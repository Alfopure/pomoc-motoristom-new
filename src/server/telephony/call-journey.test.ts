import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import type { Json } from "@/lib/supabase/database.types";
import type { IncomingFlow } from "@/lib/telephony/incoming-flow";
import { incomingFlowSignature, journeyElapsedSeconds } from "@/lib/telephony/call-journey";
import type { AttemptRow, LegRow, SessionRow } from "./state/types";
import { materialiseIncomingFlow } from "./routing/incoming-flow";
import { loadActiveCallJourneys, loadCallJourney, projectCallJourney, type JourneyProjectionInput } from "./call-journey";
import { appendJourneyEvidence, JOURNEY_EVIDENCE_LIMIT } from "./state/types";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1), SESSION = id(2), CALL = id(3), LINE = id(4), OPERATOR = id(5);
const at = (seconds: number) => new Date(Date.parse("2026-10-05T10:00:00Z") + seconds * 1000).toISOString();
const flow: IncomingFlow = { version: 1, ending: "callback_prompt", steps: [
  { id: id(10), type: "ring", seconds: 20, people: [{ profileId: OPERATOR, application: true, personalNumber: "+421910988882" }] },
  { id: id(11), type: "wait", minutes: 1 },
  { id: id(12), type: "repeat", stepIds: [id(10)], times: 2 },
] };
function session(patch: Partial<SessionRow> = {}): SessionRow {
  return { id: SESSION, organization_id: ORG, state: "ringing", direction: "inbound", line_id: LINE, version: 3,
    started_at: at(0), answered_at: null, ended_at: null, customer_leg_id: null, caller_number: "+421910000001", called_number: "+421232408774", current_step: 1,
    metadata: { ring: { plan: materialiseIncomingFlow(flow, new Date(at(0))), active_step: 0, step_started_at: at(1), step_deadline_at: at(26), mode: "plan" },
      journey: { version: 1, entries: [{ id: "e1", kind: "step_enter", at: at(1), stepIndex: 0 }] } }, ...patch } as SessionRow;
}
function attempt(n = 20, patch: Partial<AttemptRow> = {}): AttemptRow {
  return { id: id(n), organization_id: ORG, session_id: SESSION, step_index: 0, member_kind: "operator", profile_id: OPERATOR, external_number: null,
    application_device: "web", leg_id: null, result: "offered", offered_at: at(2), answered_at: null, ended_at: null, ring_secs: 20, created_at: at(2), ...patch } as AttemptRow;
}
const project = (patch: Partial<JourneyProjectionInput> = {}) => projectCallJourney({ session: session(), call: { id: CALL, end_reason: null }, attempts: [attempt()], legs: [], events: [], profiles: new Map([[OPERATOR, "Michal"]]), now: new Date(at(10)), ...patch });

describe("observed call journey", () => {
  it("uses active step rather than the continuation pointer and preserves repeated identities", () => {
    const data = project();
    expect(data.currentOccurrenceId).toBe(`${SESSION}:0`);
    expect(data.occurrences.map(step => step.id)).toHaveLength(new Set(data.occurrences.map(step => step.id)).size);
    expect(data.occurrences[2]).toMatchObject({ sourceStepId: id(10), repeatStepId: id(12), repeatRound: 1, executionIndex: 2 });
    expect(data.occurrences[3].repeatRound).toBe(2);
    expect(data.occurrences[0]).toMatchObject({ startedAt: at(1), configuredSeconds: 20, state: "active", timingBasis: "observed_transition" });
    expect(data.occurrences[0].endpoints[0].offeredAt).toBe(at(2));
    expect(data.flow.signature).toBe(incomingFlowSignature(flow));
    expect(JSON.stringify(data)).not.toContain("step_deadline_at");
  });

  it("shows all three physical offers without counting a canceled sibling as missed", () => {
    const data = project({ session: session({ state: "talking", answered_at: at(8) }), attempts: [
      attempt(20, { result: "cancelled", ended_at: at(8) }),
      attempt(21, { application_device: "mobile", result: "answered", answered_at: at(8) }),
      attempt(22, { member_kind: "external_number", application_device: null, external_number: "+421910988882", result: "cancelled", ended_at: at(8) }),
    ] });
    expect(data.currentOccurrenceId).toBeNull();
    expect(data.occurrences[0]).toMatchObject({ state: "completed", endedAt: at(8) });
    expect(data.occurrences[0].endpoints.map(endpoint => [endpoint.channel, endpoint.state, endpoint.reason])).toEqual([
      ["web", "cancelled", "answered_elsewhere"], ["mobile_app", "answered", "answered"], ["personal_number", "cancelled", "answered_elsewhere"],
    ]);
    expect(data.occurrences[1].state).toBe("not_reached");
  });

  it("retains exact adjacent wait intervals and never uses current editor settings", () => {
    const waitFlow: IncomingFlow = { version: 1, ending: "hangup", steps: [{ id: id(10), type: "wait", minutes: 1 }, { id: id(11), type: "wait", minutes: 2 }] };
    const data = project({ session: session({ state: "waiting", current_step: 2, metadata: {
      ring: { plan: materialiseIncomingFlow(waitFlow, new Date(at(0))), active_step: null, mode: "plan" }, waiting: { flow_step_index: 1, since: at(60), max_minutes: 2 },
      journey: { version: 1, entries: [
        { id: "a", kind: "step_enter", stepIndex: 0, at: at(0) }, { id: "b", kind: "step_exit", stepIndex: 0, at: at(60), reason: "wait_timeout" }, { id: "c", kind: "step_enter", stepIndex: 1, at: at(60) },
      ] },
    } }), attempts: [] });
    expect(data.currentOccurrenceId).toBe(`${SESSION}:1`);
    expect(data.occurrences[0]).toMatchObject({ state: "completed", startedAt: at(0), endedAt: at(60), reason: "wait_timeout" });
    expect(data.occurrences[1]).toMatchObject({ state: "active", startedAt: at(60), configuredSeconds: 120 });
  });

  it("marks an old unrecorded passed wait unknown instead of zero seconds or not reached", () => {
    const data = project({ session: session({ metadata: { ring: { plan: materialiseIncomingFlow(flow, new Date(at(0))), active_step: 2, mode: "plan", step_started_at: at(70) } } }), attempts: [attempt(20, { step_index: 2, offered_at: at(70) })] });
    expect(data.coverage).toBe("partial");
    expect(data.occurrences[1]).toMatchObject({ state: "unknown", startedAt: null, endedAt: null });
  });
  it("shows a known manual pickup in its observed wait without guessing the app device", () => {
    const current = session(), metadata = current.metadata as { ring: Record<string, Json> };
    const data = project({ attempts: [], session: session({ state: "talking", answered_at: at(70), answered_by_profile_id: OPERATOR, metadata: { ...metadata, journey: { version: 1, entries: [
      { id: "a", kind: "step_enter", stepIndex: 1, at: at(20) }, { id: "b", kind: "step_exit", stepIndex: 1, at: at(70), reason: "answered" },
    ] } } }), legs: [{ id: id(101), organization_id: ORG, session_id: SESSION, role: "operator", profile_id: OPERATOR, initiated_at: at(68), answered_at: at(70), ended_at: null, client_state: { intent: "pickup" } } as unknown as LegRow] });
    expect(data.occurrences[1].endpoints).toEqual([expect.objectContaining({ profileId: OPERATOR, displayName: "Michal", channel: "application_unknown", state: "answered", reason: "manual_pickup", offeredAt: at(68), answeredAt: at(70) })]);
    expect(data.occurrences[0].endpoints).toEqual([]);
  });

  it.each(["held", "consulting", "waiting"] as const)("does not reactivate initial routing for answered %s", state => {
    const data = project({ session: session({ state, answered_at: at(5) }) });
    expect(data.currentOccurrenceId).toBeNull();
    expect(data.phase).toBe(state === "held" ? "held" : state === "consulting" ? "transfer" : "post_answer_wait");
  });

  it("keeps callback confirmation separate from queue/ringing despite open sibling offers", () => {
    const current = session();
    const data = project({ session: session({ state: "callback_offered", metadata: { ...current.metadata as object, callback: { confirmed: true, requested_at: at(9), digit: "1", context: "waiting_room" } } }) });
    expect(data.phase).toBe("callback_confirmation");
    expect(data.currentOccurrenceId).toBeNull();
    expect(data.callback).toMatchObject({ kind: "requested", digit: "1", requestedAt: at(9) });
    expect(data.events.at(-1)?.kind).toBe("callback_requested");
    expect(data.occurrences.at(-1)?.state).toBe("not_reached");
  });

  it("does not infer a callback request from an offer or an ordinary missed row", () => {
    const current = session();
    const metadata = current.metadata as { ring: Record<string, Json> };
    const data = project({ callback: { source: "missed", metadata: {} }, session: session({ state: "callback_offered", metadata: { ...metadata, ring: { ...metadata.ring, exhausted: true, fallback: "callback_prompt" } } }) });
    expect(data.callback?.kind).toBe("missed");
    expect(data.currentOccurrenceId).toBe(`${SESSION}:ending`);
    expect(data.phase).not.toBe("callback_confirmation");
  });

  it("ends the customer journey while other conference participants remain and never outputs SIP identities", () => {
    const data = project({ session: session({ state: "conference", answered_at: at(3), caller_number: "sip:anonymous@private.invalid" }),
      legs: [{ id: id(99), session_id: SESSION, organization_id: ORG, role: "customer", ended_at: at(7), telnyx_call_control_id: "secret-provider-id" } as LegRow] });
    expect(data).toMatchObject({ phase: "ended", customerActive: false, sessionActive: true, callerNumber: null, endedAt: at(7) });
    expect(JSON.stringify(data)).not.toMatch(/secret-provider|private.invalid/);
  });

  it("keeps the final announcement live until the customer actually leaves", () => {
    const current = session(), metadata = current.metadata as { ring: Record<string, Json> };
    const closing = session({ state: "missed", metadata: { ...metadata, ring: { ...metadata.ring, plan: materialiseIncomingFlow({ ...flow, ending: "hangup_message" }, new Date(at(0))), exhausted: true, fallback: "hangup_message" } } });
    const data = project({ session: closing });
    expect(data).toMatchObject({ customerActive: true, phase: "routing", currentOccurrenceId: `${SESSION}:ending` });
    expect(project({ session: closing, call: { id: CALL, end_reason: "all_busy", ended_at: at(10) } })).toMatchObject({ customerActive: false, phase: "ended" });
  });

  it("outbound/internal calls have no fabricated incoming steps", () => {
    for (const direction of ["outbound", "internal"] as const) expect(project({ session: session({ direction }) }).occurrences).toEqual([]);
  });

  it("distinguishes skipped app device evidence and ignores events from another session", () => {
    const makeEvent = (sessionId: string, applicationDevice: "web" | "mobile") => ({ id: id(70), normalized_payload: { session_id: sessionId, routing: [{ version: 1, kind: "selection", step: 0, at: at(1), selectedCount: 0, members: [{ profileId: OPERATOR, applicationDevice, endpoint: "sip", outcome: "skipped", reason: "no_device" }] }] }, handled_status: "processed" as const, received_at: at(1), provider_timestamp: at(1) });
    const data = project({ attempts: [], events: [makeEvent(SESSION, "mobile"), makeEvent(id(999), "web")] });
    expect(data.occurrences[0].endpoints).toHaveLength(1);
    expect(data.occurrences[0].endpoints[0]).toMatchObject({ channel: "mobile_app", state: "skipped", reason: "no_device" });
  });

  it("flags truncated evidence and missing names without guessing zeros", () => {
    const data = project({ profiles: new Map(), truncated: true });
    expect(data).toMatchObject({ truncated: true, coverage: "partial" });
    expect(data.occurrences[0].endpoints[0].displayName).toBeNull();
    expect(journeyElapsedSeconds(null, null, Date.now())).toBeNull();
    expect(journeyElapsedSeconds(at(9), at(1), Date.now())).toBeNull();
  });

  it("uses canonical skipped evidence when later event audits are truncated", () => {
    const current = session();
    const data = project({ attempts: [], session: session({ state: "ended", ended_at: at(10), metadata: { ...current.metadata as object, journey: { version: 1, entries: [
      { id: "a", kind: "step_enter", stepIndex: 0, at: at(1) }, { id: "b", kind: "step_exit", stepIndex: 0, at: at(1), reason: "no_eligible_members" },
    ] } } }) });
    expect(data.occurrences[0].state).toBe("skipped");
  });

  it("does not call incomplete or backwards historical intervals complete", () => {
    const current = session();
    for (const end of [null, at(0)]) {
      const entries = [{ id: "a", kind: "step_enter", stepIndex: 0, at: at(1) }, ...(end ? [{ id: "b", kind: "step_exit", stepIndex: 0, at: end, reason: "customer_hangup" }] : [])];
      const data = project({ attempts: [], session: session({ state: "ended", ended_at: at(10), metadata: { ...current.metadata as object, journey: { version: 1, entries } } }) });
      expect(data.coverage).toBe("partial");
    }
  });
});

describe("bounded authorized journey reads", () => {
  function database() {
    const fake = createFakeSupabase();
    fake.db.seed("motorist_telephony_lines", [{ id: LINE, organization_id: ORG }, { id: id(400), organization_id: id(999) }]);
    fake.db.seed("motorist_call_sessions", [session(), session({ id: id(200), organization_id: id(999) })]);
    fake.db.seed("motorist_calls", [{ id: CALL, organization_id: ORG, session_id: SESSION }, { id: id(300), organization_id: id(999), session_id: id(200) }]);
    fake.db.seed("motorist_ring_attempts", [attempt(), attempt(200, { organization_id: id(999), session_id: id(200), profile_id: id(500) })]);
    return { fake, deps: { admin: fake.admin, organizationId: ORG, now: () => new Date(at(10)) } };
  }
  it("returns only the actor organization and never invokes provider operations/RPC writes", async () => {
    const { fake, deps } = database();
    const result = await loadActiveCallJourneys(deps, LINE);
    expect(result.calls.map(call => call.sessionId)).toEqual([SESSION]);
    const detail = await loadCallJourney(deps, CALL);
    expect(detail.sessionId).toBe(SESSION);
    expect(fake.db.log.every(entry => entry.kind === "query" && entry.operation === "select")).toBe(true);
  });
  it("makes foreign and absent call/session/line IDs equally unavailable", async () => {
    const { deps } = database();
    await expect(loadCallJourney(deps, id(300))).rejects.toMatchObject({ status: 404 });
    await expect(loadCallJourney(deps, id(200), "session")).rejects.toMatchObject({ status: 404 });
    await expect(loadCallJourney(deps, id(999))).rejects.toMatchObject({ status: 404 });
    await expect(loadActiveCallJourneys(deps, id(400))).rejects.toMatchObject({ status: 404 });
  });
  it("rejects malformed IDs and preserves two calls from the same caller", async () => {
    const { fake, deps } = database();
    await expect(loadCallJourney(deps, "bad")).rejects.toMatchObject({ status: 400 });
    fake.db.insert("motorist_call_sessions", session({ id: id(201), started_at: at(2) }));
    const result = await loadActiveCallJourneys(deps, LINE);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].callerNumber).toBe(result.calls[1].callerNumber);
    expect(result.calls[0].sessionId).not.toBe(result.calls[1].sessionId);
  });
  it("includes a closing missed session without including ordinary missed cleanup", async () => {
    const { fake, deps } = database(), current = session(), metadata = current.metadata as { ring: Record<string, Json> };
    fake.db.insert("motorist_call_sessions", session({ id: id(202), state: "missed", metadata: { ...metadata, closing_message: true, ring: { ...metadata.ring, plan: materialiseIncomingFlow({ ...flow, ending: "hangup_message" }, new Date(at(0))), exhausted: true, fallback: "hangup_message" } } }));
    fake.db.insert("motorist_call_sessions", session({ id: id(203), state: "missed", metadata: {} }));
    const result = await loadActiveCallJourneys(deps, LINE);
    expect(result.calls.map(call => call.sessionId)).toEqual([SESSION, id(202)]);
    expect(result.calls[1].customerActive).toBe(true);
  });
});

describe("additive frozen evidence", () => {
  it("deduplicates replay and bounds records without discarding original history", () => {
    const entry = { id: "event:enter:1", at: at(1), kind: "step_enter" as const, stepIndex: 1 };
    const first = appendJourneyEvidence(null, entry);
    expect(appendJourneyEvidence(first, entry).entries).toHaveLength(1);
    const full = { version: 1, entries: Array.from({ length: JOURNEY_EVIDENCE_LIMIT }, (_, index) => ({ ...entry, id: String(index) })) };
    const result = appendJourneyEvidence(full, entry);
    expect(result.truncated).toBe(true);
    expect(result.entries[0].id).toBe("0");
  });
  it("fingerprints equivalent object order but detects routing/policy changes and freezes wait policy", () => {
    const reordered = { steps: flow.steps, ending: flow.ending, version: 1 } as IncomingFlow;
    expect(incomingFlowSignature(flow)).toBe(incomingFlowSignature(reordered));
    const changed = structuredClone(flow);
    if (changed.steps[1].type !== "wait") throw Error("fixture");
    changed.steps[1].policy = { mode: "music", intervalSeconds: 15 };
    expect(incomingFlowSignature(flow)).not.toBe(incomingFlowSignature(changed));
    const frozen = materialiseIncomingFlow(changed, new Date(at(0)));
    changed.steps[1].policy.mode = "callback";
    expect(frozen.steps[1].waitPolicy?.mode).toBe("music");
  });
});
