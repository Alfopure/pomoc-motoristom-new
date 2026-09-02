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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const validator = resolve("deploy/bin/validate-activation-inputs.py");
const handover = resolve("deploy/bin/handover-viptel-listener-only.sh");
const staging = resolve("deploy/bin/stage-viptel-listener-handover.sh");
const targetRef = "sjcsrygkkmersoczpunh";
const oldVersion = "hetzner-handover-old";
const newVersion = "hetzner-handover-new";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function serialize(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
}

function shared(version) {
  return {
    NODE_ENV: "production",
    DEPLOYMENT_VERSION: version,
    SUPABASE_PROJECT_REF: targetRef,
    SUPABASE_URL: `https://${targetRef}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_URL: `https://${targetRef}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-key",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public-key",
    SUPABASE_ANON_KEY: "public-key",
    SUPABASE_PUBLISHABLE_KEY: "public-key",
    SUPABASE_SECRET_KEY: "service-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    MOTORIST_DEV_AUTH_BYPASS: "false",
    APP_BASE_URL: "https://dispecing.linkapomoci.sk",
    PUBLIC_APP_URL: "https://dispecing.linkapomoci.sk",
    NEXT_PUBLIC_APP_URL: "https://dispecing.linkapomoci.sk",
  };
}

function writeManifest(path, version, git = "a".repeat(40)) {
  writeFileSync(path, `${JSON.stringify({
    version,
    image: `motorist-app:${version}`,
    imageId: `sha256:${(version === oldVersion ? "b" : "c").repeat(64)}`,
    gitSha: git,
    buildContextSha256: "d".repeat(64),
    buildArgsSha256: "e".repeat(64),
    platform: "linux/amd64",
    schedulerEnabled: false,
  })}\n`);
}

function makeHistoricRelease() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "motorist-historic-release-")));
  const release = join(root, "release");
  const env = join(release, "env");
  const bin = join(release, "bin");
  mkdirSync(env, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  writeManifest(join(release, "manifest.json"), oldVersion);
  const files = {
    "image.tar.gz": "historic-image\n",
    "compose.yml": "name: motorist-dispatch\nservices: {}\n",
    Caddyfile: "historic-caddy\n",
    "upstream.caddy": "historic-upstream\n",
    "bin/install-release.sh": "#!/usr/bin/env bash\nexit 0\n",
  };
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(release, name), contents);
  }
  chmodSync(join(bin, "install-release.sh"), 0o700);
  writeFileSync(join(env, "worker.env"), serialize({
    ...shared(oldVersion),
    WORKER_INSTANCE_ID: "motorist-prod-01",
    SCHEDULER_ENABLED: "true",
    HEALTHCHECKS_PING_URL: "https://hc-ping.com/11111111-1111-4111-8111-111111111111",
  }), { mode: 0o600 });
  writeFileSync(join(env, "viptel-listener.env"), serialize({
    ...shared(oldVersion),
    VIPTEL_LISTENER_INSTANCE_ID: "motorist-prod-01-viptel",
    VIPTEL_LISTENER_ENABLED: "true",
    VIPTEL_HEALTHCHECKS_PING_URL: "https://hc-ping.com/22222222-2222-4222-8222-222222222222",
  }), { mode: 0o600 });
  const immutable = [
    "image.tar.gz",
    "manifest.json",
    "compose.yml",
    "Caddyfile",
    "upstream.caddy",
    "bin/install-release.sh",
  ];
  const sums = `${immutable.map((name) => `${sha256(readFileSync(join(release, name)))}  ${name}`).join("\n")}\n`;
  writeFileSync(join(release, "SHA256SUMS"), sums);
  return { root, release, sums };
}

function makeNewRuntime() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "motorist-handover-runtime-")));
  const env = join(root, "env");
  mkdirSync(env, { mode: 0o700 });
  writeManifest(join(root, "manifest.json"), newVersion);
  const bridgeToken = "provider-snapshot-bridge-authority-0001";
  const common = {
    ...shared(newVersion),
    VIPTEL_LIVE_MUTATIONS_ENABLED: "false",
    VIPTEL_LIVE_MUTATION_TOKEN: "live-mutation-authority-token-0001",
    VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED: "true",
    VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN: bridgeToken,
  };
  const listenerPath = join(env, "viptel-listener.env");
  writeFileSync(join(env, "web.env"), serialize(common), { mode: 0o600 });
  writeFileSync(join(env, "worker.env"), serialize({
    ...common,
    WORKER_INSTANCE_ID: "motorist-prod-01",
    SCHEDULER_ENABLED: "false",
    HEALTHCHECKS_PING_URL: "https://hc-ping.com/11111111-1111-4111-8111-111111111111",
  }), { mode: 0o600 });
  writeFileSync(listenerPath, serialize({
    ...common,
    VIPTEL_LISTENER_INSTANCE_ID: "motorist-prod-01-viptel",
    VIPTEL_LISTENER_ENABLED: "false",
    VIPTEL_LIVE_MUTATIONS_ENABLED: "false",
    VIPTEL_LIVE_MUTATION_TOKEN: "live-mutation-authority-token-0001",
    VIPTEL_DISPATCH_PERSONAL_EXTENSIONS: "20,21,22,23",
    VIPTEL_HEALTHCHECKS_PING_URL: "https://hc-ping.com/22222222-2222-4222-8222-222222222222",
  }), { mode: 0o600 });
  writeFileSync(join(env, "caddy.env"), serialize({
    APP_DOMAIN: "dispecing.linkapomoci.sk",
    ACME_EMAIL: "info@example.test",
  }), { mode: 0o600 });
  for (const name of ["web.env", "worker.env", "viptel-listener.env", "caddy.env"]) {
    chmodSync(join(env, name), 0o600);
  }
  return { root, env, listenerPath, bridgeToken };
}

function makeFakeDockerHandover(t, { failNewHealth = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "motorist-handover-e2e-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldRelease = join(root, "old");
  const newRelease = join(root, "new");
  const fakeBin = join(root, "fake-bin");
  const receipts = join(root, "receipts");
  const statePath = join(root, "listener-state");
  const dockerLog = join(root, "docker.log");
  const validatorLog = join(root, "validator.log");
  for (const path of [join(oldRelease, "env"), join(newRelease, "env"), join(newRelease, "bin"), fakeBin, receipts]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  writeManifest(join(oldRelease, "manifest.json"), oldVersion, "a".repeat(40));
  writeManifest(join(newRelease, "manifest.json"), newVersion, "f".repeat(40));
  for (const release of [oldRelease, newRelease]) {
    writeFileSync(join(release, "SHA256SUMS"), "fixture\n");
    writeFileSync(join(release, "compose.yml"), "name: motorist-dispatch\nservices: {}\n");
  }
  writeFileSync(join(oldRelease, "env/worker.env"), 'SCHEDULER_ENABLED="true"\n', { mode: 0o600 });
  writeFileSync(join(oldRelease, "env/viptel-listener.env"), 'VIPTEL_LISTENER_ENABLED="true"\n', { mode: 0o600 });
  writeFileSync(join(newRelease, "env/viptel-listener.env"), [
    'VIPTEL_LISTENER_ENABLED="false"',
    'VIPTEL_LIVE_MUTATIONS_ENABLED="false"',
    'VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED="true"',
    'VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN="provider-snapshot-bridge-authority-0001"',
    'VIPTEL_DISPATCH_PERSONAL_EXTENSIONS="20,21,22,23"',
    "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(statePath, "old\n");
  writeFileSync(dockerLog, "");
  writeFileSync(validatorLog, "");

  const scriptPath = join(newRelease, "bin/handover-viptel-listener-only.sh");
  writeFileSync(
    scriptPath,
    readFileSync(handover, "utf8").replace(
      'operation_root="/opt/motorist/receipts"',
      `operation_root=${JSON.stringify(receipts)}`,
    ),
  );
  chmodSync(scriptPath, 0o700);

  const validatorStub = join(newRelease, "bin/validate-activation-inputs.py");
  writeFileSync(validatorStub, `#!/usr/bin/env python3
import hashlib, os, re, sys
command = sys.argv[1]
with open(os.environ["FAKE_VALIDATOR_LOG"], "a", encoding="utf-8") as log:
    log.write(command + " " + " ".join(sys.argv[2:]) + "\\n")
if command == "set-handover-listener-flags":
    release = sys.argv[2]
    enabled = sys.argv[sys.argv.index("--enabled") + 1]
    path = os.path.join(release, "env", "viptel-listener.env")
    with open(path, "r", encoding="utf-8") as source:
        contents = source.read()
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
elif command == "handover-state" and os.environ.get("FAKE_NEW_HEALTH_FAIL") == "1":
    listener_version = sys.argv[sys.argv.index("--listener-version") + 1]
    if listener_version == os.environ["FAKE_NEW_VERSION"]:
        raise SystemExit("injected new-listener health failure")
`);
  chmodSync(validatorStub, 0o700);

  const lockStub = join(newRelease, "bin/open-operation-lock.py");
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

  const dockerStub = join(fakeBin, "docker");
  writeFileSync(dockerStub, `#!/usr/bin/env bash
set -euo pipefail
command_name=$1
shift
state=$(tr -d '\\n' <"$FAKE_STATE_FILE")
case "$command_name" in
  image)
    image_name="\${@: -1}"
    if [[ "$image_name" == "$FAKE_OLD_IMAGE" ]]; then
      echo "$FAKE_OLD_IMAGE_ID"
    elif [[ "$image_name" == "$FAKE_NEW_IMAGE" ]]; then
      echo "$FAKE_NEW_IMAGE_ID"
    else
      exit 1
    fi
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
      elif [[ "$state" == old ]]; then
        printf '%064d\\n' 2
      else
        printf '%064d\\n' 3
      fi
    elif [[ "$action" == up ]]; then
      if [[ "$PWD" == "$FAKE_OLD_RELEASE" ]]; then next_state=old; else next_state=new; fi
      printf '%s\\n' "$next_state" >"$FAKE_STATE_FILE"
      printf 'up:%s:%s\\n' "$next_state" "$service_name" >>"$FAKE_DOCKER_LOG"
    else
      exit 1
    fi
    ;;
  inspect)
    format=$2
    container="\${@: -1}"
    if [[ "$container" == "$(printf '%064d' 1)" ]]; then
      selected_image="$FAKE_OLD_IMAGE_ID"
      selected_source="$FAKE_OLD_RELEASE/env/worker.env"
      selected_id="$container"
    elif [[ "$state" == old ]]; then
      selected_image="$FAKE_OLD_IMAGE_ID"
      selected_source="$FAKE_OLD_RELEASE/env/viptel-listener.env"
      selected_id="$(printf '%064d' 2)"
    else
      selected_image="$FAKE_NEW_IMAGE_ID"
      selected_source="$FAKE_NEW_RELEASE/env/viptel-listener.env"
      selected_id="$(printf '%064d' 3)"
    fi
    if [[ "$format" == *'.Id}}|'* ]]; then
      printf '%s|%s|true|2026-08-05T00:00:00Z|0001-01-01T00:00:00Z\\n' "$selected_id" "$selected_image"
    elif [[ "$format" == *'.Image}}'* ]]; then
      echo "$selected_image"
    elif [[ "$format" == *'.State.Running}}'* ]]; then
      echo true
    elif [[ "$format" == *'.Mounts'* ]]; then
      echo "$selected_source"
    else
      exit 1
    fi
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

  for (const release of [oldRelease, newRelease]) {
    writeFileSync(
      join(release, "SHA256SUMS"),
      `${sha256(readFileSync(join(release, "manifest.json")))}  manifest.json\n`,
    );
  }

  const oldImage = `motorist-app:${oldVersion}`;
  const newImage = `motorist-app:${newVersion}`;
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_STATE_FILE: statePath,
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_VALIDATOR_LOG: validatorLog,
    FAKE_OLD_RELEASE: oldRelease,
    FAKE_NEW_RELEASE: newRelease,
    FAKE_OLD_IMAGE: oldImage,
    FAKE_NEW_IMAGE: newImage,
    FAKE_OLD_IMAGE_ID: `sha256:${"b".repeat(64)}`,
    FAKE_NEW_IMAGE_ID: `sha256:${"c".repeat(64)}`,
    FAKE_NEW_VERSION: newVersion,
    FAKE_NEW_HEALTH_FAIL: failNewHealth ? "1" : "0",
  };
  delete env.MOTORIST_OPERATION_LOCK_FD;
  const run = spawnSync(scriptPath, [
    oldRelease,
    newRelease,
    "a".repeat(40),
    "f".repeat(40),
  ], { encoding: "utf8", env, timeout: 10_000 });
  return { root, run, statePath, dockerLog, validatorLog, receipts, newRelease };
}

test("historic handover release and active runtime are exact-hash bound", (t) => {
  const item = makeHistoricRelease();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const releaseSha = sha256(item.sums);
  const verified = spawnSync("python3", [
    validator,
    "verify-handover-release",
    item.release,
    oldVersion,
    "--expected-git-sha",
    "a".repeat(40),
    "--expected-release-sha256",
    releaseSha,
  ], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);

  const runtime = spawnSync("python3", [
    validator,
    "verify-handover-old-runtime",
    item.release,
    oldVersion,
    "--expected-worker-sha256",
    sha256(readFileSync(join(item.release, "env/worker.env"))),
    "--expected-listener-sha256",
    sha256(readFileSync(join(item.release, "env/viptel-listener.env"))),
  ], { encoding: "utf8" });
  assert.equal(runtime.status, 0, runtime.stderr);

  writeFileSync(join(item.release, "unbound.txt"), "not checksummed\n");
  const unbound = spawnSync("python3", [
    validator,
    "verify-handover-release",
    item.release,
    oldVersion,
    "--expected-git-sha",
    "a".repeat(40),
    "--expected-release-sha256",
    releaseSha,
  ], { encoding: "utf8" });
  assert.notEqual(unbound.status, 0);
  assert.match(unbound.stderr, /does not cover the exact immutable release/);
});

test("handover flag update preserves the independent provider bridge", (t) => {
  const item = makeNewRuntime();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const before = sha256(readFileSync(item.listenerPath));
  const enabled = spawnSync("python3", [
    validator,
    "set-handover-listener-flags",
    item.root,
    newVersion,
    "--enabled",
    "true",
    "--expected-listener-sha256",
    before,
    "--output",
    "hash",
  ], { encoding: "utf8" });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout.trim(), /^[0-9a-f]{64}$/);
  assert.equal(`${enabled.stdout}${enabled.stderr}`.includes(item.bridgeToken), false);
  const contents = readFileSync(item.listenerPath, "utf8");
  assert.match(contents, /VIPTEL_LISTENER_ENABLED="true"/);
  assert.match(contents, /VIPTEL_LIVE_MUTATIONS_ENABLED="true"/);
  assert.match(contents, /VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED="true"/);
  assert.match(contents, /VIPTEL_DISPATCH_PERSONAL_EXTENSIONS="20,21,22,23"/);
  assert.ok(contents.includes(item.bridgeToken));
});

test("split-release listener validation binds disabled candidates and active rollback runtimes", (t) => {
  const item = makeNewRuntime();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));

  const validate = (enabled) => spawnSync("python3", [
    validator,
    "verify-handover-listener-runtime",
    item.root,
    newVersion,
    "--expected-listener-sha256",
    sha256(readFileSync(item.listenerPath)),
    "--enabled",
    enabled,
  ], { encoding: "utf8" });

  const disabled = validate("false");
  assert.equal(disabled.status, 0, disabled.stderr);

  const activeContents = readFileSync(item.listenerPath, "utf8")
    .replace(/VIPTEL_LISTENER_ENABLED="false"/, 'VIPTEL_LISTENER_ENABLED="true"')
    .replace(/VIPTEL_LIVE_MUTATIONS_ENABLED="false"/, 'VIPTEL_LIVE_MUTATIONS_ENABLED="true"');
  writeFileSync(item.listenerPath, activeContents, { mode: 0o600 });
  chmodSync(item.listenerPath, 0o600);

  const active = validate("true");
  assert.equal(active.status, 0, active.stderr);
  const mismatched = validate("false");
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /handover state is not the expected value/);
});

test("staged runtime validates bridge authority and exact personal extensions", (t) => {
  const item = makeNewRuntime();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const validate = () => spawnSync("python3", [
    validator,
    "verify-handover-stage-runtime",
    item.root,
    newVersion,
  ], { encoding: "utf8" });
  const accepted = validate();
  assert.equal(accepted.status, 0, accepted.stderr);

  const shortToken = readFileSync(item.listenerPath, "utf8").replace(
    /VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN=.*\n/,
    `VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN=${JSON.stringify("short")}\n`,
  );
  writeFileSync(item.listenerPath, shortToken, { mode: 0o600 });
  chmodSync(item.listenerPath, 0o600);
  const rejected = validate();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /provider snapshot bridge authority length is invalid/);

  const disabledBridge = shortToken
    .replace(/VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED=.*\n/, 'VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED="false"\n')
    .replace(/VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN=.*\n/, `VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN=${JSON.stringify(item.bridgeToken)}\n`);
  writeFileSync(item.listenerPath, disabledBridge, { mode: 0o600 });
  chmodSync(item.listenerPath, 0o600);
  const disabled = validate();
  assert.notEqual(disabled.status, 0);
  assert.match(disabled.stderr, /provider snapshot bridge is not in the required state/);
});

test("staged runtime rejects web/listener VIPTel authority mismatch", (t) => {
  const item = makeNewRuntime();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const listener = readFileSync(item.listenerPath, "utf8").replace(
    /VIPTEL_LIVE_MUTATION_TOKEN=.*\n/,
    `VIPTEL_LIVE_MUTATION_TOKEN=${JSON.stringify("different-live-mutation-authority-0001")}\n`,
  );
  writeFileSync(item.listenerPath, listener, { mode: 0o600 });
  chmodSync(item.listenerPath, 0o600);
  const rejected = spawnSync("python3", [
    validator,
    "verify-handover-stage-runtime",
    item.root,
    newVersion,
  ], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /web\/listener VIPTel live-mutation authority mismatch/);
});

test("handover state permits only the preserved scheduler and reconciliation job", () => {
  const now = new Date().toISOString();
  const rows = [
    {
      instance_id: "motorist-prod-01",
      deployment_version: oldVersion,
      heartbeat_at: now,
      scheduler_tick_at: now,
      scheduler_status: "running",
      viptel_ws_status: "disabled",
    },
    {
      instance_id: "motorist-prod-01-viptel",
      deployment_version: newVersion,
      heartbeat_at: now,
      scheduler_tick_at: null,
      scheduler_status: "listener",
      viptel_ws_status: "connected",
    },
  ];
  const run = (value, boundary) => spawnSync("python3", [
    "-c",
    [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('validator',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "boundary=sys.argv[5] if len(sys.argv)>5 else None",
      "module.validate_handover_heartbeat_rows(json.loads(sys.argv[2]),sys.argv[3],sys.argv[4],boundary)",
    ].join(";"),
    validator,
    JSON.stringify(value),
    oldVersion,
    newVersion,
    ...(boundary ? [boundary] : []),
  ], { encoding: "utf8" });
  const accepted = run(rows);
  assert.equal(accepted.status, 0, accepted.stderr);
  const earlierBoundary = new Date(Date.parse(now) - 1_000).toISOString();
  assert.equal(run(rows, earlierBoundary).status, 0);
  const equalBoundary = run(rows, now);
  assert.notEqual(equalBoundary.status, 0);
  assert.match(equalBoundary.stderr, /heartbeat predates the required boundary/);
  const changedWorker = structuredClone(rows);
  changedWorker[0].deployment_version = newVersion;
  assert.notEqual(run(changedWorker).status, 0);
  const duplicate = [...rows, rows[1]];
  assert.notEqual(run(duplicate).status, 0);
});

test("handover mutates only the listener and has an exact old-listener rollback", () => {
  const script = readFileSync(handover, "utf8");
  assert.match(script, /preserved_jobs="telephony\.viptel\.reconcile"/);
  assert.match(script, /compose_project="motorist-dispatch"/);
  assert.match(script, /docker compose --project-name "\$compose_project" -f compose\.yml up[\s\\]+-d --no-deps --force-recreate "\$service"/);
  assert.match(script, /start_listener_from "\$old_release_dir" "\$old_image_id"/);
  assert.match(script, /verify_worker_unchanged/);
  assert.match(script, /worker_container_sha256/);
  assert.match(script, /schedulerAndControlsPreserved/);
  assert.match(script, /"preservedJobs": \["telephony\.viptel\.reconcile"\]/);
  assert.doesNotMatch(script, /set-controls|--mode enable|--mode disable/);
  assert.doesNotMatch(script, /(?:up|start|stop|restart)[^\n]*(?:worker|web_blue|web_green|caddy)/);
  assert.doesNotMatch(script, /\bmapfile\b/);
  assert.equal(script.includes("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED="), false);
  assert.equal(spawnSync("bash", ["-n", handover]).status, 0);
});

test("fake Docker handover succeeds without recreating the worker", (t) => {
  const item = makeFakeDockerHandover(t);
  assert.equal(item.run.status, 0, `${item.run.stdout}\n${item.run.stderr}`);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "new");
  assert.equal(readFileSync(item.dockerLog, "utf8").trim(), "up:new:viptel_listener");
  const validatorCalls = readFileSync(item.validatorLog, "utf8");
  assert.doesNotMatch(validatorCalls, /set-controls/);
  assert.match(validatorCalls, /controls-state/);
  const receiptFiles = readdirSync(item.receipts).filter((name) => name.endsWith(".jsonl"));
  assert.equal(receiptFiles.length, 1);
  const records = readFileSync(join(item.receipts, receiptFiles[0]), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[1].status, "success");
  assert.equal(records[1].activeListenerReleaseVersion, newVersion);
  assert.deepEqual(records[1].preservedJobs, ["telephony.viptel.reconcile"]);
  assert.equal(records[1].providerSnapshotBridgeEnabled, true);
  assert.deepEqual(records[1].personalExtensions, ["20", "21", "22", "23"]);
  assert.equal(records[1].workerUnchanged, true);
  assert.equal(records[1].schedulerAndControlsPreserved, true);
});

test("fake Docker health failure restores the exact old listener", (t) => {
  const item = makeFakeDockerHandover(t, { failNewHealth: true });
  assert.notEqual(item.run.status, 0);
  assert.match(item.run.stderr, /injected new-listener health failure/);
  assert.equal(readFileSync(item.statePath, "utf8").trim(), "old");
  assert.deepEqual(
    readFileSync(item.dockerLog, "utf8").trim().split("\n"),
    ["up:new:viptel_listener", "up:old:viptel_listener"],
  );
  assert.match(
    readFileSync(join(item.newRelease, "env/viptel-listener.env"), "utf8"),
    /VIPTEL_LISTENER_ENABLED="false"/,
  );
  const receiptFile = readdirSync(item.receipts).find((name) => name.endsWith(".jsonl"));
  assert.ok(receiptFile);
  const records = readFileSync(join(item.receipts, receiptFile), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records[1].status, "failure");
  assert.equal(records[1].stage, "rollback_complete");
  assert.equal(records[1].activeListenerReleaseVersion, oldVersion);
  assert.equal(records[1].workerUnchanged, true);
  assert.equal(records[1].schedulerAndControlsPreserved, true);
});

test("staging is atomic and never starts or changes the existing Compose project", () => {
  const script = readFileSync(staging, "utf8");
  assert.match(script, /destination="\$release_root\/\$version"/);
  assert.match(script, /capture-private-evidence\.py/);
  assert.match(script, /verify-handover-stage-runtime/);
  assert.match(script, /docker compose --project-name "\$compose_project" -f compose\.yml config --quiet/);
  assert.match(script, /docker load --input "\$temporary\/image\.tar\.gz"/);
  assert.match(script, /mv -T -- "\$temporary" "\$destination"/);
  assert.match(script, /"servicesStarted": \[\]/);
  assert.match(script, /"existingProjectChanged": False/);
  assert.doesNotMatch(script, /docker compose[^\n]*(?:up|down|start|stop|restart|rm)/);
  assert.equal(spawnSync("bash", ["-n", staging]).status, 0);
});

test("release tooling checksum-binds both handover operations", () => {
  const builder = readFileSync(resolve("deploy/bin/build-release.sh"), "utf8");
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");
  const validation = readFileSync(validator, "utf8");
  for (const name of ["handover-viptel-listener-only.sh", "stage-viptel-listener-handover.sh"]) {
    for (const implementation of [builder, installer, validation]) {
      assert.ok(implementation.includes(name), `${name} missing from release tooling`);
    }
  }
});
