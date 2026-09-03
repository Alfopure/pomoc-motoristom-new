import { describe, expect, it } from "vitest";

import type { RingGroupDoc, RingPlanDoc } from "@/server/telephony/config-service";

import {
  addMember,
  groupDraftsFromDocument,
  groupFanoutNote,
  groupUsageNote,
  issuesByPath,
  memberRingSecsNote,
  moveMember,
  moveMemberInGroups,
  newGroupDraft,
  plansUsingGroup,
  removeMember,
  ringGroupsDirty,
  ringGroupsPayload,
  updateMember,
  validateRingGroupDrafts,
  type GroupValidationContext,
} from "./ring-groups-model";

const OPERATOR_A = "11111111-1111-4111-8111-111111111111";
const OPERATOR_B = "22222222-2222-4222-8222-222222222222";

function group(overrides: Partial<RingGroupDoc> = {}): RingGroupDoc {
  return {
    id: "group-a",
    name: "Dispečing A",
    description: null,
    active: true,
    members: [
      { id: "m2", memberKind: "operator", profileId: OPERATOR_B, externalNumber: null, position: 1, ringSecs: null, lastOfferedAt: null, lastAnsweredAt: null },
      { id: "m1", memberKind: "operator", profileId: OPERATOR_A, externalNumber: null, position: 0, ringSecs: 15, lastOfferedAt: null, lastAnsweredAt: null },
    ],
    ...overrides,
  };
}

function plan(overrides: Partial<RingPlanDoc> = {}): RingPlanDoc {
  return {
    id: "plan-1",
    name: "Denný",
    fallbackKind: "callback_prompt",
    fallbackNumber: null,
    active: true,
    steps: [{ id: "s1", stepIndex: 0, ringGroupId: "group-a", timeoutSecs: 20, strategy: "all" }],
    ...overrides,
  };
}

function context(overrides: Partial<GroupValidationContext> = {}): GroupValidationContext {
  return { operatorIds: [OPERATOR_A, OPERATOR_B], destinationAllowlist: ["SK", "CZ"], plans: [], ...overrides };
}

describe("groupDraftsFromDocument", () => {
  it("orders members by position and turns an absent ring time into an empty field", () => {
    const [draft] = groupDraftsFromDocument([group()]);
    expect(draft.members.map((member) => member.id)).toEqual(["m1", "m2"]);
    expect(draft.members[0].ringSecs).toBe("15");
    expect(draft.members[1].ringSecs).toBe("");
  });
});

describe("moveMember", () => {
  it("moves a row and renumbers the positions in the payload", () => {
    const [draft] = groupDraftsFromDocument([group()]);
    const moved = moveMember(draft.members, draft.members[1].key, draft.members[0].key);
    expect(moved.map((member) => member.id)).toEqual(["m2", "m1"]);

    const payload = ringGroupsPayload([{ ...draft, members: moved }]);
    expect(payload[0].members.map((member) => [member.id, member.position])).toEqual([
      ["m2", 0],
      ["m1", 1],
    ]);
  });

  it("keeps the list untouched when the row is dropped on itself or on an unknown key", () => {
    const [draft] = groupDraftsFromDocument([group()]);
    expect(moveMember(draft.members, draft.members[0].key, draft.members[0].key).map((member) => member.id)).toEqual(["m1", "m2"]);
    expect(moveMember(draft.members, draft.members[0].key, "nope").map((member) => member.id)).toEqual(["m1", "m2"]);
  });

  it("only reorders the group it was asked for", () => {
    const drafts = groupDraftsFromDocument([group(), group({ id: "group-b", name: "Dispečing B" })]);
    const next = moveMemberInGroups(drafts, drafts[0].key, drafts[0].members[1].key, drafts[0].members[0].key);
    expect(next[0].members.map((member) => member.id)).toEqual(["m2", "m1"]);
    expect(next[1].members.map((member) => member.id)).toEqual(["m1", "m2"]);
  });
});

describe("ringGroupsPayload", () => {
  it("normalises an external number, drops the operator field and keeps ids", () => {
    let drafts = [newGroupDraft("Mobil")];
    drafts = addMember(drafts, drafts[0].key, "external_number");
    drafts = updateMember(drafts, drafts[0].key, drafts[0].members[0].key, { externalNumber: "0905 123 456", ringSecs: "25" });
    const payload = ringGroupsPayload(drafts);
    expect(payload[0]).toMatchObject({ id: null, name: "Mobil", active: true });
    expect(payload[0].members[0]).toMatchObject({ memberKind: "external_number", profileId: null, externalNumber: "+421905123456", position: 0, ringSecs: 25 });
  });

  it("reports the document unchanged until something actually moves", () => {
    const drafts = groupDraftsFromDocument([group()]);
    expect(ringGroupsDirty(drafts, [group()])).toBe(false);
    const moved = moveMemberInGroups(drafts, drafts[0].key, drafts[0].members[1].key, drafts[0].members[0].key);
    expect(ringGroupsDirty(moved, [group()])).toBe(true);
    expect(ringGroupsDirty(removeMember(drafts, drafts[0].key, drafts[0].members[0].key), [group()])).toBe(true);
  });
});

describe("validateRingGroupDrafts", () => {
  function codes(drafts: ReturnType<typeof groupDraftsFromDocument>, ctx = context()) {
    return validateRingGroupDrafts(drafts, ctx).map((issue) => issue.code);
  }

  it("accepts the seeded shape", () => {
    expect(codes(groupDraftsFromDocument([group()]))).toEqual([]);
  });

  it("demands a name and refuses two groups with the same one", () => {
    const drafts = groupDraftsFromDocument([group({ name: "" }), group({ id: "group-b", name: "dispečing a" }), group({ id: "group-c" })]);
    expect(codes(drafts)).toEqual(["name_required", "duplicate_name"]);
  });

  it("checks the operator member: chosen, of this organisation, only once", () => {
    const missing = groupDraftsFromDocument([
      group({ members: [{ id: "m1", memberKind: "operator", profileId: null, externalNumber: null, position: 0, ringSecs: null, lastOfferedAt: null, lastAnsweredAt: null }] }),
    ]);
    expect(codes(missing)).toEqual(["profile_required"]);

    const foreign = groupDraftsFromDocument([group()]);
    expect(codes(foreign, context({ operatorIds: [OPERATOR_A] }))).toEqual(["profile_foreign"]);

    const twice = groupDraftsFromDocument([
      group({
        members: [
          { id: "m1", memberKind: "operator", profileId: OPERATOR_A, externalNumber: null, position: 0, ringSecs: null, lastOfferedAt: null, lastAnsweredAt: null },
          { id: "m2", memberKind: "operator", profileId: OPERATOR_A, externalNumber: null, position: 1, ringSecs: null, lastOfferedAt: null, lastAnsweredAt: null },
        ],
      }),
    ]);
    expect(codes(twice)).toEqual(["duplicate_member"]);
  });

  it("checks an external member against E.164, the allowlist and duplicates", () => {
    function external(number: string, position = 0) {
      return { id: `x${position}`, memberKind: "external_number" as const, profileId: null, externalNumber: number, position, ringSecs: null, lastOfferedAt: null, lastAnsweredAt: null };
    }
    expect(codes(groupDraftsFromDocument([group({ members: [external("klapka 12")] })]))).toEqual(["number_invalid"]);
    expect(codes(groupDraftsFromDocument([group({ members: [external("+49151222333")] })]))).toEqual(["number_not_allowed"]);
    expect(codes(groupDraftsFromDocument([group({ members: [external("+421905123456", 0), external("0905123456", 1)] })]))).toEqual(["duplicate_member"]);
  });

  it("keeps the per-member ring time between 5 and 120 seconds", () => {
    const drafts = groupDraftsFromDocument([group()]);
    const tooLow = updateMember(drafts, drafts[0].key, drafts[0].members[0].key, { ringSecs: "3" });
    expect(codes(tooLow)).toEqual(["ring_secs_too_low"]);
    const tooHigh = updateMember(drafts, drafts[0].key, drafts[0].members[0].key, { ringSecs: "300" });
    expect(codes(tooHigh)).toEqual(["ring_secs_too_high"]);
    const nonsense = updateMember(drafts, drafts[0].key, drafts[0].members[0].key, { ringSecs: "20 s" });
    expect(codes(nonsense)).toEqual(["ring_secs_invalid"]);
    const empty = updateMember(drafts, drafts[0].key, drafts[0].members[0].key, { ringSecs: "" });
    expect(codes(empty)).toEqual([]);
  });

  it("refuses to empty or drop a group that a plan step still uses", () => {
    const drafts = groupDraftsFromDocument([group()]);
    const emptied = removeMember(removeMember(drafts, drafts[0].key, drafts[0].members[0].key), drafts[0].key, drafts[0].members[1].key);
    expect(codes(emptied, context({ plans: [plan()] }))).toEqual(["group_empty"]);
    expect(codes([], context({ plans: [plan()] }))).toEqual(["group_in_use"]);
  });

  it("hangs each message on the row that caused it", () => {
    const drafts = groupDraftsFromDocument([group({ name: "" })]);
    const byPath = issuesByPath(validateRingGroupDrafts(drafts, context({ operatorIds: [] })));
    expect(byPath.get(drafts[0].key)?.map((issue) => issue.code)).toEqual(["name_required"]);
    expect(byPath.get(drafts[0].members[0].key)?.map((issue) => issue.code)).toEqual(["profile_foreign"]);
  });
});

describe("plansUsingGroup", () => {
  it("names the plans that keep a group alive", () => {
    expect(plansUsingGroup("group-a", [plan(), plan({ id: "plan-2", name: "Nočný", steps: [] })])).toEqual(["Denný"]);
    expect(plansUsingGroup(null, [plan()])).toEqual([]);
  });
});

describe("groupUsageNote", () => {
  it("lists the plans, and warns that a switched-off group makes them skip the step", () => {
    const [draft] = groupDraftsFromDocument([group()]);
    expect(groupUsageNote(draft, [plan()])).toBe("Používajú ju plány: Denný.");
    expect(groupUsageNote({ ...draft, active: false }, [plan()])).toBe("Skupina je vypnutá, v týchto plánoch sa krok preskočí: Denný.");
  });

  it("says nothing about an active group no plan uses", () => {
    const [draft] = groupDraftsFromDocument([group()]);
    expect(groupUsageNote(draft, [])).toBeNull();
    expect(groupUsageNote({ ...draft, active: false }, [])).toBe("Skupina je vypnutá a zatiaľ ju nepoužíva žiadny plán.");
  });
});

describe("notes about what the ring engine really does", () => {
  it("warns when a group is bigger than the organisation fan-out cap", () => {
    const [draft] = groupDraftsFromDocument([group()]);
    const usedByAll = [plan()];
    expect(groupFanoutNote(draft, usedByAll, 8)).toBeNull();
    expect(groupFanoutNote(draft, usedByAll, 1)).toContain("najviac 1");
    // An `ordered` step dials one member at a time, so the cap never truncates it.
    const orderedPlan: RingPlanDoc = { ...plan(), steps: plan().steps.map((step) => ({ ...step, strategy: "ordered" as const })) };
    expect(groupFanoutNote(draft, [orderedPlan], 1)).toBeNull();
    expect(groupFanoutNote(draft, [], 1)).toBeNull();
  });

  it("warns that a per-member ring time is inert in an `all` step", () => {
    const [draft] = groupDraftsFromDocument([group()]);
    const withTime = { ...draft, members: draft.members.map((member, index) => (index === 0 ? { ...member, ringSecs: "60" } : member)) };
    const withoutTime = { ...draft, members: draft.members.map((member) => ({ ...member, ringSecs: "" })) };
    expect(memberRingSecsNote(withoutTime, [plan()])).toBeNull();
    expect(memberRingSecsNote(withTime, [plan()])).toContain("postupne");
    const orderedPlan: RingPlanDoc = { ...plan(), steps: plan().steps.map((step) => ({ ...step, strategy: "ordered" as const })) };
    expect(memberRingSecsNote(withTime, [orderedPlan])).toBeNull();
  });
});
