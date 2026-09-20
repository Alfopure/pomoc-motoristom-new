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

describe("the queries that offer a colleague really do exclude her", () => {
  // The helper being correct proves nothing about whether it was wired up.
  // This walks the real call sites and asserts the filter is present, so
  // deleting it anywhere fails here rather than in production.
  const SITES: Array<[string, string]> = [
    ["src/server/telephony/team.ts", "operator roster"],
    ["src/data/dispatch-repository.ts", "assignee pickers"],
    ["src/server/telephony/return-line.ts", "return-line owners"],
    ["src/server/telephony/config-service.ts", "operators tab"],
    ["src/server/telephony/call-actions.ts", "transfer and monitor targets"],
    ["src/server/sms-inbox.ts", "SMS assignment"],
    ["src/server/task-notifications.ts", "task notifications"],
  ];

  it.each(SITES)("%s (%s) filters profiles through humansOnly", async (path) => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path, "utf8");
    const listings = source.split("\n").filter((line) => line.includes('from("motorist_profiles")'));
    expect(listings.length, `${path} no longer queries profiles`).toBeGreaterThan(0);
    expect(source).toContain("humansOnly(");
  });
});
