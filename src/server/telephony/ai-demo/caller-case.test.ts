import { describe, expect, it } from "vitest";

import { createFakeSupabase } from "@/test/fake-supabase";

import { describeAfterVerification, describeBeforeVerification, fullDisclosureEnabled, lookupCallerCase } from "./caller-case";

function depsWith(seed: (fake: ReturnType<typeof createFakeSupabase>) => void) {
  const fake = createFakeSupabase();
  seed(fake);
  return { admin: fake.admin, organizationId: "org" } as never;
}

const CONTACT = { id: "contact", organization_id: "org", name: "Jana Nováková", phone: "+421910988882" };
const VEHICLE = { id: "vehicle", organization_id: "org", license_plate: "BL123AB", make: "Škoda", model: "Octavia" };
const CASE = {
  id: "case", organization_id: "org", case_number: "2026-0042", status: "in_progress",
  created_at: "2026-09-12T08:00:00Z", summary: "Porucha na diaľnici", main_note: "Klient čaká pri odpočívadle",
  contact_id: "contact", vehicle_id: "vehicle",
};

describe("lookupCallerCase", () => {
  it("finds the open case belonging to the number that called", async () => {
    const deps = depsWith((fake) => {
      fake.db.seed("motorist_contacts", [CONTACT]);
      fake.db.seed("motorist_cases", [CASE]);
      fake.db.seed("motorist_vehicles", [VEHICLE]);
    });
    const result = await lookupCallerCase(deps, "0910 988 882");
    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") return;
    expect(result.caseFound.before.caseNumber).toBe("2026-0042");
    expect(result.caseFound.plateOnFile).toBe("BL123AB");
    expect(result.caseFound.after.contactName).toBe("Jana Nováková");
  });

  it("says nothing useful when the number is withheld", async () => {
    const deps = depsWith(() => undefined);
    expect((await lookupCallerCase(deps, null)).outcome).toBe("no_number");
    expect((await lookupCallerCase(deps, "")).outcome).toBe("no_number");
  });

  it("reports how many, not which, when a number has several open cases", async () => {
    const deps = depsWith((fake) => {
      fake.db.seed("motorist_contacts", [CONTACT]);
      fake.db.seed("motorist_cases", [CASE, { ...CASE, id: "case2", case_number: "2026-0043" }]);
    });
    const result = await lookupCallerCase(deps, "+421910988882");
    expect(result).toEqual({ outcome: "several", count: 2 });
  });

  it("ignores cases that are already closed", async () => {
    const deps = depsWith((fake) => {
      fake.db.seed("motorist_contacts", [CONTACT]);
      fake.db.seed("motorist_cases", [{ ...CASE, status: "completed_assisted" }]);
    });
    expect((await lookupCallerCase(deps, "+421910988882")).outcome).toBe("not_found");
  });

  it("returns no plate when the case has no vehicle, so nothing can verify", async () => {
    const deps = depsWith((fake) => {
      fake.db.seed("motorist_contacts", [CONTACT]);
      fake.db.seed("motorist_cases", [{ ...CASE, vehicle_id: null }]);
    });
    const result = await lookupCallerCase(deps, "+421910988882");
    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") return;
    expect(result.caseFound.plateOnFile).toBeNull();
  });

  it("does not reach cases belonging to another organisation", async () => {
    const deps = depsWith((fake) => {
      fake.db.seed("motorist_contacts", [{ ...CONTACT, organization_id: "other" }]);
      fake.db.seed("motorist_cases", [{ ...CASE, organization_id: "other" }]);
    });
    expect((await lookupCallerCase(deps, "+421910988882")).outcome).toBe("not_found");
  });
});

describe("what may be said before the caller proves anything", () => {
  it("tells her a case exists but forbids her from raising it", () => {
    const text = describeBeforeVerification({ outcome: "found" } as never) ?? "";
    expect(text).toContain("Nehovor o ňom sám od seba");
    expect(text).toContain("evidenčné číslo");
    // The date and the number are the two things a stranger must not get.
    expect(text).not.toMatch(/\d{4}-\d{4}/);
  });

  it("says nothing at all when there is nothing to find", () => {
    expect(describeBeforeVerification({ outcome: "not_found" })).toBeNull();
    expect(describeBeforeVerification({ outcome: "no_number" })).toBeNull();
  });
});

describe("full disclosure is off unless it is switched on", () => {
  it("stays locked for a missing variable, an empty one, or anything but true", () => {
    expect(fullDisclosureEnabled({})).toBe(false);
    expect(fullDisclosureEnabled({ AI_DEMO_FULL_DISCLOSURE: "" })).toBe(false);
    expect(fullDisclosureEnabled({ AI_DEMO_FULL_DISCLOSURE: "1" })).toBe(false);
    expect(fullDisclosureEnabled({ AI_DEMO_FULL_DISCLOSURE: "yes" })).toBe(false);
    expect(fullDisclosureEnabled({ AI_DEMO_FULL_DISCLOSURE: "false" })).toBe(false);
  });

  it("opens only for the exact word", () => {
    expect(fullDisclosureEnabled({ AI_DEMO_FULL_DISCLOSURE: "true" })).toBe(true);
    expect(fullDisclosureEnabled({ AI_DEMO_FULL_DISCLOSURE: " TRUE " })).toBe(true);
  });
});

describe("what may be said once the plate checks out", () => {
  const found = {
    before: { caseId: "case", caseNumber: "2026-0042", status: "in_progress", openedOn: "2026-09-12" },
    plateOnFile: "BL123AB",
    after: { contactName: "Jana Nováková", vehicle: "Škoda Octavia", summary: "Porucha", mainNote: "Čaká pri odpočívadle" },
  };

  it("withholds the person and the car while disclosure is off", () => {
    const text = describeAfterVerification(found, false);
    expect(text).toContain("2026-0042");
    expect(text).not.toContain("Jana");
    expect(text).not.toContain("Octavia");
    expect(text).toContain("ozve kolega");
  });

  it("gives the rest only when disclosure is on", () => {
    const text = describeAfterVerification(found, true);
    expect(text).toContain("Jana Nováková");
    expect(text).toContain("Škoda Octavia");
  });

  it("never repeats the plate back, in either mode", () => {
    expect(describeAfterVerification(found, true)).not.toContain("BL123AB");
    expect(describeAfterVerification(found, false)).not.toContain("BL123AB");
  });
});
