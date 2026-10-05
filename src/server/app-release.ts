import "server-only";
import { resolveAppEnvironment } from "@/lib/app-environment";
import type { AppRelease } from "@/lib/app-release";
import { getAppVersion } from "./app-version";

/** Build-time values use literal property accesses for Next.js env substitution. */
export function getAppRelease(env: Record<string, string | undefined> = process.env): AppRelease {
  return {
    environment: resolveAppEnvironment(env),
    code: process.env.NEXT_PUBLIC_APP_RELEASE_CODE || null,
    builtAt: process.env.NEXT_PUBLIC_APP_BUILT_AT || null,
    commit: env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
    deployment: getAppVersion(env),
  };
}
