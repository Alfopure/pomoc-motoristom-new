import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateRuntimeEnvContract } from "../deploy/bin/runtime-env-contract.mjs";
import { parseRuntimeEnv, serializeRuntimeEnv } from "../deploy/runtime-env-parser.mjs";
import { serializeApplicationRuntimeEnv } from "../deploy/supabase/validate-application-release.mjs";

test("runtime generator preserves the Healthchecks job map across every strict parser", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "motorist-runtime-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, "base.env");
  const integrations = join(root, "integrations.env");
  const output = join(root, "runtime");
  const jobMap = {
    "notifications.materialize": "https://hc-ping.com/11111111-1111-4111-8111-111111111111",
    "fleet.commander.positions": "https://hc-ping.com/22222222-2222-4222-8222-222222222222",
  };
  const escapedSecret = `quote" backslash\\ apostrophe'`;
  const liveMutationToken = "runtime-test-live-mutation-token-0001";
  const snapshotBridgeToken = "runtime-test-snapshot-bridge-token-0001";

  writeFileSync(
    base,
    [
      "SUPABASE_PROJECT_REF=sjcsrygkkmersoczpunh",
      "SUPABASE_URL=https://sjcsrygkkmersoczpunh.supabase.co",
      "NEXT_PUBLIC_SUPABASE_URL=https://sjcsrygkkmersoczpunh.supabase.co",
      "SUPABASE_PUBLISHABLE_KEY=public-test-key",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=public-test-key",
      "SUPABASE_ANON_KEY=public-test-key",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=public-test-key",
      "SUPABASE_SECRET_KEY=secret-test-key",
      "SUPABASE_SERVICE_ROLE_KEY=secret-test-key",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(
    integrations,
    [
      `HEALTHCHECKS_JOB_URLS_JSON=${JSON.stringify(JSON.stringify(jobMap))}`,
      `WEBDISPECINK_PASSWORD=${JSON.stringify(escapedSecret)}`,
      `VIPTEL_LIVE_MUTATIONS_ENABLED=${JSON.stringify("true")}`,
      `VIPTEL_LIVE_MUTATION_TOKEN=${JSON.stringify(liveMutationToken)}`,
      `VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED=${JSON.stringify("true")}`,
      `VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN=${JSON.stringify(snapshotBridgeToken)}`,
      `VIPTEL_DISPATCH_PERSONAL_EXTENSIONS=${JSON.stringify("20,21,22,23")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const result = spawnSync(
    process.execPath,
    [
      resolve("deploy/bin/prepare-runtime-env.mjs"),
      "--base",
      base,
      "--overrides",
      join(root, "missing-overrides.env"),
      "--integrations",
      integrations,
      "--out",
      output,
      "--version",
      "hetzner-runtime-test",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(liveMutationToken), false);
  assert.equal(result.stderr.includes(liveMutationToken), false);
  assert.equal(result.stdout.includes(snapshotBridgeToken), false);
  assert.equal(result.stderr.includes(snapshotBridgeToken), false);
  const generatedFiles = ["web.env", "worker.env", "viptel-listener.env", "caddy.env"];
  for (const filename of generatedFiles) {
    const contents = readFileSync(join(output, filename), "utf8");
    assert.doesNotThrow(() => parseRuntimeEnv(contents));

    const pythonResult = spawnSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util, pathlib, sys",
          "path = pathlib.Path(sys.argv[1])",
          "spec = importlib.util.spec_from_file_location('activation_validator', sys.argv[2])",
          "module = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "module.parse_env(path)",
        ].join("; "),
        join(output, filename),
        resolve("deploy/bin/validate-activation-inputs.py"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(pythonResult.status, 0, pythonResult.stderr);
  }

  await validateRuntimeEnvContract({
    envDir: output,
    version: "hetzner-runtime-test",
    sourceRef: "jcwbiulwuwyrnmzjjbgr",
    targetRef: "sjcsrygkkmersoczpunh",
    appDomain: "dispecing.linkapomoci.sk",
  });

  const workerContents = readFileSync(join(output, "worker.env"), "utf8");
  const worker = parseRuntimeEnv(workerContents);
  assert.deepEqual(JSON.parse(worker.HEALTHCHECKS_JOB_URLS_JSON), jobMap);
  assert.equal(worker.WEBDISPECINK_PASSWORD, escapedSecret);
  const listener = parseRuntimeEnv(readFileSync(join(output, "viptel-listener.env"), "utf8"));
  assert.equal(listener.VIPTEL_LIVE_MUTATIONS_ENABLED, "true");
  assert.equal(listener.VIPTEL_LIVE_MUTATION_TOKEN, liveMutationToken);
  assert.equal(listener.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED, "true");
  assert.equal(listener.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN, snapshotBridgeToken);
  assert.equal(listener.VIPTEL_DISPATCH_PERSONAL_EXTENSIONS, "20,21,22,23");
  assert.equal(Object.keys(listener).some((key) => key.startsWith("NEXT_PUBLIC_VIPTEL_LIVE_")), false);
  assert.equal(
    Object.keys(listener).some((key) => key.startsWith("NEXT_PUBLIC_VIPTEL_PROVIDER_SNAPSHOT_")),
    false,
  );
  const healthchecksLine = workerContents
    .split("\n")
    .find((line) => line.startsWith("HEALTHCHECKS_JOB_URLS_JSON="));
  assert.ok(healthchecksLine);
  assert.equal(
    JSON.parse(healthchecksLine.slice(healthchecksLine.indexOf("=") + 1)),
    JSON.stringify(jobMap),
  );
});

function writeRuntimeContractFixture(root, {
  flag,
  token,
  bridgeFlag,
  bridgeToken,
  listenerOverrides = {},
} = {}) {
  const targetRef = "sjcsrygkkmersoczpunh";
  const version = "hetzner-live-gate-test";
  const appDomain = "dispecing.linkapomoci.sk";
  const gate = {};
  if (flag !== undefined) gate.VIPTEL_LIVE_MUTATIONS_ENABLED = flag;
  if (token !== undefined) gate.VIPTEL_LIVE_MUTATION_TOKEN = token;
  if (bridgeFlag !== undefined) gate.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED = bridgeFlag;
  if (bridgeToken !== undefined) gate.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN = bridgeToken;
  const common = {
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
    APP_BASE_URL: `https://${appDomain}`,
    PUBLIC_APP_URL: `https://${appDomain}`,
    NEXT_PUBLIC_APP_URL: `https://${appDomain}`,
    ...gate,
  };
  const files = {
    "web.env": common,
    "worker.env": {
      ...common,
      SCHEDULER_ENABLED: "false",
      WORKER_INSTANCE_ID: "motorist-prod-01",
    },
    "viptel-listener.env": {
      ...common,
      VIPTEL_LISTENER_ENABLED: "false",
      VIPTEL_LISTENER_INSTANCE_ID: "motorist-prod-01-viptel",
      VIPTEL_DISPATCH_PERSONAL_EXTENSIONS: "20,21,22,23",
      ...listenerOverrides,
    },
    "caddy.env": {
      APP_DOMAIN: appDomain,
      ACME_EMAIL: "info@example.test",
    },
  };

  for (const [filename, env] of Object.entries(files)) {
    writeFileSync(join(root, filename), serializeRuntimeEnv(env), { mode: 0o600 });
  }

  return {
    envDir: root,
    version,
    sourceRef: "jcwbiulwuwyrnmzjjbgr",
    targetRef,
    appDomain,
  };
}

test("runtime contract keeps live mutation authority fail-closed and server-only", async (t) => {
  const makeCase = (options) => {
    const root = mkdtempSync(join(tmpdir(), "motorist-live-gate-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return writeRuntimeContractFixture(root, options);
  };

  await assert.doesNotReject(() => validateRuntimeEnvContract(makeCase({ flag: "false" })));
  await assert.doesNotReject(() => validateRuntimeEnvContract(makeCase({
    flag: "true",
    token: "a".repeat(32),
  })));
  await assert.rejects(
    () => validateRuntimeEnvContract(makeCase({ flag: "true", token: "a".repeat(31) })),
    /VIPTel live mutation authority is missing or too short/,
  );
  await assert.rejects(
    () => validateRuntimeEnvContract(makeCase({ flag: "enabled", token: "a".repeat(32) })),
    /VIPTel live mutation flag must be true, false, or absent/,
  );
  await assert.rejects(
    () => validateRuntimeEnvContract(makeCase({
      flag: "true",
      token: "a".repeat(32),
      listenerOverrides: { NEXT_PUBLIC_VIPTEL_LIVE_MUTATION_TOKEN: "forbidden" },
    })),
    /VIPTel live mutation authority must remain server-only/,
  );
  await assert.rejects(
    () => validateRuntimeEnvContract(makeCase({
      flag: "true",
      token: "a".repeat(32),
      listenerOverrides: { VIPTEL_LIVE_MUTATION_TOKEN: "c".repeat(32) },
    })),
    /web\/listener VIPTel live-mutation authority mismatch/,
  );
});

test("runtime contract keeps provider snapshot bridge independent and server-only", async (t) => {
  const makeCase = (options) => {
    const root = mkdtempSync(join(tmpdir(), "motorist-snapshot-bridge-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return writeRuntimeContractFixture(root, options);
  };

  await assert.doesNotReject(() => validateRuntimeEnvContract(makeCase({
    flag: "false",
    bridgeFlag: "true",
    bridgeToken: "b".repeat(32),
  })));
  await assert.rejects(
    () => validateRuntimeEnvContract(makeCase({
      bridgeFlag: "true",
      bridgeToken: "b".repeat(31),
    })),
    /provider snapshot bridge authority is missing or too short/,
  );
  await assert.rejects(
    () => validateRuntimeEnvContract(makeCase({
      bridgeFlag: "true",
      bridgeToken: "b".repeat(32),
      listenerOverrides: { NEXT_PUBLIC_VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN: "forbidden" },
    })),
    /provider snapshot bridge authority must remain server-only/,
  );
  await assert.rejects(
    () => validateRuntimeEnvContract(makeCase({
      listenerOverrides: { VIPTEL_DISPATCH_PERSONAL_EXTENSIONS: "20,21,22" },
    })),
    /personal extension allowlist must be exactly 20,21,22,23/,
  );
  await assert.rejects(
    () => validateRuntimeEnvContract(makeCase({
      bridgeFlag: "true",
      bridgeToken: "b".repeat(32),
      listenerOverrides: { VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN: "c".repeat(32) },
    })),
    /web\/listener VIPTel provider snapshot bridge authority mismatch/,
  );
  await assert.rejects(
    () => validateRuntimeEnvContract(makeCase({
      flag: "true",
      token: "a".repeat(32),
      bridgeFlag: "true",
      bridgeToken: "a".repeat(32),
    })),
    /live-mutation and provider snapshot authorities must differ/,
  );
});

test("runtime parser rejects values outside the canonical deploy contract", () => {
  for (const invalid of [
    "A=plain\n",
    "A='quoted'\n",
    "A=1\n",
    "A=null\n",
    "A=[]\n",
    "A={}\n",
    "A=\"unterminated\n",
    "A=\"value\"",
    "A=\"one\"\nA=\"two\"\n",
    "INVALID-KEY=\"value\"\n",
    "A=\"value\\u0000\"\n",
  ]) {
    assert.throws(() => parseRuntimeEnv(invalid));
  }
});

test("shared runtime serializer round-trips nested JSON without dotenv ambiguity", () => {
  const nested = JSON.stringify({ "notifications.materialize": "https://example.test/ping" });
  const serialized = serializeRuntimeEnv({ HEALTHCHECKS_JOB_URLS_JSON: nested });
  assert.equal(parseRuntimeEnv(serialized).HEALTHCHECKS_JOB_URLS_JSON, nested);
  assert.equal(JSON.parse(serialized.slice(serialized.indexOf("=") + 1)), nested);
  assert.throws(() => serializeRuntimeEnv({ "INVALID-KEY": "value" }));
});

test("application image smoke writer emits a strict runtime secret", () => {
  const serialized = serializeApplicationRuntimeEnv({
    SUPABASE_URL: "https://target.example",
    HEALTHCHECKS_JOB_URLS_JSON: JSON.stringify({ job: "https://example.test/ping" }),
  });
  const parsed = parseRuntimeEnv(serialized);
  assert.equal(parsed.SUPABASE_URL, "https://target.example");
  assert.deepEqual(JSON.parse(parsed.HEALTHCHECKS_JOB_URLS_JSON), {
    job: "https://example.test/ping",
  });
  assert.throws(() => serializeApplicationRuntimeEnv({ UNSAFE: "line one\nline two" }));
});
