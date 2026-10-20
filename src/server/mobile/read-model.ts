import "server-only";

import type { CallCenterCall } from "@/data/dispatch-types";
import type { MobileActiveCall, MobileHistoryCall } from "@/lib/mobile-api";
import type { ActiveCallView } from "@/server/telephony/active-calls";

export function mobileActiveCall(call: ActiveCallView): MobileActiveCall {
  return {
    id: call.sessionId, direction: call.direction, state: call.state,
    number: call.direction === "outbound" ? call.calledNumber : call.callerNumber,
    name: call.partnerName, contactName: call.contactName ?? null, lineLabel: call.lineLabel, startedAt: call.startedAt,
  };
}
/** Allowlist fields; never serialize provider IDs, recordings, case notes or events. */
export function mobileHistoryCall(call: CallCenterCall): MobileHistoryCall {
  return {
    id: call.id, direction: call.direction, status: call.status,
    number: call.direction === "outbound" ? call.destinationNumber || call.calledNumber || null : call.callerNumber || null,
    name: call.direction === "internal" ? call.colleagueName ?? call.callerName ?? null : call.callerName ?? null,
    lineLabel: call.lineLabel, operatorName: call.operatorName ?? null, startedAt: call.startedAt,
    answeredAt: call.answeredAt ?? null, endedAt: call.endedAt ?? null,
    durationSeconds: typeof call.durationSeconds === "number" && Number.isFinite(call.durationSeconds) && call.durationSeconds >= 0 ? call.durationSeconds : null,
    callback: call.callback && ["open", "scheduled", "done", "cancelled"].includes(call.callback.status)
      ? { status: call.callback.status, claimedByName: typeof call.callback.claimedByName === "string" && call.callback.claimedByName.trim() ? call.callback.claimedByName.trim().slice(0, 200) : null }
      : null,
  };
}
