import "server-only";
import { after } from "next/server";
import type { MotoristActor } from "@/server/api-auth";
import { withBackgroundRequestMetrics } from "@/server/request-metrics";
import { continueAcceptedHangup, hangupCall } from "@/server/telephony/call-actions";
import { sessionOwnership } from "@/server/telephony/ownership";
import { toCallActor, type TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import type { SessionRow } from "@/server/telephony/state/types";

/** Caller must first pass requireNativeSession for this exact current endpoint. */
export async function finishNativeHangup(
  deps: TelephonyRuntimeDeps, actor: MotoristActor, session: Pick<SessionRow, "id" | "ended_at">, deadline: number,
) {
  if (session.ended_at) return { sessionId: session.id, terminationPending: false };
  const result = await hangupCall(deps, toCallActor(actor), session.id);
  if (result.terminationPending) {
    after(withBackgroundRequestMetrics(() => sessionOwnership.exit(async () => {
      try { await continueAcceptedHangup(deps, session.id, deadline); }
      catch { /* Existing webhook/cron recovery retains durable pending effects. */ }
    })));
  }
  return { sessionId: session.id, terminationPending: result.terminationPending === true };
}
