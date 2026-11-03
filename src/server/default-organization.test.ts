import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase } from "@/test/fake-supabase";
import { forgetResolvedOrganizations, resolveDefaultOrganizationId } from "./default-organization";

let fake: ReturnType<typeof createFakeSupabase>;
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => fake.admin }));

beforeEach(() => {
  fake = createFakeSupabase({ now: () => new Date("2026-09-17T08:00:00.000Z") });
  forgetResolvedOrganizations();
});
afterEach(() => vi.unstubAllEnvs());

const lookups = () => fake.db.log.filter(row => row.table === "motorist_organizations").length;

describe("default organisation", () => {
  it("looks the slug up once per instance instead of on every request", async () => {
    const [row] = fake.db.insert("motorist_organizations", { slug: "pomoc-motoristom", name: "PM", active: true });
    fake.db.log.length = 0;

    expect(await resolveDefaultOrganizationId()).toBe(row.id);
    expect(await resolveDefaultOrganizationId()).toBe(row.id);
    expect(await resolveDefaultOrganizationId()).toBe(row.id);
    expect(lookups()).toBe(1);
  });

  it("keeps a different slug on its own lookup", async () => {
    const [main] = fake.db.insert("motorist_organizations", { slug: "pomoc-motoristom", name: "PM", active: true });
    const [other] = fake.db.insert("motorist_organizations", { slug: "other", name: "Other", active: true });

    expect(await resolveDefaultOrganizationId()).toBe(main.id);
    vi.stubEnv("MOTORIST_ORGANIZATION_SLUG", "other");
    expect(await resolveDefaultOrganizationId()).toBe(other.id);
  });

  it("does not remember a deactivated organisation as resolved", async () => {
    const [row] = fake.db.insert("motorist_organizations", { slug: "pomoc-motoristom", name: "PM", active: false });
    fake.db.log.length = 0;
    await expect(resolveDefaultOrganizationId()).rejects.toMatchObject({ message: "Organizácia nie je nakonfigurovaná.", status: 500 });
    expect(lookups()).toBe(1);

    fake.db.update("motorist_organizations", { active: true }, candidate => candidate.id === row.id);
    await expect(resolveDefaultOrganizationId()).resolves.toBe(row.id);
    expect(lookups()).toBe(2);
  });

  it("verifies a transient timeout once and caches only the successful lookup", async () => {
    const [row] = fake.db.insert("motorist_organizations", { slug: "pomoc-motoristom", name: "PM", active: true });
    fake.db.log.length = 0;
    fake.db.failNext("motorist_organizations", "select", {
      message: "AbortError: un-owned read exceeded 10000 ms", code: "", details: null, hint: null,
    });

    expect(await resolveDefaultOrganizationId()).toBe(row.id);
    expect(await resolveDefaultOrganizationId()).toBe(row.id);
    expect(lookups()).toBe(2);
    expect(fake.db.log.every(query => query.operation === "select")).toBe(true);
  });

  it("preserves the public failure after both reads time out without caching it", async () => {
    const [row] = fake.db.insert("motorist_organizations", { slug: "pomoc-motoristom", name: "PM", active: true });
    fake.db.log.length = 0;
    const failure = { message: "AbortError: un-owned read exceeded 10000 ms", code: "", details: null, hint: null };
    fake.db.failNext("motorist_organizations", "select", failure);
    fake.db.failNext("motorist_organizations", "select", failure);

    await expect(resolveDefaultOrganizationId()).rejects.toMatchObject({ message: "Organizáciu sa nepodarilo overiť.", status: 500 });
    expect(lookups()).toBe(2);
    expect(await resolveDefaultOrganizationId()).toBe(row.id);
    expect(lookups()).toBe(3);
    expect(fake.db.log.every(query => query.operation === "select")).toBe(true);
  });

  it("does not retry or cache a missing organisation", async () => {
    await expect(resolveDefaultOrganizationId()).rejects.toMatchObject({ message: "Organizácia nie je nakonfigurovaná.", status: 500 });
    expect(lookups()).toBe(1);
    const [row] = fake.db.insert("motorist_organizations", { slug: "pomoc-motoristom", name: "PM", active: true });
    expect(await resolveDefaultOrganizationId()).toBe(row.id);
    expect(lookups()).toBe(2);
  });

  it.each([
    { code: "42501", message: "permission denied" },
    { code: "PGRST205", message: "table missing from schema cache" },
  ])("does not retry or cache a permanent database error: $code", async failure => {
    const [row] = fake.db.insert("motorist_organizations", { slug: "pomoc-motoristom", name: "PM", active: true });
    fake.db.log.length = 0;
    fake.db.failNext("motorist_organizations", "select", { ...failure, details: null, hint: null });
    await expect(resolveDefaultOrganizationId()).rejects.toMatchObject({ message: "Organizáciu sa nepodarilo overiť.", status: 500 });
    expect(lookups()).toBe(1);
    expect(await resolveDefaultOrganizationId()).toBe(row.id);
    expect(lookups()).toBe(2);
    expect(fake.db.log.every(query => query.operation === "select")).toBe(true);
  });
});
