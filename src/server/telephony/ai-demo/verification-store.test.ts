import { describe, expect, it } from "vitest";

import { createFakeSupabase } from "@/test/fake-supabase";

import { readVerificationAttempts, recordVerificationAttempts } from "./verification-store";

const NOW = new Date("2026-09-20T10:00:00Z");
const deps = (fake: ReturnType<typeof createFakeSupabase>) => ({ admin: fake.admin, organizationId: "org" }) as never;

describe("the per-case attempt counter", () => {
  it("starts at nothing for a case nobody has guessed at", async () => {
    expect(await readVerificationAttempts(deps(createFakeSupabase()), "case", NOW)).toBe(0);
  });

  it("remembers across calls, which is the whole point", async () => {
    const fake = createFakeSupabase();
    await recordVerificationAttempts(deps(fake), { caseId: "case", attempts: 2, verified: false, now: NOW });
    expect(await readVerificationAttempts(deps(fake), "case", NOW)).toBe(2);
  });

  it("only ever climbs, so a slower writer cannot hand tries back", async () => {
    const fake = createFakeSupabase();
    await recordVerificationAttempts(deps(fake), { caseId: "case", attempts: 3, verified: false, now: NOW });
    await recordVerificationAttempts(deps(fake), { caseId: "case", attempts: 1, verified: false, now: NOW });
    expect(await readVerificationAttempts(deps(fake), "case", NOW)).toBe(3);
  });

  it("gives a case its tries back the next day", async () => {
    const fake = createFakeSupabase();
    await recordVerificationAttempts(deps(fake), { caseId: "case", attempts: 3, verified: false, now: NOW });
    const tomorrow = new Date("2026-09-21T10:00:00Z");
    expect(await readVerificationAttempts(deps(fake), "case", tomorrow)).toBe(0);
  });

  it("counts each case separately", async () => {
    const fake = createFakeSupabase();
    await recordVerificationAttempts(deps(fake), { caseId: "one", attempts: 3, verified: false, now: NOW });
    expect(await readVerificationAttempts(deps(fake), "two", NOW)).toBe(0);
  });

  it("never lets a write failure end a call", async () => {
    const broken = { from: () => { throw new Error("database unavailable"); } };
    await expect(
      recordVerificationAttempts({ admin: broken, organizationId: "org" } as never, { caseId: "case", attempts: 1, verified: false, now: NOW }),
    ).resolves.toBeUndefined();
  });

  it("treats an unreadable count as nothing used rather than failing", async () => {
    const broken = { from: () => { throw new Error("database unavailable"); } };
    await expect(readVerificationAttempts({ admin: broken, organizationId: "org" } as never, "case", NOW)).resolves.toBe(0);
  });
});
