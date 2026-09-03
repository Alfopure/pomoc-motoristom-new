import { describe, expect, it } from "vitest";

import type { IvrMenuDoc, LineDoc, RingGroupDoc, RingPlanDoc } from "@/server/telephony/config-service";

import {
  addStep,
  describeFallback,
  describeRingPlan,
  describeRingPlanParts,
  memberRingSeconds,
  moveStep,
  moveStepInPlans,
  newPlanDraft,
  planDraftsFromDocument,
  planHasRunnableStep,
  planUsageNote,
  removeStep,
  ringPlanIdsInUse,
  ringPlanSeconds,
  ringPlansDirty,
  ringPlansPayload,
  stepSeconds,
  updatePlan,
  updateStep,
  validateRingPlanDrafts,
  type PlanValidationContext,
} from "./ring-plan-model";

const OPERATOR_A = "11111111-1111-4111-8111-111111111111";
const OPERATOR_B = "22222222-2222-4222-8222-222222222222";

function member(overrides: Partial<RingGroupDoc["members"][number]> = {}): RingGroupDoc["members"][number] {
  return {
    id: "m1",
    memberKind: "operator",
    profileId: OPERATOR_A,
    externalNumber: null,
    position: 0,
    ringSecs: null,
    lastOfferedAt: null,
    lastAnsweredAt: null,
    ...overrides,
  };
}

function groupA(overrides: Partial<RingGroupDoc> = {}): RingGroupDoc {
  return {
    id: "group-a",
    name: "Dispečing A",
    description: null,
    active: true,
    members: [member(), member({ id: "m2", profileId: OPERATOR_B, position: 1 })],
    ...overrides,
  };
}

function groupB(overrides: Partial<RingGroupDoc> = {}): RingGroupDoc {
  return {
    id: "group-b",
    name: "Dispečing B",
    description: null,
    active: true,
    members: [member({ id: "m3", ringSecs: 15 }), member({ id: "m4", profileId: OPERATOR_B, position: 1, ringSecs: 15 })],
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
    steps: [
      { id: "s2", stepIndex: 1, ringGroupId: "group-b", timeoutSecs: 15, strategy: "ordered" },
      { id: "s1", stepIndex: 0, ringGroupId: "group-a", timeoutSecs: 20, strategy: "all" },
    ],
    ...overrides,
  };
}

function context(overrides: Partial<PlanValidationContext> = {}): PlanValidationContext {
  return { groups: [groupA(), groupB()], destinationAllowlist: ["SK", "CZ"], planIdsInUse: [], ...overrides };
}

describe("planDraftsFromDocument", () => {
  it("orders the steps by step index and keeps the ids", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    expect(draft.steps.map((step) => step.id)).toEqual(["s1", "s2"]);
    expect(draft.steps[0].timeoutSecs).toBe("20");
    expect(draft.fallbackNumber).toBe("");
  });
});

describe("moveStep", () => {
  it("renumbers step_index from the array order after a drag", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    const moved = moveStep(draft.steps, draft.steps[1].key, draft.steps[0].key);
    expect(moved.map((step) => step.id)).toEqual(["s2", "s1"]);

    const payload = ringPlansPayload([{ ...draft, steps: moved }]);
    expect(payload[0].steps.map((step) => [step.id, step.stepIndex])).toEqual([
      ["s2", 0],
      ["s1", 1],
    ]);
  });

  it("ignores a drop on itself or on an unknown row", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    expect(moveStep(draft.steps, draft.steps[0].key, draft.steps[0].key).map((step) => step.id)).toEqual(["s1", "s2"]);
    expect(moveStep(draft.steps, draft.steps[0].key, "nope").map((step) => step.id)).toEqual(["s1", "s2"]);
  });

  it("only reorders the plan it was asked for", () => {
    const drafts = planDraftsFromDocument([plan(), plan({ id: "plan-2", name: "Nočný" })]);
    const next = moveStepInPlans(drafts, drafts[0].key, drafts[0].steps[1].key, drafts[0].steps[0].key);
    expect(next[0].steps.map((step) => step.id)).toEqual(["s2", "s1"]);
    expect(next[1].steps.map((step) => step.id)).toEqual(["s1", "s2"]);
  });
});

describe("ringPlansPayload", () => {
  it("normalises the fallback number only when the fallback forwards", () => {
    let drafts = [newPlanDraft("Nočný")];
    drafts = updatePlan(drafts, drafts[0].key, { fallbackKind: "external_number", fallbackNumber: "0905 123 456" });
    expect(ringPlansPayload(drafts)[0]).toMatchObject({ fallbackKind: "external_number", fallbackNumber: "+421905123456" });

    drafts = updatePlan(drafts, drafts[0].key, { fallbackKind: "callback_prompt" });
    expect(ringPlansPayload(drafts)[0].fallbackNumber).toBeNull();
  });

  it("stays clean until a step actually changes", () => {
    const drafts = planDraftsFromDocument([plan()]);
    expect(ringPlansDirty(drafts, [plan()])).toBe(false);
    expect(ringPlansDirty(moveStepInPlans(drafts, drafts[0].key, drafts[0].steps[1].key, drafts[0].steps[0].key), [plan()])).toBe(true);
    expect(ringPlansDirty(updateStep(drafts, drafts[0].key, drafts[0].steps[0].key, { timeoutSecs: "30" }), [plan()])).toBe(true);
    expect(ringPlansDirty(removeStep(drafts, drafts[0].key, drafts[0].steps[0].key), [plan()])).toBe(true);
  });
});

describe("validateRingPlanDrafts", () => {
  function codes(drafts: ReturnType<typeof planDraftsFromDocument>, ctx = context()) {
    return validateRingPlanDrafts(drafts, ctx).map((issue) => issue.code);
  }

  it("accepts the seeded plan", () => {
    expect(codes(planDraftsFromDocument([plan()]))).toEqual([]);
  });

  it("demands a name and refuses two plans with the same one", () => {
    const drafts = planDraftsFromDocument([plan({ name: "" }), plan({ id: "plan-2" }), plan({ id: "plan-3", name: "denný" })]);
    expect(codes(drafts)).toEqual(["name_required", "duplicate_name"]);
  });

  it("refuses a plan without a step", () => {
    expect(codes(planDraftsFromDocument([plan({ steps: [] })]))).toEqual(["plan_empty"]);
  });

  it("keeps the step timeout between 5 and 120 seconds", () => {
    const drafts = planDraftsFromDocument([plan()]);
    expect(codes(updateStep(drafts, drafts[0].key, drafts[0].steps[0].key, { timeoutSecs: "4" }))).toEqual(["timeout_too_low"]);
    expect(codes(updateStep(drafts, drafts[0].key, drafts[0].steps[0].key, { timeoutSecs: "121" }))).toEqual(["timeout_too_high"]);
    expect(codes(updateStep(drafts, drafts[0].key, drafts[0].steps[0].key, { timeoutSecs: "20 s" }))).toEqual(["timeout_invalid"]);
    expect(codes(updateStep(drafts, drafts[0].key, drafts[0].steps[0].key, { timeoutSecs: "5" }))).toEqual([]);
    expect(codes(updateStep(drafts, drafts[0].key, drafts[0].steps[0].key, { timeoutSecs: "120" }))).toEqual([]);
  });

  it("demands a known and non-empty group in every step", () => {
    const drafts = planDraftsFromDocument([plan()]);
    expect(codes(updateStep(drafts, drafts[0].key, drafts[0].steps[0].key, { ringGroupId: "" }))).toEqual(["group_unknown"]);
    expect(codes(drafts, context({ groups: [groupA({ members: [] }), groupB()] }))).toEqual(["group_empty"]);
  });

  it("checks the forwarding fallback against E.164 and the allowlist", () => {
    const drafts = planDraftsFromDocument([plan({ fallbackKind: "external_number", fallbackNumber: null })]);
    expect(codes(drafts)).toEqual(["fallback_number_invalid"]);
    expect(codes(planDraftsFromDocument([plan({ fallbackKind: "external_number", fallbackNumber: "+49151222333" })]))).toEqual([
      "fallback_number_not_allowed",
    ]);
    expect(codes(planDraftsFromDocument([plan({ fallbackKind: "external_number", fallbackNumber: "0905123456" })]))).toEqual([]);
  });

  it("refuses to drop a plan a line still points at", () => {
    expect(codes([], context({ planIdsInUse: ["plan-1"] }))).toEqual(["plan_in_use"]);
    expect(codes(planDraftsFromDocument([plan()]), context({ planIdsInUse: ["plan-1"] }))).toEqual([]);
  });

  it("hangs each message on the row that caused it", () => {
    const drafts = planDraftsFromDocument([plan({ name: "" })]);
    const issues = validateRingPlanDrafts(updateStep(drafts, drafts[0].key, drafts[0].steps[0].key, { timeoutSecs: "1" }), context());
    expect(issues.map((item) => [item.path, item.code])).toEqual([
      [drafts[0].key, "name_required"],
      [drafts[0].steps[0].key, "timeout_too_low"],
    ]);
  });
});

describe("ring time arithmetic", () => {
  it("clamps a member's own ring time the way the runtime does", () => {
    expect(memberRingSeconds(null, 20)).toBe(20);
    expect(memberRingSeconds(15, 20)).toBe(15);
    expect(memberRingSeconds(2, 20)).toBe(5);
    expect(memberRingSeconds(null, 3)).toBe(5);
    expect(memberRingSeconds(300, 20)).toBe(120);
  });

  it("sums an ordered step and takes the timeout of an 'all' step", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    expect(stepSeconds(draft.steps[0], groupA())).toBe(20);
    expect(stepSeconds(draft.steps[1], groupB())).toBe(30);
    expect(ringPlanSeconds(draft, [groupA(), groupB()])).toBe(50);
  });

  it("counts nothing for a step whose group is missing, switched off or empty", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    expect(stepSeconds(draft.steps[0], undefined)).toBe(0);
    expect(stepSeconds(draft.steps[0], groupA({ active: false }))).toBe(0);
    expect(stepSeconds(draft.steps[0], groupA({ members: [] }))).toBe(0);
    expect(ringPlanSeconds(draft, [groupA({ active: false }), groupB()])).toBe(30);
  });
});

describe("plain-language preview", () => {
  it("reads back the seeded plan as one Slovak sentence", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    expect(describeRingPlan(draft, [groupA(), groupB()])).toBe(
      'Skupina „Dispečing A" zvoní všetkým 20 s, potom skupina „Dispečing B" zvoní po jednom po 15 s, potom ponuka spätného volania.',
    );
  });

  it("says when an ordered group rings every member for its own time", () => {
    const mixed = groupB({ members: [member({ id: "m3", ringSecs: 10 }), member({ id: "m4", profileId: OPERATOR_B, position: 1, ringSecs: 25 })] });
    const [draft] = planDraftsFromDocument([plan()]);
    expect(describeRingPlanParts(draft, [groupA(), mixed])[1]).toBe('skupina „Dispečing B" zvoní po jednom, každý svojím časom (spolu 35 s)');
  });

  it("warns that a step with no group, a switched-off group or an empty group is skipped", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    const parts = describeRingPlanParts(draft, [groupA({ active: false }), groupB({ members: [] })]);
    expect(parts[0]).toBe('skupina „Dispečing A" je vypnutá, krok sa preskočí');
    expect(parts[1]).toBe('skupina „Dispečing B" nemá žiadneho člena, krok sa preskočí');
    const orphan = updateStep([draft], draft.key, draft.steps[0].key, { ringGroupId: "" })[0];
    expect(describeRingPlanParts(orphan, [groupA(), groupB()])[0]).toBe("krok bez vybratej skupiny sa preskočí");
  });

  it("names every fallback in plain Slovak", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    expect(describeFallback(draft)).toBe("ponuka spätného volania");
    expect(describeFallback({ ...draft, fallbackKind: "waiting_room" })).toBe("hovor ostane v čakárni");
    expect(describeFallback({ ...draft, fallbackKind: "hangup_message" })).toBe("prehrá sa záverečná hláška a hovor sa ukončí");
    expect(describeFallback({ ...draft, fallbackKind: "external_number", fallbackNumber: "0905123456" })).toBe("presmerovanie na +421905123456");
    expect(describeFallback({ ...draft, fallbackKind: "external_number", fallbackNumber: "" })).toBe("presmerovanie na externé číslo");
  });

  it("describes a plan that has no step yet by what the engine really does", () => {
    const draft = newPlanDraft("Nový");
    // `startRingPlan` offers a callback *before* `applyFallback` is reached, so
    // the configured fallback is never consulted for a plan that freezes empty.
    expect(describeRingPlan(draft, [groupA()])).toBe(
      "Plán zatiaľ nemá žiadny krok — hovor dostane ponuku spätného volania — nastavené správanie po vyčerpaní plánu sa nepoužije, plán sa vôbec nespustí.",
    );
  });

  it("keeps the preview in step with a freshly added step", () => {
    const drafts = [newPlanDraft("Nový")];
    const withStep = addStep(drafts, drafts[0].key, "group-a");
    expect(withStep[0].steps).toHaveLength(1);
    expect(describeRingPlan(withStep[0], [groupA()])).toBe(
      'Skupina „Dispečing A" zvoní všetkým 20 s, potom ponuka spätného volania.',
    );
  });
});

describe("what the preview must not hide", () => {
  function line(overrides: Partial<LineDoc> = {}): LineDoc {
    return {
      id: "line-1",
      phoneNumber: "+421232408700",
      label: "Hlavná linka",
      partnerName: null,
      telnyxNumberId: null,
      ringPlanId: "plan-1",
      ivrMenuId: null,
      businessHoursId: null,
      environment: "production",
      active: true,
      ...overrides,
    };
  }

  function menu(overrides: Partial<IvrMenuDoc> = {}): IvrMenuDoc {
    return { id: "ivr-1", name: "Hlavné menu", active: true, ringPlanIds: ["plan-1"], ...overrides };
  }

  it("warns that an inactive plan a line uses skips ringing entirely", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    const groups = [groupA(), groupB()];
    expect(planUsageNote(draft, [line()], { groups })).toMatchObject({ tone: "info" });
    expect(planUsageNote({ ...draft, active: false }, [line()], { groups })).toMatchObject({ tone: "warning" });
    expect(planUsageNote({ ...draft, active: false }, [line()], { groups })?.text).toContain("Hlavná linka");
    expect(planUsageNote({ ...draft, active: false }, [line()], { groups })?.text).toContain("nezazvoní");
    // No line points at it: switching it off is harmless, so the note is calm.
    expect(planUsageNote({ ...draft, active: false }, [line({ ringPlanId: null })], { groups })).toMatchObject({ tone: "info" });
    expect(planUsageNote(draft, [line({ ringPlanId: null })], { groups })).toBeNull();
  });

  it("counts a plan an IVR digit targets as used and names the menu", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    const groups = [groupA(), groupB()];
    const detached = [line({ ringPlanId: null })];

    const note = planUsageNote({ ...draft, active: false }, detached, { groups, ivrMenus: [menu()] });
    expect(note).toMatchObject({ tone: "warning" });
    expect(note?.text).toContain("Hlavné menu");
    expect(note?.text).toContain("pôvodnom pláne linky");
    expect(planUsageNote(draft, detached, { groups, ivrMenus: [menu()] })).toMatchObject({ tone: "info" });
    // ...and it is refused for deletion exactly like a line's plan.
    expect(ringPlanIdsInUse(detached, [menu()])).toEqual(["plan-1"]);
    expect(ringPlanIdsInUse([line()], [menu()])).toEqual(["plan-1"]);
  });

  it("describes an inactive plan by the callback offer the engine really makes", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    expect(describeRingPlan({ ...draft, active: false }, [groupA(), groupB()])).toBe(
      "Plán je vypnutý — žiadny krok sa nevykoná a hovor dostane ponuku spätného volania — nastavené správanie po vyčerpaní plánu sa nepoužije, plán sa vôbec nespustí.",
    );
  });

  it("says the same when every step points at a switched-off group", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    const off = [groupA({ active: false }), groupB({ active: false })];
    // `materialiseRingPlan` drops inactive groups, so the plan freezes with zero
    // steps and `fallback_kind` (e.g. an on-call mobile) is never applied.
    expect(planHasRunnableStep(draft, off)).toBe(false);
    expect(describeRingPlan(draft, off)).toContain("neostane ani jeden krok");
    expect(planUsageNote(draft, [line()], { groups: off })).toMatchObject({ tone: "warning" });
    expect(planHasRunnableStep(draft, [groupA(), groupB({ active: false })])).toBe(true);
  });

  it("says how many members an `all` step really reaches under the fan-out cap", () => {
    const [draft] = planDraftsFromDocument([plan()]);
    // Two members, cap 1: `planRingStep` slices the eligible list and finishes
    // the step after that single fan-out, so the second member never rings.
    expect(describeRingPlanParts(draft, [groupA(), groupB()], 1)[0]).toBe(
      'skupina „Dispečing A" zvoní naraz najviac 1 z 2 členov (limit organizácie) 20 s, na ostatných sa v tomto kroku nedostane',
    );
    expect(describeRingPlanParts(draft, [groupA(), groupB()], 8)[0]).toBe('skupina „Dispečing A" zvoní všetkým 20 s');
    // An `ordered` step is unaffected: it dials one member at a time.
    expect(describeRingPlanParts(draft, [groupA(), groupB()], 1)[1]).toBe('skupina „Dispečing B" zvoní po jednom po 15 s');
  });
});
