import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { ownershipRpc, sessionOwnership } from "./ownership";
import type { SessionOwnershipDeps } from "./session-runner";
import { SessionLeaseLostError } from "./service-errors";
import { commandId } from "./telnyx/command-id";
import { isCallGoneError, type TelnyxClient } from "./telnyx/client";

type TerminationLeg = { commandId: string; callControlId: string };

/**
 * The fenced provider journal (migration `20260929200000:189-206`) is written
 * only through its RPCs and is absent from the generated types; this is its
 * first app-side read. Same narrowing as `telephony-directory.ts`.
 */
type JournalDatabase = {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Database["public"]["Tables"] & {
      motorist_provider_commands: {
        Row: { session_id: string; command_id: string; path: string; outcome: string | null };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
  };
};

/** The journal path `TelnyxClient.hangup` writes for a leg (`telnyx/client.ts` `callAction`): `/calls/<encoded ccid>/actions/hangup`. */
const hangupPath = (callControlId: string) => `/calls/${encodeURIComponent(callControlId)}/actions/hangup`;

/**
 * Legs the provider itself has already ended: an accepted `/actions/hangup`
 * journal row for the leg (any issuer — the reducer's own `app_hangup`, an
 * offer cancellation, an earlier compensation) or a received `call.hangup`
 * ledger row for the exact call_control_id, whatever its processing status.
 * Never app-side `ended_at` (M19 fix lens): a synthetic close (`step_timeout`,
 * `orphan_sweep`, `stale_finalise`, `reconciled`) is not the provider speaking.
 * A failed read returns nothing, so the pass falls back to hanging up.
 */
async function providerEndedLegs(deps: SessionOwnershipDeps, sessionId: string, legs: readonly TerminationLeg[]): Promise<Set<string>> {
  const ended = new Set<string>();
  if (legs.length === 0) return ended;
  const ids = legs.map((leg) => leg.callControlId);
  const byPath = new Map(ids.map((id) => [hangupPath(id), id]));
  try {
    // The session's accepted hangup rows are a handful; matching the encoded
    // path in JS is cheaper than quoting `%`, `:` and `/` for a PostgREST list.
    const [journal, ledger] = await Promise.all([
      (deps.admin as unknown as SupabaseClient<JournalDatabase>).from("motorist_provider_commands").select("path")
        .eq("session_id", sessionId).eq("outcome", "accepted").like("path", "%/actions/hangup"),
      deps.admin.from("motorist_telnyx_webhook_events").select("call_control_id")
        .eq("organization_id", deps.organizationId).eq("event_type", "call.hangup").in("call_control_id", ids),
    ]);
    if (journal.error) throw new Error(`termination journal read failed: ${journal.error.message}`);
    if (ledger.error) throw new Error(`termination ledger read failed: ${ledger.error.message}`);
    for (const row of journal.data ?? []) {
      const id = byPath.get(row.path);
      if (id) ended.add(id);
    }
    for (const row of ledger.data ?? []) {
      if (row.call_control_id && byPath.has(hangupPath(row.call_control_id))) ended.add(row.call_control_id);
    }
  } catch (error) {
    // Today's behaviour is the fallback: an unreadable evidence table must not
    // leave a leg ringing; the checkpoint still records what the hangups return.
    deps.logger?.({ level: "warn", scope: "termination", sessionId, code: "termination_evidence_unavailable",
      error: error instanceof Error ? error.message : String(error) });
    ended.clear();
  }
  return ended;
}

/** Each late accepted leg is an independent cleanup obligation. One unknown
 * hangup must not block another leg or the provider fact that resolves it.
 */
export async function reconcileTermination(deps: SessionOwnershipDeps & { telnyx: TelnyxClient | null }, sessionId: string): Promise<boolean> {
  const legs = await ownershipRpc<TerminationLeg[]>(deps.admin,
    "motorist_provider_termination_legs_v2", { p_session_id: sessionId });
  // Provider evidence only (M19): a leg Telnyx already reports as ended is a
  // completed obligation, not a command. 10 of the incident's 11 compensation
  // hangups hit legs ended > 5 s earlier and came back 422/90018.
  const providerEnded = await providerEndedLegs(deps, sessionId, legs);
  const completed: string[] = legs.filter((leg) => providerEnded.has(leg.callControlId)).map((leg) => leg.commandId);
  const outstanding: TerminationLeg[] = legs.filter((leg) => !providerEnded.has(leg.callControlId));
  if (completed.length) deps.logger?.({ scope: "termination", sessionId, code: "termination_legs_provider_ended", count: completed.length });
  const hangup = async (leg: TerminationLeg) => {
    if (!deps.telnyx) throw new Error("Provider unavailable");
    await deps.telnyx.hangup({ callControlId: leg.callControlId,
      commandId: commandId({ sessionId, legId: leg.callControlId, step: leg.commandId, intent: "termination-compensation" }) });
  };
  const settle = (leg: { commandId: string }, error: unknown) => {
    if (error === null) { completed.push(leg.commandId); return; }
    if (isCallGoneError(error)) completed.push(leg.commandId);
    else deps.logger?.({ level: "warn", scope: "termination", sessionId, code: "termination_leg_outcome_pending" });
  };
  // Under contract 2 the legs go out together: the customer's leg does not wait
  // for an operator leg whose outcome is still unknown. Losing the lease
  // mid-flight is safe there because `prepare_v2` fences every command on its
  // own generation, so a command from a lease we no longer hold never reaches
  // the provider. Contract 1 has no journal to fence it, so it stops instead.
  if (sessionOwnership.getStore()?.contract === 2) {
    const settled = await Promise.allSettled(outstanding.map(hangup));
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") { settle(outstanding[index], null); continue; }
      if (result.reason instanceof SessionLeaseLostError) throw result.reason;
      settle(outstanding[index], result.reason);
    }
  } else {
    for (const leg of outstanding) {
      try { await hangup(leg); settle(leg, null); }
      catch (error) {
        if (error instanceof SessionLeaseLostError) throw error;
        settle(leg, error);
      }
    }
  }
  const result = await ownershipRpc<{ pending: boolean }>(deps.admin, "motorist_provider_termination_checkpoint_v2",
    { p_session_id: sessionId, p_completed_commands: completed });
  return result.pending;
}
