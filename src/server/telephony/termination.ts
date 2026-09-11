import { ownershipRpc } from "./ownership";
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
  const completed: string[] = [];
  for (const leg of legs) {
    try {
      if (!deps.telnyx) throw new Error("Provider unavailable");
      await deps.telnyx.hangup({ callControlId: leg.callControlId,
        commandId: commandId({ sessionId, legId: leg.callControlId, step: leg.commandId, intent: "termination-compensation" }) });
      completed.push(leg.commandId);
    } catch (error) {
      if (error instanceof SessionLeaseLostError) throw error;
      if (isCallGoneError(error)) completed.push(leg.commandId);
      else deps.logger?.({ level: "warn", scope: "termination", sessionId, code: "termination_leg_outcome_pending" });
    }
  }
  const result = await ownershipRpc<{ pending: boolean }>(deps.admin, "motorist_provider_termination_checkpoint_v2",
    { p_session_id: sessionId, p_completed_commands: completed });
  return result.pending;
}
