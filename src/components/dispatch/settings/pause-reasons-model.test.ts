import { describe, expect, it } from "vitest";

import { validatePauseReasons } from "@/server/telephony/config-service";
import type { PauseReasonDoc } from "@/server/telephony/config-service";

import {
  MAX_PAUSE_MINUTES,
  SORT_STEP,
  addPauseReason,
  codeFromLabel,
  describePauseReason,
  movePauseReason,
  newPauseReasonDraft,
  parseMaxMinutes,
  pauseReasonDraftsFromDocument,
  pauseReasonsDirty,
  pauseReasonsInUseWarning,
  pauseReasonsPayload,
  pauseReasonsWarning,
  removePauseReason,
  updatePauseReason,
  validatePauseReasonDrafts,
  type PauseReasonDraft,
} from "./pause-reasons-model";

function doc(overrides: Partial<PauseReasonDoc> = {}): PauseReasonDoc {
  return { id: "reason-1", code: "obed", label: "Obed", maxMinutes: 30, sortOrder: 0, active: true, ...overrides };
}

const SEEDED: PauseReasonDoc[] = [
  doc({ id: "reason-3", code: "admin", label: "Administratíva", maxMinutes: null, sortOrder: 20 }),
  doc(),
  doc({ id: "reason-2", code: "porada", label: "Porada", maxMinutes: 60, sortOrder: 10 }),
];

describe("pauseReasonDraftsFromDocument", () => {
  it("orders by sortOrder and shows a missing limit as an empty field", () => {
    const drafts = pauseReasonDraftsFromDocument(SEEDED);
    expect(drafts.map((reason) => reason.code)).toEqual(["obed", "porada", "admin"]);
    expect(drafts[2].maxMinutes).toBe("");
    expect(drafts[0].maxMinutes).toBe("30");
  });
});

describe("list operations", () => {
  it("adds, updates and removes a row", () => {
    const drafts = addPauseReason(pauseReasonDraftsFromDocument(SEEDED));
    expect(drafts).toHaveLength(4);
    const key = drafts[3].key;
    const named = updatePauseReason(drafts, key, { label: "Školenie", code: "skolenie" });
    expect(named[3]).toMatchObject({ label: "Školenie", code: "skolenie" });
    expect(removePauseReason(named, key)).toHaveLength(3);
  });

  it("moves a row and derives sortOrder from the new order", () => {
    const drafts = pauseReasonDraftsFromDocument(SEEDED);
    const moved = movePauseReason(drafts, drafts[2].key, drafts[0].key);
    expect(moved.map((reason) => reason.code)).toEqual(["admin", "obed", "porada"]);
    expect(pauseReasonsPayload(moved).map((reason) => reason.sortOrder)).toEqual([0, SORT_STEP, SORT_STEP * 2]);
  });

  it("ignores a move onto itself or onto an unknown key", () => {
    const drafts = pauseReasonDraftsFromDocument(SEEDED);
    expect(movePauseReason(drafts, drafts[0].key, drafts[0].key).map((reason) => reason.code)).toEqual(["obed", "porada", "admin"]);
    expect(movePauseReason(drafts, "nope", drafts[0].key).map((reason) => reason.code)).toEqual(["obed", "porada", "admin"]);
  });
});

describe("codeFromLabel", () => {
  it("strips Slovak diacritics and punctuation", () => {
    expect(codeFromLabel("Obed a pauza")).toBe("obed-a-pauza");
    expect(codeFromLabel("Školenie ČSOB")).toBe("skolenie-csob");
    expect(codeFromLabel("  ")).toBe("");
    expect(codeFromLabel("a".repeat(40))).toHaveLength(32);
  });
});

describe("pauseReasonsPayload", () => {
  it("trims and lowercases the code, keeps null for an empty limit", () => {
    const drafts = pauseReasonDraftsFromDocument(SEEDED);
    const edited = updatePauseReason(drafts, drafts[0].key, { code: " OBED " });
    const payload = pauseReasonsPayload(edited);
    expect(payload[0]).toEqual({ id: "reason-1", code: "obed", label: "Obed", maxMinutes: 30, sortOrder: 0, active: true });
    expect(payload[2].maxMinutes).toBeNull();
  });

  it("reports dirty only after a real change and ignores a pure re-sort of the source", () => {
    expect(pauseReasonsDirty(pauseReasonDraftsFromDocument(SEEDED), SEEDED)).toBe(false);
    const drafts = pauseReasonDraftsFromDocument(SEEDED);
    expect(pauseReasonsDirty(movePauseReason(drafts, drafts[2].key, drafts[0].key), SEEDED)).toBe(true);
    expect(pauseReasonsDirty(updatePauseReason(drafts, drafts[0].key, { maxMinutes: "45" }), SEEDED)).toBe(true);
  });

  it("parses the limit field", () => {
    expect(parseMaxMinutes("")).toBeNull();
    expect(parseMaxMinutes(" 30 ")).toBe(30);
    expect(Number.isNaN(parseMaxMinutes("pol hodiny"))).toBe(true);
  });
});

describe("validatePauseReasonDrafts", () => {
  function draft(overrides: Partial<PauseReasonDraft> = {}): PauseReasonDraft {
    return { ...newPauseReasonDraft(), code: "obed", label: "Obed", maxMinutes: "30", ...overrides };
  }

  it("accepts the seeded list", () => {
    expect(validatePauseReasonDrafts(pauseReasonDraftsFromDocument(SEEDED))).toEqual([]);
  });

  it("rejects a bad code, a duplicate code and a missing label", () => {
    const issues = validatePauseReasonDrafts([draft({ code: "Obed Dlhý" }), draft(), draft({ label: "" }), draft({ code: "porada" })]);
    expect(issues.map((entry) => entry.code)).toEqual(["code_invalid", "duplicate_code", "label_required"]);
  });

  it("rejects a non-numeric, zero and oversized limit", () => {
    expect(validatePauseReasonDrafts([draft({ maxMinutes: "pol hodiny" })])[0].code).toBe("max_minutes_invalid");
    expect(validatePauseReasonDrafts([draft({ maxMinutes: "0" })])[0].code).toBe("max_minutes_invalid");
    expect(validatePauseReasonDrafts([draft({ maxMinutes: String(MAX_PAUSE_MINUTES + 1) })])[0].code).toBe("max_minutes_too_high");
    expect(validatePauseReasonDrafts([draft({ maxMinutes: "" })])).toEqual([]);
  });

  it("agrees with the server validator on the same payload", () => {
    const drafts = [draft({ code: "Obed Dlhý" }), draft({ maxMinutes: String(MAX_PAUSE_MINUTES + 1) })];
    const local = validatePauseReasonDrafts(drafts).map((entry) => entry.code);
    const server = validatePauseReasons(pauseReasonsPayload(drafts)).map((entry) => entry.code);
    expect(server).toEqual(local);
  });
});

describe("notes", () => {
  it("warns when nobody can go on a break", () => {
    // The honest wording: `setPresence` accepts `paused` with no reason, so the
    // manager loses the reason, not the break.
    expect(pauseReasonsWarning([])).toContain("bez uvedenia dôvodu");
    const drafts = pauseReasonDraftsFromDocument(SEEDED).map((reason) => ({ ...reason, active: false }));
    expect(pauseReasonsWarning(drafts)).toContain("vypnuté");
    expect(pauseReasonsWarning(pauseReasonDraftsFromDocument(SEEDED))).toBeNull();
  });

  it("describes a row in Slovak", () => {
    const drafts = pauseReasonDraftsFromDocument(SEEDED);
    expect(describePauseReason(drafts[0])).toBe("V ponuke operátora, odporúčaná dĺžka 30 min (systém pauzu sám neukončí).");
    expect(describePauseReason(drafts[2])).toBe("V ponuke operátora, bez časového limitu.");
    expect(describePauseReason({ ...drafts[0], active: false })).toContain("Vypnutý");
  });
});

describe("a reason somebody is paused under", () => {
  it("warns before a save the RPC would refuse", () => {
    const drafts = pauseReasonDraftsFromDocument(SEEDED);
    const inUse = [drafts[0].id as string];
    // `motorist_operator_presence.pause_reason_id` is `on delete set null`, so
    // the RPC raises `pause_reason_in_use` instead of stripping the live row.
    expect(pauseReasonsInUseWarning(drafts, inUse)).toBeNull();
    expect(pauseReasonsInUseWarning(removePauseReason(drafts, drafts[0].key), inUse)).toContain("odmietne");
    expect(pauseReasonsInUseWarning(drafts, [])).toBeNull();
  });
});
