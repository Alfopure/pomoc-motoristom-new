import { describe, expect, it } from "vitest";
import { layoutPreviewEnabled, layoutPreviewStorageKey, parseLayoutPreviewMode } from "./layout-preview-policy";

describe("released workspace availability", () => {
  it("enables a deployed Preview even though its build is production mode", () => {
    expect(layoutPreviewEnabled({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe(true);
  });
  it("enables the approved production release", () => {
    expect(layoutPreviewEnabled({ VERCEL_ENV: "production", NODE_ENV: "production" })).toBe(true);
  });
  it("keeps unclassified production builds disabled", () => {
    expect(layoutPreviewEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(layoutPreviewEnabled({})).toBe(false);
  });
  it("allows local development and keeps appearance separate for each actor", () => {
    expect(layoutPreviewEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(layoutPreviewStorageKey("org:alice")).not.toBe(layoutPreviewStorageKey("org:bob"));
    expect(parseLayoutPreviewMode("classic")).toBe("classic");
    expect(parseLayoutPreviewMode("corrupt")).toBe("modern");
  });
});
