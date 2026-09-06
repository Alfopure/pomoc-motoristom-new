import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useTelephonyConsole } from "../../src/components/dispatch/useTelephonyConsole";
import { EMPTY_ACTIVE_CALLS } from "../../src/lib/telephony/active-calls-model";

type Request = { url: string; resolve: (response: Response) => void };
const requests: Request[] = [];
const outcomes: string[] = [];
let emit: (event: string, payload?: unknown) => void = () => {};
window.addEventListener("fixture-sdk-connected", ((event: CustomEvent) => { emit = event.detail; }) as EventListener);

const harness = {
  requests, outcomes,
  microphoneRequests: 0,
  stoppedTracks: 0,
  grant: () => {},
  deny: () => {},
  begin: (kind: "dial" | "callback" | "pickup" | "supervise") => { throw new Error(`Fixture is not mounted: ${kind}`); },
  prepare: () => {},
  incoming: () => emit("telnyx.notification", { type: "callUpdate", call: {
    id: "fixture-incoming", state: "ringing", direction: "inbound",
    options: { remoteCallerNumber: "+421900000002" }, telnyxIDs: { telnyxCallControlId: "incoming-leg" },
    isAudioMuted: false, answer() {}, hangup() {}, muteAudio() {}, unmuteAudio() {}, dtmf() {},
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

window.fetch = async (input) => {
  const url = String(input);
  if (url === "/api/telephony/calls" || /\/api\/telephony\/callbacks\/[^/]+\/call$/.test(url) || /\/api\/telephony\/calls\/[^/]+\/(pickup|supervise)$/.test(url)) {
    return new Promise<Response>((resolve) => requests.push({ url, resolve }));
  }
  if (url === "/api/telephony/webphone/token") return Response.json({ token: "fixture-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), deviceSessionId: "fixture-device", sipUsername: "fixture" });
  if (url === "/api/telephony/calls/active") return Response.json(EMPTY_ACTIVE_CALLS);
  if (url.includes("/presence")) return Response.json({ own: { status: "available" }, pauseReasons: [] });
  return Response.json({});
};

function Fixture() {
  const telephony = useTelephonyConsole({ enabled: true, operators: [] });
  useEffect(() => {
    harness.begin = (kind) => {
      const action = kind === "dial" ? telephony.dial("+421900000001") : kind === "callback" ? telephony.callBackRequest("fixture") : kind === "pickup" ? telephony.callAction("pickup", "fixture") : telephony.supervise("fixture", "monitor");
      void action.then(() => outcomes.push("ok"), (error: Error) => outcomes.push(error.message));
    };
    harness.prepare = () => { void telephony.preparePhone(); };
  }, [telephony]);
  return <output id="state" data-pending={String(telephony.outboundPending)} data-legs={telephony.phone.pendingOperatorLegs ?? 0} data-status={telephony.phone.status} data-readiness={telephony.readiness.status} data-ringing={String(telephony.phone.call?.ringing ?? false)}>{telephony.notice ?? telephony.readiness.message}</output>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
