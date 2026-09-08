import { CoordinatedWebphone } from "../../src/lib/telephony/coordinated-webphone";
import { TelnyxWebphone, type WebphoneSdkCall, type WebphoneSdkClient } from "../../src/lib/telephony/telnyx-webphone";
import { BrowserIncomingRingtone } from "../../src/lib/telephony/browser-ringtone";
import { TelnyxRTC } from "./mobile-calling-sdk";

const events: string[] = [];
let emit: (event: string, payload: unknown) => void;
let sound = false;
BrowserIncomingRingtone.prototype.start = async function () { sound = true; events.push("sound:start"); return true; };
BrowserIncomingRingtone.prototype.stop = function () { sound = false; events.push("sound:stop"); };
window.addEventListener("fixture-sdk-connected", ((event: CustomEvent) => { emit = event.detail; }) as EventListener);
const phone = new CoordinatedWebphone({ scope: "fixture:paused-operator", mobile: false,
  createPhone: options => new TelnyxWebphone({ ...options, createClient: () => new TelnyxRTC() as unknown as WebphoneSdkClient }),
});
const policy = () => phone.setIncomingOfferPolicy({ presenceRevision: 42, automaticAllowed: false });
policy(); phone.start();
Object.assign(window, { pickupTabs: {
  poll: policy,
  begin: () => phone.beginOperatorRequest(),
  finish: (id: string) => phone.endOperatorRequest(id),
  expected: (id: string) => phone.expectOperatorLeg({ callControlId: id, sessionId: "chosen-session" }),
  read: () => ({ events, sound, phone: phone.getSnapshot() }),
  invite(id: string) {
    const call: WebphoneSdkCall = {
      id, state: "ringing", direction: "inbound", options: {},
      telnyxIDs: { telnyxCallControlId: id, telnyxSessionId: "chosen-session", telnyxLegId: id }, isAudioMuted: false,
      answer() { events.push(`answer:${id}`); call.state = "active"; emit("telnyx.notification", { type: "callUpdate", call }); },
      hangup() { events.push(`hangup:${id}`); call.state = "hangup"; emit("telnyx.notification", { type: "callUpdate", call }); },
      muteAudio() {}, unmuteAudio() {}, dtmf() {},
    };
    emit("telnyx.notification", { type: "callUpdate", call });
  },
} });
