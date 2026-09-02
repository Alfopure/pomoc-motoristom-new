import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const validator = resolve("deploy/bin/validate-activation-inputs.py");
const fixtureParent = resolve(".context/activation-security-tests");
const sourceRef = "jcwbiulwuwyrnmzjjbgr";
const targetRef = "sjcsrygkkmersoczpunh";
const version = "hetzner-20260716T220000Z";
const image = `motorist-app:${version}`;
const imageId = `sha256:${"a".repeat(64)}`;
const job = "fleet.commander.catalog";
const releaseFiles = [
  "image.tar.gz",
  "manifest.json",
  "compose.yml",
  "Caddyfile",
  "upstream.caddy",
  "runtime-env-parser.mjs",
  "bin/install-release.sh",
  "bin/validate-gate-timestamp.py",
  "bin/write-cutover-receipt.py",
  "bin/capture-private-evidence.py",
  "bin/open-operation-lock.py",
  "bin/run-one-shot-job.sh",
  "bin/write-one-shot-receipt.py",
  "bin/activate-after-cutover.sh",
  "bin/activate-telephony-background.sh",
  "bin/activate-viptel-listener-only.sh",
  "bin/handover-viptel-listener-only.sh",
  "bin/upgrade-viptel-listener-only.sh",
  "bin/stage-viptel-listener-handover.sh",
  "bin/prepare-runtime-env.mjs",
  "bin/runtime-env-contract.mjs",
  "bin/validate-activation-inputs.py",
  "bin/create-activation-gate.py",
  "bin/probe-viptel-listener.sh",
  "bin/write-viptel-listener-receipt.py",
];

mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
chmodSync(fixtureParent, 0o700);

function iso(secondsOffset = 0) {
  return new Date(Date.now() + secondsOffset * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function utc(milliseconds) {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function writePrivate(path, contents) {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeJson(path, value, privateFile = true) {
  const contents = `${JSON.stringify(value)}\n`;
  if (privateFile) writePrivate(path, contents);
  else writeFileSync(path, contents, { mode: 0o644 });
}

function runtimeEnv(kind) {
  const values = {
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
  if (kind === "worker") {
    values.SCHEDULER_ENABLED = "false";
    values.WORKER_INSTANCE_ID = "motorist-prod-01";
    values.HEALTHCHECKS_PING_URL = "https://hc-ping.com/11111111-1111-4111-8111-111111111111";
    values.HEALTHCHECKS_JOB_URLS_JSON = JSON.stringify({
      [job]: "https://hc-ping.com/22222222-2222-4222-8222-222222222222",
    });
  } else {
    values.VIPTEL_LISTENER_ENABLED = "false";
    values.VIPTEL_LIVE_MUTATIONS_ENABLED = "false";
    values.VIPTEL_LIVE_MUTATION_TOKEN = "listener-test-authority-token-at-least-32-characters";
    values.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED = "true";
    values.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN = "provider-snapshot-bridge-authority-0001";
    values.VIPTEL_DISPATCH_PERSONAL_EXTENSIONS = "20,21,22,23";
    values.VIPTEL_LISTENER_INSTANCE_ID = "motorist-prod-01-viptel";
    values.VIPTEL_HEALTHCHECKS_PING_URL = "https://hc-ping.com/33333333-3333-4333-8333-333333333333";
  }
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

function runtimeEnvSha256(kind) {
  return createHash("sha256").update(runtimeEnv(kind)).digest("hex");
}

function makeFixture({ withListenerReceipt = false } = {}) {
  const root = mkdtempSync(join(fixtureParent, "case-"));
  chmodSync(root, 0o700);
  const production = join(root, "production");
  const envDir = join(production, "env");
  const binDir = join(production, "bin");
  const receipts = join(root, "one-shot");
  mkdirSync(envDir, { recursive: true, mode: 0o700 });
  mkdirSync(binDir, { mode: 0o755 });
  mkdirSync(receipts, { mode: 0o700 });
  chmodSync(receipts, 0o700);

  writeJson(
    join(production, "manifest.json"),
    {
      version,
      image,
      imageId,
      buildContextSha256: "b".repeat(64),
      buildArgsSha256: "c".repeat(64),
      gitSha: "d".repeat(40),
      platform: "linux/amd64",
      schedulerEnabled: false,
    },
    false,
  );
  writePrivate(join(envDir, "worker.env"), runtimeEnv("worker"));
  writePrivate(join(envDir, "viptel-listener.env"), runtimeEnv("listener"));

  writeFileSync(join(production, "image.tar.gz"), "fixture-image\n");
  writeFileSync(join(production, "compose.yml"), "name: fixture\nservices: {}\n");
  writeFileSync(join(production, "Caddyfile"), "# fixture\n");
  writeFileSync(join(production, "upstream.caddy"), "# fixture\n");
  copyFileSync(resolve("deploy/runtime-env-parser.mjs"), join(production, "runtime-env-parser.mjs"));
  for (const name of releaseFiles.filter((entry) => entry.startsWith("bin/"))) {
    const destination = join(production, name);
    if (name === "bin/validate-activation-inputs.py") {
      copyFileSync(validator, destination);
    } else if (name === "bin/activate-after-cutover.sh") {
      copyFileSync(resolve("deploy/bin/activate-after-cutover.sh"), destination);
    } else if (name === "bin/activate-telephony-background.sh") {
      copyFileSync(resolve("deploy/bin/activate-telephony-background.sh"), destination);
    } else if (name === "bin/activate-viptel-listener-only.sh") {
      copyFileSync(resolve("deploy/bin/activate-viptel-listener-only.sh"), destination);
    } else if (name === "bin/open-operation-lock.py") {
      copyFileSync(resolve("deploy/bin/open-operation-lock.py"), destination);
    } else {
      writeFileSync(destination, "#!/usr/bin/env sh\nexit 0\n");
    }
    chmodSync(destination, 0o755);
  }
  const checksumLines = releaseFiles.map((name) => {
    const digest = createHash("sha256").update(readFileSync(join(production, name))).digest("hex");
    return `${digest}  ${name}`;
  });
  const sumsPath = join(production, "SHA256SUMS");
  writeFileSync(sumsPath, `${checksumLines.join("\n")}\n`, { mode: 0o644 });
  const sumsSha256 = createHash("sha256").update(readFileSync(sumsPath)).digest("hex");

  const identity = {
    receipt_schema_version: 2,
    release_version: version,
    image,
    image_id: imageId,
    build_context_sha256: "b".repeat(64),
    build_args_sha256: "c".repeat(64),
    sha256sums_sha256: sumsSha256,
    gate_snapshot_id: "20260716T220000Z",
    gate_run_id: "20260716T220000Z-1-2",
    gate_report_sha256: "e".repeat(64),
    continuity_policy_sha256: "1".repeat(64),
    continuity_anchor_sha256: "2".repeat(64),
    live_watermark_anchor_sha256: "3".repeat(64),
    live_storage_anchor_sha256: "4".repeat(64),
    live_storage_transition_manifest_sha256: "5".repeat(64),
    component_report_sha256: {
      application: "6".repeat(64),
      auth: "7".repeat(64),
      config: "8".repeat(64),
      database: "9".repeat(64),
      storage: "0".repeat(64),
    },
    gate_validated_at_utc: iso(-40),
    dns_points_to_target: true,
    predeployment_source_write_freeze_active: true,
    predeployment_target_jobs_active: false,
    scheduler_enabled: false,
  };
  const first = {
    ...identity,
    previous_record_sha256: null,
    recorded_at_utc: iso(-30),
    status: "in_progress",
    stage: "cutover_started",
    compose_healthy: false,
    https_healthy: false,
    stack_removed: false,
  };
  const firstLine = `${JSON.stringify(first)}\n`;
  const terminal = {
    ...identity,
    previous_record_sha256: createHash("sha256").update(firstLine).digest("hex"),
    recorded_at_utc: iso(-20),
    status: "success",
    stage: "cutover_complete",
    compose_healthy: true,
    https_healthy: true,
    stack_removed: false,
  };
  const cutover = join(root, "cutover.jsonl");
  writePrivate(cutover, `${firstLine}${JSON.stringify(terminal)}\n`);
  const cutoverSha256 = createHash("sha256").update(readFileSync(cutover)).digest("hex");
  const gateCompletedAt = Date.now() - 10_000;
  const gate = join(root, "gate.json");
  writeJson(gate, {
    schema: "motorist-activation-gate/v1",
    gateStatus: "pass_activation",
    sourceProjectRef: sourceRef,
    targetProjectRef: targetRef,
    source: { persistentDatabaseFreeze: true, activeCronJobs: 0 },
    target: {
      persistentDatabaseFreeze: false,
      activeCronJobs: 0,
      jobControlsTotal: 11,
      jobControlsEnabled: 0,
      jobControlSetExact: true,
    },
    publicHttps: { live: true, ready: true, exactRelease: true },
    dns: {
      authoritativeExactTarget: true,
      recursiveExactTarget: true,
      authoritativeNameserverCount: 3,
    },
    cutoverReceiptSha256: cutoverSha256,
    releaseVersion: version,
    gitSha: "d".repeat(40),
    image,
    imageId,
    platform: "linux/amd64",
    buildContextSha256: "b".repeat(64),
    buildArgsSha256: "c".repeat(64),
    releaseManifestSha256: createHash("sha256")
      .update(readFileSync(join(production, "manifest.json")))
      .digest("hex"),
    sha256sumsSha256: sumsSha256,
    validationStartedAtUtc: utc(gateCompletedAt - 10_000),
    validationCompletedAtUtc: utc(gateCompletedAt),
    validationDurationSeconds: 10,
    maximumAgeSeconds: 300,
    validUntilUtc: utc(gateCompletedAt + 300_000),
    validatedAtUtc: utc(gateCompletedAt),
  });

  const oneShotReceipt = (recordedAtUtc) => ({
    schema: "motorist-one-shot/v1",
    recordedAtUtc,
    releaseVersion: version,
    imageId,
    runtimeEnvSha256: runtimeEnvSha256("worker"),
    targetProjectRef: targetRef,
    job,
    ok: true,
    status: "success",
    summary: { fetchedCount: 2, createdCount: 0, updatedCount: 2, errorCount: 0, status: "success" },
  });
  writeJson(join(receipts, "commander-first.json"), oneShotReceipt(iso(-6)));
  const oneShot = join(receipts, "commander-second.json");
  writeJson(oneShot, oneShotReceipt(iso(-5)));

  if (withListenerReceipt) {
    writeJson(join(receipts, "viptel-listener.json"), {
      schema: "motorist-viptel-listener/v2",
      recordedAtUtc: iso(-5),
      probeStartedAtUtc: iso(-20),
      callWindowStartedAtUtc: iso(-10),
      callWindowEndedAtUtc: iso(-6),
      releaseVersion: version,
      imageId,
      runtimeEnvSha256: runtimeEnvSha256("listener"),
      targetProjectRef: targetRef,
      ok: true,
      status: "success",
      incomingCallTested: true,
      outgoingCallTested: true,
      listenerConnected: true,
      listenerReconnected: true,
      summary: {
        websocketConnectionsObserved: 2,
        inboundCallsObserved: 1,
        outboundCallsObserved: 1,
      },
    });
  }

  return {
    root,
    production,
    receipts,
    cutover,
    gate,
    oneShot,
    validator: join(binDir, "validate-activation-inputs.py"),
    binDir,
  };
}

function run(fixture, extra = []) {
  return spawnSync(
    "python3",
    [
      fixture.validator,
      "preflight",
      fixture.production,
      fixture.cutover,
      fixture.gate,
      fixture.receipts,
      "--activation-script-dir",
      fixture.binDir,
      "--jobs",
      job,
      ...extra,
    ],
    { encoding: "utf8" },
  );
}

function revalidateGate(fixture, evidence, expectedGateSha256 = evidence.activationGateSha256) {
  return spawnSync(
    "python3",
    [
      fixture.validator,
      "revalidate-gate",
      fixture.production,
      version,
      fixture.cutover,
      fixture.gate,
      "--activation-script-dir",
      fixture.binDir,
      "--expected-cutover-sha256",
      evidence.cutoverReceiptSha256,
      "--expected-gate-sha256",
      expectedGateSha256,
    ],
    { encoding: "utf8" },
  );
}

function mutateJson(path, callback) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  callback(value);
  writeJson(path, value);
}

function mutateCutover(path, callback) {
  const records = readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  callback(records[0], records[1]);
  const firstLine = `${JSON.stringify(records[0])}\n`;
  records[1].previous_record_sha256 = createHash("sha256").update(firstLine).digest("hex");
  writePrivate(path, `${firstLine}${JSON.stringify(records[1])}\n`);
}

test("activation preflight accepts bound private evidence", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = run(fixture);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.jobs, [job]);
  assert.equal(output.releaseVersion, version);
  assert.match(output.cutoverReceiptSha256, /^[0-9a-f]{64}$/);
  assert.match(output.activationGateSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(output.oneShotReceiptBindings.map((binding) => binding.job), [job]);
});

test("activation gate revalidation is checksum-bound and freshness-bound", (t) => {
  const changed = makeFixture();
  t.after(() => rmSync(changed.root, { recursive: true, force: true }));
  const checked = run(changed);
  assert.equal(checked.status, 0, checked.stderr);
  const evidence = JSON.parse(checked.stdout);
  assert.equal(revalidateGate(changed, evidence).status, 0);

  mutateJson(changed.gate, (gate) => {
    gate.dns.recursiveExactTarget = false;
  });
  const replaced = revalidateGate(changed, evidence);
  assert.notEqual(replaced.status, 0);
  assert.match(replaced.stderr, /activation gate changed after preflight/);

  const expired = makeFixture();
  t.after(() => rmSync(expired.root, { recursive: true, force: true }));
  const beforeExpiry = run(expired);
  assert.equal(beforeExpiry.status, 0, beforeExpiry.stderr);
  const expiryEvidence = JSON.parse(beforeExpiry.stdout);
  const completedAt = Date.now() - 301_000;
  mutateJson(expired.gate, (gate) => {
    gate.validationStartedAtUtc = utc(completedAt - 1_000);
    gate.validationCompletedAtUtc = utc(completedAt);
    gate.validationDurationSeconds = 1;
    gate.validUntilUtc = utc(completedAt + 300_000);
    gate.validatedAtUtc = utc(completedAt);
  });
  const expiredSha256 = createHash("sha256").update(readFileSync(expired.gate)).digest("hex");
  const stale = revalidateGate(expired, expiryEvidence, expiredSha256);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /activation gate is older than five minutes/);
});

test("activation revalidates the same gate immediately before both enabling writes", () => {
  const activation = readFileSync(resolve("deploy/bin/activate-after-cutover.sh"), "utf8");
  assert.match(
    activation,
    /revalidate_activation_gate\nmapfile -t active_runtime_hashes < <\(\n  python3 "\$validator" set-flags/,
  );
  assert.match(
    activation,
    /if \[\[ -n "\$jobs" \]\]; then\n  revalidate_activation_gate\n  python3 "\$validator" set-controls/,
  );
  assert.equal((activation.match(/^\s*revalidate_activation_gate$/gm) ?? []).length, 2);
  assert.match(
    activation,
    /revalidate-gate[\s\S]*--expected-cutover-sha256 "\$cutover_sha256"[\s\S]*--expected-gate-sha256 "\$gate_sha256"/,
  );
  assert.ok(activation.indexOf("rollback_armed=true") < activation.indexOf("revalidate_activation_gate\nmapfile"));
});

test("activation receipt is chained and bound to the exact validation evidence", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const checked = run(fixture);
  assert.equal(checked.status, 0, checked.stderr);
  const evidence = JSON.parse(checked.stdout);
  const receipt = join(fixture.root, "activation.jsonl");
  const shared = [
    "--release-version",
    version,
    "--image",
    image,
    "--image-id",
    imageId,
    "--jobs",
    job,
    "--listener",
    "false",
    "--cutover-sha256",
    evidence.cutoverReceiptSha256,
    "--gate-sha256",
    evidence.activationGateSha256,
    "--one-shot-bindings-json",
    JSON.stringify(evidence.oneShotReceiptBindings),
  ];
  const created = spawnSync(
    "python3",
    [
      validator,
      "receipt",
      receipt,
      "--mode",
      "create",
      "--status",
      "in_progress",
      "--stage",
      "activation_started",
      ...shared,
    ],
    { encoding: "utf8" },
  );
  assert.equal(created.status, 0, created.stderr);
  const appended = spawnSync(
    "python3",
    [
      validator,
      "receipt",
      receipt,
      "--mode",
      "append",
      "--status",
      "success",
      "--stage",
      "activation_complete",
      ...shared,
    ],
    { encoding: "utf8" },
  );
  assert.equal(appended.status, 0, appended.stderr);
  const lines = readFileSync(receipt, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  const initial = JSON.parse(lines[0]);
  const terminal = JSON.parse(lines[1]);
  assert.equal(initial.cutover_receipt_sha256, evidence.cutoverReceiptSha256);
  assert.equal(initial.activation_gate_sha256, evidence.activationGateSha256);
  assert.deepEqual(initial.one_shot_receipts, evidence.oneShotReceiptBindings);
  assert.equal(terminal.previous_record_sha256, createHash("sha256").update(`${lines[0]}\n`).digest("hex"));
});

test("activation validates public HTTPS before creating a receipt or mutating runtime", () => {
  const activation = readFileSync(resolve("deploy/bin/activate-after-cutover.sh"), "utf8");
  assert.match(activation, /approved_jobs="notifications\.materialize,[^"]+telephony\.transcripts\.process"/);
  assert.match(activation, /jobs.*approved_jobs.*enable_listener.*true/);
  const publicCheck = activation.indexOf("--jobs \"\" --phase disabled");
  const receiptCreate = activation.indexOf("--mode create --status in_progress");
  const flagMutation = activation.indexOf("--scheduler true --listener");
  assert.ok(publicCheck > 0);
  assert.ok(publicCheck < receiptCreate);
  assert.ok(publicCheck < flagMutation);
  const implementation = readFileSync(validator, "utf8");
  assert.match(implementation, /if args\.phase == "disabled":\n\s+validate_public_https/);
});

test("activation verifies each running container image before enabling controls", () => {
  const activation = readFileSync(resolve("deploy/bin/activate-after-cutover.sh"), "utf8");
  const composeStart = activation.indexOf("timeout 180 docker compose");
  const runtimeImageCheck = activation.indexOf(
    'for service in "${services[@]}"; do',
    composeStart,
  );
  const controlsEnable = activation.indexOf("--jobs \"$jobs\" --mode enable");
  assert.ok(composeStart > 0);
  assert.ok(runtimeImageCheck > composeStart);
  assert.ok(controlsEnable > runtimeImageCheck);
  assert.match(activation, /docker inspect --format '\{\{\.Image\}\}'/);
  assert.match(activation, /\[\[ "\$actual_id" == "\$image_id" && "\$running" == true \]\]/);
  assert.equal((activation.match(/export WORKER_IMAGE="\$image_id"/g) ?? []).length, 3);
  assert.equal((activation.match(/export VIPTEL_LISTENER_IMAGE="\$image_id"/g) ?? []).length, 3);
  assert.doesNotMatch(activation, /export WORKER_IMAGE="\$image"\n/);
});

test("activation preflight rejects release checksum tampering", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeFileSync(join(fixture.production, "compose.yml"), "name: tampered\nservices: {}\n");
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release checksum verification failed/);
});

test("listener-only release verification rejects a truncated checksum inventory", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const sums = join(fixture.production, "SHA256SUMS");
  const expectedReleaseSha256 = createHash("sha256")
    .update(readFileSync(sums))
    .digest("hex");
  const verify = () => spawnSync("python3", [
    fixture.validator,
    "verify-listener-release",
    fixture.production,
    version,
    "--expected-git-sha",
    "d".repeat(40),
    "--expected-release-sha256",
    expectedReleaseSha256,
  ], { encoding: "utf8" });
  const accepted = verify();
  assert.equal(accepted.status, 0, accepted.stderr);

  const originalLines = readFileSync(sums, "utf8").trimEnd().split("\n");
  writeFileSync(sums, `${[...originalLines].reverse().join("\n")}\n`);
  const rebound = verify();
  assert.notEqual(rebound.status, 0);
  assert.match(rebound.stderr, /listener release checksum binding changed/);

  const truncated = originalLines.slice(0, -1);
  writeFileSync(sums, `${truncated.join("\n")}\n`);
  const rejected = verify();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /checksum manifest does not cover the exact release/);
});

test("activation preflight binds the exact SHA256SUMS file to cutover", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const sums = join(fixture.production, "SHA256SUMS");
  const reordered = readFileSync(sums, "utf8").trimEnd().split("\n").reverse();
  writeFileSync(sums, `${reordered.join("\n")}\n`);
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /production release is not the release bound into the successful cutover receipt/,
  );
});

test("activation preflight binds receipt build hashes to the manifest", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  mutateCutover(fixture.cutover, (first, terminal) => {
    first.build_context_sha256 = "f".repeat(64);
    terminal.build_context_sha256 = "f".repeat(64);
  });
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cutover build context binding mismatch/);
});

test("activation preflight rejects Storage-transition identity drift", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  mutateCutover(fixture.cutover, (_first, terminal) => {
    terminal.live_storage_transition_manifest_sha256 = "f".repeat(64);
  });
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cutover receipt identity changed/);
});

test("activation preflight only runs its validator from production bin", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = spawnSync(
    "python3",
    [
      validator,
      "preflight",
      fixture.production,
      fixture.cutover,
      fixture.gate,
      fixture.receipts,
      "--activation-script-dir",
      fixture.binDir,
      "--jobs",
      job,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /validator is outside the release bin directory/);
});

test("activation preflight rejects a stale gate", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  mutateJson(fixture.gate, (gate) => {
    const completedAt = Date.now() - 301_000;
    gate.validationStartedAtUtc = utc(completedAt - 10_000);
    gate.validationCompletedAtUtc = utc(completedAt);
    gate.validatedAtUtc = utc(completedAt);
    gate.validUntilUtc = utc(completedAt + 300_000);
  });
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /older than five minutes/);
});

test("activation preflight rejects an unrelated fresh gate", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  mutateJson(fixture.gate, (gate) => {
    gate.unrelated_but_well_formed_evidence = true;
  });
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fields are not exact/);
});

test("activation gate must bind the exact successful cutover receipt", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  mutateJson(fixture.gate, (gate) => {
    gate.cutoverReceiptSha256 = "f".repeat(64);
  });
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cutover binding mismatch/);
});

test("activation preflight rejects a broken cutover hash chain", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const lines = readFileSync(fixture.cutover, "utf8").trimEnd().split("\n");
  const terminal = JSON.parse(lines[1]);
  terminal.previous_record_sha256 = "0".repeat(64);
  writePrivate(fixture.cutover, `${lines[0]}\n${JSON.stringify(terminal)}\n`);
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /chain hash mismatch/);
});

test("activation preflight rejects source-bound runtime", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const worker = join(fixture.production, "env", "worker.env");
  writePrivate(worker, `${runtimeEnv("worker")}UNSAFE_NOTE=${JSON.stringify(sourceRef)}\n`);
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source project ref/);
});

test("activation preflight rejects duplicate, SWHouse, and unknown jobs", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  for (const denied of [
    `${job},${job}`,
    "fleet.swhouse.occupancy",
    "unknown.job",
  ]) {
    const result = spawnSync(
      "python3",
      [
        fixture.validator,
        "preflight",
        fixture.production,
        fixture.cutover,
        fixture.gate,
        fixture.receipts,
        "--activation-script-dir",
        fixture.binDir,
        "--jobs",
        denied,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, denied);
  }
});

test("activation preflight rejects hardlinked evidence", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  linkSync(fixture.oneShot, join(fixture.receipts, "duplicate.json"));
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one link/);
});

test("activation preflight rejects symlinked runtime evidence", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const worker = join(fixture.production, "env", "worker.env");
  const saved = join(fixture.root, "saved-worker.env");
  writePrivate(saved, readFileSync(worker));
  unlinkSync(worker);
  symlinkSync(saved, worker);
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a regular file|symlink/);
});

test("activation preflight requires a recent exact-version one-shot success", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  mutateJson(fixture.oneShot, (receipt) => {
    receipt.releaseVersion = "hetzner-wrong";
  });
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /one-shot release mismatch/);
});

test("activation requires two consecutive exact-runtime one-shot successes", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  unlinkSync(join(fixture.receipts, "commander-first.json"));
  const missingPair = run(fixture);
  assert.notEqual(missingPair.status, 0);
  assert.match(missingPair.stderr, /two exact-release one-shot receipts are required/);

  const restoredFirst = JSON.parse(readFileSync(fixture.oneShot, "utf8"));
  restoredFirst.recordedAtUtc = iso(-6);
  writeJson(join(fixture.receipts, "commander-first.json"), restoredFirst);
  const worker = join(fixture.production, "env", "worker.env");
  writePrivate(worker, `${runtimeEnv("worker")}ROTATED_CREDENTIAL=${JSON.stringify("different")}\n`);
  const changedRuntime = run(fixture);
  assert.notEqual(changedRuntime.status, 0);
  assert.match(changedRuntime.stderr, /one-shot runtime binding mismatch/);
});

test("activation enforces exact aggregate schema and second-run idempotence", (t) => {
  const extraField = makeFixture();
  t.after(() => rmSync(extraField.root, { recursive: true, force: true }));
  mutateJson(extraField.oneShot, (receipt) => {
    receipt.summary.unapproved = 1;
  });
  const malformed = run(extraField);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /summary contract is invalid/);

  const recreated = makeFixture();
  t.after(() => rmSync(recreated.root, { recursive: true, force: true }));
  mutateJson(recreated.oneShot, (receipt) => {
    receipt.summary.createdCount = 1;
  });
  const duplicateCreate = run(recreated);
  assert.notEqual(duplicateCreate.status, 0);
  assert.match(duplicateCreate.stderr, /idempotency summary is unsafe/);
});

test("runtime flag mutation uses fingerprint compare-and-swap", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const workerPath = join(fixture.production, "env", "worker.env");
  const listenerPath = join(fixture.production, "env", "viptel-listener.env");
  const originalWorker = readFileSync(workerPath);
  const command = (workerSha, listenerSha) => spawnSync(
    "python3",
    [
      fixture.validator,
      "set-flags",
      fixture.production,
      version,
      "--scheduler",
      "true",
      "--listener",
      "false",
      "--expected-worker-sha256",
      workerSha,
      "--expected-listener-sha256",
      listenerSha,
      "--output",
      "lines",
    ],
    { encoding: "utf8" },
  );

  const rejected = command("0".repeat(64), "0".repeat(64));
  assert.notEqual(rejected.status, 0);
  assert.deepEqual(readFileSync(workerPath), originalWorker);

  const accepted = command(
    createHash("sha256").update(readFileSync(workerPath)).digest("hex"),
    createHash("sha256").update(readFileSync(listenerPath)).digest("hex"),
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  const hashes = accepted.stdout.trim().split("\n");
  assert.equal(hashes.length, 2);
  assert.match(readFileSync(workerPath, "utf8"), /SCHEDULER_ENABLED="true"/);
  const verified = spawnSync(
    "python3",
    [
      fixture.validator,
      "verify-runtime",
      fixture.production,
      version,
      "--expected-worker-sha256",
      hashes[0],
      "--expected-listener-sha256",
      hashes[1],
    ],
    { encoding: "utf8" },
  );
  assert.equal(verified.status, 0, verified.stderr);
});

test("activation requires external Healthchecks endpoints", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const worker = join(fixture.production, "env", "worker.env");
  writePrivate(worker, runtimeEnv("worker").replace(
    /HEALTHCHECKS_PING_URL=.*\n/,
    `HEALTHCHECKS_PING_URL=${JSON.stringify("")}\n`,
  ));
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /worker Healthchecks URL is missing/);
});

test("a newer failed or skipped exact-release receipt blocks activation", async (t) => {
  for (const status of ["failed", "skipped"]) {
    await t.test(status, () => {
      const fixture = makeFixture();
      try {
        writeJson(join(fixture.receipts, `newer-${status}.json`), {
          schema: "motorist-one-shot/v1",
          recordedAtUtc: iso(-1),
          releaseVersion: version,
          imageId,
          runtimeEnvSha256: runtimeEnvSha256("worker"),
          targetProjectRef: targetRef,
          job,
          ok: false,
          status,
          summary: {},
        });
        const result = run(fixture);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /latest one-shot receipt pair did not succeed/);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("VIPTel activation requires inbound, outbound, connected, and reconnected evidence", (t) => {
  const missing = makeFixture();
  t.after(() => rmSync(missing.root, { recursive: true, force: true }));
  const denied = run(missing, ["--enable-viptel-listener"]);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /VIPTel listener receipt is missing/);

  const complete = makeFixture({ withListenerReceipt: true });
  t.after(() => rmSync(complete.root, { recursive: true, force: true }));
  const accepted = run(complete, ["--enable-viptel-listener"]);
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("VIPTel activation rejects inconsistent aggregate proof", (t) => {
  const fixture = makeFixture({ withListenerReceipt: true });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  mutateJson(join(fixture.receipts, "viptel-listener.json"), (receipt) => {
    receipt.summary.inboundCallsObserved = 0;
  });
  const result = run(fixture, ["--enable-viptel-listener"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /call aggregates are inconsistent/);
});

test("a newer failed VIPTel listener receipt blocks activation", (t) => {
  const fixture = makeFixture({ withListenerReceipt: true });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeJson(join(fixture.receipts, "viptel-listener-newer-failure.json"), {
    schema: "motorist-viptel-listener/v2",
    recordedAtUtc: iso(-1),
    probeStartedAtUtc: iso(-10),
    callWindowStartedAtUtc: null,
    callWindowEndedAtUtc: null,
    releaseVersion: version,
    imageId,
    runtimeEnvSha256: runtimeEnvSha256("listener"),
    targetProjectRef: targetRef,
    ok: false,
    status: "failed",
    incomingCallTested: false,
    outgoingCallTested: false,
    listenerConnected: false,
    listenerReconnected: false,
    summary: {
      websocketConnectionsObserved: 0,
      inboundCallsObserved: 0,
      outboundCallsObserved: 0,
    },
  });
  const result = run(fixture, ["--enable-viptel-listener"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /latest VIPTel listener receipt did not succeed/);
});

test("activation preflight rejects an inactive source freeze", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  mutateJson(fixture.gate, (gate) => {
    gate.source.persistentDatabaseFreeze = false;
  });
  const result = run(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source state is unsafe/);
});

test("rollback receipt records incomplete cleanup truthfully", (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const checked = run(fixture);
  assert.equal(checked.status, 0, checked.stderr);
  const evidence = JSON.parse(checked.stdout);
  const receipt = join(fixture.root, "rollback.jsonl");
  const shared = [
    "--release-version",
    version,
    "--image",
    image,
    "--image-id",
    imageId,
    "--jobs",
    job,
    "--listener",
    "false",
    "--cutover-sha256",
    evidence.cutoverReceiptSha256,
    "--gate-sha256",
    evidence.activationGateSha256,
    "--one-shot-bindings-json",
    JSON.stringify(evidence.oneShotReceiptBindings),
  ];
  const create = spawnSync(
    "python3",
    [
      validator,
      "receipt",
      receipt,
      "--mode",
      "create",
      "--status",
      "in_progress",
      "--stage",
      "activation_started",
      ...shared,
    ],
    { encoding: "utf8" },
  );
  assert.equal(create.status, 0, create.stderr);
  const append = spawnSync(
    "python3",
    [
      validator,
      "receipt",
      receipt,
      "--mode",
      "append",
      "--status",
      "failure",
      "--stage",
      "rollback_incomplete",
      ...shared,
    ],
    { encoding: "utf8" },
  );
  assert.equal(append.status, 0, append.stderr);
  const terminal = JSON.parse(readFileSync(receipt, "utf8").trimEnd().split("\n")[1]);
  assert.equal(terminal.status, "failure");
  assert.equal(terminal.stage, "rollback_incomplete");

  const activation = readFileSync(resolve("deploy/bin/activate-after-cutover.sh"), "utf8");
  assert.match(activation, /local rollback_stage=rollback_incomplete/);
  assert.match(activation, /rollback_stage=rollback_complete/);
  assert.match(activation, /--stage "\$rollback_stage"/);
  assert.match(activation, /Activation rollback is incomplete; manual intervention is required/);
});
