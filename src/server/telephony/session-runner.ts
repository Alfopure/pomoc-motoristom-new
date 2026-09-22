import { reconcileProviderEvent } from "./provider-event-evidence";
import { measureRequestStep } from "@/server/request-metrics";
import { reconcileTermination } from "./termination";
import { sessionOwnership, ownershipRpc, assertOwnership, OWNERSHIP_RENEW_SKIP_MS, SESSION_WORK_MS, SESSION_LEASE_MS, DATABASE_REQUEST_MS, type Ownership } from "./ownership";
import { resolvePersonalRingMembers } from "./routing/ring-plan";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { announcementConfigFromMetadata, readAnnouncementConfig } from "@/lib/telephony/announcements";

import { writeCallAudit } from "./audit";
import { recordTelephonyIncident, recoverTelephonyIncidentThrottled, TELEPHONY_INCIDENT_JOBS } from "./incidents";
import { buildBusinessHoursSchedule, type BusinessHoursSchedule } from "@/lib/telephony/business-hours";
import { materialiseRingPlan, materialiseRingPlanRows } from "./routing/ring-plan";
import { readRuntimeRoutingSnapshot, RoutingSnapshotCompatibilityError, type RuntimeRoutingSnapshot } from "./routing/snapshot";
import { applyReduceResult, auditCommandOutcomes, recordCallEvent, resumePendingEffects, SessionConflictError, type ApplyResult, type CommandOutcome, type EffectsDeps } from "./state/effects";
import { hasStabilityContract, telephonyStabilityEnabled } from "./stability";
import { attachContactOperations, collectContactProof, readContactHistory } from "./contact-proof";
import { readPendingEffects } from "./state/continuation";
import { cancelRevokedOffers } from "./state/cancelled-offers";
import { reduce } from "./state/transitions";
import { needsRecordingContinuation, requiresRecordingLease } from "./state/recording";
import { SessionEventDeferredError, SessionLeaseBusyError, SessionLeaseLostError, SessionTerminationPendingError } from "./service-errors";
export { SessionEventDeferredError } from "./service-errors";
import { resolveSessionRecordingPolicy } from "./recording-policy-service";
import {
  DEFAULT_ROUTING_SETTINGS,
  ACTIVE_SESSION_STATES,
  emptyTransition,
  isOpenLeg,
  readMeta,
  toJson,
  type AttemptRow,
  type DeviceRow,
  type FrozenRingPlan,
  type IvrOptionRow,
  type LegRow,
  type PresenceRow,
  type RoutingContext,
  type RoutingSettings,
  type SessionEvent,
  type SessionRow,
  type TelephonyEnvironment,
} from "./state/types";
import type { TelnyxClient } from "./telnyx/client";
import type { TelnyxClientState } from "./telnyx/client-state";
import type { TelnyxConfig } from "./telnyx/env";

/**
 * Runs one event through the per-session pipeline shared by the webhook
 * processor, the call actions and the sweeper:
 *
 *   lease (jittered retry ≤ 3 s) → load session/legs/attempts → routing
 *   context → pure reducer → effects (CAS on `version`, retry budget 20) →
 *   call-event audit row → lease release.
 *
 * Contract-1 compatibility permits version CAS for bookkeeping and teardown.
 * Contract-2 writes require the fixed ownership token and generation; version
 * CAS alone never authorizes provider commands.
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
  leaseWaitMs?: number;
  leaseTtlMs?: number;
  maxConflictRetries?: number;
  /** Registers best-effort after-response work; never performs push under the session lease. */
  onCallTransition?: (sessionId: string) => void;
};

export const LEASE_WAIT_MS = 3_000;
/**
 * How long a provider callback may wait for the lease before answering 500.
 *
 * It used to give up instantly, so simultaneous callbacks for the same call —
 * a conference emits `created`, `participant.joined`, `floor.changed` and
 * `participant.left` within milliseconds — all answered 500 and Telnyx
 * redelivered every one of them. On the heaviest test call on 17 Sep that was
 * 23 of 55 events failing outright, 5.2 deliveries per event, and provider
 * facts landing minutes late through the cron.
 *
 * Two seconds cover the initiated/answered collision (the customer
 * `call.answered` lands 0.17-0.32 s after `answer` and the holder keeps the
 * lease ~1.3 s after it) and stay at most 2/3 of the operator's own budget
 * (`LEASE_WAIT_MS`, asserted in `session-contention.test.ts`), so
 * hold/unhold/transfer/consult keep a 1 s reserve and a click still outlasts a
 * callback competing for the same lease. It is also well under the provider's
 * 30 s webhook timeout. Waiting holds nothing: the invocation is only retrying
 * the acquire RPC. Sweeps keep giving up at once — they are opportunistic by
 * design.
 */
export const WEBHOOK_LEASE_WAIT_MS = 2_000;
/**
 * Flat poll ladder for that wait. The adaptive ladder (150·2^n capped at 800)
 * slept 800 ms after a release and gave up at 1.2 s, so a lease freed between
 * 0.55 and 1.2 s was noticed late and one freed after 1.25 s became an HTTP
 * 500 (M15: 15 of 173 runner rows with lease_wait_ms 1300-1600). Seven flat
 * steps + jitter are at most 8 acquire RPCs (the 50 ms retry once produced 17)
 * inside a hard 2 s wall cap; with real RPC latency the cap is what ends it.
 */
export const WEBHOOK_LEASE_POLL_MS: readonly number[] = [100, 150, 200, 250, 250, 250, 250];
export const LEASE_TTL_MS = SESSION_LEASE_MS;
export const LEASE_JITTER_MIN_MS = 50;
export const LEASE_JITTER_MAX_MS = 150;
export const MAX_CONFLICT_RETRIES = 20;
/** Legs older than this no longer count against `max_concurrent_legs`. */
export const ACTIVE_LEG_WINDOW_MS = 4 * 60 * 60 * 1000;

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

function sleepOf(deps: Pick<SessionRunnerDeps, "sleep">): (ms: number) => Promise<void> {
  return deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

function leaseTtl(deps: Pick<SessionRunnerDeps, "leaseTtlMs">): number {
  return Math.max(SESSION_LEASE_MS, deps.leaseTtlMs ?? LEASE_TTL_MS);
}

export async function acquireSessionLease(deps: SessionRunnerDeps, sessionId: string, token: string): Promise<boolean> {
  const now = nowOf(deps);
  const sleep = sleepOf(deps);
  const random = deps.random ?? Math.random;
  const budget = deps.leaseWaitMs ?? LEASE_WAIT_MS;
  const ttl = leaseTtl(deps);
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

/** Re-acquires the lease with the same token (re-entrant RPC); best effort. */
export async function renewSessionLease(deps: SessionRunnerDeps, sessionId: string, token: string, required = false): Promise<void> {
  if (sessionOwnership.getStore()) return assertOwnership();
  const { data, error } = await deps.admin.rpc("motorist_session_lease_acquire", { p_session_id: sessionId, p_token: token, p_ttl_ms: leaseTtl(deps) });
  if (error) deps.logger?.({ level: "warn", scope: "lease", sessionId, message: "renew failed", error: error.message });
  else if (data !== true) deps.logger?.({ level: "warn", scope: "lease", sessionId, message: "lease lost during effects" });
  if (required && (error || data !== true)) throw new SessionLeaseLostError();
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
  return routingSettingsFromRow(data);
}

function routingSettingsFromRow(data: Database["public"]["Tables"]["motorist_telephony_settings"]["Row"] | null): RoutingSettings & { raw: typeof data } {
  if (!data) return { ...DEFAULT_ROUTING_SETTINGS, raw: null };
  return {
    parkMaxMinutes: data.park_max_minutes,
    maxRingFanout: data.max_ring_fanout,
    maxConcurrentLegs: data.max_concurrent_legs,
    wrapUpSecondsDefault: DEFAULT_ROUTING_SETTINGS.wrapUpSecondsDefault,
    // A deployment that runs ahead of its migration reads no column at all,
    // and must keep the behaviour it had rather than silently stop escalating.
    queueEscalateAfterSeconds: typeof data.queue_escalate_after_seconds === "number"
      ? data.queue_escalate_after_seconds
      : DEFAULT_ROUTING_SETTINGS.queueEscalateAfterSeconds,
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

async function loadRoutingConfiguration(deps: SessionRunnerDeps, session: SessionRow, now: Date, noContinuation: boolean, event?: SessionEvent, snapshotLegs?: LegRow[]) {
  const { admin, organizationId } = deps;
  const meta = readMeta(session);
  let entrySnapshot: RuntimeRoutingSnapshot | null = null;
  let currentRecordingPolicy: RoutingContext["recordingPolicy"];
  // Only the first ordinary customer answer opts into the new read path. A
  // frozen plan or unfinished voice sequence must keep its existing reader.
  const initialCustomerAnswer = noContinuation && session.writer_contract === 2 &&
    session.direction === "inbound" && session.state === "received" && !session.ended_at &&
    !session.termination_requested_at && !meta.hangup && !meta.greeting && !meta.gather &&
    !meta.ring && !meta.queue && !meta.ivr && !meta.greeting_call_gone_at &&
    event?.kind === "telnyx" && event.type === "call.answered" &&
    (!meta.announcements || readAnnouncementConfig(meta.announcements).inboundStartAnnouncements !== true) &&
    snapshotLegs?.some((leg) => leg.id === session.customer_leg_id && leg.role === "customer" &&
      leg.telnyx_call_control_id === event.callControlId && !leg.ended_at);
  if (initialCustomerAnswer) {
    try {
      const [raw, policy] = await Promise.all([
        measureRequestStep("routing.snapshot", () => readRuntimeRoutingSnapshot(admin, organizationId)),
        resolveSessionRecordingPolicy(admin, organizationId),
      ]);
      currentRecordingPolicy = policy;
      const line = raw.lines.find((row) => row.id === session.line_id) ?? null;
      const announcements = meta.announcements ? readAnnouncementConfig(meta.announcements) : announcementConfigFromMetadata(line?.metadata);
      if (!policy.enabled && !line?.ivr_menu_id && announcements.inboundStartAnnouncements !== true) entrySnapshot = raw;
    } catch (error) {
      if (!(error instanceof RoutingSnapshotCompatibilityError)) throw error;
      // Fall back once, before effects, using a whole legacy configuration.
      // A broken log sink must not turn compatibility recovery into call loss.
      try { deps.logger?.({ scope: "routing", code: "routing_snapshot_fallback", reason: error.reason }); } catch { /* best effort */ }
    }
  }
  const [line, settings, recordingPolicy] = entrySnapshot
    ? [entrySnapshot.lines.find((row) => row.id === session.line_id) ?? null, routingSettingsFromRow(entrySnapshot.settings), currentRecordingPolicy] as const
    : await Promise.all([
    session.line_id
      ? admin
        .from("motorist_telephony_lines")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("id", session.line_id)
        .maybeSingle()
        .then((result) => {
          if (result.error) throw new Error(`line load failed: ${result.error.message}`);
          return result.data;
        })
      : null,
    loadRoutingSettings(admin, organizationId),
    currentRecordingPolicy ?? resolveSessionRecordingPolicy(admin, organizationId),
  ]);
  // An initiated leg only needs to be registered/answered. Its answered event
  // selects the route. Do not put IVR, ring-plan materialisation and operator
  // availability reads ahead of answer (or repeat them for every fanout leg).
  // Recovery work can still need the full context on an initiated event.
  const initiationOnly = event?.kind === "telnyx" && event.type === "call.initiated" &&
    !meta.announcement_sequence && !meta.gather && !meta.recording?.barrier &&
    !meta.recording?.pendingAudio && !readPendingEffects(session).entries.length;
  const routing = !initiationOnly && ROUTING_STATES.has(session.state);
  // An outgoing call already has an explicit recipient. Loading the line's
  // inbound IVR and ring groups on every setup webhook delays that recipient
  // and makes unrelated inbound configuration failures block the call.
  // Retain saved plans/queues for resumed routing, and count capacity below
  // for every routing state, including parked outgoing and internal calls.
  const inboundRouting = routing && (session.direction === "inbound" || Boolean(meta.ring?.plan) || meta.ring?.mode === "plan" || Boolean(meta.queue));

  // Once a caller has left the introduction/menu, routing uses the frozen plan.
  // Re-reading every IVR branch while operators answer or hang up holds the
  // session lease for unrelated configuration work and delays those events.
  const needsEntryRouting = inboundRouting && ["received", "greeting", "ivr"].includes(session.state);
  const hours = entrySnapshot?.hours.find((row) => row.id === line?.business_hours_id);
  const snapshotHours = hours?.active && entrySnapshot ? buildBusinessHoursSchedule({
    timezone: hours.timezone,
    intervals: entrySnapshot.intervals.filter((row) => row.business_hours_id === hours.id),
    exceptions: entrySnapshot.exceptions.filter((row) => row.business_hours_id === hours.id),
  }) : null;
  const [businessHours, ivr] = entrySnapshot ? [snapshotHours, null] : needsEntryRouting
    ? await Promise.all([loadBusinessHours(admin, organizationId, line?.business_hours_id ?? null), loadIvr(admin, organizationId, line?.ivr_menu_id ?? null)]) : [null, null];

  let ringPlan: FrozenRingPlan | null = meta.ring?.plan ?? null;
  const ringPlans: Record<string, FrozenRingPlan> = {};
  if (inboundRouting) {
    const planIds = new Set<string>();
    if (!ringPlan && line?.ring_plan_id) planIds.add(line.ring_plan_id);
    for (const option of ivr?.options ?? []) if (option.target_ring_plan_id) planIds.add(option.target_ring_plan_id);
    // The RPC's abbreviated presence is not availability. Resolve paused
    // substitutes freshly, then the shared eligibility phase rereads targets.
    const paused = entrySnapshot && planIds.size > 0
      ? await admin.from("motorist_operator_presence").select("profile_id").eq("organization_id", organizationId).eq("status", "paused") : null;
    if (paused?.error) throw new Error(`operator routing load failed: ${paused.error.message}`);
    const pausedProfileIds = new Set((paused?.data ?? []).map((row) => row.profile_id));
    await Promise.all([...planIds].map(async (planId) => {
      const frozen = entrySnapshot ? materialiseRingPlanRows({
        plan: entrySnapshot.plans.find((row) => row.id === planId) ?? null,
        steps: entrySnapshot.steps, groups: entrySnapshot.groups, members: entrySnapshot.members,
        operatorRouting: entrySnapshot.operatorSettings, pausedProfileIds,
        destinationAllowlist: entrySnapshot.settings?.destination_allowlist ?? ["SK", "CZ"],
        personalMobileEnabled: telephonyStabilityEnabled(), now,
      }) : await materialiseRingPlan(admin, { organizationId, ringPlanId: planId, now });
      if (frozen) ringPlans[planId] = frozen;
    }));
    if (!ringPlan && line?.ring_plan_id) ringPlan = ringPlans[line.ring_plan_id] ?? null;
    if (ringPlan) ringPlans[ringPlan.planId] = ringPlan;
  }

  if (inboundRouting) {
    const personal = entrySnapshot ? { data: entrySnapshot.operatorSettings, error: null }
      : await admin.from("motorist_operator_telephony_settings").select("*").eq("organization_id", organizationId);
    if (personal.error) throw new Error(`personal routing load failed: ${personal.error.message}`);
    for (const [id, plan] of Object.entries(ringPlans)) {
      ringPlans[id] = { ...plan, steps: plan.steps.map((step) => ({ ...step, members: resolvePersonalRingMembers(step.members, personal.data ?? [], settings.raw?.destination_allowlist ?? ["SK", "CZ"]) })) };
    }
    if (ringPlan) ringPlan = ringPlans[ringPlan.planId] ?? ringPlan;
  }

  return { line, settings, recordingPolicy, routing, businessHours, ivr, ringPlan, ringPlans };
}

export async function loadRoutingContext(deps: SessionRunnerDeps, session: SessionRow, event?: SessionEvent, snapshotLegs?: LegRow[]): Promise<RoutingContext> {
  const { admin, organizationId } = deps;
  const now = nowOf(deps)();
  const meta = readMeta(session);
  const noContinuation =
    meta.recording?.policy.enabled === false && !meta.recording.recorders.length &&
    !meta.recording.barrier && !meta.recording.pendingAudio && !meta.announcement_sequence &&
    !readPendingEffects(session).entries.length;
  const bridgeObservation = noContinuation && event?.kind === "telnyx" && event.type === "call.bridged" &&
    snapshotLegs?.some(leg => leg.telnyx_call_control_id === event.callControlId && Boolean(leg.answered_at));
  const passiveObservation = noContinuation && event?.kind === "telnyx" && (
    ["conference.participant.joined", "conference.participant.left", "conference.ended"].includes(event.type) ||
    ["call.playback.ended", "call.speak.ended"].includes(event.type) &&
      ["talking", "held", "consulting", "conference", "ended"].includes(session.state) && !meta.gather
  );
  // An offer being accepted connects two legs that already exist. The reducer
  // reads `settings.parkMaxMinutes` (the waiting room the compensation falls
  // back to), `mediaAvailable`, `now` and the frozen recording policy — nothing
  // about the line, the IVR, capacity or who else is free. Loading those cost
  // three parallel rounds on the one transition the caller is waiting through.
  //
  // Conditioned on `noContinuation` like every other lean branch: `reduce` runs
  // `reduceRecording`, whose eligibility and lease decisions read the live
  // policy, so a frozen one may only be handed over when recording is frozen
  // off. `internal` is excluded on purpose — it branches to
  // `onInternalCalleeAnswered`, a different path with its own bridge.
  const answeredOffer = noContinuation && event?.kind === "telnyx" &&
    ["call.answered", "call.bridged"].includes(event.type) &&
    ["ring", "pickup", "transfer", "transfer_safe"].includes(event.clientState?.intent ?? "") &&
    Boolean(meta.ring?.plan) && ["ringing", "waiting", "parked"].includes(session.state) &&
    snapshotLegs?.some(leg => leg.telnyx_call_control_id === event.callControlId && leg.role !== "customer");
  // Outbound parking has no inbound ring plan. Select the same lean context
  // only for an exact, persisted pickup; this is not event admission. Early
  // events and conflicting hints retain the full path's correlation/recovery.
  const pickupLeg = snapshotLegs?.find(leg => leg.telnyx_call_control_id === (event?.kind === "telnyx" ? event.callControlId : null));
  const savedPickup = pickupLeg?.client_state as TelnyxClientState | null | undefined;
  // Outbound setup can leave customer_leg_id unset. The reducer then selects
  // by role; require exactly one saved customer so that fallback is unambiguous.
  const customers = snapshotLegs?.filter(leg => leg.role === "customer") ?? [];
  const pickupCustomer = customers.length === 1 ? customers[0] : undefined;
  const outboundPickup = noContinuation && session.writer_contract === 2 &&
    session.direction === "outbound" && ["waiting", "parked"].includes(session.state) &&
    !session.ended_at && !session.termination_requested_at && !meta.hangup &&
    !meta.ring?.plan && meta.ring?.mode === "outbound" && Boolean(meta.pickup?.by) &&
    !session.conference_id && !meta.conference && !meta.consult && !meta.transfer && !meta.queue &&
    !meta.internal && !meta.party_pending && !meta.supervise &&
    Boolean(meta.announcements) &&
    !meta.greeting && !meta.greeting_call_gone_at && !meta.closing_message && !meta.ivr && !meta.callback &&
    (!meta.gather || meta.gather.spec?.purpose === "moh_tick" && !meta.gather.failed && !meta.gather.call_gone) &&
    event?.kind === "telnyx" && ["call.answered", "call.bridged"].includes(event.type) &&
    event.clientState?.sid === session.id && event.clientState.role === "operator" && event.clientState.intent === "pickup" &&
    pickupLeg?.organization_id === organizationId && pickupLeg.session_id === session.id &&
    pickupLeg.role === "operator" && isOpenLeg(pickupLeg) && !pickupLeg.answered_at &&
    pickupLeg.profile_id === meta.pickup?.by && savedPickup?.sid === session.id &&
    savedPickup.role === "operator" && savedPickup.intent === "pickup" &&
    savedPickup.operatorId === pickupLeg.profile_id && event.clientState.operatorId === pickupLeg.profile_id &&
    savedPickup.offerToken === event.clientState.offerToken &&
    pickupCustomer?.organization_id === organizationId && pickupCustomer.session_id === session.id &&
    (!session.customer_leg_id || session.customer_leg_id === pickupCustomer.id) &&
    Boolean(pickupCustomer.telnyx_call_control_id) && isOpenLeg(pickupCustomer);
  if (answeredOffer || outboundPickup) {
    const settings = await loadRoutingSettings(admin, organizationId);
    const config = deps.config;
    return {
      now, organizationId, environment: deps.environment, line: null,
      businessHours: null, ivr: null, ringPlan: null, ringPlans: {}, presence: [], devices: [],
      openOffers: [], activeLegCount: 0, settings,
      fromNumber: (config.configured ? config.defaultFromNumber : null) ?? null,
      // Not `false`: `mohIsPlaying` would then never see the waiting-room loop
      // and the answer would bridge the caller with a playback still running.
      mediaAvailable: config.configured ? Boolean(config.mediaBaseUrl) : false,
      announcements: meta.announcements ? readAnnouncementConfig(meta.announcements) : undefined,
      recordingPolicy: meta.recording?.policy,
      lean: true,
    };
  }
  if (event?.kind === "app" && event.type === "hangup" || bridgeObservation || passiveObservation) {
    // Ending a call needs only its already authenticated session/legs. New
    // IVR, capacity, media and recording settings cannot authorize a hangup
    // more strongly, and a slow/broken settings read must not hold it hostage.
    // Retain frozen recorder evidence so teardown never erases capture state.
    // Likewise, a known answered leg's bridge confirmation only records that
    // fact. An out-of-order first bridge still loads the complete route below.
    // Passive media/conference observations still reconcile evidence and keep
    // their audit, but need no unrelated line/IVR/capacity configuration.
    return {
      now, organizationId, environment: deps.environment, line: null,
      businessHours: null, ivr: null, ringPlan: null, ringPlans: {}, presence: [], devices: [],
      openOffers: [], activeLegCount: 0, settings: DEFAULT_ROUTING_SETTINGS,
      fromNumber: null, mediaAvailable: false,
      announcements: meta.announcements ? readAnnouncementConfig(meta.announcements) : undefined,
      recordingPolicy: meta.recording?.policy,
    };
  }
  const { line, settings, recordingPolicy, routing, businessHours, ivr, ringPlan, ringPlans } =
    await measureRequestStep("routing.configuration", () => loadRoutingConfiguration(deps, session, now, noContinuation, event, snapshotLegs));

  let presence: PresenceRow[] = [];
  let devices: DeviceRow[] = [];
  let openOffers: string[] = [];
  let activeLegCount = 0;
  if (routing) {
    const profileIds = new Set<string>();
    for (const plan of Object.values(ringPlans)) for (const step of plan.steps) for (const member of step.members) if (member.profileId) profileIds.add(member.profileId);
    for (const plan of Object.values(ringPlans)) for (const member of plan.queueMembers ?? []) if (member.profileId) profileIds.add(member.profileId);
    const ids = [...profileIds];
    const [presenceResult, devicesResult, offersResult, legsResult] = await measureRequestStep("routing.eligibility", () => Promise.all([
      ids.length > 0 ? admin.from("motorist_operator_presence").select("*").eq("organization_id", organizationId).in("profile_id", ids) : Promise.resolve({ data: [] as PresenceRow[], error: null }),
      ids.length > 0 ? admin.from("motorist_operator_devices").select("*").eq("organization_id", organizationId).eq("environment", deps.environment).in("profile_id", ids) : Promise.resolve({ data: [] as DeviceRow[], error: null }),
      ids.length > 0
        ? admin.from("motorist_ring_attempts").select("profile_id, session_id").eq("organization_id", organizationId).eq("result", "offered").in("profile_id", ids).neq("session_id", session.id)
        : Promise.resolve({ data: [] as Array<{ profile_id: string | null; session_id: string }>, error: null }),
      admin
        .from("motorist_call_legs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .is("ended_at", null)
        // Bounded: a leg orphaned by a lost `call.hangup` webhook must not eat the
        // org-wide capacity forever (the sweep closes them, see `closeOrphanLegs`).
        .gte("initiated_at", new Date(now.getTime() - ACTIVE_LEG_WINDOW_MS).toISOString()),
    ]));
    if (presenceResult.error) throw new Error(`presence load failed: ${presenceResult.error.message}`);
    if (devicesResult.error) throw new Error(`devices load failed: ${devicesResult.error.message}`);
    if (offersResult.error) throw new Error(`open offers load failed: ${offersResult.error.message}`);
    if (legsResult.error) throw new Error(`leg count failed: ${legsResult.error.message}`);
    presence = (presenceResult.data ?? []) as PresenceRow[];
    devices = (devicesResult.data ?? []) as DeviceRow[];
    openOffers = [...new Set(((offersResult.data ?? []) as Array<{ profile_id: string | null }>).map((row) => row.profile_id).filter((id): id is string => Boolean(id)))];
    activeLegCount = legsResult.count ?? 0;
    if (activeLegCount >= settings.maxConcurrentLegs) {
      // Every ring step would be skipped for `capacity`: make the outage visible.
      deps.logger?.({ level: "warn", scope: "routing", sessionId: session.id, message: "concurrent leg cap reached", activeLegCount, cap: settings.maxConcurrentLegs });
      await recordTelephonyIncident(admin, {
        job: TELEPHONY_INCIDENT_JOBS.capacity,
        error: new Error(`concurrent leg cap reached (${activeLegCount}/${settings.maxConcurrentLegs})`),
        context: { sessionId: session.id },
        now,
      });
    } else {
      // Back under the cap: close the incident (throttled per instance) so the
      // health surface does not report telephony as permanently overloaded.
      await recoverTelephonyIncidentThrottled(admin, TELEPHONY_INCIDENT_JOBS.capacity, now);
    }
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
    // Only a verified origination number may place calls; the dialled DID is not always one
    // (.context/telnyx-setup.md S3: +421232408700 is rejected with 10010), so the env default wins.
    fromNumber: (config.configured ? config.defaultFromNumber : null) ?? line?.phone_number ?? null,
    mediaAvailable: config.configured ? Boolean(config.mediaBaseUrl) : false,
    announcements: meta.announcements ? readAnnouncementConfig(meta.announcements) : announcementConfigFromMetadata(line?.metadata),
    recordingPolicy,
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
    sleep: sleepOf(deps),
    logger: deps.logger,
    wrapUpSecondsFor: async (profileId) => {
      const { data } = await deps.admin.from("motorist_operator_telephony_settings").select("wrap_up_seconds").eq("profile_id", profileId).maybeSingle();
      return data?.wrap_up_seconds ?? DEFAULT_ROUTING_SETTINGS.wrapUpSecondsDefault;
    },
  };
}

/**
 * Closes the audit trail of every supervision that ended in this transition.
 *
 * The stop button is only one of the ways it can end: the supervisor's browser
 * leg drops, the supervised call ends under them, or the conference join is
 * refused and the compensation clears the entry. All of them go through the
 * reducer, so `metadata.supervise` losing a key is the one signal that covers
 * them — and without it `motorist_audit_log` holds a `supervise.start` with no
 * terminating row, which is exactly the question the audit exists to answer.
 */
async function auditSupervisionEnd(deps: SessionRunnerDeps, before: SessionRow, after: SessionRow, event: SessionEvent, compensated: boolean): Promise<void> {
  const was = readMeta(before).supervise ?? {};
  const now = readMeta(after).supervise ?? {};
  const ended = Object.keys(was).filter((profileId) => !now[profileId]);
  if (ended.length === 0) return;
  const reason = compensated
    ? "join_failed"
    : event.kind === "app"
      ? event.type === "stop_supervise"
        ? "stopped"
        : `app:${event.type}`
      : event.type === "call.hangup"
        ? "leg_ended"
        : `telnyx:${event.type}`;
  for (const profileId of ended) {
    await writeCallAudit(
      { admin: deps.admin, organizationId: deps.organizationId, logger: deps.logger },
      {
        action: "telephony.supervise.stop",
        actorProfileId: profileId,
        entityId: after.id,
        before: { mode: was[profileId]?.mode ?? null, started_at: was[profileId]?.at ?? null },
        after: { supervisor: profileId, reason, operator: after.answered_by_profile_id },
        source: event.kind === "app" ? "dispatch_console" : "telephony",
      },
    );
  }
}

/** Entry point for per-session webhook bookkeeping and other short DB work.
 * V2 scopes are reusable only for the same session. Never transfer a generation
 * from a freshly read row into a running invocation.
 */
export type SessionOwnershipDeps = Pick<SessionRunnerDeps, "admin" | "organizationId" | "leaseTtlMs" | "leaseWaitMs" | "sleep" | "random" | "logger">;

export async function ownedSessionWork<T>(
  deps: SessionOwnershipDeps, sessionId: string, work: () => Promise<T>,
  options: { known?: SessionRow; /** Diagnostics only: names the waiting event in the busy error. */ eventType?: string } = {},
): Promise<T> {
  const existing = sessionOwnership.getStore();
  if (existing) {
    if (existing.sessionId !== sessionId) throw new SessionLeaseLostError();
    // A lease acquired moments ago in this same invocation cannot have expired,
    // and the database fence — not this RPC — is what refuses a stale writer.
    if (Date.now() - existing.acquiredAt >= OWNERSHIP_RENEW_SKIP_MS) await assertOwnership(existing);
    return work();
  }
  // The database controls admission. Before expand, rows have no contract
  // column; after expand, all new writers participate without a second flag.
  // The caller often just read this row (webhook correlation); re-reading it
  // only to look at `writer_contract` is a round trip on the critical path.
  // `writer_contract === undefined` means "no lease at all", so a partial row
  // must never be accepted here: it would silently skip ownership.
  const known = options.known?.id === sessionId && options.known.organization_id === deps.organizationId &&
    options.known.writer_contract !== undefined ? options.known : null;
  const probe = known ? { data: known, error: null }
    : await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", sessionId).abortSignal(AbortSignal.timeout(DATABASE_REQUEST_MS)).maybeSingle();
  if (probe.error) throw new SessionEventDeferredError(`Session ownership lookup failed: ${probe.error.message}`);
  if (!probe.data) throw new SessionNotFoundError(sessionId);
  if (probe.data.writer_contract === undefined) return work();
  const token = randomUUID();
  const started = Date.now();
  const budget = deps.leaseWaitMs ?? LEASE_WAIT_MS;
  // Callbacks (and any waiter with a budget that short) poll the flat ladder;
  // operator controls keep the adaptive one so `LEASE_WAIT_MS` still means the
  // same number of RPCs (session-contention.test.ts "bounds an interactive acquisition").
  const flat = budget <= WEBHOOK_LEASE_WAIT_MS;
  let attempt = 0;
  let polls = 0;
  let claim: { generation: number; contract: number } | null;
  try {
    for (;;) {
      polls += 1;
      claim = await measureRequestStep("lease", () => ownershipRpc<{ generation: number; contract: number } | null>(deps.admin, "motorist_session_lease_acquire_v2", { p_session_id: sessionId, p_token: token, p_ttl_ms: leaseTtl(deps) }));
      if (claim) break;
      const remaining = budget - (Date.now() - started);
      if (remaining <= 0) throw new SessionLeaseBusyError({ leaseWaitMs: budget, polls, eventType: options.eventType });
      // Give the active writer room to finish. A fixed 50 ms retry made each
      // contending webhook/control issue up to 17 RPCs during one busy call.
      if (flat && attempt >= WEBHOOK_LEASE_POLL_MS.length) throw new SessionLeaseBusyError({ leaseWaitMs: budget, polls, eventType: options.eventType });
      const step = flat ? WEBHOOK_LEASE_POLL_MS[attempt++] : Math.min(800, 150 * 2 ** Math.min(attempt++, 3));
      await sleepOf(deps)(Math.min(remaining, step + Math.floor((deps.random ?? Math.random)() * 75)));
    }
  } catch (error) {
    if (error instanceof SessionEventDeferredError) throw error;
    throw new SessionEventDeferredError(error instanceof Error ? error.message : "Session lease unavailable");
  }
  const owner: Ownership = { admin: deps.admin, sessionId, organizationId: deps.organizationId, token,
    generation: claim.generation, contract: claim.contract, deadline: Date.now() + SESSION_WORK_MS,
    acquiredAt: Date.now(), leaseWaitMs: Math.max(0, Date.now() - started) };
  try { return await sessionOwnership.run(owner, work); }
  finally {
    // Release failure cannot rewrite a completed operation into a safe retry.
    try { await ownershipRpc(deps.admin, "motorist_session_lease_release_v2", { p_session_id: sessionId, p_token: token, p_generation: owner.generation }); }
    catch (error) { deps.logger?.({ level: "warn", scope: "lease", sessionId, message: "lease release pending expiry", error: error instanceof Error ? error.message : String(error) }); }
  }
}

export async function runSessionEvent(
  deps: SessionRunnerDeps,
  sessionId: string,
  event: SessionEvent,
  options?: { known?: SessionRow },
): Promise<SessionRunResult> {
  let known: SessionRow | undefined = options?.known;
  if (event.kind === "app" && event.type === "hangup") {
    // A console action has already loaded this row to authorise itself, and
    // the only field wanted here is `writer_contract`, which terminating never
    // changes — so re-reading it was a round trip in front of the one command
    // an operator most wants to be instant.
    const target = known
      ? { data: known, error: null as null }
      : await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", sessionId).abortSignal(AbortSignal.timeout(DATABASE_REQUEST_MS)).maybeSingle();
    if (target.error) throw new SessionEventDeferredError(`Termination intent lookup failed: ${target.error.message}`);
    // Both this read and the ownership probe happen before the lease, and the
    // probe only inspects `writer_contract`, which terminating never changes.
    known = target.data ?? undefined;
    if (target.data?.writer_contract === 2) await ownershipRpc(deps.admin, "motorist_session_terminate_v2", { p_organization_id: deps.organizationId, p_session_id: sessionId });
  }
  // Timer sweeps are opportunistic: never queue repeated lock acquisition
  // ahead of an operator's control or a real provider fact.
  const ownershipDeps = event.kind === "app" && event.type === "sweep" ? { ...deps, leaseWaitMs: 0 } : deps;
  return ownedSessionWork(ownershipDeps, sessionId, async () => {
    const owner = sessionOwnership.getStore();
    if (owner) owner.terminationPending = false;
    const result = await runOwnedSessionEvent(deps, sessionId, event, owner);
    if (owner?.terminationPending && event.kind === "app") throw new SessionTerminationPendingError();
    return result;
  }, { known, eventType: `${event.kind}.${event.type}` });
}

async function runOwnedSessionEvent(deps: SessionRunnerDeps, sessionId: string, event: SessionEvent, owner?: Ownership): Promise<SessionRunResult> {
  const runnerStarted = nowOf(deps)();
  const token = owner?.token ?? randomUUID();
  let leaseAcquired: boolean;
  try { leaseAcquired = Boolean(owner) || await measureRequestStep("lease", () => acquireSessionLease(deps, sessionId, token)); }
  catch (error) { throw new SessionEventDeferredError(error instanceof Error ? error.message : "Session lease unavailable"); }
  const leaseWaitMs = owner?.leaseWaitMs ?? nowOf(deps)().getTime() - runnerStarted.getTime();
  const timing = (effectsStarted?: Date) => {
    const completed = nowOf(deps)();
    return { runner_started_at: runnerStarted.toISOString(), lease_wait_ms: Math.max(0, leaseWaitMs),
      ...(effectsStarted ? { effects_started_at: effectsStarted.toISOString() } : {}),
      completed_at: completed.toISOString(), processing_ms: Math.max(0, completed.getTime() - runnerStarted.getTime()) };
  };
  if (!leaseAcquired) deps.logger?.({ level: "warn", scope: "lease", sessionId, eventId: event.id, message: "lease unavailable; checking whether event can safely proceed" });
  const maxRetries = deps.maxConflictRetries ?? MAX_CONFLICT_RETRIES;
  let effectsMayHaveStarted = false;

  try {
    for (let retries = 0; ; retries += 1) {
      let snapshot: Awaited<ReturnType<typeof loadSessionSnapshot>>;
      try {
        snapshot = await loadSessionSnapshot(deps, sessionId);
      } catch (error) {
        if (error instanceof SessionNotFoundError || effectsMayHaveStarted) throw error;
        throw new SessionEventDeferredError(error instanceof Error ? error.message : "session snapshot unavailable");
      }
      const durable = snapshot.session.writer_contract === 2 || telephonyStabilityEnabled() || hasStabilityContract(snapshot.session);
      if (owner?.contract === 2 && snapshot.session.termination_requested_at &&
        !readMeta(snapshot.session).hangup && ACTIVE_SESSION_STATES.has(snapshot.session.state) && snapshot.legs.length &&
        !(event.kind === "app" && event.type === "hangup")) {
        // An authorized hangup can commit its intent while another webhook
        // owns the lease. Its original request may then time out. Resume that
        // durable intent at the next acquired lease, including the inbound
        // customer, which has no POST /calls journal entry to compensate.
        const termination = await runOwnedSessionEvent(deps, sessionId, {
          kind: "app", type: "hangup", id: `termination:${sessionId}:${snapshot.session.termination_requested_at}`,
          actorProfileId: null, occurredAt: snapshot.session.termination_requested_at,
        }, owner);
        effectsMayHaveStarted = true;
        if (event.kind === "app" && event.type === "sweep") return termination;
        // Preserve the original provider fact after applying the stop intent;
        // never acknowledge a hangup webhook without closing its exact leg.
        snapshot = await loadSessionSnapshot(deps, sessionId);
      }
      if (owner?.contract === 2 && event.kind === "telnyx") await reconcileProviderEvent(deps.admin, sessionId, event, deps.telnyx);
      if (owner?.contract === 2 && event.kind === "telnyx" && event.rawClientState && event.callControlId && ["call.initiated", "call.answered", "call.hangup"].includes(event.type)) {
        await ownershipRpc(deps.admin, "motorist_provider_observe_dial_v2", { p_session_id: sessionId,
          p_client_state: event.rawClientState, p_call_control_id: event.callControlId, p_call_leg_id: event.callLegId,
          p_call_session_id: event.callSessionId, p_alive: event.type !== "call.hangup" });
      }
      if (owner?.contract === 2 && snapshot.session.termination_requested_at && !(event.kind === "app" && event.type === "hangup")) {
        effectsMayHaveStarted = true;
        owner.terminationPending = await reconcileTermination(deps, sessionId);
      }
      // This verdict needs only the session. Loading every routing dependency
      // before returning it needlessly extends contention for both invocations.
      if (durable && !leaseAcquired) {
        if (event.kind === "app" && event.type === "sweep") {
          return { outcome: "ignored", reason: "sweep deferred while another event owns the session", session: snapshot.session, leaseAcquired, retries };
        }
        // Contract 1 only: the poll count lives in `ownedSessionWork`, not here.
        throw new SessionLeaseBusyError({ leaseWaitMs: deps.leaseWaitMs ?? LEASE_WAIT_MS, polls: 0, eventType: `${event.kind}.${event.type}` });
      }
      let context: RoutingContext;
      try {
        context = await loadRoutingContext(deps, snapshot.session, event, snapshot.legs);
      } catch (error) {
        if (effectsMayHaveStarted) throw error;
        // A failed read has not applied this event or run compensation. Keep
        // its claim retryable just like a contended lease, not an HTTP 200 loss.
        throw new SessionEventDeferredError(error instanceof Error ? error.message : "routing context unavailable");
      }
      context.recordingLeaseHeld = leaseAcquired;
      const recordingLeaseRequired = requiresRecordingLease(snapshot.session, context);
      const effects: EffectsDeps = { ...effectsDeps(deps), eventTiming: () => timing(), renewLease: leaseAcquired ? () => renewSessionLease(deps, sessionId, token, recordingLeaseRequired || durable) : undefined };
      if (!leaseAcquired && (recordingLeaseRequired || durable) && event.kind === "app" && event.type === "sweep") {
        // Polling is retried by the next poll/cron. It must not erase the active
        // owner's recording or pending audio intent by changing capture policy.
        deps.logger?.({ scope: "session", sessionId, eventId: event.id, code: "sweep_deferred_lease_busy", leaseAcquired });
        return { outcome: "ignored", reason: "sweep deferred while another event owns the session", session: snapshot.session, leaseAcquired, retries };
      }
      if (snapshot.session.presence_cancellations && Object.keys(snapshot.session.presence_cancellations).length) {
        effectsMayHaveStarted = true;
        await cancelRevokedOffers(effects, snapshot.session, event.kind === "telnyx" && event.callControlId && event.clientState ? { callControlId: event.callControlId, clientState: event.clientState } : undefined);
      }
      if (readPendingEffects(snapshot.session).entries.length) {
        const preemptsAudio = event.kind === "telnyx" ? event.type === "call.hangup" : !["sweep", "pickup", "recording_continue"].includes(event.type);
        try {
          effectsMayHaveStarted = true;
          const resumed = await resumePendingEffects(effects, snapshot.session, { databaseOnly: preemptsAudio, skipCompletedProjections: event.kind !== "app" || event.type !== "sweep" });
          if (resumed?.failed && !preemptsAudio && event.kind === "app") return { outcome: "applied", apply: resumed, session: resumed.session, leaseAcquired, retries, stateBefore: snapshot.session.state, commands: resumed.commands };
        } catch (error) {
          if (!preemptsAudio) throw error;
          deps.logger?.({ level: "warn", scope: "effects", sessionId, code: "bookkeeping_deferred_for_teardown" });
        }
        snapshot = await loadSessionSnapshot(deps, sessionId);
        // Resuming a guarded winner can revoke other offers after the initial
        // cancellation pass. Finish those newly staged obligations in this turn.
        if (snapshot.session.cancellations_next_attempt_at) {
          await cancelRevokedOffers(effects, snapshot.session);
          snapshot = await loadSessionSnapshot(deps, sessionId);
        }
      }
      if (!leaseAcquired && recordingLeaseRequired && event.kind === "app" && event.type !== "hangup") {
        throw new SessionEventDeferredError("Prebieha zmena nahrávania. Zopakujte akciu o chvíľu.");
      }
      const previousContact = JSON.stringify(readContactHistory(snapshot.session));
      if (durable || readContactHistory(snapshot.session).operations.length) {
        snapshot.session = { ...snapshot.session, metadata: toJson({ ...readMeta(snapshot.session), callback_contact: collectContactProof(snapshot, event) }) };
      }
      let result = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, context);
      if (!leaseAcquired && recordingLeaseRequired && event.kind === "telnyx" && event.type !== "call.hangup" && result.commands.length) {
        // The webhook ledger retains this event for retry. Pure bookkeeping
        // (e.g. conference.created) may advance version without owning media.
        throw new SessionEventDeferredError("Prebieha zmena nahrávania. Zopakujte akciu o chvíľu.");
      }
      if (result.ignored && JSON.stringify(readContactHistory(snapshot.session)) !== previousContact) {
        const next = emptyTransition();
        next.session.metadata = snapshot.session.metadata;
        result = { next, commands: [], compensations: [], guard: null, ignored: null };
      }
      attachContactOperations(snapshot, result, event, durable);

      if (result.ignored) {
        await recordCallEvent(effects, {
          session: snapshot.session,
          event,
          handledStatus: "ignored",
          stateBefore: snapshot.session.state,
          stateAfter: snapshot.session.state,
          notes: [result.ignored],
          commands: [],
          timing: timing(),
        });
        return { outcome: "ignored", reason: result.ignored, session: snapshot.session, leaseAcquired, retries };
      }

      try {
        const effectsStarted = nowOf(deps)();
        effects.eventTiming = () => timing(effectsStarted);
        effectsMayHaveStarted = true;
        let apply = await applyReduceResult(effects, { session: snapshot.session, result, event, expectedVersion: snapshot.session.version });
        if (owner?.contract === 2 && snapshot.session.termination_requested_at && event.kind === "app" && event.type === "hangup") {
          // Stop the caller through the durable hangup transition first. Late
          // outbound acceptances are independent cleanup obligations afterward.
          owner.terminationPending = await reconcileTermination(deps, sessionId);
        }
        // Complete only bounded internal continuations while retaining this event's lease.
        // These are command acknowledgements, never fabricated provider webhooks.
        // A follow `sweep` after a failed gather plans the next ring step, and a
        // lean context carries an empty presence and device list rather than an
        // absent one — it would step over everybody. Pay for the full context
        // once, here, where it is rare, instead of on the answer itself.
        let followContext = context;
        for (let continuation = 0; continuation < 2; continuation += 1) {
          const meta = readMeta(apply.session);
          const sequence = meta.announcement_sequence;
          const stopReady = needsRecordingContinuation(apply.session);
          const mediaFailed = sequence && Date.parse(sequence.deadlineAt) <= nowOf(deps)().getTime() ||
            meta.gather?.failed && !meta.gather.call_gone && Date.parse(meta.gather.deadline_at) <= nowOf(deps)().getTime();
          if ((!stopReady && !mediaFailed) || stopReady && !leaseAcquired) break;
          const fresh = await loadSessionSnapshot(deps, sessionId);
          const followEvent: SessionEvent = { kind: "app", type: stopReady ? "recording_continue" : "sweep", id: `${event.id}:continue:${continuation}`, actorProfileId: null, occurredAt: nowOf(deps)().toISOString() };
          if (followContext.lean) followContext = await loadRoutingContext(deps, fresh.session, followEvent, fresh.legs);
          const follow = reduce(fresh.session, fresh.legs, fresh.attempts, followEvent, { ...followContext, now: nowOf(deps)() });
          if (follow.ignored) break;
          attachContactOperations(fresh, follow, followEvent, durable);
          const nextApply = await applyReduceResult(effects, { session: fresh.session, result: follow, event: followEvent, expectedVersion: fresh.session.version });
          apply = { ...nextApply, commands: [...apply.commands, ...nextApply.commands], notes: [...apply.notes, ...nextApply.notes] };
        }
        if (apply.session.cancellations_next_attempt_at && Date.parse(apply.session.cancellations_next_attempt_at) <= nowOf(deps)().getTime()) {
          await cancelRevokedOffers(effects, apply.session);
          apply = { ...apply, session: (await loadSessionSnapshot(deps, sessionId)).session };
        }
        if (!durable) await recordCallEvent(effects, {
          session: apply.session,
          event,
          handledStatus: apply.failed ? "failed" : "processed",
          stateBefore: snapshot.session.state,
          stateAfter: apply.session.state,
          notes: [...apply.notes, ...apply.compensations.map((entry) => `compensation: ${entry}`)],
          commands: auditCommandOutcomes(apply.commands),
          timing: timing(effectsStarted),
          error: apply.failure?.error ?? null,
        });
        await auditSupervisionEnd(deps, snapshot.session, apply.session, event, apply.compensations.length > 0);
        if (!apply.failed && (["ringing", "waiting", "parked", "consulting", "conference"].includes(apply.session.state) || readMeta(apply.session).party_pending)) {
          try { deps.onCallTransition?.(sessionId); }
          catch {
            // A notification scheduler cannot change the result of a SIP command.
            deps.logger?.({ level: "warn", scope: "call-push", sessionId, message: "notification scheduling unavailable" });
          }
        }
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
    if (leaseAcquired && !owner) await releaseSessionLease(deps, sessionId, token);
  }
}
