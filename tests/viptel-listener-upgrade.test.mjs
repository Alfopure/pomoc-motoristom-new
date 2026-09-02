import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const upgrade = resolve("deploy/bin/upgrade-viptel-listener-only.sh");
const validator = resolve("deploy/bin/validate-activation-inputs.py");
const workerVersion = "hetzner-upgrade-worker";
const oldListenerVersion = "hetzner-upgrade-listener-old";
const newListenerVersion = "hetzner-upgrade-listener-new";
const workerGitSha = "a".repeat(40);
const oldListenerGitSha = "e".repeat(40);
const newListenerGitSha = "f".repeat(40);
const workerImageId = `sha256:${"b".repeat(64)}`;
const oldListenerImageId = `sha256:${"c".repeat(64)}`;
const newListenerImageId = `sha256:${"d".repeat(64)}`;
const candidateContainerId = "3".padStart(64, "0");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeManifest(path, version, gitSha, imageId) {
  writeFileSync(path, `${JSON.stringify({
    version,
    image: `motorist-app:${version}`,
    imageId,
    gitSha,
    buildContextSha256: "1".repeat(64),
    buildArgsSha256: "2".repeat(64),
    platform: "linux/amd64",
    schedulerEnabled: false,
  })}\n`);
}

function checksumFixtureRelease(release) {
  const names = ["manifest.json", "compose.yml"];
  writeFileSync(
    join(release, "SHA256SUMS"),
    `${names.map((name) => `${sha256(readFileSync(join(release, name)))}  ${name}`).join("\n")}\n`,
  );
}

function parseReceipt(receipts) {
  const receiptFiles = readdirSync(receipts).filter((name) => name.endsWith(".jsonl"));
  assert.equal(receiptFiles.length, 1);
  const path = join(receipts, receiptFiles[0]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const contents = readFileSync(path, "utf8");
  assert.ok(contents.endsWith("\n"));
  const lines = contents.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  const records = lines.map((line) => JSON.parse(line));
  assert.equal(records[0].schema, "motorist-viptel-listener-upgrade/v1");
  assert.equal(records[1].schema, "motorist-viptel-listener-upgrade/v1");
  assert.equal(records[1].previousRecordSha256, sha256(`${lines[0]}\n`));
  for (const record of records) {
    assert.equal(record.workerReleaseVersion, workerVersion);
    assert.equal(record.oldListenerReleaseVersion, oldListenerVersion);
    assert.equal(record.newListenerReleaseVersion, newListenerVersion);
  }
  return { path, records };
}

function makeFakeDockerUpgrade(t, {
  failNewHealth = false,
  failRollbackHealth = false,
  wrongWorkerBinding = null,
  tamperCandidateBeforeCas = false,
  corruptWorkerInventoryOnNewHealthFailure = false,
  driftWorkerDuringRollbackHealth = false,
  failOldListenerRestore = false,
  failSuccessReceipt = false,
  successReceiptSignal = null,
  failNoRunningCandidateQuery = false,
  firstCandidateStopNoEffect = false,
  candidateContainmentNeverSucceeds = false,
  resurrectCandidateOnRestoreFailure = false,
  failSuccessReceiptAfterWrite = false,
  resurrectCandidateDuringRollbackHealth = false,
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "motorist-listener-upgrade-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releaseRoot = join(root, "releases");
  const workerRelease = join(releaseRoot, workerVersion);
  const oldListenerRelease = join(releaseRoot, oldListenerVersion);
  const newListenerRelease = join(releaseRoot, newListenerVersion);
  const fakeBin = join(root, "fake-bin");
  const receipts = join(root, "receipts");
  const statePath = join(root, "listener-state");
  const dockerLog = join(root, "docker.log");
  const validatorLog = join(root, "validator.log");
  const workerDriftMarker = join(root, "worker-drift");
  const successSignalMarker = join(root, "success-signal");
  const noRunningQueryMarker = join(root, "no-running-query");
  const stopAttemptsPath = join(root, "stop-attempts");
  const successAfterWriteFailureMarker = join(root, "success-after-write-failure");
  for (const path of [
    join(workerRelease, "env"),
    join(oldListenerRelease, "env"),
    join(newListenerRelease, "env"),
    join(newListenerRelease, "bin"),
    fakeBin,
    receipts,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  writeManifest(join(workerRelease, "manifest.json"), workerVersion, workerGitSha, workerImageId);
  writeManifest(
    join(oldListenerRelease, "manifest.json"),
    oldListenerVersion,
    oldListenerGitSha,
    oldListenerImageId,
  );
  writeManifest(
    join(newListenerRelease, "manifest.json"),
    newListenerVersion,
    newListenerGitSha,
    newListenerImageId,
  );
  for (const release of [workerRelease, oldListenerRelease, newListenerRelease]) {
    writeFileSync(join(release, "compose.yml"), "name: motorist-dispatch\nservices: {}\n");
  }

  const workerRuntime = join(workerRelease, "env/worker.env");
  const oldListenerRuntime = join(oldListenerRelease, "env/viptel-listener.env");
  const newListenerRuntime = join(newListenerRelease, "env/viptel-listener.env");
  writeFileSync(workerRuntime, [
    `DEPLOYMENT_VERSION=${JSON.stringify(workerVersion)}`,
    'WORKER_INSTANCE_ID="motorist-prod-01"',
    'SCHEDULER_ENABLED="true"',
    "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(oldListenerRuntime, [
    `DEPLOYMENT_VERSION=${JSON.stringify(oldListenerVersion)}`,
    'VIPTEL_LISTENER_INSTANCE_ID="motorist-prod-01-viptel"',
    'VIPTEL_LISTENER_ENABLED="true"',
    'VIPTEL_LIVE_MUTATIONS_ENABLED="true"',
    "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(newListenerRuntime, [
    `DEPLOYMENT_VERSION=${JSON.stringify(newListenerVersion)}`,
    'VIPTEL_LISTENER_INSTANCE_ID="motorist-prod-01-viptel"',
    'VIPTEL_LISTENER_ENABLED="false"',
    'VIPTEL_LIVE_MUTATIONS_ENABLED="false"',
    'VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED="true"',
    'VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN="provider-snapshot-bridge-authority-0001"',
    'VIPTEL_DISPATCH_PERSONAL_EXTENSIONS="20,21,22,23"',
    "",
  ].join("\n"), { mode: 0o600 });
  for (const release of [workerRelease, oldListenerRelease, newListenerRelease]) {
    checksumFixtureRelease(release);
  }

  writeFileSync(statePath, "old\n");
  writeFileSync(dockerLog, "");
  writeFileSync(validatorLog, "");
  writeFileSync(stopAttemptsPath, "0\n");

  const scriptPath = join(newListenerRelease, "bin/upgrade-viptel-listener-only.sh");
  writeFileSync(
    scriptPath,
    readFileSync(upgrade, "utf8").replace(
      'operation_root="/opt/motorist/receipts"',
      `operation_root=${JSON.stringify(receipts)}`,
    ).replace(
      'release_root="/opt/motorist/releases"',
      `release_root=${JSON.stringify(releaseRoot)}`,
    ),
  );
  chmodSync(scriptPath, 0o700);

  const validatorStub = join(newListenerRelease, "bin/validate-activation-inputs.py");
  writeFileSync(validatorStub, `#!/usr/bin/env python3
import hashlib, os, re, sys

command = sys.argv[1]
with open(os.environ["FAKE_VALIDATOR_LOG"], "a", encoding="utf-8") as log:
    log.write(command + " " + " ".join(sys.argv[2:]) + "\\n")

if command == "verify-handover-worker-runtime":
    if sys.argv[2] != os.environ["FAKE_WORKER_RELEASE"] or sys.argv[3] != os.environ["FAKE_WORKER_VERSION"]:
        raise SystemExit("worker runtime was verified against the wrong release")
elif command == "verify-handover-listener-runtime":
    expected = {
        os.environ["FAKE_OLD_LISTENER_RELEASE"]: os.environ["FAKE_OLD_LISTENER_VERSION"],
        os.environ["FAKE_NEW_LISTENER_RELEASE"]: os.environ["FAKE_NEW_LISTENER_VERSION"],
    }
    if expected.get(sys.argv[2]) != sys.argv[3]:
        raise SystemExit("listener runtime was verified against the wrong release")
elif command == "set-handover-listener-flags":
    release = sys.argv[2]
    if release != os.environ["FAKE_NEW_LISTENER_RELEASE"]:
        raise SystemExit("flags may only change in the candidate release")
    enabled = sys.argv[sys.argv.index("--enabled") + 1]
    path = os.path.join(release, "env", "viptel-listener.env")
    if (
        enabled == "true"
        and "--expected-listener-sha256" in sys.argv
        and os.environ.get("FAKE_TAMPER_CANDIDATE_BEFORE_CAS") == "1"
    ):
        with open(path, "a", encoding="utf-8") as output:
            output.write("# injected concurrent candidate change\\n")
    with open(path, "rb") as source:
        before = source.read()
    if "--expected-listener-sha256" in sys.argv:
        expected_hash = sys.argv[sys.argv.index("--expected-listener-sha256") + 1]
        if hashlib.sha256(before).hexdigest() != expected_hash:
            raise SystemExit("candidate runtime CAS mismatch")
    contents = before.decode("utf-8")
    value = "true" if enabled == "true" else "false"
    contents = re.sub(r'^VIPTEL_LISTENER_ENABLED=.*$', f'VIPTEL_LISTENER_ENABLED="{value}"', contents, flags=re.M)
    contents = re.sub(r'^VIPTEL_LIVE_MUTATIONS_ENABLED=.*$', f'VIPTEL_LIVE_MUTATIONS_ENABLED="{value}"', contents, flags=re.M)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as output:
        output.write(contents)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    if "--output" in sys.argv:
        with open(path, "rb") as source:
            print(hashlib.sha256(source.read()).hexdigest())
elif command == "handover-state":
    if sys.argv[2] != os.environ["FAKE_WORKER_RELEASE"] or sys.argv[3] != os.environ["FAKE_WORKER_VERSION"]:
        raise SystemExit("state was queried through the wrong worker release")
    listener_version = sys.argv[sys.argv.index("--listener-version") + 1]
    def require_freshness_boundary():
        if "--listener-not-before-utc" not in sys.argv:
            raise SystemExit("listener heartbeat freshness boundary is missing")
        boundary = sys.argv[sys.argv.index("--listener-not-before-utc") + 1]
        if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?Z", boundary) is None:
            raise SystemExit("listener heartbeat freshness boundary is invalid")
    if listener_version == os.environ["FAKE_NEW_LISTENER_VERSION"]:
        require_freshness_boundary()
        if os.environ.get("FAKE_NEW_HEALTH_FAIL") == "1":
            if os.environ.get("FAKE_CORRUPT_WORKER_INVENTORY") == "1":
                path = os.path.join(os.environ["FAKE_WORKER_RELEASE"], "SHA256SUMS")
                with open(path, "a", encoding="utf-8") as output:
                    output.write("corrupted worker inventory\\n")
            raise SystemExit("injected new-listener health failure")
        wait_seconds = sys.argv[sys.argv.index("--wait-seconds") + 1]
        if wait_seconds == "0" and os.environ.get("FAKE_FAIL_SUCCESS_RECEIPT") == "1":
            receipt_names = [
                name for name in os.listdir(os.environ["FAKE_RECEIPTS"])
                if name.endswith(".jsonl")
            ]
            if len(receipt_names) != 1:
                raise SystemExit("success receipt fixture is missing")
            os.chmod(os.path.join(os.environ["FAKE_RECEIPTS"], receipt_names[0]), 0o644)
    elif listener_version == os.environ["FAKE_OLD_LISTENER_VERSION"]:
        with open(os.environ["FAKE_DOCKER_LOG"], "r", encoding="utf-8") as source:
            listener_was_restarted = "up:old:viptel_listener:" in source.read()
        if listener_was_restarted:
            require_freshness_boundary()
            wait_seconds = sys.argv[sys.argv.index("--wait-seconds") + 1]
            if (
                wait_seconds == "120"
                and os.environ.get("FAKE_RESURRECT_CANDIDATE_DURING_ROLLBACK_HEALTH") == "1"
            ):
                with open(os.environ["FAKE_STATE_FILE"], "w", encoding="utf-8") as output:
                    output.write("new\\n")
                with open(os.environ["FAKE_DOCKER_LOG"], "a", encoding="utf-8") as output:
                    output.write("health-resurrected:new:viptel_listener\\n")
                raise SystemExit("injected rollback health candidate resurrection")
            if os.environ.get("FAKE_DRIFT_WORKER_DURING_ROLLBACK_HEALTH") == "1":
                with open(os.environ["FAKE_WORKER_DRIFT_MARKER"], "w", encoding="utf-8") as output:
                    output.write("drifted\\n")
            if os.environ.get("FAKE_FAIL_NO_RUNNING_CANDIDATE_QUERY") == "1":
                with open(os.environ["FAKE_NO_RUNNING_QUERY_MARKER"], "w", encoding="utf-8") as output:
                    output.write("armed\\n")
            if os.environ.get("FAKE_ROLLBACK_HEALTH_FAIL") == "1":
                raise SystemExit("injected old-listener rollback health failure")
`);
  chmodSync(validatorStub, 0o700);

  const lockStub = join(newListenerRelease, "bin/open-operation-lock.py");
  writeFileSync(lockStub, `#!/usr/bin/env python3
import os, sys
command = sys.argv[1]
if command == "prepare":
    os.makedirs(sys.argv[2], mode=0o700, exist_ok=True)
elif command == "exec":
    marker = sys.argv.index("--")
    environment = dict(os.environ)
    environment["MOTORIST_OPERATION_LOCK_FD"] = "9"
    os.execvpe(sys.argv[marker + 1], sys.argv[marker + 1:], environment)
elif command != "verify":
    raise SystemExit("unexpected lock command")
`);
  chmodSync(lockStub, 0o700);

  const pythonStub = join(fakeBin, "python3");
  writeFileSync(pythonStub, `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${FAKE_SUCCESS_RECEIPT_SIGNAL:-}" \
  && "\${1:-}" == - && "\${3:-}" == append && "\${4:-}" == success ]]; then
  printf '%s\\n' "$FAKE_SUCCESS_RECEIPT_SIGNAL" >"$FAKE_SUCCESS_SIGNAL_MARKER"
  kill -s "$FAKE_SUCCESS_RECEIPT_SIGNAL" "$PPID"
fi
if [[ "\${FAKE_FAIL_SUCCESS_RECEIPT_AFTER_WRITE:-0}" == 1 \
  && "\${1:-}" == - && "\${3:-}" == append && "\${4:-}" == success ]]; then
  if /usr/bin/python3 "$@"; then
    printf 'failed-after-write\\n' >"$FAKE_SUCCESS_AFTER_WRITE_FAILURE_MARKER"
    exit 74
  fi
  exit $?
fi
exec /usr/bin/python3 "$@"
`);
  chmodSync(pythonStub, 0o700);

  const dockerStub = join(fakeBin, "docker");
  writeFileSync(dockerStub, `#!/usr/bin/env bash
set -euo pipefail
command_name=$1
shift
state=$(tr -d '\\n' <"$FAKE_STATE_FILE")
case "$command_name" in
  image)
    image_name="\${@: -1}"
    case "$image_name" in
      "$FAKE_WORKER_IMAGE") echo "$FAKE_WORKER_IMAGE_ID" ;;
      "$FAKE_OLD_LISTENER_IMAGE") echo "$FAKE_OLD_LISTENER_IMAGE_ID" ;;
      "$FAKE_NEW_LISTENER_IMAGE") echo "$FAKE_NEW_LISTENER_IMAGE_ID" ;;
      *) exit 1 ;;
    esac
    ;;
  compose)
    action=""
    for argument in "$@"; do
      case "$argument" in ps|up) action=$argument ;; esac
    done
    service_name="\${@: -1}"
    if [[ "$action" == ps ]]; then
      if [[ "$service_name" == worker ]]; then
        printf '%064d\\n' 1
      elif [[ -f "$FAKE_NO_RUNNING_QUERY_MARKER" \
        && "$(tr -d '\\n' <"$FAKE_NO_RUNNING_QUERY_MARKER")" == armed ]]; then
        printf 'consumed\\n' >"$FAKE_NO_RUNNING_QUERY_MARKER"
        printf 'ps-failed:viptel_listener\\n' >>"$FAKE_DOCKER_LOG"
        exit 1
      elif [[ "$state" == old ]]; then
        printf '%064d\\n' 2
      else
        printf '%064d\\n' 3
      fi
    elif [[ "$action" == up ]]; then
      if [[ "$service_name" != viptel_listener ]]; then exit 1; fi
      if [[ "$PWD" == "$FAKE_OLD_LISTENER_RELEASE" ]]; then
        next_state=old
      elif [[ "$PWD" == "$FAKE_NEW_LISTENER_RELEASE" ]]; then
        next_state=new
      else
        exit 1
      fi
      if [[ "$next_state" == old && "$state" != stopped ]]; then
        printf 'unsafe-up-blocked:old:%s:%s\\n' "$service_name" "$PWD" >>"$FAKE_DOCKER_LOG"
        exit 1
      fi
      if [[ "$next_state" == old && "$FAKE_OLD_LISTENER_RESTORE_FAIL" == 1 ]]; then
        printf 'up-failed:%s:%s:%s\\n' "$next_state" "$service_name" "$PWD" >>"$FAKE_DOCKER_LOG"
        if [[ "$FAKE_RESURRECT_CANDIDATE_ON_RESTORE_FAILURE" == 1 ]]; then
          printf 'new\\n' >"$FAKE_STATE_FILE"
        fi
        exit 1
      fi
      printf '%s\\n' "$next_state" >"$FAKE_STATE_FILE"
      printf 'up:%s:%s:%s\\n' "$next_state" "$service_name" "$PWD" >>"$FAKE_DOCKER_LOG"
    else
      exit 1
    fi
    ;;
  inspect)
    format=$2
    container="\${@: -1}"
    if [[ "$container" == "$(printf '%064d' 1)" ]]; then
      if [[ "$FAKE_WRONG_WORKER_BINDING" == image ]]; then
        selected_image="$FAKE_OLD_LISTENER_IMAGE_ID"
      else
        selected_image="$FAKE_WORKER_IMAGE_ID"
      fi
      if [[ "$FAKE_WRONG_WORKER_BINDING" == mount ]]; then
        selected_source="$FAKE_OLD_LISTENER_RELEASE/env/viptel-listener.env"
      else
        selected_source="$FAKE_WORKER_RELEASE/env/worker.env"
      fi
      selected_id="$container"
      if [[ -f "$FAKE_WORKER_DRIFT_MARKER" ]]; then
        selected_started="2026-08-05T00:00:01Z"
      else
        selected_started="2026-08-05T00:00:00Z"
      fi
    elif [[ "$state" == old ]]; then
      selected_image="$FAKE_OLD_LISTENER_IMAGE_ID"
      selected_source="$FAKE_OLD_LISTENER_RELEASE/env/viptel-listener.env"
      selected_id="$(printf '%064d' 2)"
      selected_started="2026-08-05T00:01:00Z"
    else
      selected_image="$FAKE_NEW_LISTENER_IMAGE_ID"
      selected_source="$FAKE_NEW_LISTENER_RELEASE/env/viptel-listener.env"
      selected_id="$(printf '%064d' 3)"
      selected_started="2026-08-05T00:02:00Z"
    fi
    if [[ "$format" == *'.Id}}|'* ]]; then
      printf '%s|%s|true|%s|0001-01-01T00:00:00Z\\n' "$selected_id" "$selected_image" "$selected_started"
    elif [[ "$format" == *'.Image}}'* ]]; then
      echo "$selected_image"
    elif [[ "$format" == *'.State.Running}}'* ]]; then
      if [[ "$state" == stopped && "$container" != "$(printf '%064d' 1)" ]]; then
        echo false
      else
        echo true
      fi
    elif [[ "$format" == *'.State.StartedAt}}'* ]]; then
      echo "$selected_started"
    elif [[ "$format" == *'.Mounts'* ]]; then
      echo "$selected_source"
    else
      exit 1
    fi
    ;;
  stop)
    container="\${@: -1}"
    if [[ "$container" != "$(printf '%064d' 3)" || "$state" != new ]]; then exit 1; fi
    attempts=$(tr -d '\\n' <"$FAKE_STOP_ATTEMPTS")
    attempts=$((attempts + 1))
    printf '%s\\n' "$attempts" >"$FAKE_STOP_ATTEMPTS"
    if [[ "$FAKE_CANDIDATE_CONTAINMENT_NEVER_SUCCEEDS" == 1 \
      || ( "$FAKE_FIRST_CANDIDATE_STOP_NO_EFFECT" == 1 && "$attempts" == 1 ) ]]; then
      printf 'stop-noeffect:viptel_listener:%s\\n' "$container" >>"$FAKE_DOCKER_LOG"
      exit 0
    fi
    printf 'stopped\\n' >"$FAKE_STATE_FILE"
    printf 'stop:stopped:viptel_listener:%s\\n' "$container" >>"$FAKE_DOCKER_LOG"
    ;;
  kill)
    container="\${@: -1}"
    if [[ "$container" != "$(printf '%064d' 3)" || "$state" != new ]]; then exit 1; fi
    if [[ "$FAKE_CANDIDATE_CONTAINMENT_NEVER_SUCCEEDS" == 1 ]]; then
      printf 'kill-noeffect:viptel_listener:%s\\n' "$container" >>"$FAKE_DOCKER_LOG"
      exit 0
    fi
    printf 'stopped\\n' >"$FAKE_STATE_FILE"
    printf 'kill:stopped:viptel_listener:%s\\n' "$container" >>"$FAKE_DOCKER_LOG"
    ;;
  *) exit 1 ;;
esac
`);
  chmodSync(dockerStub, 0o700);

  const timeoutStub = join(fakeBin, "timeout");
  writeFileSync(timeoutStub, `#!/usr/bin/env bash
set -euo pipefail
shift
exec "$@"
`);
  chmodSync(timeoutStub, 0o700);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_STATE_FILE: statePath,
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_VALIDATOR_LOG: validatorLog,
    FAKE_WORKER_RELEASE: workerRelease,
    FAKE_OLD_LISTENER_RELEASE: oldListenerRelease,
    FAKE_NEW_LISTENER_RELEASE: newListenerRelease,
    FAKE_WORKER_VERSION: workerVersion,
    FAKE_OLD_LISTENER_VERSION: oldListenerVersion,
    FAKE_NEW_LISTENER_VERSION: newListenerVersion,
    FAKE_WORKER_IMAGE: `motorist-app:${workerVersion}`,
    FAKE_OLD_LISTENER_IMAGE: `motorist-app:${oldListenerVersion}`,
    FAKE_NEW_LISTENER_IMAGE: `motorist-app:${newListenerVersion}`,
    FAKE_WORKER_IMAGE_ID: workerImageId,
    FAKE_OLD_LISTENER_IMAGE_ID: oldListenerImageId,
    FAKE_NEW_LISTENER_IMAGE_ID: newListenerImageId,
    FAKE_NEW_HEALTH_FAIL: failNewHealth ? "1" : "0",
    FAKE_ROLLBACK_HEALTH_FAIL: failRollbackHealth ? "1" : "0",
    FAKE_WRONG_WORKER_BINDING: wrongWorkerBinding ?? "",
    FAKE_TAMPER_CANDIDATE_BEFORE_CAS: tamperCandidateBeforeCas ? "1" : "0",
    FAKE_CORRUPT_WORKER_INVENTORY: corruptWorkerInventoryOnNewHealthFailure ? "1" : "0",
    FAKE_DRIFT_WORKER_DURING_ROLLBACK_HEALTH: driftWorkerDuringRollbackHealth ? "1" : "0",
    FAKE_WORKER_DRIFT_MARKER: workerDriftMarker,
    FAKE_OLD_LISTENER_RESTORE_FAIL: failOldListenerRestore ? "1" : "0",
    FAKE_FAIL_SUCCESS_RECEIPT: failSuccessReceipt ? "1" : "0",
    FAKE_RECEIPTS: receipts,
    FAKE_SUCCESS_RECEIPT_SIGNAL: successReceiptSignal ?? "",
    FAKE_SUCCESS_SIGNAL_MARKER: successSignalMarker,
    FAKE_FAIL_NO_RUNNING_CANDIDATE_QUERY: failNoRunningCandidateQuery ? "1" : "0",
    FAKE_NO_RUNNING_QUERY_MARKER: noRunningQueryMarker,
    FAKE_FIRST_CANDIDATE_STOP_NO_EFFECT: firstCandidateStopNoEffect ? "1" : "0",
    FAKE_CANDIDATE_CONTAINMENT_NEVER_SUCCEEDS: candidateContainmentNeverSucceeds ? "1" : "0",
    FAKE_STOP_ATTEMPTS: stopAttemptsPath,
    FAKE_RESURRECT_CANDIDATE_ON_RESTORE_FAILURE: resurrectCandidateOnRestoreFailure ? "1" : "0",
    FAKE_FAIL_SUCCESS_RECEIPT_AFTER_WRITE: failSuccessReceiptAfterWrite ? "1" : "0",
    FAKE_SUCCESS_AFTER_WRITE_FAILURE_MARKER: successAfterWriteFailureMarker,
    FAKE_RESURRECT_CANDIDATE_DURING_ROLLBACK_HEALTH: resurrectCandidateDuringRollbackHealth ? "1" : "0",
  };
  delete env.MOTORIST_OPERATION_LOCK_FD;
  const workerBefore = readFileSync(workerRuntime);
  const oldListenerBefore = readFileSync(oldListenerRuntime);
  const run = spawnSync(scriptPath, [
    workerRelease,
    oldListenerRelease,
    newListenerRelease,
    workerGitSha,
    oldListenerGitSha,
    newListenerGitSha,
  ], { encoding: "utf8", env, timeout: 10_000 });
  return {
    run,
    workerRelease,
    oldListenerRelease,
    newListenerRelease,
    workerRuntime,
    workerSums: join(workerRelease, "SHA256SUMS"),
    oldListenerRuntime,
    newListenerRuntime,
    workerBefore,
    oldListenerBefore,
    statePath,
    dockerLog,
    validatorLog,
    receipts,
    workerDriftMarker,
    successSignalMarker,
    noRunningQueryMarker,
    stopAttemptsPath,
    successAfterWriteFailureMarker,
  };
}

test("three-release listener upgrade has a listener-only mutation boundary", () => {
  const script = readFileSync(upgrade, "utf8");
  assert.match(script, /service="viptel_listener"/);
  assert.match(script, /preserved_jobs="telephony\.viptel\.reconcile"/);
  assert.match(script, /verify_worker_unchanged/);
  assert.match(script, /verify-handover-worker-runtime/);
  assert.match(script, /verify-handover-listener-runtime/);
  assert.match(script, /--listener-not-before-utc/);
  assert.match(script, /--no-deps --force-recreate "\$service"/);
  assert.doesNotMatch(script, /set-controls|--mode enable|--mode disable/);
  assert.doesNotMatch(
    script,
    /docker compose[^\n]*(?:up|start|stop|restart)[^\n]*(?:worker|web_blue|web_green|caddy)/,
  );
  assert.match(script, /trap 'exit 129' HUP/);
  const interruptsBlocked = script.lastIndexOf("trap '' HUP INT TERM");
  const successReceipt = script.indexOf("write_receipt append success", interruptsBlocked);
  const rollbackDisarmed = script.indexOf("rollback_armed=false", successReceipt);
  const trapsCleared = script.indexOf("trap - EXIT HUP INT TERM", rollbackDisarmed);
  assert.ok(interruptsBlocked >= 0, "success commit must block HUP, INT, and TERM");
  assert.ok(successReceipt > interruptsBlocked, "interrupts must be blocked before receipt append");
  assert.ok(rollbackDisarmed > successReceipt, "rollback must remain armed while receipt append runs");
  assert.ok(trapsCleared > rollbackDisarmed, "rollback must be disarmed before traps are cleared");
  assert.equal(
    script.slice(interruptsBlocked, rollbackDisarmed).includes("trap - EXIT"),
    false,
    "EXIT rollback must remain armed through the durable receipt write",
  );
  const syntax = spawnSync("bash", ["-n", upgrade], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("fake Docker upgrade preserves a separate worker release", (t) => {
  const item = makeFakeDockerUpgrade(t);
  assert.equal(item.run.status, 0, `${item.run.stdout}\n${item.run.stderr}`);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "new");
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  assert.deepEqual(readFileSync(item.oldListenerRuntime), item.oldListenerBefore);
  assert.equal(
    readFileSync(item.dockerLog, "utf8").trim(),
    `up:new:viptel_listener:${item.newListenerRelease}`,
  );

  const calls = readFileSync(item.validatorLog, "utf8");
  assert.match(calls, new RegExp(`verify-handover-worker-runtime ${item.workerRelease} ${workerVersion}`));
  assert.match(
    calls,
    new RegExp(`verify-handover-listener-runtime ${item.oldListenerRelease} ${oldListenerVersion}`),
  );
  assert.match(
    calls,
    new RegExp(`verify-handover-listener-runtime ${item.newListenerRelease} ${newListenerVersion}`),
  );
  assert.match(
    calls,
    new RegExp(
      `handover-state ${item.workerRelease} ${workerVersion}[^\\n]*--listener-version ${newListenerVersion}[^\\n]*--listener-not-before-utc [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?Z`,
    ),
  );
  assert.doesNotMatch(calls, /set-controls/);

  const { records } = parseReceipt(item.receipts);
  assert.equal(records[0].status, "in_progress");
  assert.equal(records[0].activeListenerReleaseVersion, oldListenerVersion);
  assert.equal(records[1].status, "success");
  assert.equal(records[1].activeListenerReleaseVersion, newListenerVersion);
  assert.equal(records[1].workerUnchanged, true);
  assert.equal(records[1].schedulerAndControlsPreserved, true);
  for (const record of records) {
    assert.equal(record.workerReleaseDir, item.workerRelease);
    assert.equal(record.oldListenerReleaseDir, item.oldListenerRelease);
    assert.equal(record.newListenerReleaseDir, item.newListenerRelease);
  }
  assert.match(records[1].newListenerHeartbeatNotBeforeUtc, /Z$/);
});

test("failed candidate health restores the exact old listener release", (t) => {
  const item = makeFakeDockerUpgrade(t, { failNewHealth: true });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /injected new-listener health failure/);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "old");
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  assert.deepEqual(readFileSync(item.oldListenerRuntime), item.oldListenerBefore);
  assert.deepEqual(
    readFileSync(item.dockerLog, "utf8").trim().split("\n"),
    [
      `up:new:viptel_listener:${item.newListenerRelease}`,
      `stop:stopped:viptel_listener:${candidateContainerId}`,
      `up:old:viptel_listener:${item.oldListenerRelease}`,
    ],
  );
  const newRuntime = readFileSync(item.newListenerRuntime, "utf8");
  assert.match(newRuntime, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(newRuntime, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);
  const calls = readFileSync(item.validatorLog, "utf8");
  assert.match(
    calls,
    new RegExp(
      `handover-state ${item.workerRelease} ${workerVersion}[^\\n]*--listener-version ${oldListenerVersion}[^\\n]*--listener-not-before-utc [^\\s]+`,
    ),
  );

  const { records } = parseReceipt(item.receipts);
  assert.equal(records[1].status, "failure");
  assert.equal(records[1].stage, "rollback_complete");
  assert.equal(records[1].activeListenerReleaseVersion, oldListenerVersion);
  assert.equal(records[1].workerUnchanged, true);
  assert.equal(records[1].schedulerAndControlsPreserved, true);
  assert.equal(records[1].workerReleaseDir, item.workerRelease);
  assert.equal(records[1].oldListenerReleaseDir, item.oldListenerRelease);
  assert.equal(records[1].newListenerReleaseDir, item.newListenerRelease);
  assert.match(records[1].newListenerHeartbeatNotBeforeUtc, /Z$/);
  assert.match(records[1].rollbackListenerHeartbeatNotBeforeUtc, /Z$/);
});

test("failed old-listener rollback health is recorded as incomplete", (t) => {
  const item = makeFakeDockerUpgrade(t, {
    failNewHealth: true,
    failRollbackHealth: true,
  });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /injected new-listener health failure/);
  assert.match(item.run.stderr, /listener upgrade rollback is incomplete/);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "old");
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  assert.deepEqual(
    readFileSync(item.dockerLog, "utf8").trim().split("\n"),
    [
      `up:new:viptel_listener:${item.newListenerRelease}`,
      `stop:stopped:viptel_listener:${candidateContainerId}`,
      `up:old:viptel_listener:${item.oldListenerRelease}`,
    ],
  );

  const calls = readFileSync(item.validatorLog, "utf8");
  assert.match(
    calls,
    new RegExp(
      `handover-state ${item.workerRelease} ${workerVersion}[^\\n]*--listener-version ${oldListenerVersion}[^\\n]*--listener-not-before-utc [^\\s]+`,
    ),
  );
  const { records } = parseReceipt(item.receipts);
  assert.equal(records[1].status, "failure");
  assert.equal(records[1].stage, "rollback_incomplete");
  assert.equal(records[1].activeListenerReleaseVersion, null);
  assert.equal(records[1].workerUnchanged, null);
  assert.match(records[1].rollbackListenerHeartbeatNotBeforeUtc, /Z$/);
});

test("failed old-listener restore physically stops the disabled candidate", (t) => {
  const item = makeFakeDockerUpgrade(t, {
    failNewHealth: true,
    failOldListenerRestore: true,
  });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /injected new-listener health failure/);
  assert.match(item.run.stderr, /listener upgrade rollback is incomplete/);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "stopped");
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  assert.deepEqual(readFileSync(item.oldListenerRuntime), item.oldListenerBefore);
  const dockerCalls = readFileSync(item.dockerLog, "utf8").trim().split("\n");
  assert.deepEqual(dockerCalls, [
    `up:new:viptel_listener:${item.newListenerRelease}`,
    `stop:stopped:viptel_listener:${candidateContainerId}`,
    `up-failed:old:viptel_listener:${item.oldListenerRelease}`,
  ]);
  assert.doesNotMatch(dockerCalls.join("\n"), /:worker:/);
  const candidate = readFileSync(item.newListenerRuntime, "utf8");
  assert.match(candidate, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(candidate, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);

  const { records } = parseReceipt(item.receipts);
  assert.equal(records[1].status, "failure");
  assert.equal(records[1].stage, "rollback_incomplete");
  assert.equal(records[1].activeListenerReleaseVersion, null);
  assert.equal(records[1].workerUnchanged, null);
});

test("containment retries before restore and repeats after partial restore failure", (t) => {
  const item = makeFakeDockerUpgrade(t, {
    failNewHealth: true,
    failOldListenerRestore: true,
    firstCandidateStopNoEffect: true,
    resurrectCandidateOnRestoreFailure: true,
  });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /injected new-listener health failure/);
  assert.match(item.run.stderr, /listener upgrade rollback is incomplete/);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "stopped");
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  const dockerCalls = readFileSync(item.dockerLog, "utf8").trim().split("\n");
  assert.equal(dockerCalls[0], `up:new:viptel_listener:${item.newListenerRelease}`);
  assert.equal(dockerCalls[1], `stop-noeffect:viptel_listener:${candidateContainerId}`);
  assert.doesNotMatch(dockerCalls.join("\n"), /unsafe-up-blocked/);
  const restoreFailure = dockerCalls.indexOf(
    `up-failed:old:viptel_listener:${item.oldListenerRelease}`,
  );
  assert.ok(restoreFailure > 1, "old restore must be attempted only after candidate containment");
  assert.ok(
    dockerCalls.slice(2, restoreFailure).some((line) => /^(?:stop|kill):stopped:/.test(line)),
    "a bounded retry or kill fallback must stop the candidate before old restore",
  );
  assert.ok(
    dockerCalls.slice(restoreFailure + 1).some((line) => /^(?:stop|kill):stopped:/.test(line)),
    "containment must run again after a partial old-listener restore failure",
  );
  const stopAttempts = Number.parseInt(readFileSync(item.stopAttemptsPath, "utf8"), 10);
  assert.ok(stopAttempts >= 2 && stopAttempts <= 8, `containment attempts were not bounded: ${stopAttempts}`);
  const candidate = readFileSync(item.newListenerRuntime, "utf8");
  assert.match(candidate, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(candidate, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);
  const { records } = parseReceipt(item.receipts);
  assert.equal(records[1].status, "failure");
  assert.equal(records[1].stage, "rollback_incomplete");
});

test("old listener is never started when bounded candidate containment cannot succeed", (t) => {
  const item = makeFakeDockerUpgrade(t, {
    failNewHealth: true,
    candidateContainmentNeverSucceeds: true,
  });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /injected new-listener health failure/);
  assert.match(item.run.stderr, /listener upgrade rollback is incomplete/);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "new");
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  const dockerCalls = readFileSync(item.dockerLog, "utf8").trim().split("\n");
  assert.equal(dockerCalls[0], `up:new:viptel_listener:${item.newListenerRelease}`);
  assert.doesNotMatch(dockerCalls.join("\n"), /(?:up|up-failed|unsafe-up-blocked):old:/);
  assert.ok(dockerCalls.some((line) => line.startsWith("stop-noeffect:")));
  assert.ok(dockerCalls.some((line) => line.startsWith("kill-noeffect:")));
  assert.ok(dockerCalls.length <= 12, `containment was not bounded: ${dockerCalls.length} Docker calls`);
  const candidate = readFileSync(item.newListenerRuntime, "utf8");
  assert.match(candidate, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(candidate, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);
  const { records } = parseReceipt(item.receipts);
  assert.equal(records[1].status, "failure");
  assert.equal(records[1].stage, "rollback_incomplete");
});

test("failed candidate-containment query cannot record rollback complete", (t) => {
  const item = makeFakeDockerUpgrade(t, {
    failNewHealth: true,
    failNoRunningCandidateQuery: true,
  });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /injected new-listener health failure/);
  assert.match(item.run.stderr, /listener upgrade rollback is incomplete/);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "old");
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  assert.deepEqual(
    readFileSync(item.dockerLog, "utf8").trim().split("\n"),
    [
      `up:new:viptel_listener:${item.newListenerRelease}`,
      `stop:stopped:viptel_listener:${candidateContainerId}`,
      `up:old:viptel_listener:${item.oldListenerRelease}`,
      "ps-failed:viptel_listener",
    ],
  );
  assert.equal(readFileSync(item.noRunningQueryMarker, "utf8"), "armed\n");
  const candidate = readFileSync(item.newListenerRuntime, "utf8");
  assert.match(candidate, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(candidate, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);
  const { records } = parseReceipt(item.receipts);
  assert.equal(records[1].status, "failure");
  assert.equal(records[1].stage, "rollback_incomplete");
  assert.equal(records[1].activeListenerReleaseVersion, null);
});

test("receipt append failure keeps EXIT rollback armed", (t) => {
  const item = makeFakeDockerUpgrade(t, { failSuccessReceipt: true });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /listener upgrade receipt is unsafe/);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "old");
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  assert.deepEqual(
    readFileSync(item.dockerLog, "utf8").trim().split("\n"),
    [
      `up:new:viptel_listener:${item.newListenerRelease}`,
      `stop:stopped:viptel_listener:${candidateContainerId}`,
      `up:old:viptel_listener:${item.oldListenerRelease}`,
    ],
  );
  const candidate = readFileSync(item.newListenerRuntime, "utf8");
  assert.match(candidate, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(candidate, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);
  const receiptNames = readdirSync(item.receipts).filter((name) => name.endsWith(".jsonl"));
  assert.equal(receiptNames.length, 1);
  const receiptPath = join(item.receipts, receiptNames[0]);
  assert.equal(statSync(receiptPath).mode & 0o777, 0o644);
  const records = readFileSync(receiptPath, "utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "in_progress");
});

test("success line followed by append failure receives an authoritative corrective record", (t) => {
  const item = makeFakeDockerUpgrade(t, { failSuccessReceiptAfterWrite: true });
  assert.notEqual(item.run.status, 0);
  assert.equal(
    readFileSync(item.successAfterWriteFailureMarker, "utf8"),
    "failed-after-write\n",
  );
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "old");
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  assert.deepEqual(
    readFileSync(item.dockerLog, "utf8").trim().split("\n"),
    [
      `up:new:viptel_listener:${item.newListenerRelease}`,
      `stop:stopped:viptel_listener:${candidateContainerId}`,
      `up:old:viptel_listener:${item.oldListenerRelease}`,
    ],
  );
  const candidate = readFileSync(item.newListenerRuntime, "utf8");
  assert.match(candidate, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(candidate, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);

  const receiptNames = readdirSync(item.receipts).filter((name) => name.endsWith(".jsonl"));
  assert.equal(receiptNames.length, 1);
  const receiptPath = join(item.receipts, receiptNames[0]);
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  const contents = readFileSync(receiptPath, "utf8");
  assert.ok(contents.endsWith("\n"));
  const lines = contents.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  const records = lines.map(JSON.parse);
  assert.equal(records[0].status, "in_progress");
  assert.equal(records[1].status, "success");
  assert.equal(records[1].stage, "upgrade_complete");
  assert.equal(records[2].status, "failure");
  assert.match(records[2].stage, /^rollback_(?:complete|incomplete)$/);
  assert.equal(records[2].previousRecordSha256, sha256(`${lines[1]}\n`));
  assert.notEqual(records.at(-1).status, "success");
});

test("HUP and TERM during durable success commit cannot trigger rollback", async (t) => {
  for (const signal of ["HUP", "TERM"]) {
    await t.test(signal, (subtest) => {
      const item = makeFakeDockerUpgrade(subtest, { successReceiptSignal: signal });
      assert.equal(item.run.status, 0, `${item.run.stdout}\n${item.run.stderr}`);
      assert.equal(readFileSync(item.successSignalMarker, "utf8"), `${signal}\n`);
      assert.equal(readFileSync(item.statePath, "utf8").trim(), "new");
      assert.equal(
        readFileSync(item.dockerLog, "utf8").trim(),
        `up:new:viptel_listener:${item.newListenerRelease}`,
      );
      assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
      const { records } = parseReceipt(item.receipts);
      assert.equal(records[1].status, "success");
      assert.equal(records[1].stage, "upgrade_complete");
      assert.equal(records[1].activeListenerReleaseVersion, newListenerVersion);
    });
  }
});

test("wrong worker image or runtime mount fails before any Compose mutation", async (t) => {
  for (const wrongWorkerBinding of ["image", "mount"]) {
    await t.test(wrongWorkerBinding, (subtest) => {
      const item = makeFakeDockerUpgrade(subtest, { wrongWorkerBinding });
      assert.notEqual(item.run.status, 0);
      assert.match(item.run.stderr, /worker does not match the exact preserved worker release/);
      assert.equal(readFileSync(item.statePath, "utf8").trim(), "old");
      assert.equal(readFileSync(item.dockerLog, "utf8"), "");
      assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
      assert.deepEqual(readFileSync(item.oldListenerRuntime), item.oldListenerBefore);
      assert.deepEqual(readdirSync(item.receipts), []);
    });
  }
});

test("candidate runtime CAS tamper fails before listener recreation", (t) => {
  const item = makeFakeDockerUpgrade(t, { tamperCandidateBeforeCas: true });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /candidate runtime CAS mismatch/);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "old");
  assert.equal(readFileSync(item.dockerLog, "utf8"), "");
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  assert.deepEqual(readFileSync(item.oldListenerRuntime), item.oldListenerBefore);
  const candidate = readFileSync(item.newListenerRuntime, "utf8");
  assert.match(candidate, /injected concurrent candidate change/);
  assert.match(candidate, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(candidate, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);

  const { records } = parseReceipt(item.receipts);
  assert.equal(records[1].status, "failure");
  assert.equal(records[1].stage, "rollback_incomplete");
  assert.equal(records[1].activeListenerReleaseVersion, null);
});

test("worker inventory corruption cannot prevent defensive listener rollback", (t) => {
  const item = makeFakeDockerUpgrade(t, {
    failNewHealth: true,
    corruptWorkerInventoryOnNewHealthFailure: true,
  });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /injected new-listener health failure/);
  assert.match(item.run.stderr, /listener upgrade rollback is incomplete/);
  assert.match(readFileSync(item.workerSums, "utf8"), /corrupted worker inventory/);
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "old");
  assert.deepEqual(
    readFileSync(item.dockerLog, "utf8").trim().split("\n"),
    [
      `up:new:viptel_listener:${item.newListenerRelease}`,
      `stop:stopped:viptel_listener:${candidateContainerId}`,
      `up:old:viptel_listener:${item.oldListenerRelease}`,
    ],
  );
  const candidate = readFileSync(item.newListenerRuntime, "utf8");
  assert.match(candidate, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(candidate, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);
  const calls = readFileSync(item.validatorLog, "utf8");
  assert.match(
    calls,
    new RegExp(
      `set-handover-listener-flags ${item.newListenerRelease} ${newListenerVersion} --enabled false --force-disable`,
    ),
  );
  assert.match(
    calls,
    new RegExp(
      `handover-state ${item.workerRelease} ${workerVersion}[^\\n]*--listener-version ${oldListenerVersion}[^\\n]*--listener-not-before-utc [^\\s]+`,
    ),
  );

  const { records } = parseReceipt(item.receipts);
  assert.equal(records[1].status, "failure");
  assert.equal(records[1].stage, "rollback_incomplete");
  assert.equal(records[1].activeListenerReleaseVersion, null);
});

test("worker drift during rollback health is caught before rollback completion", (t) => {
  const item = makeFakeDockerUpgrade(t, {
    failNewHealth: true,
    driftWorkerDuringRollbackHealth: true,
  });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /injected new-listener health failure/);
  assert.match(item.run.stderr, /listener upgrade rollback is incomplete/);
  assert.equal(readFileSync(item.workerDriftMarker, "utf8"), "drifted\n");
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "old");
  assert.deepEqual(
    readFileSync(item.dockerLog, "utf8").trim().split("\n"),
    [
      `up:new:viptel_listener:${item.newListenerRelease}`,
      `stop:stopped:viptel_listener:${candidateContainerId}`,
      `up:old:viptel_listener:${item.oldListenerRelease}`,
    ],
  );
  const candidate = readFileSync(item.newListenerRuntime, "utf8");
  assert.match(candidate, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(candidate, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);
  const { records } = parseReceipt(item.receipts);
  assert.equal(records[1].status, "failure");
  assert.equal(records[1].stage, "rollback_incomplete");
  assert.equal(records[1].activeListenerReleaseVersion, null);
  assert.equal(records[1].workerUnchanged, null);
});

test("candidate resurrection during rollback health is immediately contained", (t) => {
  const item = makeFakeDockerUpgrade(t, {
    failNewHealth: true,
    resurrectCandidateDuringRollbackHealth: true,
  });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /injected new-listener health failure/);
  assert.match(item.run.stderr, /listener upgrade rollback is incomplete/);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "stopped");
  assert.deepEqual(readFileSync(item.workerRuntime), item.workerBefore);
  assert.deepEqual(readFileSync(item.oldListenerRuntime), item.oldListenerBefore);
  const dockerCalls = readFileSync(item.dockerLog, "utf8").trim().split("\n");
  const oldStart = dockerCalls.indexOf(`up:old:viptel_listener:${item.oldListenerRelease}`);
  const resurrection = dockerCalls.indexOf("health-resurrected:new:viptel_listener");
  assert.ok(oldStart > 0);
  assert.ok(resurrection > oldStart, "fault must occur during old-listener health wait");
  assert.ok(
    dockerCalls.slice(resurrection + 1).some((line) => /^(?:stop|kill):stopped:/.test(line)),
    "bounded candidate containment must rerun immediately after the failed health wait",
  );
  assert.doesNotMatch(dockerCalls.join("\n"), /:worker:/);
  const candidate = readFileSync(item.newListenerRuntime, "utf8");
  assert.match(candidate, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(candidate, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);
  const { records } = parseReceipt(item.receipts);
  assert.equal(records.at(-1).status, "failure");
  assert.equal(records.at(-1).stage, "rollback_incomplete");
  assert.equal(records.at(-1).activeListenerReleaseVersion, null);
});

test("candidate heartbeat must be newer than the listener restart boundary", () => {
  const timestamp = (offsetMilliseconds) => new Date(Date.now() + offsetMilliseconds)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const rows = [
    {
      instance_id: "motorist-prod-01",
      deployment_version: workerVersion,
      heartbeat_at: timestamp(0),
      scheduler_tick_at: timestamp(0),
      scheduler_status: "running",
      viptel_ws_status: "disabled",
    },
    {
      instance_id: "motorist-prod-01-viptel",
      deployment_version: newListenerVersion,
      heartbeat_at: timestamp(-2_000),
      scheduler_tick_at: null,
      scheduler_status: "listener",
      viptel_ws_status: "connected",
    },
  ];
  const run = (boundary) => spawnSync("python3", [
    "-c",
    [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('validator',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.validate_handover_heartbeat_rows(json.loads(sys.argv[2]),sys.argv[3],sys.argv[4],sys.argv[5])",
    ].join(";"),
    validator,
    JSON.stringify(rows),
    workerVersion,
    newListenerVersion,
    boundary,
  ], { encoding: "utf8" });

  const accepted = run(timestamp(-4_000));
  assert.equal(accepted.status, 0, accepted.stderr);
  const equalBoundary = run(rows[1].heartbeat_at);
  assert.notEqual(equalBoundary.status, 0);
  assert.match(equalBoundary.stderr, /handover listener heartbeat predates the required boundary/);
  const staleReplay = run(timestamp(0));
  assert.notEqual(staleReplay.status, 0);
  assert.match(staleReplay.stderr, /handover listener heartbeat predates the required boundary/);
});

test("listener upgrade helper is checksum-bound by every release tool", () => {
  for (const path of [
    "deploy/bin/build-release.sh",
    "deploy/bin/install-release.sh",
    "deploy/bin/validate-activation-inputs.py",
  ]) {
    assert.match(readFileSync(resolve(path), "utf8"), /upgrade-viptel-listener-only\.sh/, path);
  }
});
