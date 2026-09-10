import { beforeEach, describe, expect, it, vi } from "vitest";
import { markNotificationRead, snoozeNotification, updateNotificationStatus } from "./motorist-mutations";

const state = vi.hoisted(() => ({ rpc: vi.fn(), tables: [] as string[], audits: [] as Record<string, unknown>[] }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({
  rpc: state.rpc,
  from: (table: string) => {
    state.tables.push(table);
    const chain = { insert: (payload: Record<string, unknown>) => { state.audits.push(payload); return chain; }, select: () => chain, single: async () => ({ data: { id: "audit" }, error: null }) };
    return chain;
  },
}) }));
const actor = { id: "20000000-0000-0000-0000-000000000001", organization_id: "10000000-0000-0000-0000-000000000001" };
beforeEach(() => { state.tables = []; state.audits = []; state.rpc.mockReset().mockResolvedValue({ data: { id: "notice-1" }, error: null }); });
describe("actor notification mutations", () => {
  it.each(["unread", "read", "archived"] as const)("uses the actual actor's transactional ACL for %s", async (status) => {
    await expect(updateNotificationStatus("notice-1", status, actor)).resolves.toEqual({ id: "notice-1" });
    expect(state.rpc).toHaveBeenCalledWith("motorist_notification_action", { p_organization_id: actor.organization_id, p_actor_id: actor.id, p_action: status, p_notification_id: "notice-1" });
    expect(state.tables).toEqual(["motorist_audit_log"]);
    expect(state.audits[0].actor_profile_id).toBe(actor.id);
  });
  it("does not resolve a fallback owner for the legacy read adapter", async () => {
    await markNotificationRead("notice-1", actor);
    expect(state.rpc).toHaveBeenCalledWith("motorist_notification_action", expect.objectContaining({ p_actor_id: actor.id, p_action: "read" }));
    expect(state.tables).not.toContain("motorist_profiles");
  });
  it.each([["P0002",404],["42501",403],["PGRST202",503]] as const)("rejects %s without audit or alternate write", async (code, status) => {
    state.rpc.mockResolvedValue({ data: null, error: { code, message: "Rejected" } });
    await expect(updateNotificationStatus("notice-1", "archived", actor)).rejects.toMatchObject({ status });
    expect(state.tables).toEqual([]);
  });
  it("snoozes through the same locked actor boundary", async () => {
    const due = new Date(Date.now()+60_000).toISOString();
    await snoozeNotification("notice-1", due, actor);
    expect(state.rpc).toHaveBeenCalledWith("motorist_notification_action", { p_organization_id: actor.organization_id, p_actor_id: actor.id, p_action: "snooze", p_notification_id: "notice-1", p_snoozed_until: due });
    expect(state.audits[0]).toMatchObject({ actor_profile_id: actor.id, action: "notification.snoozed" });
  });
});
