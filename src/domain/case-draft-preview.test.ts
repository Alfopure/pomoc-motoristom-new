import { describe, expect, it } from "vitest";
import { draftPreviewGroups, parseCaseDraftPreview } from "./case-draft-preview";

describe("read-only new-case projection", () => {
  it("preserves in-progress text, empty fields and literal markup as text", () => {
    const preview = { version: 1, fields: { note: "  ešte píšem\nďalší riadok <script>  ", plate: "" } };
    expect(parseCaseDraftPreview(preview)).toEqual(preview);
  });
  it("supports every named preview field without duplicate keys", () => {
    const keys = draftPreviewGroups.flatMap(group => Object.keys(group.fields));
    expect(new Set(keys).size).toBe(keys.length);
    const preview = { version: 1, fields: Object.fromEntries(keys.map(key => [key, "priebežný údaj"])) };
    expect(parseCaseDraftPreview(preview)).toEqual(preview);
  });
  it.each([
    null, [], { version: 2, fields: {} }, { version: 1, fields: [] },
    { version: 1, fields: {}, organizationId: "forged" },
    { version: 1, fields: { accessToken: "secret" } },
    { version: 1, fields: { note: { private: "object" } } },
    { version: 1, fields: { note: "x".repeat(4001) } },
  ])("rejects unexpected values and non-projection data: %j", input => {
    expect(() => parseCaseDraftPreview(input)).toThrow();
  });
  it("bounds the total UTF-8 size even when every individual value is short enough", () => {
    const keys = draftPreviewGroups.flatMap(group => Object.keys(group.fields)).slice(0, 10);
    expect(() => parseCaseDraftPreview({ version: 1, fields: Object.fromEntries(keys.map(key => [key, "Ž".repeat(3000)])) })).toThrow(/veľký/);
  });
});
