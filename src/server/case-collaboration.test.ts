import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("@/data/case-detail-repository", () => ({ loadCaseDetail: vi.fn() }));
vi.mock("@/data/dispatch-repository", () => ({ loadDispatchNotifications: vi.fn() }));
import { loadCaseLiveSnapshot, updateCaseEditorPresence } from "./case-collaboration";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadDispatchNotifications } from "@/data/dispatch-repository";
import type { MotoristActor } from "./api-auth";
const actor = { organizationId: "server-org", profileId: "server-profile", displayName: "Server name", role: "dispatcher" } as MotoristActor;
const sessionId = "00000000-0000-4000-8000-000000000001";
describe("server-derived presence identity", () => {
  it.each(["PGRST202", "42883", "42P01"])("fails closed when final authorization loses schema (%s)", async code => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: { versions: {}, editors: [], more: false, details: { cases: [], events: [], submissions: [], contacts: [], vehicles: [], locations: [], profiles: [] } }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code } });
    vi.mocked(createSupabaseAdminClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>);
    vi.mocked(loadDispatchNotifications).mockResolvedValue([]);
    await expect(loadCaseLiveSnapshot(actor, { versions: {} })).rejects.toMatchObject({ status: 503 });
    expect(rpc).toHaveBeenLastCalledWith("motorist_case_collaboration", expect.objectContaining({ p_action: "authorize" }));
  });
  it("keeps initial missing-schema compatibility without reading private relations", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    vi.mocked(createSupabaseAdminClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>);
    vi.mocked(loadDispatchNotifications).mockClear();
    expect(await loadCaseLiveSnapshot(actor, { versions: {} })).toMatchObject({ available: false, changes: [], notifications: [] });
    expect(loadDispatchNotifications).not.toHaveBeenCalled();
  });
  it("rejects a revocation discovered after reading the coherent snapshot", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: { versions: {}, editors: [], more: false, details: { cases: [], events: [], submissions: [], contacts: [], vehicles: [], locations: [], profiles: [] } }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "42501" } });
    vi.mocked(createSupabaseAdminClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>);
    await expect(loadCaseLiveSnapshot(actor, { versions: {} })).rejects.toMatchObject({ status: 403 });
  });
  it.each([undefined, { cases: [] }])("rejects the old incomplete manifest instead of acknowledging absent card data (%s)", async details => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: { versions: {}, editors: [], details }, error: null });
    vi.mocked(createSupabaseAdminClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>);
    await expect(loadCaseLiveSnapshot(actor, { versions: {} })).rejects.toMatchObject({ status: 503 });
  });
  it("rejects forged identity and unsubmitted personal content before RPC", async () => {
    const rpc = vi.fn();
    for (const extra of [{ profileId: "other" }, { displayName: "Other" }, { contactPhone: "+421123" }, { draft: { name: "Customer" } }]) {
      await expect(updateCaseEditorPresence(actor, { action: "heartbeat", sessionId, ...extra }, { rpc })).rejects.toMatchObject({ status: 400 });
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it("binds each heartbeat to the authenticated actor and propagates denied case access", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    await updateCaseEditorPresence(actor, { action: "heartbeat", sessionId, caseId: null }, { rpc });
    expect(rpc).toHaveBeenCalledWith("motorist_case_collaboration", { p_organization_id: "server-org", p_actor_profile_id: "server-profile", p_action: "heartbeat", p_input: { sessionId, caseId: null } });
    rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } });
    await expect(updateCaseEditorPresence(actor, { action: "heartbeat", sessionId }, { rpc })).rejects.toMatchObject({ status: 403 });
  });
});
