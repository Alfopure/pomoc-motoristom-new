import { describe, expect, it } from "vitest";
import type { RoutingDocument } from "@/server/telephony/config-service";
import type { IncomingFlow } from "@/lib/telephony/incoming-flow";
import { DEFAULT_OPERATOR_SETTINGS } from "@/lib/telephony/operator-settings";
import { incomingFlowChanges, incomingFlowsMatch, legacyIncomingFlow, moveFlowStep, personalNumberIssue, removeFlowStep, validateIncomingFlowDraft } from "./incoming-flow-model";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function document(): RoutingDocument {
  return {
    organizationId: id(1), routingVersion: 55, snapshotId: "snapshot", settings: null,
    capabilities: { defaultInboundCallMode: "ring_first", ownedMobileRouting: true, unifiedIncomingFlow: true },
    limits: { destinationAllowlist: ["SK", "CZ"], maxRingFanout: 8, maxConcurrentLegs: 9 },
    operators: [1, 2].map(n => ({ profileId: id(100 + n), displayName: `Operátor ${n}`, role: "dispatcher", active: true, accessStatus: "active", settings: { ...DEFAULT_OPERATOR_SETTINGS, defaultMobileNumber: `+42191012345${n}` }, device: null })),
    lines: [1, 2].map(n => ({ id: id(200 + n), phoneNumber: `+42123240877${n}`, label: `Linka ${n}`, partnerName: null, telnyxNumberId: null, ringPlanId: id(300), ivrMenuId: null, businessHoursId: null, environment: "development", active: true, inboundCallMode: "ring_first", incomingFlow: null })),
    groups: [{ id: id(400), name: "Ľudia", active: true, description: null, members: [
      { id: id(401), memberKind: "operator", profileId: id(101), externalNumber: null, position: 0, ringSecs: 17, lastOfferedAt: null, lastAnsweredAt: null },
      { id: id(402), memberKind: "external_number", profileId: null, ownerProfileId: id(101), externalNumber: "+421910123451", position: 1, ringSecs: 31, lastOfferedAt: null, lastAnsweredAt: null },
    ] }],
    plans: [{ id: id(300), name: "Postup", fallbackKind: "hangup_message", fallbackNumber: null, active: true, steps: [{ id: id(301), stepIndex: 0, ringGroupId: id(400), timeoutSecs: 25, strategy: "all" }] }],
    businessHours: [], pauseReasons: [], pauseReasonsInUse: [], ivrMenus: [],
  };
}
function flow(): IncomingFlow {
  return { version: 1, steps: [{ id: id(501), type: "ring", seconds: 20, people: [{ profileId: id(101), application: true, personalNumber: null }] }, { id: id(502), type: "external", seconds: 25, number: "+421910123459" }, { id: id(503), type: "repeat", stepIds: [id(501), id(502)], times: 2 }], ending: "hangup_message" };
}

describe("incoming flow editor model", () => {
  it("previews simultaneous devices as one person without mutating any stored routing", () => {
    const source = document(), before = structuredClone(source);
    const converted = legacyIncomingFlow(source, source.lines[0]);
    expect(converted.flow?.steps).toEqual([{ id: id(301), type: "ring", seconds: 25, people: [{ profileId: id(101), application: true, personalNumber: "+421910123451" }] }]);
    expect(source).toEqual(before);
    expect(incomingFlowChanges({}, source)).toEqual([]);
  });
  it("preserves each ordered raw endpoint and its timing rather than combining web + phone", () => {
    const source = document(); source.plans[0].steps[0].strategy = "ordered";
    const converted = legacyIncomingFlow(source, source.lines[0]);
    expect(converted.flow?.steps).toMatchObject([
      { type: "ring", seconds: 17, people: [{ profileId: id(101), application: true, personalNumber: null }] },
      { type: "ring", seconds: 31, people: [{ profileId: id(101), application: false, personalNumber: "+421910123451" }] },
    ]);
    expect(converted).toEqual(legacyIncomingFlow(source, source.lines[0]));
  });
  it("obeys effective line strategy override", () => {
    const source = document(); source.lines[0].inboundCallMode = "ring_ordered";
    expect(legacyIncomingFlow(source, source.lines[0]).flow?.steps).toHaveLength(2);
    source.plans[0].steps[0].strategy = "ordered"; source.lines[0].inboundCallMode = "ring_all";
    expect(legacyIncomingFlow(source, source.lines[0]).flow?.steps).toHaveLength(1);
  });
  it("preserves personal-mobile delivery instead of silently adding application", () => {
    const source = document(); source.groups[0].members.pop(); source.operators[0].settings!.deliveryMode = "personal_mobile";
    expect(legacyIncomingFlow(source, source.lines[0]).flow?.steps[0]).toMatchObject({ people: [{ application: false, personalNumber: "+421910123451" }] });
  });
  it("generates distinct stable identities when ordered plans reuse a group", () => {
    const source = document(); source.plans[0].steps[0].strategy = "ordered";
    source.plans[0].steps.push({ ...source.plans[0].steps[0], id: id(302), stepIndex: 1 });
    const converted = legacyIncomingFlow(source, source.lines[0]).flow!;
    expect(converted).not.toBeNull(); expect(new Set(converted.steps.map(step => step.id)).size).toBe(4);
  });
  it.each(["waiting_room", "external_number"] as const)("never relabels terminal %s as an equivalent new flow", fallbackKind => {
    const source = document(); source.plans[0].fallbackKind = fallbackKind;
    expect(legacyIncomingFlow(source, source.lines[0])).toMatchObject({ flow: null, canReplace: true });
  });
  it("allows only explicit replacement for manual queue", () => {
    const source = document(); source.lines[0].inboundCallMode = "queue_first";
    expect(legacyIncomingFlow(source, source.lines[0])).toMatchObject({ flow: null, canReplace: true });
  });
  it("blocks return lines and routes borrowed by another line", () => {
    const source = document(); source.lines[1].returnLineId = source.lines[0].id;
    expect(legacyIncomingFlow(source, source.lines[0]).canReplace).toBe(false);
    expect(legacyIncomingFlow(source, source.lines[1]).canReplace).toBe(false);
  });
  it("blocks IVR, inactive lines, and malformed saved flows without dropping behavior", () => {
    for (const mode of ["ivr", "inactive", "invalid"]) {
      const source = document();
      if (mode === "ivr") { source.lines[0].ivrMenuId = id(600); source.ivrMenus.push({ id: id(600), active: true } as RoutingDocument["ivrMenus"][number]); }
      if (mode === "inactive") source.lines[0].active = false;
      if (mode === "invalid") source.lines[0].incomingFlowInvalid = true;
      expect(legacyIncomingFlow(source, source.lines[0])).toMatchObject({ flow: null, canReplace: false });
    }
  });
  it("also blocks a dormant IVR assignment because activating it would change route precedence", () => {
    const source = document(); source.lines[0].ivrMenuId = id(600);
    expect(legacyIncomingFlow(source, source.lines[0])).toMatchObject({ flow: null, canReplace: false });
  });
  it("does not silently lose standalone external numbers in a simultaneous group", () => {
    const source = document(); source.groups[0].members[1].ownerProfileId = null; source.groups[0].members[1].externalNumber = "+421910123459";
    expect(legacyIncomingFlow(source, source.lines[0]).flow).toBeNull();
    source.plans[0].steps[0].strategy = "ordered";
    expect(legacyIncomingFlow(source, source.lines[0]).flow?.steps[1]).toMatchObject({ type: "external", number: "+421910123459", seconds: 31 });
  });
  it("serializes only changed lines and retains their original expected flow", () => {
    const source = document(); source.lines[0].incomingFlow = flow();
    const changed = flow(); changed.ending = "callback_prompt";
    expect(incomingFlowChanges({ [source.lines[0].id]: changed }, source)).toEqual([{ id: source.lines[0].id, flow: changed, expectedFlow: flow() }]);
    expect(incomingFlowChanges({ [source.lines[0].id]: flow() }, source)).toEqual([]);
  });
  it("matches a committed result despite JSONB object key ordering", () => {
    const source = document(); const changes = incomingFlowChanges({ [source.lines[0].id]: flow() }, source);
    source.lines[0].incomingFlow = { ending: "hangup_message", steps: flow().steps.map(step => Object.fromEntries(Object.entries(step).reverse()) as typeof step), version: 1 };
    expect(incomingFlowsMatch(changes, source)).toBe(true);
    expect(incomingFlowChanges({ [source.lines[0].id]: flow() }, source)).toEqual([]);
  });
  it("does not report lost-response success for a missing, malformed or different line", () => {
    for (const mode of ["missing", "invalid", "different"]) {
      const source = document(); const changes = incomingFlowChanges({ [source.lines[0].id]: flow() }, source);
      source.lines[0].incomingFlow = flow();
      if (mode === "missing") source.lines.shift();
      if (mode === "invalid") source.lines[0].incomingFlowInvalid = true;
      if (mode === "different") source.lines[0].incomingFlow!.ending = "hangup";
      expect(incomingFlowsMatch(changes, source)).toBe(false);
    }
  });
  it("does not mistake changes on an unrelated line for a failed save", () => {
    const source = document(); const changes = incomingFlowChanges({ [source.lines[0].id]: flow() }, source);
    source.lines[0].incomingFlow = flow(); source.lines[1].incomingFlow = { ...flow(), ending: "hangup" };
    expect(incomingFlowsMatch(changes, source)).toBe(true);
  });
  it("retains IDs during reorder and prevents repeats moving before their targets", () => {
    const source = flow();
    expect(moveFlowStep(source, id(503), -1)).toBeNull();
    expect(moveFlowStep(source, id(501), -1)).toBeNull();
    expect(moveFlowStep(source, id(501), 1)?.steps.map(step => step.id)).toEqual([id(502), id(501), id(503)]);
    expect(source).toEqual(flow());
  });
  it("removes dependent repeat references and only drops a repeat after its last target", () => {
    const changed = removeFlowStep(flow(), id(501));
    expect(changed.steps.at(-1)).toMatchObject({ type: "repeat", stepIds: [id(502)] });
    expect(removeFlowStep(changed, id(502)).steps).toEqual([]);
  });
  it("validates personal numbers against syntax, destinations, and own-line loops", () => {
    const source = document();
    expect(personalNumberIssue("0910 123 456", source)).toBeNull();
    expect(personalNumberIssue("wrong", source)).toContain("platné");
    expect(personalNumberIssue("+14155552671", source)).toContain("povolené");
    expect(personalNumberIssue(source.lines[0].phoneNumber, source)).toContain("dispečingu");
  });
  it("rejects another person's number across profile defaults, owned endpoints and saved flows", () => {
    const source = document();
    expect(personalNumberIssue("+421910123452", source, id(101))).toContain("inému");
    expect(personalNumberIssue("+421910123451", source, id(101))).toBeNull();
    expect(personalNumberIssue("+421910123451", source, id(102))).toContain("inému");
    source.lines[1].incomingFlow = { version: 1, ending: "hangup", steps: [{ id: id(701), type: "ring", seconds: 20, people: [{ profileId: id(102), application: false, personalNumber: "+421910123459" }] }] };
    expect(personalNumberIssue("+421910123459", source, id(101))).toContain("inému");
  });
  it("catches unavailable operators, per-device fanout and organization capacity", () => {
    const source = document(); source.operators[0].active = false;
    expect(validateIncomingFlowDraft(flow(), source).some(issue => issue.code === "inactive_person")).toBe(true);
    source.operators[0].active = true; source.limits!.maxConcurrentLegs = 2;
    expect(validateIncomingFlowDraft(flow(), source).some(issue => issue.code === "fanout_limit")).toBe(true);
    source.limits!.maxConcurrentLegs = 9;
    expect(validateIncomingFlowDraft(flow(), source)).toEqual([]);
  });
});
