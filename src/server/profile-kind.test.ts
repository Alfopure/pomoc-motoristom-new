import { describe, expect, it } from "vitest";

import { humansOnly, isHumanProfile } from "./profile-kind";

describe("humansOnly", () => {
  it("excludes the assistant from a list of people", () => {
    const calls: Array<[string, string]> = [];
    const query = { neq: (column: string, value: string) => { calls.push([column, value]); return "narrowed"; } };
    expect(humansOnly(query)).toBe("narrowed");
    expect(calls).toEqual([["kind", "ai"]]);
  });

  it("asks for 'not ai' rather than 'is human', so an unknown kind still counts as a person", () => {
    // A colleague silently missing from an assignee list is a task nobody does.
    // A stranger appearing in one is visible and gets fixed.
    const calls: Array<[string, string]> = [];
    humansOnly({ neq: (c: string, v: string) => { calls.push([c, v]); return null; } });
    expect(calls[0][1]).toBe("ai");
  });
});

describe("isHumanProfile", () => {
  it("treats the assistant as not a person", () => {
    expect(isHumanProfile({ kind: "ai" })).toBe(false);
  });

  it("treats everyone else, including a row from before the column existed, as a person", () => {
    expect(isHumanProfile({ kind: "human" })).toBe(true);
    expect(isHumanProfile({ kind: null })).toBe(true);
    expect(isHumanProfile({})).toBe(true);
  });

  it("has no opinion about a missing row", () => {
    expect(isHumanProfile(null)).toBe(false);
    expect(isHumanProfile(undefined)).toBe(false);
  });
});
