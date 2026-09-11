import { announcementConfigFromMetadata, isAnnouncementEnabled, resolveAnnouncement, resolveCombinedInboundIntro, type AnnouncementKey } from "@/lib/telephony/announcements";
import { commandId } from "../telnyx/command-id";
import type { AnnouncementSequence, RecorderState, RecordingState } from "./recording-types";
import { RECORDING_START_SETTLE_MS } from "./recording-types";
import { emptyTransition, ignoredResult, isOpenLeg, readMeta, toJson, type AppEvent, type AttemptRow, type Command, type LegRow, type ReduceResult, type RoutingContext, type SessionEvent, type SessionRow } from "./types";

type Core = (session: SessionRow, legs: LegRow[], attempts: AttemptRow[], event: SessionEvent, context: RoutingContext) => ReduceResult;
type Reject = (message: string) => never;
export function recordingIntent(recorderId: string): string { return `rec:${recorderId.replaceAll("-", "").slice(0, 24)}`; }
const NOTICE_KEYS: AnnouncementKey[] = ["recordingNotice", "recordingServiceNotice"];
const noticeKey = (state: RecordingState): AnnouncementKey => state.policy.qualityEnabled === true ? "recordingNotice" : "recordingServiceNotice";
const PRIVACY_ACTIONS = new Set(["hold", "park", "consult", "blind_transfer", "complete_transfer", "add_party", "supervise"]);
const ACTION_PROMPTS: Partial<Record<AppEvent["type"], AnnouncementKey>> = {
  hold: "holdStart", unhold: "resume", park: "parkStart", blind_transfer: "transferStart",
  consult: "consultStart", complete_transfer: "transferStart", cancel_consult: "resume", add_party: "conferenceJoin",
  remove_party: "conferenceLeave", leave_conference: "conferenceLeave",
};

export function potentiallyRecording(recorder: RecorderState): boolean { return recorder.observed !== "stopped"; }

/** Bookkeeping versions may change; the accepted conversation must still own audio. */
export function pendingAudioStillOwned(session: SessionRow, pending: NonNullable<RecordingState["pendingAudio"]>): boolean {
  return !session.ended_at && ["talking", "conference"].includes(session.state) &&
    (pending.operatorProfileId === undefined || pending.operatorProfileId === session.answered_by_profile_id) &&
    (!pending.conferenceId || pending.conferenceId === session.conference_id);
}

function policyState(session: SessionRow, context: RoutingContext): RecordingState | undefined {
  const existing = readMeta(session).recording;
  if (existing) return existing;
  const policy = context.recordingPolicy;
  if (!policy || session.direction === "internal") return undefined;
  const announcements = readMeta(session).announcements ?? context.announcements ?? announcementConfigFromMetadata(context.line?.metadata);
  const startupEnabled = session.direction === "inbound"
    ? announcements.inboundStartAnnouncements !== false
    : announcements.outboundStartAnnouncements === true;
  // No automatic notice means no automatic capture. Freeze this per call;
  // changing a line later must not alter a conversation already in progress.
  const effectivePolicy = startupEnabled ? policy : { ...policy, enabled: false, reason: "start_announcements_disabled" };
  return { version: 1, policy: effectivePolicy, epoch: 0, noticeCompletedAt: null, noticeFailed: false, suppressedAt: null, suppressionReason: null, recorders: [], error: effectivePolicy.enabled ? null : effectivePolicy.reason ?? null };
}

function eligible(session: SessionRow, context: RoutingContext, state: RecordingState | undefined): state is RecordingState {
  return Boolean(state?.policy.enabled && context.recordingPolicy?.enabled && !state.noticeFailed && state.suppressionReason !== "objection" &&
    (session.direction === "inbound" ? state.policy.inbound : session.direction === "outbound" && state.policy.outbound));
}

function actionAnnouncementsEnabled(session: SessionRow, context: RoutingContext, state: RecordingState | undefined): boolean {
  // Basic call controls are immediate for calls without capture. Optional
  // operational prompts remain available by explicit server configuration;
  // recorded or uncertain sessions retain their existing privacy sequence.
  return process.env.TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED === "true" ||
    Boolean(state?.recorders.some(potentiallyRecording) || state?.barrier || state?.pendingAudio) || eligible(session, context, state);
}

/** A global recording switch alone cannot make a silent call require a media lease. */
export function requiresRecordingLease(session: SessionRow, context: RoutingContext): boolean {
  const state = policyState(session, context);
  if (!state) return false;
  // Frozen policy decides whether this call may capture; live policy may revoke
  // it. Uncertain capture and pending privacy/audio work remain serialized even
  // after either policy is disabled.
  return Boolean(state.recorders.some(potentiallyRecording) || state.barrier || state.pendingAudio ||
    state.policy.enabled && context.recordingPolicy?.enabled &&
    (session.direction === "inbound" ? state.policy.inbound : session.direction === "outbound" && state.policy.outbound));
}

function patched(session: SessionRow, patch: Record<string, unknown>): SessionRow {
  return { ...session, metadata: toJson({ ...readMeta(session), ...patch }) };
}

function metadataResult(session: SessionRow, commands: Command[] = [], notes: string[] = []): ReduceResult {
  const next = emptyTransition();
  next.session.metadata = session.metadata;
  next.notes = notes;
  return { next, commands, compensations: [], guard: null, ignored: null };
}

function mergeMetadata(result: ReduceResult, session: SessionRow): ReduceResult {
  if (result.ignored) return result;
  result.next.session.metadata = toJson({ ...readMeta(session), ...readMeta({ metadata: result.next.session.metadata ?? session.metadata }) });
  if (result.guard) {
    const rejected = result.guard.onRejected.next;
    rejected.session.metadata = toJson({ ...readMeta(session), ...readMeta({ metadata: rejected.session.metadata ?? session.metadata }) });
  }
  return result;
}

function sequenceCommand(session: SessionRow, sequence: AnnouncementSequence): Command {
  const id = commandId({ sessionId: session.id, legId: sequence.callControlId, step: sequence.id, intent: `sequence:${sequence.index}:${sequence.speechRetry ? "tts" : "audio"}` });
  return { kind: "playback_start", commandId: id,
    leg: { callControlId: sequence.callControlId }, media: { key: sequence.keys[sequence.index] }, forceSpeech: sequence.speechRetry,
    clientState: { sid: session.id, role: "customer", intent: `seq:${id.replaceAll("-", "").slice(0, 24)}` } };
}

function startSequence(session: SessionRow, context: RoutingContext, callControlId: string, keys: AnnouncementKey[], continuation: SessionEvent | null, id: string): ReduceResult {
  const announcements = readMeta(session).announcements ?? context.announcements ?? announcementConfigFromMetadata(context.line?.metadata);
  const text = resolveAnnouncement(announcements, keys[0]).text;
  const timeout = Math.min(300_000, Math.max(45_000, Math.ceil(text.length / 10) * 1000 + 15_000));
  const sequence: AnnouncementSequence = { id, keys, index: 0, callControlId, startedAt: context.now.toISOString(), deadlineAt: new Date(context.now.getTime() + timeout).toISOString(), speechRetry: false, continuation };
  const changed = patched(session, { announcements, announcement_sequence: sequence });
  return metadataResult(changed, [sequenceCommand(changed, sequence)], ["customer announcement pending completion"]);
}

/** Recording state is persisted BEFORE commands. A timeout always remains potentially active. */
export function recordingCommandOutcome(session: SessionRow, command: Extract<Command, { kind: "recording_start" | "recording_stop" }>, success: boolean, at: string, callGone = false, notStarted = false, providerRecordingId?: string | null): SessionRow {
  const recording = readMeta(session).recording;
  if (!recording) return session;
  const item = recording.recorders.find((r) => r.id === command.recorderId && r.epoch === command.epoch);
  if (!item || (command.kind === "recording_start" ? item.startCommandId !== command.commandId : item.stopCommandId !== command.commandId)) return session;
  const expected = command.kind === "recording_start" ? "recording" : "stopped";
  // A late start acknowledgement must not undo an objection or a newer STOP.
  if (command.kind === "recording_start" && (item.desired !== expected || recording.epoch !== command.epoch || recording.suppressionReason === "objection")) return session;
  const stopped = notStarted || command.kind === "recording_stop" && (success || callGone);
  const updated: RecorderState = { ...item, ...(providerRecordingId ? { providerRecordingId } : {}), observed: stopped ? "stopped" : success ? "recording" : "unknown", startedAt: command.kind === "recording_start" && success ? at : item.startedAt,
    stoppedAt: stopped ? at : item.stoppedAt, error: notStarted ? "recording_admission_denied" : success || stopped ? null : `${command.kind}_unconfirmed` };
  return patched(session, { recording: { ...recording, recorders: recording.recorders.map((r) => r.id === item.id ? updated : r), error: updated.error,
    pendingAudio: command.kind === "recording_start" && success && recording.pendingAudio?.epoch === command.epoch
      ? { ...recording.pendingAudio, readyAt: new Date(Date.parse(at) + RECORDING_START_SETTLE_MS).toISOString() } : recording.pendingAudio } });
}

export function needsRecordingContinuation(session: SessionRow): boolean {
  const recording = readMeta(session).recording;
  return Boolean(recording?.barrier && recording.recorders.every((r) => !potentiallyRecording(r)));
}

function stopRecorders(session: SessionRow, state: RecordingState, event: AppEvent, context: RoutingContext, objection: boolean, continuation: AppEvent | null = objection ? null : event): ReduceResult {
  const epoch = state.epoch + 1;
  const commands: Command[] = [];
  const recorders = state.recorders.map((r): RecorderState => {
    if (!potentiallyRecording(r)) return r;
    const id = commandId({ sessionId: session.id, legId: r.callControlId, step: event.id, intent: `record:stop:${r.id}` });
    commands.push({ kind: "recording_stop", commandId: id, leg: { callControlId: r.callControlId }, recorderId: r.id, epoch: r.epoch });
    return { ...r, stopCommandId: id, desired: "stopped", observed: "stopping", error: null };
  });
  const changed = patched(session, { recording: { ...state, epoch, recorders, pendingAudio: null, suppressedAt: objection ? context.now.toISOString() : state.suppressedAt,
    suppressionReason: objection ? "objection" : state.suppressionReason === "objection" ? "objection" : "topology",
    barrier: { action: continuation, epoch, deadlineAt: new Date(context.now.getTime() + 5_000).toISOString() }, error: null } satisfies RecordingState });
  return metadataResult(changed, commands, [objection ? "recording objection persisted; waiting for verified stop" : "privacy action waits for all recorders to stop"]);
}

function startBeforeAudio(result: ReduceResult, session: SessionRow, legs: LegRow[], event: SessionEvent, context: RoutingContext, resumeConversation = false): ReduceResult {
  result = mergeMetadata(result, session);
  // Teardown can proceed without a media lease, but cannot start new capture.
  // Keep approved policy intact so an overlapping sweep cannot revoke it.
  if (context.recordingLeaseHeld === false) return result;
  const state = readMeta(session).recording;
  if (!eligible(session, context, state) || !state.noticeCompletedAt || state.recorders.some(potentiallyRecording) || session.ended_at) return mergeMetadata(result, session);
  if (state.recorders.length >= 128) return mergeMetadata(result, patched(session, { recording: { ...state, error: "recording_segment_limit" } }));
  const customer = legs.find((leg) => leg.role === "customer" && isOpenLeg(leg));
  if (!customer) return mergeMetadata(result, session);
  const nextMeta = readMeta({ metadata: result.next.session.metadata ?? session.metadata });
  const nextState = result.next.session.state ?? session.state;
  if (Object.values(nextMeta.supervise ?? {}).some((entry) => entry.mode === "whisper") || nextState === "consulting") return mergeMetadata(result, session);
  const conference = Boolean(session.conference_id || result.commands.some((command) => command.kind === "conference_create" || command.kind === "conference_join"));
  if (conference && (!state.policy.conferenceVerified || !context.recordingPolicy?.conferenceVerified)) return mergeMetadata(result, session);
  if (nextMeta.transfer && (!state.policy.transferVerified || !context.recordingPolicy?.transferVerified)) return mergeMetadata(result, session);
  let index = result.commands.findIndex((command) => command.kind === "bridge" && (command.leg.callControlId === customer.telnyx_call_control_id || command.target.callControlId === customer.telnyx_call_control_id));
  if (index < 0 && conference && ["talking", "conference"].includes(nextState)) {
    index = result.commands.findIndex((command) => command.kind === "conference_unhold" && command.legs.some((leg) => leg.callControlId === customer.telnyx_call_control_id));
    if (index < 0) index = result.commands.findIndex((command) => command.kind === "conference_join" &&
      state.notifiedCallControlIds?.includes(command.leg.callControlId ?? ""));
  }
  if (index < 0 && event.kind === "app" && event.type === "stop_supervise" && ["talking", "conference"].includes(nextState)) index = result.commands.length;
  if (index < 0 && event.kind === "telnyx" && event.type === "call.recording.saved" && ["talking", "conference"].includes(nextState)) index = result.commands.length;
  if (index < 0 && resumeConversation && nextState === "talking" && !session.hold_started_at) index = result.commands.length;
  const supervisor = event.kind === "telnyx" ? legs.find((leg) => leg.telnyx_call_control_id === event.callControlId && leg.role === "supervisor") : undefined;
  const supervisorMode = supervisor?.profile_id ? nextMeta.supervise?.[supervisor.profile_id]?.mode : event.kind === "app" && event.type === "supervise" ? event.supervisor?.mode : undefined;
  if (index < 0 && state.policy.conferenceVerified && context.recordingPolicy?.conferenceVerified && ["talking", "conference"].includes(nextState) &&
    ((event.kind === "telnyx" && event.type === "call.answered" && supervisor && (supervisorMode === "monitor" || supervisorMode === "barge" && state.notifiedCallControlIds?.includes(supervisor.telnyx_call_control_id))) ||
    (event.kind === "app" && event.type === "supervise" && supervisorMode === "barge" && result.commands.some((command) => command.kind === "conference_update" || command.kind === "supervisor_role_switch")))) index = result.commands.length;
  if (index < 0) return mergeMetadata(result, session);
  // Physical dual-channel probes found intermittent lost audio when an existing
  // bridge was promoted. Establish the customer conference before connecting
  // the operator, while both legs are still independent. The durable bridge
  // continuation owns both steps and can recover a missing provider response.
  const connection = result.commands[index];
  if (connection?.kind === "bridge" && !connection.playRingtone && !session.conference_id &&
    connection.leg.callControlId === customer.telnyx_call_control_id && state.policy.conferenceVerified && context.recordingPolicy?.conferenceVerified) {
    connection.recordingConferenceName = `rec-${session.id}-${connection.commandId}`;
  }
  const id = commandId({ sessionId: session.id, legId: customer.telnyx_call_control_id, step: event.id, intent: `record:start:${state.epoch}` });
  const recorder: RecorderState = { id, epoch: state.epoch, callControlId: customer.telnyx_call_control_id, startCommandId: id, desired: "recording", observed: "starting", startedAt: null, stoppedAt: null, error: null };
  const pendingCommands = result.commands.slice(index).filter((command): command is Extract<Command, { kind: "bridge" | "conference_unhold" | "conference_join" }> => ["bridge", "conference_unhold", "conference_join"].includes(command.kind));
  const operatorProfileId = result.next.session.answered_by_profile_id === undefined ? session.answered_by_profile_id : result.next.session.answered_by_profile_id;
  const changed = patched(session, { recording: { ...state, recorders: [...state.recorders, recorder], suppressionReason: null, error: null,
    connection: connection?.kind === "bridge" && connection.recordingConferenceName
      ? { commandId: connection.commandId, epoch: state.epoch, startedAt: context.now.toISOString(), confirmedAt: null, conferenceId: null,
        operatorProfileId,
        callControlIds: [connection.leg.callControlId!, connection.target.callControlId!] }
      : state.connection,
    pendingAudio: pendingCommands.length ? { commands: pendingCommands, epoch: state.epoch, startedAt: context.now.toISOString(), readyAt: new Date(context.now.getTime() + RECORDING_START_SETTLE_MS).toISOString(), sourceEventId: event.id,
      operatorProfileId, conferenceId: session.conference_id } : null } });
  result.commands.splice(index, 0, { kind: "recording_start", commandId: id, leg: { callControlId: recorder.callControlId }, recorderId: id, epoch: recorder.epoch,
    maxLength: Math.max(30, Math.min(1800, state.policy.maxSegmentSeconds)), bestEffort: true });
  result.next.session.metadata = toJson({ ...readMeta({ metadata: result.next.session.metadata ?? session.metadata }), recording: readMeta(changed).recording });
  return result;
}

/** Wrapper around the existing routing reducer. Only correlated media completions release audio. */
export function reduceRecording(session: SessionRow, legs: LegRow[], attempts: AttemptRow[], event: SessionEvent, context: RoutingContext, core: Core, reject: Reject, resumed = false): ReduceResult {
  let current = session;
  const state = policyState(session, context);
  if (state) current = patched(current, { recording: state });
  const customer = legs.find((leg) => leg.role === "customer" && isOpenLeg(leg));
  const meta = readMeta(current);
  const sequence = meta.announcement_sequence;
  const announcements = meta.announcements ?? context.announcements ?? announcementConfigFromMetadata(context.line?.metadata);
  if (event.kind === "telnyx" && (event.type === "call.recording.saved" || event.type === "call.recording.error")) {
    const recorder = state?.recorders.find((r) => r.callControlId === event.callControlId && (r.providerRecordingId && typeof event.payload.recording_id === "string" ? r.providerRecordingId === event.payload.recording_id : recordingIntent(r.id) === event.clientState?.intent));
    if (!state || !recorder) return ignoredResult("recording event has no matching recorder token");
    const endedAt = typeof event.payload.recording_ended_at === "string" && Number.isFinite(Date.parse(event.payload.recording_ended_at)) ? event.payload.recording_ended_at : null;
    const saved = event.type === "call.recording.saved" && endedAt !== null;
    const changed: RecorderState = { ...recorder, observed: saved ? "stopped" : "unknown", desired: saved ? "stopped" : recorder.desired,
      stoppedAt: saved ? endedAt : recorder.stoppedAt, error: saved ? null : "recording_provider_error" };
    const providerStartedAt = typeof event.payload.recording_started_at === "string" ? event.payload.recording_started_at : null;
    const rollover = saved && providerStartedAt && recorder.desired === "recording" && !state.barrier && eligible(current, context, state) &&
      Date.parse(endedAt!) - Date.parse(providerStartedAt) >= Math.max(30, Math.min(1800, state.policy.maxSegmentSeconds)) * 1000 - 1000;
    const updated = patched(current, { recording: { ...state, epoch: rollover ? state.epoch + 1 : state.epoch, recorders: state.recorders.map((r) => r.id === recorder.id ? changed : r),
      error: state.epoch === recorder.epoch ? changed.error : state.error } });
    const result = metadataResult(updated, [], [saved ? "provider saved recording with ended timestamp" : "provider recorder state uncertain"]);
    return rollover ? startBeforeAudio(result, updated, legs, event, context) : result;
  }
  if (event.kind === "app" && event.type === "hangup") {
    current = patched(current, { announcement_sequence: null, recording: state ? { ...state, barrier: null, pendingAudio: null } : undefined });
    return mergeMetadata(core(current, legs, attempts, event, context), current);
  }
  if (event.kind === "telnyx" && event.type === "call.hangup") {
    if (sequence?.callControlId === event.callControlId) current = patched(current, { announcement_sequence: null,
      recording: state && sequence.keys.some((key) => NOTICE_KEYS.includes(key)) ? { ...state, noticeFailed: true, error: "notice_interrupted" } : state });
    if (event.callControlId === customer?.telnyx_call_control_id) current = patched(current, { announcement_sequence: null, recording: state ? { ...state, barrier: null, pendingAudio: null,
      recorders: state.recorders.map((r) => r.callControlId === event.callControlId ? { ...r, desired: "stopped", observed: "stopped", stoppedAt: event.occurredAt ?? context.now.toISOString() } : r) } : undefined });
    const result = core(current, legs, attempts, event, context);
    return result.ignored && sequence?.callControlId === event.callControlId ? metadataResult(current) : mergeMetadata(result, current);
  }
  if (event.kind === "app" && (event.type === "recording_stop" || event.type === "recording_retry_stop")) {
    if (!customer || !state || current.ended_at) return reject("Hovor nemá aktívne nahrávanie.");
    return stopRecorders(patched(current, { announcement_sequence: null }), state, event, context, true);
  }
  if (event.kind === "app" && ["sweep", "recording_policy_stop"].includes(event.type) && state?.recorders.some(potentiallyRecording) && !context.recordingPolicy?.enabled && customer && !current.ended_at) {
    return stopRecorders(patched(current, { announcement_sequence: null }), state, event, context, false, null);
  }
  if (event.kind === "app" && event.type === "recording_policy_stop") return ignoredResult("recording policy already converged");
  if (state?.pendingAudio && !sequence && (event.kind === "app" && event.type === "sweep" || event.id === state.pendingAudio.sourceEventId)) {
    const pending = state.pendingAudio;
    const valid = pending.epoch === state.epoch && state.suppressionReason !== "objection" && pendingAudioStillOwned(current, pending) && customer;
    if (!valid) return metadataResult(patched(current, { recording: { ...state, pendingAudio: null } }));
    if (Date.parse(pending.readyAt) > context.now.getTime()) return ignoredResult("recording media readiness interval pending");
    const commands = pending.commands.filter((command) => command.kind === "bridge"
      ? legs.some((leg) => isOpenLeg(leg) && leg.telnyx_call_control_id === command.leg.callControlId) && legs.some((leg) => isOpenLeg(leg) && leg.telnyx_call_control_id === command.target.callControlId)
      : command.kind === "conference_join" ? legs.some((leg) => isOpenLeg(leg) && leg.telnyx_call_control_id === command.leg.callControlId)
      : command.legs.every((ref) => legs.some((leg) => isOpenLeg(leg) && leg.telnyx_call_control_id === ref.callControlId)));
    return commands.length ? metadataResult(current, commands, ["retrying durable customer audio commands after media readiness"]) : metadataResult(patched(current, { recording: { ...state, pendingAudio: null } }));
  }
  if (event.kind === "app" && event.type === "recording_continue") {
    if (!state?.barrier || !needsRecordingContinuation(current) || !customer || current.ended_at) return ignoredResult("recording barrier not confirmed");
    const action = state.barrier.action;
    const expired = context.now.getTime() > Date.parse(state.barrier.deadlineAt);
    current = patched(current, { recording: { ...state, barrier: null, error: expired && action ? "privacy_action_expired" : null } });
    if (!action) return isAnnouncementEnabled(announcements, "recordingPaused")
      ? startSequence(current, context, customer.telnyx_call_control_id, ["recordingPaused"], null, event.id)
      : metadataResult(current);
    if (expired) return metadataResult(current, [], ["privacy action expired; original conversation retained"]);
    return reduceRecording(current, legs, attempts, action, context, core, reject);
  }
  if (event.kind === "app" && event.type === "sweep" && state?.barrier && Date.parse(state.barrier.deadlineAt) <= context.now.getTime()) {
    current = patched(current, { recording: { ...state, barrier: null, error: state.recorders.some(potentiallyRecording) ? "recording_stop_unconfirmed" : "privacy_action_expired" } });
    return metadataResult(current, [], ["privacy barrier deadline elapsed; action not executed"]);
  }
  if (sequence && !resumed) {
    const timeout = event.kind === "app" && event.type === "sweep" && Date.parse(sequence.deadlineAt) <= context.now.getTime();
    const completion = event.kind === "telnyx" && (event.type === "call.playback.ended" || event.type === "call.speak.ended") && event.callControlId === sequence.callControlId &&
      event.clientState?.intent === (sequenceCommand(current, sequence) as Extract<Command, {kind: "playback_start"}>).clientState?.intent && (!sequence.speechRetry || event.type === "call.speak.ended");
    if (completion || timeout) {
      if (!customer || current.ended_at || !legs.some((leg) => leg.telnyx_call_control_id === sequence.callControlId && isOpenLeg(leg))) return metadataResult(patched(current, { announcement_sequence: null }));
      const success = completion && event.kind === "telnyx" && event.status === "completed";
      if (!success && !sequence.speechRetry) {
        const retry = { ...sequence, speechRetry: true, deadlineAt: new Date(context.now.getTime() + 45_000).toISOString() };
        const commands: Command[] = timeout ? [{ kind: "playback_stop", commandId: commandId({ sessionId: current.id, legId: sequence.callControlId, step: sequence.id, intent: "sequence:watchdog:stop" }), leg: { callControlId: sequence.callControlId }, bestEffort: true }] : [];
        commands.push(sequenceCommand(current, retry));
        return metadataResult(patched(current, { announcement_sequence: retry }), commands, ["announcement retries once using locale speech"]);
      }
      let recording = readMeta(current).recording;
      if (NOTICE_KEYS.includes(sequence.keys[sequence.index]) && recording) recording = { ...recording, noticeCompletedAt: success ? context.now.toISOString() : null, noticeFailed: !success,
        notifiedCallControlIds: success ? [...new Set([...(recording.notifiedCallControlIds ?? []), sequence.callControlId])] : recording.notifiedCallControlIds, error: success ? null : "notice_unavailable" };
      current = patched(current, { recording, announcement_sequence: null });
      if (success && sequence.index + 1 < sequence.keys.length) return startSequence(current, context, sequence.callControlId, sequence.keys.slice(sequence.index + 1), sequence.continuation, `${sequence.id}:next`);
      if (!sequence.continuation) return metadataResult(current);
      return reduceRecording(current, legs, attempts, sequence.continuation, context, core, reject, true);
    }
    if (event.kind === "app" && event.type !== "sweep") return reject("Počkajte na dokončenie hlášky.");
    if (event.kind === "app" && event.type === "sweep") return ignoredResult("announcement still pending");
    if (event.kind === "telnyx" && (["call.playback.ended", "call.speak.ended"].includes(event.type) || event.type === "call.answered" && sequence.continuation?.kind === "telnyx" && event.callControlId === sequence.continuation.callControlId)) return ignoredResult("unrelated or duplicate event during announcement");
    if (event.id === sequence.continuation?.id || (event.kind === "telnyx" && event.clientState?.intent?.startsWith("seq:"))) return ignoredResult("announcement already pending or completion stale");
  }
  if (!resumed && customer && !current.ended_at) {
    if (event.kind === "app" && PRIVACY_ACTIONS.has(event.type) && state?.recorders.some(potentiallyRecording)) {
      // Validate the requested action before changing capture, without executing any effects.
      core(current, legs, attempts, event, context);
      if (state.barrier) return reject("Vypnutie nahrávania ešte nie je potvrdené.");
      return stopRecorders(current, state, event, context, false);
    }
    if (event.kind === "app" && ACTION_PROMPTS[event.type] && session.direction !== "internal" && actionAnnouncementsEnabled(current, context, state)) {
      core(current, legs, attempts, event, context);
      const keys: AnnouncementKey[] = [ACTION_PROMPTS[event.type]!];
      if (["unhold", "cancel_consult"].includes(event.type) && isAnnouncementEnabled(announcements, "recordingResumed") && eligible(current, context, state) && state.policy.conferenceVerified && context.recordingPolicy?.conferenceVerified) keys.push("recordingResumed");
      // A private consult participant must hear the recording notice before joining the customer.
      if (event.type === "complete_transfer" && eligible(current, context, state) && state.policy.conferenceVerified && state.policy.transferVerified) {
        const consult = legs.find((leg) => leg.role === "consult" && isOpenLeg(leg));
        if (consult && !state.notifiedCallControlIds?.includes(consult.telnyx_call_control_id)) return startSequence(current, context, consult.telnyx_call_control_id, [noticeKey(state)], event, event.id);
      }
      return startSequence(current, context, customer.telnyx_call_control_id, keys, event, event.id);
    }
    if (event.kind === "app" && event.type === "supervise" && event.supervisor?.mode === "barge" && eligible(current, context, state) && state.policy.conferenceVerified) {
      const supervisor = legs.find((leg) => leg.role === "supervisor" && leg.profile_id === event.supervisor?.profileId && isOpenLeg(leg));
      if (supervisor && !state.notifiedCallControlIds?.includes(supervisor.telnyx_call_control_id)) return startSequence(current, context, supervisor.telnyx_call_control_id, [noticeKey(state)], event, event.id);
    }
    if (event.kind === "app" && event.type === "stop_supervise" && isAnnouncementEnabled(announcements, "recordingResumed") && eligible(current, context, state) && state.recorders.length) {
      core(current, legs, attempts, event, context);
      return startSequence(current, context, customer.telnyx_call_control_id, ["recordingResumed"], event, event.id);
    }
    if (event.kind === "telnyx" && event.type === "call.answered" && eligible(current, context, state)) {
      const party = legs.find((leg) => {
        const intent = (leg.client_state as { intent?: string } | null)?.intent;
        return leg.telnyx_call_control_id === event.callControlId && ((intent === "party" && state.policy.conferenceVerified) || (["transfer_recorded", "transfer_safe"].includes(intent ?? "") && state.policy.transferVerified) ||
          (leg.role === "supervisor" && state.policy.conferenceVerified && meta.supervise?.[leg.profile_id ?? ""]?.mode === "barge"));
      });
      if (party && !state.notifiedCallControlIds?.includes(party.telnyx_call_control_id)) return startSequence(current, context, party.telnyx_call_control_id, [noticeKey(state)], event, event.id);
    }
    if (event.kind === "telnyx" && session.direction === "inbound" && session.state === "greeting" && event.status === "completed" &&
      event.callControlId === customer.telnyx_call_control_id && ["call.playback.ended", "call.speak.ended"].includes(event.type) &&
      event.clientState?.intent === (meta.greeting?.speech_retry ? "greeting_retry" : "greeting") &&
      (!meta.greeting?.speech_retry || event.type === "call.speak.ended") && eligible(current, context, state) && !state.noticeCompletedAt) {
      const combined = meta.greeting?.recording_notice && resolveCombinedInboundIntro(announcements, meta.greeting.recording_notice);
      if (combined && combined.notice === noticeKey(state)) {
        current = patched(current, { recording: { ...state, noticeCompletedAt: context.now.toISOString(), noticeFailed: false,
          notifiedCallControlIds: [...new Set([...(state.notifiedCallControlIds ?? []), customer.telnyx_call_control_id])], error: null } });
        return mergeMetadata(core(current, legs, attempts, event, context), current);
      }
      return startSequence(current, context, customer.telnyx_call_control_id, [noticeKey(state)], event, event.id);
    }
    if (event.kind === "telnyx" && event.type === "call.answered" && meta.outbound_audio_gate && session.direction === "outbound" && event.callControlId === customer.telnyx_call_control_id && session.state === "ringing") {
      const keys: AnnouncementKey[] = announcements.outboundStartAnnouncements === true ? ["outboundIntro"] : [];
      // Existing recorded sessions keep their notice contract across releases.
      // New silent sessions have recording disabled in their frozen policy.
      if (eligible(current, context, state)) keys.push(noticeKey(state));
      if (keys.length) return startSequence(current, context, customer.telnyx_call_control_id, keys, event, event.id);
    }
  }
  const result = core(current, legs, attempts, event, context);
  if (event.kind === "app" && event.type === "blind_transfer" && current.state === "talking" && state?.suppressionReason === "topology") {
    for (const compensation of result.compensations) {
      const prerequisite = result.commands.find((command) => "commandId" in command && command.commandId === compensation.forCommand);
      if (!compensation.next || !prerequisite || !["dial", "transfer"].includes(prerequisite.kind)) continue;
      const restored = { ...current, ...compensation.next.session };
      const recording = readMeta(restored).recording;
      if (!recording) continue;
      // The privacy barrier stopped capture while the original conversation
      // remained audible. Rejection resumes capture without erasing that gap.
      const withGap = patched(restored, { recording: { ...recording, coverageUnconfirmed: recording.coverageUnconfirmed ?? {
        since: recording.recorders.at(-1)?.stoppedAt ?? context.now.toISOString(), epoch: recording.epoch, audioCommandId: compensation.forCommand,
      } } });
      compensation.next.session.metadata = withGap.metadata;
      const recovery = startBeforeAudio({ next: compensation.next, commands: compensation.commands, compensations: [], guard: null, ignored: null },
        withGap, legs, { ...event, id: `${event.id}:compensate:${compensation.forCommand}` }, context, true);
      compensation.next = recovery.next;
      compensation.commands = recovery.commands;
    }
  }
  return startBeforeAudio(result, current, legs, event, context);
}
