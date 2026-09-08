import { TelnyxWebphone, type WebphoneSdkCall, type WebphoneSdkClient } from "../../src/lib/telephony/telnyx-webphone";
import { BrowserIncomingRingtone } from "../../src/lib/telephony/browser-ringtone";
import { deriveTelephonyOperatorPresences } from "../../src/lib/telephony/presence";
import type { Operator } from "../../src/domain/types";
import { TelnyxRTC } from "./mobile-calling-sdk";

let emit: (event: string, payload: unknown) => void;
const events: string[] = [];
let sound = false;
BrowserIncomingRingtone.prototype.start = async function () { sound = true; events.push("sound:start"); return true; };
BrowserIncomingRingtone.prototype.stop = function () { sound = false; events.push("sound:stop"); };
window.addEventListener("fixture-sdk-connected", ((event: CustomEvent) => { emit = event.detail; }) as EventListener);
let phone: TelnyxWebphone;
let status: "available" | "paused" = "available";
function policy() { phone.setIncomingOfferPolicy({ automaticAllowed: status === "available" }); }
function start() {
  phone?.stop();
  phone = new TelnyxWebphone({ createClient: () => new TelnyxRTC() as unknown as WebphoneSdkClient });
  policy(); phone.start();
}
start();
const scenario = {
  pause() { status = "paused"; policy(); },
  restart() { start(); },
  pickup(id: string) { phone.expectOperatorLeg({ callControlId: id, sessionId: "selected-session" }); },
  invite(id: string, fail = false) {
    const call: WebphoneSdkCall = {
      id, state: "ringing", direction: "inbound", options: {},
      telnyxIDs: { telnyxCallControlId: id, telnyxSessionId: "session", telnyxLegId: id }, isAudioMuted: false,
      answer() { events.push(`answer:${id}`); call.state = "active"; },
      hangup() { events.push(`hangup:${id}`); if (fail) return Promise.reject(new Error("temporary")); call.state = "hangup"; },
      muteAudio() {}, unmuteAudio() {}, dtmf() {},
    };
    emit("telnyx.notification", { type: "callUpdate", call });
  },
  read() {
    const presences = deriveTelephonyOperatorPresences({ operators: [{ id: "me", name: "Test" } as Operator], snapshot: {
      actorProfileId: "me", canManageAssignments: false, checkedAt: new Date().toISOString(), devices: [{ profileId: "me", registered: true }], presence: [{ profileId: "me", status }],
    } });
    return { events, sound, status, ready: presences.filter((p) => p.available).length, phone: phone.getSnapshot() };
  },
};
Object.assign(window, { pauseScenario: scenario });
