import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import {
  MAX_CONCURRENT_LEGS,
  MAX_RING_FANOUT,
  MOH_TICK_MS,
  RING_STEP_GRACE_SECS,
  readMeta,
  type AppEvent,
  type AttemptPlan,
  type DeviceRow,
  type FrozenRingMember,
  type FrozenRingPlan,
  type FrozenRingStep,
  type PresenceRow,
  type SessionRow,
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

export function clampRingSecs(value: number | null | undefined, fallback: number): number {
  const base = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(MAX_MEMBER_RING_SECS, Math.max(MIN_MEMBER_RING_SECS, Math.round(base)));
}

/** Natural key of a member / attempt (`profile:<id>` or `number:<e164>`). */
export function memberKey(member: { profileId: string | null; externalNumber: string | null }): string {
  return member.profileId ? `profile:${member.profileId}` : `number:${member.externalNumber ?? ""}`;
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

  const groupById = new Map((groups.data ?? []).map((group) => [group.id, group]));
  const frozenSteps: FrozenRingStep[] = [];
  for (const step of stepRows) {
    const group = groupById.get(step.ring_group_id);
    if (!group || !group.active) continue;
    const timeoutSecs = clampRingSecs(step.timeout_secs, DEFAULT_STEP_TIMEOUT_SECS);
    const stepMembers: FrozenRingMember[] = (members.data ?? [])
      .filter((member) => member.ring_group_id === group.id)
      .map((member) => ({
        kind: member.member_kind,
        profileId: member.member_kind === "operator" ? member.profile_id : null,
        externalNumber: member.member_kind === "external_number" ? member.external_number : null,
        position: member.position,
        ringSecs: clampRingSecs(member.ring_secs, timeoutSecs),
        memberId: member.id,
      }))
      .filter((member) => (member.kind === "operator" ? Boolean(member.profileId) : Boolean(member.externalNumber)))
      .sort((left, right) => left.position - right.position);
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
    planId: plan.data.id,
    name: plan.data.name,
    fallback: { kind: plan.data.fallback_kind, number: plan.data.fallback_number ?? null },
    steps: frozenSteps,
    frozenAt: (input.now ?? new Date()).toISOString(),
  };
}

export function toEligibilityPresence(rows: PresenceRow[]): EligibilityPresence[] {
  return rows.map((row) => ({ profileId: row.profile_id, status: row.status, currentSessionId: row.current_session_id, wrapUpUntil: row.wrap_up_until }));
}

export function toEligibilityDevices(rows: DeviceRow[]): EligibilityDevice[] {
  return rows.map((row) => ({ profileId: row.profile_id, deviceSeenAt: row.device_seen_at, registrationState: row.registration_state, sipUsername: row.sip_username }));
}

export type RingStepPlanInput = {
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

export type RingStepSkip = { member: FrozenRingMember; reason: IneligibilityReason | "attempted" | "capacity" | "fanout" };

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
    if (input.attempted.has(memberKey(member))) {
      skipped.push({ member, reason: "attempted" });
      continue;
    }
    const decision = evaluateMemberEligibility(
      member.kind === "operator" ? { kind: "operator", profileId: member.profileId ?? "" } : { kind: "external_number", externalNumber: member.externalNumber ?? "" },
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
  const deadline = ms(readMeta(session).ring?.step_deadline_at);
  return deadline !== null && deadline < now.getTime();
}

/** A waiting/parked session whose MOH tick has not re-armed for two tick periods. */
export function isWaitingTickStale(session: SessionRow, now: Date, tickMs: number = MOH_TICK_MS): boolean {
  if (session.state !== "waiting" && session.state !== "parked") return false;
  const waiting = readMeta(session).waiting;
  const last = ms(waiting?.last_tick_at) ?? ms(waiting?.since) ?? ms(session.parked_at) ?? ms(session.updated_at);
  return last !== null && last + 2 * tickMs < now.getTime();
}

/** `wrap_up` / `missed` sessions untouched for two minutes (leg hangup webhooks lost). */
export const STALE_SESSION_MS = 120_000;

export function isSessionStale(session: SessionRow, now: Date, staleMs: number = STALE_SESSION_MS): boolean {
  if (session.state !== "wrap_up" && session.state !== "missed") return false;
  const updated = ms(session.updated_at);
  return updated !== null && updated + staleMs < now.getTime();
}

export async function findOverdueSessions(admin: AdminClient, input: { organizationId: string; now: Date }): Promise<{ ringing: SessionRow[]; waiting: SessionRow[]; stale: SessionRow[] }> {
  const { data, error } = await admin
    .from("motorist_call_sessions")
    .select("*")
    .eq("organization_id", input.organizationId)
    .in("state", ["ringing", "waiting", "parked", "wrap_up", "missed"]);
  if (error) throw new Error(`overdue session scan failed: ${error.message}`);
  const rows = data ?? [];
  return {
    ringing: rows.filter((row) => isRingStepOverdue(row, input.now)),
    waiting: rows.filter((row) => isWaitingTickStale(row, input.now)),
    stale: rows.filter((row) => isSessionStale(row, input.now)),
  };
}

export type SweepDeps = {
  admin: AdminClient;
  organizationId: string;
  now?: () => Date;
  /** Runs one session through lease → reducer → effects (provided by the session runner). */
  runSessionEvent: (sessionId: string, event: AppEvent) => Promise<unknown>;
  eventId?: () => string;
};

export type SweepResult = { checked: number; swept: string[]; errors: Array<{ sessionId: string; error: string }> };

export async function sweepOverdueRingSteps(deps: SweepDeps): Promise<SweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const overdue = await findOverdueSessions(deps.admin, { organizationId: deps.organizationId, now });
  const targets = [...overdue.ringing, ...overdue.waiting, ...overdue.stale];
  const result: SweepResult = { checked: targets.length, swept: [], errors: [] };
  for (const session of targets) {
    const id = deps.eventId ? deps.eventId() : `sweep:${session.id}:${now.getTime()}`;
    try {
      await deps.runSessionEvent(session.id, { kind: "app", id, type: "sweep", actorProfileId: null, occurredAt: now.toISOString() });
      result.swept.push(session.id);
    } catch (error) {
      result.errors.push({ sessionId: session.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
