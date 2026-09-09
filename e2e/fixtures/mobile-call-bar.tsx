import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PhoneBar } from "../../src/components/dispatch/PhoneBar";
import type { PhoneBarCall, PhoneBarModel } from "../../src/lib/telephony/active-calls-model";
import type { WebphoneSnapshot } from "../../src/lib/telephony/telnyx-webphone";

export type CallBarScenario = "incoming" | "offer" | "answering" | "raw-active" | "active" | "blocked-audio" | "pending" | "stale-server";
declare global {
  interface Window {
    callBarScenario: (scenario: CallBarScenario) => void;
    callBarEvents: string[];
  }
}

const call: PhoneBarCall = {
  sessionId: "fixture-session", callId: "fixture-call", kind: "active", state: "talking", direction: "inbound",
  lineLabel: "Allianz Assistance", partnerName: "Allianz", number: "+421900111222", callerName: "Peter Novák",
  caseId: "fixture-case", match: null, matchCount: 0, participants: [], timerSince: new Date().toISOString(),
  answered: true, held: false, parked: false, consulting: false, conference: false, mine: true,
  operatorProfileId: "fixture-operator", operatorName: "Operátor", offeredProfileIds: [], offeredOperatorNames: [], offeredToMe: false,
};
const model: PhoneBarModel = {
  checkedAt: new Date().toISOString(), configured: true, active: null, offers: [], waiting: [], otherActiveCount: 0,
  others: [], teamCalls: [], supervising: null, ownPresenceStatus: "available",
  presence: { actorProfileId: "fixture-operator", canManageAssignments: false, checkedAt: new Date().toISOString(), devices: [], presence: [] },
};
const phone: WebphoneSnapshot = {
  status: "registered", registration: { status: "registered", label: "Pripojené", tone: "ok", detail: "Fixture" },
  sipUsername: null, deviceSessionId: null, message: null,
  call: {
    id: "fixture-browser-call", state: "ringing", direction: "inbound", number: call.number, callerName: call.callerName,
    telnyxCallControlId: "fixture-control", sessionId: null, muted: false, ringing: true, active: false,
  },
};
window.callBarEvents = [];
const record = (event: string) => window.callBarEvents.push(event);

function Fixture() {
  const [scenario, setScenario] = useState<CallBarScenario>("incoming");
  useEffect(() => { window.callBarScenario = setScenario; }, []);
  const isActive = ["raw-active", "active", "blocked-audio"].includes(scenario);
  const hasServer = scenario === "active" || scenario === "blocked-audio";
  return (
    <div className="flex h-dvh flex-col bg-zinc-50" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <header className="flex h-11 shrink-0 items-center px-3 text-xs font-bold">Dispečing</header>
      <PhoneBar
        model={{ ...model, offers: scenario === "offer" ? [{ ...call, kind: "offer", state: "ringing", answered: false, browserCallControlIds: ["fixture-control"] }] : [], active: hasServer ? call : scenario === "stale-server" ? { ...call, callerName: "Stará zákazníčka", sessionId: "stale-session" } : null }}
        phone={{ ...phone, call: scenario === "pending" ? null : { ...phone.call!, sessionId: hasServer ? call.sessionId : null, ringing: !isActive, active: isActive, state: isActive ? "active" : "ringing" }, answering: scenario === "answering", audioBlocked: scenario === "blocked-audio" }}
        outboundPending={scenario === "pending"}
        degradedSessionIds={new Set()}
        busyAction={null}
        notice={null}
        onDismissNotice={() => record("dismiss")}
        onCallAction={(action, sessionId) => record(`server:${action}:${sessionId}`)}
        onPartyAction={() => record("party")}
        canSupervise={false}
        onSupervise={() => record("supervise")}
        onStopSupervise={() => record("stop-supervise")}
        onAnswer={() => record("answer")}
        onHangupBrowser={() => record("browser-hangup")}
        onToggleMute={() => record("mute")}
        onDtmf={(digit) => record(`dtmf:${digit}`)}
        onNewCase={() => record("new-case")}
        onLinkCase={() => record("link-case")}
        onOpenCase={(caseId) => record(`open:${caseId}`)}
        onResumeAudio={() => record("resume-audio")}
      />
      <main className="min-h-0 flex-1 p-3 text-xs">Obsah prípadu zostáva dostupný počas hovoru.</main>
      <nav aria-label="Mobilná navigácia" className="shrink-0 border-t bg-white px-3 text-xs" style={{ height: "calc(52px + env(safe-area-inset-bottom))", paddingBottom: "env(safe-area-inset-bottom)" }}>Prípady · Úlohy · Mapa · Menu</nav>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
