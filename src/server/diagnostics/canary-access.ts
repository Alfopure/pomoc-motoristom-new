import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isTestLiveDeployment } from "@/lib/app-environment";
import { serverSentryConfiguration } from "./server-errors";

export const BROWSER_CANARY_COOKIE = "pm-diagnostic-canary";
export const BROWSER_CANARY_MAX_AGE_SECONDS = 60;

/** Old immutable deployments lose this capability automatically at the deadline. */
export function canaryDeploymentEnabled(): boolean {
  const expiry = process.env.DIAGNOSTICS_TEST_CANARY_EXPIRES_AT;
  const expiresAt = expiry ? Date.parse(expiry) : NaN;
  return process.env.DIAGNOSTICS_TEST_CANARY_ENABLED === "true" && isTestLiveDeployment() &&
    process.env.DIAGNOSTICS_SERVER_ERRORS_ENABLED === "true" && Boolean(serverSentryConfiguration()) &&
    Boolean(expiry && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiry)) &&
    Number.isFinite(expiresAt) && expiresAt > Date.now() && expiresAt <= Date.now() + 86_400_000;
}

function signature(issuedAt: string): string | null {
  const secret = process.env.DIAGNOSTICS_TEST_CANARY_TOKEN;
  if (!secret || secret.length < 32 || secret.length > 256) return null;
  const release = serverSentryConfiguration()?.release;
  if (!release) return null;
  return createHmac("sha256", secret).update(`browser-diagnostic-canary:v1:${release}:${issuedAt}`).digest("hex");
}

export function createBrowserCanaryPermit(): string | null {
  if (!canaryDeploymentEnabled()) return null;
  const issuedAt = String(Date.now());
  const mac = signature(issuedAt);
  return mac ? `${issuedAt}.${mac}` : null;
}

/** This cookie authorizes only the fixed canary page, never an application session. */
export function validCanaryPermit(value: string | undefined): boolean {
  if (!canaryDeploymentEnabled() || !value || value.length > 90) return false;
  const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(value);
  if (!match) return false;
  const age = Date.now() - Number(match[1]);
  if (age < 0 || age >= BROWSER_CANARY_MAX_AGE_SECONDS * 1000) return false;
  const expected = signature(match[1]);
  return Boolean(expected && timingSafeEqual(Buffer.from(match[2], "hex"), Buffer.from(expected, "hex")));
}
