import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import type { MobileVoiceTuning } from "@/lib/mobile-api";
import type { WebCallTuning } from "@/lib/telephony/active-calls-model";
import type { SessionStartMode } from "./state/types";

/**
 * Call-setup latency switches (call-speed plan S0.1).
 *
 * Every optimisation of the call-speed program ships behind one of these, and
 * every default is today's behaviour. Two sources are merged key by key, the
 * database winning: `TELEPHONY_LATENCY_FLAGS` (JSON; changing it needs a fresh
 * deploy) and `motorist_telephony_settings.latency_flags` (jsonb, migration
 * 20261031090000; a change applies within the cache TTL). A deployment running
 * ahead of that migration simply reads env. Unknown keys and wrong types are
 * ignored and logged once per instance, never thrown: a typo in a kill switch
 * must not stop calls.
 *
 * Switches that change call semantics are frozen into `metadata.start_mode`
 * when a session is created (`freezeStartMode`), so flipping one never changes
 * a call that is already in progress.
 */

type AdminClient = SupabaseClient<Database>;
type Logger = (entry: Record<string, unknown>) => void;
type Origin = "web" | "mobile";
type ByOrigin = Record<Origin, boolean>;

const BOOLEAN_KEYS = [
  "internal_lean_path", "bridged_observation_fast", "claim_holding_drain", "fresh_after_write",
  "start_fast_path", "start_test_proof_prefetch", "start_early_response", "own_leg_request_header",
  "internal_auto_bridge", "hold_fast_web", "hold_join_with_hold", "test_conference_self_proof",
] as const;
const CLIENT_BOOLEAN_KEYS = ["webEarlyAccept", "webPrefetchIce", "targetLocalFirst", "mobileTokenCache", "mobileTrickleIce",
  "mobileRealtimeStatus", "mobileEarlyAccept", "mobileParallelOffers"] as const;
const CLIENT_REGION_KEYS = ["webRtcRegion", "mobileRtcRegion"] as const;

export type LatencyFlags = Record<typeof BOOLEAN_KEYS[number], boolean> & {
  /** Scoped by the device that starts the call (`deps.deviceKind` of the start request). */
  concurrent_dial: { outbound: ByOrigin; internal: ByOrigin };
  /** 8–30 s; only for sessions frozen as concurrent. Sequential sessions keep `SEQUENTIAL_OWN_LEG_TIMEOUT_SECS`. */
  own_leg_timeout_secs_concurrent: number;
  api_region: "us" | "eu";
  /** 0 keeps undici's default. */
  http_keepalive_ms: number;
  /** Passed to the clients: `tuning` on the web, `voiceTuning` on the phone. */
  client: WebCallTuning & MobileVoiceTuning;
};

/** Today's own-leg dial timeout (`initializeOutgoingSession`). */
export const SEQUENTIAL_OWN_LEG_TIMEOUT_SECS = 30;
/** Same reuse as the live gate (`runtime.ts`): ~0 extra reads per poll, a database switch applies within seconds. */
export const LATENCY_FLAGS_CACHE_TTL_MS = 5_000;
const MAX_KEEPALIVE_MS = 600_000;

export function defaultLatencyFlags(): LatencyFlags {
  return {
    ...Object.fromEntries(BOOLEAN_KEYS.map(key => [key, false])) as Record<typeof BOOLEAN_KEYS[number], boolean>,
    concurrent_dial: { outbound: { web: false, mobile: false }, internal: { web: false, mobile: false } },
    own_leg_timeout_secs_concurrent: 12,
    api_region: "us",
    http_keepalive_ms: 0,
    client: { webEarlyAccept: false, webRtcRegion: "auto", webPrefetchIce: false, targetLocalFirst: false,
      mobileTokenCache: false, mobileRtcRegion: "auto", mobileTrickleIce: false, mobileRealtimeStatus: false,
      mobileEarlyAccept: false, mobileParallelOffers: false },
  };
}

/** Routes without telephony deps (mobile readiness) still leave the one line per instance. */
const consoleLogger: Logger = (entry) => {
  const line = JSON.stringify(entry);
  if (entry.level === "warn") console.warn(line);
  else console.info(line);
};
const reported = new Set<string>();
const logged = new Map<string, string>();
const cache = new Map<string, { at: number; value: Promise<LatencyFlags> }>();

/** Test seam. */
export function clearLatencyFlagsCache(): void {
  cache.clear();
  reported.clear();
  logged.clear();
}

/** Key names only: a value never enters the log. */
function reportOnce(logger: Logger | undefined, problem: string): void {
  if (reported.has(problem)) return;
  reported.add(problem);
  try { logger?.({ level: "warn", scope: "latency-flags", code: "latency_flag_ignored", problem }); }
  catch { /* Diagnostic only. */ }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function overrides(base: LatencyFlags, raw: unknown, source: "env" | "database", logger?: Logger): LatencyFlags {
  if (raw === null || raw === undefined) return base;
  const input = record(raw);
  if (!input) { reportOnce(logger, `${source}:not_an_object`); return base; }
  const next = structuredClone(base);
  const ignore = (key: string) => reportOnce(logger, `${source}:${key}`);
  for (const [key, value] of Object.entries(input)) {
    if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
      if (typeof value === "boolean") next[key as typeof BOOLEAN_KEYS[number]] = value;
      else ignore(key);
    } else if (key === "concurrent_dial") {
      const dial = record(value);
      if (!dial) { ignore(key); continue; }
      for (const [direction, origins] of Object.entries(dial)) {
        const byOrigin = record(origins);
        if ((direction !== "outbound" && direction !== "internal") || !byOrigin) { ignore(`${key}.${direction}`); continue; }
        for (const [origin, enabled] of Object.entries(byOrigin)) {
          if ((origin === "web" || origin === "mobile") && typeof enabled === "boolean") next.concurrent_dial[direction][origin] = enabled;
          else ignore(`${key}.${direction}.${origin}`);
        }
      }
    } else if (key === "own_leg_timeout_secs_concurrent") {
      if (typeof value === "number" && Number.isInteger(value) && value >= 8 && value <= 30) next.own_leg_timeout_secs_concurrent = value;
      else ignore(key);
    } else if (key === "api_region") {
      if (value === "us" || value === "eu") next.api_region = value;
      else ignore(key);
    } else if (key === "http_keepalive_ms") {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_KEEPALIVE_MS) next.http_keepalive_ms = value;
      else ignore(key);
    } else if (key === "client") {
      const client = record(value);
      if (!client) { ignore(key); continue; }
      for (const [name, setting] of Object.entries(client)) {
        if ((CLIENT_BOOLEAN_KEYS as readonly string[]).includes(name) && typeof setting === "boolean") next.client[name as typeof CLIENT_BOOLEAN_KEYS[number]] = setting;
        else if ((CLIENT_REGION_KEYS as readonly string[]).includes(name) && (setting === "auto" || setting === "eu")) next.client[name as typeof CLIENT_REGION_KEYS[number]] = setting;
        else ignore(`${key}.${name}`);
      }
    } else ignore(key);
  }
  return next;
}

/** Defaults overlaid with `TELEPHONY_LATENCY_FLAGS`; invalid JSON keeps the defaults. */
export function envLatencyFlags(env: Record<string, string | undefined> = process.env, logger?: Logger): LatencyFlags {
  const raw = env.TELEPHONY_LATENCY_FLAGS?.trim();
  if (!raw) return defaultLatencyFlags();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { reportOnce(logger, "env:invalid_json"); return defaultLatencyFlags(); }
  return overrides(defaultLatencyFlags(), parsed, "env", logger);
}

/**
 * Env overlaid with the organisation's database flags. Never throws: a missing
 * column (M1 not applied) or a failed read resolves from env alone. A separate
 * select from the live gate's, so a missing column can never touch that gate.
 */
export async function readLatencyFlags(admin: AdminClient, organizationId: string,
  options: { env?: Record<string, string | undefined>; logger?: Logger } = {}): Promise<LatencyFlags> {
  const now = Date.now();
  const hit = cache.get(organizationId);
  if (hit && now - hit.at < LATENCY_FLAGS_CACHE_TTL_MS && now >= hit.at) return hit.value;
  const logger = options.logger ?? consoleLogger;
  const entry = { at: now, value: null as unknown as Promise<LatencyFlags> };
  entry.value = (async () => {
    const base = envLatencyFlags(options.env, logger);
    let flags = base;
    try {
      const { data, error } = await admin.from("motorist_telephony_settings").select("latency_flags")
        .eq("organization_id", organizationId).maybeSingle();
      // Postgres reports the column as 42703; PostgREST's schema cache as PGRST204.
      if (error && (error.code === "42703" || error.code === "PGRST204" || /latency_flags/.test(error.message ?? ""))) reportOnce(logger, "database:column_missing");
      else if (error) throw error;
      else flags = overrides(base, (data as { latency_flags?: unknown } | null)?.latency_flags, "database", logger);
    } catch {
      // As with the live gate, a failed read falls back and is not reused.
      if (cache.get(organizationId) === entry) cache.delete(organizationId);
      return base;
    }
    const effective = JSON.stringify(flags);
    if (logged.get(organizationId) !== effective) {
      logged.set(organizationId, effective);
      try { logger({ scope: "latency-flags", organizationId, flags }); }
      catch { /* Diagnostic only. */ }
    }
    return flags;
  })();
  cache.set(organizationId, entry);
  return entry.value;
}

/** Deps built outside `createTelephonyDeps` (tests, cron helpers) use env alone. */
export function latencyFlagsOf(deps: { latencyFlags?: LatencyFlags; logger?: Logger }): LatencyFlags {
  return deps.latencyFlags ?? envLatencyFlags(process.env, deps.logger);
}

export function concurrentDialFor(flags: LatencyFlags, direction: "outbound" | "internal", origin: Origin): boolean {
  return flags.concurrent_dial[direction][origin];
}

/** What a new session keeps for its whole life, whatever the flags say later. */
export function freezeStartMode(flags: LatencyFlags, input: { direction: "inbound" | "outbound" | "internal"; origin: Origin | null }): SessionStartMode {
  const concurrent = input.direction !== "inbound" && input.origin !== null && concurrentDialFor(flags, input.direction, input.origin);
  return { concurrent, autoBridge: input.direction === "internal" && flags.internal_auto_bridge,
    ownLegTimeoutSecs: concurrent ? flags.own_leg_timeout_secs_concurrent : SEQUENTIAL_OWN_LEG_TIMEOUT_SECS,
    apiRegion: flags.api_region, origin: input.origin };
}

export function webCallTuning(flags: LatencyFlags): WebCallTuning {
  const { webEarlyAccept, webRtcRegion, webPrefetchIce, targetLocalFirst } = flags.client;
  return { webEarlyAccept, webRtcRegion, webPrefetchIce, targetLocalFirst };
}

export function mobileVoiceTuning(flags: LatencyFlags): MobileVoiceTuning {
  const { mobileTokenCache, mobileRtcRegion, mobileTrickleIce, mobileRealtimeStatus, mobileEarlyAccept, mobileParallelOffers } = flags.client;
  return { mobileTokenCache, mobileRtcRegion, mobileTrickleIce, mobileRealtimeStatus, mobileEarlyAccept, mobileParallelOffers };
}
