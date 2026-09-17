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
    await expect(resolveDefaultOrganizationId()).rejects.toThrow();

    fake.db.update("motorist_organizations", { active: true }, candidate => candidate.id === row.id);
    await expect(resolveDefaultOrganizationId()).resolves.toBe(row.id);
  });
});
