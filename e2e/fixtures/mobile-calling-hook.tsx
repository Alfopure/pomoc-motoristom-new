import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useTelephonyConsole } from "../../src/components/dispatch/useTelephonyConsole";
import { EMPTY_ACTIVE_CALLS, type ActiveCallPayload } from "../../src/lib/telephony/active-calls-model";

type Request = { url: string; body?: string; resolve: (response: Response) => void };
const requests: Request[] = [];
const outcomes: string[] = [];
let emit: (event: string, payload?: unknown) => void = () => {};
window.addEventListener("fixture-sdk-connected", ((event: CustomEvent) => { emit = event.detail; }) as EventListener);

const harness = {
  requests, outcomes,
  activeReads: 0,
  microphoneRequests: 0,
  stoppedTracks: 0,
  sdkHangups: 0,
  calls: [] as ActiveCallPayload[],
  connected: () => {
    const now = new Date().toISOString();
    harness.calls = [{
      sessionId: "fixture", callId: "fixture-log", state: "talking", direction: "inbound",
      callerNumber: "+421900000002", calledNumber: "+421900000001", lineId: null,
      lineLabel: null, partnerName: null, caseId: null, match: null, startedAt: now,
      answeredAt: now, answeredByProfileId: "fixture-operator", holdStartedAt: null,
      parkedAt: null, parkedByProfileId: null, waitingSince: null, waitingReason: null,
      waitingMaxMinutes: null, currentStep: 0, ringMode: null, offeredProfileIds: [], mine: true,
      legs: [{ id: "fixture-leg", callControlId: "incoming-leg", role: "operator", profileId: "fixture-operator",
        state: "bridged", toNumber: null, fromNumber: null, answeredAt: now, bridgedAt: now,
        intent: "ring", muted: false, supervisorMode: null }],
    }];
    harness.callState("active");
  },
  grant: () => {},
  deny: () => {},
  begin: (kind: "dial" | "callback" | "pickup" | "supervise" | "hangup" | "hold"): void => { throw new Error(`Fixture is not mounted: ${kind}`); },
  prepare: () => {},
  incoming: () => harness.callState("ringing"),
  callState: (state: "ringing" | "active" | "hangup", id = "fixture-incoming") => emit("telnyx.notification", { type: "callUpdate", call: {
    id, state, direction: "inbound",
    options: { remoteCallerNumber: "+421900000002" }, telnyxIDs: { telnyxCallControlId: "incoming-leg" },
    isAudioMuted: false, answer() {}, hangup() { harness.sdkHangups++; }, muteAudio() {}, unmuteAudio() {}, dtmf() {},
  } }),
};
declare global { interface Window { phoneHarness: typeof harness } }
window.phoneHarness = harness;

Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
  getUserMedia: () => {
    harness.microphoneRequests++;
    return new Promise<MediaStream>((resolve, reject) => {
      harness.deny = () => reject(new DOMException("Fixture permission denied", "NotAllowedError"));
      harness.grant = () => {
        const track = { readyState: "live", stop: () => { harness.stoppedTracks++; } };
        resolve({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream);
      };
    });
  },
} });

window.fetch = async (input, init) => {
  const url = String(input);
  if (url === "/api/telephony/calls" || /\/api\/telephony\/callbacks\/[^/]+\/call$/.test(url) || /\/api\/telephony\/calls\/[^/]+\/(pickup|supervise|hangup|hold|reconcile)$/.test(url)) {
    return new Promise<Response>((resolve) => requests.push({ url, body: init?.body as string | undefined, resolve }));
  }
  if (url === "/api/telephony/webphone/token") return Response.json({ token: "fixture-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), deviceSessionId: "fixture-device", sipUsername: "fixture" });
  if (url === "/api/telephony/calls/active") { harness.activeReads++; return Response.json({ ...EMPTY_ACTIVE_CALLS, calls: harness.calls, organizationId: "fixture-org", actorProfileId: "fixture-operator", ownPresence: { status: "available", pauseReasonId: null, statusSince: new Date().toISOString() } }); }
  if (url.includes("/presence")) return Response.json({ own: { status: "available" }, pauseReasons: [] });
  return Response.json({});
};

function Fixture() {
  const telephony = useTelephonyConsole({ enabled: true, operators: [], profileId: "00000000-0000-4000-8000-000000000101" });
  useEffect(() => {
    harness.begin = (kind) => {
      const action = kind === "dial" ? telephony.dial("+421900000001") : kind === "callback" ? telephony.callBackRequest("fixture") : kind === "pickup" || kind === "hangup" || kind === "hold" ? telephony.callAction(kind, "fixture") : telephony.supervise("fixture", "monitor");
      void action.then(() => outcomes.push("ok"), (error: Error) => outcomes.push(error.message));
    };
    harness.prepare = () => { void telephony.preparePhone(); };
  }, [telephony]);
  return <output id="state" data-call={telephony.phone.call?.id ?? ""} data-server-call={telephony.phoneBar.active?.sessionId ?? ""} data-configured={String(telephony.configured)} data-pending={String(telephony.outboundPending)} data-legs={telephony.phone.pendingOperatorLegs ?? 0} data-status={telephony.phone.status} data-readiness={telephony.readiness.status} data-ringing={String(telephony.phone.call?.ringing ?? false)}>{telephony.notice ?? telephony.readiness.message}</output>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
