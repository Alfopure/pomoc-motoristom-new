import { describe, expect, it } from "vitest";
import { smsSegments, stripSmsDiacritics } from "./segments";
describe("SMS segments", () => {
  it.each([[160, 1], [161, 2], [306, 2], [307, 3]])("counts %i GSM units", (length, segments) => expect(smsSegments("a".repeat(length))).toMatchObject({ encoding: "GSM-7", units: length, segments }));
  it("counts extensions twice, without splitting escapes", () => {
    expect(smsSegments("^{}\\[~]|€")).toMatchObject({ encoding: "GSM-7", units: 18 });
    expect(smsSegments("^".repeat(153)).segments).toBe(3);
  });
  it("switches the whole message to UTF-16 and counts emoji pairs", () => {
    expect(smsSegments("ľ".repeat(70))).toMatchObject({ encoding: "UTF-16", segments: 1 });
    expect(smsSegments("ľ".repeat(71)).segments).toBe(2);
    expect(smsSegments("😀".repeat(67))).toMatchObject({ units: 134, segments: 3 });
  });
  it("counts the actual complete URL and only strips diacritics explicitly", () => {
    const body = `Poloha: https://sms.example/l/${"a".repeat(43)}`;
    expect(smsSegments(body).units).toBe(body.length);
    expect(stripSmsDiacritics("Žiadosť 😀")).toBe("Ziadost 😀");
    expect(smsSegments("").segments).toBe(0);
  });
});
