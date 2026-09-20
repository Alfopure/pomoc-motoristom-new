import { describe, expect, it } from "vitest";
import { createTelephonyHarness, ORG } from "@/test/telephony-harness";
import { getRoutingDocument } from "@/server/telephony/config-service";
import { newGroupDraft, newMemberDraft } from "./ring-groups-model";
import { newPlanDraft, newStepDraft } from "./ring-plan-model";
import { documentWithDraft, identifyGroups, identifyPlans, incomingDraft, incomingMatches, incomingPayload } from "./incoming-routing-model";
async function document() { const harness = createTelephonyHarness(); return getRoutingDocument(harness.deps, { organizationId: ORG, includeSettings: true }); }
describe("combined routing draft", () => {
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
