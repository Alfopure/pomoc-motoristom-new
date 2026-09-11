import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { contactOperationIntent } from "./contact-proof";
import { ownershipRpc, sessionOwnership } from "./ownership";
import type { TelephonyEvent } from "./state/types";
import { decodeClientState } from "./telnyx/client-state";
import type { TelnyxClient } from "./telnyx/client";

export type PendingProviderCommand = {
  commandId: string; fingerprint: string; path: string; payload: Record<string, unknown>;
  dispatchGeneration: number; dispatchToken: string; firstDispatchedAt: string; correlationState: string | null;
};

const ELIGIBLE = new Set(["call.answered", "call.hangup", "call.bridged", "conference.created", "conference.participant.joined", "conference.participant.left"]);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | null => typeof value === "string" && value.length ? value : null;

function timeMicros(value: string | null): bigint | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const subMillisecond = /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(value)?.[1].padEnd(6, "0").slice(3, 6) ?? "000";
  return BigInt(Date.parse(value)) * BigInt(1000) + BigInt(subMillisecond);
}

function pathParts(path: string): string[] | null {
  try { return path.split("/").filter(Boolean).map(decodeURIComponent); }
  catch { return null; }
}

/** Pure endpoint-specific evidence filter. The provider's shared session ID is never proof. */
export function commandEvidenceCandidate(command: PendingProviderCommand, sessionId: string, event: TelephonyEvent): boolean {
  const dispatched = timeMicros(command.firstDispatchedAt), occurred = timeMicros(event.occurredAt);
  if (dispatched === null || occurred === null || occurred < dispatched) return false;
  const parts = pathParts(command.path);
  if (!parts) return false;
  const payload = record(command.payload);
  if (parts.length === 4 && parts[0] === "calls" && parts[2] === "actions" && event.callControlId === parts[1]) {
    if (parts[3] === "answer" && event.type === "call.answered") return true;
    if (parts[3] === "hangup" && event.type === "call.hangup") return true;
    if (parts[3] === "bridge" && event.type === "call.bridged") {
      // Telnyx does not echo the peer in call.bridged. Bind the immutable pair
      // through our unique command intent on the source leg, never only a sid.
      const expected = str(payload.client_state);
      const state = decodeClientState(expected);
      return Boolean(str(payload.call_control_id) && payload.call_control_id !== parts[1] && expected &&
        expected === event.rawClientState && state?.sid === sessionId && state.intent === contactOperationIntent(command.commandId));
    }
  }
  if (parts.length === 1 && parts[0] === "conferences" && event.type === "conference.created") {
    return Boolean(event.conferenceId && event.callControlId && payload.call_control_id === event.callControlId && str(payload.name));
  }
  if (parts.length === 4 && parts[0] === "conferences" && parts[2] === "actions" && parts[1] === event.conferenceId && payload.call_control_id === event.callControlId && event.callControlId) {
    return parts[3] === "join" && event.type === "conference.participant.joined" || parts[3] === "leave" && event.type === "conference.participant.left";
  }
  // A saved recording does not prove recording is still active. Media, role
  // changes, transfer and recording require their own stronger observations.
  return false;
}

/** Called only after signature/connection verification and exact session resolution,
 * under the current owner, BEFORE pending-effect replay. It never sends a POST.
 */
export async function reconcileProviderEvent(admin: SupabaseClient<Database>, sessionId: string, event: TelephonyEvent,
  telnyx?: Pick<TelnyxClient, "request"> | null): Promise<number> {
  const owner = sessionOwnership.getStore();
  if (owner?.contract !== 2 || owner.sessionId !== sessionId || !ELIGIBLE.has(event.type)) return 0;
  const pending = await ownershipRpc<PendingProviderCommand[]>(admin, "motorist_provider_pending_commands_v2", { p_session_id: sessionId });
  const candidates = pending.filter(command => commandEvidenceCandidate(command, sessionId, event));
  // A later join/answer event cannot distinguish two earlier unknown attempts.
  if (candidates.length !== 1) return 0;
  const command = candidates[0];
  let result: Record<string, unknown> = { data: { result: "ok" } };
  if (command.path === "/conferences") {
    if (!telnyx || !event.conferenceId) return 0;
    // conference.created has no name. Verify this exact ID/name via one GET;
    // creator-leg equality was checked above. No name-only lookup or new create.
    const response = await telnyx.request<unknown>("GET", `/conferences/${encodeURIComponent(event.conferenceId)}`);
    const conference = record(record(response).data);
    if (conference.id !== event.conferenceId || conference.name !== command.payload.name) return 0;
    result = { data: { id: event.conferenceId, name: conference.name } };
  }
  const changed = await ownershipRpc<boolean>(admin, "motorist_provider_command_result_v2", {
    p_session_id: sessionId, p_command_id: command.commandId, p_fingerprint: command.fingerprint,
    p_generation: command.dispatchGeneration, p_token: command.dispatchToken, p_status: 200, p_result: result,
  });
  return changed ? 1 : 0;
}
