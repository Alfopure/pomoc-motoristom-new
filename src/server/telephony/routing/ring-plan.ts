import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { isDestinationAllowed } from "@/lib/telephony/destinations";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import { hasStabilityContract, telephonyStabilityEnabled } from "../stability";
import { SessionLeaseBusyError } from "../service-errors";
import { readPendingEffects } from "../state/continuation";
import type { PauseRoutingMode } from "@/lib/telephony/operator-settings";

import {
  MAX_CONCURRENT_LEGS,
  MAX_RING_FANOUT,
  RING_STEP_GRACE_SECS,
  WAITING_TICK_STALE_MS,
  GREETING_TIMEOUT_MS,
  DEFAULT_ROUTING_SETTINGS,
  readMeta,
  isGatherOverdue,
  type AppEvent,
  type AttemptRow,
  type AttemptPlan,
  type DeviceRow,
  type FrozenRingMember,
  type FrozenRingPlan,
  type FrozenRingStep,
  type PresenceRow,
  type SessionRow,
  type TelephonyEnvironment,
  TERMINAL_STATES,
} from "../state/types";
import { evaluateMemberEligibility, type EligibilityDevice, type EligibilityPresence, type IneligibilityReason } from "./eligibility";

/**
 * Ring plans (design §2.6).
 *
 * - `materialiseRingPlan` reads the configuration tables and returns a frozen
 *   snapshot; the reducer stores it in `motorist_call_sessions.metadata.ring.plan`
 *   at ring start so later configuration edits never alter a live call.
 * - `planRingStep` (pure) decides whom to dial for one step: strategy `all`
 *   dials every eligible member at once (capped by `MAX_RING_FANOUT` and the
 *   org-wide `MAX_CONCURRENT_LEGS`), strategy `ordered` dials one member at a
 *   time in `position` order, each for `max(5, ring_secs ?? step timeout)`.
 * - `advanceRingStep` wraps the compare-and-set RPC so that only one
 *   invocation fans out a step.
 * - `sweepOverdueRingSteps` re-drives sessions whose step deadline passed
 *   without the expected hangup webhooks.
 */

type AdminClient = SupabaseClient<Database>;

export const MIN_MEMBER_RING_SECS = 5;
export const MAX_MEMBER_RING_SECS = 120;
export const DEFAULT_STEP_TIMEOUT_SECS = 20;
export const ACTIVE_LEG_WINDOW_MS = 4 * 60 * 60 * 1000;
export const QUEUE_OPERATOR_RETRY_MS = 60_000;

/** Shared by the leased reducer and the advisory queue prefilter. */
export function queueOperatorMembers(plan: FrozenRingPlan, attempts: AttemptRow[], now: Date, dueNow: boolean): FrozenRingMember[] {
  const lastOffered = new Map<string, number>();
  for (const attempt of attempts) if (attempt.profile_id) {
    lastOffered.set(attempt.profile_id, Math.max(lastOffered.get(attempt.profile_id) ?? 0, Date.parse(attempt.offered_at ?? attempt.created_at)));
  }
  return [...new Map([...(plan.queueMembers ?? []), ...plan.steps.flatMap(step => step.members)]
    .filter(member => member.kind === "operator" && member.profileId).map(member => [member.profileId, member])).values()]
    .filter(member => !dueNow || (lastOffered.get(member.profileId!) ?? 0) + QUEUE_OPERATOR_RETRY_MS <= now.getTime())
    .sort((a, z) => (lastOffered.get(a.profileId!) ?? 0) - (lastOffered.get(z.profileId!) ?? 0) || a.position - z.position);
}

export function planQueueStep(plan: FrozenRingPlan, index: number, members: FrozenRingMember[], input: RingStepPlanInput): RingStepPlanResult {
  return planRingStep({ index, groupId: plan.steps[0].groupId, groupName: "Čakáreň", strategy: "ordered", timeoutSecs: 20,
    members: members.map((member, position) => ({ ...member, position, ringSecs: Math.max(20, member.ringSecs) })) }, { ...input, maxFanout: 1 });
}

export function clampRingSecs(value: number | null | undefined, fallback: number): number {
  const base = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(MAX_MEMBER_RING_SECS, Math.max(MIN_MEMBER_RING_SECS, Math.round(base)));
}

/** Natural key of a member / attempt (`profile:<id>` or `number:<e164>`). */
export function memberKey(member: { profileId: string | null; externalNumber: string | null }): string {
  return member.profileId ? `profile:${member.profileId}` : `number:${member.externalNumber ?? ""}`;
}

export type PausedOperatorRouting = {
  profileId: string;
  mode: PauseRoutingMode;
  defaultMobileNumber: string | null;
  forwardProfileId: string | null;
  forwardNumber: string | null;
};

/**
 * Allows a paused operator to nominate a colleague. Personal phone forwarding
 * is retired: the saved number never makes a paused operator reachable. The
 * original position and ring time stay intact, preserving both `ordered` and
 * `all` ring-group semantics. Invalid or newly disallowed settings deliberately
 * fall back to the original paused member, which eligibility will skip.
 */
export function applyPausedOperatorRouting(
  members: readonly FrozenRingMember[],
  input: {
    pausedProfileIds: ReadonlySet<string>;
    routing: readonly PausedOperatorRouting[];
    destinationAllowlist: readonly string[];
  },
): FrozenRingMember[] {
  const routingByProfile = new Map(input.routing.map((row) => [row.profileId, row]));
  const resolved: FrozenRingMember[] = [];
  const seen = new Set<string>();

  for (const member of members) {
    let next = member;
    if (member.kind === "operator" && member.profileId && input.pausedProfileIds.has(member.profileId)) {
      const route = routingByProfile.get(member.profileId);
      // Legacy personal forwarding must never make a pause reachable.
      if (route?.mode === "operator" && route.forwardProfileId && route.forwardProfileId !== member.profileId) {
        next = { ...member, kind: "operator", profileId: route.forwardProfileId, externalNumber: null, memberId: null };
      }
    }

    const key = memberKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(next);
  }
  return resolved;
}

export type PersonalRoutingRow = { profile_id: string; default_mobile_number: string | null; delivery_mode?: "web" | "personal_mobile" };

type Tables = Database["public"]["Tables"];
export type RingPlanRows = {
  plan: Tables["motorist_ring_plans"]["Row"] | null;
  steps: readonly Tables["motorist_ring_plan_steps"]["Row"][];
  groups: readonly Tables["motorist_ring_groups"]["Row"][];
  members: readonly Tables["motorist_ring_group_members"]["Row"][];
  operatorRouting: readonly Tables["motorist_operator_telephony_settings"]["Row"][];
  pausedProfileIds: ReadonlySet<string>;
  destinationAllowlist: readonly string[];
  personalMobileEnabled: boolean;
  now: Date;
};

/** Re-evaluated for frozen plans too; a typed external number cannot evade pause. */
export function resolvePersonalRingMembers(members: readonly FrozenRingMember[], rows: readonly PersonalRoutingRow[], allowlist: readonly string[], createMobile = false): FrozenRingMember[] {
  return members.map((member) => {
    const settings = rows.find((row) => row.profile_id === member.profileId);
    if (createMobile && member.kind === "operator" && settings?.delivery_mode === "personal_mobile") {
      const number = normalizeE164(settings.default_mobile_number);
      if (number && isDestinationAllowed(number, allowlist)) return { ...member, kind: "external_number", externalNumber: number, ownerProfileId: member.profileId, provenance: "personal_mobile" };
    }
    if (member.kind !== "external_number") return member;
    const number = normalizeE164(member.externalNumber);
    const owners = rows.filter((row) => number && normalizeE164(row.default_mobile_number) === number);
    // Ambiguous numbers are conservatively unavailable, never independent backup.
    const owner = member.ownerProfileId ?? member.profileId ?? (owners.length === 1 ? owners[0].profile_id : owners.length > 1 ? "ambiguous-personal-number" : null);
    return { ...member, profileId: owner, ownerProfileId: owner, provenance: owner ? "personal_mobile" : "configured_external" };
  });
}

export async function materialiseRingPlan(
  admin: AdminClient,
  input: { organizationId: string; ringPlanId: string; now?: Date },
): Promise<FrozenRingPlan | null> {
  const plan = await admin.from("motorist_ring_plans").select("*").eq("organization_id", input.organizationId).eq("id", input.ringPlanId).maybeSingle();
  if (plan.error) throw new Error(`ring plan load failed: ${plan.error.message}`);
  if (!plan.data || !plan.data.active) return null;

  const steps = await admin
    .from("motorist_ring_plan_steps")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("ring_plan_id", plan.data.id)
    .order("step_index", { ascending: true });
  if (steps.error) throw new Error(`ring plan steps load failed: ${steps.error.message}`);
  const stepRows = steps.data ?? [];
  const groupIds = [...new Set(stepRows.map((step) => step.ring_group_id))];

  const [groups, members] =
    groupIds.length > 0
      ? await Promise.all([
          admin.from("motorist_ring_groups").select("*").eq("organization_id", input.organizationId).in("id", groupIds),
          admin
            .from("motorist_ring_group_members")
            .select("*")
            .eq("organization_id", input.organizationId)
            .in("ring_group_id", groupIds)
            .order("position", { ascending: true }),
        ])
      : [
          { data: [], error: null },
          { data: [], error: null },
        ];
  if (groups.error) throw new Error(`ring groups load failed: ${groups.error.message}`);
  if (members.error) throw new Error(`ring group members load failed: ${members.error.message}`);

  // Read all personal numbers: an external member may be the same number as an
  // operator outside this group. select(*) remains compatible with old schemas.
  const [paused, operatorRouting, telephonySettings] = await Promise.all([
    admin.from("motorist_operator_presence").select("*").eq("organization_id", input.organizationId).eq("status", "paused"),
    admin.from("motorist_operator_telephony_settings").select("*").eq("organization_id", input.organizationId),
    admin.from("motorist_telephony_settings").select("destination_allowlist").eq("organization_id", input.organizationId).maybeSingle(),
  ]);
  if (paused.error || operatorRouting.error || telephonySettings.error) throw new Error("operator routing load failed");
  return materialiseRingPlanRows({
    plan: plan.data, steps: stepRows, groups: groups.data ?? [], members: members.data ?? [],
    operatorRouting: operatorRouting.data ?? [],
    pausedProfileIds: new Set((paused.data ?? []).map((row) => row.profile_id)),
    destinationAllowlist: telephonySettings.data?.destination_allowlist ?? ["SK", "CZ"],
    personalMobileEnabled: telephonyStabilityEnabled(), now: input.now ?? new Date(),
  });
}

/** Shared by the legacy queries and the fresh, event-local routing snapshot. */
export function materialiseRingPlanRows(input: RingPlanRows): FrozenRingPlan | null {
  const { plan, pausedProfileIds, destinationAllowlist, operatorRouting: routingRows } = input;
  if (!plan?.active) return null;
  const pausedRouting: PausedOperatorRouting[] = routingRows.map((row) => ({
    profileId: row.profile_id, mode: row.pause_routing_mode, defaultMobileNumber: row.default_mobile_number,
    forwardProfileId: row.pause_forward_profile_id, forwardNumber: row.pause_forward_number,
  }));
  const groupById = new Map(input.groups.map((group) => [group.id, group]));
  const frozenSteps: FrozenRingStep[] = [];
  const queueMembers: FrozenRingMember[] = [];
  for (const step of input.steps.filter((row) => row.ring_plan_id === plan.id).sort((left, right) => left.step_index - right.step_index)) {
    const group = groupById.get(step.ring_group_id);
    if (!group || !group.active) continue;
    const timeoutSecs = clampRingSecs(step.timeout_secs, DEFAULT_STEP_TIMEOUT_SECS);
    const configuredMembers: FrozenRingMember[] = input.members
      .filter((member) => member.ring_group_id === group.id)
      .map((member) => ({
        kind: member.member_kind,
        profileId: member.member_kind === "operator" ? member.profile_id : member.owner_profile_id ?? null,
        ownerProfileId: member.owner_profile_id ?? null,
        externalNumber: member.member_kind === "external_number" ? member.external_number : null,
        position: member.position,
        ringSecs: clampRingSecs(member.ring_secs, timeoutSecs),
        memberId: member.id,
      }))
      .filter((member) => (member.kind === "operator" ? Boolean(member.profileId) : Boolean(member.externalNumber)))
      .sort((left, right) => left.position - right.position);
    const stepMembers = resolvePersonalRingMembers(applyPausedOperatorRouting(configuredMembers, { pausedProfileIds, routing: pausedRouting, destinationAllowlist }), routingRows, destinationAllowlist, input.personalMobileEnabled);
    queueMembers.push(...configuredMembers.filter((member) => member.kind === "operator"));
    frozenSteps.push({
      index: frozenSteps.length,
      groupId: group.id,
      groupName: group.name,
      strategy: step.strategy === "ordered" ? "ordered" : "all",
      timeoutSecs,
      members: stepMembers,
    });
  }

  return {
    planId: plan.id,
    name: plan.name,
    fallback: { kind: plan.fallback_kind, number: plan.fallback_number ?? null },
    steps: frozenSteps,
    queueMembers,
    frozenAt: input.now.toISOString(),
  };
}

export function toEligibilityPresence(rows: PresenceRow[]): EligibilityPresence[] {
  return rows.map((row) => ({ profileId: row.profile_id, status: row.status, currentSessionId: row.current_session_id, wrapUpUntil: row.wrap_up_until, pauseReturn: row.pause_return }));
}

export function toEligibilityDevices(rows: DeviceRow[]): EligibilityDevice[] {
  return rows.map((row) => ({ profileId: row.profile_id, deviceSeenAt: row.device_seen_at, registrationState: row.registration_state, sipUsername: row.sip_username }));
}

export type RingStepPlanInput = {
  /** Existing v1 sessions may finish during rollback; new owned PSTN stays gated. */
  ownedPstnEnabled?: boolean;
  sessionId: string;
  now: Date;
  presence: EligibilityPresence[];
  devices: EligibilityDevice[];
  openOffers: string[];
  /** Member keys already attempted in this step (any result). */
  attempted: ReadonlySet<string>;
  maxFanout?: number;
  maxConcurrentLegs?: number;
  activeLegCount?: number;
};

export type RingStepSkip = { member: FrozenRingMember; reason: IneligibilityReason | "attempted" | "capacity" | "fanout" | "feature_disabled" };

export type RingStepPlanResult = {
  attempts: AttemptPlan[];
  members: FrozenRingMember[];
  skipped: RingStepSkip[];
  /** True when eligible members were left out because of the leg cap. */
  capacityLimited: boolean;
  /** Ring time of this fan-out (step timeout for `all`, the member's own for `ordered`). */
  ringSecs: number;
  /** True when the step has no members left to try after this fan-out. */
  exhaustedAfter: boolean;
};

export function planRingStep(step: FrozenRingStep, input: RingStepPlanInput): RingStepPlanResult {
  const maxFanout = Math.max(1, input.maxFanout ?? MAX_RING_FANOUT);
  const capacity = Math.max(0, (input.maxConcurrentLegs ?? MAX_CONCURRENT_LEGS) - (input.activeLegCount ?? 0));
  const skipped: RingStepSkip[] = [];
  const eligible: FrozenRingMember[] = [];

  for (const member of [...step.members].sort((left, right) => left.position - right.position)) {
    if (member.kind === "external_number" && (member.ownerProfileId || member.profileId) && !(input.ownedPstnEnabled ?? telephonyStabilityEnabled())) {
      skipped.push({ member, reason: "feature_disabled" });
      continue;
    }
    if (input.attempted.has(memberKey(member))) {
      skipped.push({ member, reason: "attempted" });
      continue;
    }
    const decision = evaluateMemberEligibility(
      member.kind === "operator" ? { kind: "operator", profileId: member.profileId ?? "" } : { kind: "external_number", externalNumber: member.externalNumber ?? "", ownerProfileId: member.ownerProfileId ?? member.profileId },
      { now: input.now, presence: input.presence, devices: input.devices, openOffers: input.openOffers, sessionId: input.sessionId },
    );
    if (!decision.eligible) {
      skipped.push({ member, reason: decision.reason });
      continue;
    }
    eligible.push(member);
  }

  const wanted = step.strategy === "ordered" ? eligible.slice(0, 1) : eligible.slice(0, maxFanout);
  if (step.strategy === "all") {
    for (const member of eligible.slice(maxFanout)) skipped.push({ member, reason: "fanout" });
  }
  const chosen = wanted.slice(0, capacity);
  for (const member of wanted.slice(capacity)) skipped.push({ member, reason: "capacity" });

  const ringSecs = step.strategy === "ordered" && chosen[0] ? chosen[0].ringSecs : step.timeoutSecs;
  const attempts: AttemptPlan[] = chosen.map((member) => ({
    stepIndex: step.index,
    ringGroupId: step.groupId,
    memberKind: member.kind,
    profileId: member.profileId,
    externalNumber: member.externalNumber,
    position: member.position,
    ringSecs: step.strategy === "ordered" ? member.ringSecs : step.timeoutSecs,
  }));

  const remainingAfter = step.strategy === "ordered" ? eligible.length - chosen.length : 0;
  return {
    attempts,
    members: chosen,
    skipped,
    capacityLimited: wanted.length > chosen.length,
    ringSecs,
    exhaustedAfter: remainingAfter === 0,
  };
}

export function stepDeadline(now: Date, ringSecs: number, graceSecs: number = RING_STEP_GRACE_SECS): string {
  return new Date(now.getTime() + (ringSecs + graceSecs) * 1000).toISOString();
}

/** Compare-and-set on `current_step`; true for the winner only. */
export async function advanceRingStep(admin: AdminClient, sessionId: string, expectedStep: number): Promise<boolean> {
  const { data, error } = await admin.rpc("motorist_advance_ring_step", { p_session_id: sessionId, p_expected_step: expectedStep });
  if (error) throw new Error(`motorist_advance_ring_step failed: ${error.message}`);
  return data === true;
}

function ms(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** A ringing session whose step deadline (ring time + grace) has passed. */
export function isRingStepOverdue(session: SessionRow, now: Date): boolean {
  if (session.state !== "ringing") return false;
  if (isQueueExpired(session, now)) return true;
  const deadline = ms(readMeta(session).ring?.step_deadline_at);
  return deadline !== null && deadline < now.getTime();
}

function isQueueExpired(session: SessionRow, now: Date): boolean {
  const meta = readMeta(session);
  const since = ms(meta.waiting?.since);
  return Boolean(meta.queue && since !== null && since + (meta.waiting?.max_minutes ?? 30) * 60_000 <= now.getTime());
}

export function isQueueOfferDue(session: SessionRow, now: Date): boolean {
  if (session.state !== "waiting") return false;
  const next = ms(readMeta(session).queue?.next_offer_at);
  return next !== null && (next <= now.getTime() || isQueueExpired(session, now));
}

/** A waiting/parked session whose MOH tick has not re-armed for `WAITING_TICK_STALE_MS`. */
export function isWaitingTickStale(session: SessionRow, now: Date, staleMs: number = WAITING_TICK_STALE_MS): boolean {
  if (session.state !== "waiting" && session.state !== "parked") return false;
  const waiting = readMeta(session).waiting;
  const last = ms(waiting?.last_tick_at) ?? ms(waiting?.since) ?? ms(session.parked_at) ?? ms(session.updated_at);
  return last !== null && last + staleMs < now.getTime();
}

export function isGreetingOverdue(session: SessionRow, now: Date): boolean {
  if (session.state !== "greeting") return false;
  const greeting = readMeta(session).greeting;
  const started = ms(greeting?.started_at) ?? ms(session.created_at);
  const deadline = ms(greeting?.deadline_at) ?? (started !== null ? started + GREETING_TIMEOUT_MS : null);
  return deadline !== null && deadline < now.getTime();
}

/** `wrap_up` / `missed` sessions untouched for two minutes (leg hangup webhooks lost). */
export const STALE_SESSION_MS = 120_000;

export function isSessionStale(session: SessionRow, now: Date, staleMs: number = STALE_SESSION_MS): boolean {
  if (session.state !== "wrap_up" && session.state !== "missed") return false;
  const updated = ms(session.updated_at);
  return updated !== null && updated + staleMs < now.getTime();
}

/** Upper bound on the scan itself; the stalest sessions come first. */
export const OVERDUE_SCAN_LIMIT = 200;

export async function findOverdueSessions(admin: AdminClient, input: { organizationId: string; now: Date; scanLimit?: number }): Promise<{ greeting: SessionRow[]; ringing: SessionRow[]; waiting: SessionRow[]; stale: SessionRow[]; media: SessionRow[] }> {
  const { data, error } = await admin
    .from("motorist_call_sessions")
    .select("*")
    .eq("organization_id", input.organizationId)
    .in("state", ["greeting", "ivr", "after_hours", "callback_offered", "ringing", "waiting", "parked", "wrap_up", "missed", "talking", "held", "consulting", "conference"])
    .order("updated_at", { ascending: true })
    .limit(input.scanLimit ?? OVERDUE_SCAN_LIMIT);
  if (error) throw new Error(`overdue session scan failed: ${error.message}`);
  const rows = data ?? [];
  return {
    greeting: rows.filter((row) => isGreetingOverdue(row, input.now)),
    ringing: rows.filter((row) => isRingStepOverdue(row, input.now)),
    waiting: rows.filter((row) => isWaitingTickStale(row, input.now) || isQueueOfferDue(row, input.now))
      .sort((a, b) => (ms(readMeta(a).waiting?.since) ?? ms(a.started_at) ?? 0) - (ms(readMeta(b).waiting?.since) ?? ms(b.started_at) ?? 0)),
    stale: rows.filter((row) => isSessionStale(row, input.now)),
    // Active capture must observe policy revocation on the existing cron, even
    // while people are talking. Media watchdogs are independent of call state.
    media: rows.filter((row) => {
      const meta = readMeta(row);
      return !row.ended_at && (isGatherOverdue(row, input.now) || meta.recording?.recorders.some((item) => item.observed !== "stopped") ||
        (ms(meta.recording?.pendingAudio?.readyAt) ?? Infinity) <= input.now.getTime() ||
        (ms(meta.announcement_sequence?.deadlineAt) ?? Infinity) <= input.now.getTime() ||
        (ms(meta.recording?.barrier?.deadlineAt) ?? Infinity) <= input.now.getTime());
    }),
  };
}

/** Legs left open by a lost `call.hangup` webhook (they would eat `max_concurrent_legs`). */
export const ORPHAN_LEG_MAX_AGE_MS = 4 * 60 * 60 * 1000;
export const ORPHAN_LEG_SCAN_LIMIT = 200;

/**
 * Closes leg rows that can no longer belong to a live call: their session is
 * terminal, or the leg is older than `ORPHAN_LEG_MAX_AGE_MS`. Bookkeeping only —
 * the Telnyx side of such a leg is long gone. A leg whose provider
 * `call.hangup` still sits unprocessed in the ledger (exact `call_control_id`)
 * is skipped and reported as `awaitingHangup`, so the exact event — not the
 * sweep timestamp — closes it (the cron replay runs before this sweep).
 */
export async function closeOrphanLegs(
  admin: AdminClient,
  input: { organizationId: string; now: Date; maxAgeMs?: number; limit?: number },
): Promise<{ closed: string[]; awaitingHangup: string[] }> {
  const cutoff = new Date(input.now.getTime() - (input.maxAgeMs ?? ORPHAN_LEG_MAX_AGE_MS)).toISOString();
  const open = await admin
    .from("motorist_call_legs")
    .select("id, session_id, initiated_at, telnyx_call_control_id")
    .eq("organization_id", input.organizationId)
    .is("ended_at", null)
    .order("initiated_at", { ascending: true })
    .limit(input.limit ?? ORPHAN_LEG_SCAN_LIMIT);
  if (open.error) throw new Error(`orphan leg scan failed: ${open.error.message}`);
  const rows = open.data ?? [];
  if (rows.length === 0) return { closed: [], awaitingHangup: [] };

  const sessionIds = [...new Set(rows.map((row) => row.session_id))];
  const sessions = await admin.from("motorist_call_sessions").select("id, state").eq("organization_id", input.organizationId).in("id", sessionIds);
  if (sessions.error) throw new Error(`orphan leg session load failed: ${sessions.error.message}`);
  const stateById = new Map((sessions.data ?? []).map((row) => [row.id, row.state]));

  const orphans = rows
    .filter((row) => {
      const state = stateById.get(row.session_id);
      if (state === undefined) return true;
      if (TERMINAL_STATES.has(state) || state === "missed") return true;
      const initiated = ms(row.initiated_at);
      return initiated !== null && initiated < Date.parse(cutoff);
    })
    .map((row) => row.id);
  if (orphans.length === 0) return { closed: [], awaitingHangup: [] };

  // One pre-lease ledger read: an unprocessed exact `call.hangup` for the leg
  // means the provider fact exists and the replay owns it — drain, not close.
  // Dead-letter and processed rows do not protect a leg: no exact hangup will
  // ever apply, so the synthetic close remains right.
  const orphanRows = rows.filter((row) => orphans.includes(row.id));
  const controlIds = orphanRows.map((row) => row.telnyx_call_control_id).filter((id): id is string => Boolean(id));
  const awaiting = await pendingHangupControlIds(admin, input.organizationId, controlIds);
  const awaitingHangup = orphanRows.filter((row) => row.telnyx_call_control_id && awaiting.has(row.telnyx_call_control_id)).map((row) => row.id);
  const closable = orphans.filter((id) => !awaitingHangup.includes(id));
  if (closable.length === 0) return { closed: [], awaitingHangup };

  {
    const { ownedSessionWork } = await import("../session-runner");
    const closedIds: string[] = [];
    for (const sessionId of sessionIds) {
      const candidateIds = rows.filter(row => row.session_id === sessionId && closable.includes(row.id)).map(row => row.id);
      // Real child rows have cascading session FKs. Missing parents cannot be leased.
      if (candidateIds.length === 0 || !stateById.has(sessionId)) continue;
      await ownedSessionWork({ admin, organizationId: input.organizationId, leaseWaitMs: 0 }, sessionId, async () => {
        const [freshSession, freshLegs] = await Promise.all([
          admin.from("motorist_call_sessions").select("state").eq("organization_id", input.organizationId).eq("id", sessionId).maybeSingle(),
          admin.from("motorist_call_legs").select("id, initiated_at").eq("organization_id", input.organizationId).eq("session_id", sessionId).in("id", candidateIds).is("ended_at", null),
        ]);
        if (freshSession.error || freshLegs.error) throw new Error("owned orphan leg recheck failed");
        if (!freshSession.data) return;
        const state = freshSession.data.state;
        const ids = (freshLegs.data ?? []).filter(row => TERMINAL_STATES.has(state) || state === "missed" || (ms(row.initiated_at) !== null && ms(row.initiated_at)! < Date.parse(cutoff))).map(row => row.id);
        if (!ids.length) return;
        const closed = await admin.from("motorist_call_legs").update({ state: "ended", ended_at: input.now.toISOString(), hangup_cause: "orphan_sweep" })
          .eq("organization_id", input.organizationId).eq("session_id", sessionId).in("id", ids).is("ended_at", null).select("id");
        if (closed.error) throw new Error(`orphan leg close failed: ${closed.error.message}`);
        closedIds.push(...(closed.data ?? []).map(row => row.id));
      });
    }
    return { closed: closedIds, awaitingHangup };
  }

}

/**
 * A leaked `offered` ring attempt blocks its operator in *every* future session
 * (`ring_attempts_profile_open_offer_idx` is a global partial unique index on
 * `profile_id`), so anything older than the longest possible step plus grace, or
 * belonging to a session that is already terminal, must be terminalised.
 */
export const STALE_ATTEMPT_MAX_AGE_MS = (120 + RING_STEP_GRACE_SECS + 60) * 1000;
export const STALE_ATTEMPT_SCAN_LIMIT = 200;

export async function closeStaleRingAttempts(
  admin: AdminClient,
  input: { organizationId: string; now: Date; maxAgeMs?: number; limit?: number },
): Promise<string[]> {
  const cutoff = new Date(input.now.getTime() - (input.maxAgeMs ?? STALE_ATTEMPT_MAX_AGE_MS)).toISOString();
  const open = await admin
    .from("motorist_ring_attempts")
    .select("id, session_id, offered_at")
    .eq("organization_id", input.organizationId)
    .eq("result", "offered")
    .order("offered_at", { ascending: true })
    .limit(input.limit ?? STALE_ATTEMPT_SCAN_LIMIT);
  if (open.error) throw new Error(`stale ring attempt scan failed: ${open.error.message}`);
  const rows = open.data ?? [];
  if (rows.length === 0) return [];

  const sessionIds = [...new Set(rows.map((row) => row.session_id))];
  const sessions = await admin.from("motorist_call_sessions").select("id, state").eq("organization_id", input.organizationId).in("id", sessionIds);
  if (sessions.error) throw new Error(`stale ring attempt session load failed: ${sessions.error.message}`);
  const stateById = new Map((sessions.data ?? []).map((row) => [row.id, row.state]));

  const stale = rows
    .filter((row) => {
      const state = stateById.get(row.session_id);
      if (state === undefined) return true;
      if (TERMINAL_STATES.has(state) || state === "missed" || state === "wrap_up") return true;
      const offered = ms(row.offered_at);
      return offered === null || offered < Date.parse(cutoff);
    })
    .map((row) => row.id);
  if (stale.length === 0) return [];

  {
    const { ownedSessionWork } = await import("../session-runner");
    const closedIds: string[] = [];
    for (const sessionId of sessionIds) {
      const candidateIds = rows.filter(row => row.session_id === sessionId && stale.includes(row.id)).map(row => row.id);
      if (candidateIds.length === 0 || !stateById.has(sessionId)) continue;
      await ownedSessionWork({ admin, organizationId: input.organizationId, leaseWaitMs: 0 }, sessionId, async () => {
        const [freshSession, freshAttempts] = await Promise.all([
          admin.from("motorist_call_sessions").select("state").eq("organization_id", input.organizationId).eq("id", sessionId).maybeSingle(),
          admin.from("motorist_ring_attempts").select("id, offered_at").eq("organization_id", input.organizationId).eq("session_id", sessionId).in("id", candidateIds).eq("result", "offered"),
        ]);
        if (freshSession.error || freshAttempts.error) throw new Error("owned ring attempt recheck failed");
        if (!freshSession.data) return;
        const state = freshSession.data.state;
        const ids = (freshAttempts.data ?? []).filter(row => TERMINAL_STATES.has(state) || state === "missed" || state === "wrap_up" || ms(row.offered_at) === null || ms(row.offered_at)! < Date.parse(cutoff)).map(row => row.id);
        if (!ids.length) return;
        const closed = await admin.from("motorist_ring_attempts").update({ result: "failed", ended_at: input.now.toISOString() })
          .eq("organization_id", input.organizationId).eq("session_id", sessionId).in("id", ids).eq("result", "offered").select("id");
        if (closed.error) throw new Error(`stale ring attempt close failed: ${closed.error.message}`);
        closedIds.push(...(closed.data ?? []).map(row => row.id));
      });
    }
    return closedIds;
  }

}

/**
 * Exact-leg ledger consult shared by `closeOrphanLegs` (E1b) and the sweep
 * yield (E4): a `call.hangup` row that is not `processed` — fresh, claimed by
 * another host, or deferred — means the provider fact exists and its owner
 * (the deferring host, the correlated replay, the cron) will apply it.
 * Dead-letter rows do not count: no exact hangup will ever apply.
 */
async function pendingHangupControlIds(admin: AdminClient, organizationId: string, controlIds: string[]): Promise<Set<string>> {
  if (controlIds.length === 0) return new Set();
  const pending = await admin.from("motorist_telnyx_webhook_events").select("call_control_id")
    .eq("organization_id", organizationId).eq("event_type", "call.hangup")
    .neq("status", "processed").neq("retry_state", "dead_letter").in("call_control_id", controlIds);
  if (pending.error) throw new Error(`pending hangup ledger check failed: ${pending.error.message}`);
  return new Set((pending.data ?? []).map((row) => row.call_control_id).filter((id): id is string => Boolean(id)));
}

/** Sessions (by id) whose verified customer leg has an unprocessed `call.hangup` in the ledger. */
async function pendingCustomerHangups(admin: AdminClient, organizationId: string, sessions: SessionRow[]): Promise<Set<string>> {
  const legIds = [...new Set(sessions.map((session) => session.customer_leg_id).filter((id): id is string => Boolean(id)))];
  if (legIds.length === 0) return new Set();
  const legs = await admin.from("motorist_call_legs").select("id, session_id, telnyx_call_control_id")
    .eq("organization_id", organizationId).eq("role", "customer").in("id", legIds);
  if (legs.error) throw new Error(`sweep customer leg load failed: ${legs.error.message}`);
  const rows = (legs.data ?? []).filter((leg) => leg.telnyx_call_control_id);
  const pending = await pendingHangupControlIds(admin, organizationId, rows.map((leg) => leg.telnyx_call_control_id as string));
  return new Set(rows.filter((leg) => pending.has(leg.telnyx_call_control_id as string)).map((leg) => leg.session_id));
}

export type SweepDeps = {
  admin: AdminClient;
  organizationId: string;
  /** Required for the advisory device/presence prefilter. */
  environment?: TelephonyEnvironment;
  now?: () => Date;
  /** Runs one session through lease → reducer → effects (provided by the session runner). */
  runSessionEvent: (sessionId: string, event: AppEvent, options?: { known?: SessionRow }) => Promise<unknown>;
  eventId?: () => string;
  /** Maximum number of sessions re-driven in this pass (unbounded by default). */
  limit?: number;
  /** Wall-clock budget: no further session is started once it is exhausted. */
  budgetMs?: number;
  /** Monotonic clock for the budget (defaults to `Date.now`; `now` may be a frozen test clock). */
  clock?: () => number;
  /**
   * Applies the customer's own unprocessed `call.hangup` (exact leg, hangup
   * only, `WEBHOOK_LEASE_WAIT_MS`, outside any ownership scope) instead of
   * sweeping the session. Only callers that can pay for it pass it: the webhook
   * inline sweep and the cron. `calls/active` never does (plan §7.5, M36).
   */
  drainCustomerTerminal?: (session: SessionRow) => Promise<void>;
  /** Wall budget the caller can spend on that one drain, measured from the sweep start (defaults to `budgetMs`). */
  drainBudgetMs?: number;
  /** A released operator should go to the oldest due waiting caller first. */
  waitingFirst?: boolean;
};

export type SweepResult = {
  checked: number;
  swept: string[];
  deferred: string[];
  errors: Array<{ sessionId: string; error: string }>;
  /** Sessions skipped because their customer's `call.hangup` is still unprocessed (also counted in `deferred`). */
  yielded: string[];
  /** The session (at most one per pass) whose pending customer hangup this pass drained. */
  drained: string[];
};

/**
 * `WEBHOOK_LEASE_WAIT_MS` (2 000) + the 8 s drain deadline of the customer-terminal
 * replay (`DEFERRED_DRAIN_DEADLINE_MS`); checked before the acquire, never mid-run
 * (M17). A literal because this module must not import the event processor.
 */
export const CUSTOMER_DRAIN_MIN_BUDGET_MS = 10_000;

export async function sweepOverdueRingSteps(deps: SweepDeps): Promise<SweepResult> {
  const clock = deps.clock ?? (() => Date.now());
  const started = clock();
  const now = (deps.now ?? (() => new Date()))();
  const overdue = await findOverdueSessions(deps.admin, { organizationId: deps.organizationId, now });
  // Ringing sessions first: a caller is listening to them right now. The stale
  // verdict is carried into the event because it is computed here, before the
  // session lease bumps `updated_at` (see `onStaleFinalise`).
  const candidates = [
    ...overdue.greeting.map((session) => ({ session, stale: false })),
    ...overdue.ringing.map((session) => ({ session, stale: false })),
    ...overdue.waiting.map((session) => ({ session, stale: false })),
    ...overdue.stale.map((session) => ({ session, stale: true })),
    ...overdue.media.map((session) => ({ session, stale: false })),
  ];
  const targets = candidates.filter(({ session }, index) => candidates.findIndex((entry) => entry.session.id === session.id) === index);
  if (deps.waitingFirst) targets.sort((a, b) => Number(b.session.state === "waiting") - Number(a.session.state === "waiting"));
  // E4.2 — yield to an unprocessed customer `call.hangup` (M12/M15). One legs
  // read + one ledger read per pass with candidates; the verdict is taken
  // before any lease. Greeting and stale candidates are exempt: the stale
  // path is how a marked session gets finalised.
  const yieldable = [...overdue.ringing, ...overdue.waiting, ...overdue.media].filter((session) => session.customer_leg_id);
  const yieldTo = await pendingCustomerHangups(deps.admin, deps.organizationId, yieldable);
  const result: SweepResult = { checked: targets.length, swept: [], deferred: [], errors: [], yielded: [], drained: [] };
  const noOffer = await idleQueueCandidates(deps, overdue.waiting.filter(session => !yieldTo.has(session.id)), now);
  const limit = deps.limit ?? targets.length;
  let attempted = 0;
  for (const { session, stale } of targets) {
    // Bounded at the loop head so no caller is killed mid-processing: the
    // webhook route by its inline budget, the cron pass by `RING_SWEEP_LIMIT`
    // and `RING_SWEEP_BUDGET_MS` (cron-jobs.ts).
    if (attempted >= limit || (deps.budgetMs !== undefined && clock() - started >= deps.budgetMs)) {
      result.deferred.push(session.id);
      continue;
    }
    if (noOffer.has(session.id)) { result.deferred.push(session.id); continue; }
    attempted += 1;
    if (yieldTo.has(session.id)) {
      // Never sweep over a pending customer hangup (every caller). The
      // candidate stays for the next pass; the hangup is applied by its own
      // host (E2.1), the next webhook's inline sweep or the cron — or right
      // here when this caller has the budget for one bounded drain.
      result.deferred.push(session.id);
      result.yielded.push(session.id);
      const drainBudget = deps.drainBudgetMs ?? deps.budgetMs;
      if (deps.drainCustomerTerminal && result.drained.length === 0 &&
        (drainBudget === undefined || drainBudget - (clock() - started) >= CUSTOMER_DRAIN_MIN_BUDGET_MS)) {
        result.drained.push(session.id);
        try { await deps.drainCustomerTerminal(session); }
        catch (error) { result.errors.push({ sessionId: session.id, error: error instanceof Error ? error.message : String(error) }); }
      }
      continue;
    }
    const id = deps.eventId ? deps.eventId() : `sweep:${session.id}:${now.getTime()}`;
    try {
      await deps.runSessionEvent(session.id, { kind: "app", id, type: "sweep", actorProfileId: null, occurredAt: now.toISOString(), stale }, { known: session });
      result.swept.push(session.id);
    } catch (error) {
      if (error instanceof SessionLeaseBusyError) result.deferred.push(session.id);
      else result.errors.push({ sessionId: session.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Advisory only. A possible change always goes through the leased reducer. */
async function idleQueueCandidates(deps: SweepDeps, sessions: SessionRow[], now: Date): Promise<Set<string>> {
  const candidates = sessions.filter(session => {
    const meta = readMeta(session);
    return session.state === "waiting" && isQueueOfferDue(session, now) && !isWaitingTickStale(session, now) &&
      !isQueueExpired(session, now) && !isSessionStale(session, now) && !isGatherOverdue(session, now) &&
      !session.termination_requested_at && !session.cancellations_next_attempt_at && !readPendingEffects(session).entries.length &&
      !meta.customer_gone_at && !meta.gather?.call_gone && !meta.hangup && !meta.pickup &&
      !meta.recording?.recorders.length && !meta.recording?.barrier && !meta.recording?.pendingAudio &&
      !meta.announcement_sequence && Boolean(meta.ring?.plan?.steps[0]);
  });
  if (!deps.environment || !candidates.length) return new Set();
  const { admin, organizationId } = deps;
  const ids = [...new Set(candidates.flatMap(session => queueOperatorMembers(readMeta(session).ring!.plan!, [], now, false).map(member => member.profileId!)))];
  const [settings, presence, devices, offers, legs, attempts, personal] = await Promise.all([
    admin.from("motorist_telephony_settings").select("*").eq("organization_id", organizationId).maybeSingle(),
    ids.length ? admin.from("motorist_operator_presence").select("*").eq("organization_id", organizationId).in("profile_id", ids) : { data: [], error: null },
    ids.length ? admin.from("motorist_operator_devices").select("*").eq("organization_id", organizationId).eq("environment", deps.environment).in("profile_id", ids) : { data: [], error: null },
    ids.length ? admin.from("motorist_ring_attempts").select("profile_id, session_id").eq("organization_id", organizationId).eq("result", "offered").in("profile_id", ids) : { data: [], error: null },
    admin.from("motorist_call_legs").select("id", { count: "exact", head: true }).eq("organization_id", organizationId)
      .is("ended_at", null).gte("initiated_at", new Date(now.getTime() - ACTIVE_LEG_WINDOW_MS).toISOString()),
    admin.from("motorist_ring_attempts").select("*").eq("organization_id", organizationId).in("session_id", candidates.map(session => session.id)),
    admin.from("motorist_operator_telephony_settings").select("*").eq("organization_id", organizationId),
  ]);
  // On an unavailable advisory snapshot take the normal leased path, whose
  // reads and error handling remain authoritative.
  if ([settings, presence, devices, offers, legs, attempts, personal].some(result => result.error)) return new Set();
  const quiet = new Set<string>();
  for (const session of candidates) {
    const meta = readMeta(session), queue = meta.queue!, frozen = meta.ring!.plan!;
    const plan = { ...frozen, steps: frozen.steps.map(step => ({ ...step,
      members: resolvePersonalRingMembers(step.members, personal.data ?? [], settings.data?.destination_allowlist ?? ["SK", "CZ"]),
    })) };
    const escalation = settings.data?.queue_escalate_after_seconds ?? DEFAULT_ROUTING_SETTINGS.queueEscalateAfterSeconds;
    if (escalation > 0 && !queue.escalated_at && queue.idle_since && Date.parse(queue.idle_since) + escalation * 1000 <= now.getTime()) continue;
    const input: RingStepPlanInput = { sessionId: session.id, now, ownedPstnEnabled: telephonyStabilityEnabled() || hasStabilityContract(session),
      presence: toEligibilityPresence(presence.data ?? []), devices: toEligibilityDevices(devices.data ?? []),
      openOffers: (offers.data ?? []).filter(offer => offer.session_id !== session.id).map(offer => offer.profile_id).filter((id): id is string => Boolean(id)),
      attempted: new Set(), activeLegCount: legs.count ?? 0, maxConcurrentLegs: settings.data?.max_concurrent_legs ?? DEFAULT_ROUTING_SETTINGS.maxConcurrentLegs };
    const ownAttempts = (attempts.data ?? []).filter(attempt => attempt.session_id === session.id);
    const planned = planQueueStep(plan, session.current_step, queueOperatorMembers(plan, ownAttempts, now, true), input);
    const reachable = planned.attempts.length > 0 || planQueueStep(plan, session.current_step, queueOperatorMembers(plan, ownAttempts, now, false), input).attempts.length > 0;
    if (!planned.attempts.length && (reachable ? null : queue.idle_since ?? now.toISOString()) === (queue.idle_since ?? null)) quiet.add(session.id);
  }
  return quiet;
}
