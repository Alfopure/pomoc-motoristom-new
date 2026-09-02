import { describe, expect, it } from "vitest";

import {
  buildViptelLineCatalog,
  findExactViptelLine,
  normalizeViptelPublicNumber,
  resolveViptelLineIdentity,
  VIPTEL_CANONICAL_LINES,
} from "./viptel-line-catalog";

describe("VIPTel line catalog", () => {
  it("contains the approved neutral, insurer and reserve allocation", () => {
    expect(VIPTEL_CANONICAL_LINES.map(({ phoneNumber, label }) => [phoneNumber, label])).toEqual([
      ["0412289240", "Neutrálna linka"],
      ["0412289241", "Allianz Assistance"],
      ["0412289242", "Autoklub Slovakia Assistance s.r.o."],
      ["0412289243", "AXA Assistance CZ s.r.o."],
      ["0412289244", "Eurocross Assistance Czech Republic s.r.o."],
      ["0412289245", "Europ Assistance"],
      ["0412289247", "LeasePlan Slovakia s.r.o."],
      ["0412289248", "Rezerva 1"],
      ["0412289249", "Rezerva 2"],
    ]);
  });

  it("resolves every approved DID only when its active row is present and leaves 9246 unknown", () => {
    const catalog = buildViptelLineCatalog(VIPTEL_CANONICAL_LINES.map((line, index) => ({
      id: `line-${index}`,
      external_id: null,
      phone_number: line.phoneNumber,
      label: `database label ${index}`,
    })));

    for (const line of VIPTEL_CANONICAL_LINES) {
      expect(findExactViptelLine(catalog, line.phoneNumber)?.label).toBe(line.label);
    }
    expect(findExactViptelLine(catalog, "0412289246")).toBeUndefined();
  });

  it("normalizes whole Slovak number formats but never suffix-matches", () => {
    expect(normalizeViptelPublicNumber("041 228 92 41")).toBe("421412289241");
    expect(normalizeViptelPublicNumber("+421 41 228 92 41")).toBe("421412289241");
    expect(normalizeViptelPublicNumber("00421412289241")).toBe("421412289241");
    expect(normalizeViptelPublicNumber("412289241")).toBe("421412289241");

    const catalog = buildViptelLineCatalog([
      { id: "line-allianz", phone_number: "0412289241", external_id: null, label: "stale label" },
    ]);
    expect(findExactViptelLine(catalog, "+421 41 228 92 41")?.label).toBe("Allianz Assistance");
    expect(findExactViptelLine(catalog, "2289241")).toBeUndefined();
    expect(findExactViptelLine(catalog, "prefix-0412289241")).toBeUndefined();
    expect(findExactViptelLine(buildViptelLineCatalog([
      { id: "bad-line", phone_number: "601", external_id: null, label: "queue scalar" },
    ]), "601")).toBeUndefined();
  });

  it("does not treat the expected hardcoded allocation as active configuration", () => {
    const identity = resolveViptelLineIdentity({
      catalog: buildViptelLineCatalog([]),
      providerNumbers: ["0412289241"],
    });

    expect(identity).toEqual({
      lineId: undefined,
      lineLabel: "Neznáma linka",
      phoneNumber: undefined,
    });
  });

  it("fails closed when an exact canonical DID has duplicate configured rows", () => {
    const catalog = buildViptelLineCatalog([
      { id: "line-a", phone_number: "0412289241", external_id: null, label: "Allianz A" },
      { id: "line-b", phone_number: "+421412289241", external_id: null, label: "Allianz B" },
    ]);

    expect(findExactViptelLine(catalog, "0412289241")).toBeUndefined();
    expect(resolveViptelLineIdentity({ catalog, providerNumbers: ["0412289241"] }).lineLabel).toBe("Neznáma linka");
  });

  it("never activates the missing 9246 or another unapproved DID from arbitrary database rows", () => {
    const catalog = buildViptelLineCatalog([
      { id: "line-missing", phone_number: "0412289246", external_id: null, label: "must stay unknown" },
      { id: "line-other", phone_number: "0412289999", external_id: null, label: "unexpected" },
    ]);

    expect(findExactViptelLine(catalog, "0412289246")).toBeUndefined();
    expect(findExactViptelLine(catalog, "0412289999")).toBeUndefined();
  });

  it("fails closed when one row cross-links two approved public DIDs", () => {
    const catalog = buildViptelLineCatalog([
      { id: "line-cross-linked", phone_number: "0412289241", external_id: "0412289242", label: "ambiguous" },
    ]);

    expect(findExactViptelLine(catalog, "0412289241")).toBeUndefined();
    expect(findExactViptelLine(catalog, "0412289242")).toBeUndefined();
  });

  it("uses stored line identity before a conflicting provider number", () => {
    const catalog = buildViptelLineCatalog([
      { id: "line-allianz", phone_number: "0412289241", external_id: null, label: "Allianz" },
      { id: "line-autoklub", phone_number: "0412289242", external_id: null, label: "Autoklub" },
    ]);

    expect(resolveViptelLineIdentity({
      catalog,
      storedLineId: "line-allianz",
      storedReceivedNumber: "0412289241",
      providerNumbers: ["0412289242"],
    })).toMatchObject({
      lineId: "line-allianz",
      lineLabel: "Allianz Assistance",
      phoneNumber: "0412289241",
    });
  });

  it("rejects conflicting stored identity evidence and never returns an unknown raw line id", () => {
    const catalog = buildViptelLineCatalog([
      { id: "line-allianz", phone_number: "0412289241", external_id: null, label: "Allianz" },
      { id: "line-autoklub", phone_number: "0412289242", external_id: null, label: "Autoklub" },
    ]);

    expect(resolveViptelLineIdentity({
      catalog,
      storedLineId: "line-allianz",
      storedReceivedNumber: "0412289242",
    })).toEqual({ lineLabel: "Neznáma linka" });
    expect(resolveViptelLineIdentity({
      catalog,
      storedLineId: "line-not-approved",
      storedReceivedNumber: "0412289999",
    })).toEqual({ lineId: undefined, lineLabel: "Neznáma linka", phoneNumber: undefined });
    expect(resolveViptelLineIdentity({
      catalog,
      providerNumbers: ["0412289241", "0412289242"],
    })).toEqual({ lineId: undefined, lineLabel: "Neznáma linka", phoneNumber: undefined });
  });

  it("never labels the missing 9246 from a conflicting stored insurer relation", () => {
    const catalog = buildViptelLineCatalog([
      { id: "line-allianz", phone_number: "0412289241", external_id: null, label: "Allianz" },
    ]);

    expect(resolveViptelLineIdentity({
      catalog,
      storedLineId: "line-allianz",
      storedReceivedNumber: "0412289246",
    })).toEqual({ lineLabel: "Neznáma linka" });
  });

  it("fails closed when provider evidence mixes one approved and one unknown public DID", () => {
    const catalog = buildViptelLineCatalog([
      { id: "line-allianz", phone_number: "0412289241", external_id: null, label: "Allianz" },
    ]);

    expect(resolveViptelLineIdentity({
      catalog,
      providerNumbers: ["0412289241", "0412289246"],
    })).toEqual({ lineId: undefined, lineLabel: "Neznáma linka", phoneNumber: undefined });
  });
});
