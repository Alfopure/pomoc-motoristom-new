import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakeSupabase, fakeError, type FakeRow } from "@/test/fake-supabase";
import { uploadCaseAttachments } from "./motorist-mutations";
const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
const actor = { userId: "user", profileId: "uploader", organizationId: "org", displayName: "Uploader", role: "dispatcher" as const };
const authorize = vi.fn(async () => actor);
const file = () => new File(["document"], "report.pdf", { type: "application/pdf" });
const old = { id: "old", fileName: "old.pdf", category: "document", storagePath: "org/cases/case/old", extra: "preserve legacy fields" };
function fixture() {
  const f = createFakeSupabase();
  f.db.seed("motorist_organizations", [{ id: "org", slug: "pomoc-motoristom", active: true }]);
  f.db.seed("motorist_cases", [{ id: "case", organization_id: "org", owner_id: "owner", updated_at: "2026-10-01T00:00:00Z", attachments_metadata: [old] }]);
  const storage = { upload: vi.fn<(path: string) => Promise<{ error: null }>>(async () => ({ error: null })), remove: vi.fn<(paths: string[]) => Promise<{ error: { message: string } | null }>>(async () => ({ error: null })) };
  Object.assign(f.admin, { storage: { from: () => storage } }); mocks.admin.mockReturnValue(f.admin);
  const commit = (args: FakeRow) => {
    const row = f.db.rows("motorist_cases")[0];
    if (row.updated_at !== args.p_expected_updated_at) throw fakeError("conflict", "PT409");
    const next = { ...row, ...args.p_case_patch as FakeRow, updated_at: "2026-10-02T00:00:00Z" };
    f.db.update("motorist_cases", next, () => true); return next;
  };
  f.db.registerRpc("motorist_save_case_atomic", commit);
  return { ...f, storage, commit };
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("MOTORIST_ORGANIZATION_ID", "org"); });
it("preserves the winner of simultaneous web uploads and rejects the stale upload", async () => {
  const f = fixture(); let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; }); let count = 0;
  f.storage.upload.mockImplementation(async () => { if (++count === 2) release(); await both; return { error: null }; });
  const results = await Promise.allSettled([uploadCaseAttachments("case", [file()], undefined, authorize), uploadCaseAttachments("case", [file()], undefined, authorize)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  expect(f.db.rows("motorist_cases")[0].attachments_metadata).toEqual([old, expect.objectContaining({ fileName: "report.pdf" })]);
  const committedPaths = (f.db.rows("motorist_cases")[0].attachments_metadata as FakeRow[]).map(item => item.storagePath);
  const loserPaths = f.storage.upload.mock.calls.map(([path]) => path).filter(path => !committedPaths.includes(path));
  expect(loserPaths).toHaveLength(1);
  expect(f.storage.remove).toHaveBeenCalledExactlyOnceWith(loserPaths);
});
it("uses the verified uploader and an immutable command in the transactional save", async () => {
  const f = fixture(); await uploadCaseAttachments("case", [file()], "note", authorize, "photo");
  expect(f.db.log.find(e => e.table === "motorist_save_case_atomic")?.payload).toMatchObject({ p_actor_id: "uploader", p_expected_updated_at: "2026-10-01T00:00:00Z", p_mutation_id: expect.any(String), p_fingerprint: expect.any(String), p_field_labels: { attachments_metadata: "prílohy" } });
  expect(f.db.log.filter(e => e.kind === "query" && e.operation !== "select")).toEqual([]);
});
it.each(["event", "audit"])("does not restore a stale array over a mobile commit after %s failure", async () => {
  const f = fixture(); const mobile = { id: "mobile", fileName: "mobile.jpg" };
  f.db.registerRpc("motorist_save_case_atomic", () => {
    f.db.update("motorist_cases", { attachments_metadata: [old, mobile], updated_at: "2026-10-03T00:00:00Z" }, () => true);
    throw fakeError("transaction failed", "XX000");
  });
  await expect(uploadCaseAttachments("case", [file()], undefined, authorize)).rejects.toMatchObject({ status: 500 });
  expect(f.db.rows("motorist_cases")[0].attachments_metadata).toEqual([old, mobile]);
  expect(f.storage.remove).not.toHaveBeenCalled();
});
it("does not delete a committed object after a lost RPC response", async () => {
  const f = fixture(); f.db.registerRpc("motorist_save_case_atomic", args => { f.commit(args); throw fakeError("connection lost", "PGRST000"); });
  await expect(uploadCaseAttachments("case", [file()], undefined, authorize)).rejects.toMatchObject({ status: 500 });
  expect(f.db.rows("motorist_cases")[0].attachments_metadata).toHaveLength(2);
  expect(f.storage.remove).not.toHaveBeenCalled();
});
it("cleans up successful earlier uploads when a later file fails before any save", async () => {
  const f = fixture(); f.storage.upload.mockResolvedValueOnce({ error: null }).mockRejectedValueOnce(new Error("upload failed"));
  await expect(uploadCaseAttachments("case", [file(), file()], undefined, authorize)).rejects.toThrow("upload failed");
  expect(f.db.log.some(e => e.kind === "rpc")).toBe(false);
  expect(f.storage.remove).toHaveBeenCalledWith([expect.stringMatching(/^org\/cases\/case\//)]);
});
it("preserves a mobile upload committed while web storage upload is in flight", async () => {
  const f = fixture(); const mobile = { id: "mobile", fileName: "mobile.jpg", storagePath: "org/cases/case/mobile/uploader/id" };
  f.storage.upload.mockImplementationOnce(async () => {
    f.db.update("motorist_cases", { attachments_metadata: [old, mobile], updated_at: "2026-10-02T00:00:00Z" }, () => true);
    return { error: null };
  });
  await expect(uploadCaseAttachments("case", [file()], undefined, authorize)).rejects.toMatchObject({ status: 409 });
  expect(f.db.rows("motorist_cases")[0].attachments_metadata).toEqual([old, mobile]);
  const loserPath = f.storage.upload.mock.calls[0][0];
  expect([old.storagePath, mobile.storagePath]).not.toContain(loserPath);
  expect(f.storage.remove).toHaveBeenCalledExactlyOnceWith([loserPath]);
});
it("refuses a foreign verified actor before reading a case or uploading", async () => {
  const f = fixture();
  await expect(uploadCaseAttachments("case", [file()], undefined, async () => ({ ...actor, organizationId: "foreign" }))).rejects.toMatchObject({ status: 403 });
  expect(f.storage.upload).not.toHaveBeenCalled();
  expect(f.db.log.some(e => e.table === "motorist_cases")).toBe(false);
});

it.each(["PT409", "40001"])("cleans only this request's files on definitive %s rollback", async code => {
  const f = fixture(); f.db.failNext("motorist_save_case_atomic", "rpc", fakeError("conflict", code));
  await expect(uploadCaseAttachments("case", [file(), file()], undefined, authorize)).rejects.toMatchObject({ status: 409, code: "CASE_REVISION_CONFLICT" });
  const paths = f.storage.upload.mock.calls.map(([path]) => path);
  expect(paths).not.toContain(old.storagePath);
  expect(f.storage.remove).toHaveBeenCalledExactlyOnceWith(paths);
  expect(f.db.rows("motorist_cases")[0].attachments_metadata).toEqual([old]);
});
it.each(["returned", "thrown"])("preserves the original conflict if cleanup fails (%s)", async failure => {
  const f = fixture(); f.db.failNext("motorist_save_case_atomic", "rpc", fakeError("conflict", "PT409"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const privateDetail = "private/storage/path user@example.com";
  if (failure === "returned") f.storage.remove.mockResolvedValue({ error: { message: privateDetail } });
  else f.storage.remove.mockRejectedValue(new Error(privateDetail));
  await expect(uploadCaseAttachments("case", [file()], undefined, authorize)).rejects.toMatchObject({ status: 409, code: "CASE_REVISION_CONFLICT" });
  expect(f.storage.remove).toHaveBeenCalledExactlyOnceWith([f.storage.upload.mock.calls[0][0]]);
  expect(console.warn).toHaveBeenCalledExactlyOnceWith("Case attachment cleanup failed", { code: "CASE_ATTACHMENT_CLEANUP_FAILED" });
});
it.each(["42501", "P0002", "PT422"])("does not infer cleanup authority from other RPC error %s", async code => {
  const f = fixture(); f.db.failNext("motorist_save_case_atomic", "rpc", fakeError("failed", code));
  await expect(uploadCaseAttachments("case", [file()], undefined, authorize)).rejects.toBeInstanceOf(Error);
  expect(f.storage.remove).not.toHaveBeenCalled();
});
