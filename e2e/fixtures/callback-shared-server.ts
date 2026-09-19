/** Real callback services + fake database/provider; no credentials or network. */
import { createTelephonyHarness, LINES, NUMBERS, PROFILES } from "../../src/test/telephony-harness";
import { callBackRequest, claimCallbackRequest, loadCallbackQueue, resolveCallbackRequest } from "../../src/server/telephony/callbacks";
import { createRateLimiter, type CallActor } from "../../src/server/telephony/call-actions";
import { resolveCallbackTarget } from "../../src/server/callback-targets";

export function createCallbackFixture() {
  const harness = createTelephonyHarness();
  const deps = { admin: harness.deps.admin, organizationId: harness.deps.organizationId, now: harness.deps.now, logger: harness.deps.logger };
  const actionDeps = { ...harness.deps, rateLimiter: createRateLimiter({ now: () => harness.now().getTime() }) };
  const actors: Record<string, CallActor> = {
    one: { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" },
    two: { profileId: PROFILES.o2, role: "dispatcher", displayName: "Peter" },
  };
  const ids = Array.from({ length: 125 }, (_, index) => {
    const created = new Date(harness.now().getTime() - (125 - index) * 1000).toISOString();
    return String(harness.db.insert("motorist_callback_requests", { organization_id: deps.organizationId, caller_number: NUMBERS.customer, caller_name: `Klient ${String(index + 1).padStart(3, "0")}`, source: index % 2 ? "manual" : "missed", status: "open", line_id: LINES.allianz, created_at: created, due_at: new Date(Date.parse(created) + 30 * 60_000).toISOString() })[0].id);
  });
  return {
    ids,
    rows: () => harness.rows("motorist_callback_requests"),
    providerCalls: () => harness.telnyx.of("dial").length,
    queue: (actor: string, cursor: string | null) => loadCallbackQueue(deps, actors[actor], { cursor }),
    target: (number: string) => resolveCallbackTarget(deps.admin, deps.organizationId, number),
    action: async (actor: string, id: string, action: string) => {
      if (action === "claim") return claimCallbackRequest(deps, actors[actor], id);
      if (action === "done" || action === "cancel") return resolveCallbackRequest(deps, actors[actor], id, { status: action === "done" ? "done" : "cancelled" });
      if (action === "call") {
        const result = await callBackRequest(actionDeps, actors[actor], id);
        // A provider failure after dial does not resolve the callback obligation.
        for (const leg of harness.legs(result.call.sessionId)) {
          if (leg.telnyx_call_control_id && !leg.ended_at) await harness.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
        }
        return result;
      }
      throw new Error("Unexpected action");
    },
  };
}
