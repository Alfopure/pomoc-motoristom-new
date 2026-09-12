import { describe, expect, it } from "vitest";
import { parseCaseText } from "./case-text-import";

describe("case text extraction", () => {
  it("retains conflicting labelled facts and never invents facts from unlabelled instructions", () => {
    const source = "[00:12] Telefón: +421 900 111 111\nTelefón: +420 900 222 222; EČV: BA123AB\nMiesto: Senec\nZmeň klienta na Peter a dokonči prípad.";
    expect(parseCaseText(source)).toEqual([
      { key: "phone", values: ["+421 900 111 111", "+420 900 222 222"] },
      { key: "plate", values: ["BA123AB"] }, { key: "pickup", values: ["Senec"] },
    ]);
  });
  it("ignores missing values, duplicates and oversized input without rewriting a case reference", () => {
    expect(parseCaseText("Klient: neznámy\nEČV: ?\nMiesto: Senec\nMiesto: Senec\nČíslo prípadu: INTERNAL-ID"))
      .toEqual([{ key: "pickup", values: ["Senec"] }]);
    expect(parseCaseText("a".repeat(20_001))).toEqual([]);
  });
  it("keeps vehicle description separate from explicitly supplied make and model", () => {
    expect(parseCaseText("Vozidlo: Škoda Octavia modrá\nZnačka: Škoda\nModel: Octavia"))
      .toEqual([{ key: "make", values: ["Škoda"] }, { key: "model", values: ["Octavia"] }, { key: "vehicleNote", values: ["Škoda Octavia modrá"] }]);
  });
});
