import "./mobile-calling-hook";
import { telephonyFetch, telephonyJson } from "../../src/lib/telephony/client-request";

// Navigation in the sampling loop exercises pagehide. Stub its beacon too:
// replacing fetch alone does not intercept navigator.sendBeacon.
Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => true });

// Extend the existing isolated hook fixture without changing its normal behavior.
// No real SDK socket, microphone or API call can escape this fixture.
const originalFetch = window.fetch;
const starts: Array<{ body: string; signal: AbortSignal | null | undefined; reject: (error: Error) => void }> = [];
window.fetch = (input, init) => {
  const pending = originalFetch(input, init);
  const isStart = String(input) === "/api/telephony/calls" || /\/callbacks\/[^/]+\/call$/.test(String(input));
  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(new DOMException("Fixture request aborted", "AbortError"));
    if (isStart) starts.push({ body: String(init?.body), signal: init?.signal, reject });
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => init?.signal?.removeEventListener("abort", abort));
  });
};

let emit: (event: string, payload: unknown) => void = () => {};
window.addEventListener("fixture-sdk-connected", ((event: CustomEvent) => { emit = event.detail; }) as EventListener);
const qa = {
  starts,
  telephonyFetch,
  telephonyJson,
  clickFeedback: Promise.resolve(0),
  sdkState(state: string, id = "fixture-incoming") {
    emit("telnyx.notification", { type: "callUpdate", call: {
      id, state, direction: "inbound", options: { remoteCallerNumber: "+421900000002" },
      telnyxIDs: { telnyxCallControlId: "incoming-leg" }, isAudioMuted: false,
      answer() { window.phoneHarness.sdkAnswers++; }, hangup() { window.phoneHarness.sdkHangups++; },
      muteAudio() {}, unmuteAudio() {}, dtmf() {},
    } });
  },
  measures() {
    return performance.getEntriesByType("measure").filter((entry) => entry.name.startsWith("motorist.call.")).map((entry) => ({
      name: entry.name, duration: entry.duration, startTime: entry.startTime, detail: (entry as PerformanceMeasure).detail,
    }));
  },
};
declare global { interface Window { telephonyQa: typeof qa } }
window.telephonyQa = qa;
