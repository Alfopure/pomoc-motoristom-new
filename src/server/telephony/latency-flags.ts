import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveAppEnvironment } from "@/lib/app-environment";
import type { Database } from "@/lib/supabase/database.types";
import type { MobileVoiceTuning } from "@/lib/mobile-api";
import type { WebCallTuning } from "@/lib/telephony/active-calls-model";
import type { SessionStartMode } from "./state/types";
import type { TelnyxConfig } from "./telnyx/env";

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
  // S7a.4 (lean routing context for hold/unhold) and S7a.2 (one read wave for the phone's hold).
  "hold_lean_context", "hold_mobile_dedupe",
  // S8.1: a new iPhone lease that replaces another phone's lease, and an operator's deactivation,
  // delete the mobile Telnyx credential, so a JWT cached on the old phone can no longer register.
  "mobile_rotate_on_takeover", "mobile_rotate_on_deactivation",
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
      return confirmStartPrivacy(admin, base, logger);
    }
    flags = await confirmStartPrivacy(admin, flags, logger);
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

/**
 * `own_leg_request_header` (call-speed S3) puts the client's start `requestId`
 * on the operator's own leg, so it is honoured only where the database confirms
 * that members can neither read call sessions nor receive their rows over
 * Realtime (`motorist_telephony_start_privacy_v1`, migrations 20261031100000–
 * 20261031100200). False, an error or an older database keeps it off; the
 * result is cached with the flags. Asked only while the switch is on.
 */
async function confirmStartPrivacy(admin: AdminClient, flags: LatencyFlags, logger: Logger): Promise<LatencyFlags> {
  if (!flags.own_leg_request_header) return flags;
  let confirmed = false;
  try {
    const { data, error } = await admin.rpc("motorist_telephony_start_privacy_v1");
    confirmed = !error && data === true;
  } catch { /* Unknown is not confirmed. */ }
  if (confirmed) return flags;
  reportOnce(logger, "own_leg_request_header:start_privacy_unconfirmed");
  return { ...flags, own_leg_request_header: false };
}

/**
 * Deps built outside `createTelephonyDeps` (tests, cron helpers) use env alone.
 * Env cannot confirm the database's start privacy, so that switch stays off.
 */
export function latencyFlagsOf(deps: { latencyFlags?: LatencyFlags; logger?: Logger }): LatencyFlags {
  return deps.latencyFlags ?? { ...envLatencyFlags(process.env, deps.logger), own_leg_request_header: false };
}

export function concurrentDialFor(flags: LatencyFlags, direction: "outbound" | "internal", origin: Origin): boolean {
  return flags.concurrent_dial[direction][origin];
}

/**
 * The start-mode switches this build implements. A frozen value is a promise
 * for the rest of the call, so a switch is frozen only once the stage that
 * ships its behaviour flips it here (S6: concurrent dial with its own-leg
 * timeout, internal auto-bridge; S5: API region; S7b: join-with-hold on the
 * first hold, see `joinWithHoldAllowed`). Until then a session records
 * what it really does, whatever the flags ask, and no later build can mistake
 * an earlier session for one that ran the optimisation.
 */
const HONOURED_START_SWITCHES = { concurrent: true, autoBridge: true, apiRegion: true, holdJoinWithHold: true } as const;

/**
 * S7b is implemented, but whether Telnyx plays the hold music to a participant
 * joining held into a conference that started on create is TEST spike S7.0
 * (docs/operations/telnyx-runbook.md). Until the runbook records a pass, only
 * a deployment whose application environment is exactly `test` may freeze it:
 * the spike runs on TEST with the switch alone, while production, a local run
 * (`development`, which may point at production data) and an unreadable
 * environment cannot reach it without a reviewed change here.
 */
const JOIN_WITH_HOLD_PROVEN = false;
function joinWithHoldAllowed(): boolean {
  if (JOIN_WITH_HOLD_PROVEN) return true;
  try { return resolveAppEnvironment() === "test"; }
  catch { return false; }
}

/**
 * S5 is implemented, but that every command of a call created through
 * `api.telnyx.eu` works there (and that the gain passes the plan's gate) is
 * TEST spike S5.0 (docs/operations/telnyx-runbook.md). Until the runbook
 * records a pass only a deployment whose application environment is exactly
 * `test` may freeze `eu`: production, a local run (`development`, even one
 * pointed at production data) and an unreadable environment keep `us`
 * whatever `api_region` says. Production needs a reviewed change here.
 */
const EU_API_PROVEN = false;
export function euApiRegionAllowed(): boolean {
  if (EU_API_PROVEN) return true;
  try { return resolveAppEnvironment() === "test"; }
  catch { return false; }
}

/**
 * S6 is implemented, but what Telnyx does when the far end answers while the
 * operator's own leg still rings (outcome A, B or C), two auto-bridged
 * endpoints answering together, and the wording of its "already bridged"
 * refusal are TEST spikes S6.0/1–4 (docs/operations/telnyx-runbook.md). Until
 * the runbook records a pass, only a deployment whose application environment
 * is exactly `test` freezes a concurrent start or the colleague auto-bridge,
 * as for S5 and S7b: production, a local run (`development`, which may point
 * at production data) and an unreadable environment keep the sequential start.
 */
const CONCURRENT_START_PROVEN = false;
function concurrentStartAllowed(): boolean {
  if (CONCURRENT_START_PROVEN) return true;
  try { return resolveAppEnvironment() === "test"; }
  catch { return false; }
}

/**
 * The Telnyx API region this deployment's `us` base really calls. Production
 * pins it to api.telnyx.com (`regionBaseUrl` in `telnyx/env.ts`), so there
 * this is always `us`; a test or local override pointing at `.eu` reads `eu`.
 */
export function providerRegionOf(config: TelnyxConfig): "us" | "eu" {
  if (!config.configured) return "us";
  try { return /(^|\.)telnyx\.eu$/.test(new URL(config.apiBaseUrl).hostname) ? "eu" : "us"; }
  catch { return "us"; }
}

/**
 * The Telnyx API region a session was frozen to (call-speed S5). A session
 * without `start_mode.apiRegion` (created before S0/S5) is `us` for good.
 */
export function sessionApiRegion(metadata: unknown): "us" | "eu" {
  const startMode = record(record(metadata)?.start_mode);
  return startMode?.apiRegion === "eu" ? "eu" : "us";
}

/**
 * What a new session keeps for its whole life, whatever the flags say later.
 *
 * `concurrentEligible` (call-speed S6.1) is false for a start that must stay
 * sequential whatever the switch says: a callback, or an outgoing call that
 * cannot connect directly (start announcements, and with them recording).
 * `autoBridgeEligible` (S6.3) is false for a colleague with web and mobile
 * endpoints, whose winner the server keeps choosing with an explicit bridge.
 * Written once, at creation (S5 pins the API region in it), so a writer that
 * cannot run S6 (a legacy contract-1 session) keeps what was frozen: the
 * concurrent start that really ran is `meta.far_end`, the colleague dial that
 * really carried the auto-bridge `meta.internal_auto_bridge`.
 */
export function freezeStartMode(flags: LatencyFlags, input: { direction: "inbound" | "outbound" | "internal"; origin: Origin | null; providerRegion: "us" | "eu";
  concurrentEligible?: boolean; autoBridgeEligible?: boolean }): SessionStartMode {
  const concurrent = HONOURED_START_SWITCHES.concurrent && input.direction !== "inbound" && input.origin !== null &&
    input.concurrentEligible !== false && concurrentDialFor(flags, input.direction, input.origin) && concurrentStartAllowed();
  const autoBridge = HONOURED_START_SWITCHES.autoBridge && input.direction === "internal" && input.autoBridgeEligible !== false &&
    flags.internal_auto_bridge && concurrentStartAllowed();
  // S7b: the first hold joins the customer already held. Present only when on,
  // so a session started with the switch off records exactly what it did before.
  const holdJoinWithHold = HONOURED_START_SWITCHES.holdJoinWithHold && input.direction !== "internal" && flags.hold_join_with_hold && joinWithHoldAllowed();
  return { concurrent, autoBridge,
    ownLegTimeoutSecs: concurrent ? flags.own_leg_timeout_secs_concurrent : SEQUENTIAL_OWN_LEG_TIMEOUT_SECS,
    // S5: a session we create is created and controlled in `eu` when the flag
    // asks for it and this deployment may (`euApiRegionAllowed`). Otherwise,
    // and always for an inbound call (Telnyx created it, in a region we have
    // no evidence for on this account; a separate inbound switch would need
    // the S5.0 inbound spike), it records the region of the host it really
    // calls, so the frozen and logged region always match the host.
    apiRegion: HONOURED_START_SWITCHES.apiRegion && input.direction !== "inbound" && flags.api_region === "eu" && euApiRegionAllowed()
      ? "eu" : input.providerRegion, origin: input.origin,
    ...(holdJoinWithHold ? { holdJoinWithHold: true as const } : {}) };
}

export function webCallTuning(flags: LatencyFlags): WebCallTuning {
  const { webEarlyAccept, webRtcRegion, webPrefetchIce, targetLocalFirst } = flags.client;
  return { webEarlyAccept, webRtcRegion, webPrefetchIce, targetLocalFirst };
}

export function mobileVoiceTuning(flags: LatencyFlags): MobileVoiceTuning {
  const { mobileTokenCache, mobileRtcRegion, mobileTrickleIce, mobileRealtimeStatus, mobileEarlyAccept, mobileParallelOffers } = flags.client;
  // A cached JWT outlives a lost lease only as long as its credential does: the phone may cache it
  // only while both rotations are on (S8.1).
  return { mobileTokenCache: mobileTokenCache && flags.mobile_rotate_on_takeover && flags.mobile_rotate_on_deactivation,
    mobileRtcRegion, mobileTrickleIce, mobileRealtimeStatus, mobileEarlyAccept, mobileParallelOffers };
}
