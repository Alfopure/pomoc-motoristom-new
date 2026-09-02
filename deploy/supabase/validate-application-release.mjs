#!/usr/bin/env node

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { clientAssetScanMatchesTarget } from "../bin/client-asset-scan-status.mjs";
import { validateRuntimeEnvContract } from "../bin/runtime-env-contract.mjs";
import { serializeRuntimeEnv } from "../runtime-env-parser.mjs";

const EXPECTED_SOURCE_REF = "jcwbiulwuwyrnmzjjbgr";
const EXPECTED_TARGET_REF = "sjcsrygkkmersoczpunh";
const EXPECTED_APP_DOMAIN = "dispecing.linkapomoci.sk";
const SNAPSHOT_PATTERN = /^[0-9]{8}T[0-9]{6}Z$/;
const RELEASE_PATTERN = /^hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function serializeApplicationRuntimeEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    invariant(!/[\r\n\0]/.test(value), `runtime value ${key} cannot be represented safely`);
  }
  return serializeRuntimeEnv(env);
}

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${args[0]} failed with status ${result.status ?? "unknown"}`);
  }
  return result;
}

export async function fetchStatus(
  url,
  options = {},
  {
    fetchImpl = fetch,
    maximumAttempts = 5,
    retryDelayMs = 250,
    timeoutMs = 10_000,
    sleep = (delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)),
  } = {},
) {
  invariant(Number.isInteger(maximumAttempts) && maximumAttempts > 0, "maximumAttempts must be a positive integer");
  invariant(Number.isInteger(retryDelayMs) && retryDelayMs >= 0, "retryDelayMs must be a non-negative integer");
  invariant(Number.isInteger(timeoutMs) && timeoutMs > 0, "timeoutMs must be a positive integer");

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await fetchImpl(url, {
        ...options,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt === maximumAttempts) throw error;
      await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
  }

  throw new Error("unreachable fetch retry state");
}

export async function waitForConsecutiveReadiness(
  baseUrl,
  releaseVersion,
  {
    fetchStatusImpl = fetchStatus,
    now = () => performance.now(),
    sleep = (delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)),
    requiredConsecutivePasses = 5,
    maximumObservations = 30,
    windowMs = 90_000,
    pollIntervalMs = 2_000,
  } = {},
) {
  invariant(
    Number.isInteger(requiredConsecutivePasses) && requiredConsecutivePasses > 0,
    "requiredConsecutivePasses must be a positive integer",
  );
  invariant(
    Number.isInteger(maximumObservations) && maximumObservations >= requiredConsecutivePasses,
    "maximumObservations must cover the required consecutive passes",
  );
  invariant(Number.isInteger(windowMs) && windowMs > 0, "windowMs must be a positive integer");
  invariant(Number.isInteger(pollIntervalMs) && pollIntervalMs >= 0, "pollIntervalMs must be non-negative");

  const deadline = now() + windowMs;
  let consecutivePasses = 0;
  for (let observation = 0; observation < maximumObservations; observation += 1) {
    const remainingMs = Math.floor(deadline - now());
    if (remainingMs <= 0) break;

    let response;
    try {
      response = await fetchStatusImpl(`${baseUrl}/api/health/ready`, {}, {
        maximumAttempts: 1,
        timeoutMs: Math.max(1, Math.min(5_000, remainingMs)),
      });
    } catch {
      consecutivePasses = 0;
    }

    if (now() >= deadline) break;
    if (response) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        return 0;
      }
      if (now() >= deadline) break;

      const exactReady =
        response.status === 200 && payload?.status === "ready" && payload?.version === releaseVersion;
      const expectedTransientNotReady =
        response.status === 503 && payload?.status === "not_ready" && payload?.version === releaseVersion;
      if (exactReady) consecutivePasses += 1;
      else if (expectedTransientNotReady) consecutivePasses = 0;
      else return 0;
    }

    if (consecutivePasses === requiredConsecutivePasses) return consecutivePasses;
    if (observation + 1 >= maximumObservations) break;
    const delayMs = Math.min(pollIntervalMs, Math.max(0, Math.floor(deadline - now())));
    if (delayMs > 0) await sleep(delayMs);
  }
  return consecutivePasses;
}

async function waitForLive(baseUrl, releaseVersion) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetchStatus(`${baseUrl}/api/health/live`, {}, { maximumAttempts: 1 });
      const payload = await response.json();
      if (response.status === 200 && payload?.status === "live" && payload?.version === releaseVersion) return true;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  return false;
}

async function main() {
  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" },
      release: { type: "string" },
      "env-dir": { type: "string", default: "deploy/env" },
      "release-root": { type: "string", default: "deploy/releases" },
      "report-root": { type: "string", default: ".context/migration/validation" },
    },
  });
  invariant(SNAPSHOT_PATTERN.test(values.snapshot ?? ""), "--snapshot is invalid");
  invariant(RELEASE_PATTERN.test(values.release ?? "") && !values.release.includes(".."), "--release is invalid");

  const releaseDir = resolve(values["release-root"], values.release);
  const envDir = resolve(values["env-dir"]);
  const manifestPath = resolve(releaseDir, "manifest.json");
  const checksumsPath = resolve(releaseDir, "SHA256SUMS");
  const [manifestContents, checksumsContents] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(checksumsPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestContents);
  invariant(manifest.version === values.release, "release manifest version mismatch");
  invariant(manifest.image === `motorist-app:${values.release}`, "release image name mismatch");
  invariant(IMAGE_ID_PATTERN.test(manifest.imageId ?? ""), "release image ID is invalid");
  invariant(SHA256_PATTERN.test(manifest.buildContextSha256 ?? ""), "release build context hash is invalid");
  invariant(SHA256_PATTERN.test(manifest.buildArgsSha256 ?? ""), "release build argument hash is invalid");
  invariant(manifest.platform === "linux/amd64", "release platform mismatch");
  invariant(manifest.schedulerEnabled === false, "release scheduler flag must be false");

  const checksumResult = spawnSync("shasum", ["-a", "256", "-c", "SHA256SUMS"], {
    cwd: releaseDir,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  invariant(checksumResult.status === 0, "release checksum validation failed");

  const runtime = await validateRuntimeEnvContract({
    envDir,
    version: values.release,
    sourceRef: EXPECTED_SOURCE_REF,
    targetRef: EXPECTED_TARGET_REF,
    appDomain: EXPECTED_APP_DOMAIN,
  });

  const localImageId = docker(["image", "inspect", "--format", "{{.Id}}", manifest.image]).stdout.trim();
  invariant(localImageId === manifest.imageId, "local Docker image ID mismatch");

  const containerName = `motorist-release-smoke-${process.pid}`;
  const dockerEnvPath = resolve(envDir, `.web.docker-smoke-${process.pid}.env`);
  const dockerEnvContents = serializeApplicationRuntimeEnv(runtime.env.web);
  await writeFile(dockerEnvPath, dockerEnvContents, { mode: 0o600 });
  let containerStarted = false;
  const cleanup = () => {
    if (containerStarted) docker(["rm", "--force", containerName], { allowFailure: true });
    try {
      unlinkSync(dockerEnvPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  const checks = {
    app_live_http_200: false,
    app_ready_database_http_200: false,
    app_ready_database_consecutive_passes: 0,
    app_root_auth_boundary_http_200: false,
    unauthenticated_job_route_http_401: false,
    supabase_auth_settings_http_200: false,
    supabase_rest_admin_range_http_206: false,
    supabase_storage_admin_http_200: false,
    client_assets_source_ref_absent: false,
    client_assets_target_ref_present: false,
  };

  try {
    const sourceClientAssetScan = docker(
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        manifest.image,
        "-c",
        `grep -r -F -- '${EXPECTED_SOURCE_REF}' /app >/dev/null 2>&1`,
      ],
      { allowFailure: true },
    );
    const targetClientAssetScan = docker(
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        manifest.image,
        "-c",
        `grep -r -F -- '${EXPECTED_TARGET_REF}' /app/.next/static >/dev/null 2>&1`,
      ],
      { allowFailure: true },
    );
    checks.client_assets_source_ref_absent = sourceClientAssetScan.status === 1;
    checks.client_assets_target_ref_present = targetClientAssetScan.status === 0;
    invariant(
      clientAssetScanMatchesTarget(sourceClientAssetScan.status, targetClientAssetScan.status),
      "compiled client assets do not match the target project",
    );

    docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--platform",
      "linux/amd64",
      "--read-only",
      "--tmpfs",
      "/tmp:size=64m,mode=1777",
      "--tmpfs",
      "/app/.next/cache:size=128m,mode=0700,uid=1001,gid=1001",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "SETUID",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      "256",
      "--memory",
      "1g",
      "--cpus",
      "1.25",
      "--mount",
      `type=bind,source=${dockerEnvPath},target=/run/secrets/runtime_env,readonly`,
      "--publish",
      "127.0.0.1::3000",
      manifest.image,
    ]);
    containerStarted = true;
    const portOutput = docker(["port", containerName, "3000/tcp"]).stdout.trim();
    const portMatch = portOutput.match(/127\.0\.0\.1:(\d+)$/m);
    invariant(portMatch, "Docker did not publish a loopback smoke-test port");
    const baseUrl = `http://127.0.0.1:${portMatch[1]}`;

    checks.app_live_http_200 = await waitForLive(baseUrl, values.release);
    invariant(checks.app_live_http_200, "exact release liveness check failed");

    checks.app_ready_database_consecutive_passes = await waitForConsecutiveReadiness(baseUrl, values.release);
    checks.app_ready_database_http_200 = checks.app_ready_database_consecutive_passes === 5;

    checks.app_root_auth_boundary_http_200 = (await fetchStatus(`${baseUrl}/`)).status === 200;
    checks.unauthenticated_job_route_http_401 =
      (await fetchStatus(`${baseUrl}/api/integrations/fleet/webdispecink/sync`)).status === 401;

    const targetUrl = `https://${EXPECTED_TARGET_REF}.supabase.co`;
    const publicKey = runtime.env.web.SUPABASE_PUBLISHABLE_KEY;
    const secretKey = runtime.env.web.SUPABASE_SECRET_KEY;
    checks.supabase_auth_settings_http_200 =
      (await fetchStatus(`${targetUrl}/auth/v1/settings`, { headers: { apikey: publicKey } })).status === 200;
    const restResponse = await fetchStatus(`${targetUrl}/rest/v1/motorist_profiles?select=id`, {
      headers: {
        apikey: secretKey,
        authorization: `Bearer ${secretKey}`,
        range: "0-0",
        prefer: "count=exact",
      },
    });
    checks.supabase_rest_admin_range_http_206 = restResponse.status === 206;
    await restResponse.body?.cancel();
    checks.supabase_storage_admin_http_200 =
      (
        await fetchStatus(`${targetUrl}/storage/v1/bucket`, {
          headers: { apikey: secretKey, authorization: `Bearer ${secretKey}` },
        })
      ).status === 200;
  } finally {
    cleanup();
    containerStarted = false;
  }

  const passed =
    checks.app_live_http_200 &&
    checks.app_ready_database_http_200 &&
    checks.app_ready_database_consecutive_passes === 5 &&
    checks.app_root_auth_boundary_http_200 &&
    checks.unauthenticated_job_route_http_401 &&
    checks.supabase_auth_settings_http_200 &&
    checks.supabase_rest_admin_range_http_206 &&
    checks.supabase_storage_admin_http_200 &&
    checks.client_assets_source_ref_absent &&
    checks.client_assets_target_ref_present;

  const report = {
    snapshot_id: values.snapshot,
    source_project_ref: EXPECTED_SOURCE_REF,
    target_project_ref: EXPECTED_TARGET_REF,
    release_version: values.release,
    image_id: manifest.imageId,
    build_context_sha256: manifest.buildContextSha256,
    build_args_sha256: manifest.buildArgsSha256,
    sha256sums_sha256: createHash("sha256").update(checksumsContents).digest("hex"),
    validated_at_utc: new Date().toISOString(),
    privacy: "Status codes, booleans, and immutable release identity only; no bodies, PII, rows, object names, tokens, passwords, or secret values.",
    application_smoke_status: passed ? "pass" : "fail",
    production_build_with_target_public_config: passed ? "pass" : "fail",
    checks,
    scheduler_enabled: false,
    worker_started: false,
    source_deleted: false,
    cutover_status: passed ? "blocked_pending_operational_gate" : "blocked_failed_application_release_smoke",
  };
  const reportPath = resolve(values["report-root"], `application-${values.snapshot}.json`);
  const temporaryPath = `${reportPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, reportPath);
  invariant(passed, "exact release application smoke failed");
  console.log(JSON.stringify({ ok: true, release: values.release, schedulerEnabled: false }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Application release validation failed: ${error.message}`);
    process.exit(1);
  });
}
