import { describe, expect, it } from "vitest";

import { dialPreview } from "./dial-preview";

describe("dialPreview", () => {
  it("says nothing until something is typed", () => {
    expect(dialPreview("")).toEqual({ kind: "empty" });
    expect(dialPreview("   ")).toEqual({ kind: "empty" });
  });

  it("refuses what the server would refuse", () => {
    expect(dialPreview("+49151")).toEqual({ kind: "invalid" });
    expect(dialPreview("klapka 12")).toEqual({ kind: "invalid" });
  });

  it("shows the number as it will be dialled", () => {
    expect(dialPreview("+420 776 123 456")).toMatchObject({ kind: "ready", e164: "+420776123456", countryAssumed: false });
    expect(dialPreview("00420776123456")).toMatchObject({ kind: "ready", e164: "+420776123456", countryAssumed: false });
    expect(dialPreview("0905 123 456")).toMatchObject({ kind: "ready", e164: "+421905123456", countryAssumed: true });
  });

  it("says so when it filled in the country itself", () => {
    // The trap: a Czech mobile typed the way a Czech person writes it.
    const czech = dialPreview("0776 123 456");
    expect(czech).toMatchObject({ kind: "ready", e164: "+421776123456", countryAssumed: true });
    expect(czech.kind === "ready" && czech.text).toContain("+421 776 123 456");
    expect(czech.kind === "ready" && czech.text).toContain("predvoľba doplnená");

    // Typed with its country, there is nothing to warn about.
    const explicit = dialPreview("+420776123456");
    expect(explicit.kind === "ready" && explicit.text).toBe("Vytočí sa +420776123456");
  });
});
