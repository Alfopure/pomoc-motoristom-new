import type { MobileVoiceTuning } from "../../../src/lib/mobile-api";

/** The build's own switches: today's behaviour. The server may only turn them on. */
export const VOICE_TUNING_OFF: MobileVoiceTuning = { mobileTokenCache: false, mobileRtcRegion: "auto", mobileTrickleIce: false,
  mobileRealtimeStatus: false, mobileEarlyAccept: false, mobileParallelOffers: false };

/** Key by key: a missing or malformed switch stays off, an unknown key is ignored. */
export function parseVoiceTuning(value: unknown): MobileVoiceTuning {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const on = (key: keyof MobileVoiceTuning) => body[key] === true;
  return { mobileTokenCache: on("mobileTokenCache"), mobileRtcRegion: body.mobileRtcRegion === "eu" ? "eu" : "auto", mobileTrickleIce: on("mobileTrickleIce"),
    mobileRealtimeStatus: on("mobileRealtimeStatus"), mobileEarlyAccept: on("mobileEarlyAccept"), mobileParallelOffers: on("mobileParallelOffers") };
}

/** The private telephony signal of one organisation; anything else is ignored. */
export function realtimeTopic(value: unknown): string | null {
  return typeof value === "string" && /^org:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}:telephony$/i.test(value) ? value : null;
}

/** A provider JWT kept in this iPhone's Keychain (S8.1), with what binds it to its lease. */
export type CachedVoiceToken = { v: 1; token: string; expiresAt: string; issuedAt: number; deviceSessionId: string; profileId: string; appBuild: string | null };
/** A cached JWT is used only this long after issue, and never this close to its expiry. */
export const CACHED_TOKEN_MAX_AGE_MS = 12 * 60 * 60_000, CACHED_TOKEN_MIN_LEFT_MS = 15 * 60_000;
const SKEW_MS = 5 * 60_000;

/** The cached JWT, or why it may not be used. Every refusal is final: the caller wipes the entry. */
export function usableCachedToken(raw: string | null, expected: { profileId: string; deviceSessionId: string | null; appBuild: string | null; now: number }):
  { token: CachedVoiceToken } | { reason: "none" | "malformed" | "profile" | "lease" | "build" | "expiring" | "age" } {
  if (raw === null) return { reason: "none" };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { reason: "malformed" }; }
  const entry = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const expiresAt = typeof entry.expiresAt === "string" ? Date.parse(entry.expiresAt) : NaN;
  if (entry.v !== 1 || typeof entry.token !== "string" || !entry.token || !Number.isFinite(expiresAt) || !Number.isSafeInteger(entry.issuedAt)
    || typeof entry.deviceSessionId !== "string" || typeof entry.profileId !== "string" || !(entry.appBuild === null || typeof entry.appBuild === "string")) return { reason: "malformed" };
  if (entry.profileId !== expected.profileId) return { reason: "profile" };
  if (entry.deviceSessionId !== expected.deviceSessionId) return { reason: "lease" };
  if (entry.appBuild !== expected.appBuild) return { reason: "build" };
  if (expiresAt - expected.now < CACHED_TOKEN_MIN_LEFT_MS) return { reason: "expiring" };
  const issuedAt = entry.issuedAt as number;
  if (expected.now - issuedAt > CACHED_TOKEN_MAX_AGE_MS || issuedAt - expected.now > SKEW_MS) return { reason: "age" };
  return { token: entry as CachedVoiceToken };
}
