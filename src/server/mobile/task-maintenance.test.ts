import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
import { maintainEmployeeTasks } from "./task-maintenance";
const ORG = "20000000-0000-4000-8000-000000000001", TASK = "30000000-0000-4000-8000-000000000001", PHOTO = "40000000-0000-4000-8000-000000000001";
const path = `${ORG}/${TASK}/${PHOTO}.jpg`;
function fixture() {
  const removed = vi.fn(async () => ({ error: null as null | { message: string } }));
  const responses: Record<string, { data?: unknown; error?: { code: string } | null }> = {
    motorist_employee_tasks_tick: { data: { recurrences: 1, reminders: 2 }, error: null },
    motorist_employee_tasks_cleanup: { data: [{ id: PHOTO, bucket: "motorist-task-photos", path }], error: null },
    motorist_employee_tasks_cleanup_finish: { data: 1, error: null },
  };
  const rpc = vi.fn((name: string) => ({ abortSignal: vi.fn(async () => responses[name]) }));
  const admin = { rpc, storage: { from: vi.fn(() => ({ remove: removed })) } } as unknown as SupabaseClient;
  return { admin, rpc, removed, responses };
}
beforeEach(() => vi.useRealTimers());
afterEach(() => vi.restoreAllMocks());
describe("bounded employee task maintenance in the existing cron", () => {
  it("materializes tasks then deletes only validated paths and acknowledges successful cleanup", async () => {
    const f = fixture(), result = await maintainEmployeeTasks(ORG, Date.now() + 12_000, f.admin);
    expect(result).toEqual({ status: "ok", recurrences: 1, reminders: 2, photosRemoved: 1, failed: 0 });
    expect(f.removed).toHaveBeenCalledWith([path]);
    expect(f.rpc).toHaveBeenLastCalledWith("motorist_employee_tasks_cleanup_finish", { p_organization_id: ORG, p_ids: [PHOTO] });
  });
  it("does no work when its remaining budget is insufficient", async () => {
    const f = fixture(); expect(await maintainEmployeeTasks(ORG, Date.now() + 1_000, f.admin)).toMatchObject({ status: "budget" }); expect(f.rpc).not.toHaveBeenCalled();
  });
  it("supports a deployment whose task extension migration is not yet available", async () => {
    const f = fixture(); f.responses.motorist_employee_tasks_tick = { error: { code: "PGRST202" } };
    expect(await maintainEmployeeTasks(ORG, Date.now() + 12_000, f.admin)).toMatchObject({ status: "unavailable", photosRemoved: 0 }); expect(f.removed).not.toHaveBeenCalled();
  });
  it("does not delete a foreign organization path", async () => {
    const f = fixture(); f.responses.motorist_employee_tasks_cleanup = { data: [{ id: PHOTO, bucket: "motorist-task-photos", path: "foreign/" + path }] };
    expect(await maintainEmployeeTasks(ORG, Date.now() + 12_000, f.admin)).toMatchObject({ failed: 1, photosRemoved: 0 }); expect(f.removed).not.toHaveBeenCalled();
  });
  it("keeps failed object deletions eligible for a later retry", async () => {
    const f = fixture(); f.removed.mockResolvedValueOnce({ error: { message: "offline" } });
    expect(await maintainEmployeeTasks(ORG, Date.now() + 12_000, f.admin)).toMatchObject({ failed: 1, photosRemoved: 0 });
    expect(f.rpc).not.toHaveBeenCalledWith("motorist_employee_tasks_cleanup_finish", expect.anything());
  });
  it("reports a failed cleanup acknowledgement without pretending completion", async () => {
    const f = fixture(); f.responses.motorist_employee_tasks_cleanup_finish = { error: { code: "timeout" } };
    expect(await maintainEmployeeTasks(ORG, Date.now() + 12_000, f.admin)).toMatchObject({ failed: 1, photosRemoved: 0 });
  });
  it("checks the budget again after tick before storage work", async () => {
    const f = fixture(), initial = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(initial).mockReturnValueOnce(initial).mockReturnValueOnce(initial).mockReturnValue(initial + 11_000);
    expect(await maintainEmployeeTasks(ORG, initial + 12_000, f.admin)).toMatchObject({ status: "budget", photosRemoved: 0 }); expect(f.removed).not.toHaveBeenCalled();
  });
});
