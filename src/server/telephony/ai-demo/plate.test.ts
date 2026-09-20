import { describe, expect, it } from "vitest";

import { normalizePlate, plateCandidates, plateMatches, speechMatchesPlate } from "./plate";

describe("normalizePlate", () => {
  it("absorbs the punctuation and spacing a transcript adds", () => {
    for (const written of ["BL-123AB", "bl 123 ab", "BL.123.AB", " BL123AB "]) {
      expect(normalizePlate(written), written).toBe("BL123AB");
    }
  });

  it("drops diacritics rather than treating them as different letters", () => {
    expect(normalizePlate("ŽA123ČD")).toBe("ZA123CD");
  });

  it("has nothing to say about nothing", () => {
    expect(normalizePlate(null)).toBe("");
    expect(normalizePlate(undefined)).toBe("");
    expect(normalizePlate("   ")).toBe("");
  });
});

describe("plateMatches", () => {
  it("accepts the same plate however it was written down", () => {
    expect(plateMatches("bl 123 ab", "BL123AB")).toBe(true);
  });

  it("forgives the letter-digit swaps a transcript makes", () => {
    // "BA1O3AB" is a slip of the ear, not a different car.
    expect(plateMatches("BA1O3AB", "BA103AB")).toBe(true);
    expect(plateMatches("BA1I3AB", "BA113AB")).toBe(true);
  });

  it("refuses a genuinely different plate", () => {
    expect(plateMatches("BL123AB", "KE456CD")).toBe(false);
    expect(plateMatches("BL123AB", "BL123AC")).toBe(false);
  });

  it("treats an empty answer as no answer, never as agreement", () => {
    expect(plateMatches("", "BL123AB")).toBe(false);
    expect(plateMatches(null, "BL123AB")).toBe(false);
    expect(plateMatches("   ", "BL123AB")).toBe(false);
  });

  it("cannot be satisfied by a case that has no plate on file", () => {
    // Otherwise "" would verify against "" and unlock everything.
    expect(plateMatches("BL123AB", null)).toBe(false);
    expect(plateMatches("", "")).toBe(false);
    expect(plateMatches("abc", "abc")).toBe(false);
  });
});

describe("plateCandidates", () => {
  it("finds the plate inside a sentence", () => {
    expect(plateCandidates("áno, je to BL 123 AB")).toContain("BL123AB");
  });

  it("copes with a caller spelling it out one piece at a time", () => {
    expect(plateCandidates("B L 1 2 3 A B")).toContain("BL123AB");
  });

  it("returns nothing for silence", () => {
    expect(plateCandidates("")).toEqual([]);
    expect(plateCandidates(null)).toEqual([]);
  });
});

describe("speechMatchesPlate", () => {
  it("verifies a plate said inside an ordinary sentence", () => {
    expect(speechMatchesPlate("no je to bratislavská, BL 123 AB", "BL123AB")).toBe(true);
  });

  it("does not verify somebody talking about something else", () => {
    expect(speechMatchesPlate("neviem, niekde som to mal napísané", "BL123AB")).toBe(false);
  });

  it("does not verify a near miss", () => {
    expect(speechMatchesPlate("je to BL 123 AC", "BL123AB")).toBe(false);
  });

  it("refuses everything when the case has no plate", () => {
    expect(speechMatchesPlate("BL 123 AB", null)).toBe(false);
    expect(speechMatchesPlate("čokoľvek", "")).toBe(false);
  });
});
