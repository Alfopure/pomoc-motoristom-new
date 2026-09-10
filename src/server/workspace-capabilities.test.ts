import { beforeEach, describe, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc }) }));
import { loadWorkspaceCapabilities } from "./workspace-capabilities";
const actor = { organizationId: "10000000-0000-4000-8000-000000000001", profileId: "20000000-0000-4000-8000-000000000001" };
beforeEach(() => rpc.mockReset());
describe("workspace activation boundary", () => {
  it("uses the actual organization and actor when reading database capabilities", async () => {
    rpc.mockResolvedValue({ data: { notes: true, tasks: false, atomicCaseSave: true, pdf: true }, error: null });
    expect(await loadWorkspaceCapabilities(actor)).toEqual({ notes: true, tasks: false, atomicCaseSave: true, pdf: true });
    expect(rpc).toHaveBeenCalledWith("motorist_workspace_capabilities", { p_organization_id: actor.organizationId, p_actor_id: actor.profileId });
  });
  it.each(["PGRST202", "42883"])("keeps new UI unavailable before the capability function exists: %s", async code => {
    rpc.mockResolvedValue({ data: null, error: { code } });
    expect(await loadWorkspaceCapabilities(actor)).toEqual({ notes: false, tasks: false, atomicCaseSave: false, pdf: false });
  });
  it.each([["42501",403],["08006",503],["40001",503]])("does not turn %s into permission to use legacy writers", async (code,status) => {
    rpc.mockResolvedValue({ data: null, error: { code } });
    await expect(loadWorkspaceCapabilities(actor)).rejects.toMatchObject({ status });
  });
  it("rejects an absent or malformed result", async () => {
    for (const data of [null, [], "enabled"]) {
      rpc.mockResolvedValue({ data, error: null });
      await expect(loadWorkspaceCapabilities(actor)).rejects.toMatchObject({ status: 503 });
    }
  });
});
