import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CallerMatch } from "@/data/dispatch-types";
import type { Database } from "@/lib/supabase/database.types";

import { buildBusinessHoursSchedule, type BusinessHoursSchedule } from "./routing/business-hours";
import { materialiseRingPlan } from "./routing/ring-plan";
import { applyReduceResult, recordCallEvent, SessionConflictError, type ApplyResult, type CommandOutcome, type EffectsDeps } from "./state/effects";
import { reduce } from "./state/transitions";
import {
  DEFAULT_ROUTING_SETTINGS,
  readMeta,
  type AttemptRow,
  type DeviceRow,
  type FrozenRingPlan,
  type IvrOptionRow,
  type LegRow,
  type LineRow,
  type PresenceRow,
  type RoutingContext,
  type RoutingSettings,
  type SessionEvent,
  type SessionRow,
  type TelephonyEnvironment,
} from "./state/types";
import type { TelnyxClient } from "./telnyx/client";
import type { TelnyxConfig } from "./telnyx/env";

/**
 * Runs one event through the per-session pipeline shared by the webhook
 * processor, the call actions and the sweeper:
 *
 *   lease (jittered retry ≤ 3 s) → load session/legs/attempts → routing
 *   context → pure reducer → effects (CAS on `version`, retry budget 20) →
 *   call-event audit row → lease release.
 *
 * If the lease cannot be obtained in time the event is still processed —
 * the version compare-and-set is the second safety net (design §2.3 item 7).
 */

type AdminClient = SupabaseClient<Database>;

export type SessionRunnerDeps = {
  admin: AdminClient;
  telnyx: TelnyxClient | null;
  config: TelnyxConfig;
  organizationId: string;
  environment: TelephonyEnvironment;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: (entry: Record<string, unknown>) => void;
  findCallerMatches?: (number: string) => Promise<{ degraded: boolean; matches: CallerMatch[] }>;
  leaseWaitMs?: number;
  leaseTtlMs?: number;
  maxConflictRetries?: number;
};

export const LEASE_WAIT_MS = 3_000;
export const LEASE_TTL_MS = 4_000;
export const LEASE_JITTER_MIN_MS = 50;
export const LEASE_JITTER_MAX_MS = 150;
export const MAX_CONFLICT_RETRIES = 20;

export type SessionRunResult =
  | { outcome: "ignored"; reason: string; session: SessionRow; leaseAcquired: boolean; retries: number }
  | { outcome: "applied"; apply: ApplyResult; session: SessionRow; leaseAcquired: boolean; retries: number; stateBefore: string; commands: CommandOutcome[] };

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} not found`);
    this.name = "SessionNotFoundError";
  }
}

export class LeaseTimeoutError extends Error {
  constructor(readonly sessionId: string) {
    super(`lease for session ${sessionId} not acquired in time`);
    this.name = "LeaseTimeoutError";
  }
}

function nowOf(deps: SessionRunnerDeps): () => Date {
  return deps.now ?? (() => new Date());
}

function sleepOf(deps: SessionRunnerDeps): (ms: number) => Promise<void> {
  return deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

export async function acquireSessionLease(deps: SessionRunnerDeps, sessionId: string, token: string): Promise<boolean> {
  const now = nowOf(deps);
  const sleep = sleepOf(deps);
  const random = deps.random ?? Math.random;
  const budget = deps.leaseWaitMs ?? LEASE_WAIT_MS;
  const ttl = deps.leaseTtlMs ?? LEASE_TTL_MS;
  const started = now().getTime();
  let waited = 0;
  for (;;) {
    const { data, error } = await deps.admin.rpc("motorist_session_lease_acquire", { p_session_id: sessionId, p_token: token, p_ttl_ms: ttl });
    if (error) throw new Error(`lease acquire failed: ${error.message}`);
    if (data === true) return true;
    const elapsed = Math.max(now().getTime() - started, waited);
    if (elapsed >= budget) return false;
    const jitter = LEASE_JITTER_MIN_MS + Math.floor(random() * (LEASE_JITTER_MAX_MS - LEASE_JITTER_MIN_MS + 1));
    waited += jitter;
    await sleep(jitter);
  }
}

export async function releaseSessionLease(deps: SessionRunnerDeps, sessionId: string, token: string): Promise<void> {
  const { error } = await deps.admin.rpc("motorist_session_lease_release", { p_session_id: sessionId, p_token: token });
  if (error) deps.logger?.({ level: "warn", scope: "lease", sessionId, error: error.message });
}

export async function loadSessionSnapshot(deps: SessionRunnerDeps, sessionId: string): Promise<{ session: SessionRow; legs: LegRow[]; attempts: AttemptRow[] }> {
  const [session, legs, attempts] = await Promise.all([
    deps.admin.from("motorist_call_sessions").select("*").eq("id", sessionId).maybeSingle(),
    deps.admin.from("motorist_call_legs").select("*").eq("session_id", sessionId).order("initiated_at", { ascending: true }),
    deps.admin.from("motorist_ring_attempts").select("*").eq("session_id", sessionId).order("step_index", { ascending: true }).order("position", { ascending: true }),
  ]);
  if (session.error) throw new Error(`session load failed: ${session.error.message}`);
  if (!session.data) throw new SessionNotFoundError(sessionId);
  if (legs.error) throw new Error(`legs load failed: ${legs.error.message}`);
  if (attempts.error) throw new Error(`attempts load failed: ${attempts.error.message}`);
  return { session: session.data, legs: legs.data ?? [], attempts: attempts.data ?? [] };
}

export async function loadRoutingSettings(admin: AdminClient, organizationId: string): Promise<RoutingSettings & { raw: Database["public"]["Tables"]["motorist_telephony_settings"]["Row"] | null }> {
  const { data, error } = await admin.from("motorist_telephony_settings").select("*").eq("organization_id", organizationId).maybeSingle();
  if (error) throw new Error(`telephony settings load failed: ${error.message}`);
  if (!data) return { ...DEFAULT_ROUTING_SETTINGS, raw: null };
  return {
    parkMaxMinutes: data.park_max_minutes,
    maxRingFanout: data.max_ring_fanout,
    maxConcurrentLegs: data.max_concurrent_legs,
    wrapUpSecondsDefault: DEFAULT_ROUTING_SETTINGS.wrapUpSecondsDefault,
    raw: data,
  };
}

async function loadBusinessHours(admin: AdminClient, organizationId: string, businessHoursId: string | null): Promise<BusinessHoursSchedule | null> {
  if (!businessHoursId) return null;
  const [hours, intervals, exceptions] = await Promise.all([
    admin.from("motorist_business_hours").select("*").eq("organization_id", organizationId).eq("id", businessHoursId).maybeSingle(),
    admin.from("motorist_business_hours_intervals").select("*").eq("business_hours_id", businessHoursId),
    admin.from("motorist_business_hours_exceptions").select("*").eq("business_hours_id", businessHoursId),
  ]);
  if (hours.error) throw new Error(`business hours load failed: ${hours.error.message}`);
  if (!hours.data || !hours.data.active) return null;
  if (intervals.error) throw new Error(`business hours intervals load failed: ${intervals.error.message}`);
  if (exceptions.error) throw new Error(`business hours exceptions load failed: ${exceptions.error.message}`);
  return buildBusinessHoursSchedule({ timezone: hours.data.timezone, intervals: intervals.data ?? [], exceptions: exceptions.data ?? [] });
}

async function loadIvr(admin: AdminClient, organizationId: string, menuId: string | null): Promise<RoutingContext["ivr"]> {
  if (!menuId) return null;
  const [menu, options] = await Promise.all([
    admin.from("motorist_ivr_menus").select("*").eq("organization_id", organizationId).eq("id", menuId).maybeSingle(),
    admin.from("motorist_ivr_options").select("*").eq("ivr_menu_id", menuId).order("digit", { ascending: true }),
  ]);
  if (menu.error) throw new Error(`ivr menu load failed: ${menu.error.message}`);
  if (!menu.data || !menu.data.active) return null;
  if (options.error) throw new Error(`ivr options load failed: ${options.error.message}`);
  return { menu: menu.data, options: (options.data ?? []) as IvrOptionRow[] };
}

const ROUTING_STATES = new Set(["received", "greeting", "ivr", "ringing", "waiting", "parked", "after_hours", "callback_offered"]);

export async function loadRoutingContext(deps: SessionRunnerDeps, session: SessionRow): Promise<RoutingContext> {
  const { admin, organizationId } = deps;
  const now = nowOf(deps)();
  const meta = readMeta(session);
  const line: LineRow | null = session.line_id
    ? await admin
        .from("motorist_telephony_lines")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("id", session.line_id)
        .maybeSingle()
        .then((result) => {
          if (result.error) throw new Error(`line load failed: ${result.error.message}`);
          return result.data;
        })
    : null;
  const settings = await loadRoutingSettings(admin, organizationId);
  const routing = ROUTING_STATES.has(session.state);

  const [businessHours, ivr] = routing ? await Promise.all([loadBusinessHours(admin, organizationId, line?.business_hours_id ?? null), loadIvr(admin, organizationId, line?.ivr_menu_id ?? null)]) : [null, null];

  let ringPlan: FrozenRingPlan | null = meta.ring?.plan ?? null;
  const ringPlans: Record<string, FrozenRingPlan> = {};
  if (routing) {
    const planIds = new Set<string>();
    if (!ringPlan && line?.ring_plan_id) planIds.add(line.ring_plan_id);
    for (const option of ivr?.options ?? []) if (option.target_ring_plan_id) planIds.add(option.target_ring_plan_id);
    for (const planId of planIds) {
      const frozen = await materialiseRingPlan(admin, { organizationId, ringPlanId: planId, now });
      if (frozen) ringPlans[planId] = frozen;
    }
    if (!ringPlan && line?.ring_plan_id) ringPlan = ringPlans[line.ring_plan_id] ?? null;
    if (ringPlan) ringPlans[ringPlan.planId] = ringPlan;
  }

  let presence: PresenceRow[] = [];
  let devices: DeviceRow[] = [];
  let openOffers: string[] = [];
  let activeLegCount = 0;
  if (routing) {
    const profileIds = new Set<string>();
    for (const plan of Object.values(ringPlans)) for (const step of plan.steps) for (const member of step.members) if (member.profileId) profileIds.add(member.profileId);
    const ids = [...profileIds];
    const [presenceResult, devicesResult, offersResult, legsResult] = await Promise.all([
      ids.length > 0 ? admin.from("motorist_operator_presence").select("*").eq("organization_id", organizationId).in("profile_id", ids) : Promise.resolve({ data: [] as PresenceRow[], error: null }),
      ids.length > 0 ? admin.from("motorist_operator_devices").select("*").eq("organization_id", organizationId).eq("environment", deps.environment).in("profile_id", ids) : Promise.resolve({ data: [] as DeviceRow[], error: null }),
      ids.length > 0
        ? admin.from("motorist_ring_attempts").select("profile_id, session_id").eq("organization_id", organizationId).eq("result", "offered").in("profile_id", ids).neq("session_id", session.id)
        : Promise.resolve({ data: [] as Array<{ profile_id: string | null; session_id: string }>, error: null }),
      admin.from("motorist_call_legs").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).is("ended_at", null),
    ]);
    if (presenceResult.error) throw new Error(`presence load failed: ${presenceResult.error.message}`);
    if (devicesResult.error) throw new Error(`devices load failed: ${devicesResult.error.message}`);
    if (offersResult.error) throw new Error(`open offers load failed: ${offersResult.error.message}`);
    if (legsResult.error) throw new Error(`leg count failed: ${legsResult.error.message}`);
    presence = (presenceResult.data ?? []) as PresenceRow[];
    devices = (devicesResult.data ?? []) as DeviceRow[];
    openOffers = [...new Set(((offersResult.data ?? []) as Array<{ profile_id: string | null }>).map((row) => row.profile_id).filter((id): id is string => Boolean(id)))];
    activeLegCount = legsResult.count ?? 0;
  }

  const config = deps.config;
  return {
    now,
    organizationId,
    environment: deps.environment,
    line,
    businessHours,
    ivr,
    ringPlan,
    ringPlans,
    presence,
    devices,
    openOffers,
    activeLegCount,
    settings,
    fromNumber: line?.phone_number ?? (config.configured ? config.defaultFromNumber : null),
    mediaAvailable: config.configured ? Boolean(config.mediaBaseUrl) : false,
  };
}

export function effectsDeps(deps: SessionRunnerDeps): EffectsDeps {
  const now = nowOf(deps);
  return {
    admin: deps.admin,
    telnyx: deps.telnyx,
    organizationId: deps.organizationId,
    environment: deps.environment,
    mediaBaseUrl: deps.config.configured ? deps.config.mediaBaseUrl : null,
    now,
    logger: deps.logger,
    wrapUpSecondsFor: async (profileId) => {
      const { data } = await deps.admin.from("motorist_operator_telephony_settings").select("wrap_up_seconds").eq("profile_id", profileId).maybeSingle();
      return data?.wrap_up_seconds ?? DEFAULT_ROUTING_SETTINGS.wrapUpSecondsDefault;
    },
  };
}

export async function runSessionEvent(deps: SessionRunnerDeps, sessionId: string, event: SessionEvent): Promise<SessionRunResult> {
  const token = randomUUID();
  const leaseAcquired = await acquireSessionLease(deps, sessionId, token);
  if (!leaseAcquired) deps.logger?.({ level: "warn", scope: "lease", sessionId, eventId: event.id, message: "processing without lease (CAS protected)" });
  const effects = effectsDeps(deps);
  const maxRetries = deps.maxConflictRetries ?? MAX_CONFLICT_RETRIES;

  try {
    for (let retries = 0; ; retries += 1) {
      const snapshot = await loadSessionSnapshot(deps, sessionId);
      const context = await loadRoutingContext(deps, snapshot.session);
      const result = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, context);

      if (result.ignored) {
        await recordCallEvent(effects, {
          session: snapshot.session,
          event,
          handledStatus: "ignored",
          stateBefore: snapshot.session.state,
          stateAfter: snapshot.session.state,
          notes: [result.ignored],
          commands: [],
        });
        return { outcome: "ignored", reason: result.ignored, session: snapshot.session, leaseAcquired, retries };
      }

      try {
        const apply = await applyReduceResult(effects, { session: snapshot.session, result, event, expectedVersion: snapshot.session.version });
        await recordCallEvent(effects, {
          session: apply.session,
          event,
          handledStatus: apply.failed ? "failed" : "processed",
          stateBefore: snapshot.session.state,
          stateAfter: apply.session.state,
          notes: [...apply.notes, ...apply.compensations.map((entry) => `compensation: ${entry}`)],
          commands: apply.commands.map((command) => ({ kind: command.kind, ok: command.ok })),
          error: apply.failure?.error ?? null,
        });
        deps.logger?.({
          scope: "session",
          sessionId,
          eventId: event.id,
          type: event.kind === "telnyx" ? event.type : `app.${event.type}`,
          stateBefore: snapshot.session.state,
          stateAfter: apply.session.state,
          branch: apply.branch,
          commands: apply.commands.map((command) => `${command.kind}${command.ok ? "" : "!"}`),
          leaseAcquired,
          retries,
        });
        return { outcome: "applied", apply, session: apply.session, leaseAcquired, retries, stateBefore: snapshot.session.state, commands: apply.commands };
      } catch (error) {
        if (error instanceof SessionConflictError && retries < maxRetries) {
          await sleepOf(deps)(LEASE_JITTER_MIN_MS);
          continue;
        }
        throw error;
      }
    }
  } finally {
    if (leaseAcquired) await releaseSessionLease(deps, sessionId, token);
  }
}
