import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { clientAssetScanMatchesTarget } from "../deploy/bin/client-asset-scan-status.mjs";

const timestampHelper = resolve("deploy/bin/validate-gate-timestamp.py");
const receiptHelper = resolve("deploy/bin/write-cutover-receipt.py");
const captureHelper = resolve("deploy/bin/capture-private-evidence.py");

function utcTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function runPython(script, args) {
  return spawnSync("python3", [script, ...args], { encoding: "utf8" });
}

function installerUsesImmutableAppImages(installer) {
  const digestCheck = installer.indexOf('[[ "$actual_id" == "$expected_id" ]]');
  const executionTail = installer.slice(digestCheck + 1);
  const probeStart = installer.indexOf('"$expected_id" >/dev/null', digestCheck);
  const probeImageCheck = installer.indexOf(
    'verify_container_image_id "$probe_container"',
    probeStart,
  );
  const probeHealth = installer.indexOf('probe_port=$(docker port', probeStart);
  const composeStart = installer.indexOf("timeout 210 docker compose", digestCheck);
  const composeImageCheck = installer.indexOf(
    'verify_compose_service_image_id "$app_service"',
    composeStart,
  );
  const composeHealthy = installer.indexOf("cutover_compose_healthy=true", composeStart);

  return (
    digestCheck >= 0
    && !executionTail.includes('"$image"')
    && installer.includes('docker run --rm --entrypoint sh "$expected_id" -c')
    && (installer.match(/docker run --rm --entrypoint sh "\$expected_id" -c/g) ?? []).length === 2
    && probeStart > digestCheck
    && probeImageCheck > probeStart
    && probeHealth > probeImageCheck
    && installer.includes('export WEB_BLUE_IMAGE="$expected_id"')
    && installer.includes('export WEB_GREEN_IMAGE="$expected_id"')
    && installer.includes('export WORKER_IMAGE="$expected_id"')
    && installer.includes('export VIPTEL_LISTENER_IMAGE="$expected_id"')
    && installer.includes("actual_container_image_id=$(docker inspect --format '{{.Image}}'")
    && installer.includes('[[ "$actual_container_image_id" == "$expected_id" ]]')
    && composeStart > digestCheck
    && composeImageCheck > composeStart
    && composeHealthy > composeImageCheck
  );
}

function receiptArgs(
  path,
  mode,
  status,
  stage,
  {
    booleans = ["false", "false", "false"],
    storageTransitionHash = "9".repeat(64),
  } = {},
) {
  return [
    path,
    mode,
    status,
    stage,
    "hetzner-security-test",
    "motorist-app:hetzner-security-test",
    `sha256:${"a".repeat(64)}`,
    "b".repeat(64),
    "c".repeat(64),
    "e".repeat(64),
    "20260714T184445Z",
    "20260715T101500Z-123-456",
    "d".repeat(64),
    "f".repeat(64),
    "1".repeat(64),
    "2".repeat(64),
    "3".repeat(64),
    storageTransitionHash,
    JSON.stringify({
      application: "4".repeat(64),
      auth: "5".repeat(64),
      config: "6".repeat(64),
      database: "7".repeat(64),
      storage: "8".repeat(64),
    }),
    "2026-07-15T10:15:00Z",
    ...booleans,
  ];
}

test("gate timestamp helper accepts only a fresh strict UTC timestamp", () => {
  assert.equal(runPython(timestampHelper, [utcTimestamp(new Date())]).status, 0);
  assert.notEqual(runPython(timestampHelper, [utcTimestamp(new Date(Date.now() - 31 * 60_000))]).status, 0);
  assert.notEqual(runPython(timestampHelper, [utcTimestamp(new Date(Date.now() + 60_000))]).status, 0);
  assert.notEqual(runPython(timestampHelper, ["2026-07-15T07:00:00+00:00"]).status, 0);
  assert.notEqual(runPython(timestampHelper, ["not-a-timestamp"]).status, 0);
});

test("cutover uses a five-minute gate while probe may use thirty minutes", () => {
  const tenMinutesOld = utcTimestamp(new Date(Date.now() - 10 * 60_000));
  assert.equal(runPython(timestampHelper, [tenMinutesOld, "1800"]).status, 0);
  assert.notEqual(runPython(timestampHelper, [tenMinutesOld, "300"]).status, 0);
  assert.notEqual(runPython(timestampHelper, [tenMinutesOld, "1801"]).status, 0);
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");
  assert.match(installer, /--install-after-dns-cutover.*maximum_age_seconds=300/);
});

test("client asset scans accept only source grep 1 and target grep 0", () => {
  assert.equal(clientAssetScanMatchesTarget(1, 0), true);
  assert.equal(clientAssetScanMatchesTarget(0, 0), false);
  assert.equal(clientAssetScanMatchesTarget(2, 0), false);
  assert.equal(clientAssetScanMatchesTarget(125, 0), false);
  assert.equal(clientAssetScanMatchesTarget(1, 1), false);
  assert.equal(clientAssetScanMatchesTarget(1, 2), false);
  assert.equal(clientAssetScanMatchesTarget(1, 125), false);
  assert.equal(clientAssetScanMatchesTarget(null, 0), false);
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");
  const validator = readFileSync(resolve("deploy/supabase/validate-application-release.mjs"), "utf8");
  assert.doesNotMatch(installer, /grep -R -F/);
  assert.doesNotMatch(validator, /grep -R -F/);
  assert.equal((installer.match(/grep -r -F/g) ?? []).length, 2);
  assert.equal((validator.match(/grep -r -F/g) ?? []).length, 2);
});

test("gate timestamp is rechecked after a simulated image-load delay", async () => {
  const nearlyExpired = utcTimestamp(new Date());
  assert.equal(runPython(timestampHelper, [nearlyExpired, "2"]).status, 0);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_100));
  assert.notEqual(runPython(timestampHelper, [nearlyExpired, "2"]).status, 0);
});

test("installer revalidates the gate after image and asset checks before probe", () => {
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");
  const imageLoad = installer.indexOf("gzip -dc image.tar.gz | docker load");
  const assetScan = installer.indexOf("source_client_asset_status=$?");
  const postLoadFreshness = installer.indexOf("require_fresh_gate_timestamp", assetScan);
  const probeBranch = installer.indexOf('if [[ "$action" == --probe-candidate-only ]]', assetScan);

  assert.notEqual(imageLoad, -1);
  assert.ok(assetScan > imageLoad);
  assert.ok(postLoadFreshness > assetScan);
  assert.ok(probeBranch > postLoadFreshness);
});

test("installer runs and verifies every app container by immutable image ID", () => {
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");
  assert.equal(installerUsesImmutableAppImages(installer), true);

  const tagBasedScan = installer.replace(
    'docker run --rm --entrypoint sh "$expected_id" -c',
    'docker run --rm --entrypoint sh "$image" -c',
  );
  const tagBasedWorker = installer.replace(
    'export WORKER_IMAGE="$expected_id"',
    'export WORKER_IMAGE="$image"',
  );
  const uncheckedProbe = installer.replace(
    'verify_container_image_id "$probe_container"',
    'true # probe image check removed',
  );
  const uncheckedCompose = installer.replace(
    'verify_compose_service_image_id "$app_service"',
    'true # compose image check removed',
  );

  for (const unsafeMutation of [tagBasedScan, tagBasedWorker, uncheckedProbe, uncheckedCompose]) {
    assert.equal(installerUsesImmutableAppImages(unsafeMutation), false);
  }
});

test("installer snapshots gate, runtime env, and the entire release before use", () => {
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");
  const firstCapture = installer.indexOf('capture-private-evidence.py" "$input_gate_report" "$gate_report"');
  const releaseCapture = installer.indexOf('for release_name in image.tar.gz manifest.json compose.yml Caddyfile upstream.caddy runtime-env-parser.mjs SHA256SUMS');
  const releaseBinCapture = installer.indexOf("for release_bin_name in");
  const validation = installer.indexOf("readarray -t validated_fields");
  const runtimeInstall = installer.indexOf('install -m 0600 "$runtime_env_dir/web.env" env/web.env');

  assert.notEqual(firstCapture, -1);
  assert.ok(releaseCapture > firstCapture);
  assert.ok(releaseBinCapture > releaseCapture);
  assert.ok(validation > firstCapture);
  assert.ok(validation > releaseCapture);
  assert.ok(validation > releaseBinCapture);
  assert.ok(runtimeInstall > validation);
  assert.match(installer, /runtime_env_dir="\$validated_runtime_env_dir"/);
  assert.match(installer, /release_dir="\$validated_release_dir"/);
  assert.match(installer, /validated_installer_dir="\$release_dir\/bin"/);
  assert.match(installer, /validated_installer_dir}\/validate-gate-timestamp\.py/);
  assert.match(installer, /validated_installer_dir}\/write-cutover-receipt\.py/);
  assert.match(installer, /retain_validated_inputs=true/);
  assert.match(installer, /for env_name in web\.env worker\.env viptel-listener\.env caddy\.env/);
  for (const helper of [
    "install-release.sh",
    "open-operation-lock.py",
    "run-one-shot-job.sh",
    "write-one-shot-receipt.py",
    "activate-after-cutover.sh",
    "activate-telephony-background.sh",
    "activate-viptel-listener-only.sh",
    "handover-viptel-listener-only.sh",
    "upgrade-viptel-listener-only.sh",
    "stage-viptel-listener-handover.sh",
    "prepare-runtime-env.mjs",
    "runtime-env-contract.mjs",
    "validate-activation-inputs.py",
    "create-activation-gate.py",
    "probe-viptel-listener.sh",
    "write-viptel-listener-receipt.py",
  ]) {
    assert.match(installer, new RegExp(helper.replaceAll(".", "\\.")));
  }
});

test("runtime secrets are mounted as files and are not exposed through compose env_file", () => {
  const compose = readFileSync(resolve("deploy/compose.yml"), "utf8");
  const entrypoint = readFileSync(resolve("deploy/runtime-entrypoint.mjs"), "utf8");
  const runtimeParser = readFileSync(resolve("deploy/runtime-env-parser.mjs"), "utf8");
  const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");
  const applicationValidator = readFileSync(resolve("deploy/supabase/validate-application-release.mjs"), "utf8");
  assert.match(compose, /web_runtime:[\s\S]*file: \.\/env\/web\.env/);
  assert.match(compose, /worker_runtime:[\s\S]*file: \.\/env\/worker\.env/);
  assert.match(compose, /viptel_listener_runtime:[\s\S]*file: \.\/env\/viptel-listener\.env/);
  assert.doesNotMatch(compose, /env_file:\s*\n\s*- \.\/env\/(web|worker|viptel-listener)\.env/);
  assert.match(entrypoint, /\/run\/secrets\/runtime_env/);
  assert.match(entrypoint, /parseRuntimeEnv\(contents\)/);
  assert.match(dockerfile, /runtime-env-parser\.mjs/);
  assert.match(runtimeParser, /JSON\.parse\(encoded\)/);
  assert.match(runtimeParser, /Object\.hasOwn\(parsed, key\)/);
  assert.match(entrypoint, /process\.setgid\(1001\)/);
  assert.match(entrypoint, /process\.setuid\(1001\)/);
  const secretRead = entrypoint.indexOf("open(secretPath");
  const groupDrop = entrypoint.indexOf("process.setgid(1001)");
  const userDrop = entrypoint.indexOf("process.setuid(1001)");
  assert.ok(secretRead >= 0 && groupDrop > secretRead && userDrop > groupDrop);
  assert.equal((compose.match(/- DAC_OVERRIDE/g) ?? []).length, 3);
  assert.equal((compose.match(/- SETGID/g) ?? []).length, 3);
  assert.equal((compose.match(/- SETUID/g) ?? []).length, 3);
  assert.equal(
    (compose.match(/cap_add:\s*\n\s*- DAC_OVERRIDE\s*\n\s*- SETGID\s*\n\s*- SETUID/g) ?? []).length,
    3,
  );
  assert.match(installer, /--cap-drop ALL\s*\\\n\s*--cap-add DAC_OVERRIDE\s*\\\n\s*--cap-add SETGID\s*\\\n\s*--cap-add SETUID/);
  assert.match(installer, /probe_file\.write\(f"\{key\}=\{json\.dumps\(value, ensure_ascii=True\)\}\\n"\)/);
  const candidateStart = installer.indexOf("docker run --detach --rm", installer.indexOf("--probe-candidate-only"));
  const candidateEnd = installer.indexOf('"$expected_id" >/dev/null', candidateStart);
  const candidate = installer.slice(candidateStart, candidateEnd);
  assert.match(candidate, /--read-only/);
  assert.match(candidate, /--tmpfs \/tmp:/);
  assert.match(candidate, /--cap-drop ALL/);
  assert.match(candidate, /--cap-add DAC_OVERRIDE/);
  assert.match(candidate, /--cap-add SETGID/);
  assert.match(candidate, /--cap-add SETUID/);
  assert.match(candidate, /--security-opt no-new-privileges:true/);
  assert.match(candidate, /--pids-limit 256/);
  assert.match(candidate, /--memory 1g/);
  assert.match(candidate, /--cpus 1\.25/);
  assert.match(candidate, /target=\/run\/secrets\/runtime_env,readonly/);
  for (const envName of ["web", "worker", "viptel-listener", "caddy"]) {
    assert.match(installer, new RegExp(`install -m 0600 .*${envName.replace("-", "\\-")}\\.env`));
  }
  assert.match(applicationValidator, /"--cap-drop",\s*"ALL",\s*"--cap-add",\s*"DAC_OVERRIDE",\s*"--cap-add",\s*"SETGID",\s*"--cap-add",\s*"SETUID"/s);
  assert.match(applicationValidator, /serializeApplicationRuntimeEnv\(runtime\.env\.web\)/);
  assert.doesNotMatch(applicationValidator, /return `\$\{key\}=\$\{value\}`/);
  assert.doesNotMatch(`${compose}\n${installer}\n${applicationValidator}`, /DAC_READ_SEARCH/);
  assert.equal(entrypoint.includes("RUNTIME_ENV_SECRET_PATH"), false);
  assert.match(entrypoint, /constants\.O_RDONLY \| constants\.O_NOFOLLOW/);
  assert.match(entrypoint, /!metadata\.isFile\(\) \|\| metadata\.nlink !== 1/);
  assert.match(entrypoint, /\(metadata\.mode & 0o077\) !== 0/);
  assert.match(entrypoint, /metadata\.size > maximumSecretBytes/);
});

test("DB relay preflight accepts both managed target credential lifecycles", () => {
  const relay = readFileSync(resolve("deploy/supabase/manage-db-relay.zsh"), "utf8");
  assert.match(
    relay,
    /target_extended_cli_source_management_api\|target_temporary_cli_source_management_api/,
  );
  assert.match(relay, /SOURCE_DB_VALIDATION_MODE:-.*management_api_read_only/s);
});

test("cutover requires authoritative DNS and a final fresh gate before its first write", () => {
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");
  const dnsValidation = installer.lastIndexOf("validate_authoritative_dns");
  const receiptDirectoryCheck = installer.indexOf('receipt directory must not traverse symlinks');
  const finalFreshness = installer.indexOf("require_fresh_gate_timestamp", receiptDirectoryCheck);
  const firstCutoverWrite = installer.indexOf("write_cutover_receipt create", receiptDirectoryCheck);

  assert.match(installer, /dig .*\+noall \+comments \+answer A/);
  assert.doesNotMatch(installer, /getent ahostsv4/);
  assert.ok(dnsValidation > 0);
  assert.ok(finalFreshness > receiptDirectoryCheck);
  assert.ok(firstCutoverWrite > finalFreshness);
});

test("cutover preserves its exact combined gate once before the first receipt write", () => {
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");
  const activationGate = readFileSync(resolve("deploy/bin/create-activation-gate.py"), "utf8");
  const receiptDirectoryCheck = installer.indexOf("receipt directory must not traverse symlinks");
  const finalFreshness = installer.indexOf("require_fresh_gate_timestamp", receiptDirectoryCheck);
  const preservation = installer.indexOf(
    'python3 "$validated_installer_dir/capture-private-evidence.py"',
    finalFreshness,
  );
  const preservedDestination = installer.indexOf('"$combined_gate_receipt_path"', preservation);
  const checksumVerification = installer.indexOf(
    '[[ "$preserved_gate_sha256" == "$gate_report_sha256" ]]',
    preservation,
  );
  const firstCutoverWrite = installer.indexOf("write_cutover_receipt create", receiptDirectoryCheck);

  assert.match(
    installer,
    /combined_gate_receipt_path="\$receipt_dir\/cutover-\$\{version\}\.combined-gate\.json"/,
  );
  assert.match(
    installer,
    /-e "\$combined_gate_receipt_path" \|\| -L "\$combined_gate_receipt_path"/,
  );
  assert.ok(finalFreshness >= 0);
  assert.ok(preservation > finalFreshness);
  assert.ok(preservedDestination > preservation);
  assert.ok(checksumVerification > preservedDestination);
  assert.ok(firstCutoverWrite > checksumVerification);
  assert.match(
    activationGate,
    /f"cutover-\{manifest\['version'\]\}\.combined-gate\.json"/,
  );

  const directory = mkdtempSync(join(tmpdir(), "motorist-combined-gate-preservation-"));
  const source = join(directory, "combined-gate.json");
  const destination = join(directory, "cutover-test.combined-gate.json");
  writeFileSync(source, '{"gate_status":"pass_predeployment"}\n', { mode: 0o600 });
  assert.equal(runPython(captureHelper, [source, destination]).status, 0);
  const preserved = readFileSync(destination, "utf8");
  writeFileSync(source, '{"gate_status":"changed"}\n', { mode: 0o600 });
  assert.notEqual(runPython(captureHelper, [source, destination]).status, 0);
  assert.equal(readFileSync(destination, "utf8"), preserved);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
});

test("Storage transition identity is bound from the combined gate into the cutover receipt", () => {
  const gate = readFileSync(resolve("deploy/supabase/validate-cutover-gate.zsh"), "utf8");
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");
  const receiptWriter = readFileSync(receiptHelper, "utf8");
  const activationGate = readFileSync(resolve("deploy/bin/create-activation-gate.py"), "utf8");

  assert.match(gate, /live_storage_transition_manifest_sha256: \$live_storage_transition_manifest_sha256/);
  assert.match(installer, /gate\.get\("live_storage_transition_manifest_sha256"\)/);
  assert.match(installer, /"\$live_storage_transition_manifest_sha256"/);
  assert.match(receiptWriter, /"live_storage_transition_manifest_sha256": live_storage_transition_manifest_sha256/);
  assert.ok(
    (activationGate.match(/"live_storage_transition_manifest_sha256"/g) ?? []).length >= 2,
  );
});

test("Rentals Vercel reconciliation is fully preflighted and only schema v2 evidence passes", () => {
  const helper = readFileSync(resolve("deploy/bin/ensure-rentals-vercel-env.mjs"), "utf8");
  const configValidator = readFileSync(resolve("deploy/supabase/validate-project-config-snapshot.zsh"), "utf8");
  const gate = readFileSync(resolve("deploy/supabase/validate-cutover-gate.zsh"), "utf8");
  const preflight = helper.indexOf("await probeTarget(publishableKey, serviceRoleKey)");
  const receiptReservation = helper.indexOf("const descriptor = openSync");
  const firstPatch = helper.indexOf("for (const { key, value, record, target } of updates)");

  assert.ok(preflight >= 0);
  assert.ok(receiptReservation > preflight);
  assert.ok(firstPatch > receiptReservation);
  for (const validator of [configValidator, gate]) {
    assert.match(validator, /\.schemaVersion == 2/);
    assert.match(validator, /\.status == "verified"/);
    assert.match(validator, /\.targetCredentialProbesPassed == true/);
    assert.match(validator, /\.requiresReconciliation == false/);
  }
});

test("config validation permits only the deliberate S3 protocol shutdown", () => {
  const configValidator = readFileSync(resolve("deploy/supabase/validate-project-config-snapshot.zsh"), "utf8");
  const gate = readFileSync(resolve("deploy/supabase/validate-cutover-gate.zsh"), "utf8");

  assert.match(configValidator, /del\(\.features\.s3Protocol\.enabled\)/);
  assert.match(configValidator, /\.features\.s3Protocol\.enabled == true/);
  assert.match(configValidator, /\.features\.s3Protocol\.enabled == false/);
  assert.match(configValidator, /equal_non_secret_settings_with_s3_protocol_disabled/);
  assert.match(gate, /\.source_s3_protocol_disabled == true/);
  assert.match(gate, /\.target_s3_protocol_disabled == true/);
});

test("cutover receipt is private, append-only, and refuses reuse", () => {
  const directory = mkdtempSync(join(tmpdir(), "motorist-receipt-"));
  const receipt = join(directory, "cutover-test.jsonl");
  const secretMarker = "must-not-appear-in-receipt";

  assert.equal(runPython(receiptHelper, receiptArgs(receipt, "create", "in_progress", "cutover_started")).status, 0);
  assert.equal(statSync(receipt).mode & 0o777, 0o600);
  const initial = readFileSync(receipt, "utf8");
  assert.equal(initial.includes(secretMarker), false);
  assert.notEqual(runPython(receiptHelper, receiptArgs(receipt, "create", "in_progress", "cutover_started")).status, 0);
  assert.equal(readFileSync(receipt, "utf8"), initial);

  assert.equal(
    runPython(
      receiptHelper,
      receiptArgs(receipt, "append", "success", "cutover_complete", {
        booleans: ["true", "true", "false"],
      }),
    ).status,
    0,
  );
  const records = readFileSync(receipt, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].status, "in_progress");
  assert.equal(records[1].status, "success");
  assert.equal(records[1].evidence_scope, "predeployment_gate_plus_local_https");
  assert.equal(records[0].live_storage_transition_manifest_sha256, "9".repeat(64));
  assert.equal(
    records[1].live_storage_transition_manifest_sha256,
    records[0].live_storage_transition_manifest_sha256,
  );
  assert.equal(records[0].previous_record_sha256, null);
  assert.equal(
    records[1].previous_record_sha256,
    createHash("sha256").update(initial).digest("hex"),
  );
  assert.notEqual(
    runPython(
      receiptHelper,
      receiptArgs(receipt, "append", "failure", "receipt_finalize"),
    ).status,
    0,
  );
});

test("cutover receipt rejects an invalid live Storage transition manifest hash", () => {
  const directory = mkdtempSync(join(tmpdir(), "motorist-receipt-transition-"));
  const receipt = join(directory, "cutover-test.jsonl");
  const args = receiptArgs(receipt, "create", "in_progress", "cutover_started", {
    storageTransitionHash: "not-a-sha256",
  });

  assert.notEqual(runPython(receiptHelper, args).status, 0);
});

test("cutover receipt append refuses unsafe mode and hard links", () => {
  const directory = mkdtempSync(join(tmpdir(), "motorist-receipt-guards-"));
  const receipt = join(directory, "cutover-test.jsonl");
  assert.equal(runPython(receiptHelper, receiptArgs(receipt, "create", "in_progress", "cutover_started")).status, 0);

  chmodSync(receipt, 0o640);
  const beforeModeFailure = readFileSync(receipt, "utf8");
  assert.notEqual(runPython(receiptHelper, receiptArgs(receipt, "append", "failure", "compose_start")).status, 0);
  assert.equal(readFileSync(receipt, "utf8"), beforeModeFailure);

  chmodSync(receipt, 0o600);
  linkSync(receipt, join(directory, "receipt-hardlink.jsonl"));
  const beforeLinkFailure = readFileSync(receipt, "utf8");
  assert.notEqual(runPython(receiptHelper, receiptArgs(receipt, "append", "failure", "compose_start")).status, 0);
  assert.equal(readFileSync(receipt, "utf8"), beforeLinkFailure);
});

test("cutover receipt append detects a modified initial record", () => {
  const directory = mkdtempSync(join(tmpdir(), "motorist-receipt-chain-"));
  const receipt = join(directory, "cutover-test.jsonl");
  assert.equal(runPython(receiptHelper, receiptArgs(receipt, "create", "in_progress", "cutover_started")).status, 0);

  const initial = JSON.parse(readFileSync(receipt, "utf8"));
  initial.gate_report_sha256 = "9".repeat(64);
  writeFileSync(receipt, `${JSON.stringify(initial)}\n`, { mode: 0o600 });
  const tampered = readFileSync(receipt, "utf8");
  assert.notEqual(
    runPython(receiptHelper, receiptArgs(receipt, "append", "success", "cutover_complete", {
      booleans: ["true", "true", "false"],
    })).status,
    0,
  );
  assert.equal(readFileSync(receipt, "utf8"), tampered);
});
