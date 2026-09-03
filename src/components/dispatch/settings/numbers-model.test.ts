import { describe, expect, it } from "vitest";

import { validateLinePatch } from "@/server/telephony/config-service";
import type { BusinessHoursDoc, IvrMenuDoc, LineDoc, RingPlanDoc } from "@/server/telephony/config-service";

import {
  ENVIRONMENT_LABELS,
  describeLineRouting,
  describeLineTitle,
  dirtyLineIds,
  findLine,
  lineDirty,
  lineDraftsFromDocument,
  linePatch,
  lineWarnings,
  updateLine,
  validateLineDraft,
  validateLineDrafts,
  type LineValidationContext,
} from "./numbers-model";

function line(overrides: Partial<LineDoc> = {}): LineDoc {
  return {
    id: "line-1",
    phoneNumber: "+421232408718",
    label: "Hlavná linka",
    partnerName: null,
    telnyxNumberId: "tn-1",
    ringPlanId: "plan-1",
    ivrMenuId: "ivr-1",
    businessHoursId: "hours-1",
    environment: "production",
    active: true,
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
    steps: [{ id: "step-1", stepIndex: 0, ringGroupId: "group-1", timeoutSecs: 20, strategy: "all" }],
    ...overrides,
  };
}

function hours(overrides: Partial<BusinessHoursDoc> = {}): BusinessHoursDoc {
  return { id: "hours-1", name: "Dispečing", timezone: "Europe/Bratislava", active: true, intervals: [], exceptions: [], ...overrides };
}

function menu(overrides: Partial<IvrMenuDoc> = {}): IvrMenuDoc {
  return { id: "ivr-1", name: "Hlavné menu", active: true, ...overrides };
}

const CONTEXT: LineValidationContext = { plans: [plan()], ivrMenus: [menu()], businessHours: [hours()] };

describe("lineDraftsFromDocument", () => {
  it("sorts by number and turns a missing partner into an empty field", () => {
    const drafts = lineDraftsFromDocument([line({ id: "line-2", phoneNumber: "+421900000000" }), line()]);
    expect(drafts.map((draft) => draft.id)).toEqual(["line-1", "line-2"]);
    expect(drafts[0].partnerName).toBe("");
  });
});

describe("linePatch", () => {
  it("is empty for an untouched line", () => {
    const [draft] = lineDraftsFromDocument([line()]);
    expect(linePatch(draft, line())).toEqual({});
    expect(lineDirty(draft, line())).toBe(false);
  });

  it("carries only the fields that changed", () => {
    const drafts = lineDraftsFromDocument([line()]);
    const edited = updateLine(drafts, "line-1", { label: " Partnerská linka ", partnerName: "ČSOB", ringPlanId: null });
    expect(linePatch(edited[0], line())).toEqual({ label: "Partnerská linka", partnerName: "ČSOB", ringPlanId: null });
  });

  it("treats an emptied partner as null and reports the dirty ids", () => {
    const drafts = lineDraftsFromDocument([line({ partnerName: "ČSOB" }), line({ id: "line-2", phoneNumber: "+421900000000" })]);
    const edited = updateLine(drafts, "line-1", { partnerName: "   " });
    expect(linePatch(edited[0], line({ partnerName: "ČSOB" }))).toEqual({ partnerName: null });
    expect(dirtyLineIds(edited, [line({ partnerName: "ČSOB" }), line({ id: "line-2", phoneNumber: "+421900000000" })])).toEqual(["line-1"]);
  });

  it("switches the environment and the active flag", () => {
    const drafts = lineDraftsFromDocument([line()]);
    const edited = updateLine(drafts, "line-1", { environment: "development", active: false });
    expect(linePatch(edited[0], line())).toEqual({ environment: "development", active: false });
  });

  it("finds the stored line behind a draft", () => {
    expect(findLine([line()], "line-1")?.phoneNumber).toBe("+421232408718");
    expect(findLine([line()], "missing")).toBeNull();
  });
});

describe("validateLineDraft", () => {
  it("accepts a fully wired line", () => {
    const [draft] = lineDraftsFromDocument([line()]);
    expect(validateLineDrafts([draft], CONTEXT)).toEqual([]);
  });

  it("requires a label", () => {
    const drafts = updateLine(lineDraftsFromDocument([line()]), "line-1", { label: "  " });
    expect(validateLineDraft(drafts[0], CONTEXT)).toEqual([{ path: "line-1", code: "label_required", message: "Linka potrebuje štítok." }]);
  });

  it("rejects a plan, IVR menu or schedule from another organisation", () => {
    const drafts = updateLine(lineDraftsFromDocument([line()]), "line-1", { ringPlanId: "foreign", ivrMenuId: "foreign", businessHoursId: "foreign" });
    expect(validateLineDraft(drafts[0], CONTEXT).map((entry) => entry.code)).toEqual(["plan_foreign", "ivr_foreign", "hours_foreign"]);
  });

  it("agrees with the server validator on the same patch", () => {
    const drafts = updateLine(lineDraftsFromDocument([line()]), "line-1", { ringPlanId: "foreign", businessHoursId: "foreign" });
    const local = validateLineDraft(drafts[0], CONTEXT).map((entry) => entry.code);
    const server = validateLinePatch(linePatch(drafts[0], line()), {
      organizationId: "org",
      profileIds: new Set(),
      lineIds: new Set(["line-1"]),
      ivrMenuIds: new Set(["ivr-1"]),
      businessHoursIds: new Set(["hours-1"]),
      ringPlanIds: new Set(["plan-1"]),
      businessHoursInUse: new Set(),
      ringPlansInUse: new Set(),
      destinationAllowlist: ["SK"],
      groups: [],
      plans: [],
    }).map((entry) => entry.code);
    expect(server).toEqual(local);
  });
});

describe("lineWarnings", () => {
  it("says nothing about a healthy production line", () => {
    const [draft] = lineDraftsFromDocument([line()]);
    expect(lineWarnings(draft, CONTEXT)).toEqual([]);
  });

  it("explains an inactive line and stops there", () => {
    const drafts = updateLine(lineDraftsFromDocument([line()]), "line-1", { active: false, ringPlanId: null });
    expect(lineWarnings(drafts[0], CONTEXT)).toEqual(["Linka je vypnutá — hovor na toto číslo sa nespracuje a nedá sa z nej ani volať von."]);
  });

  it("warns about a missing plan, an inactive schedule and an inactive IVR menu", () => {
    const drafts = updateLine(lineDraftsFromDocument([line()]), "line-1", { ringPlanId: null });
    const warnings = lineWarnings(drafts[0], { ...CONTEXT, businessHours: [hours({ active: false })], ivrMenus: [menu({ active: false })] });
    expect(warnings[0]).toContain("nemá plán zvonenia");
    expect(warnings[1]).toContain("sú vypnuté");
    expect(warnings[2]).toContain("IVR menu");
  });

  it("warns about a switched-off plan and a plan without steps", () => {
    const [draft] = lineDraftsFromDocument([line()]);
    expect(lineWarnings(draft, { ...CONTEXT, plans: [plan({ active: false })] })[0]).toContain("je vypnutý");
    expect(lineWarnings(draft, { ...CONTEXT, plans: [plan({ steps: [] })] })[0]).toContain("nemá žiadny krok");
  });

  it("marks a development line", () => {
    const drafts = updateLine(lineDraftsFromDocument([line()]), "line-1", { environment: "development" });
    expect(lineWarnings(drafts[0], CONTEXT)).toEqual(["Linka je označená ako testovacia; ak pre to isté číslo existuje produkčná linka, v produkcii má prednosť ona."]);
  });

  it("warns when the line has no schedule at all", () => {
    const drafts = updateLine(lineDraftsFromDocument([line()]), "line-1", { businessHoursId: null });
    expect(lineWarnings(drafts[0], CONTEXT)).toEqual(["Linka nemá otváracie hodiny — zvoní nonstop."]);
  });
});

describe("descriptions", () => {
  it("summarises the routing chain and the header", () => {
    const [draft] = lineDraftsFromDocument([line({ partnerName: "ČSOB" })]);
    expect(describeLineRouting(draft, CONTEXT)).toBe('hodiny „Dispečing" → IVR „Hlavné menu" → plán „Denný".');
    expect(describeLineTitle(draft)).toContain("Hlavná linka (ČSOB)");
    const bare = updateLine(lineDraftsFromDocument([line()]), "line-1", { label: "", ringPlanId: null, ivrMenuId: null, businessHoursId: null });
    expect(describeLineRouting(bare[0], CONTEXT)).toBe("bez otváracích hodín → bez IVR → bez plánu zvonenia.");
    expect(describeLineTitle(bare[0])).toContain("bez štítku");
  });

  it("labels both environments in Slovak", () => {
    expect(ENVIRONMENT_LABELS.production).toBe("Produkcia");
    expect(ENVIRONMENT_LABELS.development).toBe("Test / vývoj");
  });
});
