import { measureRequestStep } from "@/server/request-metrics";
import type { Json } from "@/lib/supabase/database.types";
import type { EffectsDeps } from "./effects";
import { SessionConflictError } from "../service-errors";
import { commandKey, readMeta, toJson, type Command, type Compensation, type ReduceResult, type SessionEvent, type SessionRow, type Transition } from "./types";

export type EffectContinuation = {
  id: string;
  generation: number;
  createdAt: string;
  event: SessionEvent;
  stateBefore: SessionRow["state"];
  previousConferenceId: string | null;
  branch: "main" | "rejected";
  transition: Transition;
  commands: Command[];
  compensations: Compensation[];
  databaseCursor: number;
  completedCommands: string[];
  attempts: number;
  lastError: string | null;
  auditComplete: boolean;
  /** Captured provider evidence survives a failed atomic accounting stage. */
  verifiedContact?: Json;
};

export type PendingEffects = { version: 1; entries: EffectContinuation[] };

export function readPendingEffects(session: Pick<SessionRow, "pending_effects">): PendingEffects {
  const value = session.pending_effects;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1, entries: [] };
  if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error("Unsupported telephony effects contract");
  return value as unknown as PendingEffects;
}

export function effectGeneration(session: Pick<SessionRow, "metadata">): number {
  return readMeta(session).effects_v1?.generation ?? 0;
}

function topologyChanged(before: SessionRow, after: SessionRow): boolean {
  const a = readMeta(before), b = readMeta(after);
  return before.state !== after.state || before.answered_by_profile_id !== after.answered_by_profile_id ||
    before.conference_id !== after.conference_id || before.ended_at !== after.ended_at ||
    a.transfer?.at !== b.transfer?.at || a.consult?.at !== b.consult?.at || a.park?.at !== b.park?.at ||
    a.ring?.active_step !== b.ring?.active_step || a.recording?.epoch !== b.recording?.epoch;
}

/** Teardown stays useful after termination; commands that create audio do not. */
export function commandStillApplies(session: SessionRow, entry: EffectContinuation, command: Command): boolean {
  if (["hangup", "recording_stop"].includes(command.kind)) return true;
  if (command.kind === "conference_leave" && (command.conferenceId || entry.previousConferenceId)) return true;
  if (command.kind === "recording_start") {
    const recording = readMeta(session).recording;
    if (!recording?.policy.enabled || recording.epoch !== command.epoch || recording.suppressionReason === "objection" || recording.noticeFailed || !recording.noticeCompletedAt ||
      !recording.recorders.some((recorder) => recorder.id === command.recorderId && recorder.desired === "recording" && recorder.startCommandId === command.commandId)) return false;
  }
  return !session.termination_requested_at && !session.ended_at && !["ended", "failed"].includes(session.state) && effectGeneration(session) === entry.generation;
}

export function databaseEffectCount(transition: Transition): number {
  return transition.legs.length + transition.attempts.length + transition.presence.filter((change) => !change.afterCommandId).length + transition.callbacks.length + (transition.contactProofs?.length ?? 0) + transition.memberTouches.length + 1;
}

export function criticalDatabaseEffectCount(transition: Transition): number {
  return transition.legs.length + transition.attempts.length + transition.presence.filter((change) => !change.afterCommandId).length + transition.callbacks.length;
}

export function continuationComplete(entry: EffectContinuation): boolean {
  return entry.auditComplete && entry.databaseCursor >= databaseEffectCount(entry.transition) && entry.commands.every((command) => entry.completedCommands.includes(commandKey(command)));
}

function prepared(session: SessionRow, transition: Transition, commands: Command[], compensations: Compensation[], event: SessionEvent, branch: EffectContinuation["branch"], now: string) {
  for (const command of commands) {
    if (session.conference_id && command.kind.startsWith("conference_") && command.kind !== "conference_create") command.conferenceId ??= session.conference_id;
  }
  const after = { ...session, ...transition.session };
  const generation = effectGeneration(session) + (topologyChanged(session, after) ? 1 : 0);
  const sessionPatch = { ...transition.session, metadata: toJson({ ...readMeta(after), effects_v1: { generation } }) };
  // The original provider envelope already lives in the webhook ledger.
  const savedEvent = event.kind === "telnyx" ? { ...event, payload: {}, rawClientState: null } : event;
  const entry: EffectContinuation = {
    id: event.id, generation, createdAt: now, event: savedEvent, stateBefore: session.state,
    previousConferenceId: session.conference_id, branch,
    transition: { ...transition, session: {} }, commands, compensations,
    databaseCursor: 0, completedCommands: [], attempts: 0, lastError: null, auditComplete: false,
  };
  return { sessionPatch, entry };
}

export async function stageEffects(deps: EffectsDeps, input: { session: SessionRow; result: ReduceResult; event: SessionEvent; expectedVersion: number }): Promise<SessionRow> {
  const now = deps.now().toISOString();
  const main = prepared(input.session, input.result.next, input.result.commands, input.result.compensations, input.event, "main", now);
  const rejected = input.result.guard ? prepared(input.session, input.result.guard.onRejected.next, input.result.guard.onRejected.commands, [], input.event, "rejected", now) : null;
  const result = await deps.admin.rpc("motorist_stage_transition_v1", {
    p_organization_id: deps.organizationId, p_session_id: input.session.id, p_expected_version: input.expectedVersion,
    p_main: toJson(main), p_rejected: toJson(rejected), p_guard: toJson(input.result.guard ? { profileId: input.result.guard.profileId, offerToken: input.result.guard.offerToken ?? null } : null),
  });
  if (result.error) throw new Error(`Transition staging failed: ${result.error.message}`);
  const response = result.data as { applied?: boolean; session?: SessionRow } | null;
  if (response?.applied === false) throw new SessionConflictError(input.session.id, input.expectedVersion);
  if (!response?.session) throw new Error("Transition staging returned no session");
  return response.session;
}

export async function checkpointEffects(deps: EffectsDeps, sessionId: string, entry: EffectContinuation | null, entryId: string): Promise<SessionRow> {
  return measureRequestStep("checkpoint", () => checkpointOwnedEffects(deps, sessionId, entry, entryId));
}

async function checkpointOwnedEffects(deps: EffectsDeps, sessionId: string, entry: EffectContinuation | null, entryId: string): Promise<SessionRow> {
  for (let retry = 0; retry < 3; retry += 1) {
    const fresh = await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", sessionId).single();
    if (fresh.error || !fresh.data) throw new Error(`Effects checkpoint read failed: ${fresh.error?.message ?? "missing session"}`);
    const pending = readPendingEffects(fresh.data);
    if (!pending.entries.some((item) => item.id === entryId)) return fresh.data;
    const entries = pending.entries.flatMap((item) => item.id === entryId ? entry ? [entry] : [] : [item]);
    const updated = await deps.admin.from("motorist_call_sessions").update({
      pending_effects: entries.length ? toJson({ version: 1, entries }) : null,
      effects_next_attempt_at: entries.length ? new Date(deps.now().getTime() + 30_000).toISOString() : null,
      version: fresh.data.version + 1,
    }).eq("organization_id", deps.organizationId).eq("id", sessionId).eq("version", fresh.data.version).select("*").maybeSingle();
    if (updated.error) throw new Error(`Effects checkpoint failed: ${updated.error.message}`);
    if (updated.data) return updated.data;
  }
  throw new Error("Effects checkpoint lost its session version");
}
