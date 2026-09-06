import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CallNotificationFocus } from "../../src/components/dispatch/CallNotificationFocus";
import { buildPhoneBarModel, EMPTY_ACTIVE_CALLS, type PhoneBarCall } from "../../src/lib/telephony/active-calls-model";
import type { WebphoneSnapshot } from "../../src/lib/telephony/telnyx-webphone";

export type CallPushScenario = "waiting" | "incoming" | "taken" | "ended" | "stale" | "other-call";
declare global { interface Window { callPushScenario: (value: CallPushScenario) => void; callPushEvents: string[] } }
export const sessionId = "4d821f21-cf1c-4a12-aa04-36f64c3eab96";
const focus = { sessionId, snapshotAtOpen: "old-snapshot" };
const call: PhoneBarCall = {
  sessionId, callId: null, browserCallControlIds: ["own-operator-leg"], kind: "waiting", state: "waiting", direction: "inbound",
  lineLabel: "Linka pomoci", partnerName: null, number: "+421900000001", callerName: "Peter Novák", caseId: null, match: null, matchCount: 0,
  timerSince: "2026-09-06T10:00:00Z", answered: false, held: false, parked: false, consulting: false, conference: false, mine: false,
  operatorProfileId: null, operatorName: null, offeredProfileIds: [], offeredOperatorNames: [], offeredToMe: false, participants: [],
};
const phone: WebphoneSnapshot = {
  status: "registered", registration: { status: "registered", label: "Pripojené", detail: "", tone: "ok" },
  sipUsername: null, deviceSessionId: null, call: null, message: null,
};
window.callPushEvents = [];
const record = (event: string) => window.callPushEvents.push(event);

function Fixture() {
  const [scenario, setScenario] = useState<CallPushScenario>("waiting");
  useEffect(() => { window.callPushScenario = setScenario; }, []);
  const incoming = scenario === "incoming" || scenario === "other-call";
  const currentCall = incoming ? { ...call, kind: "offer" as const, state: "ringing" as const, offeredToMe: true }
    : scenario === "taken" ? { ...call, kind: "active" as const, state: "talking" as const, operatorName: "Jana" } : call;
  return <main className="min-h-dvh bg-zinc-50 p-3">
    <CallNotificationFocus
      focus={focus}
      model={{ ...buildPhoneBarModel(EMPTY_ACTIVE_CALLS), checkedAt: "fresh-snapshot", configured: true, ownPresenceStatus: "available", teamCalls: scenario === "ended" ? [] : [currentCall] }}
      phone={{ ...phone, call: incoming ? {
        id: "browser-call", state: "ringing", direction: "inbound", number: call.number, callerName: call.callerName,
        telnyxCallControlId: scenario === "other-call" ? "another-leg" : "own-operator-leg", sessionId: null,
        muted: false, active: false, ringing: true,
      } : null }}
      configured={true} stale={scenario === "stale"} busy={false} outboundPending={false}
      onRefresh={() => record("refresh")} onDismiss={() => record("dismiss")}
      onReconnect={() => record("reconnect")} onAnswer={() => record("answer")}
      onPickup={(id) => record(`pickup:${id}`)}
    />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
