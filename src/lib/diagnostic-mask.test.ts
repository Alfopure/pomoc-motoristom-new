import { describe, expect, it } from "vitest";
import { maskDiagnostic } from "./diagnostic-mask";

describe("diagnostic masking", () => {
  it.each([
    ["Volajúci +421 905 123 456", "Volajúci [číslo]"], ["Číslo (0905) 123 456", "Číslo [číslo]"], ["tel. +421 (905) 123 456", "tel. [číslo]"],
    ["tel 0905.123.456", "tel [číslo]"], ["tel 0905123456", "tel [číslo]"], ["mail jan.novak@example.sk", "mail [e-mail]"],
    ["EČV BA123AB a BA-123 AB", "EČV [EČV] a [EČV]"], ["CZ 1A2 3456", "CZ [EČV]"], ["VIN TMBJJ7NE8L0123456", "VIN [VIN]"],
    ["malé ba123ab a vin tmbjj7ne8l0123456", "malé [EČV] a vin [VIN]"], ["mail ján.novák@example.sk", "mail [e-mail]"],
  ])("masks %s", (input, output) => expect(maskDiagnostic(input)).toBe(output));
  it("keeps release stack locations, Slovak dates and package versions", () => {
    const frames = "TypeError: x\n    at CaseList (address at main.jsbundle:1:1234567)\n    at renderWithHooks (main.jsbundle:1:20512345)";
    expect(maskDiagnostic(frames)).toBe(frames);
    for (const text of ["Termín 20. 10. 2026 14:30:05 (Bratislava)", "od 20.10.2026", "react-native@0.86.0 a expo@57.0.30"]) expect(maskDiagnostic(text)).toBe(text);
  });
  it("keeps identifiers, dates, short numbers and code words", () => {
    const text = "case 00000000-0000-4000-8000-000000000001 at 2026-10-20T14:30:05.123Z, version 1.10.2 (12), step 3 of 5, TypeError in renderRow";
    expect(maskDiagnostic(text)).toBe(text);
  });
  it("drops control characters, so masks cannot be forged", () => {
    expect(maskDiagnostic("a\u0000 1\u0000 b")).toBe("a 1 b");
  });
});
