import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const activationPath = resolve("deploy/bin/activate-viptel-listener-only.sh");
const validatorPath = resolve("deploy/bin/validate-activation-inputs.py");
const version = "hetzner-listener-only-test";
const targetRef = "sjcsrygkkmersoczpunh";
const authority = "listener-test-authority-token-at-least-32-characters";
const bridgeAuthority = "provider-snapshot-bridge-authority-0001";

function serialize(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

function sharedRuntime() {
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

function fixture(token = authority) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "viptel-listener-only-")));
  const production = join(root, "release");
  const env = join(production, "env");
  mkdirSync(env, { recursive: true, mode: 0o700 });
  writeFileSync(join(production, "manifest.json"), `${JSON.stringify({
    version,
    image: `motorist-app:${version}`,
    imageId: `sha256:${"a".repeat(64)}`,
    gitSha: "b".repeat(40),
    buildContextSha256: "c".repeat(64),
    buildArgsSha256: "d".repeat(64),
    platform: "linux/amd64",
    schedulerEnabled: false,
  })}\n`);
  const web = join(env, "web.env");
  const worker = join(env, "worker.env");
  const listener = join(env, "viptel-listener.env");
  writeFileSync(web, serialize({
    ...sharedRuntime(),
    VIPTEL_LIVE_MUTATIONS_ENABLED: "false",
    VIPTEL_LIVE_MUTATION_TOKEN: token,
    VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED: "true",
    VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN: bridgeAuthority,
    VIPTEL_DISPATCH_PERSONAL_EXTENSIONS: "20,21,22,23",
  }), { mode: 0o600 });
  writeFileSync(worker, serialize({
    ...sharedRuntime(),
    WORKER_INSTANCE_ID: "motorist-prod-01",
    SCHEDULER_ENABLED: "false",
    HEALTHCHECKS_PING_URL: "https://hc-ping.com/11111111-1111-4111-8111-111111111111",
  }), { mode: 0o600 });
  writeFileSync(listener, serialize({
    ...sharedRuntime(),
    VIPTEL_LISTENER_INSTANCE_ID: "motorist-prod-01-viptel",
    VIPTEL_LISTENER_ENABLED: "false",
    VIPTEL_LIVE_MUTATIONS_ENABLED: "false",
    VIPTEL_LIVE_MUTATION_TOKEN: token,
    VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED: "true",
    VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN: bridgeAuthority,
    VIPTEL_DISPATCH_PERSONAL_EXTENSIONS: "20,21,22,23",
    VIPTEL_HEALTHCHECKS_PING_URL: "https://hc-ping.com/22222222-2222-4222-8222-222222222222",
  }), { mode: 0o600 });
  chmodSync(web, 0o600);
  chmodSync(worker, 0o600);
  chmodSync(listener, 0o600);
  return { root, production, web, worker, listener };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function setListenerFlags(value, options = {}) {
  const args = [
    validatorPath,
    "set-listener-flags",
    options.production,
    version,
    "--enabled",
    value,
  ];
  if (options.force) args.push("--force-disable");
  if (options.expected) args.push("--expected-listener-sha256", options.expected);
  if (options.output) args.push("--output", "hash");
  return spawnSync("python3", args, { encoding: "utf8" });
}

test("listener-only activation is exact-release bound and never starts the worker", () => {
  const activation = readFileSync(activationPath, "utf8");
  assert.match(activation, /EXPECTED_PRODUCTION_GIT_SHA/);
  assert.match(activation, /git_sha != expected_git_sha/);
  assert.match(activation, /sha256sum -c SHA256SUMS/);
  assert.match(activation, /docker image inspect --format '\{\{\.Id\}\}'/);
  assert.match(activation, /set-listener-flags[\s\S]*--enabled true/);
  assert.match(activation, /compose_project="motorist-dispatch"/);
  assert.match(activation, /docker compose --project-name "\$compose_project" -f compose\.yml up[\s\\]+-d --no-deps --force-recreate "\$service"/);
  assert.ok((activation.match(/--expected-release-sha256 "\$release_checksum_sha256"/g) ?? []).length >= 3);
  assert.ok(
    activation.indexOf("verify-listener-release")
      < activation.indexOf('python3 "$operation_lock_helper" prepare'),
  );
  assert.doesNotMatch(activation, /up[\s\\]+-d[^\n]*(?:worker|web_blue|web_green|caddy)/);
  assert.doesNotMatch(activation, /set-controls|--scheduler true|--mode enable/);
  assert.match(activation, /verify_worker_unchanged/);
  assert.match(activation, /--require-fresh-disabled-worker/);
  assert.match(activation, /--require-fresh-disabled-listener/);
  assert.doesNotMatch(activation, /Worker is running; refusing|listener is already running/);
  assert.match(activation, /controls-state "\$release_dir" "\$version" --jobs ""/);
  assert.match(activation, /listener-only-state[\s\S]*--phase started/);
  assert.ok((activation.match(/verify_listener_running_exact_image/g) ?? []).length >= 3);
  assert.doesNotMatch(activation, /VIPTEL_LIVE_MUTATION_TOKEN/);
  const syntax = spawnSync("bash", ["-n", activationPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("listener flags use one CAS-bound atomic file replacement", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const workerBefore = readFileSync(item.worker);
  const listenerBefore = readFileSync(item.listener);

  const stale = setListenerFlags("true", {
    production: item.production,
    expected: "0".repeat(64),
    output: true,
  });
  assert.notEqual(stale.status, 0);
  assert.deepEqual(readFileSync(item.listener), listenerBefore);

  const enabled = setListenerFlags("true", {
    production: item.production,
    expected: sha256(item.listener),
    output: true,
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout.trim(), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(`${enabled.stdout}${enabled.stderr}`, new RegExp(authority));
  const activeRuntime = readFileSync(item.listener, "utf8");
  assert.match(activeRuntime, /VIPTEL_LISTENER_ENABLED="true"/);
  assert.match(activeRuntime, /VIPTEL_LIVE_MUTATIONS_ENABLED="true"/);
  assert.deepEqual(readFileSync(item.worker), workerBefore);

  const verified = spawnSync("python3", [
    validatorPath,
    "verify-listener-runtime",
    item.production,
    version,
    "--expected-listener-sha256",
    enabled.stdout.trim(),
    "--enabled",
    "true",
    "--require-authority",
  ], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
});

test("short authority fails closed without changing either runtime", (t) => {
  const item = fixture("too-short");
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const listenerBefore = readFileSync(item.listener);
  const workerBefore = readFileSync(item.worker);
  const result = setListenerFlags("true", {
    production: item.production,
    expected: sha256(item.listener),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authority length is invalid/);
  assert.deepEqual(readFileSync(item.listener), listenerBefore);
  assert.deepEqual(readFileSync(item.worker), workerBefore);
});

test("force-disable turns both flags off even when authority became invalid", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const enabled = setListenerFlags("true", {
    production: item.production,
    expected: sha256(item.listener),
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  const damaged = readFileSync(item.listener, "utf8").replace(
    /VIPTEL_LIVE_MUTATION_TOKEN=.*\n/,
    `VIPTEL_LIVE_MUTATION_TOKEN=${JSON.stringify("invalid")}\n`,
  );
  writeFileSync(item.listener, damaged, { mode: 0o600 });
  chmodSync(item.listener, 0o600);

  const disabled = setListenerFlags("false", {
    production: item.production,
    force: true,
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  const runtime = readFileSync(item.listener, "utf8");
  assert.match(runtime, /VIPTEL_LISTENER_ENABLED="false"/);
  assert.match(runtime, /VIPTEL_LIVE_MUTATIONS_ENABLED="false"/);
});

test("listener-only heartbeat validation accepts installed disabled services and rejects an active scheduler", () => {
  const runHeartbeatCheck = (rows, phase, requireWorker = false, requireListener = false) => spawnSync("python3", [
    "-c",
    [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('validator',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.validate_listener_only_heartbeat_rows(json.loads(sys.argv[2]),sys.argv[3],sys.argv[4],sys.argv[5]=='true',sys.argv[6]=='true')",
    ].join(";"),
    validatorPath,
    JSON.stringify(rows),
    version,
    phase,
    String(requireWorker),
    String(requireListener),
  ], { encoding: "utf8" });

  const listener = {
    instance_id: "motorist-prod-01-viptel",
    deployment_version: version,
    heartbeat_at: new Date().toISOString(),
    scheduler_tick_at: null,
    scheduler_status: "listener",
    viptel_ws_status: "connected",
  };
  const valid = runHeartbeatCheck([listener], "started");
  assert.equal(valid.status, 0, valid.stderr);

  const disabledListener = { ...listener, viptel_ws_status: "disabled" };
  const disabledWorker = {
    instance_id: "motorist-prod-01",
    deployment_version: version,
    heartbeat_at: new Date().toISOString(),
    scheduler_tick_at: null,
    scheduler_status: "disabled",
    viptel_ws_status: "disabled",
  };
  const installedBaseline = runHeartbeatCheck(
    [disabledListener, disabledWorker],
    "disabled",
    true,
    true,
  );
  assert.equal(installedBaseline.status, 0, installedBaseline.stderr);

  const activeWorker = runHeartbeatCheck([
    listener,
    {
      ...disabledWorker,
      scheduler_tick_at: new Date().toISOString(),
      scheduler_status: "running",
    },
  ], "started");
  assert.notEqual(activeWorker.status, 0);
  assert.match(activeWorker.stderr, /worker scheduler is active/);

  const duplicateListener = runHeartbeatCheck([listener, listener], "started");
  assert.notEqual(duplicateListener.status, 0);
  assert.match(duplicateListener.stderr, /heartbeat identity is duplicated/);
});

test("listener-only receipt is private, chained, and truthfully records rollback", () => {
  const activation = readFileSync(activationPath, "utf8");
  assert.match(activation, /os\.open\(path, flags \| os\.O_CREAT \| os\.O_EXCL, 0o600\)/);
  assert.match(activation, /stat\.S_IMODE\(metadata\.st_mode\) != 0o600/);
  assert.match(activation, /previousRecordSha256/);
  assert.match(activation, /hashlib\.sha256\(first_line\)\.hexdigest\(\)/);
  assert.match(activation, /listener activation receipt initial record is invalid/);
  assert.match(activation, /set\(first\) != set\(record\)/);
  assert.match(activation, /listener activation receipt transition is invalid/);
  assert.match(activation, /local rollback_stage=rollback_incomplete/);
  assert.match(activation, /set-listener-flags[\s\S]*--enabled false --force-disable/);
  assert.match(activation, /stop_listener/);
  assert.match(activation, /rollback_stage=rollback_complete/);
  assert.match(activation, /workerStarted": False/);
  assert.match(activation, /schedulerEnabled": False/);
  assert.match(activation, /enabledJobs": \[\]/);
});

test("release tooling checksum-binds and installs the listener-only activator", () => {
  const builder = readFileSync(resolve("deploy/bin/build-release.sh"), "utf8");
  const installer = readFileSync(resolve("deploy/bin/install-release.sh"), "utf8");
  const validator = readFileSync(validatorPath, "utf8");
  for (const implementation of [builder, installer, validator]) {
    assert.match(implementation, /activate-viptel-listener-only\.sh/);
  }
});
