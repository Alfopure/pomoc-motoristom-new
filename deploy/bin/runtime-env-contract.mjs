#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parseRuntimeEnv } from "../runtime-env-parser.mjs";

const MIN_LIVE_MUTATION_TOKEN_LENGTH = 32;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadStrictEnv(path) {
  const [contents, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  invariant((metadata.mode & 0o077) === 0, `${path} must have mode 0600 or stricter`);

  return {
    env: parseRuntimeEnv(contents),
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function validateShared(env, contract) {
  const targetUrl = `https://${contract.targetRef}.supabase.co`;
  invariant(env.SUPABASE_PROJECT_REF === contract.targetRef, "runtime project ref mismatch");
  invariant(env.NEXT_PUBLIC_SUPABASE_URL === targetUrl, "public Supabase URL mismatch");
  invariant(env.SUPABASE_URL === targetUrl, "server Supabase URL mismatch");
  invariant(env.DEPLOYMENT_VERSION === contract.version, "runtime release version mismatch");
  invariant(env.NODE_ENV === "production", "NODE_ENV must be production");
  invariant(env.MOTORIST_DEV_AUTH_BYPASS === "false", "development auth bypass must be disabled");
  invariant(env.APP_BASE_URL === `https://${contract.appDomain}`, "APP_BASE_URL mismatch");
  invariant(env.PUBLIC_APP_URL === `https://${contract.appDomain}`, "PUBLIC_APP_URL mismatch");
  invariant(env.NEXT_PUBLIC_APP_URL === `https://${contract.appDomain}`, "NEXT_PUBLIC_APP_URL mismatch");
  invariant(!Object.hasOwn(env, "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY"), "runtime Server Actions key is forbidden");
  invariant(!Object.hasOwn(env, "SUPABASE_JWT_SECRET"), "legacy JWT secret is forbidden");
  invariant(!Object.hasOwn(env, "VERCEL"), "VERCEL marker is forbidden on Hetzner");

  const publicAliases = [
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
  ];
  const serverAliases = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
  invariant(publicAliases.every((key) => env[key]?.length > 0), "public key alias is missing");
  invariant(serverAliases.every((key) => env[key]?.length > 0), "server key alias is missing");
  invariant(new Set(publicAliases.map((key) => env[key])).size === 1, "public key aliases differ");
  invariant(new Set(serverAliases.map((key) => env[key])).size === 1, "server key aliases differ");
  invariant(env[publicAliases[0]] !== env[serverAliases[0]], "public and server keys must differ");
  invariant(
    Object.values(env).every((value) => !String(value).includes(contract.sourceRef)),
    "source project ref is present in runtime env",
  );
}

function validateLiveMutationGate(env, runtimeName) {
  const enabled = env.VIPTEL_LIVE_MUTATIONS_ENABLED;
  invariant(
    enabled === undefined || enabled === "false" || enabled === "true",
    `${runtimeName} VIPTel live mutation flag must be true, false, or absent`,
  );
  invariant(
    !Object.keys(env).some((key) => key.startsWith("NEXT_PUBLIC_VIPTEL_LIVE_")),
    `${runtimeName} VIPTel live mutation authority must remain server-only`,
  );

  if (enabled === "true") {
    invariant(
      (env.VIPTEL_LIVE_MUTATION_TOKEN?.trim().length ?? 0) >= MIN_LIVE_MUTATION_TOKEN_LENGTH,
      `${runtimeName} VIPTel live mutation authority is missing or too short`,
    );
  }
}

function validateProviderSnapshotBridge(env, runtimeName) {
  const enabled = env.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED;
  invariant(
    enabled === undefined || enabled === "false" || enabled === "true",
    `${runtimeName} VIPTel provider snapshot bridge flag must be true, false, or absent`,
  );
  invariant(
    !Object.keys(env).some((key) => key.startsWith("NEXT_PUBLIC_VIPTEL_PROVIDER_SNAPSHOT_")),
    `${runtimeName} VIPTel provider snapshot bridge authority must remain server-only`,
  );
  if (enabled === "true") {
    invariant(
      (env.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN?.trim().length ?? 0)
        >= MIN_LIVE_MUTATION_TOKEN_LENGTH,
      `${runtimeName} VIPTel provider snapshot bridge authority is missing or too short`,
    );
  }
}

function validateCrossRuntimeViptelAuthorities(web, listener) {
  invariant(
    web.VIPTEL_LIVE_MUTATION_TOKEN === listener.VIPTEL_LIVE_MUTATION_TOKEN,
    "web/listener VIPTel live-mutation authority mismatch",
  );
  invariant(
    web.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN === listener.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN,
    "web/listener VIPTel provider snapshot bridge authority mismatch",
  );
  if (web.VIPTEL_LIVE_MUTATION_TOKEN && web.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN) {
    invariant(
      web.VIPTEL_LIVE_MUTATION_TOKEN !== web.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN,
      "VIPTel live-mutation and provider snapshot authorities must differ",
    );
  }
}

export async function validateRuntimeEnvContract({
  envDir,
  version,
  sourceRef,
  targetRef,
  appDomain,
}) {
  const contract = { version, sourceRef, targetRef, appDomain };
  const paths = {
    web: resolve(envDir, "web.env"),
    worker: resolve(envDir, "worker.env"),
    listener: resolve(envDir, "viptel-listener.env"),
    caddy: resolve(envDir, "caddy.env"),
  };
  const [web, worker, listener, caddy] = await Promise.all([
    loadStrictEnv(paths.web),
    loadStrictEnv(paths.worker),
    loadStrictEnv(paths.listener),
    loadStrictEnv(paths.caddy),
  ]);

  validateShared(web.env, contract);
  validateShared(worker.env, contract);
  validateShared(listener.env, contract);
  validateLiveMutationGate(web.env, "web");
  validateLiveMutationGate(worker.env, "worker");
  validateLiveMutationGate(listener.env, "listener");
  validateProviderSnapshotBridge(web.env, "web");
  validateProviderSnapshotBridge(worker.env, "worker");
  validateProviderSnapshotBridge(listener.env, "listener");
  validateCrossRuntimeViptelAuthorities(web.env, listener.env);
  invariant(!Object.hasOwn(web.env, "SCHEDULER_ENABLED"), "web env must not contain scheduler state");
  invariant(worker.env.SCHEDULER_ENABLED === "false", "worker scheduler must be disabled");
  invariant(worker.env.WORKER_INSTANCE_ID === "motorist-prod-01", "worker instance identity mismatch");
  invariant(listener.env.VIPTEL_LISTENER_ENABLED === "false", "VIPTel listener must start disabled");
  invariant(listener.env.VIPTEL_LISTENER_INSTANCE_ID === "motorist-prod-01-viptel", "VIPTel listener identity mismatch");
  invariant(
    listener.env.VIPTEL_DISPATCH_PERSONAL_EXTENSIONS === "20,21,22,23",
    "VIPTel personal extension allowlist must be exactly 20,21,22,23",
  );
  invariant(caddy.env.APP_DOMAIN === appDomain, "Caddy domain mismatch");
  invariant(caddy.env.ACME_EMAIL?.length > 0, "Caddy ACME email is missing");
  invariant(
    Object.values(caddy.env).every((value) => !String(value).includes(sourceRef)),
    "source project ref is present in Caddy env",
  );

  return {
    paths,
    env: { web: web.env, worker: worker.env, listener: listener.env, caddy: caddy.env },
    sha256: { web: web.sha256, worker: worker.sha256, listener: listener.sha256, caddy: caddy.sha256 },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "env-dir": { type: "string" },
      version: { type: "string" },
      "source-ref": { type: "string" },
      "target-ref": { type: "string" },
      "app-domain": { type: "string" },
    },
  });
  for (const key of ["env-dir", "version", "source-ref", "target-ref", "app-domain"]) {
    invariant(values[key]?.length > 0, `--${key} is required`);
  }
  await validateRuntimeEnvContract({
    envDir: values["env-dir"],
    version: values.version,
    sourceRef: values["source-ref"],
    targetRef: values["target-ref"],
    appDomain: values["app-domain"],
  });
  console.log(JSON.stringify({ ok: true, schedulerEnabled: false }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Runtime env contract failed: ${error.message}`);
    process.exit(1);
  });
}
