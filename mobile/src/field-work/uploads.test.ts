import { describe, expect, it, vi } from "vitest";
import { MobileApiError } from "../lib/api";
import { memoryStorage, type StorageDriver } from "../lib/session-storage";
import { TowingUploads, towingUploadsKey, type TowingUpload, type UploadFiles } from "./uploads";

const id = (n: number) => `98000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = id(1), MEMBER = id(2), ORDER = id(3), OTHER_ORDER = id(4);
const scope = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", projectUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", userId: USER, memberId: MEMBER };
const bytes = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 255, 217]);
const upload = (n: number, orderId = ORDER) => ({ orderId, attachmentId: id(100 + n), commandId: id(200 + n), kind: "work" as const, expectedRevision: 7, assignmentGeneration: 2,
  fileName: "foto.jpg", mimeType: "image/jpeg" as const, sizeBytes: bytes.length });
function memoryFiles() {
  const files = new Map<string, Uint8Array>();
  const store: UploadFiles = { read: vi.fn(async (key: string) => files.get(key) ?? null), write: vi.fn(async (key: string, value: Uint8Array) => { files.set(key, value.slice()); }),
    remove: vi.fn(async (key: string) => { files.delete(key); }),
    keepOnly: vi.fn(async (ids: string[]) => { for (const key of [...files.keys()]) if (!ids.includes(key)) files.delete(key); }) };
  return { files, store };
}
async function ready(send: (record: TowingUpload, bytes: Uint8Array) => Promise<unknown>, storage: StorageDriver = memoryStorage(), files = memoryFiles()) {
  const uploads = new TowingUploads(storage, files.store, scope, send, { current: () => true, clock: () => Date.parse("2026-10-28T08:00:00Z") });
  await uploads.load();
  return { uploads, storage, files };
}
const saved = async (storage: StorageDriver) => JSON.parse((await storage.getItem(towingUploadsKey(scope)))!).uploads;

describe("towing uploads kept on the phone", () => {
  it("is scoped to the environment, project, user and member", () => {
    expect(towingUploadsKey(scope)).toBe(`pm-towing-uploads-v1.test.nzpnqdstvkfncflgqlny.${USER}.${MEMBER}`);
    expect(() => towingUploadsKey({ ...scope, projectUrl: "https://ifpaeegaesdmljfkdvcn.supabase.co" })).toThrow();
  });
  it("keeps the ids and the bytes before sending and forgets both once confirmed", async () => {
    const storage = memoryStorage(), files = memoryFiles();
    const send = vi.fn(async (record: TowingUpload, sent: Uint8Array) => {
      expect(await saved(storage)).toEqual([{ ...upload(1), createdAt: "2026-10-28T08:00:00.000Z" }]);
      expect(files.files.get(record.attachmentId)).toEqual(sent);
      return { ok: true };
    });
    const { uploads } = await ready(send, storage, files);
    await expect(uploads.start(upload(1), bytes)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith({ ...upload(1), createdAt: "2026-10-28T08:00:00.000Z" }, bytes);
    expect(uploads.snapshot().uploads).toEqual([]);
    expect(await saved(storage)).toEqual([]);
    expect(files.files.size).toBe(0);
  });
  it("after a restart resumes with the same ids and bytes, never on its own", async () => {
    const send = vi.fn().mockRejectedValueOnce(new MobileApiError("Spojenie sa prerušilo.", 0)).mockResolvedValueOnce({ ok: true });
    const first = await ready(send);
    await expect(first.uploads.start(upload(2), bytes)).resolves.toBe(false);
    expect(first.uploads.forOrder(ORDER)).toMatchObject({ status: "failed", message: "Spojenie sa prerušilo." });
    const restored = await ready(send, first.storage, first.files);
    expect(restored.uploads.snapshot().uploads).toMatchObject([{ attachmentId: id(102), commandId: id(202), status: "waiting", missing: false, message: null }]);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(restored.uploads.resume(id(102))).resolves.toBe(true);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(restored.uploads.snapshot().uploads).toEqual([]);
  });
  it("removes bytes that no stored upload refers to when it loads", async () => {
    const send = vi.fn().mockRejectedValue(new MobileApiError("offline", 0));
    const first = await ready(send);
    await first.uploads.start(upload(10), bytes);
    first.files.files.set(id(999), bytes);
    const restored = await ready(send, first.storage, first.files);
    expect([...restored.files.files.keys()]).toEqual([id(110)]);
    expect(restored.uploads.forOrder(ORDER)).toMatchObject({ missing: false });
  });
  it("offers only abandoning when the phone no longer has the bytes", async () => {
    const send = vi.fn().mockRejectedValue(new MobileApiError("offline", 0));
    const first = await ready(send);
    await first.uploads.start(upload(3), bytes);
    first.files.files.clear();
    const restored = await ready(send, first.storage, first.files);
    expect(restored.uploads.forOrder(ORDER)).toMatchObject({ missing: true });
    await expect(restored.uploads.resume(id(103))).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(restored.uploads.discard(id(103))).resolves.toBe(true);
    expect(await saved(restored.storage)).toEqual([]);
  });
  it("forgets an upload the server already shows ready, but not one still pending", async () => {
    const send = vi.fn().mockRejectedValue(new MobileApiError("offline", 0));
    const { uploads, files } = await ready(send);
    await uploads.start(upload(4), bytes);
    await uploads.settle({ id: ORDER, attachments: [{ id: id(104), kind: "work", name: "foto.jpg", mimeType: "image/jpeg", status: "pending", createdAt: "2026-10-28T08:00:00Z" }] });
    expect(uploads.forOrder(ORDER)).toBeDefined();
    await uploads.settle({ id: ORDER, attachments: [{ id: id(104), kind: "work", name: "foto.jpg", mimeType: "image/jpeg", status: "ready", createdAt: "2026-10-28T08:00:00Z" }] });
    expect(uploads.forOrder(ORDER)).toBeUndefined();
    expect(files.files.size).toBe(0);
  });
  it("sends nothing it could not keep, and one unfinished upload per order", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const storage = memoryStorage(), files = memoryFiles();
    const { uploads } = await ready(send, storage, files);
    vi.spyOn(storage, "setItem").mockRejectedValueOnce(new Error("Keychain locked"));
    await expect(uploads.start(upload(5), bytes)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(files.files.size).toBe(0);
    expect(uploads.snapshot().error).toContain("Neodoslala sa");
    send.mockRejectedValueOnce(new MobileApiError("offline", 0));
    await uploads.start(upload(6), bytes);
    await expect(uploads.start(upload(7), bytes)).resolves.toBe(false);
    await expect(uploads.start(upload(8, OTHER_ORDER), bytes)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("keeps a refused upload for the person to abandon, with the server's reason", async () => {
    const send = vi.fn().mockRejectedValue(new MobileApiError("Zákazka už nie je vo vašom zozname.", 404));
    const { uploads } = await ready(send);
    await uploads.start(upload(9), bytes);
    expect(uploads.forOrder(ORDER)).toMatchObject({ status: "failed", message: "Zákazka už nie je vo vašom zozname." });
  });
  it("rejects a stored list of another account or with a broken record", async () => {
    const storage = memoryStorage();
    await storage.setItem(towingUploadsKey(scope), JSON.stringify({ version: 1, scope: { ...scope, memberId: id(9) }, uploads: [] }));
    const other = await ready(vi.fn(), storage);
    expect(other.uploads.snapshot()).toMatchObject({ ready: false, error: expect.stringContaining("nepodarilo načítať") });
    await storage.setItem(towingUploadsKey(scope), JSON.stringify({ version: 1, scope, uploads: [{ ...upload(1), createdAt: "2026-10-28T08:00:00Z", extra: 1 }] }));
    expect((await ready(vi.fn(), storage)).uploads.snapshot().ready).toBe(false);
  });
});
