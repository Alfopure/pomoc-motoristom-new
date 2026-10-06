import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CallJourney, JourneyEndpoint, JourneyOccurrence } from "@/lib/telephony/call-journey";
import { CallJourneyTimeline } from "./CallJourney";
import { endpointAttemptSeconds, endpointStateLabel, journeyDisplayNow, journeyReason, journeyRouteGroups, journeyStageLabel, journeyTerminalKey, occurrenceElapsed } from "./call-journey-model";

const start = "2026-10-04T10:00:00.000Z";
const occurrence = (patch: Partial<JourneyOccurrence> = {}): JourneyOccurrence => ({ id: "call:0", executionIndex: 0, sourceStepId: "source", kind: "ring", label: "Michal", state: "active", startedAt: start, endedAt: null, configuredSeconds: 25, timingBasis: "observed_transition", reason: null, endpoints: [], ...patch });
const endpoint = (patch: Partial<JourneyEndpoint> = {}): JourneyEndpoint => ({ id: "attempt", profileId: "operator", displayName: "Michal", channel: "web", number: null, state: "offered", reason: null, offeredAt: start, answeredAt: null, endedAt: null, ...patch });
const journey = (patch: Partial<CallJourney> = {}): CallJourney => ({ version: 1, sessionId: "call", callId: null, lineId: "line", direction: "inbound", callerNumber: "+421900000001", calledNumber: "+421232408774", phase: "routing", sessionState: "ringing", sessionVersion: 1, asOf: "2026-10-04T10:00:10.000Z", customerActive: true, sessionActive: true, startedAt: start, answeredAt: null, endedAt: null, flow: { source: "incoming_flow", signature: "saved" }, currentOccurrenceId: "call:0", coverage: "complete", truncated: false, occurrences: [occurrence()], events: [], callback: null, ...patch });

describe("human-readable call evidence", () => {
  it("keeps reconciling after a customer hangup until the session is terminal", () => {
    const hungUp = journey({ phase: "ended", customerActive: false, endedAt: start });
    expect(journeyTerminalKey(hungUp)).toBeNull();
    expect(journeyTerminalKey({ ...hungUp, sessionActive: false })).toBeNull();
    expect(journeyTerminalKey({ ...hungUp, sessionActive: false, sessionState: "missed" })).toBeNull();
    expect(journeyTerminalKey({ ...hungUp, sessionActive: false, sessionState: "ended" })).not.toBeNull();
    expect(journeyTerminalKey({ ...hungUp, sessionActive: false, sessionState: "failed" })).not.toBeNull();
  });
  it("requires coherent end evidence before settling a detail", () => {
    const ended = journey({ phase: "ended", sessionActive: false, customerActive: false, sessionState: "ended", endedAt: start });
    expect(journeyTerminalKey({ ...ended, customerActive: true })).toBeNull();
    expect(journeyTerminalKey({ ...ended, endedAt: null })).toBeNull();
    expect(journeyTerminalKey({ ...ended, endedAt: "invalid" })).toBeNull();
  });
  it("ignores read time but notices late session, callback and endpoint evidence", () => {
    const ended = journey({ phase: "ended", sessionActive: false, customerActive: false, sessionState: "ended", endedAt: start });
    const key = journeyTerminalKey(ended);
    expect(journeyTerminalKey({ ...ended, asOf: "2026-10-04T10:02:00.000Z" })).toBe(key);
    for (const patch of [
      { sessionVersion: 2 },
      { callback: { kind: "requested" as const, requestedAt: start, digit: "1" } },
      { occurrences: [occurrence({ state: "completed", endedAt: start, endpoints: [endpoint({ state: "cancelled" })] })] },
      { events: [{ id: "late", at: start, label: "Ukončené", kind: "ended" }] },
      { truncated: true },
    ]) expect(journeyTerminalKey({ ...ended, ...patch })).not.toBe(key);
  });
  it("freezes at the server observation during stale refreshes despite device clock skew", () => {
    const call = journey();
    expect(journeyDisplayNow(call, 1_000, 4_000, false)).toBe(Date.parse(call.asOf) + 3_000);
    expect(journeyDisplayNow(call, 1_000, 90_000, true)).toBe(Date.parse(call.asOf));
  });
  it("does not tick an unknown historical interval or make an unvisited interval zero", () => {
    expect(occurrenceElapsed(occurrence({ state: "unknown" }), Date.parse(start) + 60_000)).toBeNull();
    expect(occurrenceElapsed(occurrence({ state: "not_reached", startedAt: null }), Date.parse(start))).toBeNull();
  });
  it("stops attempted-connection time at answer before the conversation ends", () => {
    const answer = endpoint({ state: "answered", answeredAt: "2026-10-04T10:00:12.000Z", endedAt: "2026-10-04T10:05:00.000Z" });
    expect(endpointAttemptSeconds(answer, false, Date.parse(start) + 999_000)).toBe(12);
    expect(endpointAttemptSeconds({ ...answer, endedAt: null }, false, Date.parse(start) + 999_000)).toBe(12);
  });
  it("distinguishes canceled siblings from unanswered attempts", () => {
    expect(endpointStateLabel(endpoint({ state: "cancelled", reason: "answered_elsewhere" }), journey())).toBe("Zastavené po prijatí na inom zariadení");
    expect(endpointStateLabel(endpoint({ state: "no_answer" }), journey())).toBe("Bez prijatia");
  });
  it("does not expose technical unknown reasons or imply capacity waits are ringing", () => {
    expect(journeyReason("provider_internal_8675309")).toBe("Dôvod nebol zaznamenaný");
    expect(journeyStageLabel(journey({ occurrences: [occurrence({ reason: "capacity" })] }))).toBe("Čaká na kapacitu");
  });
  it("does not place held conversations or callback confirmations on routing steps", () => {
    expect(journeyStageLabel(journey({ phase: "held" }))).toBe("Podržaný počas rozhovoru");
    expect(journeyStageLabel(journey({ phase: "callback_confirmation" }))).toBe("Spätné volanie vyžiadané");
  });
  it("groups only equal frozen signatures and isolates unverifiable old routes", () => {
    const calls = [journey(), journey({ sessionId: "same" }), journey({ sessionId: "new", flow: { source: "incoming_flow", signature: "changed" } }), ...["old1", "old2"].map(sessionId => journey({ sessionId, flow: { source: "legacy", signature: null } }))];
    expect(journeyRouteGroups(calls).map(group => group.calls.map(call => call.sessionId))).toEqual([["call", "same"], ["new"], ["old1"], ["old2"]]);
  });
  it("does not advance the step when its requested limit expires", () => {
    const call = journey({ occurrences: [occurrence({ endpoints: [endpoint()] })] });
    const html = renderToStaticMarkup(createElement(CallJourneyTimeline, { journey: call, now: Date.parse(start) + 30_000 }));
    expect(html).toContain("Limit uplynul; čakáme na potvrdenie ďalšieho stavu.");
    expect(html).toContain("Pokus o spojenie");
    expect(html).not.toContain("Čakáreň");
  });
  it("announces an explicit request and explains incomplete historical evidence", () => {
    const call = journey({ phase: "ended", sessionActive: false, endedAt: "2026-10-04T10:00:18.000Z", currentOccurrenceId: null, coverage: "partial", callback: { kind: "requested", requestedAt: "2026-10-04T10:00:15.000Z", digit: "1" } });
    const html = renderToStaticMarkup(createElement(CallJourneyTimeline, { journey: call, now: Date.parse(start) + 90_000 }));
    expect(html).toContain("Spätné volanie vyžiadal volajúci stlačením 1");
    expect(html).toContain("Chýbajúce časy ani dôvody neodhadujeme.");
    expect(html).toContain("00:18");
  });
});
