import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ rpc: mocks.rpc }) }));
import { loadNotes, loadNote, saveNote, validateNoteInput, noteErrorResponse } from "./notes";
import type { MotoristActor } from "./api-auth";
const actor: MotoristActor = { userId: "u", profileId: "a", organizationId: "org", role: "admin", displayName: "A" };
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => mocks.rpc.mockReset().mockResolvedValue({ data: [], error: null }));
describe("notebook authenticated RPC boundary", () => {
  it("sends explicit actor/org scope even for admins", async () => {
    await loadNotes(actor); expect(mocks.rpc).toHaveBeenCalledWith("motorist_notebook", { p_organization_id: "org", p_actor_profile_id: "a", p_action: "list" });
  });
  it("default creation is private and updates require a revision", async () => {
    await saveNote(actor, { title: "private", body: "secret" }); expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_recipients: [], p_expected_revision: null });
    expect(() => validateNoteInput({ title: "x", body: "y" })).toThrow("verzia");
  });
  it.each([[id, id], ["bad"], Array(101).fill(id)])("rejects invalid recipients %j", recipientProfileIds => {
    expect(() => validateNoteInput({ title: "x", body: "y", recipientProfileIds }, true)).toThrow();
  });
  it("does not expose database detail in responses or logs", async () => {
    const log = vi.spyOn(console, "error");
    mocks.rpc.mockResolvedValue({ error: { code: "XX000", message: "Secret notebook body" } });
    let response!: Response; try { await loadNote(actor, id); } catch (error) { response = noteErrorResponse(error); }
    expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(await response.text()).not.toContain("Secret"); expect(log).not.toHaveBeenCalled(); log.mockRestore();
  });
  it.each([["42501",403], ["P0002",404], ["40001",409]])("maps %s without leaking its detail", async (code, status) => {
    mocks.rpc.mockResolvedValue({ error: { code, message: "private" } }); await expect(loadNote(actor, id)).rejects.toMatchObject({ status });
  });
});
