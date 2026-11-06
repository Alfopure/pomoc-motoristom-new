import { describe, expect, it, vi } from "vitest";
import { DraftVault } from "../drafts/vault";
import { memoryStorage } from "../lib/session-storage";
import type { DraftPort } from "../drafts/port";
import type { UploadFiles } from "../field-work/uploads";
import { MobileApiError } from "../lib/api";
import { TaskPhotoRemoval, TaskPhotos } from "./photos";
import { commandId, orgId, otherId, receipt, scope, stubApi, task, taskId, userId } from "./fixtures.test-helper";
import type { TaskPhotoGrant } from "./api";

const image = { bytes: new Uint8Array([255, 216, 255, 1]), fileName: "kontrola.jpg", mimeType: "image/jpeg" as const, category: "photo" as const };
function setup() {
  const records = new Map<string, object>(); let sequence = 20, active = true;
  const save = (value: object) => { records.set((value as { key: string }).key, structuredClone(value)); };
  const values = new Map<string, Uint8Array>();
  const files: UploadFiles = { read: vi.fn(async id => values.get(id) ?? null), write: vi.fn(async (id, bytes) => { values.set(id, bytes); }), remove: vi.fn(async id => { values.delete(id); }), keepOnly: vi.fn() };
  const port: DraftPort = { load: () => records.get(userId) ?? null, changed: save, prepare: vi.fn(async data => {
    save(typeof data === "function" ? data() : data); return { finish: async (value: object) => { save(value); return true; } };
  }), current: () => active, settled: () => true, reject: vi.fn(), acceptsScope: value => Boolean(value && typeof value === "object" && "organizationId" in value && value.organizationId === orgId) };
  const photoPrepare = vi.fn(async (_id, input) => ({ ...scope, receipt: { ...receipt(input.commandId), task: { ...task, revision: 2 } },
    attachment: { id: input.attachmentId, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes, createdAt: scope.checkedAt },
    upload: { url: "https://nzpnqdstvkfncflgqlny.supabase.co/storage/v1/object/upload/sign/test?token=temporary", token: "temporary", path: "test", method: "PUT", contentType: input.mimeType } } as TaskPhotoGrant));
  const photoConfirm = vi.fn(async (_id, _photoId, input) => ({ ...receipt(input.commandId), task: { ...task, revision: 3 } }));
  const photoUpload = vi.fn(async () => {});
  const api = stubApi({ photoPrepare, photoConfirm, photoUpload });
  const options = { id: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`, files, port: vi.fn((key: string) => ({ ...port, load: () => records.get(key) ?? null })) };
  return { deactivate: () => { active = false; }, create: () => new TaskPhotos(api, userId, options), files, values, port, options, api, photoPrepare, photoConfirm, photoUpload, saved: (key = userId) => records.get(key) ?? null };
}

describe("private task photo lifecycle", () => {
  it("keeps only ids and metadata in the scoped draft, with bytes in the cache", async () => {
    const f = setup(), photos = f.create();
    await photos.select(userId, image);
    const json = JSON.stringify(f.saved());
    expect(json).toContain("kontrola.jpg");
    for (const forbidden of ["uri", "url", "token", "bytes", "authorization"]) expect(json).not.toContain(`"${forbidden}"`);
    expect(f.values.get(photos.get(userId).photo!.attachmentId)).toEqual(image.bytes);
    expect(f.photoPrepare).not.toHaveBeenCalled();
  });
  it("does not leave the phone when its durable write barrier fails", async () => {
    const f = setup(), photos = f.create(); await photos.select(userId, image);
    vi.mocked(f.port.prepare).mockRejectedValueOnce(new Error("disk full"));
    await photos.upload(userId, task);
    expect(f.photoPrepare).not.toHaveBeenCalled();
    expect(photos.get(userId)).toMatchObject({ status: "failed", photo: { taskId: null } });
  });
  it("retries a lost confirmation with exactly the same command after restart", async () => {
    const f = setup(), first = f.create(); await first.select(userId, image);
    f.photoConfirm.mockRejectedValueOnce(new MobileApiError("lost response", 503));
    await first.upload(userId, task);
    expect(first.get(taskId).status).toBe("uncertain");
    first.dispose(); const restored = f.create();
    expect(restored.forTask(taskId)).toBe(taskId);
    await restored.upload(userId, { ...task, revision: 30 });
    expect(f.photoPrepare).toHaveBeenCalledOnce(); expect(f.photoUpload).toHaveBeenCalledOnce();
    expect(f.photoConfirm.mock.calls[1]).toEqual(f.photoConfirm.mock.calls[0]);
    expect(restored.get(userId).photo).toBeNull(); expect(f.values.size).toBe(0);
    expect(JSON.stringify(f.saved())).not.toContain("temporary");
  });
  it("preserves the prepare id after a lost prepare response and does not duplicate on a double press", async () => {
    const f = setup(), photos = f.create(); await photos.select(userId, image);
    f.photoPrepare.mockRejectedValueOnce(new MobileApiError("lost prepare", 0));
    await photos.upload(userId, task);
    await Promise.all([photos.upload(userId, task), photos.upload(userId, task)]);
    expect(f.photoPrepare).toHaveBeenCalledTimes(2);
    expect(f.photoPrepare.mock.calls[1][1]).toEqual(f.photoPrepare.mock.calls[0][1]);
    expect(f.photoConfirm).toHaveBeenCalledOnce();
  });
  it("reports an evicted cache without sending and permits explicit discard", async () => {
    const f = setup(), photos = f.create(); await photos.select(userId, image); f.values.clear();
    await photos.upload(userId, task);
    expect(photos.get(taskId)).toMatchObject({ missing: true, status: "failed" }); expect(f.photoPrepare).not.toHaveBeenCalled();
    await photos.discard(taskId); expect(photos.get(taskId).photo).toBeNull();
  });
  it("requires an explicit retry to rebase a known revision conflict", async () => {
    const f = setup(), photos = f.create(); await photos.select(userId, image);
    f.photoConfirm.mockRejectedValueOnce(new MobileApiError("revision changed", 409));
    await photos.upload(userId, task);
    const first = f.photoConfirm.mock.calls[0][2]; expect(photos.get(taskId).status).toBe("failed");
    f.api.detail = vi.fn(async () => ({ ...scope, task: { ...task, revision: 7 }, activity: [], nextActivityCursor: null }));
    await photos.upload(userId, task);
    expect(f.photoConfirm.mock.calls[1][2]).toMatchObject({ expectedRevision: 7 });
    expect(f.photoConfirm.mock.calls[1][2].commandId).not.toBe(first.commandId);
    expect(f.photoUpload).toHaveBeenCalledOnce();
  });
  it("binds each vault port once and rejects a corrupt pending identity", () => {
    const f = setup(), photos = f.create(); photos.get(userId); photos.get(userId);
    expect(f.options.port).toHaveBeenCalledOnce();
    const corrupt = new TaskPhotos(f.api, otherId, { ...f.options, port: () => ({ ...f.port, load: () => ({ version: 1, key: otherId, photo: { attachmentId: commandId } }) }) });
    expect(corrupt.get(otherId).status).toBe("failed"); expect(f.port.reject).toHaveBeenCalledOnce();
  });
  it("finishes every real vault ticket after successful and failed uploads", async () => {
    const f = setup(); let counter = 100;
    const vault = await DraftVault.open(memoryStorage(), { environment: "test", projectUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", userId, profileId: otherId, organizationId: orgId }, {
      durable: true, uuid: () => `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`, current: () => true, revalidate: async () => {},
    });
    const photos = new TaskPhotos(f.api, userId, { ...f.options, port: key => vault.bind("employee-task-photo", key) });
    await photos.select(userId, image);
    f.photoConfirm.mockRejectedValueOnce(new MobileApiError("lost", 503));
    await photos.upload(userId, task);
    expect(vault.snapshot().busy).toBe(false);
    await photos.upload(userId, task);
    expect(vault.snapshot().busy).toBe(false);
    expect(photos.get(userId).photo).toBeNull();
    photos.dispose(); vault.close();
  });
  it("rebases a known prepare conflict before retrying prepare, never premature confirmation", async () => {
    const f = setup(), photos = f.create(); await photos.select(userId, image);
    f.photoPrepare.mockRejectedValueOnce(new MobileApiError("revision changed", 409));
    await photos.upload(userId, task);
    expect(f.photoConfirm).not.toHaveBeenCalled();
    f.api.detail = vi.fn(async () => ({ ...scope, task: { ...task, revision: 9 }, activity: [], nextActivityCursor: null }));
    await photos.upload(userId, task);
    expect(f.photoPrepare.mock.calls[1][1]).toMatchObject({ expectedRevision: 9 });
    expect(f.photoPrepare.mock.calls[1][1].commandId).not.toBe(f.photoPrepare.mock.calls[0][1].commandId);
    expect(f.photoConfirm).toHaveBeenCalledOnce();
  });

  it("moves a failed creation photo to its task so another new task has an independent selection", async () => {
    const f = setup(), photos = f.create(); await photos.select(userId, image);
    f.photoConfirm.mockRejectedValueOnce(new MobileApiError("lost", 503));
    await photos.upload(userId, task);
    const previous = photos.get(taskId).photo!;
    expect(photos.get(userId).photo).toBeNull();
    await photos.select(userId, { ...image, fileName: "druha.jpg" });
    expect(photos.get(userId).photo?.attachmentId).not.toBe(previous.attachmentId);
    await photos.discard(userId);
    expect(photos.get(taskId).photo).toEqual(previous);
    photos.dispose(); const restored = f.create();
    expect(restored.get(userId).photo).toBeNull(); expect(restored.get(taskId).photo).toEqual(previous);
  });
  it("rebases removal only after a definitive conflict and explicit retry", async () => {
    const f = setup(); let sequence = 200;
    const photoRemove = vi.fn().mockRejectedValueOnce(new MobileApiError("changed", 409)).mockResolvedValueOnce(receipt());
    f.api.photoRemove = photoRemove;
    f.api.detail = vi.fn(async () => ({ ...scope, task: { ...task, revision: 8, attachments: [{ id: otherId, fileName: "a.jpg", mimeType: "image/jpeg" as const, sizeBytes: 4, createdAt: scope.checkedAt }] }, activity: [], nextActivityCursor: null }));
    const removal = new TaskPhotoRemoval(f.api, taskId, otherId, () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`);
    await removal.remove(1); expect(removal.snapshot().status).toBe("conflict"); expect(f.api.detail).not.toHaveBeenCalled();
    await removal.remove(1);
    expect(photoRemove.mock.calls[1][2].expectedRevision).toBe(8);
    expect(photoRemove.mock.calls[1][2].commandId).not.toBe(photoRemove.mock.calls[0][2].commandId);
  });
  it("replays an unknown removal result without rebasing its command", async () => {
    const f = setup(); const photoRemove = vi.fn().mockRejectedValueOnce(new MobileApiError("lost", 503)).mockResolvedValueOnce(receipt()); f.api.photoRemove = photoRemove;
    const removal = new TaskPhotoRemoval(f.api, taskId, otherId, () => commandId);
    await removal.remove(1); expect(removal.snapshot().status).toBe("uncertain");
    await removal.remove(9); expect(photoRemove.mock.calls[1]).toEqual(photoRemove.mock.calls[0]);
  });

  it.each([{ checkpoint: 2, dispose: true }, { checkpoint: 2, dispose: false }, { checkpoint: 3, dispose: true }, { checkpoint: 3, dispose: false }])("does not start a new write after a deferred phase loses its scope: %j", async test => {
    const f = setup(), photos = f.create(); await photos.select(taskId, image);
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const original = vi.mocked(f.port.prepare).getMockImplementation()!;
    for (let index = 1; index < test.checkpoint; index++) vi.mocked(f.port.prepare).mockImplementationOnce(original);
    vi.mocked(f.port.prepare).mockImplementationOnce(async payload => { await paused; return original(payload); });
    const running = photos.upload(taskId, task);
    await vi.waitFor(() => expect(f.port.prepare).toHaveBeenCalledTimes(test.checkpoint));
    if (test.dispose) photos.dispose(); else f.deactivate();
    resume(); await running;
    expect(f.photoUpload).toHaveBeenCalledTimes(test.checkpoint === 2 ? 0 : 1);
    expect(f.photoConfirm).not.toHaveBeenCalled();
  });
  it("does not start removal after logout while reviewing a known conflict", async () => {
    const f = setup(); f.api.photoRemove = vi.fn().mockRejectedValueOnce(new MobileApiError("changed", 409));
    const removal = new TaskPhotoRemoval(f.api, taskId, otherId, () => commandId);
    await removal.remove(1);
    let resume!: (value: Awaited<ReturnType<typeof f.api.detail>>) => void;
    f.api.detail = vi.fn(() => new Promise<Awaited<ReturnType<typeof f.api.detail>>>(resolve => { resume = resolve; }));
    const retry = removal.remove(1); removal.dispose();
    resume({ ...scope, task: { ...task, revision: 9, attachments: [{ id: otherId, fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 4, createdAt: scope.checkedAt }] }, activity: [], nextActivityCursor: null });
    await retry; expect(f.api.photoRemove).toHaveBeenCalledOnce();
  });

  it("can reconcile an uploaded photo after the OS evicted its cache bytes", async () => {
    const f = setup(), photos = f.create(); await photos.select(userId, image);
    f.photoConfirm.mockRejectedValueOnce(new MobileApiError("lost", 503));
    await photos.upload(userId, task); f.values.clear();
    await photos.upload(taskId, task);
    expect(photos.get(taskId).photo).toBeNull();
    expect(f.photoConfirm).toHaveBeenCalledTimes(2); expect(f.photoUpload).toHaveBeenCalledOnce();
  });

});
