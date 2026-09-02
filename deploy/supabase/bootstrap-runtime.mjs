#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const PROJECT_REF = "jcwbiulwuwyrnmzjjbgr";
const MIGRATION_VERSION = "20260714124204";
const MIGRATION_NAME = "worker_job_runtime";
const API_KEY_NAME = "hetzner-production";
const BASE_ENV_PATH = resolve(".context/secrets/vercel-production.env");
const OVERRIDES_PATH = resolve(".context/secrets/runtime-overrides.env");
const MIGRATION_PATH = resolve(`supabase/migrations/${MIGRATION_VERSION}_${MIGRATION_NAME}.sql`);

const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim();
if (!accessToken) throw new Error("SUPABASE_ACCESS_TOKEN is missing.");

async function management(path, init = {}) {
  const response = await fetch(`https://api.supabase.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Supabase Management API ${response.status}: ${body?.message ?? body?.error ?? "request failed"}`);
  }
  return body;
}

async function query(sql, readOnly = false) {
  return management(`/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query: sql, read_only: readOnly }),
  });
}

async function loadOptional(path) {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function serialize(env) {
  return `${Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join("\n")}\n`;
}

await management(`/projects/${PROJECT_REF}`);

const migration = await readFile(MIGRATION_PATH, "utf8");
await query(`begin;\n${migration}\nrollback;`);

const alreadyApplied = await query(
  `select to_regclass('public.motorist_job_runs') is not null as applied;`,
  true,
);

const isApplied = alreadyApplied?.[0]?.applied === true;
if (!isApplied) {
  await query(`begin;\n${migration}\ncommit;`);
}

const validation = await query(
  `select
    to_regclass('public.motorist_job_controls') is not null as controls,
    to_regclass('public.motorist_job_runs') is not null as runs,
    to_regclass('public.motorist_worker_status') is not null as worker_status,
    to_regclass('public.motorist_job_incidents') is not null as incidents,
    (select count(*) from public.motorist_job_controls where enabled) as enabled_jobs,
    has_table_privilege('anon', 'public.motorist_job_runs', 'select') as anon_can_select,
    has_table_privilege('authenticated', 'public.motorist_job_runs', 'select') as authenticated_can_select;`,
  true,
);
const verified = validation?.[0];
if (
  !verified?.controls ||
  !verified?.runs ||
  !verified?.worker_status ||
  !verified?.incidents ||
  Number(verified?.enabled_jobs) !== 0 ||
  verified?.anon_can_select !== false ||
  verified?.authenticated_can_select !== false
) {
  throw new Error("Worker migration verification failed.");
}

let keys = await management(`/projects/${PROJECT_REF}/api-keys?reveal=true`);
let runtimeKey = keys.find((key) => key.type === "secret" && key.name === API_KEY_NAME)?.api_key;
let createdRuntimeKey = false;
if (!runtimeKey) {
  const created = await management(`/projects/${PROJECT_REF}/api-keys?reveal=true`, {
    method: "POST",
    body: JSON.stringify({
      type: "secret",
      name: API_KEY_NAME,
      description: "Dedicated service-role key for the Hetzner production runtime.",
      secret_jwt_template: { role: "service_role" },
    }),
  });
  runtimeKey = created.api_key;
  createdRuntimeKey = true;
}
keys = null;

if (!runtimeKey?.startsWith("sb_secret_")) {
  throw new Error("Supabase did not return the dedicated secret runtime key.");
}

const base = parseEnv(await readFile(BASE_ENV_PATH, "utf8"));
const projectUrl = base.SUPABASE_URL || base.NEXT_PUBLIC_SUPABASE_URL;
if (!projectUrl || new URL(projectUrl).hostname.split(".")[0] !== PROJECT_REF) {
  throw new Error("Vercel production environment points to a different Supabase project.");
}

const apiProbe = await fetch(`${projectUrl}/rest/v1/motorist_job_controls?select=job_name&limit=1`, {
  headers: { apikey: runtimeKey, Authorization: `Bearer ${runtimeKey}` },
  signal: AbortSignal.timeout(10_000),
});
if (!apiProbe.ok) throw new Error(`Dedicated Supabase runtime key probe failed with HTTP ${apiProbe.status}.`);

const overrides = await loadOptional(OVERRIDES_PATH);
const nextEncryptionKey = overrides.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY || randomBytes(32).toString("base64");
const updatedOverrides = {
  ...overrides,
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: nextEncryptionKey,
  SUPABASE_SECRET_KEY: runtimeKey,
};
const temporary = `${OVERRIDES_PATH}.tmp-${process.pid}`;
await writeFile(temporary, serialize(updatedOverrides), { mode: 0o600 });
await rename(temporary, OVERRIDES_PATH);
await chmod(OVERRIDES_PATH, 0o600);

runtimeKey = null;
console.log(
  JSON.stringify({
    ok: true,
    projectRef: PROJECT_REF,
    migrationAppliedNow: !isApplied,
    migrationVerified: true,
    enabledJobs: 0,
    dedicatedRuntimeKeyCreated: createdRuntimeKey,
    overridesFileMode: "0600",
  }),
);
