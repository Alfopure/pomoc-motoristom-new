import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { CaseWritePlan, commitAtomicCaseSave } from "./case-atomic-save";
const input = { organizationId: "org", actorId: "actor", caseId: "case", expectedUpdatedAt: "2026-09-10T11:00:00Z", casePatch: { priority: "high" }, related: [], fieldLabels: {} };
describe("atomic case mutation boundary", () => {
  it("prepares related writes without a database and submits one RPC", async () => {
    const plan = new CaseWritePlan();
    const id = plan.write("motorist_contacts", null, { name: "New" });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    plan.write("motorist_vehicles", "existing", { license_plate: "NEW" }, "earlier");
    const rpc = vi.fn(async () => ({ data: { id: "case", updated_at: "next" }, error: null }));
    const result = await commitAtomicCaseSave({ rpc } as unknown as SupabaseClient<Database>, { ...input, related: plan.writes });
    expect(result.updated_at).toBe("next");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("motorist_save_case_atomic", expect.objectContaining({ p_expected_updated_at: input.expectedUpdatedAt, p_related: plan.writes }));
  });
  it.each([["PT409", 409], ["40001", 409], ["42501", 403], ["P0002", 404], ["23514", 500]])("maps SQL %s without attempting a fallback write", async (code, status) => {
    const rpc = vi.fn(async () => ({ data: null, error: { code } }));
    await expect(commitAtomicCaseSave({ rpc } as unknown as SupabaseClient<Database>, input)).rejects.toMatchObject({ status });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each(["PT409", "40001"])("preserves the editor conflict contract for %s and leaves the draft revision untouched", async code => {
    const draft = { ...input, related: [{ table: "motorist_contacts" as const, id: "contact", insert: false, patch: { name: "Unsaved" }, expectedUpdatedAt: "earlier" }] };
    const original = structuredClone(draft);
    const rpc = vi.fn(async () => ({ data: null, error: { code, message: "Private database detail" } }));
    await expect(commitAtomicCaseSave({ rpc } as unknown as SupabaseClient<Database>, draft)).rejects.toMatchObject({
      status: 409, code: "CASE_REVISION_CONFLICT",
      message: "Prípad medzitým zmenil iný používateľ. Načítajte aktuálny stav; vaše zmeny zostávajú v editore.",
    });
    expect(draft).toEqual(original);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("motorist_save_case_atomic", expect.objectContaining({
      p_expected_updated_at: original.expectedUpdatedAt, p_case_patch: original.casePatch, p_related: original.related,
    }));
  });
});
