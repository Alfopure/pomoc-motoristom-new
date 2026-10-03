import { describe, expect, it } from "vitest";
import { createTelephonyHarness, ORG } from "@/test/telephony-harness";
import { getRoutingDocument } from "@/server/telephony/config-service";
import { newGroupDraft, newMemberDraft } from "./ring-groups-model";
import { newPlanDraft, newStepDraft, validateRingPlanDrafts } from "./ring-plan-model";
import { documentWithDraft, identifyGroups, identifyPlans, incomingDraft, incomingLineBehaviour, incomingMatches, incomingPayload, incomingPlanIdsForLine, incomingRouteSummary, initialIncomingLineId, mergeSavedLine } from "./incoming-routing-model";
async function document() { const harness = createTelephonyHarness(); return getRoutingDocument(harness.deps, { organizationId: ORG, includeSettings: true }); }
describe("combined routing draft", () => {
  it("keeps the coherent plan version when one number is saved separately", async () => {
    const current = { ...await document(), snapshotId: "coherent-1" };
    const draft = incomingDraft(current);
    draft.plans[0].steps[0].timeoutSecs = "35";
    const saved = { ...await document(), snapshotId: undefined, lines: current.lines.map((line, index) => index === 0 ? { ...line, inboundCallMode: "queue_first" as const } : line) };
    const merged = mergeSavedLine(current, saved);
    expect(merged.snapshotId).toBe("coherent-1");
    expect(merged.routingVersion).toBe(current.routingVersion);
    expect(merged.lines[0].inboundCallMode).toBe("queue_first");
    expect(incomingMatches(draft, merged)).toBe(false);
    expect(draft.plans[0].steps[0].timeoutSecs).toBe("35");
  });
  it("assigns stable IDs before a new plan refers to a new group", () => {
    let n=0; const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12,"0")}`;
    const groups = identifyGroups([{ ...newGroupDraft("Tím"), members: [newMemberDraft("operator")] }], uuid);
    const plans = identifyPlans([{ ...newPlanDraft("Prvý"), steps: [newStepDraft(groups[0].id!)] }], uuid);
    const again = identifyGroups(groups, uuid);
    expect(again).toEqual(groups); expect(n).toBe(4); expect(incomingPayload({ groups, plans }).plans[0].steps[0].ringGroupId).toBe(groups[0].id);
  });
  it("keeps saved member history and ownership while editing times", async () => {
    const source=await document(); source.groups[0].members[0].ownerProfileId = null; source.groups[0].members[0].lastAnsweredAt="2026-09-19T10:00:00Z";
    const draft=incomingDraft(source); draft.groups[0].members[0].ringSecs="35";
    const working=documentWithDraft(source,draft);
    expect(working.groups[0].members[0]).toMatchObject({ lastAnsweredAt:"2026-09-19T10:00:00Z", ownerProfileId:null, ringSecs:35 });
    expect(incomingMatches(draft,source)).toBe(false);
  });
  it("recognizes committed draft after server reorders named lists and normalizes owners", async () => {
    const source=await document(); const draft=incomingDraft(source);
    source.groups.reverse(); for(const group of source.groups) for(const member of group.members) member.ownerProfileId ??= null;
    expect(incomingMatches(draft,source)).toBe(true);
  });
  it("does not silently rebase a different remote commit", async () => {
    const source=await document(); const draft=incomingDraft(source); draft.plans[0].steps[0].timeoutSecs="35";
    source.plans[0].steps[0].timeoutSecs=40;
    expect(incomingMatches(draft,source)).toBe(false); expect(draft.plans[0].steps[0].timeoutSecs).toBe("35");
  });
});

async function scopedDocument() {
  const source = await document();
  source.plans = ["direct", "ivr-plan", "unused"].map(id => ({ ...source.plans[0], id, name: id }));
  source.lines = [
    { ...source.lines[0], id: "inactive", active: false, ringPlanId: "unused", ivrMenuId: null, returnLineId: null },
    { ...source.lines[0], id: "active", active: true, ringPlanId: "direct", ivrMenuId: "ivr", returnLineId: null },
    { ...source.lines[0], id: "return", active: true, ringPlanId: "unused", ivrMenuId: null, returnLineId: "active", inboundCallMode: "ring_ordered" as const },
  ];
  source.ivrMenus = [{ id: "ivr", name: "Menu", active: true, promptMediaUrl: null, ttsText: null, invalidMediaUrl: null,
    timeoutSecs: 10, maxTries: 2, ringPlanIds: ["ivr-plan"], options: [
      { id: "option", digit: "1", action: "ring_plan", targetRingPlanId: "ivr-plan", targetNumber: null, label: "Pomoc", promptMediaUrl: null, ttsText: null },
    ] }];
  return source;
}

describe("incoming line display scope", () => {
  it("starts on an active line and respects explicit inactive-line navigation", async () => {
    const source = await scopedDocument();
    expect(initialIncomingLineId(source)).toBe("active");
    expect(initialIncomingLineId(source, { section: "telephony", tab: "incoming", lineId: "inactive" })).toBe("inactive");
    expect(initialIncomingLineId({ ...source, lines: [] })).toBe("");
  });

  it("includes direct and IVR targets, including a borrowed return route", async () => {
    const source = await scopedDocument();
    expect(incomingPlanIdsForLine(source, "active")).toEqual(["direct", "ivr-plan"]);
    expect(incomingPlanIdsForLine(source, "return")).toEqual(["direct", "ivr-plan"]);
    expect(incomingPlanIdsForLine(source, "missing")).toEqual([]);
    expect(incomingPlanIdsForLine(source, "")).toBeNull();
    source.ivrMenus[0].ringPlanIds = [];
    expect(incomingPlanIdsForLine(source, "active")).toEqual(["direct", "ivr-plan"]);
  });

  it("describes IVR choices as branches and skips fallback when all plan groups are inactive", async () => {
    const source = await scopedDocument();
    expect(incomingRouteSummary(source, "active")).toEqual({ ring: "Podľa voľby v hlasovom menu", fallback: "Podľa zvolenej vetvy" });
    source.ivrMenus[0].active = false;
    source.groups = source.groups.map(group => ({ ...group, active: false }));
    expect(incomingRouteSummary(source, "active")).toEqual({ ring: "Bez aktívnych krokov", fallback: "Spätné volanie, ak je možné" });
    expect(incomingRouteSummary(source, "inactive")).toEqual({ ring: "Linka nie je aktívna", fallback: "Smerovanie sa nespustí" });
  });

  it("reveals deep-linked unused plans and groups without changing the line's saved assignment", async () => {
    const source = await scopedDocument();
    const target = { section: "telephony" as const, tab: "incoming" as const, lineId: "active" };
    expect(initialIncomingLineId(source, { ...target, planId: "ivr-plan" })).toBe("active");
    expect(initialIncomingLineId(source, { ...target, planId: "unused" })).toBe("");
    expect(initialIncomingLineId(source, { ...target, groupId: "unrelated-group" })).toBe("");
    expect(source.lines[1].ringPlanId).toBe("direct");
  });

  it("keeps hidden plans, their invalid drafts and full save payload when scope changes", async () => {
    const source = await scopedDocument();
    const draft = incomingDraft(source);
    draft.plans[2].steps = [];
    const before = structuredClone(incomingPayload(draft));
    const working = documentWithDraft(source, draft);
    expect(incomingPlanIdsForLine(working, "active")).not.toContain("unused");
    expect(incomingPlanIdsForLine(working, "")).toBeNull();
    expect(incomingPayload(draft)).toEqual(before);
    expect(incomingPayload(draft).plans.map(plan => plan.id)).toEqual(["direct", "ivr-plan", "unused"]);
    expect(validateRingPlanDrafts(draft.plans, { groups: working.groups, destinationAllowlist: ["SK", "CZ"], planIdsInUse: [] }))
      .toContainEqual(expect.objectContaining({ path: draft.plans[2].key, code: "plan_empty" }));
  });

  it("uses the dialled return-line override without rewriting shared strategy or personal times", async () => {
    const source = await scopedDocument();
    const before = incomingPayload(incomingDraft(source));
    expect(incomingLineBehaviour(source.lines[2], "queue_first")).toEqual({ mode: "ring_first", strategyOverride: "ordered" });
    expect(incomingLineBehaviour({ ...source.lines[2], inboundCallMode: "ring_all" }, "queue_first"))
      .toEqual({ mode: "ring_first", strategyOverride: "all" });
    expect(incomingLineBehaviour({ ...source.lines[2], inboundCallMode: null }, "queue_first"))
      .toEqual({ mode: "queue_first", strategyOverride: null });
    expect(incomingLineBehaviour({ ...source.lines[2], inboundCallMode: null }, null))
      .toEqual({ mode: null, strategyOverride: null });
    expect(incomingPayload(incomingDraft(source))).toEqual(before);
  });
});
