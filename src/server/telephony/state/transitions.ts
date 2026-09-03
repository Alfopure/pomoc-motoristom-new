import type { CallLegRole, CallLegState, CallSessionState, Json, RingAttemptResult } from "@/lib/supabase/database.types";

import { evaluateBusinessHours } from "@/lib/telephony/business-hours";
import { classifyRingHangup } from "../routing/eligibility";
import { decideIvr, describeIvrDecision, ivrGatherSpec } from "../routing/ivr";
import { memberKey, planRingStep, stepDeadline, toEligibilityDevices, toEligibilityPresence, type RingStepPlanResult } from "../routing/ring-plan";
import type { TelnyxClientState } from "../telnyx/client-state";
import { commandId } from "../telnyx/command-id";
import {
  ACTIVE_SESSION_STATES,
  CALLBACK_OFFER_TIMEOUT_MS,
  DEFAULT_TRANSFER_TIMEOUT_SECS,
  CAPACITY_RETRY_SECS,
  CAPACITY_WAIT_MAX_MS,
  MOH_TICK_TIMEOUT_MS,
  WAITING_TICK_STALE_MS,
  TALKING_STATES,
  TERMINAL_STATES,
  WAITING_STATES,
  emptyTransition,
  ignoredResult,
  isOpenLeg,
  isTerminalAttemptResult,
  mergeMeta,
  readMeta,
  telnyxSipUri,
  type AppEvent,
  type AttemptPatch,
  type AttemptRow,
  type CallbackPlan,
  type Command,
  type Compensation,
  type DialCommand,
  type FrozenRingPlan,
  type GatherSpec,
  type LegPatch,
  type LegRef,
  type LegRow,
  type LegValues,
  type MediaRef,
  type PresenceChange,
  type ReduceResult,
  type ReservationGuard,
  type RingFanout,
  type RoutingContext,
  type SessionEvent,
  type SessionMeta,
  type SessionPatch,
  type SessionRow,
  type TelephonyEvent,
  type Transition,
  type TransferTarget,
} from "./types";

/**
 * Pure call state machine (design §2.5/§2.6).
 *
 * `reduce(session, legs, attempts, event, context)` never touches the
 * network or the database. Transitions are keyed on leg rows
 * (`answered_at`, `bridged_at`, `ended_at`) so unordered or duplicated
 * webhooks are safe: an event that changes nothing returns `ignored`.
 *
 * Every Telnyx command carries a deterministic `command_id`
 * (`uuidv5(session|leg|eventId|intent)`) so a re-run of the same event
 * produces byte-identical commands, which Telnyx de-duplicates.
 */

const OUTBOUND_TIMEOUT_SECS = 45;
const INTERNAL_TIMEOUT_SECS = 30;
const PICKUP_TIMEOUT_SECS = 30;
const CONSULT_TIMEOUT_SECS = 30;
const PICKUP_STALE_MS = 30_000;
export const STALE_FINALISE_MS = 120_000;

const CALLBACK_OFFER_TTS = "Momentálne sú všetci operátori obsadení. Ak chcete, aby sme vám zavolali späť, stlačte jednotku.";
const AFTER_HOURS_TTS = "Voláte mimo pracovného času. Ak chcete, aby sme vám zavolali späť, stlačte jednotku.";

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

class TransitionBuilder {
  readonly nowIso: string;
  readonly eventKey: string;
  private sessionPatch: SessionPatch = {};
  private metaPatch: Partial<SessionMeta> = {};
  private readonly legPatches = new Map<string, LegPatch>();
  private readonly attemptPatches = new Map<string, AttemptPatch>();
  private readonly endedLegs = new Set<string>();
  readonly presence: PresenceChange[] = [];
  readonly callbacks: CallbackPlan[] = [];
  readonly call: Transition["call"] = {};
  readonly memberTouches: Transition["memberTouches"] = [];
  readonly notes: string[] = [];
  readonly commands: Command[] = [];
  readonly compensations: Compensation[] = [];
  guard: ReservationGuard | null = null;
  private nextState: CallSessionState;

  constructor(
    readonly session: SessionRow,
    readonly legs: LegRow[],
    readonly attempts: AttemptRow[],
    readonly event: SessionEvent,
    readonly ctx: RoutingContext,
  ) {
    this.nowIso = ctx.now.toISOString();
    this.eventKey = event.id;
    this.nextState = session.state;
  }

  fork(): TransitionBuilder {
    return new TransitionBuilder(this.session, this.legs, this.attempts, this.event, this.ctx);
  }

  get meta(): SessionMeta {
    return { ...readMeta(this.session), ...this.metaPatch } as SessionMeta;
  }

  get state(): CallSessionState {
    return this.nextState;
  }

  setState(state: CallSessionState): this {
    this.nextState = state;
    this.sessionPatch.state = state;
    return this;
  }

  patchSession(patch: SessionPatch): this {
    Object.assign(this.sessionPatch, patch);
    return this;
  }

  patchMeta(patch: Partial<SessionMeta>): this {
    Object.assign(this.metaPatch, patch);
    return this;
  }

  note(text: string): this {
    this.notes.push(text);
    return this;
  }

  cmdId(legKey: string, intent: string, step: string | number = this.eventKey): string {
    return commandId({ sessionId: this.session.id, legId: legKey, step, intent });
  }

  cmd(command: Command): this {
    this.commands.push(command);
    return this;
  }

  compensate(forCommand: string, description: string, commands: Command[], next: Transition | null = null): this {
    this.compensations.push({ forCommand, description, commands, next });
    return this;
  }

  leg(callControlId: string, values: LegValues, createIfMissing = false): this {
    const existing = this.legPatches.get(callControlId);
    if (existing) {
      Object.assign(existing.values, values);
      existing.createIfMissing = existing.createIfMissing || createIfMissing;
    } else {
      this.legPatches.set(callControlId, { callControlId, values: { ...values }, createIfMissing });
    }
    if (values.ended_at || values.state === "ended" || values.state === "failed") this.endedLegs.add(callControlId);
    return this;
  }

  attempt(id: string, values: AttemptPatch["values"]): this {
    const existing = this.attemptPatches.get(id);
    if (existing) Object.assign(existing.values, values);
    else this.attemptPatches.set(id, { id, values: { ...values } });
    return this;
  }

  presenceChange(change: PresenceChange): this {
    this.presence.push(change);
    return this;
  }

  callback(plan: CallbackPlan): this {
    this.callbacks.push(plan);
    return this;
  }

  // --- derived views ------------------------------------------------------

  findLeg(callControlId: string | null | undefined): LegRow | undefined {
    if (!callControlId) return undefined;
    return this.legs.find((leg) => leg.telnyx_call_control_id === callControlId);
  }

  legEnded(leg: LegRow): boolean {
    return !isOpenLeg(leg) || this.endedLegs.has(leg.telnyx_call_control_id);
  }

  openLegs(): LegRow[] {
    return this.legs.filter((leg) => !this.legEnded(leg));
  }

  customerLeg(): LegRow | undefined {
    const byId = this.session.customer_leg_id ? this.legs.find((leg) => leg.id === this.session.customer_leg_id) : undefined;
    const byRole = byId ?? this.legs.find((leg) => leg.role === "customer");
    if (byRole || this.session.direction !== "internal") return byRole;
    // Internal calls have no PSTN party: the far end is the colleague's leg.
    return this.legs.find((leg) => legIntent(leg) === "internal");
  }

  /** The leg currently talking to the customer (operator or external). */
  answeringLeg(): LegRow | undefined {
    const byProfile = this.session.answered_by_profile_id
      ? this.openLegs().find((leg) => leg.profile_id === this.session.answered_by_profile_id && (leg.role === "operator" || leg.role === "external"))
      : undefined;
    return byProfile ?? this.openLegs().find((leg) => (leg.role === "operator" || leg.role === "external") && Boolean(leg.answered_at));
  }

  attemptsView(): AttemptRow[] {
    return this.attempts.map((attempt) => {
      const patch = this.attemptPatches.get(attempt.id);
      return patch ? ({ ...attempt, ...patch.values } as AttemptRow) : attempt;
    });
  }

  attemptForLeg(leg: LegRow): AttemptRow | undefined {
    const view = this.attemptsView();
    const byLeg = view.find((attempt) => attempt.leg_id === leg.id);
    if (byLeg) return byLeg;
    const state = clientStateOf(leg);
    if (state?.intent !== "ring" || state.step === undefined) return undefined;
    return view.find(
      (attempt) =>
        attempt.step_index === state.step &&
        ((leg.profile_id && attempt.profile_id === leg.profile_id) || (!leg.profile_id && attempt.external_number && attempt.external_number === leg.to_number)),
    );
  }

  ringPlan(): FrozenRingPlan | null {
    return this.meta.ring?.plan ?? this.ctx.ringPlan;
  }

  activeRingStep(): number | null {
    const step = this.meta.ring?.active_step;
    return typeof step === "number" ? step : null;
  }

  // --- result -------------------------------------------------------------

  transition(): Transition {
    const session: SessionPatch = { ...this.sessionPatch };
    if (Object.keys(this.metaPatch).length > 0) session.metadata = mergeMeta(this.session, this.metaPatch);
    return {
      session,
      legs: [...this.legPatches.values()],
      attempts: [...this.attemptPatches.values()],
      presence: [...this.presence],
      callbacks: [...this.callbacks],
      call: { ...this.call },
      memberTouches: [...this.memberTouches],
      notes: [...this.notes],
    };
  }

  result(): ReduceResult {
    return { next: this.transition(), commands: [...this.commands], compensations: [...this.compensations], guard: this.guard, ignored: null };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clientStateOf(leg: LegRow): TelnyxClientState | null {
  const value = leg.client_state;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sid !== "string" || typeof record.role !== "string") return null;
  return record as unknown as TelnyxClientState;
}

function legIntent(leg: LegRow, fallback: TelnyxClientState | null = null): string | null {
  return clientStateOf(leg)?.intent ?? fallback?.intent ?? null;
}

function ref(leg: LegRow | { telnyx_call_control_id: string }): LegRef {
  return { callControlId: leg.telnyx_call_control_id };
}

function clientStateJson(state: TelnyxClientState): Json {
  return JSON.parse(JSON.stringify(state)) as Json;
}

function customerState(sessionId: string, intent?: string): TelnyxClientState {
  return intent ? { sid: sessionId, role: "customer", intent } : { sid: sessionId, role: "customer" };
}

function secondsBetween(from: string | null | undefined, to: string): number | null {
  if (!from) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

function hangupCmd(b: TransitionBuilder, leg: LegRow, reason: string, bestEffort = true): Command {
  return { kind: "hangup", commandId: b.cmdId(leg.telnyx_call_control_id, `hangup:${reason}`), leg: ref(leg), reason, bestEffort };
}

/**
 * Hangs up a leg that belongs to a session which is already terminal (the leg
 * may not even have a row yet: a dial that timed out client-side).
 */
function hangupOrphanLeg(b: TransitionBuilder, callControlId: string, role: CallLegRole): void {
  b.cmd({ kind: "hangup", commandId: b.cmdId(callControlId, "hangup:terminal_session"), leg: { callControlId }, reason: "terminal_session", bestEffort: true });
  b.leg(callControlId, { role, state: "ended", ended_at: b.nowIso, hangup_cause: "terminal_session" }, true);
}

function gatherCmd(b: TransitionBuilder, leg: LegRow, spec: GatherSpec, intentSuffix = ""): Command {
  return {
    kind: "gather",
    commandId: b.cmdId(leg.telnyx_call_control_id, `gather:${spec.purpose}${intentSuffix}`),
    leg: ref(leg),
    spec,
    clientState: customerState(b.session.id, spec.purpose),
  };
}

/**
 * The waiting-room heartbeat: a silent `gather` that only times out. The music
 * itself is a detached `playback_start { loop: "infinity" }` (see `startMoh`),
 * so re-arming the tick never interrupts it.
 */
function mohTickSpec(): GatherSpec {
  return {
    media: null,
    purpose: "moh_tick",
    maximumDigits: 1,
    timeoutMillis: MOH_TICK_TIMEOUT_MS,
    // Telnyx waits `initial_timeout_millis` (default 5 s) for the first digit:
    // without this the tick would fire twelve times a minute.
    initialTimeoutMillis: MOH_TICK_TIMEOUT_MS,
    validDigits: "0123456789#*",
  };
}

/**
 * Starts the continuous waiting-room music on the customer leg (stopped by
 * `stopMoh`). Idempotent inside one transition: the ring plan and the waiting
 * room share the command id, so a fallback that walks from one to the other
 * cannot issue the same `playback_start` twice.
 */
function startMoh(b: TransitionBuilder, customer: LegRow): void {
  if (!b.ctx.mediaAvailable) return;
  const commandId = b.cmdId(customer.telnyx_call_control_id, "playback:moh");
  if (b.commands.some((command) => "commandId" in command && command.commandId === commandId)) return;
  b.cmd({ kind: "playback_start", commandId, leg: ref(customer), media: { key: "moh" }, loop: "infinity", bestEffort: true });
}

function callbackOfferSpec(media: MediaRef, ttsText: string): GatherSpec {
  return {
    media,
    purpose: "callback_offer",
    ttsText,
    validDigits: "1",
    maximumDigits: 1,
    minimumDigits: 1,
    maximumTries: 1,
    timeoutMillis: CALLBACK_OFFER_TIMEOUT_MS,
  };
}

function isCustomer(leg: LegRow): boolean {
  return leg.role === "customer";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function reduce(session: SessionRow, legs: LegRow[], attempts: AttemptRow[], event: SessionEvent, context: RoutingContext): ReduceResult {
  const b = new TransitionBuilder(session, legs, attempts, event, context);
  if (event.kind === "app") return reduceApp(b, event);
  return reduceTelnyx(b, event);
}

function reduceTelnyx(b: TransitionBuilder, event: TelephonyEvent): ReduceResult {
  switch (event.type) {
    case "call.initiated":
      return onInitiated(b, event);
    case "call.answered":
      return onAnswered(b, event);
    case "call.bridged":
      return onBridged(b, event);
    case "call.hangup":
      return onHangup(b, event);
    case "call.gather.ended":
      return onGatherEnded(b, event);
    case "call.playback.ended":
      return onPlaybackEnded(b, event);
    case "call.hold":
    case "call.unhold":
      return onSdkHold(b, event);
    case "conference.created":
      return onConferenceCreated(b, event);
    default:
      return ignoredResult(`no transition for ${event.type}`);
  }
}

// ---------------------------------------------------------------------------
// call.initiated
// ---------------------------------------------------------------------------

function onInitiated(b: TransitionBuilder, event: TelephonyEvent): ReduceResult {
  if (!event.callControlId) return ignoredResult("call.initiated without call_control_id");
  const leg = b.findLeg(event.callControlId);
  const state = event.clientState;
  if (TERMINAL_STATES.has(b.session.state)) {
    // A dial whose HTTP response never arrived (timeout) still created this leg,
    // and the caller marked the session `failed`. Nothing will ever bridge it:
    // hang it up instead of leaving a live leg nobody owns.
    if (!leg && (!state || state.sid !== b.session.id)) return ignoredResult("session already terminal");
    if (leg && b.legEnded(leg)) return ignoredResult("session already terminal");
    hangupOrphanLeg(b, event.callControlId, state?.role ?? "operator");
    return b.note("leg initiated for a terminal session → hangup").result();
  }

  if (!leg) {
    // A leg we dialed (or a transfer target) whose webhook overtook our own upsert.
    if (!state || state.sid !== b.session.id) return ignoredResult("foreign leg");
    b.leg(
      event.callControlId,
      {
        telnyx_call_leg_id: event.callLegId,
        role: state.role,
        profile_id: state.operatorId ?? null,
        to_number: event.to,
        from_number: event.from,
        state: "ringing",
        initiated_at: event.occurredAt ?? b.nowIso,
        client_state: clientStateJson(state),
      },
      true,
    );
    return b.note(`leg ${state.role} created from client_state`).result();
  }

  const values: LegValues = { telnyx_call_leg_id: leg.telnyx_call_leg_id ?? event.callLegId };
  if (!leg.to_number && event.to) values.to_number = event.to;
  if (!leg.from_number && event.from) values.from_number = event.from;
  if (leg.state === "initiated" && event.direction === "outgoing") values.state = "ringing";
  b.leg(leg.telnyx_call_control_id, values);

  if (isCustomer(leg) && b.session.direction === "inbound" && b.session.state === "received" && !leg.answered_at) {
    const answerId = b.cmdId(leg.telnyx_call_control_id, "answer");
    b.cmd({ kind: "answer", commandId: answerId, leg: ref(leg), clientState: customerState(b.session.id) });
    const failed = b.fork();
    failed.setState("failed").patchSession({ ended_at: b.nowIso });
    failed.call.status = "failed";
    failed.call.end_reason = "answer_failed";
    failed.leg(leg.telnyx_call_control_id, { state: "failed", ended_at: b.nowIso, hangup_cause: "answer_failed" });
    b.compensate(answerId, "answer failed → hang up the customer leg", [hangupCmd(b, leg, "answer_failed")], failed.transition());
    return b.note("answering inbound customer leg").result();
  }
  return b.result();
}

// ---------------------------------------------------------------------------
// call.answered / call.bridged
// ---------------------------------------------------------------------------

function onAnswered(b: TransitionBuilder, event: TelephonyEvent): ReduceResult {
  if (!event.callControlId) return ignoredResult("call.answered without call_control_id");
  let leg = b.findLeg(event.callControlId);
  if (!leg) {
    const state = event.clientState;
    if (!state || state.sid !== b.session.id) return ignoredResult("foreign leg");
    leg = syntheticLeg(b, event, state);
    b.leg(leg.telnyx_call_control_id, { ...legValuesFromSynthetic(leg), answered_at: event.occurredAt ?? b.nowIso, state: "answered" }, true);
  } else {
    if (leg.answered_at) return ignoredResult("leg already answered");
    if (b.legEnded(leg)) return ignoredResult("leg already ended");
    b.leg(leg.telnyx_call_control_id, { answered_at: event.occurredAt ?? b.nowIso, state: "answered", telnyx_call_leg_id: leg.telnyx_call_leg_id ?? event.callLegId });
  }
  return onLegAnswered(b, leg, { alreadyBridged: false, at: event.occurredAt ?? b.nowIso });
}

function onBridged(b: TransitionBuilder, event: TelephonyEvent): ReduceResult {
  if (!event.callControlId) return ignoredResult("call.bridged without call_control_id");
  const leg = b.findLeg(event.callControlId);
  if (!leg) {
    const state = event.clientState;
    if (!state || state.sid !== b.session.id) return ignoredResult("foreign leg");
    const synthetic = syntheticLeg(b, event, state);
    b.leg(synthetic.telnyx_call_control_id, { ...legValuesFromSynthetic(synthetic), answered_at: event.occurredAt ?? b.nowIso, bridged_at: event.occurredAt ?? b.nowIso, state: "bridged" }, true);
    return onLegAnswered(b, synthetic, { alreadyBridged: true, at: event.occurredAt ?? b.nowIso });
  }
  if (b.legEnded(leg)) return ignoredResult("leg already ended");
  const values: LegValues = { state: "bridged" };
  if (!leg.bridged_at) values.bridged_at = event.occurredAt ?? b.nowIso;
  const firstSignal = !leg.answered_at;
  if (firstSignal) values.answered_at = event.occurredAt ?? b.nowIso;
  b.leg(leg.telnyx_call_control_id, values);
  if (firstSignal && !isCustomer(leg)) {
    // Out-of-order delivery: bridged arrived before answered. Treat it as the answer.
    return onLegAnswered(b, leg, { alreadyBridged: true, at: event.occurredAt ?? b.nowIso });
  }
  if (firstSignal && isCustomer(leg) && (b.session.direction === "outbound" || b.session.direction === "internal")) {
    return onLegAnswered(b, leg, { alreadyBridged: true, at: event.occurredAt ?? b.nowIso });
  }
  return b.note("bridged").result();
}

function syntheticLeg(b: TransitionBuilder, event: TelephonyEvent, state: TelnyxClientState): LegRow {
  return {
    id: `pending:${event.callControlId}`,
    organization_id: b.session.organization_id,
    session_id: b.session.id,
    telnyx_call_control_id: event.callControlId ?? "",
    telnyx_call_leg_id: event.callLegId,
    role: state.role,
    profile_id: state.operatorId ?? null,
    to_number: event.to,
    from_number: event.from,
    state: "initiated",
    hangup_cause: null,
    hangup_source: null,
    initiated_at: event.occurredAt ?? b.nowIso,
    answered_at: null,
    bridged_at: null,
    ended_at: null,
    client_state: clientStateJson(state),
    metadata: {},
    created_at: b.nowIso,
    updated_at: b.nowIso,
  };
}

function legValuesFromSynthetic(leg: LegRow): LegValues {
  return {
    telnyx_call_leg_id: leg.telnyx_call_leg_id,
    role: leg.role,
    profile_id: leg.profile_id,
    to_number: leg.to_number,
    from_number: leg.from_number,
    initiated_at: leg.initiated_at,
    client_state: leg.client_state,
  };
}

function onLegAnswered(b: TransitionBuilder, leg: LegRow, opts: { alreadyBridged: boolean; at: string }): ReduceResult {
  if (TERMINAL_STATES.has(b.session.state)) {
    if (b.legEnded(leg)) return ignoredResult("session already terminal");
    hangupOrphanLeg(b, leg.telnyx_call_control_id, leg.role);
    return b.note("leg answered in a terminal session → hangup").result();
  }
  const intent = legIntent(leg);

  if (isCustomer(leg)) {
    if (b.session.direction === "inbound") return onCustomerAnswered(b, leg);
    return onFarEndAnswered(b, leg, opts);
  }

  if (leg.role === "consult") return onConsultAnswered(b, leg);
  if (leg.role === "supervisor") return b.note("supervisor answered").result();

  if (intent === "outbound" || intent === "internal_caller") return onOwnLegAnswered(b, leg, intent);
  if (intent === "internal") return onInternalCalleeAnswered(b, leg, opts);
  return onOfferAnswered(b, leg, opts);
}

/** Inbound customer answered by us → business hours → IVR or ring plan. */
function onCustomerAnswered(b: TransitionBuilder, leg: LegRow): ReduceResult {
  if (b.session.state !== "received" && b.session.state !== "greeting") return b.note("customer answered late").result();
  b.setState("greeting");
  const hours = evaluateBusinessHours(b.ctx.businessHours, b.ctx.now);
  if (!hours.open) {
    startAfterHours(b, leg, hours.reason);
    return b.result();
  }
  if (b.ctx.ivr && b.ctx.line?.ivr_menu_id && b.ctx.ivr.menu.id === b.ctx.line.ivr_menu_id && b.ctx.ivr.menu.active) {
    startIvr(b, leg, 1);
    return b.result();
  }
  startRingPlan(b, leg, b.ringPlan());
  return b.result();
}

function startAfterHours(b: TransitionBuilder, leg: LegRow, reason: string): void {
  b.setState("after_hours").patchMeta({ after_hours: { reason, at: b.nowIso } });
  b.cmd(gatherCmd(b, leg, callbackOfferSpec({ key: "afterHours" }, AFTER_HOURS_TTS)));
  b.note(`closed (${reason}) → after-hours callback offer`);
}

/**
 * Plays the menu. `tries` counts the prompts already played, so a re-prompt
 * (invalid digit or the `repeat` option) carries a distinct command id and the
 * budget in `metadata.ivr.tries` is the same one `decideIvr` checks.
 */
function startIvr(b: TransitionBuilder, leg: LegRow, tries: number): void {
  const ivr = b.ctx.ivr;
  if (!ivr) return;
  b.setState("ivr").patchMeta({ ivr: { ...(b.meta.ivr ?? {}), menu_id: ivr.menu.id, tries } });
  b.cmd(gatherCmd(b, leg, ivrGatherSpec(ivr), tries > 1 ? `:${tries}` : ""));
}

function startRingPlan(b: TransitionBuilder, customer: LegRow, plan: FrozenRingPlan | null): void {
  if (!plan || plan.steps.length === 0) {
    b.note("no ring plan → callback offer");
    offerCallback(b, customer, { key: "callbackOffer" }, "missed");
    return;
  }
  b.patchMeta({ ring: { ...(b.meta.ring ?? {}), plan, mode: "plan", exhausted: false, fallback: null } });
  b.patchSession({ ring_plan_id: plan.planId });
  if (b.ctx.mediaAvailable) {
    b.cmd({ kind: "playback_start", commandId: b.cmdId(customer.telnyx_call_control_id, "playback:greeting"), leg: ref(customer), media: { key: "greeting" }, bestEffort: true });
    startMoh(b, customer);
  }
  const started = ringFromStep(b, customer, plan, 0);
  if (!started) applyFallback(b, customer, plan);
}

/** Finds the first step at or after `fromStep` with an eligible member and fans it out. */
function ringFromStep(b: TransitionBuilder, customer: LegRow, plan: FrozenRingPlan, fromStep: number): boolean {
  for (let index = fromStep; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    const planned = planStep(b, plan, index);
    if (planned.attempts.length === 0) {
      // Design §2.6: over the org-wide leg cap the step waits for capacity instead
      // of burning through the plan; the fallback only follows after the wait.
      if (planned.capacityLimited && capacityWaitedMs(b) < CAPACITY_WAIT_MAX_MS) {
        holdStepForCapacity(b, index);
        return true;
      }
      b.note(`step ${index} (${step.groupName}) skipped: ${planned.skipped.map((skip) => `${memberKey(skip.member)}=${skip.reason}`).join(",") || "no members"}`);
      continue;
    }
    fanout(b, customer, index, planned, { expectedStep: b.session.current_step, setStep: index + 1 });
    return true;
  }
  return false;
}

function planStep(b: TransitionBuilder, plan: FrozenRingPlan, index: number): RingStepPlanResult {
  const step = plan.steps[index];
  // `applyFallback` fans out the synthetic external-number step at
  // `plan.steps.length`, so an index past the last real step can reach here.
  if (!step) return { attempts: [], members: [], skipped: [], capacityLimited: false, ringSecs: 0, exhaustedAfter: true };
  const attempted = new Set(
    b
      .attemptsView()
      .filter((attempt) => attempt.step_index === index)
      .map((attempt) => memberKey({ profileId: attempt.profile_id, externalNumber: attempt.external_number })),
  );
  return planRingStep(step, {
    sessionId: b.session.id,
    now: b.ctx.now,
    presence: toEligibilityPresence(b.ctx.presence),
    devices: toEligibilityDevices(b.ctx.devices),
    openOffers: b.ctx.openOffers,
    attempted,
    maxFanout: b.ctx.settings.maxRingFanout,
    maxConcurrentLegs: b.ctx.settings.maxConcurrentLegs,
    activeLegCount: b.ctx.activeLegCount,
  });
}

/** Milliseconds this session has already spent waiting for leg capacity. */
function capacityWaitedMs(b: TransitionBuilder): number {
  const since = b.meta.ring?.capacity_wait_since;
  if (!since) return 0;
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? 0 : Math.max(0, b.ctx.now.getTime() - parsed);
}

/** Keeps `stepIndex` armed (no dials) so a sweep re-tries it once a leg frees up. */
function holdStepForCapacity(b: TransitionBuilder, stepIndex: number): void {
  const ring = b.meta.ring ?? {};
  b.setState("ringing").patchMeta({
    ring: {
      ...ring,
      mode: "plan",
      active_step: stepIndex,
      step_started_at: ring.step_started_at ?? b.nowIso,
      step_deadline_at: stepDeadline(b.ctx.now, CAPACITY_RETRY_SECS, 0),
      capacity_wait_since: ring.capacity_wait_since ?? b.nowIso,
      exhausted: false,
    },
  });
  b.note(`step ${stepIndex}: waiting for leg capacity`);
}

function fanout(b: TransitionBuilder, customer: LegRow, stepIndex: number, planned: RingStepPlanResult, guard: RingFanout["guard"]): void {
  const devices = new Map(b.ctx.devices.map((device) => [device.profile_id, device]));
  const from = b.ctx.fromNumber ?? b.session.called_number ?? "";
  const dials: DialCommand[] = [];
  const ringingProfileIds: string[] = [];
  for (const attempt of planned.attempts) {
    const key = attempt.profileId ?? attempt.externalNumber ?? "member";
    const sip = attempt.profileId ? devices.get(attempt.profileId)?.sip_username : null;
    const to = attempt.profileId ? (sip ? telnyxSipUri(sip) : null) : attempt.externalNumber;
    if (!to) {
      b.note(`member ${key} has no dialable address`);
      continue;
    }
    const clientState: TelnyxClientState = attempt.profileId
      ? { sid: b.session.id, role: "operator", operatorId: attempt.profileId, step: stepIndex, intent: "ring" }
      : { sid: b.session.id, role: "external", step: stepIndex, intent: "ring" };
    dials.push({
      kind: "dial",
      commandId: b.cmdId(key, "ring", stepIndex),
      to,
      from,
      role: attempt.profileId ? "operator" : "external",
      profileId: attempt.profileId,
      externalNumber: attempt.externalNumber,
      clientState,
      linkTo: customer.telnyx_call_control_id,
      timeoutSecs: attempt.ringSecs,
      attempt: { stepIndex, profileId: attempt.profileId, externalNumber: attempt.externalNumber },
    });
    if (attempt.profileId) ringingProfileIds.push(attempt.profileId);
  }
  const deadlineAt = stepDeadline(b.ctx.now, planned.ringSecs);
  b.cmd({ kind: "ring_fanout", step: stepIndex, guard, attempts: planned.attempts, dials, ringingProfileIds, deadlineAt });
  b.setState("ringing").patchMeta({
    ring: { ...(b.meta.ring ?? {}), mode: "plan", active_step: stepIndex, step_started_at: b.nowIso, step_deadline_at: deadlineAt, capacity_wait_since: null, exhausted: false },
  });
  for (const member of planned.members) {
    if (member.memberId) b.memberTouches.push({ memberId: member.memberId, field: "last_offered_at" });
  }
  b.note(`step ${stepIndex}: ${dials.length} dial(s)`);
}

function applyFallback(b: TransitionBuilder, customer: LegRow, plan: FrozenRingPlan): void {
  const ring = b.meta.ring ?? {};
  const kind = plan.fallback.kind;
  if (kind === "external_number" && plan.fallback.number && ring.fallback !== "external_number") {
    const stepIndex = plan.steps.length;
    const planned: RingStepPlanResult = {
      attempts: [{ stepIndex, ringGroupId: null, memberKind: "external_number", profileId: null, externalNumber: plan.fallback.number, position: 0, ringSecs: DEFAULT_TRANSFER_TIMEOUT_SECS }],
      members: [],
      skipped: [],
      capacityLimited: false,
      ringSecs: DEFAULT_TRANSFER_TIMEOUT_SECS,
      exhaustedAfter: true,
    };
    fanout(b, customer, stepIndex, planned, { expectedStep: b.session.current_step, setStep: stepIndex + 1 });
    b.patchMeta({ ring: { ...b.meta.ring, fallback: "external_number" } });
    b.note("fallback: external number");
    return;
  }
  stopMoh(b, customer);
  b.patchMeta({ ring: { ...ring, exhausted: true, fallback: kind } });
  if (kind === "waiting_room") {
    enterWaiting(b, customer, "ring_exhausted");
    return;
  }
  if (kind === "hangup_message") {
    b.setState("missed").patchSession({ ended_at: null });
    b.call.status = "missed";
    b.call.end_reason = "all_busy";
    b.callback({ source: "missed", callerNumber: b.session.caller_number ?? "", createTask: Boolean(b.session.case_id) });
    if (b.ctx.mediaAvailable) {
      b.cmd({ kind: "playback_start", commandId: b.cmdId(customer.telnyx_call_control_id, "playback:all_busy"), leg: ref(customer), media: { key: "allBusy" } });
    } else {
      b.cmd(hangupCmd(b, customer, "all_busy", false));
    }
    b.note("fallback: all-busy message");
    return;
  }
  offerCallback(b, customer, { key: "callbackOffer" }, "missed");
}

/** True while a `playback_start` loop is running on the customer leg. */
function mohIsPlaying(b: TransitionBuilder): boolean {
  if (!b.ctx.mediaAvailable) return false;
  return (b.session.state === "ringing" && b.meta.ring?.mode === "plan") || WAITING_STATES.has(b.session.state);
}

function stopMoh(b: TransitionBuilder, customer: LegRow): void {
  if (!mohIsPlaying(b)) return;
  const commandId = b.cmdId(customer.telnyx_call_control_id, "playback_stop");
  // One transition can pass through two callers (fallback → callback offer).
  if (b.commands.some((command) => "commandId" in command && command.commandId === commandId)) return;
  b.cmd({ kind: "playback_stop", commandId, leg: ref(customer), bestEffort: true });
}

function offerCallback(b: TransitionBuilder, customer: LegRow, media: MediaRef, source: SessionMeta["callback"] extends infer T ? (T extends { source?: infer S } ? NonNullable<S> : never) : never): void {
  // The prompt must not compete with the waiting-room loop.
  stopMoh(b, customer);
  b.setState("callback_offered").patchMeta({ callback: { source, confirmed: false } });
  b.cmd(gatherCmd(b, customer, callbackOfferSpec(media, CALLBACK_OFFER_TTS)));
  b.note(`callback offer (${source})`);
}

function enterWaiting(b: TransitionBuilder, customer: LegRow, reason: string, state: "waiting" | "parked" = "waiting"): void {
  const musicRunning = mohIsPlaying(b);
  // The waiting-room limit is frozen the moment the caller enters it, like the
  // ring plan is frozen at call start: `loadRoutingSettings` re-reads the
  // settings row on every event, so an admin lowering `park_max_minutes` used to
  // eject callers who were already waiting — a configuration change disturbing a
  // call in progress.
  b.setState(state).patchMeta({ waiting: { since: b.nowIso, reason, ticks: 0, last_tick_at: b.nowIso, max_minutes: b.ctx.settings.parkMaxMinutes } });
  // The ring plan already started the loop; restarting it would jump the audio.
  if (!musicRunning) startMoh(b, customer);
  b.cmd(gatherCmd(b, customer, mohTickSpec()));
  b.note(`${state} (${reason})`);
}

/** Outbound/internal: the far end answered → the bridge command placed at dial time completes. */
function onFarEndAnswered(b: TransitionBuilder, leg: LegRow, opts: { alreadyBridged: boolean; at: string }): ReduceResult {
  if (b.session.state !== "ringing") return b.note("far end answered outside ringing").result();
  b.setState("talking").patchSession({ answered_at: b.session.answered_at ?? opts.at });
  b.call.status = "answered";
  b.call.answered_at = b.session.answered_at ?? opts.at;
  b.call.ring_seconds = secondsBetween(b.session.started_at, opts.at);
  b.note("far end answered → talking");
  return b.result();
}

/** Internal call: the colleague answered → reserve them, the bridge placed at dial time completes. */
function onInternalCalleeAnswered(b: TransitionBuilder, leg: LegRow, opts: { alreadyBridged: boolean; at: string }): ReduceResult {
  if (b.session.state !== "ringing") {
    b.cmd(hangupCmd(b, leg, "late_answer", false));
    return b.note("colleague answered late → hang up").result();
  }
  const rejected = b.fork();
  rejected.cmd(hangupCmd(rejected, leg, "operator_busy", false));
  b.setState("talking").patchSession({ answered_at: b.session.answered_at ?? opts.at });
  b.call.status = "answered";
  b.call.answered_at = b.session.answered_at ?? opts.at;
  b.call.ring_seconds = secondsBetween(b.session.started_at, opts.at);
  b.note("colleague answered → talking");
  if (leg.profile_id) b.guard = { profileId: leg.profile_id, onRejected: { next: rejected.transition(), commands: rejected.commands } };
  return b.result();
}

/** The operator's own WebRTC leg answered (click-to-call / internal call) → dial the far end and bridge with ringback. */
function onOwnLegAnswered(b: TransitionBuilder, leg: LegRow, intent: string): ReduceResult {
  if (b.session.state !== "received") return b.note("own leg answered outside received").result();
  const meta = b.meta;
  let dial: DialCommand;
  if (intent === "outbound") {
    const outbound = meta.outbound;
    if (!outbound) return ignoredResult("outbound session without target");
    dial = {
      kind: "dial",
      commandId: b.cmdId("customer", "dial:outbound"),
      to: outbound.to,
      from: outbound.from,
      role: "customer",
      profileId: null,
      externalNumber: outbound.to,
      clientState: customerState(b.session.id, "outbound"),
      linkTo: leg.telnyx_call_control_id,
      timeoutSecs: OUTBOUND_TIMEOUT_SECS,
    };
  } else {
    const internal = meta.internal;
    if (!internal) return ignoredResult("internal session without target");
    dial = {
      kind: "dial",
      commandId: b.cmdId(internal.target_profile_id, "dial:internal"),
      to: internal.target_sip,
      from: b.ctx.fromNumber ?? b.session.caller_number ?? "",
      role: "operator",
      profileId: internal.target_profile_id,
      externalNumber: null,
      clientState: { sid: b.session.id, role: "operator", operatorId: internal.target_profile_id, intent: "internal" },
      linkTo: leg.telnyx_call_control_id,
      timeoutSecs: INTERNAL_TIMEOUT_SECS,
    };
  }
  b.cmd(dial);
  b.cmd({
    kind: "bridge",
    commandId: b.cmdId(leg.telnyx_call_control_id, "bridge:own"),
    leg: ref(leg),
    target: { fromDial: dial.commandId },
    playRingtone: true,
  });
  b.setState("ringing").patchMeta({ ring: { ...(meta.ring ?? {}), mode: intent === "outbound" ? "outbound" : "internal", active_step: null } });
  const failed = b.fork();
  failed.setState("failed").patchSession({ ended_at: b.nowIso });
  failed.call.status = "failed";
  failed.call.end_reason = "dial_failed";
  failed.presenceChange({ profileId: leg.profile_id ?? "", status: "available", sessionId: null, onlyIfSession: b.session.id, reason: "dial failed" });
  b.compensate(dial.commandId, "far-end dial failed → hang up the operator leg", [hangupCmd(b, leg, "dial_failed")], failed.transition());
  b.note(`own leg answered → dialing ${intent === "outbound" ? "customer" : "colleague"}`);
  return b.result();
}

/** A ring/transfer/pickup/internal offer leg answered. */
function onOfferAnswered(b: TransitionBuilder, leg: LegRow, opts: { alreadyBridged: boolean; at: string }): ReduceResult {
  const customer = b.customerLeg();
  const intent = legIntent(leg);
  const attempt = b.attemptForLeg(leg);
  const canWin =
    customer !== undefined &&
    !b.legEnded(customer) &&
    ((b.session.state === "ringing" && !b.session.answered_by_profile_id) ||
      (WAITING_STATES.has(b.session.state) && intent === "pickup") ||
      (b.session.state === "ringing" && b.meta.ring?.mode !== "plan" && intent !== "ring"));

  if (!canWin) {
    b.cmd(hangupCmd(b, leg, "late_answer", false));
    if (attempt && !isTerminalAttemptResult(attempt.result)) b.attempt(attempt.id, { result: "cancelled", ended_at: b.nowIso });
    if (leg.profile_id) b.presenceChange({ profileId: leg.profile_id, status: "available", sessionId: null, onlyIfSession: b.session.id, onlyIfStatus: ["ringing", "on_call"], reason: "late answer" });
    return b.note("late answer → hang up").result();
  }

  const win = () => {
    b.setState("talking").patchSession({
      answered_by_profile_id: leg.profile_id ?? null,
      answered_at: b.session.answered_at ?? opts.at,
      hold_started_at: null,
      parked_at: null,
      customer_leg_id: b.session.customer_leg_id ?? (customer.id.startsWith("pending:") ? null : customer.id),
    });
    b.call.status = "answered";
    b.call.answered_at = b.session.answered_at ?? opts.at;
    b.call.operator_id = leg.profile_id ?? null;
    b.call.ring_seconds = secondsBetween(b.session.started_at, opts.at);
    if (attempt) {
      b.attempt(attempt.id, { result: "answered", answered_at: opts.at });
      b.call.ring_group_id = attempt.ring_group_id;
    }
    if (!leg.profile_id) b.patchMeta({ answered_external: leg.to_number ?? null });
    if (intent === "pickup") b.patchMeta({ pickup: null, waiting: null });
    if (intent === "transfer") b.patchMeta({ transfer: b.meta.transfer ? { ...b.meta.transfer, completed_at: opts.at } : null });
    b.patchMeta({ ring: { ...(b.meta.ring ?? {}), active_step: null, step_deadline_at: null } });

    stopMoh(b, customer);
    if (WAITING_STATES.has(b.session.state)) {
      b.cmd({ kind: "gather_stop", commandId: b.cmdId(customer.telnyx_call_control_id, "gather_stop"), leg: ref(customer), bestEffort: true });
    }
    if (!opts.alreadyBridged && intent !== "transfer") {
      const bridgeId = b.cmdId(customer.telnyx_call_control_id, "bridge", leg.telnyx_call_control_id);
      b.cmd({ kind: "bridge", commandId: bridgeId, leg: ref(customer), target: ref(leg), parkAfterUnbridge: "self" });
      const failed = b.fork();
      failed.leg(leg.telnyx_call_control_id, { state: "failed", ended_at: b.nowIso, hangup_cause: "bridge_failed" });
      if (attempt) failed.attempt(attempt.id, { result: "failed", ended_at: b.nowIso });
      if (leg.profile_id) failed.presenceChange({ profileId: leg.profile_id, status: "available", sessionId: null, onlyIfSession: b.session.id, reason: "bridge failed" });
      failed.patchSession({ answered_by_profile_id: null });
      enterWaiting(failed, customer, "bridge_failed");
      b.compensate(bridgeId, "bridge failed → operator leg hung up, customer to waiting room", [hangupCmd(b, leg, "bridge_failed"), ...failed.commands], failed.transition());
    }
    // Losers: every other open offer leg of this session.
    for (const other of b.openLegs()) {
      if (other.telnyx_call_control_id === leg.telnyx_call_control_id || isCustomer(other) || other.role === "consult" || other.role === "supervisor") continue;
      b.cmd(hangupCmd(b, other, "lose_race"));
      const otherAttempt = b.attemptForLeg(other);
      if (otherAttempt && !isTerminalAttemptResult(otherAttempt.result)) b.attempt(otherAttempt.id, { result: "cancelled", ended_at: b.nowIso });
      if (other.profile_id) {
        b.presenceChange({ profileId: other.profile_id, status: "available", sessionId: null, onlyIfSession: b.session.id, onlyIfStatus: ["ringing"], reason: "lost race" });
      }
    }
    for (const open of b.attemptsView()) {
      if (!isTerminalAttemptResult(open.result) && (!attempt || open.id !== attempt.id)) b.attempt(open.id, { result: "cancelled", ended_at: b.nowIso });
    }
    const plan = b.ringPlan();
    const member = plan?.steps.flatMap((step) => step.members).find((candidate) => candidate.profileId && candidate.profileId === leg.profile_id);
    if (member?.memberId) b.memberTouches.push({ memberId: member.memberId, field: "last_answered_at" });
    b.note(`${leg.role} ${leg.profile_id ?? leg.to_number ?? ""} answered → talking`);
  };

  if (leg.profile_id) {
    const rejected = b.fork();
    rejected.cmd(hangupCmd(rejected, leg, "operator_busy", false));
    if (attempt) rejected.attempt(attempt.id, { result: "cancelled", ended_at: b.nowIso });
    rejected.note("reservation rejected → hang up");
    win();
    b.guard = { profileId: leg.profile_id, onRejected: { next: rejected.transition(), commands: rejected.commands } };
    return b.result();
  }
  win();
  return b.result();
}

/** Consult leg answered: join the conference (customer stays on hold). */
function onConsultAnswered(b: TransitionBuilder, leg: LegRow): ReduceResult {
  if (b.session.state !== "consulting") {
    b.cmd(hangupCmd(b, leg, "consult_cancelled", false));
    return b.note("consult answered after cancel → hang up").result();
  }
  const join = () => {
    b.cmd({ kind: "conference_join", commandId: b.cmdId(leg.telnyx_call_control_id, "conference:join"), leg: ref(leg) });
    b.patchMeta({ consult: b.meta.consult ? { ...b.meta.consult, leg_call_control_id: leg.telnyx_call_control_id, answered_at: b.nowIso } : null });
    b.note("consult answered → joined conference");
  };
  if (leg.profile_id) {
    const rejected = b.fork();
    rejected.cmd(hangupCmd(rejected, leg, "operator_busy", false));
    join();
    b.guard = { profileId: leg.profile_id, onRejected: { next: rejected.transition(), commands: rejected.commands } };
    return b.result();
  }
  join();
  return b.result();
}

// ---------------------------------------------------------------------------
// call.hangup
// ---------------------------------------------------------------------------

function onHangup(b: TransitionBuilder, event: TelephonyEvent): ReduceResult {
  if (!event.callControlId) return ignoredResult("call.hangup without call_control_id");
  const at = event.occurredAt ?? b.nowIso;
  let leg = b.findLeg(event.callControlId);
  if (!leg) {
    const state = event.clientState;
    if (!state || state.sid !== b.session.id) return ignoredResult("foreign leg");
    leg = syntheticLeg(b, event, state);
    b.leg(leg.telnyx_call_control_id, { ...legValuesFromSynthetic(leg), state: "ended", ended_at: at, hangup_cause: event.hangupCause, hangup_source: event.hangupSource }, true);
  } else {
    if (leg.ended_at) return ignoredResult("duplicate hangup");
    b.leg(leg.telnyx_call_control_id, { state: "ended", ended_at: at, hangup_cause: event.hangupCause, hangup_source: event.hangupSource });
  }

  if (isCustomer(leg)) return onCustomerHangup(b, leg, event, at);
  return onPartyHangup(b, leg, event, at);
}

function onCustomerHangup(b: TransitionBuilder, leg: LegRow, event: TelephonyEvent, at: string): ReduceResult {
  const state = b.session.state;
  const meta = b.meta;
  const appHangup = meta.hangup ?? null;
  const cause = appHangup ? "operator_hangup" : "caller_hangup";

  if (TERMINAL_STATES.has(state) || state === "wrap_up" || state === "missed") {
    finishIfQuiet(b, at);
    return b.result();
  }

  for (const other of b.openLegs()) {
    if (other.telnyx_call_control_id === leg.telnyx_call_control_id) continue;
    b.cmd(hangupCmd(b, other, "customer_left"));
  }
  cancelOpenAttempts(b, at, "customer left");

  if (state === "ringing" && meta.ring?.mode === "plan") {
    b.setState("missed");
    b.call.status = "missed";
    b.call.end_reason = cause;
    b.call.ended_at = at;
    b.callback({ source: "missed", callerNumber: b.session.caller_number ?? "", createTask: Boolean(b.session.case_id) });
    b.note("customer hung up while ringing → missed");
  } else if (state === "ringing") {
    // Outbound / internal / transfer / pickup ringing: nobody answered the far end.
    const answered = Boolean(b.session.answered_at);
    b.setState(answered ? "wrap_up" : "ended");
    b.call.status = answered ? "ended" : b.session.direction === "inbound" ? "missed" : "ended";
    b.call.end_reason = answered ? cause : classifyRingHangup({ hangupCause: event.hangupCause, sipHangupCause: event.sipHangupCause });
    b.call.ended_at = at;
    if (!answered && b.session.direction === "inbound") {
      b.callback({ source: "missed", callerNumber: b.session.caller_number ?? "", createTask: Boolean(b.session.case_id) });
    }
    releaseTalkingOperators(b, answered);
    b.note("far end left while ringing");
  } else if (TALKING_STATES.has(state)) {
    b.setState("wrap_up");
    b.call.status = "ended";
    b.call.end_reason = cause;
    b.call.ended_at = at;
    releaseTalkingOperators(b, true);
    b.note("customer hung up while talking → wrap-up");
  } else if (WAITING_STATES.has(state)) {
    const answered = Boolean(b.session.answered_at);
    b.setState("ended").patchSession({ ended_at: at });
    b.call.status = answered ? "ended" : "abandoned_queue";
    b.call.end_reason = appHangup ? "operator_hangup" : "abandoned_in_queue";
    b.call.ended_at = at;
    if (!answered) b.callback({ source: "missed", callerNumber: b.session.caller_number ?? "", createTask: Boolean(b.session.case_id) });
    releaseTalkingOperators(b, answered);
    b.note("customer left the waiting room");
  } else {
    // received / greeting / ivr / after_hours / callback_offered
    const requested = Boolean(meta.callback?.confirmed);
    b.setState("ended").patchSession({ ended_at: at });
    b.call.status = requested ? "ended" : "missed";
    b.call.end_reason = requested ? "callback_requested" : appHangup ? "operator_hangup" : state === "after_hours" ? "after_hours" : cause;
    b.call.ended_at = at;
    if (!requested && (state === "ivr" || state === "greeting" || (state === "callback_offered" && meta.callback?.source === "missed"))) {
      b.callback({ source: "missed", callerNumber: b.session.caller_number ?? "", createTask: Boolean(b.session.case_id) });
    }
    b.note(`customer left during ${state}`);
  }

  finishIfQuiet(b, at);
  return b.result();
}

function cancelOpenAttempts(b: TransitionBuilder, at: string, reason: string): void {
  for (const attempt of b.attemptsView()) {
    if (isTerminalAttemptResult(attempt.result)) continue;
    b.attempt(attempt.id, { result: "cancelled", ended_at: at });
    if (attempt.profile_id) {
      b.presenceChange({ profileId: attempt.profile_id, status: "available", sessionId: null, onlyIfSession: b.session.id, onlyIfStatus: ["ringing"], reason });
    }
  }
}

/** Operators who were talking go to wrap-up; operators still dialing go back to available. */
function releaseTalkingOperators(b: TransitionBuilder, wrapUp: boolean): void {
  const seen = new Set<string>();
  for (const leg of b.legs) {
    if (!leg.profile_id || isCustomer(leg) || seen.has(leg.profile_id)) continue;
    seen.add(leg.profile_id);
    const talked = Boolean(leg.answered_at) || leg.profile_id === b.session.answered_by_profile_id;
    b.presenceChange({
      profileId: leg.profile_id,
      status: wrapUp && talked ? "after_call_work" : "available",
      sessionId: null,
      startWrapUp: wrapUp && talked,
      onlyIfSession: b.session.id,
      reason: wrapUp && talked ? "call ended" : "session ended",
    });
  }
}

/** Moves the session to `ended` once every leg is terminal. */
function finishIfQuiet(b: TransitionBuilder, at: string): void {
  if (b.openLegs().length > 0) return;
  if (b.state === "ended" || b.state === "failed") {
    if (!b.session.ended_at) b.patchSession({ ended_at: at });
    return;
  }
  b.setState("ended").patchSession({ ended_at: at });
  if (!b.call.ended_at) b.call.ended_at = at;
  b.note("all legs ended → ended");
}

function onPartyHangup(b: TransitionBuilder, leg: LegRow, event: TelephonyEvent, at: string): ReduceResult {
  const state = b.session.state;
  const meta = b.meta;
  const intent = legIntent(leg);
  const attempt = b.attemptForLeg(leg);
  const answered = Boolean(leg.answered_at);

  // 1. An offer that ended without being answered.
  if (!answered) {
    if (attempt && !isTerminalAttemptResult(attempt.result)) {
      b.attempt(attempt.id, { result: classifyRingHangup({ hangupCause: event.hangupCause, sipHangupCause: event.sipHangupCause }), ended_at: at });
    }
    if (leg.profile_id) {
      b.presenceChange({ profileId: leg.profile_id, status: "available", sessionId: null, onlyIfSession: b.session.id, onlyIfStatus: ["ringing"], reason: "offer ended" });
    }
    const customer = b.customerLeg();
    if (state === "ringing" && meta.ring?.mode === "plan" && customer && !b.legEnded(customer)) {
      continueRinging(b, customer);
    } else if (state === "ringing" && meta.ring?.mode === "transfer" && customer && !b.legEnded(customer)) {
      b.patchMeta({ transfer: null });
      enterWaiting(b, customer, "transfer_failed");
    } else if (state === "ringing" && (meta.ring?.mode === "outbound" || meta.ring?.mode === "internal") && leg.role !== "customer") {
      // The caller's own leg dropped before the far end answered (only reachable for internal callee legs here).
      if (customer && !b.legEnded(customer)) b.cmd(hangupCmd(b, customer, "no_answer"));
      b.setState("ended").patchSession({ ended_at: at });
      b.call.status = "ended";
      b.call.end_reason = classifyRingHangup({ hangupCause: event.hangupCause, sipHangupCause: event.sipHangupCause });
      b.call.ended_at = at;
      releaseTalkingOperators(b, false);
    } else if (state === "received" && (intent === "outbound" || intent === "internal_caller")) {
      b.setState("ended").patchSession({ ended_at: at });
      b.call.status = "ended";
      b.call.end_reason = "operator_cancel";
      b.call.ended_at = at;
      releaseTalkingOperators(b, false);
    } else if (WAITING_STATES.has(state) && intent === "pickup") {
      b.patchMeta({ pickup: null });
    } else if (state === "consulting" && leg.role === "consult" && customer && !b.legEnded(customer)) {
      backFromConsult(b, customer, "consult_no_answer");
    }
    finishIfQuiet(b, at);
    return b.result();
  }

  // 2. A party that had answered.
  const customer = b.customerLeg();
  const customerOpen = customer !== undefined && !b.legEnded(customer);
  const isOwner = leg.profile_id ? leg.profile_id === b.session.answered_by_profile_id : leg.role === "external" && !b.session.answered_by_profile_id;

  if (state === "consulting" && leg.role === "consult" && customerOpen) {
    backFromConsult(b, customer, "consult_left");
    if (leg.profile_id) b.presenceChange({ profileId: leg.profile_id, status: "after_call_work", sessionId: null, startWrapUp: true, onlyIfSession: b.session.id, reason: "consult ended" });
  } else if (state === "consulting" && isOwner && customerOpen) {
    const consultLeg = b.openLegs().find((candidate) => candidate.role === "consult");
    if (consultLeg?.answered_at) {
      completeTransfer(b, customer, consultLeg, leg.profile_id, "operator_left");
    } else {
      if (consultLeg) b.cmd(hangupCmd(b, consultLeg, "operator_left"));
      operatorLost(b, customer, leg);
    }
  } else if ((TALKING_STATES.has(state) || state === "wrap_up") && isOwner && customerOpen && !meta.hangup) {
    operatorLost(b, customer, leg);
  } else if (leg.profile_id) {
    // Idempotent release: only an operator still bound to this call moves to wrap-up.
    const reason = state === "parked" || state === "waiting" ? "parked" : state === "wrap_up" || state === "missed" || state === "ended" || meta.hangup ? "leg ended" : "left call";
    b.presenceChange({ profileId: leg.profile_id, status: "after_call_work", sessionId: null, startWrapUp: true, onlyIfSession: b.session.id, onlyIfStatus: ["on_call", "ringing"], reason });
  }
  finishIfQuiet(b, at);
  return b.result();
}

/** Operator dropped (tab closed, network) while the customer is still there → waiting room. */
function operatorLost(b: TransitionBuilder, customer: LegRow, leg: LegRow): void {
  if (b.session.conference_id) {
    b.cmd({ kind: "conference_leave", commandId: b.cmdId(customer.telnyx_call_control_id, "conference:leave"), leg: ref(customer), bestEffort: true });
    b.patchSession({ conference_id: null, conference_name: null });
  }
  b.patchSession({ answered_by_profile_id: null, hold_started_at: null });
  b.patchMeta({ previous_operator: leg.profile_id ?? null, consult: null, conference: null });
  enterWaiting(b, customer, "operator_lost");
  if (leg.profile_id) b.presenceChange({ profileId: leg.profile_id, status: "after_call_work", sessionId: null, startWrapUp: true, onlyIfSession: b.session.id, onlyIfStatus: ["on_call", "ringing"], reason: "operator lost" });
}

function backFromConsult(b: TransitionBuilder, customer: LegRow, reason: string): void {
  b.cmd({ kind: "conference_unhold", commandId: b.cmdId(customer.telnyx_call_control_id, `conference:unhold:${reason}`), legs: [ref(customer)], bestEffort: true });
  b.setState("talking").patchSession({ hold_started_at: null }).patchMeta({ consult: null });
  b.note(`back to talking (${reason})`);
}

function completeTransfer(b: TransitionBuilder, customer: LegRow, consultLeg: LegRow, previousOperator: string | null, reason: string): void {
  b.cmd({ kind: "conference_unhold", commandId: b.cmdId(customer.telnyx_call_control_id, `conference:unhold:${reason}`), legs: [ref(customer)], bestEffort: true });
  b.leg(consultLeg.telnyx_call_control_id, { role: consultLeg.profile_id ? "operator" : "external" });
  b.setState("talking").patchSession({ answered_by_profile_id: consultLeg.profile_id ?? null, hold_started_at: null });
  b.patchMeta({
    consult: null,
    transfer: { kind: "attended", target: b.meta.consult?.target ?? { kind: "number", number: consultLeg.to_number ?? "", label: consultLeg.to_number ?? "" }, by: previousOperator, at: b.nowIso, completed_at: b.nowIso },
    previous_operator: previousOperator,
  });
  if (consultLeg.profile_id) b.call.operator_id = consultLeg.profile_id;
  if (previousOperator) b.presenceChange({ profileId: previousOperator, status: "after_call_work", sessionId: null, startWrapUp: true, onlyIfSession: b.session.id, reason: "transfer completed" });
  b.note(`attended transfer completed (${reason})`);
}

/** After an offer leg ended: next ordered member, next step, or fallback. */
function continueRinging(b: TransitionBuilder, customer: LegRow): void {
  const plan = b.ringPlan();
  const active = b.activeRingStep();
  if (!plan || active === null) return;
  const view = b.attemptsView().filter((attempt) => attempt.step_index === active);
  if (view.some((attempt) => !isTerminalAttemptResult(attempt.result))) {
    b.note(`step ${active}: still ringing others`);
    return;
  }
  if (active >= plan.steps.length) {
    // The synthetic `external_number` fallback step just ended unanswered:
    // there is no plan step to walk to, go straight to the next fallback.
    applyFallback(b, customer, plan);
    return;
  }
  const planned = planStep(b, plan, active);
  if (planned.attempts.length > 0) {
    // `ordered` walks to the next member; `all` only gets here when a member was
    // held back earlier (leg cap) and has become dialable meanwhile.
    fanout(b, customer, active, planned, null);
    return;
  }
  if (planned.capacityLimited && capacityWaitedMs(b) < CAPACITY_WAIT_MAX_MS) {
    holdStepForCapacity(b, active);
    return;
  }
  if (ringFromStep(b, customer, plan, active + 1)) return;
  applyFallback(b, customer, plan);
}

// ---------------------------------------------------------------------------
// call.gather.ended / call.playback.ended
// ---------------------------------------------------------------------------

function onGatherEnded(b: TransitionBuilder, event: TelephonyEvent): ReduceResult {
  const leg = b.findLeg(event.callControlId);
  if (!leg || !isCustomer(leg)) return ignoredResult("gather on a non-customer leg");
  if (b.legEnded(leg)) return ignoredResult("customer leg ended");
  if (event.status === "call_hangup" || event.status === "cancelled" || event.status === "cancelled_amd") return ignoredResult(`gather ${event.status}`);
  const purpose = event.clientState?.intent ?? null;
  const digits = event.status === "valid" ? (event.digits ?? "") : "";
  const state = b.session.state;

  if (state === "ivr" && (purpose === "ivr" || purpose === null)) return onIvrChoice(b, leg, digits);
  if ((state === "after_hours" || state === "callback_offered") && purpose !== "moh_tick") return onCallbackChoice(b, leg, digits);
  if (WAITING_STATES.has(state)) return onWaitingTick(b, leg);
  return ignoredResult(`gather in ${state}`);
}

/**
 * One `call.gather.ended` in the `ivr` state. The mapping, the retry budget and
 * the fallbacks live in `routing/ivr.ts`; this function only turns the decision
 * into commands.
 */
function onIvrChoice(b: TransitionBuilder, leg: LegRow, digits: string): ReduceResult {
  const ivr = b.ctx.ivr;
  const plan = b.ringPlan();
  const tries = b.meta.ivr?.tries ?? 1;
  const decision = decideIvr({ config: ivr, outcome: { digits }, tries, availablePlanIds: Object.keys(b.ctx.ringPlans) });
  b.patchMeta({
    ivr: {
      ...(b.meta.ivr ?? { tries }),
      menu_id: ivr?.menu.id ?? b.meta.ivr?.menu_id ?? "",
      tries,
      chosen: digits || null,
      action: decision.kind === "default" ? "default" : decision.kind === "retry" ? "repeat" : decision.kind,
    },
  });
  b.note(describeIvrDecision(decision));

  switch (decision.kind) {
    case "ring_plan": {
      const target = decision.planId ? b.ctx.ringPlans[decision.planId] : plan;
      startRingPlan(b, leg, target ?? plan);
      return b.result();
    }
    case "callback":
      confirmCallback(b, leg, "ivr", decision.prompt);
      return b.result();
    case "external_number":
      blindTransferCustomer(b, leg, { kind: "number", number: decision.number, label: decision.option.label }, null);
      return b.result();
    case "waiting_room":
      enterWaiting(b, leg, "ivr");
      return b.result();
    case "retry":
      startIvr(b, leg, decision.tries);
      return b.result();
    case "hangup":
      closeWithIvrMessage(b, leg, decision.prompt);
      return b.result();
    case "default":
      startRingPlan(b, leg, plan);
      return b.result();
  }
}

/**
 * The "closing message" target: the caller is told something and the call ends.
 *
 * With a recording the message is played first and the hangup follows
 * `call.playback.ended` (`onPlaybackEnded`); without one — no recording on the
 * option, or no media base configured — the call ends straight away rather than
 * leaving the caller in silence.
 */
function closeWithIvrMessage(b: TransitionBuilder, leg: LegRow, prompt: MediaRef | null): void {
  if (prompt && b.ctx.mediaAvailable) {
    b.setState("missed").patchSession({ ended_at: null });
    b.call.status = "missed";
    b.call.end_reason = "ivr_message";
    b.cmd({ kind: "playback_start", commandId: b.cmdId(leg.telnyx_call_control_id, "playback:ivr_message"), leg: ref(leg), media: prompt });
    return;
  }
  b.cmd(hangupCmd(b, leg, "ivr_hangup", false));
}

function onCallbackChoice(b: TransitionBuilder, leg: LegRow, digits: string): ReduceResult {
  const source = b.meta.callback?.source ?? (b.session.state === "after_hours" ? "after_hours" : "missed");
  if (digits === "1") {
    confirmCallback(b, leg, source);
    return b.result();
  }
  b.patchMeta({ callback: { ...(b.meta.callback ?? {}), source, confirmed: false, declined_at: b.nowIso } });
  b.cmd(hangupCmd(b, leg, "callback_declined", false));
  return b.note("callback declined → hangup").result();
}

function confirmCallback(
  b: TransitionBuilder,
  leg: LegRow,
  source: "ivr" | "after_hours" | "park_timeout" | "missed" | "manual",
  /** Recording of the IVR option that asked for the callback; the shared confirmation otherwise. */
  prompt: MediaRef | null = null,
): void {
  b.setState("callback_offered").patchMeta({ callback: { requested_at: b.nowIso, source, confirmed: true } });
  b.callback({ source, callerNumber: b.session.caller_number ?? "", createTask: Boolean(b.session.case_id) });
  if (b.ctx.mediaAvailable) {
    b.cmd({ kind: "playback_start", commandId: b.cmdId(leg.telnyx_call_control_id, "playback:callback_confirmed"), leg: ref(leg), media: prompt ?? { key: "callbackConfirmed" } });
  } else {
    b.cmd(hangupCmd(b, leg, "callback_confirmed", false));
  }
  b.note(`callback requested (${source})`);
}

function onWaitingTick(b: TransitionBuilder, leg: LegRow): ReduceResult {
  const waiting = b.meta.waiting ?? { since: b.session.parked_at ?? b.nowIso, reason: "unknown", ticks: 0 };
  const since = Date.parse(b.session.parked_at ?? waiting.since ?? b.nowIso);
  // Frozen at `enterWaiting`; the live value only serves sessions that entered
  // the waiting room before this field existed.
  const limitMinutes = typeof waiting.max_minutes === "number" && waiting.max_minutes > 0 ? waiting.max_minutes : b.ctx.settings.parkMaxMinutes;
  const limitMs = limitMinutes * 60_000;
  if (!Number.isNaN(since) && b.ctx.now.getTime() - since >= limitMs) {
    b.patchMeta({ waiting: { ...waiting, ticks: waiting.ticks + 1, last_tick_at: b.nowIso }, park: b.meta.park ? { ...b.meta.park, timed_out_at: b.nowIso } : null });
    offerCallback(b, leg, { key: "callbackOffer" }, "park_timeout");
    b.note("park limit reached → callback offer");
    return b.result();
  }
  b.patchMeta({ waiting: { ...waiting, ticks: waiting.ticks + 1, last_tick_at: b.nowIso } });
  b.cmd(gatherCmd(b, leg, mohTickSpec()));
  return b.note("MOH tick").result();
}

function onPlaybackEnded(b: TransitionBuilder, event: TelephonyEvent): ReduceResult {
  const leg = b.findLeg(event.callControlId);
  if (!leg || !isCustomer(leg)) return ignoredResult("playback on a non-customer leg");
  if (b.legEnded(leg)) return ignoredResult("customer leg ended");
  if (event.status === "call_hangup" || event.status === "cancelled" || event.status === "cancelled_amd") return ignoredResult(`playback ${event.status}`);
  const state = b.session.state;
  if (state === "callback_offered" && b.meta.callback?.confirmed) {
    b.cmd(hangupCmd(b, leg, "callback_confirmed", false));
    return b.note("callback confirmation played → hangup").result();
  }
  if (state === "missed" && b.meta.ring?.fallback === "hangup_message") {
    b.cmd(hangupCmd(b, leg, "all_busy", false));
    return b.note("all-busy message played → hangup").result();
  }
  if (state === "missed" && b.meta.ivr?.action === "hangup") {
    b.cmd(hangupCmd(b, leg, "ivr_hangup", false));
    return b.note("IVR closing message played → hangup").result();
  }
  if (WAITING_STATES.has(state) && b.ctx.mediaAvailable) {
    // An infinite loop should never end on its own; if it did, the caller would
    // sit in silence until pickup.
    startMoh(b, leg);
    return b.note("waiting-room music restarted").result();
  }
  return ignoredResult(`playback ended in ${state}`);
}

function onSdkHold(b: TransitionBuilder, event: TelephonyEvent): ReduceResult {
  const leg = b.findLeg(event.callControlId);
  if (!leg) return ignoredResult("hold on unknown leg");
  b.leg(leg.telnyx_call_control_id, { state: (event.type === "call.hold" ? "held" : leg.bridged_at ? "bridged" : "answered") as CallLegState });
  b.patchMeta({ sdk_hold: event.type === "call.hold" ? { leg: leg.telnyx_call_control_id, at: b.nowIso } : null });
  return b.note(event.type).result();
}

function onConferenceCreated(b: TransitionBuilder, event: TelephonyEvent): ReduceResult {
  if (!event.conferenceId || b.session.conference_id) return ignoredResult("conference already known");
  b.patchSession({ conference_id: event.conferenceId });
  return b.note("conference id recorded").result();
}

// ---------------------------------------------------------------------------
// App intents
// ---------------------------------------------------------------------------

export class CallActionRejected extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "CallActionRejected";
  }
}

function reduceApp(b: TransitionBuilder, event: AppEvent): ReduceResult {
  if (event.type === "sweep") return onSweep(b);
  if (!ACTIVE_SESSION_STATES.has(b.session.state)) throw new CallActionRejected("Hovor už nie je aktívny.", 409);
  const customer = b.customerLeg();
  if (!customer || b.legEnded(customer)) {
    // Outbound/internal call cancelled before the far end exists: only the operator's own leg is up.
    if (event.type === "hangup" && b.openLegs().length > 0) return appHangup(b, null, event);
    throw new CallActionRejected("Hovor už nie je aktívny.", 409);
  }

  switch (event.type) {
    case "hold":
      return appHold(b, customer);
    case "unhold":
      return appUnhold(b, customer);
    case "park":
      return appPark(b, customer, event);
    case "pickup":
      return appPickup(b, customer, event);
    case "blind_transfer":
      return appBlindTransfer(b, customer, event);
    case "consult":
      return appConsult(b, customer, event);
    case "complete_transfer":
      return appCompleteTransfer(b, customer, event);
    case "cancel_consult":
      return appCancelConsult(b, customer);
    case "hangup":
      return appHangup(b, customer, event);
    default:
      return ignoredResult(`unknown app event ${(event as AppEvent).type}`);
  }
}

/**
 * Lazy conference promotion (design §2.1): the **operator** leg creates the
 * conference and the customer joins it.
 *
 * Creating a conference from a bridged leg ends the bridge, and Telnyx documents
 * `park_after_unbridge` as the only thing that saves a leg from being hung up
 * when its bridge ends. The inbound bridge is issued on the customer leg with
 * `park_after_unbridge: "self"` (`onLegAnswered`), so the customer is protected
 * by definition while the operator leg is not: the operator must therefore be
 * the leg that moves *itself* into the conference. Promoting from the customer
 * side would risk tearing down the operator's WebRTC leg, which no compensation
 * could restore (see docs/operations/telnyx-runbook.md, spike "conference
 * promotion").
 */
function promoteToConference(b: TransitionBuilder, customer: LegRow, operator: LegRow, actor: string | null): void {
  if (b.session.conference_id) return;
  const createId = b.cmdId(operator.telnyx_call_control_id, "conference:create");
  b.cmd({ kind: "conference_create", commandId: createId, leg: ref(operator), name: `sess-${b.session.id}` });
  const joinId = b.cmdId(customer.telnyx_call_control_id, "conference:join");
  b.cmd({ kind: "conference_join", commandId: joinId, leg: ref(customer) });
  b.patchMeta({ conference: { promoted_at: b.nowIso, by: actor } });
  const failed = b.fork();
  failed.patchSession({ state: b.session.state, hold_started_at: b.session.hold_started_at, conference_id: null, conference_name: null });
  failed.patchMeta({ conference: null, consult: null });
  b.compensate(createId, "conference promotion failed → call stays bridged", [], failed.transition());
  // The create already moved the operator into the conference and parked the
  // customer: take the operator back out and re-bridge, otherwise the operator
  // would sit alone in a conference the customer never joined.
  b.compensate(
    joinId,
    "conference join failed → operator left the conference and re-bridged",
    [
      { kind: "conference_leave", commandId: b.cmdId(operator.telnyx_call_control_id, "conference:leave:join_failed"), leg: ref(operator), bestEffort: true },
      { kind: "bridge", commandId: b.cmdId(customer.telnyx_call_control_id, "bridge:rejoin"), leg: ref(customer), target: ref(operator), parkAfterUnbridge: "self", bestEffort: true },
    ],
    failed.transition(),
  );
}

function requireOperatorLeg(b: TransitionBuilder): LegRow {
  const leg = b.answeringLeg();
  if (!leg) throw new CallActionRejected("Hovor nemá pripojeného operátora.", 409);
  return leg;
}

function appHold(b: TransitionBuilder, customer: LegRow): ReduceResult {
  if (b.session.state !== "talking") throw new CallActionRejected("Podržať je možné len prebiehajúci hovor.", 409);
  const operator = requireOperatorLeg(b);
  promoteToConference(b, customer, operator, (b.event as AppEvent).actorProfileId);
  b.cmd({ kind: "conference_hold", commandId: b.cmdId(customer.telnyx_call_control_id, "conference:hold"), legs: [ref(customer)], media: { key: "moh" } });
  b.setState("held").patchSession({ hold_started_at: b.nowIso });
  b.leg(customer.telnyx_call_control_id, { state: "held" });
  return b.note("hold").result();
}

function appUnhold(b: TransitionBuilder, customer: LegRow): ReduceResult {
  if (b.session.state !== "held") throw new CallActionRejected("Hovor nie je podržaný.", 409);
  b.cmd({ kind: "conference_unhold", commandId: b.cmdId(customer.telnyx_call_control_id, "conference:unhold"), legs: [ref(customer)] });
  b.setState("talking").patchSession({ hold_started_at: null });
  b.leg(customer.telnyx_call_control_id, { state: "bridged" });
  return b.note("unhold").result();
}

function appPark(b: TransitionBuilder, customer: LegRow, event: AppEvent): ReduceResult {
  if (b.session.state !== "talking" && b.session.state !== "held") throw new CallActionRejected("Zaparkovať je možné len prebiehajúci hovor.", 409);
  const operator = requireOperatorLeg(b);
  if (b.session.conference_id) {
    if (b.session.state === "held") {
      b.cmd({ kind: "conference_unhold", commandId: b.cmdId(customer.telnyx_call_control_id, "conference:unhold:park"), legs: [ref(customer)], bestEffort: true });
    }
    b.cmd({ kind: "conference_leave", commandId: b.cmdId(customer.telnyx_call_control_id, "conference:leave:park"), leg: ref(customer), bestEffort: true });
  }
  b.cmd(hangupCmd(b, operator, "parked", false));
  b.patchSession({ parked_at: b.nowIso, answered_by_profile_id: null, hold_started_at: null, conference_id: null, conference_name: null });
  b.patchMeta({ park: { by: event.actorProfileId, at: b.nowIso }, previous_operator: operator.profile_id ?? null, conference: null });
  enterWaiting(b, customer, "parked", "parked");
  b.leg(customer.telnyx_call_control_id, { state: "answered" });
  if (operator.profile_id) b.presenceChange({ profileId: operator.profile_id, status: "after_call_work", sessionId: null, startWrapUp: true, onlyIfSession: b.session.id, reason: "parked" });
  return b.result();
}

function appPickup(b: TransitionBuilder, customer: LegRow, event: AppEvent): ReduceResult {
  if (!WAITING_STATES.has(b.session.state)) throw new CallActionRejected("Hovor nie je v čakárni.", 409);
  if (!event.picker) throw new CallActionRejected("Chýba telefón operátora.", 400);
  const pending = b.meta.pickup;
  if (pending && Date.parse(pending.at) + PICKUP_STALE_MS > b.ctx.now.getTime() && pending.by !== event.picker.profileId) {
    throw new CallActionRejected("Hovor už preberá iný operátor.", 409);
  }
  const dial: DialCommand = {
    kind: "dial",
    commandId: b.cmdId(event.picker.profileId, "dial:pickup"),
    to: event.picker.sipUri,
    from: b.ctx.fromNumber ?? b.session.called_number ?? "",
    role: "operator",
    profileId: event.picker.profileId,
    externalNumber: null,
    clientState: { sid: b.session.id, role: "operator", operatorId: event.picker.profileId, intent: "pickup", autoAnswer: true },
    linkTo: customer.telnyx_call_control_id,
    timeoutSecs: PICKUP_TIMEOUT_SECS,
    autoAnswer: true,
  };
  b.cmd(dial);
  b.patchMeta({ pickup: { by: event.picker.profileId, at: b.nowIso } });
  const failed = b.fork();
  failed.patchMeta({ pickup: null });
  b.compensate(dial.commandId, "pickup dial failed", [], failed.transition());
  return b.note(`pickup by ${event.picker.profileId}`).result();
}

function blindTransferCustomer(b: TransitionBuilder, customer: LegRow, target: TransferTarget, actor: string | null): void {
  const operator = b.answeringLeg();
  // A caller transferred straight out of the waiting room must not carry the
  // music loop into the transfer.
  stopMoh(b, customer);
  if (b.session.state === "held") {
    b.cmd({ kind: "conference_unhold", commandId: b.cmdId(customer.telnyx_call_control_id, "conference:unhold:transfer"), legs: [ref(customer)], bestEffort: true });
  }
  if (b.session.conference_id) {
    b.cmd({ kind: "conference_leave", commandId: b.cmdId(customer.telnyx_call_control_id, "conference:leave:transfer"), leg: ref(customer), bestEffort: true });
  }
  const targetClientState: TelnyxClientState =
    target.kind === "operator"
      ? { sid: b.session.id, role: "operator", operatorId: target.profileId, intent: "transfer" }
      : { sid: b.session.id, role: "external", intent: "transfer" };
  const transferId = b.cmdId(customer.telnyx_call_control_id, "transfer");
  b.cmd({
    kind: "transfer",
    commandId: transferId,
    leg: ref(customer),
    to: target.kind === "operator" ? target.sipUri : target.number,
    from: b.ctx.fromNumber ?? b.session.called_number,
    targetClientState,
    timeoutSecs: DEFAULT_TRANSFER_TIMEOUT_SECS,
  });
  if (operator) b.cmd(hangupCmd(b, operator, "transferred"));
  b.setState("ringing").patchSession({ answered_by_profile_id: null, hold_started_at: null, conference_id: null, conference_name: null });
  b.patchMeta({
    transfer: { kind: "blind", target, by: actor, at: b.nowIso },
    ring: { ...(b.meta.ring ?? {}), mode: "transfer", active_step: null, step_deadline_at: stepDeadline(b.ctx.now, DEFAULT_TRANSFER_TIMEOUT_SECS) },
    previous_operator: operator?.profile_id ?? null,
    conference: null,
  });
  if (operator?.profile_id) b.presenceChange({ profileId: operator.profile_id, status: "after_call_work", sessionId: null, startWrapUp: true, onlyIfSession: b.session.id, reason: "blind transfer" });
  const failed = b.fork();
  failed.patchSession({
    state: b.session.state,
    answered_by_profile_id: b.session.answered_by_profile_id,
    hold_started_at: b.session.hold_started_at,
    conference_id: b.session.conference_id,
    conference_name: b.session.conference_name,
  });
  failed.patchMeta({ transfer: null, ring: b.meta.ring ?? null });
  b.compensate(transferId, "transfer failed → call stays with the operator", [], failed.transition());
  b.note(`blind transfer → ${target.label}`);
}

function appBlindTransfer(b: TransitionBuilder, customer: LegRow, event: AppEvent): ReduceResult {
  if (b.session.state !== "talking" && b.session.state !== "held") throw new CallActionRejected("Prepojiť je možné len prebiehajúci hovor.", 409);
  if (!event.target) throw new CallActionRejected("Chýba cieľ prepojenia.", 400);
  blindTransferCustomer(b, customer, event.target, event.actorProfileId);
  return b.result();
}

function appConsult(b: TransitionBuilder, customer: LegRow, event: AppEvent): ReduceResult {
  if (b.session.state !== "talking" && b.session.state !== "held") throw new CallActionRejected("Konzultovať je možné len prebiehajúci hovor.", 409);
  if (!event.target) throw new CallActionRejected("Chýba cieľ konzultácie.", 400);
  const operator = requireOperatorLeg(b);
  promoteToConference(b, customer, operator, event.actorProfileId);
  if (b.session.state !== "held") {
    b.cmd({ kind: "conference_hold", commandId: b.cmdId(customer.telnyx_call_control_id, "conference:hold:consult"), legs: [ref(customer)], media: { key: "moh" } });
  }
  const target = event.target;
  const dial: DialCommand = {
    kind: "dial",
    commandId: b.cmdId(target.kind === "operator" ? target.profileId : target.number, "dial:consult"),
    to: target.kind === "operator" ? target.sipUri : target.number,
    from: b.ctx.fromNumber ?? b.session.called_number ?? "",
    role: "consult",
    profileId: target.kind === "operator" ? target.profileId : null,
    externalNumber: target.kind === "number" ? target.number : null,
    clientState: target.kind === "operator" ? { sid: b.session.id, role: "consult", operatorId: target.profileId, intent: "consult" } : { sid: b.session.id, role: "consult", intent: "consult" },
    linkTo: customer.telnyx_call_control_id,
    timeoutSecs: CONSULT_TIMEOUT_SECS,
  };
  b.cmd(dial);
  b.setState("consulting").patchSession({ hold_started_at: b.session.hold_started_at ?? b.nowIso });
  b.patchMeta({ consult: { target, by: event.actorProfileId, at: b.nowIso } });
  const failed = b.fork();
  failed.setState("talking").patchSession({ hold_started_at: null }).patchMeta({ consult: null });
  b.compensate(dial.commandId, "consult dial failed → customer unheld", [{ kind: "conference_unhold", commandId: b.cmdId(customer.telnyx_call_control_id, "conference:unhold:consult_failed"), legs: [ref(customer)], bestEffort: true }], failed.transition());
  return b.note(`consult → ${target.label}`).result();
}

function appCompleteTransfer(b: TransitionBuilder, customer: LegRow, event: AppEvent): ReduceResult {
  if (b.session.state !== "consulting") throw new CallActionRejected("Hovor nie je v konzultácii.", 409);
  const consultLeg = b.openLegs().find((leg) => leg.role === "consult");
  if (!consultLeg?.answered_at) throw new CallActionRejected("Konzultovaný hovor ešte nebol prijatý.", 409);
  const operator = b.answeringLeg();
  completeTransfer(b, customer, consultLeg, operator?.profile_id ?? event.actorProfileId, "completed");
  if (operator) {
    b.cmd({ kind: "conference_leave", commandId: b.cmdId(operator.telnyx_call_control_id, "conference:leave:complete"), leg: ref(operator), bestEffort: true });
    b.cmd(hangupCmd(b, operator, "transfer_completed"));
  }
  return b.result();
}

function appCancelConsult(b: TransitionBuilder, customer: LegRow): ReduceResult {
  if (b.session.state !== "consulting") throw new CallActionRejected("Hovor nie je v konzultácii.", 409);
  const consultLeg = b.openLegs().find((leg) => leg.role === "consult");
  if (consultLeg) b.cmd(hangupCmd(b, consultLeg, "consult_cancelled"));
  backFromConsult(b, customer, "cancelled");
  if (consultLeg?.profile_id) b.presenceChange({ profileId: consultLeg.profile_id, status: "available", sessionId: null, onlyIfSession: b.session.id, reason: "consult cancelled" });
  return b.result();
}

function appHangup(b: TransitionBuilder, customer: LegRow | null, event: AppEvent): ReduceResult {
  b.patchMeta({ hangup: { by: event.actorProfileId, at: b.nowIso, scope: "session" } });
  if (customer) b.cmd(hangupCmd(b, customer, "app_hangup", false));
  for (const leg of b.openLegs()) {
    if (customer && leg.telnyx_call_control_id === customer.telnyx_call_control_id) continue;
    b.cmd(hangupCmd(b, leg, "app_hangup", customer !== null));
  }
  const answered = Boolean(b.session.answered_at);
  const state = b.session.state;
  if (TALKING_STATES.has(state)) {
    b.setState("wrap_up");
    b.call.status = "ended";
    b.call.end_reason = "operator_hangup";
    b.call.ended_at = b.nowIso;
    releaseTalkingOperators(b, true);
  } else if (state === "ringing" && b.meta.ring?.mode === "plan") {
    b.setState("missed");
    b.call.status = "missed";
    b.call.end_reason = "operator_hangup";
    b.call.ended_at = b.nowIso;
    cancelOpenAttempts(b, b.nowIso, "hung up by operator");
  } else {
    b.setState("ended").patchSession({ ended_at: b.nowIso });
    b.call.status = answered ? "ended" : b.session.direction === "inbound" ? (WAITING_STATES.has(state) ? "abandoned_queue" : "missed") : "ended";
    b.call.end_reason = "operator_hangup";
    b.call.ended_at = b.nowIso;
    cancelOpenAttempts(b, b.nowIso, "hung up by operator");
    releaseTalkingOperators(b, answered);
  }
  return b.note(`hangup by ${event.actorProfileId ?? "system"}`).result();
}

/** Timer-driven re-evaluation (cron / active-calls poll / end of webhook). */
function onSweep(b: TransitionBuilder): ReduceResult {
  const state = b.session.state;
  if (state === "wrap_up" || state === "missed") return onStaleFinalise(b);
  const customer = b.customerLeg();
  if (!customer || b.legEnded(customer)) return ignoredResult("sweep: no customer leg");
  const meta = b.meta;

  if (state === "ringing" && meta.ring?.mode === "plan") {
    const deadline = meta.ring.step_deadline_at ? Date.parse(meta.ring.step_deadline_at) : NaN;
    if (Number.isNaN(deadline) || deadline >= b.ctx.now.getTime()) return ignoredResult("sweep: step not overdue");
    const active = b.activeRingStep();
    for (const attempt of b.attemptsView()) {
      if (attempt.step_index !== active || isTerminalAttemptResult(attempt.result)) continue;
      b.attempt(attempt.id, { result: "no_answer", ended_at: b.nowIso });
      const leg = attempt.leg_id ? b.legs.find((candidate) => candidate.id === attempt.leg_id) : undefined;
      if (leg && !b.legEnded(leg)) {
        b.cmd(hangupCmd(b, leg, "step_timeout"));
        b.leg(leg.telnyx_call_control_id, { state: "ended", ended_at: b.nowIso, hangup_cause: "step_timeout" });
      }
      if (attempt.profile_id) {
        b.presenceChange({ profileId: attempt.profile_id, status: "available", sessionId: null, onlyIfSession: b.session.id, onlyIfStatus: ["ringing"], reason: "step timeout" });
      }
    }
    continueRinging(b, customer);
    return b.note("sweep: overdue step advanced").result();
  }

  if (state === "ringing" && meta.ring?.mode === "transfer") {
    const deadline = meta.ring.step_deadline_at ? Date.parse(meta.ring.step_deadline_at) : NaN;
    if (Number.isNaN(deadline) || deadline >= b.ctx.now.getTime()) return ignoredResult("sweep: transfer not overdue");
    for (const leg of b.openLegs()) if (!isCustomer(leg)) b.cmd(hangupCmd(b, leg, "transfer_timeout"));
    b.patchMeta({ transfer: null });
    enterWaiting(b, customer, "transfer_timeout");
    return b.result();
  }

  if (WAITING_STATES.has(state)) {
    const last = Date.parse(meta.waiting?.last_tick_at ?? meta.waiting?.since ?? b.session.parked_at ?? b.session.updated_at);
    if (!Number.isNaN(last) && last + WAITING_TICK_STALE_MS >= b.ctx.now.getTime()) return ignoredResult("sweep: tick fresh");
    return onWaitingTick(b, customer);
  }

  return ignoredResult(`sweep: nothing to do in ${state}`);
}

/** Sweep for sessions whose customer already left but whose remaining leg webhooks never arrived. */
function onStaleFinalise(b: TransitionBuilder): ReduceResult {
  // `updated_at` cannot be trusted here: the session lease is acquired before
  // the snapshot is loaded and its UPDATE fires the `updated_at` trigger, so the
  // row always looks fresh. The scanner's pre-lease verdict wins when present.
  const scanned = b.event.kind === "app" && b.event.type === "sweep" && b.event.stale === true;
  if (!scanned) {
    const updated = Date.parse(b.session.updated_at);
    if (Number.isNaN(updated) || updated + STALE_FINALISE_MS > b.ctx.now.getTime()) return ignoredResult("sweep: not stale yet");
  }
  // A leaked `offered` attempt keeps its operator out of every future ring plan
  // (the cross-session partial unique index), so terminalise them here too.
  cancelOpenAttempts(b, b.nowIso, "stale finalise");
  for (const leg of b.openLegs()) {
    b.cmd(hangupCmd(b, leg, "stale_finalise"));
    b.leg(leg.telnyx_call_control_id, { state: "ended", ended_at: b.nowIso, hangup_cause: "stale_finalise" });
    if (leg.profile_id) b.presenceChange({ profileId: leg.profile_id, status: "available", sessionId: null, onlyIfSession: b.session.id, onlyIfStatus: ["ringing", "on_call"], reason: "stale finalise" });
  }
  b.setState("ended").patchSession({ ended_at: b.session.ended_at ?? b.nowIso });
  return b.note("sweep: stale session finalised").result();
}

export { emptyTransition };
export type { RingAttemptResult, CallLegRole };
