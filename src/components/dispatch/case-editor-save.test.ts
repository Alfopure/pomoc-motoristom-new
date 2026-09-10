import { describe, expect, it } from "vitest";
import { changedCaseFields } from "./case-editor-save";
describe("case editor accepted snapshot", () => {
  it("does not resend acknowledged priority or explicit status with later text", () => {
    expect(changedCaseFields(JSON.stringify({ priority: "high", status: "open", licensePlate: "OLD" }), JSON.stringify({ priority: "high", status: "open", licensePlate: "NEW" }))).toEqual({ licensePlate: "NEW" });
  });
  it("preserves explicit null and turns cleared optional values into null writes", () => {
    expect(changedCaseFields(JSON.stringify({ pickup: { lat: 1 }, weightKg: 2000 }), JSON.stringify({ pickup: null }))).toEqual({ pickup: null, weightKg: null });
  });
  it("compares nested contacts and ignores only the transport revision", () => {
    expect(changedCaseFields(JSON.stringify({ contacts: [{ name: "Old" }], expectedUpdatedAt: "old" }), JSON.stringify({ contacts: [{ name: "New" }], expectedUpdatedAt: "new" }))).toEqual({ contacts: [{ name: "New" }] });
  });
});
