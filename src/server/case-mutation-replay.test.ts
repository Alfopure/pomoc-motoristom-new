import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => mocks }));
import { updateCase } from "./motorist-mutations";
import { caseMutationIdentity } from "./case-atomic-save";
const input = { mutationId: "40000000-0000-4000-8000-000000000001", expectedUpdatedAt: "2026-09-11T10:00:00Z", priority: "urgent" as const };
beforeEach(() => { mocks.rpc.mockReset(); mocks.from.mockReset(); });
describe("case mutation reconciliation before planning", () => {
  it("returns the exact receipt before missing relations or stale vehicle proof can reject a committed save", async () => {
    const receipt = { id: "case", updated_at: "committed", priority: "urgent" };
    mocks.rpc.mockResolvedValue({ data: receipt, error: null });
    const result = await updateCase("case", input, "actor", "org");
    expect(result.caseRow).toEqual(receipt);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("motorist_case_mutation_result", expect.objectContaining({ p_organization_id: "org", p_actor_id: "actor", p_mutation_id: input.mutationId }));
  });
  it("rejects changed payload reuse without attempting a write or planning", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PT422" } });
    await expect(updateCase("case", input, "actor", "org")).rejects.toMatchObject({ status: 422, code: "CASE_MUTATION_MISMATCH" });
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("canonicalizes key ordering while binding every payload field and expected revision", () => {
    expect(caseMutationIdentity(input)).toEqual(caseMutationIdentity({ priority: input.priority, expectedUpdatedAt: input.expectedUpdatedAt, mutationId: input.mutationId }));
    expect(caseMutationIdentity(input)?.fingerprint).not.toBe(caseMutationIdentity({ ...input, expectedUpdatedAt: "2026-09-11T11:00:00Z" })?.fingerprint);
    expect(caseMutationIdentity(input)?.fingerprint).not.toBe(caseMutationIdentity({ ...input, priority: "low" })?.fingerprint);
  });
});
