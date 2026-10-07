import "./mobile-calling-hook";
import { EMPTY_ACTIVE_CALLS, type ActiveCallsPayload } from "../../src/lib/telephony/active-calls-model";

type Read = { payload: ActiveCallsPayload; resolve: (response: Response) => void };
type Command = { url: string; resolve: (response: Response) => void; reject: (error: Error) => void };

const harness = {
  deferReads: false,
  reads: [] as Read[],
  commands: [] as Command[],
  snapshot: (): ActiveCallsPayload => ({
    ...EMPTY_ACTIVE_CALLS, configured: true, checkedAt: new Date().toISOString(),
    calls: structuredClone(window.phoneHarness.calls), organizationId: "fixture-org", actorProfileId: "fixture-operator",
    ownPresence: { status: "available", pauseReasonId: null, statusSince: new Date().toISOString() },
  }),
  refresh: () => document.dispatchEvent(new Event("visibilitychange")),
};
declare global { interface Window { hangupHarness: typeof harness } }
window.hangupHarness = harness;

const baseFetch = window.fetch;
window.fetch = async (input, init) => {
  const url = String(input);
  if (url === "/api/telephony/calls/active") {
    window.phoneHarness.activeReads++;
    // Capture at request start: a delayed pre-click read must remain stale.
    const payload = harness.snapshot();
    if (harness.deferReads) return new Promise<Response>((resolve) => harness.reads.push({ payload, resolve }));
    return Response.json(payload);
  }
  if (/\/api\/telephony\/calls\/[^/]+\/(hangup|hold)$/.test(url)) {
    return new Promise<Response>((resolve, reject) => harness.commands.push({ url, resolve, reject }));
  }
  return baseFetch(input, init);
};
Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => true });
