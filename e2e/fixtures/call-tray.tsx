import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PhoneBar } from "../../src/components/dispatch/PhoneBar";
import { buildPhoneBarModel, EMPTY_ACTIVE_CALLS, type PhoneBarCall } from "../../src/lib/telephony/active-calls-model";
import type { WebphoneSnapshot } from "../../src/lib/telephony/telnyx-webphone";

type Scenario = { offers: number; own?: boolean; selected?: number; phase?: "ringing" | "waiting" | "colleague" | "ivr" };
declare global { interface Window { trayScenario: (scenario: Scenario) => void; trayEvents: string[] } }
const base = buildPhoneBarModel(EMPTY_ACTIVE_CALLS);
function row(i: number): PhoneBarCall { return { sessionId: `session-${i}`, callId: null, kind: "offer", state: "ringing", direction: "inbound", lineLabel: "Hlavná linka", partnerName: null, number: `+42190000000${i}`, callerName: `Volajúci ${i}`, caseId: null, match: null, matchCount: 0, participants: [], timerSince: "2026-09-19T10:00:00Z", startedAt: "2026-09-19T10:00:00Z", answered: false, held: false, parked: false, consulting: false, conference: false, mine: false, operatorProfileId: null, operatorName: null, offeredProfileIds: ["me"], offeredOperatorNames: ["Jana"], offeredToMe: true, browserIncomingCallControlIds: [`control-${i}`], browserCallControlIds: [`control-${i}`] }; }
const phoneBase: WebphoneSnapshot = { status: "registered", registration: { status: "registered", label: "Pripojené", tone: "ok", detail: "Fixture" }, sipUsername: null, deviceSessionId: null, message: null, call: null };
window.trayEvents = [];
const noop = () => {};
function Fixture() {
  const [scenario, setScenario] = useState<Scenario>({ offers: 0 });
  useEffect(() => { window.trayScenario = setScenario; }, []);
  const offers = Array.from({ length: scenario.offers }, (_, i) => row(i));
  const selected = scenario.selected ?? 0;
  if (offers[selected]) {
    if (scenario.phase === "waiting") { offers[selected].kind = "waiting"; offers[selected].state = "waiting"; }
    if (scenario.phase === "colleague") { offers[selected].kind = "active"; offers[selected].state = "talking"; offers[selected].operatorProfileId = "colleague"; }
    if (scenario.phase === "ivr") offers[selected].state = "ivr";
  }
  const own: PhoneBarCall | null = scenario.own ? { ...row(99), kind: "active", state: "talking", mine: true, answered: true, participants: [{ legId: "caller-leg", kind: "caller", profileId: null, name: "Volajúci", detail: null, answered: true, muted: false, supervisorMode: null, self: false, controllable: false }], operatorProfileId: "me", offeredToMe: false } : null;
  const browser = scenario.own ? own : offers[selected]?.state === "ringing" ? offers[selected] : null;
  const phone: WebphoneSnapshot = { ...phoneBase, call: browser ? { id: `browser-${browser.sessionId}`, sessionId: browser.sessionId, telnyxCallControlId: scenario.own ? "control-99" : `control-${selected}`, direction: "inbound", number: browser.number, callerName: browser.callerName, state: scenario.own ? "active" : "ringing", active: Boolean(scenario.own), ringing: !scenario.own, muted: false } : null };
  return <div className="min-h-screen bg-[#eff2f7]"><header className="h-14 border-b bg-white px-4 py-4 text-sm font-semibold">Pomoc motoristom · Ústredňa</header><PhoneBar model={{ ...base, configured: true, active: own, teamCalls: offers, offers, ownPresenceStatus: "available" }} phone={phone} degradedSessionIds={new Set()} busyAction={null} notice={null} onDismissNotice={noop} onCallAction={(action, id) => window.trayEvents.push(`${action}:${id}`)} onPartyAction={noop} canSupervise={false} onSupervise={noop} onStopSupervise={noop} onAnswer={() => window.trayEvents.push("unsafe-generic-answer")} onAnswerOffer={(session, leg) => window.trayEvents.push(`answer:${session}:${leg}`)} onRejectOfferIdentity={(session, leg) => window.trayEvents.push(`reject:${session}:${leg}`)} onHangupBrowser={noop} onToggleMute={noop} onDtmf={noop} onNewCase={noop} onLinkCase={noop} onOpenCase={noop} /><main className="p-4">Pracovná plocha</main></div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
