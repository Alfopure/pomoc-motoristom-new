import { describe, expect, it } from "vitest";
import { guideChapters } from "../../content/guide/chapters";
import { searchGuide } from "./search";

describe("client guide search", () => {
  it("finds a break without accents and with the everyday synonym", () => {
    for (const query of ["prestávka", "prestavka", "Ako si dám pauzu"]) {
      expect(searchGuide(query, guideChapters).some((result) => result.chapterSlug === "pauza-a-zastupovanie")).toBe(true);
    }
  });

  it("understands queue and callback terminology", () => {
    expect(searchGuide("fronta", guideChapters).some((result) => result.chapterSlug === "cakaren")).toBe(true);
    expect(searchGuide("callback", guideChapters).some((result) => result.chapterSlug === "spatne-hovory")).toBe(true);
  });

  it("returns exact section and step links, including phrases in the body", () => {
    const chapter = guideChapters.find((item) => item.slug === "pauza-a-zastupovanie")!;
    const result = searchGuide("Som dostupný", [chapter]);
    expect(result.some((item) => item.anchor === "som-dostupny")).toBe(true);
    const bodyResult = searchGuide("budík", [chapter]);
    expect(bodyResult[0]?.anchor).toBe("pripomienka-a-navrat");
    for (const match of [...result, ...bodyResult]) {
      const anchors = chapter.sections.flatMap((section) => [section.id, ...(section.steps ?? []).map((step) => step.id)]);
      if (match.anchor) expect(anchors).toContain(match.anchor);
    }
  });

  it("does not pretend to have results for empty or unrelated questions", () => {
    expect(searchGuide("", guideChapters)).toEqual([]);
    expect(searchGuide("ako sa to", guideChapters)).toEqual([]);
    expect(searchGuide("zzxyyzzy", guideChapters)).toEqual([]);
  });
});
