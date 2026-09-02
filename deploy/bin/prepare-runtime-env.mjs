#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { parseRuntimeEnv, serializeRuntimeEnv } from "../runtime-env-parser.mjs";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: ".context/secrets/vercel-production.env" },
    overrides: { type: "string", default: ".context/secrets/runtime-overrides.env" },
    integrations: { type: "string", default: ".context/secrets/integration-runtime.env" },
    out: { type: "string", default: "deploy/env" },
    version: { type: "string" },
    origin: { type: "string", default: "https://dispecing.linkapomoci.sk" },
    domain: { type: "string", default: "dispecing.linkapomoci.sk" },
  },
});

if (!values.version?.trim()) throw new Error("--version is required.");

async function loadOptional(path, parser = parseEnv) {
  try {
    return parser(await readFile(resolve(path), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

const base = await loadOptional(values.base);
const integrations = await loadOptional(values.integrations, parseRuntimeEnv);
const overrides = await loadOptional(values.overrides);
const nonEmpty = (env) => Object.fromEntries(Object.entries(env).filter(([, value]) => value?.length > 0));
const merged = { ...base, ...nonEmpty(integrations), ...nonEmpty(overrides) };

merged.SUPABASE_URL ||= merged.NEXT_PUBLIC_SUPABASE_URL;
merged.SUPABASE_PUBLISHABLE_KEY ||=
  merged.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || merged.SUPABASE_ANON_KEY || merged.NEXT_PUBLIC_SUPABASE_ANON_KEY;
merged.SUPABASE_SECRET_KEY ||= merged.SUPABASE_SERVICE_ROLE_KEY;

const required = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
];
const missing = required.filter((key) => !merged[key]?.trim());
if (missing.length) {
  console.error(`Missing runtime values: ${missing.join(", ")}`);
  console.error(`Add them to ${values.overrides} with mode 0600; no secret values were printed.`);
  process.exit(2);
}

const excludedPrefixes = ["POSTGRES_", "TURBO_", "VERCEL_"];
const excludedExact = new Set(["HCLOUD_TOKEN", "NX_DAEMON", "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY", "VERCEL"]);
const shared = Object.fromEntries(
  Object.entries(merged).filter(
    ([key, value]) =>
      value?.length > 0 && !excludedExact.has(key) && !excludedPrefixes.some((prefix) => key.startsWith(prefix)),
  ),
);

const common = {
  ...shared,
  NODE_ENV: "production",
  DEPLOYMENT_VERSION: values.version.trim(),
  APP_BASE_URL: values.origin,
  PUBLIC_APP_URL: values.origin,
  NEXT_PUBLIC_APP_URL: values.origin,
  MOTORIST_DEV_AUTH_BYPASS: "false",
};

const web = Object.fromEntries(
  Object.entries(common).filter(([key]) => !["HCLOUD_READ_TOKEN", "HEALTHCHECKS_PING_URL", "SCHEDULER_ENABLED"].includes(key)),
);
const worker = {
  ...common,
  WORKER_INSTANCE_ID: "motorist-prod-01",
  SCHEDULER_ENABLED: "false",
  ALERT_EMAIL_TO: merged.ALERT_EMAIL_TO || "info@alfopure.tech",
  HCLOUD_READ_TOKEN: merged.HCLOUD_READ_TOKEN || "",
  HEALTHCHECKS_PING_URL: merged.HEALTHCHECKS_PING_URL || "",
};
const listenerSharedKeys = new Set([
  "SUPABASE_PROJECT_REF",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_APP_URL",
  "MOTORIST_ORGANIZATION_ID",
  "MOTORIST_ORGANIZATION_SLUG",
  "VIPTEL_USERNAME",
  "VIPTEL_PASSWORD",
  "VIPTEL_REST_BASE_URL",
  "VIPTEL_WEBSOCKET_URL",
  "VIPTEL_REQUEST_TIMEOUT_MS",
  "VIPTEL_DEFAULT_EXTENSION",
  "VIPTEL_CALLER_ID",
  "VIPTEL_LIVE_MUTATIONS_ENABLED",
  "VIPTEL_LIVE_MUTATION_TOKEN",
  "VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED",
  "VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN",
  "VIPTEL_DISPATCH_PERSONAL_EXTENSIONS",
]);
const listener = {
  ...Object.fromEntries(Object.entries(common).filter(([key]) => listenerSharedKeys.has(key))),
  NODE_ENV: "production",
  DEPLOYMENT_VERSION: values.version.trim(),
  APP_BASE_URL: values.origin,
  PUBLIC_APP_URL: values.origin,
  MOTORIST_DEV_AUTH_BYPASS: "false",
  VIPTEL_LISTENER_INSTANCE_ID: "motorist-prod-01-viptel",
  VIPTEL_LISTENER_ENABLED: "false",
  VIPTEL_RECONCILE_ON_CONNECT: "true",
  VIPTEL_HEALTHCHECKS_PING_URL: merged.VIPTEL_HEALTHCHECKS_PING_URL || "",
  VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED:
    merged.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED || "false",
  VIPTEL_DISPATCH_PERSONAL_EXTENSIONS:
    merged.VIPTEL_DISPATCH_PERSONAL_EXTENSIONS || "20,21,22,23",
};
const caddy = {
  APP_DOMAIN: values.domain,
  ACME_EMAIL: merged.ACME_EMAIL || "info@alfopure.tech",
};

async function atomicSecretWrite(path, contents) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, target);
}

await Promise.all([
  atomicSecretWrite(`${values.out}/web.env`, serializeRuntimeEnv(web)),
  atomicSecretWrite(`${values.out}/worker.env`, serializeRuntimeEnv(worker)),
  atomicSecretWrite(`${values.out}/viptel-listener.env`, serializeRuntimeEnv(listener)),
  atomicSecretWrite(`${values.out}/caddy.env`, serializeRuntimeEnv(caddy)),
]);

console.log(
  JSON.stringify({
    ok: true,
    output: values.out,
    files: ["web.env", "worker.env", "viptel-listener.env", "caddy.env"],
    schedulerEnabled: false,
    viptelListenerEnabled: false,
  }),
);
