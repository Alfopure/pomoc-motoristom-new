import { describe, expect, it } from "vitest";
import { sanitizeDiagnostic } from "./diagnostics";

describe("device-log sanitizer", () => {
  it("keeps reason codes, flags, counts and short IDs as lowercase text", () => {
    expect(sanitizeDiagnostic("Offer.Done", { reason: "fail:Native_Offer_Pending", ready: true, pending: 2, call: "3F2A9C1B" }))
      .toEqual({ event: "offer.done", fields: { reason: "fail:native_offer_pending", ready: "true", pending: "2", call: "3f2a9c1b" } });
  });
  it("drops disallowed characters, caps lengths and skips unusable fields", () => {
    const fields = { "Bad Key/Name": "a b\nc;d=e", long: "x".repeat(200), ["k".repeat(80)]: "v", empty: "", missing: undefined, nothing: null,
      fraction: 1.5, infinite: Number.POSITIVE_INFINITY, object: {} as unknown as string, "!!!": "lost" };
    expect(sanitizeDiagnostic("push rejected!", fields)).toEqual({ event: "pushrejected",
      fields: { badkeyname: "abcde", long: "x".repeat(40), ["k".repeat(32)]: "v", empty: "none" } });
    expect(sanitizeDiagnostic("x".repeat(80))?.event).toHaveLength(48);
    expect(sanitizeDiagnostic("¿?")).toBeNull();
    expect(Object.keys(sanitizeDiagnostic("many", Object.fromEntries(Array.from({ length: 30 }, (_, index) => ["f" + index, index])))!.fields)).toHaveLength(16);
  });
  it("redacts a phone number in any notation, but not short codes", () => {
    for (const value of ["+421 900 000 999", "0900000999", "421-900-000-999", "421.900.000.999", "tel:+421900000999", "(0911) 222 333", "1234567"]) {
      expect(sanitizeDiagnostic("x", { value })?.fields.value).toBe("redacted");
    }
    expect(sanitizeDiagnostic("x", { value: 421_900_000_999 })?.fields.value).toBe("redacted");
    expect(sanitizeDiagnostic("caller:0900000999")?.event).toBe("redacted");
    expect(sanitizeDiagnostic("x", { "n0900000999": true })?.fields).toEqual({ redacted: "true" });
    for (const value of ["fail:409", "123456", "a1b2c3d4", "12-34-56", "v2"]) expect(sanitizeDiagnostic("x", { value })?.fields.value).toBe(value);
  });
  it("never lets more than six digits in a row through", () => {
    let seed = 7;
    const random = () => (seed = seed * 48271 % 2147483647) / 2147483647;
    const alphabet = "0123456789 +-.:_/()aZ";
    for (let sample = 0; sample < 3000; sample += 1) {
      const value = Array.from({ length: 1 + Math.floor(random() * 30) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
      const line = sanitizeDiagnostic("e" + value, { [value]: value, number: Math.floor(random() * 1e12) });
      expect(JSON.stringify(line)).not.toMatch(/\d{7}/);
    }
  });
});
