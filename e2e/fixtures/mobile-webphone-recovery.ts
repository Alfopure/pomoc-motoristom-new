import { CoordinatedWebphone } from "../../src/lib/telephony/coordinated-webphone";
import { TelnyxWebphone, type WebphoneSdkCall, type WebphoneSdkClient } from "../../src/lib/telephony/telnyx-webphone";
import { TelnyxRTC } from "./mobile-calling-sdk";

let emit: (event: string, payload?: unknown) => void = () => {};
let call: WebphoneSdkCall | null = null;
let retiredCall: WebphoneSdkCall | null = null;
let pendingLogin: { resolve(): void; reject(error: unknown): void } | null = null;
const events: string[] = [];
const loginTokens: string[] = [];
let holdLogin = false;
window.addEventListener("fixture-sdk-created", () => events.push("sdk:create"));
window.addEventListener("fixture-sdk-disconnected", () => events.push("sdk:disconnect"));
window.addEventListener("fixture-sdk-connected", ((event: CustomEvent) => {
  emit = event.detail;
  events.push("sdk:connect");
}) as EventListener);
window.addEventListener("fixture-sdk-login", ((event: CustomEvent) => {
  loginTokens.push(event.detail.token);
  if (holdLogin) { event.preventDefault(); pendingLogin = event.detail; }
}) as EventListener);

const phone = new CoordinatedWebphone({ scope: "isolated-mobile", mobile: true,
  createPhone: options => new TelnyxWebphone({ ...options, silent: true,
    createClient: credentials => new TelnyxRTC({ login_token: credentials.token }) as unknown as WebphoneSdkClient,
  }),
});
phone.start();
const harness = {
  events, loginTokens,
  snapshot: () => phone.getSnapshot(),
  prepare: async () => { try { await phone.prepareForCall(); } finally { phone.finishRequest(); } },
  stop: () => phone.dispose(),
  holdLogin: () => { holdLogin = true; },
  finishLogin: () => { holdLogin = false; pendingLogin?.resolve(); pendingLogin = null; },
  emit: (event: string, payload?: unknown) => emit(event, payload),
  recoverCall: () => {
    if (!call) throw new Error("A call must exist before it can recover.");
    retiredCall = call;
    call = { ...call, recoveredCallId: call.id, state: "answering" };
    emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    emit("telnyx.notification", { type: "callUpdate", call });
  },
  lateRetiredHangup: () => {
    if (!retiredCall) throw new Error("No retired call exists.");
    retiredCall.state = "hangup";
    emit("telnyx.notification", { type: "callUpdate", call: retiredCall });
  },
  callState: (state: "active" | "hangup" | "recovering", id = "mobile-call") => {
    if (!call || call.id !== id) call = {
      id, state, direction: "inbound", options: {}, isAudioMuted: false,
      telnyxIDs: { telnyxCallControlId: id, telnyxSessionId: "mobile-session", telnyxLegId: id },
      answer() { events.push("call:answer"); }, hangup() { events.push("call:hangup"); },
      muteAudio() {}, unmuteAudio() {}, dtmf() {},
    };
    call.state = state;
    emit("telnyx.notification", { type: "callUpdate", call });
  },
};
declare global { interface Window { mobileRecovery: typeof harness } }
window.mobileRecovery = harness;
