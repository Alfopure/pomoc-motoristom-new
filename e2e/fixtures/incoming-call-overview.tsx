import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { HeaderLiveCallsMenu } from "../../src/components/dispatch/LiveCallOverview";
import { HeaderPhoneStatusMenu } from "../../src/components/dispatch/HeaderPhoneStatusMenu";
import { buildPhoneBarModel, EMPTY_ACTIVE_CALLS, type ActiveCallPayload } from "../../src/lib/telephony/active-calls-model";
import { webphoneRegistrationView } from "../../src/lib/telephony/webphone-model";
import type { WebphoneSnapshot } from "../../src/lib/telephony/telnyx-webphone";

const call: ActiveCallPayload = {
  sessionId: "incoming-session", callId: null, state: "ringing", direction: "inbound",
  callerNumber: "+421900000001", calledNumber: "+421900000002", lineId: null, lineLabel: "Testovacia linka",
  partnerName: null, caseId: null, match: null, startedAt: new Date().toISOString(), answeredAt: null,
  answeredByProfileId: null, holdStartedAt: null, parkedAt: null, parkedByProfileId: null,
  waitingSince: null, waitingReason: null, waitingMaxMinutes: null, currentStep: 1, ringMode: "plan",
  offeredProfileIds: [], mine: false, legs: [{
    id: "backup", role: "external", profileId: null, state: "ringing", toNumber: "+421900000003",
    fromNumber: null, answeredAt: null, bridgedAt: null, intent: "ring", muted: false, supervisorMode: null,
  }],
};

function Fixture() {
  const [scenario, setScenario] = useState("backup");
  const [events, setEvents] = useState<string[]>([]);
  const record = (event: string) => setEvents((all) => [...all, event]);
  const localInvite = scenario === "offers" || scenario === "answering";
  const ownOffer = localInvite || scenario === "own-offer-recovery" || scenario === "other-offer-recovery";
  const incoming = ownOffer ? { ...call, offeredProfileIds: ["me"], legs: [{ ...call.legs[0], id: "my-leg", role: "operator" as const, profileId: "me", callControlId: "my-invite" }] } : call;
  const model = buildPhoneBarModel({
    ...EMPTY_ACTIVE_CALLS, configured: true, actorProfileId: "me",
    calls: localInvite ? [{ ...incoming, sessionId: "stale-session", callerNumber: "+421900000004", legs: [] }, incoming] : [incoming],
    presence: { actorProfileId: "me", checkedAt: "", canManageAssignments: true, devices: [], presence: [{ profileId: "me", status: ownOffer ? "ringing" : "available", currentSessionId: scenario === "other-offer-recovery" ? "other-session" : ownOffer ? call.sessionId : null }] },
  }, { operatorName: () => "Operátor" });
  const status = scenario === "other-device" ? "superseded" : "registered";
  const phone: WebphoneSnapshot = {
    status, message: null, registration: webphoneRegistrationView({ status, message: null }),
    call: localInvite ? {
      id: "browser-invite", state: "ringing", direction: "inbound", number: call.callerNumber!, callerName: null,
      telnyxCallControlId: "my-invite", sessionId: null, muted: false, ringing: true, active: false,
    } : null,
    answering: scenario === "answering", pendingOperatorLegs: scenario === "pending" ? 1 : 0,
    callError: null, audioBlocked: false, deviceSessionId: "fixture-device", sipUsername: "fixture",
  };
  return <>
    <label>Scenár <select aria-label="Scenár" value={scenario} onChange={(event) => setScenario(event.target.value)}>
      {["backup", "offers", "answering", "other-device", "pending", "own-offer-recovery", "other-offer-recovery"].map((value) => <option key={value}>{value}</option>)}
    </select></label>
    <HeaderPhoneStatusMenu busy={false} onChange={() => {}} onRequestPause={() => {}} onDismissNotice={() => {}}
      onTakeover={() => record("takeover")} notice={scenario === "other-device" ? "Stará chyba hovoru" : null}
      phone={phone} status={model.ownPresenceStatus} readiness={{ status: "ready", message: null }}
      onPreparePhone={async () => true} outboundPending={false} />
    <HeaderLiveCallsMenu model={model} presences={[]} canManageCalls busyAction={null} phone={phone}
      onAnswer={() => record("answer")} onRejectOffer={() => record("reject")}
      onCallAction={(action, sessionId) => record(`${action}:${sessionId}`)}
      onSupervise={() => {}} onStopSupervise={() => {}} />
    <output aria-label="Akcie">{events.join(",")}</output>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
