import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
function time(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

export type ConnectionOutcome = {
  eventId: string;
  sessionId: string;
  failedAt: string;
  outcome: "pending" | "confirmed_after_failure" | "command_recovered" | "ended_without_confirmation" | "unknown";
};

type FailedCommand = { id: string | null; kind: string };
type Recovery = { id: string; kind: string; at: string };

/** A completed ledger row is not a repaired command or proof of physical audio. */
export function classifyConnectionFailure(input: {
  eventId: string; sessionId: string; failedAt: string; eventAt: string | null;
  commands: FailedCommand[]; recovered?: Recovery[];
  session: { state: string; ended_at: string | null; metadata: unknown } | undefined;
}): ConnectionOutcome {
  const { session } = input;
  const recording = object(object(session?.metadata).recording);
  const connection = object(recording.connection);
  const sourceAt = time(input.failedAt);
  const identifiable = input.commands.length > 0 && input.commands.every((command) => command.id);
  const confirmed = identifiable && input.commands.every((command) => command.kind === "bridge" &&
    connection.commandId === command.id && time(connection.confirmedAt) >= sourceAt);
  const recovered = identifiable && input.commands.every((command) => input.recovered?.some((result) =>
    result.id === command.id && result.kind === command.kind && time(result.at) >= sourceAt));
  const pending = object(recording.pendingAudio);
  const pendingCommands = Array.isArray(pending.commands) ? pending.commands.map(object) : [];
  let outcome: ConnectionOutcome["outcome"] = "unknown";
  if (confirmed) outcome = "confirmed_after_failure";
  else if (recovered) outcome = "command_recovered";
  else if (session?.ended_at || session && ["ended", "failed"].includes(session.state)) outcome = "ended_without_confirmation";
  else if (input.commands.some((command) => command.id && pendingCommands.some((entry) => entry.commandId === command.id))) outcome = "pending";
  // A later hangup, park, objection, or unrelated bridge cannot explain an older
  // failure by itself. Historical audits without command identity stay unknown.
  return { eventId: input.eventId, sessionId: input.sessionId, failedAt: input.failedAt, outcome };
}

export async function getRecentConnectionOutcomes(deps: {
  admin: SupabaseClient<Database>; organizationId: string; since: string;
}): Promise<{ entries: ConnectionOutcome[]; truncated: boolean; error: string | null }> {
  const events = await deps.admin.from("motorist_call_events").select("id, created_at, provider_timestamp, normalized_payload")
    .eq("organization_id", deps.organizationId).eq("handled_status", "failed")
    .gte("created_at", deps.since).order("created_at", { ascending: false }).limit(201);
  if (events.error) return { entries: [], truncated: false, error: events.error.message };
  const failures = (events.data ?? []).slice(0, 200).flatMap((event) => {
    const payload = object(event.normalized_payload);
    if (typeof payload.session_id !== "string") return [];
    const commands = Array.isArray(payload.commands) ? payload.commands.map(object) : [];
    const connectionFailed = commands.some((command) => command.ok === false && ["bridge", "conference_join", "conference_unhold"].includes(String(command.kind)));
    const recordingContinuation = payload.error === "recording continuation superseded; delayed audio action cancelled";
    if (!connectionFailed && !recordingContinuation) return [];
    // A provider telling us the customer has already gone is normal teardown.
    if (typeof payload.error === "string" && /90018|call_gone|not_active/.test(payload.error)) return [];
    return [{ eventId: event.id, sessionId: payload.session_id, failedAt: event.created_at, eventAt: event.provider_timestamp,
      commands: commands.filter((command) => command.ok === false && ["bridge", "conference_join", "conference_unhold"].includes(String(command.kind)))
        .map((command) => ({ id: typeof command.command_id === "string" ? command.command_id : null, kind: String(command.kind) })) }];
  });
  const ids = [...new Set(failures.map((entry) => entry.sessionId))];
  if (!ids.length) return { entries: [], truncated: (events.data?.length ?? 0) > 200, error: null };
  const sessions = await deps.admin.from("motorist_call_sessions").select("id, state, ended_at, metadata")
    .eq("organization_id", deps.organizationId).in("id", ids);
  if (sessions.error) return { entries: [], truncated: false, error: sessions.error.message };
  const successes = await deps.admin.from("motorist_call_events").select("created_at, normalized_payload")
    .eq("organization_id", deps.organizationId).eq("handled_status", "processed")
    .in("normalized_payload->>session_id", ids).gte("created_at", deps.since)
    .order("created_at", { ascending: false }).limit(501);
  if (successes.error) return { entries: [], truncated: false, error: successes.error.message };
  const recovered = new Map<string, Recovery[]>();
  for (const event of (successes.data ?? []).slice(0, 500)) {
    const payload = object(event.normalized_payload);
    if (typeof payload.session_id !== "string" || !Array.isArray(payload.commands)) continue;
    const entries = payload.commands.map(object).flatMap((command) => command.ok === true && command.skipped === false && typeof command.command_id === "string"
      ? [{ id: command.command_id, kind: String(command.kind), at: event.created_at }] : []);
    recovered.set(payload.session_id, [...(recovered.get(payload.session_id) ?? []), ...entries]);
  }
  const byId = new Map((sessions.data ?? []).map((session) => [session.id, session]));
  return { entries: failures.map((failure) => classifyConnectionFailure({ ...failure, session: byId.get(failure.sessionId), recovered: recovered.get(failure.sessionId) })),
    truncated: (events.data?.length ?? 0) > 200 || (successes.data?.length ?? 0) > 500, error: null };
}
