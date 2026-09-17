import { ownershipRpc, sessionOwnership } from "./ownership";
import type { SessionOwnershipDeps } from "./session-runner";
import { SessionLeaseLostError } from "./service-errors";
import { commandId } from "./telnyx/command-id";
import { isCallGoneError, type TelnyxClient } from "./telnyx/client";

/** Each late accepted leg is an independent cleanup obligation. One unknown
 * hangup must not block another leg or the provider fact that resolves it.
 */
export async function reconcileTermination(deps: SessionOwnershipDeps & { telnyx: TelnyxClient | null }, sessionId: string): Promise<boolean> {
  const legs = await ownershipRpc<Array<{ commandId: string; callControlId: string }>>(deps.admin,
    "motorist_provider_termination_legs_v2", { p_session_id: sessionId });
  const hangup = async (leg: { commandId: string; callControlId: string }) => {
    if (!deps.telnyx) throw new Error("Provider unavailable");
    await deps.telnyx.hangup({ callControlId: leg.callControlId,
      commandId: commandId({ sessionId, legId: leg.callControlId, step: leg.commandId, intent: "termination-compensation" }) });
  };
  const completed: string[] = [];
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
    const settled = await Promise.allSettled(legs.map(hangup));
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") { settle(legs[index], null); continue; }
      if (result.reason instanceof SessionLeaseLostError) throw result.reason;
      settle(legs[index], result.reason);
    }
  } else {
    for (const leg of legs) {
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
