import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
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

const sourceHelper = resolve("deploy/bin/create-target-authority-gate.py");
const sourceRef = "jcwbiulwuwyrnmzjjbgr";
const targetRef = "sjcsrygkkmersoczpunh";
const targetUrl = `https://${targetRef}.supabase.co`;
const sourceToken = "sbp_source-test-token-000000000000";
const targetToken = "sbp_target-test-token-000000000000";
const publicKey = "sb_publishable_target-test-key";
const secretKey = "sb_secret_target-test-key";

function loadQueryHashes() {
  const script = String.raw`
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location("target_authority_hashes", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps({"source": module.SOURCE_QUERY_SHA256, "target": module.TARGET_QUERY_SHA256}))
`;
  const result = spawnSync("python3", ["-c", script, sourceHelper], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const queryHashes = loadQueryHashes();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalCommitment(field, evidence) {
  return sha256(
    canonicalJson({
      schema: "target-authority/compatibility-commitment-v1",
      field,
      evidence,
    }),
  );
}

function serializeEnv(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

function writePrivate(path, contents) {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function sharedEnv(version) {
  return {
    SUPABASE_PROJECT_REF: targetRef,
    SUPABASE_URL: targetUrl,
    NEXT_PUBLIC_SUPABASE_URL: targetUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
    SUPABASE_ANON_KEY: publicKey,
    SUPABASE_PUBLISHABLE_KEY: publicKey,
    SUPABASE_SECRET_KEY: secretKey,
    SUPABASE_SERVICE_ROLE_KEY: secretKey,
    DEPLOYMENT_VERSION: version,
    NODE_ENV: "production",
    MOTORIST_DEV_AUTH_BYPASS: "false",
    APP_BASE_URL: "https://dispecing.linkapomoci.sk",
    PUBLIC_APP_URL: "https://dispecing.linkapomoci.sk",
    NEXT_PUBLIC_APP_URL: "https://dispecing.linkapomoci.sk",
  };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "motorist-target-authority-")));
  const release = join(root, "release");
  const bin = join(release, "bin");
  const runtime = join(root, "runtime");
  const privateDir = join(root, "private");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(privateDir, { mode: 0o700 });
  chmodSync(runtime, 0o700);
  chmodSync(privateDir, 0o700);

  const helper = sourceHelper;
  const version = "hetzner-target-authority-test";
  const shared = sharedEnv(version);
  const envs = {
    web: shared,
    worker: { ...shared, SCHEDULER_ENABLED: "false", WORKER_INSTANCE_ID: "motorist-prod-01" },
    "viptel-listener": {
      ...shared,
      VIPTEL_LISTENER_ENABLED: "false",
      VIPTEL_LISTENER_INSTANCE_ID: "motorist-prod-01-viptel",
    },
    caddy: { APP_DOMAIN: "dispecing.linkapomoci.sk", ACME_EMAIL: "test@example.invalid" },
  };
  for (const [name, values] of Object.entries(envs)) {
    writePrivate(join(runtime, `${name}.env`), serializeEnv(values));
  }

  const buildArgs = {
    DEPLOYMENT_VERSION: version,
    NEXT_PUBLIC_APP_URL: "https://dispecing.linkapomoci.sk",
    NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY: "",
    NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID: "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
    NEXT_PUBLIC_SUPABASE_URL: targetUrl,
  };
  const contractPayload = `${JSON.stringify({ schemaVersion: 1, buildArgs })}\n`;
  const buildContract = join(privateDir, "build-input.json");
  writePrivate(buildContract, contractPayload);
  const manifest = {
    version,
    gitSha: "a".repeat(40),
    image: `motorist-app:${version}`,
    imageId: `sha256:${"b".repeat(64)}`,
    buildContextSha256: "c".repeat(64),
    buildArgsSha256: sha256(contractPayload),
    platform: "linux/amd64",
    createdAt: "2026-07-17T12:00:00Z",
    schedulerEnabled: false,
  };
  const releaseFiles = {
    "image.tar.gz": "exact image archive bytes\n",
    "manifest.json": `${JSON.stringify(manifest)}\n`,
    "compose.yml": "services: {}\n",
    Caddyfile: "test.invalid\n",
    "upstream.caddy": "\n",
  };
  for (const [name, contents] of Object.entries(releaseFiles)) {
    if (name.startsWith("bin/")) continue;
    writeFileSync(join(release, name), contents);
  }
  const sums = `${Object.entries(releaseFiles)
    .map(([name, contents]) => `${sha256(contents)}  ${name}`)
    .join("\n")}\n`;
  writeFileSync(join(release, "SHA256SUMS"), sums);

  const migrationEnv = join(privateDir, "migration.env");
  writePrivate(
    migrationEnv,
    [
      `SOURCE_PROJECT_REF=${sourceRef}`,
      `TARGET_PROJECT_REF=${targetRef}`,
      `SOURCE_SUPABASE_ACCESS_TOKEN=${sourceToken}`,
      `TARGET_SUPABASE_ACCESS_TOKEN=${targetToken}`,
      "",
    ].join("\n"),
  );
  return {
    root,
    release,
    helper,
    runtime,
    privateDir,
    buildContract,
    migrationEnv,
    manifest,
    sumsSha256: sha256(sums),
  };
}

function writeAggregateEvidence(f, mutate = () => {}, mode = 0o600) {
  const observedAt = new Date(Date.now() - 1_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const evidence = {
    schema: "motorist-target-authority-aggregate-evidence/v1",
    status: "pass_read_only",
    generated_at_utc: observedAt,
    source: {
      status: "pass",
      project_ref: sourceRef,
      transport: "supabase_management_api",
      tool: "database/query",
      read_only: true,
      credential_value_read_or_recorded: false,
      query_sha256: queryHashes.source,
      observed_at_utc: observedAt,
      database_default_read_only: true,
      active_cron_jobs: 0,
    },
    target: {
      status: "pass",
      project_ref: targetRef,
      transport: "supabase_dispatch_prod",
      tool: "execute_sql",
      read_only: true,
      credential_value_read_or_recorded: false,
      query_sha256: queryHashes.target,
      observed_at_utc: observedAt,
      database_default_read_only: false,
      active_cron_jobs: 0,
      job_controls_total: 11,
      job_controls_enabled: 0,
      expected_job_controls_total: 11,
    },
  };
  mutate(evidence);
  const payload = `${JSON.stringify(evidence)}\n`;
  const path = join(f.privateDir, `aggregate-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, payload, { mode });
  chmodSync(path, mode);
  return { path, payload, evidence };
}

const harness = String.raw`
import datetime
import importlib.util
import os
from pathlib import Path
import sys

helper, release, runtime, contract, migration, output = sys.argv[1:]
spec = importlib.util.spec_from_file_location("target_authority", helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
case = os.environ.get("TEST_CASE", "happy")
aggregate_path = os.environ.get("AGGREGATE_EVIDENCE")
controlled_now = os.environ.get("CONTROLLED_NOW")
clock = [
    datetime.datetime.strptime(controlled_now, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=datetime.timezone.utc
    )
] if controlled_now else None

def now():
    return clock[0] if clock else datetime.datetime.now(datetime.timezone.utc)

def query(project_ref, token):
    assert aggregate_path is None
    if project_ref == module.SOURCE_REF:
        assert token.startswith("sbp_source-test-token")
        return {
            "database_default_read_only": case != "source-unfrozen",
            "active_cron_jobs": 1 if case == "source-cron" else 0,
        }
    assert project_ref == module.TARGET_REF
    assert token.startswith("sbp_target-test-token")
    return {
        "database_default_read_only": False,
        "active_cron_jobs": 0,
        "job_controls_total": 11,
        "job_controls_enabled": 1 if case == "target-job" else 0,
        "expected_job_controls_total": 11,
    }

def services(env):
    assert env["SUPABASE_URL"] == module.TARGET_URL
    if case == "delayed-boundary":
        clock[0] += datetime.timedelta(seconds=3)
    if case == "service-failure":
        return {"auth": True, "data_api": False, "storage": True}
    return {"auth": True, "data_api": True, "storage": True}

try:
    module.create_target_authority_gate(
        Path(release), Path(runtime), Path(contract),
        None if aggregate_path else Path(migration), Path(output),
        aggregate_evidence_path=Path(aggregate_path) if aggregate_path else None,
        query_function=query, service_function=services, now_function=now,
    )
except module.GateError as error:
    print(f"gate failed: {error}", file=sys.stderr)
    raise SystemExit(1)
`;

function runGate(
  f,
  output,
  testCase = "happy",
  aggregateEvidence = null,
  controlledNow = null,
) {
  return spawnSync(
    "python3",
    [
      "-c",
      harness,
      f.helper,
      f.release,
      f.runtime,
      f.buildContract,
      aggregateEvidence ? join(f.root, "absent-management-pat.env") : f.migrationEnv,
      output,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_CASE: testCase,
        ...(aggregateEvidence ? { AGGREGATE_EVIDENCE: aggregateEvidence } : {}),
        ...(controlledNow ? { CONTROLLED_NOW: controlledNow } : {}),
      },
    },
  );
}

test("target-authority gate emits only private aggregate evidence", () => {
  const f = fixture();
  const output = join(f.privateDir, "target-authority.json");
  const result = runGate(f, output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(statSync(output).mode & 0o777, 0o600);
  const payload = readFileSync(output, "utf8");
  const gate = JSON.parse(payload);
  assert.equal(gate.schema, "target-authority/v1");
  assert.equal(gate.gate_status, "pass_predeployment");
  assert.equal(gate.source_write_freeze_active, true);
  assert.equal(gate.target_writable, true);
  assert.equal(gate.target.active_cron_jobs, 0);
  assert.equal(gate.target.job_controls_total, 11);
  assert.equal(gate.target.job_controls_enabled, 0);
  assert.deepEqual(gate.target_services, { auth: true, data_api: true, storage: true });
  assert.equal(gate.image_target_only, true);
  assert.equal(gate.runtime_target_only, true);
  assert.equal(gate.release_version, f.manifest.version);
  assert.match(gate.image_archive_sha256, /^[0-9a-f]{64}$/);
  for (const secret of [sourceToken, targetToken, publicKey, secretKey]) {
    assert.equal(payload.includes(secret), false);
  }
});

test("private aggregate evidence replaces both Management API PAT queries", () => {
  const f = fixture();
  const aggregate = writeAggregateEvidence(f);
  const output = join(f.privateDir, "target-authority.json");
  const result = runGate(f, output, "happy", aggregate.path);
  assert.equal(result.status, 0, result.stderr);
  const gate = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(gate.state_evidence.mode, "aggregate_file");
  assert.equal(
    gate.state_evidence.schema,
    "motorist-target-authority-aggregate-evidence/v1",
  );
  assert.equal(gate.state_evidence.sha256, sha256(aggregate.payload));
  assert.deepEqual(
    [gate.state_evidence.source.transport, gate.state_evidence.source.tool],
    ["supabase_management_api", "database/query"],
  );
  assert.deepEqual(
    [gate.state_evidence.target.transport, gate.state_evidence.target.tool],
    ["supabase_dispatch_prod", "execute_sql"],
  );
  assert.equal(gate.state_evidence.source.credential_value_read_or_recorded, false);
  assert.equal(gate.state_evidence.target.credential_value_read_or_recorded, false);
  assert.equal(readFileSync(output, "utf8").includes(sourceToken), false);
  assert.equal(readFileSync(output, "utf8").includes(targetToken), false);
});

test("aggregate evidence rejects stale and future observations", async (t) => {
  for (const [name, seconds, expected] of [
    ["stale", -180, /stale/],
    ["future", 60, /future/],
  ]) {
    await t.test(name, () => {
      const f = fixture();
      const timestamp = new Date(Date.now() + seconds * 1_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
      const aggregate = writeAggregateEvidence(f, (evidence) => {
        evidence.generated_at_utc = timestamp;
        evidence.source.observed_at_utc = timestamp;
        evidence.target.observed_at_utc = timestamp;
      });
      const output = join(f.privateDir, "target-authority.json");
      const result = runGate(f, output, "happy", aggregate.path);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(existsSync(output), false);
    });
  }
});

test("near-boundary aggregate evidence cannot age out during a delayed probe", () => {
  const f = fixture();
  const base = new Date();
  base.setMilliseconds(0);
  const controlledNow = base.toISOString().replace(/\.\d{3}Z$/, "Z");
  const nearBoundary = new Date(base.getTime() - 119_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const aggregate = writeAggregateEvidence(f, (evidence) => {
    evidence.generated_at_utc = nearBoundary;
    evidence.source.observed_at_utc = nearBoundary;
    evidence.target.observed_at_utc = nearBoundary;
  });
  const output = join(f.privateDir, "target-authority.json");
  const result = runGate(
    f,
    output,
    "delayed-boundary",
    aggregate.path,
    controlledNow,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /became stale during gate validation/);
  assert.equal(existsSync(output), false);
});

test("aggregate evidence fails closed on tampered identity, provenance, credentials, or state", async (t) => {
  const cases = [
    ["project ref", (evidence) => { evidence.target.project_ref = sourceRef; }, /project ref/],
    ["transport", (evidence) => { evidence.target.transport = "supabase_dispatch_source"; }, /transport and tool/],
    ["query", (evidence) => { evidence.target.query_sha256 = "0".repeat(64); }, /query binding/],
    ["credential", (evidence) => { evidence.source.credential_value_read_or_recorded = true; }, /credential value/],
    ["source freeze", (evidence) => { evidence.source.database_default_read_only = false; }, /source database freeze/],
    ["target jobs", (evidence) => { evidence.target.job_controls_enabled = 1; }, /target has enabled jobs/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const f = fixture();
      const aggregate = writeAggregateEvidence(f, mutate);
      const output = join(f.privateDir, "target-authority.json");
      const result = runGate(f, output, "happy", aggregate.path);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(existsSync(output), false);
    });
  }
});

test("aggregate evidence requires exact target control counts", () => {
  const f = fixture();
  const aggregate = writeAggregateEvidence(f, (evidence) => {
    delete evidence.target.expected_job_controls_total;
  });
  const output = join(f.privateDir, "target-authority.json");
  const result = runGate(f, output, "happy", aggregate.path);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target aggregate evidence contract is not exact/);
  assert.equal(existsSync(output), false);
});

test("aggregate evidence requires exact mode 0600", () => {
  const f = fixture();
  const aggregate = writeAggregateEvidence(f, () => {}, 0o644);
  const output = join(f.privateDir, "target-authority.json");
  const result = runGate(f, output, "happy", aggregate.path);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must have mode 0600/);
  assert.equal(existsSync(output), false);
});

test("aggregate evidence rejects duplicate JSON keys", () => {
  const f = fixture();
  const aggregate = writeAggregateEvidence(f);
  const duplicate = aggregate.payload.replace(
    '"schema":"motorist-target-authority-aggregate-evidence/v1"',
    '"schema":"motorist-target-authority-aggregate-evidence/v1","schema":"motorist-target-authority-aggregate-evidence/v1"',
  );
  writePrivate(aggregate.path, duplicate);
  const output = join(f.privateDir, "target-authority.json");
  const result = runGate(f, output, "happy", aggregate.path);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate key/);
  assert.equal(existsSync(output), false);
});

test("target-authority gate directly satisfies the current installer field contract", () => {
  const f = fixture();
  const output = join(f.privateDir, "target-authority.json");
  const result = runGate(f, output);
  assert.equal(result.status, 0, result.stderr);
  const gate = JSON.parse(readFileSync(output, "utf8"));
  const shaPattern = /^[0-9a-f]{64}$/;
  const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  assert.equal(gate.gate_status, "pass_predeployment");
  assert.deepEqual(gate.failures, []);
  assert.match(gate.snapshot_id, /^\d{8}T\d{6}Z$/);
  assert.match(gate.gate_run_id, /^\d{8}T\d{6}Z-\d+-\d+$/);
  assert.equal(gate.source_project_ref, sourceRef);
  assert.equal(gate.target_project_ref, targetRef);
  assert.equal(gate.release_version, f.manifest.version);
  assert.equal(gate.image_id, f.manifest.imageId);
  assert.equal(gate.build_context_sha256, f.manifest.buildContextSha256);
  assert.equal(gate.build_args_sha256, f.manifest.buildArgsSha256);
  assert.equal(gate.sha256sums_sha256, f.sumsSha256);
  for (const field of [
    "continuity_policy_sha256",
    "continuity_anchor_sha256",
    "live_watermark_anchor_sha256",
    "live_storage_anchor_sha256",
    "live_storage_transition_manifest_sha256",
    "auth_redirect_receipt_sha256",
    "rentals_vercel_env_receipt_sha256",
  ]) {
    assert.match(gate[field], shaPattern);
  }
  assert.deepEqual(Object.keys(gate.component_report_sha256).sort(), [
    "application",
    "auth",
    "config",
    "database",
    "storage",
  ]);
  for (const digest of Object.values(gate.component_report_sha256)) assert.match(digest, shaPattern);
  assert.equal(gate.source_write_freeze_active, true);
  assert.equal(gate.source_deleted, false);
  assert.equal(gate.target_jobs_active, false);
  assert.equal(gate.scheduler_enabled, false);
  assert.equal(gate.production_cutover_performed, false);
  assert.equal(gate.component_evidence_count, 6);
  for (const field of [
    "validated_at_utc",
    "gate_started_at_utc",
    "completed_at_utc",
    "operational_state_validated_at_utc",
  ]) {
    assert.match(gate[field], utcPattern);
  }
  const started = Date.parse(gate.gate_started_at_utc);
  const validated = Date.parse(gate.validated_at_utc);
  const operational = Date.parse(gate.operational_state_validated_at_utc);
  const completed = Date.parse(gate.completed_at_utc);
  assert.ok(started <= validated && validated <= completed);
  assert.ok(started <= operational && operational <= completed);
  assert.equal(gate.gate_run_duration_seconds, (completed - started) / 1000);
  assert.equal(gate.maximum_component_age_seconds, (completed - validated) / 1000);
  assert.ok(gate.gate_run_duration_seconds <= 30 * 60);
  assert.ok(gate.maximum_component_age_seconds <= 30 * 60);
});

test("installer compatibility hashes commit to fresh minimal evidence without placeholders", () => {
  const f = fixture();
  const output = join(f.privateDir, "target-authority.json");
  const result = runGate(f, output);
  assert.equal(result.status, 0, result.stderr);
  const gate = JSON.parse(readFileSync(output, "utf8"));
  const { scope, evidence } = gate.compatibility;
  assert.equal(scope.schema, "target-authority/installer-compatibility-v1");
  assert.equal(scope.legacy_artifacts_reused, false);
  assert.equal(scope.legacy_semantics_claimed, false);
  assert.equal(scope.commitment_algorithm, "sha256-canonical-json");
  assert.equal(scope.component_evidence_count, 6);
  for (const [field, evidenceName] of Object.entries(scope.field_evidence)) {
    assert.equal(gate[field], canonicalCommitment(field, evidence[evidenceName]));
  }
  for (const [component, evidenceName] of Object.entries(scope.component_evidence)) {
    const field = `component_report_sha256.${component}`;
    assert.equal(gate.component_report_sha256[component], canonicalCommitment(field, evidence[evidenceName]));
  }
  assert.equal(
    scope.sixth_component.sha256,
    canonicalCommitment(
      "compatibility_component.operational_state",
      evidence[scope.sixth_component.evidence],
    ),
  );
  const allBindings = [
    ...Object.keys(scope.field_evidence).map((field) => gate[field]),
    ...Object.values(gate.component_report_sha256),
    scope.sixth_component.sha256,
  ];
  assert.equal(new Set(allBindings).size, allBindings.length);
  assert.equal(allBindings.some((digest) => digest === "0".repeat(64)), false);
});

for (const [testCase, errorPattern] of [
  ["source-unfrozen", /source database freeze is inactive/],
  ["source-cron", /source has active cron jobs/],
  ["target-job", /target has enabled jobs/],
  ["service-failure", /target service evidence is incomplete/],
]) {
  test(`target-authority gate fails closed for ${testCase}`, () => {
    const f = fixture();
    const output = join(f.privateDir, "target-authority.json");
    const result = runGate(f, output, testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, errorPattern);
    assert.equal(existsSync(output), false);
    assert.equal(result.stderr.includes(sourceToken), false);
    assert.equal(result.stderr.includes(targetToken), false);
  });
}

test("target-authority gate rejects source project in runtime", () => {
  const f = fixture();
  const webPath = join(f.runtime, "web.env");
  writePrivate(webPath, `${readFileSync(webPath, "utf8")}UNSAFE_URL=${JSON.stringify(`https://${sourceRef}.supabase.co`)}\n`);
  const output = join(f.privateDir, "target-authority.json");
  const result = runGate(f, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime contains the source project/);
  assert.equal(existsSync(output), false);
});

test("target-authority gate binds exact build inputs to the release", () => {
  const f = fixture();
  const contract = JSON.parse(readFileSync(f.buildContract, "utf8"));
  contract.buildArgs.NEXT_PUBLIC_SUPABASE_URL = `https://${sourceRef}.supabase.co`;
  writePrivate(f.buildContract, `${JSON.stringify(contract)}\n`);
  const output = join(f.privateDir, "target-authority.json");
  const result = runGate(f, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /build-input contract does not match the release/);
  assert.equal(existsSync(output), false);
});

test("target-authority gate rejects any release checksum drift", () => {
  const f = fixture();
  writeFileSync(join(f.release, "compose.yml"), "tampered\n");
  const output = join(f.privateDir, "target-authority.json");
  const result = runGate(f, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release checksum verification failed/);
  assert.equal(existsSync(output), false);
});

test("minimal gate has no dependency on legacy forensic artifacts", () => {
  const source = readFileSync(sourceHelper, "utf8");
  for (const legacyArtifact of [
    "live-target-continuity-policy.json",
    "create-live-watermark-anchor.mjs",
    "resolve-live-watermark-anchor.mjs",
    "validate-live-target-continuity.mjs",
  ]) {
    assert.equal(source.includes(legacyArtifact), false);
  }
  assert.match(source, /"read_only": True/);
});
