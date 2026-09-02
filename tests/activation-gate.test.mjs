import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceHelper = resolve("deploy/bin/create-activation-gate.py");
const helperSource = readFileSync(sourceHelper, "utf8");
const sourceRef = "jcwbiulwuwyrnmzjjbgr";
const targetRef = "sjcsrygkkmersoczpunh";
const sourceToken = "sbp_source-test-secret-marker-000000000000";
const targetToken = "sbp_target-test-secret-marker-000000000000";

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function utcSeconds(milliseconds) {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "motorist-activation-gate-")));
  const release = join(root, "release");
  const bin = join(release, "bin");
  const privateDir = join(root, "private");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(privateDir, { mode: 0o700 });
  const helper = join(bin, "create-activation-gate.py");
  copyFileSync(sourceHelper, helper);
  chmodSync(helper, 0o755);

  const version = "hetzner-activation-gate-test";
  const manifest = {
    version,
    gitSha: "a".repeat(40),
    image: `motorist-app:${version}`,
    imageId: `sha256:${"b".repeat(64)}`,
    buildContextSha256: "c".repeat(64),
    buildArgsSha256: "d".repeat(64),
    platform: "linux/amd64",
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    schedulerEnabled: false,
  };
  const files = {
    "image.tar.gz": "test image archive\n",
    "manifest.json": `${JSON.stringify(manifest)}\n`,
    "compose.yml": "services: {}\n",
    Caddyfile: "test.invalid\n",
    "upstream.caddy": "\n",
    "bin/create-activation-gate.py": readFileSync(helper),
  };
  for (const [name, contents] of Object.entries(files)) {
    if (name.startsWith("bin/")) continue;
    writeFileSync(join(release, name), contents);
  }
  const sums = Object.entries(files)
    .map(([name, contents]) => `${sha256(contents)}  ${name}`)
    .join("\n") + "\n";
  writeFileSync(join(release, "SHA256SUMS"), sums);
  const sumsSha256 = sha256(sums);

  const now = Date.now();
  const gateStartedAtUtc = utcSeconds(now - 240_000);
  const gateValidatedAtUtc = utcSeconds(now - 180_000);
  const gateOperationalAtUtc = utcSeconds(now - 151_000);
  const gateCompletedAtUtc = utcSeconds(now - 150_000);
  const cutoverStartedAtUtc = utcSeconds(now - 120_000);
  const cutoverCompletedAtUtc = utcSeconds(now - 60_000);
  const componentReportSha256 = {
    application: "5".repeat(64),
    auth: "6".repeat(64),
    config: "7".repeat(64),
    database: "8".repeat(64),
    storage: "9".repeat(64),
  };
  const continuityIdentity = {
    continuity_policy_sha256: "1".repeat(64),
    continuity_anchor_sha256: "2".repeat(64),
    live_watermark_anchor_sha256: "3".repeat(64),
    live_storage_anchor_sha256: "4".repeat(64),
    live_storage_transition_manifest_sha256: "0".repeat(64),
  };
  const combinedGate = join(privateDir, `cutover-${version}.combined-gate.json`);
  writeFileSync(
    combinedGate,
    `${JSON.stringify({
      snapshot_id: "20260716T220000Z",
      gate_run_id: "20260716T220000Z-1-2",
      source_project_ref: sourceRef,
      target_project_ref: targetRef,
      release_version: version,
      image_id: manifest.imageId,
      build_context_sha256: manifest.buildContextSha256,
      build_args_sha256: manifest.buildArgsSha256,
      sha256sums_sha256: sumsSha256,
      ...continuityIdentity,
      auth_redirect_receipt_sha256: "a".repeat(64),
      rentals_vercel_env_receipt_sha256: "b".repeat(64),
      component_report_sha256: componentReportSha256,
      gate_started_at_utc: gateStartedAtUtc,
      completed_at_utc: gateCompletedAtUtc,
      validated_at_utc: gateValidatedAtUtc,
      operational_state_validated_at_utc: gateOperationalAtUtc,
      gate_run_duration_seconds: 90,
      maximum_component_age_seconds: 30,
      component_evidence_count: 6,
      gate_status: "pass_predeployment",
      failures: [],
      source_write_freeze_active: true,
      source_deleted: false,
      target_writable: true,
      target_jobs_active: false,
      scheduler_enabled: false,
      production_cutover_performed: false,
    })}\n`,
    { mode: 0o600 },
  );

  const shared = {
    receipt_schema_version: 2,
    release_version: version,
    image: manifest.image,
    image_id: manifest.imageId,
    build_context_sha256: manifest.buildContextSha256,
    build_args_sha256: manifest.buildArgsSha256,
    sha256sums_sha256: sumsSha256,
    gate_snapshot_id: "20260716T220000Z",
    gate_run_id: "20260716T220000Z-1-2",
    gate_report_sha256: sha256(readFileSync(combinedGate)),
    ...continuityIdentity,
    component_report_sha256: componentReportSha256,
    gate_validated_at_utc: gateValidatedAtUtc,
    dns_expected_ipv4: "195.201.36.90",
    dns_points_to_target: true,
    predeployment_source_write_freeze_active: true,
    predeployment_target_jobs_active: false,
    scheduler_enabled: false,
  };
  const first = {
    ...shared,
    previous_record_sha256: null,
    recorded_at_utc: cutoverStartedAtUtc,
    status: "in_progress",
    stage: "cutover_started",
    compose_healthy: false,
    https_healthy: false,
    stack_removed: false,
  };
  const firstLine = `${JSON.stringify(first)}\n`;
  const terminal = {
    ...shared,
    previous_record_sha256: sha256(firstLine),
    recorded_at_utc: cutoverCompletedAtUtc,
    status: "success",
    stage: "cutover_complete",
    compose_healthy: true,
    https_healthy: true,
    stack_removed: false,
  };
  const receipt = join(privateDir, `cutover-${version}.jsonl`);
  writeFileSync(receipt, `${firstLine}${JSON.stringify(terminal)}\n`, { mode: 0o600 });
  const env = join(privateDir, "migration.env");
  writeFileSync(
    env,
    [
      `SOURCE_PROJECT_REF=${sourceRef}`,
      `TARGET_PROJECT_REF=${targetRef}`,
      `SOURCE_SUPABASE_ACCESS_TOKEN=${sourceToken}`,
      `TARGET_SUPABASE_ACCESS_TOKEN=${targetToken}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { root, release, helper, privateDir, receipt, combinedGate, env, manifest };
}

const harness = String.raw`
import importlib.util
import os
from pathlib import Path
import sys

helper, release, receipt, env, output = sys.argv[1:]
spec = importlib.util.spec_from_file_location("motorist_activation_gate", helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def query(project_ref, token):
    if project_ref == module.SOURCE_REF:
        assert token.startswith("sbp_source-test-secret-marker")
        return {
            "database_default_read_only": os.environ.get("TEST_CASE") != "source-unfrozen",
            "active_cron_jobs": 0,
        }
    assert project_ref == module.TARGET_REF
    assert token.startswith("sbp_target-test-secret-marker")
    return {
        "database_default_read_only": False,
        "active_cron_jobs": 0,
        "job_controls_total": 11,
        "job_controls_enabled": 0,
        "expected_job_controls_total": 11,
    }

def health(version):
    assert version == "hetzner-activation-gate-test"
    return {"live": True, "ready": True, "exactRelease": True}

def dns():
    return {
        "authoritativeExactTarget": True,
        "recursiveExactTarget": True,
        "authoritativeNameserverCount": 3,
    }

module.create_activation_gate(
    Path(release), Path(receipt), Path(env), Path(output),
    query_function=query, health_function=health, dns_function=dns,
)
`;

function runGate(f, output, testCase = "happy") {
  return spawnSync(
    "python3",
    ["-c", harness, f.helper, f.release, f.receipt, f.env, output],
    { encoding: "utf8", env: { ...process.env, TEST_CASE: testCase } },
  );
}

function rewriteReceipt(f, mutate) {
  const records = readFileSync(f.receipt, "utf8").trim().split("\n").map(JSON.parse);
  mutate(records);
  const firstLine = `${JSON.stringify(records[0])}\n`;
  records[1].previous_record_sha256 = sha256(firstLine);
  writeFileSync(f.receipt, `${firstLine}${JSON.stringify(records[1])}\n`, { mode: 0o600 });
}

test("activation gate is private, aggregate-only, exact-release evidence", () => {
  const f = fixture();
  const output = join(f.privateDir, "activation-gate.json");
  const result = runGate(f, output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(statSync(output).mode & 0o777, 0o600);
  const gate = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(gate.schema, "motorist-activation-gate/v1");
  assert.equal(gate.gateStatus, "pass_activation");
  assert.equal(gate.releaseVersion, f.manifest.version);
  assert.equal(gate.imageId, f.manifest.imageId);
  assert.deepEqual(gate.source, {
    persistentDatabaseFreeze: true,
    activeCronJobs: 0,
  });
  assert.equal(gate.target.jobControlsTotal, 11);
  assert.equal(gate.target.jobControlsEnabled, 0);
  assert.equal(gate.publicHttps.exactRelease, true);
  assert.equal(gate.dns.authoritativeExactTarget, true);
  const serialized = readFileSync(output, "utf8");
  assert.equal(serialized.includes(sourceToken), false);
  assert.equal(serialized.includes(targetToken), false);
  assert.match(gate.cutoverReceiptSha256, /^[0-9a-f]{64}$/);
  assert.match(gate.validatedAtUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(gate.validationCompletedAtUtc, gate.validatedAtUtc);
  assert.ok(gate.validationDurationSeconds >= 0 && gate.validationDurationSeconds <= 120);
  assert.equal(gate.maximumAgeSeconds, 300);
  assert.equal(
    Date.parse(gate.validUntilUtc) - Date.parse(gate.validationCompletedAtUtc),
    300_000,
  );

  const reused = runGate(f, output);
  assert.notEqual(reused.status, 0);
  assert.equal(reused.stdout.includes("secret-marker"), false);
  assert.equal(reused.stderr.includes("secret-marker"), false);
});

test("activation gate rejects a broken cutover chain", () => {
  const f = fixture();
  const records = readFileSync(f.receipt, "utf8").trim().split("\n").map(JSON.parse);
  records[1].previous_record_sha256 = "f".repeat(64);
  writeFileSync(f.receipt, `${records.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const output = join(f.privateDir, "broken-chain.json");
  const result = runGate(f, output);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.includes("secret-marker"), false);
});

test("activation gate rejects a fabricated receipt with no matching combined gate", () => {
  const f = fixture();
  rewriteReceipt(f, (records) => {
    for (const record of records) record.gate_report_sha256 = "f".repeat(64);
  });

  const result = runGate(f, join(f.privateDir, "fabricated-receipt.json"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /combined gate checksum differs/);
});

test("activation gate rejects combined-gate component identity drift even when its hash is rebound", () => {
  const f = fixture();
  const combinedGate = JSON.parse(readFileSync(f.combinedGate, "utf8"));
  combinedGate.component_report_sha256.database = "f".repeat(64);
  writeFileSync(f.combinedGate, `${JSON.stringify(combinedGate)}\n`, { mode: 0o600 });
  const reboundHash = sha256(readFileSync(f.combinedGate));
  rewriteReceipt(f, (records) => {
    for (const record of records) record.gate_report_sha256 = reboundHash;
  });

  const result = runGate(f, join(f.privateDir, "component-drift.json"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /component-report identity differs/);
});

test("activation gate rejects a combined gate that was stale when cutover started", () => {
  const f = fixture();
  const combinedGate = JSON.parse(readFileSync(f.combinedGate, "utf8"));
  const firstRecord = JSON.parse(readFileSync(f.receipt, "utf8").split("\n", 1)[0]);
  const cutoverStartedAt = Date.parse(firstRecord.recorded_at_utc);
  const staleValidatedAtUtc = utcSeconds(cutoverStartedAt - 600_000);
  combinedGate.gate_started_at_utc = utcSeconds(cutoverStartedAt - 700_000);
  combinedGate.validated_at_utc = staleValidatedAtUtc;
  combinedGate.operational_state_validated_at_utc = utcSeconds(cutoverStartedAt - 551_000);
  combinedGate.completed_at_utc = utcSeconds(cutoverStartedAt - 550_000);
  combinedGate.gate_run_duration_seconds = 150;
  combinedGate.maximum_component_age_seconds = 50;
  writeFileSync(f.combinedGate, `${JSON.stringify(combinedGate)}\n`, { mode: 0o600 });
  const reboundHash = sha256(readFileSync(f.combinedGate));
  rewriteReceipt(f, (records) => {
    for (const record of records) {
      record.gate_report_sha256 = reboundHash;
      record.gate_validated_at_utc = staleValidatedAtUtc;
    }
  });

  const result = runGate(f, join(f.privateDir, "stale-combined-gate.json"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /combined gate was stale/);
});

test("activation gate rejects an unsafe live source state", () => {
  const f = fixture();
  const result = runGate(f, join(f.privateDir, "wrong-state.json"), "source-unfrozen");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source freeze is inactive/);
});

test("activation gate rejects cutover release identity drift", () => {
  const f = fixture();
  const records = readFileSync(f.receipt, "utf8").trim().split("\n").map(JSON.parse);
  records[1].continuity_anchor_sha256 = "0".repeat(64);
  writeFileSync(f.receipt, `${records.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const result = runGate(f, join(f.privateDir, "identity-drift.json"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /identity changed/);
});

test("activation gate requires the live Storage transition manifest binding", () => {
  const f = fixture();
  const records = readFileSync(f.receipt, "utf8").trim().split("\n").map(JSON.parse);
  for (const record of records) {
    delete record.live_storage_transition_manifest_sha256;
  }
  const firstLine = `${JSON.stringify(records[0])}\n`;
  records[1].previous_record_sha256 = sha256(firstLine);
  writeFileSync(f.receipt, `${firstLine}${JSON.stringify(records[1])}\n`, { mode: 0o600 });

  const result = runGate(f, join(f.privateDir, "missing-storage-transition.json"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hash identity is invalid/);
});

test("activation gate uses only fixed read-only SELECTs", () => {
  assert.match(helperSource, /json\.dumps\(\{"query": query, "read_only": True\}\)/);
  assert.doesNotMatch(helperSource, /"read_only"\s*:\s*False/);
  assert.match(helperSource, /method="POST"/);
  assert.doesNotMatch(helperSource, /method="(?:PATCH|PUT|DELETE)"/);
  for (const name of ["SOURCE_STATE_QUERY", "TARGET_STATE_QUERY"]) {
    const match = helperSource.match(new RegExp(`${name} = (?:f)?"""([\\s\\S]*?)"""`));
    assert.ok(match, `${name} not found`);
    const sql = match[1].toLowerCase();
    assert.match(sql.trim(), /^select\b/);
    assert.doesNotMatch(sql, /\b(?:insert|update|delete|alter|drop|create|truncate|grant|revoke)\b/);
  }
});
