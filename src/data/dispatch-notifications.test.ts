import { describe, expect, it, vi } from "vitest";
import { loadDispatchNotifications } from "./dispatch-repository";

const identities = vi.hoisted(() => ({ org: "10000000-0000-0000-0000-000000000001", a: "20000000-0000-0000-0000-000000000001", b: "20000000-0000-0000-0000-000000000002", admin: "20000000-0000-0000-0000-000000000003" }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({
  from: (table: string) => {
    if (table !== "motorist_notifications") throw new Error(`Unexpected organization-wide lookup: ${table}`);
    const rows = [
      { id: "a", organization_id: identities.org, recipient_profile_id: identities.a, visibility: "private", title: "PRIVATE A" },
      { id: "b", organization_id: identities.org, recipient_profile_id: identities.b, visibility: "private", title: "PRIVATE B" },
      { id: "team", organization_id: identities.org, recipient_profile_id: null, visibility: "team", title: "Historical team" },
    ].map(row => ({ ...row, status: "unread", payload: {}, kind: "task_due", severity: "info", created_at: "2026-09-10T12:00:00Z", updated_at: "2026-09-10T12:00:00Z" }));
    let organization: string | undefined, audience: string | undefined;
    const query = {
      select: () => query, neq: () => query, not: () => query, order: () => query, limit: () => query,
      eq: (column: string, value: string) => { if (column === "organization_id") organization = value; return query; },
      or: (predicate: string) => { audience = predicate; return query; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null, data: rows.filter(row => row.organization_id === organization && (!audience || row.visibility === "team" || (row.visibility === "private" && audience.includes(`recipient_profile_id.eq.${row.recipient_profile_id}`)))) }).then(resolve),
    };
    return query;
  },
}) }));

describe("service-role notification snapshot", () => {
  it("returns A's personal rows without B's body or title", async () => {
    const result = await loadDispatchNotifications(identities.org, identities.a);
    expect(result.map(row => row.id).sort()).toEqual(["a", "team"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE B");
  });
  it("product administrator has no implicit access to A or B", async () => {
    const result = await loadDispatchNotifications(identities.org, identities.admin);
    expect(result.map(row => row.id)).toEqual(["team"]);
  });
  it("a missing actor never falls back to another organization member", async () => {
    expect((await loadDispatchNotifications(identities.org, "")).map(row => row.id)).toEqual(["team"]);
  });
});
