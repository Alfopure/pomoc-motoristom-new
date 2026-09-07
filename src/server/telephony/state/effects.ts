import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import { TelephonyNotConfiguredError } from "@/lib/telephony/not-configured";
import { readAnnouncementConfig, resolveAnnouncement } from "@/lib/telephony/announcements";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";

import { recordTelephonyIncident, recoverTelephonyIncidentThrottled, TELEPHONY_INCIDENT_JOBS } from "../incidents";
import { addTelephonyUsage } from "../usage";
import { advanceRingStep } from "../routing/ring-plan";
import { reserveOperator } from "../routing/reservation";
import { encodeClientState } from "../telnyx/client-state";
import { commandId } from "../telnyx/command-id";
import { isCallGoneError, TelnyxCommandError, type DialResult, type TelnyxClient } from "../telnyx/client";
import { recordingCommandOutcome, recordingIntent } from "./recording";
import { RECORDING_START_SETTLE_MS } from "./recording-types";
import { observeParticipants } from "./participants";
import {
  DEFAULT_TTS_VOICE,
  announcementKeyForMedia,
  LEG_TIME_LIMIT_SECS,
  callStatusForSession,
  commandKey,
  emptyTransition,
  isOpenLeg,
  mediaUrl,
  readMeta,
  toJson,
  type AppEvent,
  type AttemptPlan,
  type CallbackPlan,
  type CallRow,
  type Command,
  type CommandKind,
  type DialCommand,
  type LegPatch,
  type LegRef,
  type LegRow,
  type MediaRef,
  type PresenceChange,
  type ReduceResult,
  type RingFanout,
  type SessionEvent,
  type SessionRow,
  type TelephonyEnvironment,
  type Transition,
} from "./types";

/**
 * Effects: persists a reducer transition and executes its Telnyx commands.
 *
 * Order (design §2.3): the transition is written first under a `version`
 * compare-and-set (`SessionConflictError` when another invocation moved the
 * session meanwhile), then the commands run sequentially. A failing command
 * records an incident and runs the reducer's compensation for it (commands +
 * patch); best-effort commands only log. Dial results are turned into leg
 * rows immediately so a webhook arriving a moment later finds them.
 */

type AdminClient = SupabaseClient<Database>;

export type EffectsDeps = {
  admin: AdminClient;
  telnyx: TelnyxClient | null;
  organizationId: string;
  environment: TelephonyEnvironment;
  mediaBaseUrl: string | null;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  logger?: (entry: Record<string, unknown>) => void;
  /** Wrap-up seconds for an operator (defaults to 30 when unknown). */
  wrapUpSecondsFor?: (profileId: string) => Promise<number>;
  /**
   * Extends the per-session lease held by the caller. A ring fan-out issues up to
   * `MAX_RING_FANOUT` sequential dials, each with its own command timeout, which
   * easily outlives the 4 s lease; the RPC is re-entrant for the same token.
   */
  renewLease?: () => Promise<void>;
};

export type CommandOutcome = {
  key: string;
  kind: CommandKind;
  commandId: string | null;
  ok: boolean;
  skipped: boolean;
  bestEffort: boolean;
  error: string | null;
  ms: number;
  detail?: Record<string, unknown>;
};

export type ApplyResult = {
  session: SessionRow;
  branch: "main" | "rejected";
  commands: CommandOutcome[];
  compensations: string[];
  failed: boolean;
  /** `callGone`: Telnyx refused because the leg had already ended — a race with the caller, not a fault. */
  failure: { command: string; error: string; callGone: boolean } | null;
  notes: string[];
};

export class SessionConflictError extends Error {
  constructor(readonly sessionId: string, readonly expectedVersion: number) {
    super(`session ${sessionId} changed (expected version ${expectedVersion})`);
    this.name = "SessionConflictError";
  }
}

export class EffectsError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EffectsError";
  }
}

class RecordingContinuationSupersededError extends EffectsError {
  constructor() { super("recording continuation superseded; delayed audio action cancelled"); }
}

const TERMINAL_CALL_STATUSES: ReadonlySet<CallRow["status"]> = new Set<CallRow["status"]>(["missed", "abandoned_queue", "ended", "failed"]);
const DEFAULT_WRAP_UP_SECONDS = 30;

function fail(message: string, error: { message: string } | null): never {
  throw new EffectsError(`${message}: ${error?.message ?? "unknown error"}`, error);
}

function isDuplicate(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function persistTransition(
  deps: EffectsDeps,
  input: { session: SessionRow; transition: Transition; expectedVersion: number | null; event: SessionEvent | null },
): Promise<SessionRow> {
  const { admin } = deps;
  const now = deps.now().toISOString();
  const patch = { ...input.transition.session };
  let session: SessionRow;

  if (Object.keys(patch).length > 0 || input.expectedVersion !== null) {
    let query = admin
      .from("motorist_call_sessions")
      .update({ ...patch, version: (input.expectedVersion ?? input.session.version) + 1 })
      .eq("id", input.session.id);
    if (input.expectedVersion !== null) query = query.eq("version", input.expectedVersion);
    const updated = await query.select("*");
    if (updated.error) fail("session update failed", updated.error);
    const row = (updated.data ?? [])[0];
    if (!row) throw new SessionConflictError(input.session.id, input.expectedVersion ?? input.session.version);
    session = row;
  } else {
    session = input.session;
  }

  for (const legPatch of input.transition.legs) await applyLegPatch(deps, session, legPatch);

  for (const attempt of input.transition.attempts) {
    const result = await admin.from("motorist_ring_attempts").update(attempt.values).eq("id", attempt.id).eq("session_id", session.id);
    if (result.error) fail("attempt update failed", result.error);
  }

  for (const change of input.transition.presence) await applyPresenceChange(deps, session, change);
  for (const plan of input.transition.callbacks) await createCallbackRequest(deps, session, plan);
  for (const touch of input.transition.memberTouches) {
    const values = touch.field === "last_offered_at" ? { last_offered_at: now } : { last_answered_at: now };
    const result = await admin.from("motorist_ring_group_members").update(values).eq("id", touch.memberId);
    if (result.error) fail("member touch failed", result.error);
  }

  await upsertCallRow(deps, session, input.transition.call);
  return session;
}

async function applyLegPatch(deps: EffectsDeps, session: SessionRow, patch: LegPatch): Promise<void> {
  const { admin } = deps;
  const existing = await admin.from("motorist_call_legs").select("id").eq("telnyx_call_control_id", patch.callControlId).maybeSingle();
  if (existing.error) fail("leg lookup failed", existing.error);
  if (existing.data) {
    const result = await admin.from("motorist_call_legs").update(patch.values).eq("id", existing.data.id);
    if (result.error) fail("leg update failed", result.error);
    return;
  }
  if (!patch.createIfMissing || !patch.values.role) return;
  const inserted = await admin
    .from("motorist_call_legs")
    .insert({
      organization_id: session.organization_id,
      session_id: session.id,
      telnyx_call_control_id: patch.callControlId,
      state: "initiated",
      ...patch.values,
    })
    .select("id, role, profile_id, client_state")
    .single();
  if (inserted.error) {
    if (isDuplicate(inserted.error)) {
      const retry = await admin.from("motorist_call_legs").update(patch.values).eq("telnyx_call_control_id", patch.callControlId);
      if (retry.error) fail("leg update failed", retry.error);
      return;
    }
    fail("leg insert failed", inserted.error);
  }
  await linkAttemptToLeg(deps, session, inserted.data.id, inserted.data.client_state, inserted.data.profile_id, patch.values.to_number ?? null);
}

/** Links a ring attempt (natural key) to its leg row once the leg exists. */
async function linkAttemptToLeg(deps: EffectsDeps, session: SessionRow, legId: string, clientState: Json, profileId: string | null, toNumber: string | null): Promise<void> {
  const state = clientState && typeof clientState === "object" && !Array.isArray(clientState) ? (clientState as Record<string, unknown>) : null;
  if (!state || state.intent !== "ring" || typeof state.step !== "number") return;
  let query = deps.admin.from("motorist_ring_attempts").update({ leg_id: legId }).eq("session_id", session.id).eq("step_index", state.step).is("leg_id", null);
  query = profileId ? query.eq("profile_id", profileId) : query.eq("external_number", toNumber ?? "");
  const result = await query;
  if (result.error) fail("attempt link failed", result.error);
}

export async function applyPresenceChange(deps: EffectsDeps, session: SessionRow, change: PresenceChange): Promise<boolean> {
  const { admin } = deps;
  const now = deps.now();
  const values: Database["public"]["Tables"]["motorist_operator_presence"]["Update"] = { status: change.status, status_since: now.toISOString() };
  if (change.sessionId !== undefined) values.current_session_id = change.sessionId;
  if (change.status === "after_call_work" && change.startWrapUp) {
    const seconds = deps.wrapUpSecondsFor ? await deps.wrapUpSecondsFor(change.profileId) : DEFAULT_WRAP_UP_SECONDS;
    values.wrap_up_until = seconds > 0 ? new Date(now.getTime() + seconds * 1000).toISOString() : null;
    if (seconds <= 0) values.status = "available";
  } else if (change.status !== "after_call_work") {
    values.wrap_up_until = null;
  }
  if (change.status !== "paused") values.pause_reason_id = null;

  let query = admin.from("motorist_operator_presence").update(values).eq("organization_id", session.organization_id).eq("profile_id", change.profileId);
  if (change.onlyIfSession) query = query.or(`current_session_id.is.null,current_session_id.eq.${change.onlyIfSession}`);
  if (change.onlyIfStatus && change.onlyIfStatus.length > 0) query = query.in("status", change.onlyIfStatus);
  const result = await query.select("id, status");
  if (result.error) fail("presence update failed", result.error);
  const applied = (result.data ?? []).length > 0;
  if (applied) {
    await appendPresenceHistory(admin, {
      organizationId: session.organization_id,
      profileId: change.profileId,
      status: values.status ?? change.status,
      reason: change.reason,
      source: "telephony",
      now,
    });
  }
  return applied;
}

/** Closes the open `motorist_operator_statuses` row and opens a new one. */
export async function appendPresenceHistory(
  admin: AdminClient,
  input: { organizationId: string; profileId: string; status: Database["public"]["Tables"]["motorist_operator_statuses"]["Row"]["status"]; reason: string | null; source: string; now: Date },
): Promise<void> {
  const nowIso = input.now.toISOString();
  const closed = await admin
    .from("motorist_operator_statuses")
    .update({ ended_at: nowIso })
    .eq("organization_id", input.organizationId)
    .eq("profile_id", input.profileId)
    .is("ended_at", null);
  if (closed.error) fail("presence history close failed", closed.error);
  const inserted = await admin.from("motorist_operator_statuses").insert({
    organization_id: input.organizationId,
    profile_id: input.profileId,
    status: input.status,
    reason: input.reason,
    source: input.source,
    started_at: nowIso,
    ended_at: null,
  });
  if (inserted.error) fail("presence history insert failed", inserted.error);
}

async function createCallbackRequest(deps: EffectsDeps, session: SessionRow, plan: CallbackPlan): Promise<void> {
  const { admin } = deps;
  const callerNumber = normalizeE164(plan.callerNumber || session.caller_number);
  if (!callerNumber) {
    // Automatic missed-call accounting can omit an unavailable number. An
    // explicit choice must never silently skip persistence then claim success.
    if (plan.request) throw new EffectsError("callback number unavailable");
    return;
  }
  const existing = await admin
    .from("motorist_callback_requests")
    .select("id, metadata")
    .eq("session_id", session.id)
    .limit(1)
    .maybeSingle();
  if (existing.error) fail("callback lookup failed", existing.error);
  if (existing.data) {
    // A replay or an earlier automatic missed-call row must not lose a later
    // explicit choice, nor overwrite ownership, resolution or outbound history.
    if (plan.request) {
      const metadata = existing.data.metadata && typeof existing.data.metadata === "object" && !Array.isArray(existing.data.metadata) ? existing.data.metadata : {};
      const updated = await admin.from("motorist_callback_requests").update({ metadata: toJson({ ...metadata, request: plan.request }) }).eq("id", existing.data.id);
      if (updated.error) fail("callback evidence update failed", updated.error);
    }
    return;
  }
  const now = deps.now();
  const inserted = await admin.from("motorist_callback_requests").insert({
    organization_id: session.organization_id,
    caller_number: callerNumber,
    caller_name: readMeta(session).match?.top?.label ?? null,
    source: plan.source,
    status: "open",
    session_id: session.id,
    line_id: session.line_id,
    case_id: session.case_id,
    due_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
    notes: plan.notes ?? null,
    metadata: toJson({ state: session.state, direction: session.direction, ...(plan.request ? { request: plan.request } : {}) }),
  });
  if (inserted.error) fail("callback insert failed", inserted.error);

  if (plan.createTask && session.case_id) {
    const openTask = await admin
      .from("motorist_case_tasks")
      .select("id")
      .eq("organization_id", session.organization_id)
      .eq("case_id", session.case_id)
      .eq("status", "open")
      .eq("kind", "callback")
      .limit(1)
      .maybeSingle();
    if (openTask.error) fail("task lookup failed", openTask.error);
    if (openTask.data) return;
    const task = await admin.from("motorist_case_tasks").insert({
      organization_id: session.organization_id,
      case_id: session.case_id,
      title: `Zavolať späť: ${callerNumber}`,
      assigned_to: session.answered_by_profile_id,
      due_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
      status: "open",
      priority: "high",
      kind: "callback",
    });
    if (task.error) fail("task insert failed", task.error);
  }
}

function seconds(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

/** Keeps exactly one `motorist_calls` row per session in sync with the session. */
export async function upsertCallRow(deps: EffectsDeps, session: SessionRow, overrides: Transition["call"]): Promise<void> {
  const { admin } = deps;
  const existing = await admin.from("motorist_calls").select("*").eq("session_id", session.id).maybeSingle();
  if (existing.error) fail("call lookup failed", existing.error);
  const current = existing.data;
  const meta = readMeta(session);
  const answeredAt = overrides.answered_at ?? session.answered_at ?? current?.answered_at ?? null;
  const endedAt = overrides.ended_at ?? session.ended_at ?? current?.ended_at ?? null;
  const status =
    overrides.status ??
    (current && TERMINAL_CALL_STATUSES.has(current.status) ? current.status : callStatusForSession({ state: session.state, direction: session.direction, answered_at: answeredAt }));
  const customerLeg = session.customer_leg_id ? await admin.from("motorist_call_legs").select("telnyx_call_control_id").eq("id", session.customer_leg_id).maybeSingle() : null;

  const values: Database["public"]["Tables"]["motorist_calls"]["Update"] = {
    provider: "telnyx",
    provider_session_id: session.telnyx_session_id,
    provider_call_id: customerLeg?.data?.telnyx_call_control_id ?? current?.provider_call_id ?? null,
    session_id: session.id,
    direction: session.direction,
    status,
    end_reason: overrides.end_reason ?? current?.end_reason ?? null,
    caller_number: session.caller_number,
    caller_name: meta.match?.top?.label ?? current?.caller_name ?? null,
    called_number: session.called_number,
    received_number: session.direction === "inbound" ? session.called_number : current?.received_number ?? null,
    destination_number: session.direction === "inbound" ? current?.destination_number ?? null : session.called_number,
    line_id: session.line_id,
    operator_id: overrides.operator_id ?? session.answered_by_profile_id ?? current?.operator_id ?? null,
    case_id: session.case_id ?? current?.case_id ?? null,
    started_at: session.started_at,
    answered_at: answeredAt,
    ended_at: endedAt,
    wait_seconds: seconds(session.started_at, answeredAt ?? endedAt),
    ring_seconds: overrides.ring_seconds ?? current?.ring_seconds ?? null,
    duration_seconds: answeredAt && endedAt ? seconds(answeredAt, endedAt) : current?.duration_seconds ?? null,
    ring_group_id: overrides.ring_group_id ?? current?.ring_group_id ?? null,
    summary: overrides.summary ?? current?.summary ?? null,
    recording_status: current?.recording_status === "available" || current?.recording_status === "deleted" ? current.recording_status :
      meta.recording?.recorders.length ? meta.recording.error ? "failed" : "pending" : current?.recording_status ?? "not_requested",
    raw_latest_payload: toJson({
      state: session.state,
      conference_id: session.conference_id,
      ring: meta.ring ? { mode: meta.ring.mode, active_step: meta.ring.active_step, exhausted: meta.ring.exhausted, fallback: meta.ring.fallback } : null,
      transfer: meta.transfer ?? null,
      callback: meta.callback ?? null,
      line_label: meta.line_label ?? null,
      partner_name: meta.partner_name ?? null,
      match: meta.match ?? null,
    }),
  };

  if (current) {
    const updated = await admin.from("motorist_calls").update(values).eq("id", current.id);
    if (updated.error) fail("call update failed", updated.error);
    return;
  }
  const inserted = await admin.from("motorist_calls").insert({
    organization_id: session.organization_id,
    ...values,
    provider: "telnyx",
    direction: session.direction,
    status,
    recording_status: values.recording_status ?? "not_requested",
    transcript_status: "not_requested",
    raw_payload: toJson({ session_id: session.id }),
  });
  if (inserted.error && !isDuplicate(inserted.error)) fail("call insert failed", inserted.error);
}

/**
 * The target of an app event, without the identity that must not be persisted.
 *
 * `motorist_call_events` is readable by every member of the organisation (RLS
 * `motorist_is_org_member`), so anything written here is visible to every
 * signed-in dispatcher through PostgREST. A `TransferTarget` for a colleague
 * carries their Telnyx SIP username — half of a registrable credential — and a
 * transfer, consultation or add-party would otherwise hand it out. The label
 * and the profile id are what the event log is read for; nothing downstream
 * reads `sipUri` back out of a row.
 */
function safeEventTarget(target: AppEvent["target"] | null | undefined): Json {
  if (!target) return null;
  return target.kind === "operator" ? { kind: "operator", profileId: target.profileId, label: target.label } : { kind: "number", number: target.number, label: target.label };
}

/** Audit row per processed event (`event_fingerprint` = event id → idempotent). */
export async function recordCallEvent(
  deps: Pick<EffectsDeps, "admin" | "organizationId" | "now">,
  input: {
    session: SessionRow | null;
    event: SessionEvent;
    handledStatus: "processed" | "ignored" | "failed";
    stateBefore: string | null;
    stateAfter: string | null;
    notes: string[];
    commands: Array<{ kind: string; ok: boolean }>;
    error?: string | null;
  },
): Promise<void> {
  const { admin } = deps;
  let callId: string | null = null;
  if (input.session) {
    const call = await admin.from("motorist_calls").select("id").eq("session_id", input.session.id).maybeSingle();
    callId = call.data?.id ?? null;
  }
  const event = input.event;
  const target = event.kind === "app" ? safeEventTarget(event.target) : null;
  const rawPayload = event.kind === "telnyx" ? toJson(event.type.includes("recording.")
    ? { recording_id: event.payload.recording_id ?? null, recording_started_at: event.payload.recording_started_at ?? null, recording_ended_at: event.payload.recording_ended_at ?? null, channels: event.payload.channels ?? null }
    : event.payload) : toJson({ type: event.type, actor: event.actorProfileId, target });
  const inserted = await admin.from("motorist_call_events").insert({
    organization_id: deps.organizationId,
    call_id: callId,
    provider: "telnyx",
    provider_session_id: input.session?.telnyx_session_id ?? (event.kind === "telnyx" ? event.callSessionId : null),
    event_type: event.kind === "telnyx" ? event.type : `app.${event.type}`,
    event_fingerprint: event.id,
    payload: toJson(
      event.kind === "telnyx"
        ? { call_control_id: event.callControlId, call_leg_id: event.callLegId, from: event.from, to: event.to, direction: event.direction, hangup_cause: event.hangupCause, digits: event.digits, status: event.status }
        : { actor: event.actorProfileId, target },
    ),
    raw_payload: rawPayload,
    normalized_payload: toJson({
      session_id: input.session?.id ?? null,
      state_before: input.stateBefore,
      state_after: input.stateAfter,
      notes: input.notes,
      commands: input.commands,
      error: input.error ?? null,
    }),
    handled_status: input.handledStatus,
    provider_timestamp: event.occurredAt,
    received_at: deps.now().toISOString(),
  });
  if (inserted.error && !isDuplicate(inserted.error)) fail("call event insert failed", inserted.error);
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

type ExecutionContext = {
  session: SessionRow;
  dialResults: Map<string, DialResult>;
  conferenceId: string | null;
};

function resolveLeg(ctx: ExecutionContext, ref: LegRef): string {
  if (ref.callControlId) return ref.callControlId;
  const dial = ref.fromDial ? ctx.dialResults.get(ref.fromDial) : undefined;
  if (!dial) throw new EffectsError(`leg reference ${ref.fromDial} has no dial result`);
  return dial.callControlId;
}

function requireTelnyx(deps: EffectsDeps): TelnyxClient {
  if (!deps.telnyx) throw new TelephonyNotConfiguredError();
  return deps.telnyx;
}

/** A hangup for a leg Telnyx no longer knows (404) or refuses to touch because it ended (422). */
function isLegAlreadyGone(error: unknown): boolean {
  return error instanceof TelnyxCommandError && (error.status === 404 || error.status === 422);
}

function resolvePrompt(deps: EffectsDeps, ctx: ExecutionContext, media: MediaRef | null) {
  const config = readAnnouncementConfig(readMeta(ctx.session).announcements);
  const key = media ? announcementKeyForMedia(media) : null;
  if (key) {
    const prompt = resolveAnnouncement(config, key);
    return { url: prompt.file ? mediaUrl(deps.mediaBaseUrl, { file: prompt.file }) : null, text: prompt.text, voice: prompt.voice };
  }
  return { url: media ? mediaUrl(deps.mediaBaseUrl, media) : null, text: null, voice: resolveAnnouncement(config, "ivrMain").voice };
}

async function executeCommand(deps: EffectsDeps, ctx: ExecutionContext, command: Command): Promise<{ skipped: boolean; detail?: Record<string, unknown> }> {
  const telnyx = requireTelnyx(deps);
  switch (command.kind) {
    case "answer":
      await telnyx.answer({ callControlId: resolveLeg(ctx, command.leg), commandId: command.commandId, clientState: encodeClientState(command.clientState) });
      return { skipped: false };
    case "hangup":
      try {
        await telnyx.hangup({ callControlId: resolveLeg(ctx, command.leg), commandId: command.commandId });
      } catch (error) {
        // The leg is already gone (the far end hung up a moment earlier): that
        // is exactly the outcome we asked for, not a failed transition. Without
        // this, an operator pressing "Ukončiť" on a call the caller just ended
        // gets a 502 for a session that is already terminal.
        if (!isLegAlreadyGone(error)) throw error;
        return { skipped: true, detail: { reason: command.reason, alreadyGone: true } };
      }
      return { skipped: false, detail: { reason: command.reason } };
    case "bridge":
      if (command.recordingConferenceName) return executeRecordedConnection(deps, ctx, command);
      await telnyx.bridge({
        callControlId: resolveLeg(ctx, command.leg),
        targetCallControlId: resolveLeg(ctx, command.target),
        commandId: command.commandId,
        parkAfterUnbridge: command.parkAfterUnbridge,
        playRingtone: command.playRingtone,
        ringtone: command.playRingtone ? "cz" : undefined,
      });
      return { skipped: false };
    case "recording_start": {
      if (!readMeta(ctx.session).recording?.policy.enabled) throw new EffectsError("recording policy proof unavailable");
      const call = await deps.admin.from("motorist_calls").select("id").eq("organization_id", deps.organizationId).eq("session_id", ctx.session.id).maybeSingle();
      if (call.error || !call.data) throw new EffectsError("recording_admission_denied");
      const admission = await deps.admin.rpc("motorist_recording_admit_session", { p_organization_id: deps.organizationId, p_session_id: ctx.session.id, p_call_id: call.data.id, p_max_per_hour: 10 });
      if (admission.error || admission.data !== true) throw new EffectsError("recording_admission_denied");
      await deps.renewLease?.();
      const recording = await telnyx.recordingStart({ callControlId: resolveLeg(ctx, command.leg), commandId: command.commandId, maxLength: command.maxLength,
        clientState: encodeClientState({ sid: ctx.session.id, role: "customer", intent: recordingIntent(command.recorderId) }) });
      return { skipped: false, detail: { providerRecordingId: recording.recordingId } };
    }
    case "recording_stop":
      await deps.renewLease?.();
      try { await telnyx.recordingStop({ callControlId: resolveLeg(ctx, command.leg), commandId: command.commandId }); }
      catch (error) { if (!isCallGoneError(error)) throw error; }
      return { skipped: false };
    case "playback_start": {
      const prompt = resolvePrompt(deps, ctx, command.media);
      const common = {
        callControlId: resolveLeg(ctx, command.leg),
        commandId: command.commandId,
        // Reset the previous introduction/gather intent; Telnyx otherwise
        // echoes it on later playback completions for the same customer leg.
        clientState: encodeClientState(command.clientState ?? { sid: ctx.session.id, role: "customer", intent: "playback" }),
      };
      if (prompt.url && !command.forceSpeech) {
        try {
          await telnyx.playbackStart({ ...common, audioUrl: prompt.url, loop: command.loop });
          return { skipped: false, detail: { url: prompt.url } };
        } catch (error) {
          if (!prompt.text || isCallGoneError(error)) throw error;
          // A refused URL must not silently skip a spoken message. Distinct
          // command IDs let Telnyx accept the speech fallback immediately.
          common.commandId = commandId({ sessionId: ctx.session.id, legId: common.callControlId, step: command.commandId, intent: "speech_fallback" });
        }
      }
      if (prompt.text) {
        await telnyx.speak({ ...common, payload: prompt.text, voice: prompt.voice });
        return { skipped: false, detail: { tts: true } };
      }
      return { skipped: true, detail: { reason: "no media base url" } };
    }
    case "playback_stop":
      await telnyx.playbackStop({ callControlId: resolveLeg(ctx, command.leg), commandId: command.commandId, stop: "all" });
      return { skipped: false };
    case "gather": {
      const leg = resolveLeg(ctx, command.leg);
      const prompt = resolvePrompt(deps, ctx, command.spec.media);
      const invalid = command.spec.invalidMedia ? resolvePrompt(deps, ctx, command.spec.invalidMedia) : null;
      const url = prompt.url;
      const text = prompt.text ?? command.spec.ttsText;
      let gatherId = command.clientState.gatherId;
      const common = {
        callControlId: leg,
        commandId: command.commandId,
        clientState: encodeClientState(command.clientState),
        minimumDigits: command.spec.minimumDigits,
        maximumDigits: command.spec.maximumDigits,
        maximumTries: command.spec.maximumTries,
        timeoutMillis: command.spec.timeoutMillis,
        initialTimeoutMillis: command.spec.initialTimeoutMillis,
        interDigitTimeoutMillis: command.spec.interDigitTimeoutMillis,
        validDigits: command.spec.validDigits,
      };
      // Managed audio menus can use their current text when an invalid-input
      // edit has no audio yet. A custom IVR recording remains authoritative;
      // its fallback text may describe an older menu.
      if (url && !command.spec.forceSpeech && !(prompt.text && invalid?.text && !invalid.url)) {
        try {
          await telnyx.gatherUsingAudio({ ...common, audioUrl: url, invalidAudioUrl: invalid?.url ?? undefined });
          return { skipped: false, detail: { url, purpose: command.spec.purpose } };
        } catch (error) {
          // Only managed prompts have text proven to match their recording.
          // A custom menu with an old fallback must recover to assistance.
          if (!prompt.text || isCallGoneError(error)) throw error;
          common.commandId = commandId({ sessionId: ctx.session.id, legId: leg, step: command.commandId, intent: "gather_speech_fallback" });
          gatherId = common.commandId.replaceAll("-", "").slice(0, 12);
          common.clientState = encodeClientState({ ...command.clientState, gatherId });
        }
      }
      if (text) {
        await telnyx.gatherUsingSpeak({ ...common, payload: text, voice: prompt.voice ?? DEFAULT_TTS_VOICE, invalidPayload: invalid?.text ?? undefined });
        return { skipped: false, detail: { tts: true, purpose: command.spec.purpose, gatherId } };
      }
      if (command.spec.media === null) {
        // Silent gather: the waiting-room tick, which must not interrupt the
        // `playback_start` loop that carries the music.
        await telnyx.gather(common);
        return { skipped: false, detail: { silent: true, purpose: command.spec.purpose } };
      }
      throw new EffectsError("gather has no usable audio or text");
    }
    case "gather_stop":
      await telnyx.gatherStop({ callControlId: resolveLeg(ctx, command.leg), commandId: command.commandId });
      return { skipped: false };
    case "dial":
      return executeDial(deps, ctx, command);
    case "transfer":
      await telnyx.transfer({
        callControlId: resolveLeg(ctx, command.leg),
        commandId: command.commandId,
        to: command.to,
        from: command.from ?? undefined,
        targetLegClientState: encodeClientState(command.targetClientState),
        timeoutSecs: command.timeoutSecs,
        sipRegion: "Europe",
        mediaEncryption: command.to.startsWith("sip:") ? "SRTP" : undefined,
        parkAfterUnbridge: "self",
      });
      return { skipped: false, detail: { to: command.to } };
    case "conference_create": {
      const conference = await createOrFindConference(telnyx, command.commandId, resolveLeg(ctx, command.leg), command.name);
      ctx.conferenceId = conference.id;
      const updated = await deps.admin.from("motorist_call_sessions").update({ conference_id: conference.id, conference_name: command.name }).eq("id", ctx.session.id);
      if (updated.error) fail("conference id persist failed", updated.error);
      ctx.session = { ...ctx.session, conference_id: conference.id, conference_name: command.name };
      return { skipped: false, detail: { conferenceId: conference.id } };
    }
    case "conference_join":
      // Verified against the published Call Control API (join a conference):
      // `supervisor_role` accepts `barge | monitor | none | whisper` and
      // `whisper_call_control_ids` is the array of legs a whispering supervisor
      // is heard by. Both are omitted for an ordinary participant.
      await telnyx.conferenceAction(requireConference(ctx), "join", {
        call_control_id: resolveLeg(ctx, command.leg),
        supervisor_role: command.supervisorRole,
        whisper_call_control_ids: command.whisper?.map((leg) => resolveLeg(ctx, leg)),
        commandId: command.commandId,
      });
      return { skipped: false, ...(command.supervisorRole ? { detail: { supervisorRole: command.supervisorRole } } : {}) };
    case "conference_update":
      await telnyx.conferenceAction(requireConference(ctx), "update", {
        call_control_id: resolveLeg(ctx, command.leg),
        supervisor_role: command.supervisorRole,
        whisper_call_control_ids: command.whisper?.map((leg) => resolveLeg(ctx, leg)),
        commandId: command.commandId,
      });
      return { skipped: false, detail: { supervisorRole: command.supervisorRole } };
    case "supervisor_role_switch":
      await telnyx.switchSupervisorRole({ callControlId: resolveLeg(ctx, command.leg), role: command.supervisorRole, commandId: command.commandId });
      return { skipped: false, detail: { supervisorRole: command.supervisorRole } };
    case "conference_leave":
      await telnyx.conferenceAction(requireConference(ctx), "leave", { call_control_id: resolveLeg(ctx, command.leg), commandId: command.commandId });
      return { skipped: false };
    case "conference_hold": {
      const url = mediaUrl(deps.mediaBaseUrl, command.media);
      await telnyx.conferenceAction(requireConference(ctx), "hold", {
        call_control_ids: command.legs.map((leg) => resolveLeg(ctx, leg)),
        audio_url: url ?? undefined,
        commandId: command.commandId,
      });
      return { skipped: false };
    }
    case "conference_unhold":
      await telnyx.conferenceAction(requireConference(ctx), "unhold", { call_control_ids: command.legs.map((leg) => resolveLeg(ctx, leg)), commandId: command.commandId });
      return { skipped: false };
    case "conference_mute":
    case "conference_unmute":
      // `mute` / `unmute` take `call_control_ids` (an array) and, like the other
      // participant commands, do not declare `command_id` in the Telnyx schema.
      await telnyx.conferenceAction(requireConference(ctx), command.kind === "conference_mute" ? "mute" : "unmute", {
        call_control_ids: command.legs.map((leg) => resolveLeg(ctx, leg)),
        commandId: command.commandId,
      });
      return { skipped: false };
    case "ring_fanout":
      return executeRingFanout(deps, ctx, command);
    default:
      throw new EffectsError(`unsupported command ${(command as Command).kind}`);
  }
}

function requireConference(ctx: ExecutionContext): string {
  const id = ctx.conferenceId ?? ctx.session.conference_id;
  if (!id) throw new EffectsError("session has no conference");
  return id;
}

/** A partially accepted connection must never run the old bridge compensation. */
class RecordingConnectionPendingError extends Error {
  constructor() { super("recorded connection awaits provider confirmation; durable continuation retained"); }
}

async function executeRecordedConnection(deps: EffectsDeps, ctx: ExecutionContext, command: Extract<Command, { kind: "bridge" }>): Promise<{ skipped: false; detail: { conferenceId: string } }> {
  const telnyx = requireTelnyx(deps), name = command.recordingConferenceName;
  if (!deps.renewLease || name !== `rec-${ctx.session.id}-${command.commandId}`) throw new RecordingContinuationSupersededError();
  const epoch = readMeta(ctx.session).recording?.epoch;
  const readinessDeadline = Date.now() + 10_000;
  const current = async () => {
    try { await deps.renewLease?.(); } catch { throw new RecordingContinuationSupersededError(); }
    const fresh = await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", ctx.session.id).maybeSingle();
    const recording = fresh.data ? readMeta(fresh.data).recording : undefined;
    if (fresh.error || !fresh.data || fresh.data.ended_at || fresh.data.version !== ctx.session.version || !recording ||
      recording.epoch !== epoch || recording.suppressionReason === "objection" ||
      !recording.pendingAudio?.commands.some((item) => item.commandId === command.commandId)) throw new RecordingContinuationSupersededError();
    ctx.session = fresh.data;
    const legs = await deps.admin.from("motorist_call_legs").select("*").eq("organization_id", deps.organizationId).eq("session_id", ctx.session.id)
      .in("telnyx_call_control_id", [resolveLeg(ctx, command.leg), resolveLeg(ctx, command.target)]);
    if (legs.error || legs.data?.length !== 2 || legs.data.some((leg) => !isOpenLeg(leg) || !leg.answered_at)) throw new RecordingContinuationSupersededError();
  };
  await current();
  const joined = async (id: string, leg: string) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (Date.now() > readinessDeadline) throw new RecordingConnectionPendingError();
      await current();
      const response = await telnyx.request<{ data?: Array<{ call_control_id?: string; status?: string }> }>("GET", `/conferences/${encodeURIComponent(id)}/participants`);
      if (response?.data?.some((entry) => entry.call_control_id === leg && entry.status === "joined")) return;
      if (attempt < 7) await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(200);
    }
    throw new RecordingConnectionPendingError();
  };
  try {
    let id = ctx.session.conference_id;
    if (!id) {
      try {
        const conference = await createOrFindConference(telnyx, command.commandId, resolveLeg(ctx, command.leg), name);
        id = conference.id;
      } catch {
        // A timeout may have created the conference. Recover only this session's
        // exact name; never assume that the former topology still exists.
        const found = await telnyx.request<{ data?: Array<{ id?: string; name?: string }> }>("GET", "/conferences", { query: { "filter[name]": name, "page[size]": 5 } });
        const matches = (found?.data ?? []).filter((entry) => entry.name === name && entry.id);
        if (matches.length !== 1) throw new RecordingConnectionPendingError();
        id = matches[0].id!;
      }
      await current();
      const updated = await deps.admin.from("motorist_call_sessions").update({ conference_id: id, conference_name: name })
        .eq("organization_id", deps.organizationId).eq("id", ctx.session.id).eq("version", ctx.session.version).is("ended_at", null).select("*").maybeSingle();
      if (updated.error || !updated.data) throw new RecordingConnectionPendingError();
      ctx.session = updated.data;
    }
    ctx.conferenceId = id;
    await joined(id, resolveLeg(ctx, command.leg));
    await current();
    await telnyx.conferenceAction(id, "join", {
      call_control_id: resolveLeg(ctx, command.target), hold: false, mute: false,
      start_conference_on_enter: true, end_conference_on_exit: false, beep_enabled: "never",
      commandId: commandId({ sessionId: ctx.session.id, legId: resolveLeg(ctx, command.target), step: command.commandId, intent: "recording:conference:connect" }),
    });
    await joined(id, resolveLeg(ctx, command.target));
    await current();
    return { skipped: false, detail: { conferenceId: id } };
  } catch (error) {
    if (error instanceof RecordingContinuationSupersededError) throw error;
    throw new RecordingConnectionPendingError();
  }
}

async function createOrFindConference(telnyx: TelnyxClient, commandId: string, callControlId: string, name: string): Promise<{ id: string }> {
  try {
    return await telnyx.createConference({ commandId, callControlId, name, startConferenceOnCreate: true, beepEnabled: "never", comfortNoise: false });
  } catch (error) {
    const exists = error instanceof TelnyxCommandError && /exist/i.test(`${error.detail ?? ""} ${error.title ?? ""}`);
    if (!exists) throw error;
    const response = await telnyx.request<{ data?: Array<{ id?: string; name?: string }> }>("GET", "/conferences", { query: { "filter[name]": name, "page[size]": 5 } });
    const match = (response?.data ?? []).find((entry) => entry.name === name && entry.id);
    if (!match?.id) throw error;
    return { id: match.id };
  }
}

async function executeDial(deps: EffectsDeps, ctx: ExecutionContext, command: DialCommand): Promise<{ skipped: boolean; detail?: Record<string, unknown> }> {
  const telnyx = requireTelnyx(deps);
  const isSip = command.to.startsWith("sip:");
  const result = await telnyx.dial({
    commandId: command.commandId,
    to: command.to,
    from: command.from,
    clientState: encodeClientState(command.clientState),
    linkTo: command.linkTo ?? undefined,
    timeoutSecs: command.timeoutSecs,
    timeLimitSecs: LEG_TIME_LIMIT_SECS,
    sipRegion: "Europe",
    mediaEncryption: isSip ? "SRTP" : undefined,
    customHeaders: command.autoAnswer ? [{ name: "X-PM-Auto-Answer", value: "1" }] : undefined,
    fromDisplayName: command.fromDisplayName,
    // Supervision attaches to a live call at dial time; the caller's bridge is
    // never touched. `supervisor_role` is only meaningful together with it.
    superviseCallControlId: command.superviseCallControlId,
    supervisorRole: command.superviseCallControlId ? command.supervisorRole : undefined,
  });
  ctx.dialResults.set(command.commandId, result);
  await upsertDialedLeg(deps, ctx.session, command, result);
  return { skipped: false, detail: { callControlId: result.callControlId, to: command.to } };
}

export async function upsertDialedLeg(deps: EffectsDeps, session: SessionRow, command: DialCommand, result: DialResult): Promise<LegRow | null> {
  const { admin } = deps;
  const now = deps.now().toISOString();
  const values = {
    organization_id: session.organization_id,
    session_id: session.id,
    telnyx_call_control_id: result.callControlId,
    telnyx_call_leg_id: result.callLegId,
    role: command.role,
    profile_id: command.profileId,
    to_number: command.to,
    from_number: command.from,
    initiated_at: now,
    client_state: toJson(command.clientState),
    metadata: toJson({ intent: command.clientState.intent ?? null, attempt: command.attempt ?? null }),
  };
  const upserted = await admin.from("motorist_call_legs").upsert(values, { onConflict: "telnyx_call_control_id" }).select("*").single();
  if (upserted.error) fail("dialed leg upsert failed", upserted.error);
  const leg = upserted.data;
  // Every dial is a billable leg: count it for the daily soft cap (best effort).
  await addTelephonyUsage(admin, { organizationId: session.organization_id, now: deps.now(), legs: 1, logger: deps.logger });
  if (command.attempt) {
    let query = admin
      .from("motorist_ring_attempts")
      .update({ leg_id: leg.id, result: "offered", offered_at: now })
      .eq("session_id", session.id)
      .eq("step_index", command.attempt.stepIndex)
      .in("result", ["pending", "offered"]);
    query = command.attempt.profileId ? query.eq("profile_id", command.attempt.profileId) : query.eq("external_number", command.attempt.externalNumber ?? "");
    const linked = await query;
    if (linked.error) fail("attempt link failed", linked.error);
  }
  if (!session.telnyx_session_id && result.callSessionId) {
    await admin.from("motorist_call_sessions").update({ telnyx_session_id: result.callSessionId }).eq("id", session.id).is("telnyx_session_id", null);
  }
  return leg;
}

async function insertAttempt(deps: EffectsDeps, session: SessionRow, plan: AttemptPlan): Promise<boolean> {
  const now = deps.now().toISOString();
  const inserted = await deps.admin.from("motorist_ring_attempts").insert({
    organization_id: session.organization_id,
    session_id: session.id,
    step_index: plan.stepIndex,
    ring_group_id: plan.ringGroupId,
    member_kind: plan.memberKind,
    profile_id: plan.profileId,
    external_number: plan.externalNumber,
    position: plan.position,
    ring_secs: plan.ringSecs,
    result: "offered",
    offered_at: now,
  });
  if (inserted.error) {
    if (isDuplicate(inserted.error)) return false;
    fail("attempt insert failed", inserted.error);
  }
  return true;
}

async function executeRingFanout(deps: EffectsDeps, ctx: ExecutionContext, command: RingFanout): Promise<{ skipped: boolean; detail?: Record<string, unknown> }> {
  const { admin } = deps;
  const session = ctx.session;
  if (command.guard) {
    const won = await advanceRingStep(admin, session.id, command.guard.expectedStep);
    if (!won) return { skipped: true, detail: { reason: "lost step race", step: command.step } };
    const set = await admin.from("motorist_call_sessions").update({ current_step: command.guard.setStep }).eq("id", session.id);
    if (set.error) fail("current_step update failed", set.error);
    ctx.session = { ...ctx.session, current_step: command.guard.setStep };
  }

  const now = deps.now().toISOString();
  const dials: DialCommand[] = [];
  const skippedMembers: string[] = [];
  for (const plan of command.attempts) {
    const key = plan.profileId ?? plan.externalNumber ?? "";
    const ok = await insertAttempt(deps, session, plan);
    if (!ok) {
      skippedMembers.push(key);
      continue;
    }
    const dial = command.dials.find((candidate) => candidate.attempt?.profileId === plan.profileId && candidate.attempt?.externalNumber === plan.externalNumber);
    if (dial) dials.push(dial);
  }

  const ringing = command.ringingProfileIds.filter((id) => !skippedMembers.includes(id));
  if (ringing.length > 0) {
    const presence = await admin
      .from("motorist_operator_presence")
      .update({ status: "ringing", current_session_id: session.id, status_since: now })
      .eq("organization_id", session.organization_id)
      .in("profile_id", ringing)
      .in("status", ["available", "after_call_work"])
      .is("current_session_id", null);
    if (presence.error) fail("presence ringing update failed", presence.error);
  }

  let succeeded = 0;
  const failures: Array<{ to: string; error: string }> = [];
  for (const dial of dials) {
    try {
      // Keep the lease alive across a slow fan-out so a concurrent `call.answered`
      // cannot start dialling the rest of the group behind our back.
      await deps.renewLease?.();
      await executeDial(deps, ctx, dial);
      succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ to: dial.to, error: message });
      let query = admin.from("motorist_ring_attempts").update({ result: "failed", ended_at: now }).eq("session_id", session.id).eq("step_index", command.step);
      query = dial.profileId ? query.eq("profile_id", dial.profileId) : query.eq("external_number", dial.externalNumber ?? "");
      await query;
      if (dial.profileId) {
        await admin
          .from("motorist_operator_presence")
          .update({ status: "available", current_session_id: null, status_since: now })
          .eq("profile_id", dial.profileId)
          .eq("current_session_id", session.id)
          .eq("status", "ringing");
      }
      await recordTelephonyIncident(admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error, context: { sessionId: session.id, command: "dial", to: dial.to } });
    }
  }

  if (command.attempts.length > 0 && succeeded === 0) {
    // Nobody is ringing (every dial failed, or every member was already offered
    // in a concurrent session), so no Telnyx event will advance the step:
    // make it overdue so the next sweep or webhook moves on immediately.
    const meta = readMeta(ctx.session);
    const updated = await admin
      .from("motorist_call_sessions")
      .update({ metadata: toJson({ ...meta, ring: { ...(meta.ring ?? {}), step_deadline_at: now } }) })
      .eq("id", session.id);
    if (updated.error) fail("deadline update failed", updated.error);
  }

  return { skipped: false, detail: { step: command.step, attempts: command.attempts.length, dialed: succeeded, skippedMembers, failures } };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof TelnyxCommandError) return `${error.code}(${error.status}): ${error.detail ?? error.message}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function applyReduceResult(
  deps: EffectsDeps,
  input: { session: SessionRow; result: ReduceResult; event: SessionEvent; expectedVersion: number },
): Promise<ApplyResult> {
  const { result } = input;
  let branch: "main" | "rejected" = "main";
  let transition = result.next;
  let commands = result.commands;
  let compensations = result.compensations;

  if (result.guard) {
    const reserved = await reserveOperator(deps.admin, { profileId: result.guard.profileId, sessionId: input.session.id });
    if (!reserved) {
      branch = "rejected";
      transition = result.guard.onRejected.next;
      commands = result.guard.onRejected.commands;
      compensations = [];
    }
  }

  let session = await persistTransition(deps, { session: input.session, transition, expectedVersion: input.expectedVersion, event: input.event });
  if (input.event.kind === "app" && ["recording_stop", "recording_retry_stop"].includes(input.event.type) && readMeta(session).recording?.suppressionReason === "objection") {
    const restricted = await deps.admin.rpc("motorist_recording_restrict_session", { p_organization_id: deps.organizationId, p_session_id: session.id });
    // The persisted session suppression also gates all processing checkpoints.
    // A database restriction retry must never delay the actual privacy STOP.
    if (restricted.error) deps.logger?.({ level: "warn", scope: "recording", sessionId: session.id, code: "recording_restriction_pending" });
  }
  // A transition can clear the persisted conference while its effects still
  // need to leave the old one (park / blind transfer).
  const ctx: ExecutionContext = { session, dialResults: new Map(), conferenceId: session.conference_id ?? input.session.conference_id };
  const outcomes: CommandOutcome[] = [];
  const compensated: string[] = [];
  let failure: ApplyResult["failure"] = null;

  for (const command of commands) {
    const started = deps.now().getTime();
    const key = commandKey(command);
    try {
      if (readMeta(ctx.session).recording?.policy.enabled) await deps.renewLease?.();
      const pending = readMeta(ctx.session).recording?.pendingAudio;
      const pendingCommand = pending?.commands.some((item) => "commandId" in command && item.commandId === command.commandId);
      if (pendingCommand) {
        const fresh = await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", session.id).maybeSingle();
        const recording = fresh.data ? readMeta(fresh.data).recording : undefined;
        if (fresh.error || !fresh.data || fresh.data.ended_at || !recording || !pending || recording.epoch !== pending.epoch || recording.suppressionReason === "objection" || !recording.pendingAudio?.commands.some((item) => "commandId" in command && item.commandId === command.commandId)) throw new RecordingContinuationSupersededError();
      }
      const executed = await executeCommand(deps, ctx, command);
      if (command.kind === "gather" && executed.detail?.tts && readMeta(ctx.session).gather?.id === command.clientState.gatherId) {
        const meta = readMeta(ctx.session);
        const checkpoint = emptyTransition();
        checkpoint.session.metadata = toJson({ ...meta, gather: { ...meta.gather, id: executed.detail.gatherId ?? meta.gather!.id, spec: { ...meta.gather!.spec, forceSpeech: true } },
          ...(command.spec.purpose === "queue_wait" && meta.waiting?.audio_phase === "combined" ? { waiting: { ...meta.waiting, audio_phase: "prompt" } } : {}) });
        session = await persistTransition(deps, { session: ctx.session, transition: checkpoint, expectedVersion: ctx.session.version, event: input.event });
        ctx.session = session;
      }
      if (pendingCommand) {
        try {
          const fresh = await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", session.id).maybeSingle();
          if (fresh.error || !fresh.data) throw new EffectsError("audio checkpoint unavailable");
          const meta = readMeta(fresh.data), recording = meta.recording;
          if (recording && recording.pendingAudio && pending && recording.pendingAudio.epoch === pending.epoch) {
            const remaining = recording.pendingAudio.commands.filter((item) => !("commandId" in command) || item.commandId !== command.commandId);
            const update = emptyTransition();
            update.session.metadata = toJson({ ...meta, recording: { ...recording, pendingAudio: remaining.length ? { ...recording.pendingAudio, commands: remaining } : null } });
            session = await persistTransition(deps, { session: fresh.data, transition: update, expectedVersion: fresh.data.version, event: input.event });
            ctx.session = session;
          }
        } catch {
          // Keeping the command pending is safe: its provider id is stable and
          // replayed idempotently. A successful bridge must not be compensated.
          deps.logger?.({ level: "warn", scope: "recording", sessionId: session.id, code: "recording_audio_checkpoint_pending" });
        }
      }
      if (command.kind === "recording_start" || command.kind === "recording_stop") {
        const latest = await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", ctx.session.id).maybeSingle();
        if (latest.error || !latest.data) throw new EffectsError("recording state checkpoint unavailable");
        ctx.session = latest.data;
        const changed = recordingCommandOutcome(ctx.session, command, true, deps.now().toISOString(), false, false, typeof executed.detail?.providerRecordingId === "string" ? executed.detail.providerRecordingId : null);
        const update = emptyTransition();
        update.session.metadata = changed.metadata;
        session = await persistTransition(deps, { session: ctx.session, transition: update, expectedVersion: ctx.session.version, event: input.event });
        ctx.session = session;
        if (command.kind === "recording_start") {
          // Persist the provider identity before the proven media-settle interval.
          await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(RECORDING_START_SETTLE_MS);
          const fresh = await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", session.id).maybeSingle();
          if (fresh.error || !fresh.data || fresh.data.version !== session.version || fresh.data.ended_at) throw new RecordingContinuationSupersededError();
          try { await deps.renewLease?.(); } catch { throw new RecordingContinuationSupersededError(); }
        }
      }
      if (["bridge", "conference_join", "conference_leave", "conference_hold", "conference_unhold", "recording_stop", "recording_start"].includes(command.kind)) {
        const provenConference = Boolean(readMeta(ctx.session).recording?.policy.conferenceVerified &&
          (["conference_join", "conference_unhold"].includes(command.kind) || command.kind === "bridge" && executed.detail?.conferenceId));
        try { await observeParticipants(deps.admin, ctx.session, commandKey(command), deps.now().toISOString(), provenConference); }
        catch { deps.logger?.({ level: "warn", scope: "recording", sessionId: session.id, code: "participant_observation_failed" }); }
      }
      outcomes.push({ key, kind: command.kind, commandId: "commandId" in command ? command.commandId : null, ok: true, skipped: executed.skipped, bestEffort: Boolean(command.bestEffort), error: null, ms: deps.now().getTime() - started, detail: executed.detail });
    } catch (error) {
      if (error instanceof RecordingContinuationSupersededError || error instanceof RecordingConnectionPendingError) {
        // A newer objection/hangup/topology transition owns this call now.
        // Never issue the delayed bridge/unhold from the superseded snapshot.
        failure = { command: key, error: error.message, callGone: false };
        outcomes.push({ key, kind: command.kind, commandId: "commandId" in command ? command.commandId : null, ok: false, skipped: true, bestEffort: Boolean(command.bestEffort), error: error.message, ms: deps.now().getTime() - started });
        break;
      }
      if (command.kind === "recording_start" || command.kind === "recording_stop") {
        try {
          const latest = await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", ctx.session.id).maybeSingle();
          if (latest.error || !latest.data) throw new EffectsError("recording state checkpoint unavailable");
          ctx.session = latest.data;
          const changed = recordingCommandOutcome(ctx.session, command, false, deps.now().toISOString(), isCallGoneError(error), error instanceof EffectsError && error.message === "recording_admission_denied" || command.kind === "recording_start" && isCallGoneError(error));
          const update = emptyTransition();
          update.session.metadata = changed.metadata;
          session = await persistTransition(deps, { session: ctx.session, transition: update, expectedVersion: ctx.session.version, event: input.event });
          ctx.session = session;
        } catch {
          // The already-persisted starting/stopping state remains potentially
          // active. Failed bookkeeping must not prevent the best-effort START
          // path from connecting assistance, or unlock a private STOP barrier.
          deps.logger?.({ level: "warn", scope: "recording", sessionId: session.id, code: "recording_checkpoint_pending" });
        }
      }
      if (command.kind === "playback_start" && command.clientState?.intent?.startsWith("seq:") && readMeta(ctx.session).announcement_sequence) {
        const update = emptyTransition();
        // executeCommand has already tried locale TTS. The immediate follow-up sweep
        // continues assistance without claiming that an unavailable privacy notice played.
        update.session.metadata = toJson({ ...readMeta(ctx.session), announcement_sequence: isCallGoneError(error) ? null : {
          ...readMeta(ctx.session).announcement_sequence, speechRetry: true, deadlineAt: deps.now().toISOString(),
        } });
        session = await persistTransition(deps, { session: ctx.session, transition: update, expectedVersion: ctx.session.version, event: input.event });
        ctx.session = session;
      }
      const message = describeError(error);
      if (command.kind === "gather" && readMeta(ctx.session).gather?.id === command.clientState.gatherId) {
        const meta = readMeta(ctx.session);
        const checkpoint = emptyTransition();
        // A failed silent music tick backs off for a minute. Prompt failure
        // continues immediately inside the runner's bounded continuation loop.
        const delay = command.spec.media === null && !command.spec.ttsText ? 60_000 : 0;
        checkpoint.session.metadata = toJson({ ...meta, gather: { ...meta.gather, failed: true, call_gone: isCallGoneError(error), deadline_at: new Date(deps.now().getTime() + delay).toISOString() } });
        session = await persistTransition(deps, { session: ctx.session, transition: checkpoint, expectedVersion: ctx.session.version, event: input.event });
        ctx.session = session;
      }
      outcomes.push({ key, kind: command.kind, commandId: "commandId" in command ? command.commandId : null, ok: false, skipped: false, bestEffort: Boolean(command.bestEffort), error: message, ms: deps.now().getTime() - started });
      if (command.bestEffort) {
        deps.logger?.({ level: "warn", scope: "effects", sessionId: session.id, command: command.kind, error: message, bestEffort: true });
        continue;
      }
      failure = { command: key, error: message, callGone: isCallGoneError(error) };
      if (failure.callGone) {
        // The far end hung up a moment before the operator pressed the button.
        // Nothing is broken: the `call.hangup` webhook is already on its way (and
        // the reconcile job is the backstop if it is lost), so this must not open
        // an incident — that would mail an alert and turn the health surface red
        // every time a caller hangs up at the wrong moment.
        deps.logger?.({ level: "warn", scope: "effects", sessionId: session.id, command: command.kind, error: message, callGone: true });
      } else {
        await recordTelephonyIncident(deps.admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error, context: { sessionId: session.id, command: command.kind, key } });
      }
      if (failure.callGone && command.kind === "playback_start" && "key" in command.media && command.media.key === "greeting") {
        // The ordinary-intro fallback can start operator dials. A provider
        // confirmation that this customer is gone must never take that path,
        // including from a later watchdog or out-of-order completion webhook.
        // Keep the normal hangup/reconciliation path responsible for accounting.
        const gone = emptyTransition();
        gone.session.metadata = toJson({ ...readMeta(session), greeting_call_gone_at: deps.now().toISOString() });
        session = await persistTransition(deps, { session, transition: gone, expectedVersion: session.version, event: input.event });
        ctx.session = session;
        break;
      }
      for (const compensation of compensations.filter((candidate) => candidate.forCommand === key)) {
        compensated.push(compensation.description);
        for (const extra of compensation.commands) {
          try {
            await executeCommand(deps, ctx, extra);
            outcomes.push({ key: commandKey(extra), kind: extra.kind, commandId: "commandId" in extra ? extra.commandId : null, ok: true, skipped: false, bestEffort: true, error: null, ms: 0, detail: { compensation: true } });
          } catch (extraError) {
            outcomes.push({ key: commandKey(extra), kind: extra.kind, commandId: "commandId" in extra ? extra.commandId : null, ok: false, skipped: false, bestEffort: true, error: describeError(extraError), ms: 0, detail: { compensation: true } });
          }
        }
        if (compensation.next) {
          const fresh = await deps.admin.from("motorist_call_sessions").select("*").eq("id", session.id).maybeSingle();
          const base = fresh.data ?? ctx.session;
          session = await persistTransition(deps, { session: base, transition: compensation.next, expectedVersion: null, event: input.event });
          ctx.session = session;
        }
      }
      break;
    }
  }

  if (!failure) {
    const fresh = await deps.admin.from("motorist_call_sessions").select("*").eq("id", session.id).maybeSingle();
    if (fresh.data) session = fresh.data;
    // Clean transition: close the open command incident (throttled per instance).
    await recoverTelephonyIncidentThrottled(deps.admin, TELEPHONY_INCIDENT_JOBS.commands, deps.now());
  }

  return { session, branch, commands: outcomes, compensations: compensated, failed: failure !== null, failure, notes: transition.notes };
}
