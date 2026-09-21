import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { CaseCollaborationProvider, useCaseCollaboration, useCaseCollaborationStore } from "../../src/components/dispatch/CaseCollaborationProvider";
import { CaseSyncIndicator } from "../../src/components/dispatch/CaseSyncIndicator";
import { useTelephonyConsole } from "../../src/components/dispatch/useTelephonyConsole";
import { PhoneBar } from "../../src/components/dispatch/PhoneBar";
import { EMPTY_ACTIVE_CALLS } from "../../src/lib/telephony/active-calls-model";
import { collaborationCard } from "./case-collaboration-data";

const initialCases = [collaborationCard];
let emit: (event: string, payload?: unknown) => void = () => {};
const ledger: Array<{ url: string; method: string; at: number }> = [];
const harness = {
  ledger, unexpected: [] as string[], sdkCreated: 0, sdkConnected: 0, sdkLogin: 0, sdkDisconnected: 0,
  sdkAnswers: 0, sdkHangups: 0, microphoneRequests: 0, stoppedTracks: 0, mounts: 0, cleanups: 0,
  answeredIds: [] as string[], hungUpIds: [] as string[],
  caseReads: 0, revision: 1, caseDelay: 0, caseFailure: false, lastClick: 0, samples: [] as number[],
  refreshCases: () => {}, setBarsHeight: (height: number) => { void height; },
  callState: (state: "ringing" | "active" | "hangup", id = "fixture-incoming") => emit("telnyx.notification", { type: "callUpdate", call: {
    id, state, direction: "inbound", options: { remoteCallerNumber: "+421900000002" }, telnyxIDs: { telnyxCallControlId: `control-${id}` },
    localStream: mediaStream, remoteStream: mediaStream, isAudioMuted: false,
    answer() { harness.sdkAnswers++; harness.answeredIds.push(id); if (harness.lastClick) harness.samples.push(performance.now() - harness.lastClick); return navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(() => undefined); },
    hangup() { harness.sdkHangups++; harness.hungUpIds.push(id); }, muteAudio() {}, unmuteAudio() {}, dtmf() {},
  } }),
};
const track = { readyState: "live", stop: () => { harness.stoppedTracks++; } };
const mediaStream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] } as unknown as MediaStream;
declare global { interface Window { syncPhoneHarness: typeof harness } }
window.syncPhoneHarness = harness;
window.addEventListener("fixture-sdk-created", () => { harness.sdkCreated++; });
window.addEventListener("fixture-sdk-connected", ((event: CustomEvent) => { harness.sdkConnected++; emit = event.detail; }) as EventListener);
window.addEventListener("fixture-sdk-login", () => { harness.sdkLogin++; });
window.addEventListener("fixture-sdk-disconnected", () => { harness.sdkDisconnected++; });
document.addEventListener("click", event => { if ((event.target as HTMLElement).closest("button")?.textContent?.trim() === "Prijať") harness.lastClick = performance.now(); }, true);
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => { harness.microphoneRequests++; return mediaStream; } } });

window.fetch = async (input, init) => {
  const url = String(input), method = init?.method ?? "GET";
  ledger.push({ url, method, at: Date.now() });
  if (url === "/api/cases/live" && method === "POST") {
    harness.caseReads++;
    if (harness.caseDelay) await new Promise(resolve => setTimeout(resolve, harness.caseDelay));
    if (harness.caseFailure) return Response.json({ error: "Isolated failure" }, { status: 503 });
    const card = { ...collaborationCard, mainNote: `Saved revision ${harness.revision}`, updatedAt: new Date(1_800_000_000_000 + harness.revision).toISOString() };
    return Response.json({ available: true, ids: [card.id], changes: [card], versions: { [card.id]: harness.revision }, notifications: [], editors: [], more: false });
  }
  if (url === "/api/telephony/webphone/token" && method === "POST") return Response.json({ token: "fixture-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), deviceSessionId: "fixture-device", sipUsername: "fixture" });
  if (url === "/api/telephony/calls/active" && method === "GET") return Response.json({ ...EMPTY_ACTIVE_CALLS, organizationId: "fixture-org", actorProfileId: "fixture-operator", calls: [], ownPresence: { status: "available", pauseReasonId: null, statusSince: new Date().toISOString() } });
  if (url === "/api/telephony/presence" && method === "GET") return Response.json({ own: { status: "available" }, pauseReasons: [] });
  if (url === "/api/telephony/devices/heartbeat" && method === "POST") return Response.json({ ok: true });
  harness.unexpected.push(`${method} ${url}`);
  throw new Error(`Unexpected fixture request: ${method} ${url}`);
};

function SyncControls() {
  const store = useCaseCollaborationStore();
  const { state } = useCaseCollaboration();
  useEffect(() => { harness.refreshCases = () => store?.resume(); }, [store]);
  return <output id="case-state" data-hidden={String(state.hidden)}>{state.cases[0]?.mainNote ?? "No card"}</output>;
}
function PhoneWorkspace() {
  const topBarsRef = useRef<HTMLDivElement>(null), spacer = useRef<HTMLDivElement>(null);
  const telephony = useTelephonyConsole({ enabled: true, operators: [], profileId: "00000000-0000-4000-8000-000000000101" });
  useEffect(() => { harness.mounts++; return () => { harness.cleanups++; }; }, []);
  useEffect(() => { harness.setBarsHeight = height => { if (spacer.current) spacer.current.style.height = `${height}px`; }; }, []);
  return <>
    <div ref={topBarsRef} data-testid="fixture-top-bars">
      <header style={{ height: 56, display: "flex", alignItems: "center", padding: "0 16px", gap: 12, background: "#fcfcfd" }}><strong>Pomoc motoristom</strong><CaseSyncIndicator topBarsRef={topBarsRef} /></header>
      <PhoneBar model={telephony.phoneBar} phone={telephony.phone} degradedSessionIds={telephony.degradedSessionIds}
        busyAction={telephony.busyAction} notice={telephony.notice} onDismissNotice={telephony.dismissNotice}
        onCallAction={telephony.callAction} onPartyAction={telephony.partyAction} canSupervise={false}
        onSupervise={telephony.supervise} onStopSupervise={telephony.stopSupervise} onAnswer={telephony.answer}
        onHangupBrowser={telephony.hangupBrowser} onToggleMute={telephony.toggleMute} onDtmf={telephony.sendDtmf}
        onNewCase={() => {}} onLinkCase={() => {}} onOpenCase={() => {}} />
      <div ref={spacer} />
    </div>
    <output id="phone-state" data-status={telephony.phone.status} data-stale={String(telephony.stale)} data-call={telephony.phone.call?.id ?? ""} data-ringing={String(telephony.phone.call?.ringing ?? false)} />
    <SyncControls />
    <label>Rozpracovaná poznámka<input id="dirty-note" defaultValue="Rozpísané" /></label>
  </>;
}
createRoot(document.getElementById("root")!).render(<CaseCollaborationProvider actorKey="fixture-org:fixture-operator" enabled viewerProfileId="fixture-operator" initialCases={initialCases}><PhoneWorkspace /></CaseCollaborationProvider>);
