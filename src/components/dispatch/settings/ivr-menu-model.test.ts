import { describe, expect, it } from "vitest";

import { validateIvrMenus, type IvrMenuDoc, type LineDoc, type RingPlanDoc, type ValidationContext } from "@/server/telephony/config-service";

import {
  addIvrMenu,
  addIvrOption,
  describeIvrOption,
  ivrMenuDraftsFromDocument,
  ivrMenuWarnings,
  ivrMenusDirty,
  ivrMenusInUseWarning,
  ivrMenusPayload,
  nextFreeDigit,
  removeIvrMenu,
  removeIvrOption,
  updateIvrMenu,
  updateIvrOption,
  validateIvrMenuDrafts,
} from "./ivr-menu-model";

const PLAN_ID = "00000000-0000-4000-8000-000000002301";
const MENU_ID = "00000000-0000-4000-8000-000000002401";

function plan(overrides: Partial<RingPlanDoc> = {}): RingPlanDoc {
  return { id: PLAN_ID, name: "Denný", fallbackKind: "callback_prompt", fallbackNumber: null, active: true, steps: [], ...overrides };
}

function line(overrides: Partial<LineDoc> = {}): LineDoc {
  return {
    id: "line-1",
    phoneNumber: "+421232408700",
    label: "Neutrálna linka",
    partnerName: null,
    telnyxNumberId: null,
    ringPlanId: PLAN_ID,
    ivrMenuId: MENU_ID,
    businessHoursId: null,
    environment: "production",
    active: true,
    ...overrides,
  };
}

function menu(overrides: Partial<IvrMenuDoc> = {}): IvrMenuDoc {
  return {
    id: MENU_ID,
    name: "Hlavné menu",
    active: true,
    promptMediaUrl: "ivr-main.mp3",
    ttsText: null,
    invalidMediaUrl: "invalid-input.mp3",
    timeoutSecs: 5,
    maxTries: 2,
    options: [
      { id: "opt-2", digit: "2", action: "callback", targetRingPlanId: null, targetNumber: null, label: "Spätné volanie", promptMediaUrl: "callback-offer.mp3", ttsText: null },
      { id: "opt-1", digit: "1", action: "ring_plan", targetRingPlanId: PLAN_ID, targetNumber: null, label: "Dispečing", promptMediaUrl: null, ttsText: null },
    ],
    ringPlanIds: [PLAN_ID],
    ...overrides,
  };
}

const CONTEXT = { plans: [plan()] };

function serverContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    organizationId: "org-1",
    profileIds: new Set<string>(),
    lineIds: new Set(["line-1"]),
    ivrMenuIds: new Set([MENU_ID]),
    businessHoursIds: new Set<string>(),
    ringPlanIds: new Set([PLAN_ID]),
    businessHoursInUse: new Set<string>(),
    ringPlansInUse: new Set([PLAN_ID]),
    ivrMenusInUse: new Set([MENU_ID]),
    destinationAllowlist: ["SK"],
    groups: [],
    plans: [],
    ...overrides,
  };
}

function codes(issues: Array<{ code: string }>): string[] {
  return issues.map((issue) => issue.code);
}

describe("drafting", () => {
  it("orders the options by the digit the caller presses", () => {
    const [draft] = ivrMenuDraftsFromDocument([menu()]);
    expect(draft.options.map((option) => option.digit)).toEqual(["1", "2"]);
    expect(draft.timeoutSecs).toBe("5");
    expect(draft.maxTries).toBe("2");
  });

  it("suggests the next free key, in the order a prompt announces them", () => {
    const [draft] = ivrMenuDraftsFromDocument([menu()]);
    expect(nextFreeDigit(draft.options)).toBe("3");
    const full = "1234567890*#".split("").map((digit) => ({ ...draft.options[0], key: `k-${digit}`, digit }));
    expect(nextFreeDigit(full)).toBe("");
  });

  it("adds and removes menus and options", () => {
    const drafts = addIvrMenu(ivrMenuDraftsFromDocument([menu()]));
    expect(drafts).toHaveLength(2);
    const withOption = addIvrOption(drafts, drafts[0].key);
    expect(withOption[0].options.map((option) => option.digit)).toEqual(["1", "2", "3"]);
    expect(removeIvrOption(withOption, drafts[0].key, withOption[0].options[2].key)[0].options).toHaveLength(2);
    expect(removeIvrMenu(drafts, drafts[1].key)).toHaveLength(1);
  });

  it("drops the target that no longer belongs to the chosen action", () => {
    const drafts = ivrMenuDraftsFromDocument([menu()]);
    const optionKey = drafts[0].options[0].key;
    const switched = updateIvrOption(drafts, drafts[0].key, optionKey, { action: "external_number" });
    expect(switched[0].options[0]).toMatchObject({ action: "external_number", targetRingPlanId: null });

    const back = updateIvrOption(switched, drafts[0].key, optionKey, { targetNumber: "+421900123456" });
    expect(updateIvrOption(back, drafts[0].key, optionKey, { action: "waiting_room" })[0].options[0]).toMatchObject({ targetNumber: "", targetRingPlanId: null });
  });

  it("only reports a change once something actually changed", () => {
    const drafts = ivrMenuDraftsFromDocument([menu()]);
    expect(ivrMenusDirty(drafts, [menu()])).toBe(false);
    expect(ivrMenusDirty(updateIvrMenu(drafts, drafts[0].key, { maxTries: "3" }), [menu()])).toBe(true);
  });
});

describe("payload", () => {
  it("sends the options in digit order and clears the targets the action ignores", () => {
    const drafts = updateIvrOption(ivrMenuDraftsFromDocument([menu()]), `ivr-menu-${MENU_ID}`, "ivr-option-opt-2", { targetNumber: "+421900123456" });
    const [payload] = ivrMenusPayload(drafts);

    expect(payload.options.map((option) => option.digit)).toEqual(["1", "2"]);
    // Digit 2 is a callback, so the number the draft still carried is not sent.
    expect(payload.options[1]).toMatchObject({ action: "callback", targetNumber: null, targetRingPlanId: null, promptMediaUrl: "callback-offer.mp3" });
    expect(payload.options[0]).toMatchObject({ action: "ring_plan", targetRingPlanId: PLAN_ID });
    expect(payload).toMatchObject({ timeoutSecs: 5, maxTries: 2, promptMediaUrl: "ivr-main.mp3", ttsText: null });
  });

  it("keeps a half-typed number out of the payload as NaN, so the save stays blocked", () => {
    const drafts = updateIvrMenu(ivrMenuDraftsFromDocument([menu()]), `ivr-menu-${MENU_ID}`, { maxTries: "" });
    expect(Number.isNaN(ivrMenusPayload(drafts)[0].maxTries)).toBe(true);
    expect(codes(validateIvrMenuDrafts(drafts, CONTEXT))).toEqual(["tries_invalid"]);
  });
});

describe("validation mirror", () => {
  it("accepts the seeded menu on both sides", () => {
    const drafts = ivrMenuDraftsFromDocument([menu()]);
    expect(validateIvrMenuDrafts(drafts, CONTEXT)).toEqual([]);
    expect(validateIvrMenus(ivrMenusPayload(drafts), serverContext())).toEqual([]);
  });

  it("refuses a duplicate key, a missing label and an unknown key", () => {
    let drafts = ivrMenuDraftsFromDocument([menu()]);
    drafts = updateIvrOption(drafts, drafts[0].key, "ivr-option-opt-2", { digit: "1", label: "" });
    expect(codes(validateIvrMenuDrafts(drafts, CONTEXT))).toEqual(["duplicate_digit", "label_required"]);

    drafts = updateIvrOption(drafts, drafts[0].key, "ivr-option-opt-2", { digit: "A", label: "Späť" });
    expect(codes(validateIvrMenuDrafts(drafts, CONTEXT))).toEqual(["digit_invalid"]);
    expect(codes(validateIvrMenus(ivrMenusPayload(drafts), serverContext()))).toEqual(["digit_invalid"]);
  });

  it("refuses an option that routes nowhere", () => {
    let drafts = ivrMenuDraftsFromDocument([menu()]);
    drafts = updateIvrOption(drafts, drafts[0].key, "ivr-option-opt-1", { targetRingPlanId: null });
    expect(codes(validateIvrMenuDrafts(drafts, CONTEXT))).toEqual(["plan_required"]);

    drafts = updateIvrOption(drafts, drafts[0].key, "ivr-option-opt-1", { action: "external_number", targetNumber: "0900 nieco" });
    expect(codes(validateIvrMenuDrafts(drafts, CONTEXT))).toEqual(["number_invalid"]);
    expect(codes(validateIvrMenus(ivrMenusPayload(drafts), serverContext()))).toEqual(["number_invalid"]);
  });

  it("refuses a menu with neither a recording nor a text, and a nonsense recording", () => {
    let drafts = updateIvrMenu(ivrMenuDraftsFromDocument([menu()]), `ivr-menu-${MENU_ID}`, { promptMediaUrl: "" });
    expect(codes(validateIvrMenuDrafts(drafts, CONTEXT))).toEqual(["prompt_required"]);

    drafts = updateIvrMenu(drafts, `ivr-menu-${MENU_ID}`, { promptMediaUrl: "http://media.test/x.mp3" });
    expect(codes(validateIvrMenuDrafts(drafts, CONTEXT))).toEqual(["prompt_invalid"]);
    expect(codes(validateIvrMenus(ivrMenusPayload(drafts), serverContext()))).toEqual(["prompt_invalid"]);
  });

  it("refuses two menus with the same name and an option pointing at a foreign plan", () => {
    const drafts = [...ivrMenuDraftsFromDocument([menu()]), { ...ivrMenuDraftsFromDocument([menu()])[0], key: "second", id: null }];
    expect(codes(validateIvrMenuDrafts(drafts, CONTEXT))).toContain("duplicate_name");

    const foreign = updateIvrOption(ivrMenuDraftsFromDocument([menu()]), `ivr-menu-${MENU_ID}`, "ivr-option-opt-1", { targetRingPlanId: "00000000-0000-4000-8000-0000000029ff" });
    expect(codes(validateIvrMenuDrafts(foreign, CONTEXT))).toEqual(["plan_foreign"]);
    expect(codes(validateIvrMenus(ivrMenusPayload(foreign), serverContext()))).toEqual(["plan_foreign"]);
  });

  it("agrees with the server that a menu a number uses cannot be deleted", () => {
    expect(ivrMenusInUseWarning([], [line()])).toContain("Neutrálna linka");
    expect(ivrMenusInUseWarning(ivrMenuDraftsFromDocument([menu()]), [line()])).toBeNull();
    expect(codes(validateIvrMenus([], serverContext()))).toEqual(["ivr_menu_in_use"]);
  });
});

describe("warnings and descriptions", () => {
  it("says what the caller will experience", () => {
    const [draft] = ivrMenuDraftsFromDocument([menu({ active: false })]);
    const messages = ivrMenuWarnings(draft, [line()]).map((warning) => warning.message);
    expect(messages.some((message) => message.includes("vypnuté"))).toBe(true);

    const unused = ivrMenuWarnings(ivrMenuDraftsFromDocument([menu()])[0], [line({ ivrMenuId: null })]);
    expect(unused[0].message).toContain("nepoužíva žiadne číslo");
  });

  it("warns about a recording nothing will play and a silent hangup", () => {
    const drafts = updateIvrOption(ivrMenuDraftsFromDocument([menu()]), `ivr-menu-${MENU_ID}`, "ivr-option-opt-1", { promptMediaUrl: "odkaz.mp3" });
    const ignored = ivrMenuWarnings(drafts[0], [line()]).find((warning) => warning.message.includes("neprehrá"));
    expect(ignored).toBeDefined();

    const silent = updateIvrOption(ivrMenuDraftsFromDocument([menu()]), `ivr-menu-${MENU_ID}`, "ivr-option-opt-1", { action: "hangup" });
    expect(ivrMenuWarnings(silent[0], [line()]).some((warning) => warning.message.includes("bez odkazu"))).toBe(true);
  });

  it("describes an option in one sentence, including a switched-off plan", () => {
    const [draft] = ivrMenuDraftsFromDocument([menu()]);
    expect(describeIvrOption(draft.options[0], CONTEXT)).toBe("Zazvoní podľa plánu „Denný“.");
    expect(describeIvrOption(draft.options[0], { plans: [plan({ active: false })] })).toContain("vypnutý");
    expect(describeIvrOption(draft.options[1], CONTEXT)).toContain("spätné volanie");
  });
});
