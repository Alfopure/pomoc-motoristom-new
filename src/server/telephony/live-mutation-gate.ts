import "server-only";

import { MutationError } from "@/server/motorist-mutations";

const ENABLED_VALUE = "true";
const MIN_AUTHORITY_TOKEN_LENGTH = 32;

export type TelephonyLiveMutationGateStatus = {
  enabled: boolean;
  reason: "enabled" | "preview_blocked" | "flag_disabled" | "authority_missing";
};

export type TelephonyGateEnvironment = Readonly<Record<string, string | undefined>>;

export type WorkplaceAdminTakeoverGateStatus = {
  enabled: boolean;
  reason: TelephonyLiveMutationGateStatus["reason"] | "takeover_flag_disabled";
};

/**
 * Production-affecting telephony writes are deliberately disabled by default.
 * Preview deployments always stay read-only because they share production data.
 * The authority token is deployment configuration only; it is never accepted
 * from a request and must never be returned to the browser or written to logs.
 */
export function telephonyLiveMutationGateStatus(
  env: TelephonyGateEnvironment = process.env,
): TelephonyLiveMutationGateStatus {
  if (env.VERCEL_ENV?.trim().toLowerCase() === "preview") {
    return { enabled: false, reason: "preview_blocked" };
  }

  if (env.VIPTEL_LIVE_MUTATIONS_ENABLED?.trim().toLowerCase() !== ENABLED_VALUE) {
    return { enabled: false, reason: "flag_disabled" };
  }

  if ((env.VIPTEL_LIVE_MUTATION_TOKEN?.trim().length ?? 0) < MIN_AUTHORITY_TOKEN_LENGTH) {
    return { enabled: false, reason: "authority_missing" };
  }

  return { enabled: true, reason: "enabled" };
}

export function assertTelephonyLiveMutationEnabled(
  operation: string,
  env: TelephonyGateEnvironment = process.env,
) {
  const status = telephonyLiveMutationGateStatus(env);
  if (status.enabled) return;

  const detail = status.reason === "preview_blocked"
    ? "Preview používa produkčné dáta a telekomunikačné zásahy sú v ňom vždy zakázané."
    : "Telekomunikačné zásahy nie sú pre toto prostredie výslovne povolené.";
  throw new MutationError(`${detail} Operácia ${safeOperationLabel(operation)} nebola vykonaná.`, 503);
}

/**
 * Administrative shared-workplace handoff is intentionally protected by a
 * second, independent switch. This keeps the broader telephony mutation gate
 * from enabling a new destructive workflow before its rollout preflight has
 * verified the lifecycle of extensions 20–23.
 */
export function workplaceAdminTakeoverGateStatus(
  env: TelephonyGateEnvironment = process.env,
): WorkplaceAdminTakeoverGateStatus {
  const live = telephonyLiveMutationGateStatus(env);
  if (!live.enabled) return live;
  if (env.VIPTEL_WORKPLACE_ADMIN_TAKEOVER_ENABLED?.trim().toLowerCase() !== ENABLED_VALUE) {
    return { enabled: false, reason: "takeover_flag_disabled" };
  }
  return { enabled: true, reason: "enabled" };
}

export function assertWorkplaceAdminTakeoverEnabled(
  operation: string,
  env: TelephonyGateEnvironment = process.env,
) {
  const status = workplaceAdminTakeoverGateStatus(env);
  if (status.enabled) return;
  if (status.reason !== "takeover_flag_disabled") {
    assertTelephonyLiveMutationEnabled(operation, env);
  }
  throw new MutationError(
    `Bezpečné prevzatie pracoviska zatiaľ nie je v tomto prostredí povolené. Operácia ${safeOperationLabel(operation)} nebola vykonaná.`,
    503,
  );
}

function safeOperationLabel(value: string) {
  const normalized = value.trim().replace(/[^a-z0-9._-]/gi, "").slice(0, 80);
  return normalized || "telephony.mutation";
}
