import { describe, expect, it, vi } from "vitest";
import { AttachmentDraft } from "./attachments";
import { DraftNotSentError } from "../drafts/port";
import { MobileApiError } from "../lib/api";
import { deferred, jsonCopy, memoryPort } from "./draft-test-port";
const caseId = "00000000-0000-4000-8000-000000000002", mutationId = "00000000-0000-4000-8000-000000000004";
const revision = "2026-10-12T15:00:00.000001Z";
const file = { bytes: new Uint8Array([255, 216, 255, 224, 12]), mimeType: "image/jpeg" as const, fileName: "Auto.jpg", category: "photo" as const };
const scope = { ok: true as const, apiVersion: 1 as const, environment: "test" as const, profileId: "00000000-0000-4000-8000-000000000001", checkedAt: "2026-10-12T15:00:00Z" };
const receipt = { ...scope, caseId, mutationId, committedRevision: "2026-10-12T15:00:00.000002Z", refreshRequired: true as const,
  attachment: { id: mutationId, fileName: file.fileName, mimeType: file.mimeType, category: file.category, sizeBytes: file.bytes.length, note: "Presná poznámka", createdAt: scope.checkedAt, downloadable: true } };
function fixture(saved: unknown = null) {
  const storage = memoryPort(saved), upload = vi.fn(async () => receipt);
  const draft = new AttachmentDraft({ upload }, caseId, () => mutationId, storage.port);
  return { ...storage, draft, upload };
}
function select(draft: AttachmentDraft) { draft.select(file); draft.editNote("Presná poznámka"); }
describe("durable attachment metadata without file persistence", () => {
  it("prepares before transport, synchronously blocks duplicate save, and publishes not-sent editing after failure", async () => {
    const f = fixture(), wait = deferred<void>(); select(f.draft);
    vi.mocked(f.port.prepare).mockImplementationOnce(async () => { await wait.promise; throw new DraftNotSentError(); });
    const saving = f.draft.save(revision); await f.draft.save(revision);
    expect(f.draft.snapshot().status).toBe("saving"); expect(f.upload).not.toHaveBeenCalled();
    wait.resolve(); await saving;
    expect(f.upload).not.toHaveBeenCalled(); expect(f.record.payload).toMatchObject({ status: "editing", pending: null });
  });
  it("restores in-flight marker as unknown without bytes, disallows replay, and requires fresh scoped list plus manual review", async () => {
    const f = fixture(), wait = deferred<typeof receipt>(); select(f.draft); f.upload.mockImplementationOnce(() => wait.promise);
    const saving = f.draft.save(revision); await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
    const marker = jsonCopy(f.record.payload), restored = fixture(marker), state = restored.draft.snapshot();
    expect(JSON.stringify(marker)).not.toMatch(/"bytes"|"uri"|"payload"/);
    expect(state).toMatchObject({ status: "uncertain", coldMissingFile: true, reviewedList: false });
    await restored.draft.reconcile(); restored.draft.select(file); restored.draft.allowNewSelection(); expect(restored.upload).not.toHaveBeenCalled(); expect(restored.draft.snapshot().status).toBe("uncertain");
    const list = { ...scope, caseId, caseRevision: revision, attachments: [receipt.attachment] };
    restored.draft.reviewList(list, state.reviewAfter - 1); expect(restored.draft.snapshot().reviewedList).toBe(false);
    restored.draft.reviewList({ ...list, caseId: mutationId }, state.reviewAfter + 1); expect(restored.draft.snapshot().reviewedList).toBe(false);
    restored.draft.reviewList({ ...list, profileId: mutationId }, state.reviewAfter + 1); expect(restored.draft.snapshot().reviewedList).toBe(false);
    restored.draft.reviewList(list, state.reviewAfter + 1); expect(restored.draft.snapshot().status).toBe("uncertain"); expect(restored.draft.snapshot().receipt).toBeNull();
    restored.draft.allowNewSelection(); expect(restored.draft.snapshot()).toMatchObject({ status: "editing", note: "Presná poznámka", selected: null, coldMissingFile: false });
    wait.resolve(receipt); await saving;
  });
  it("restores unsent metadata with note, but requires a fresh file selection before upload", async () => {
    const f = fixture(); select(f.draft); const restored = fixture(f.record.payload);
    expect(restored.draft.snapshot()).toMatchObject({ status: "editing", coldMissingFile: true, note: "Presná poznámka" });
    await restored.draft.save(revision); expect(restored.upload).not.toHaveBeenCalled(); restored.draft.select(file); await restored.draft.save(revision); expect(restored.upload).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 409, 422])("keeps exact live bytes and command after ambiguous upload then denial %i", async status => {
    const f = fixture(); select(f.draft); f.upload.mockRejectedValueOnce(new MobileApiError("unknown", 0)).mockRejectedValueOnce(new MobileApiError("denied", status));
    await f.draft.save(revision); await f.draft.reconcile(); expect(f.draft.snapshot().status).toBe("uncertain");
    expect(f.upload.mock.calls[1]).toEqual(f.upload.mock.calls[0]); expect(f.record.payload).toMatchObject({ status: "uncertain" });
  });
  it("records confirmed late receipt after disposal and blocks reset after receipt storage failure", async () => {
    const f = fixture(), wait = deferred<typeof receipt>(); select(f.draft); f.upload.mockImplementationOnce(() => wait.promise);
    const saving = f.draft.save(revision); await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce()); f.draft.dispose(); wait.resolve(receipt); await saving;
    expect(f.record.payload).toMatchObject({ status: "saved", receipt }); expect(f.draft.snapshot().receipt).toBeNull();
    const failed = fixture(); select(failed.draft); failed.record.finishOk = false; await failed.draft.save(revision); failed.draft.reset();
    expect(failed.draft.snapshot().status).toBe("saved"); await failed.draft.save(revision); expect(failed.upload).toHaveBeenCalledOnce();
  });
  it("rejects malformed/cross-scope metadata and treats malformed successful receipt as uncertain", async () => {
    const f = fixture(); select(f.draft); await f.draft.save(revision);
    for (const patch of [{ version: 2 }, { uri: "file://secret" }, { receipt: { ...receipt, profileId: mutationId } }, { selected: { ...f.draft.snapshot().selected, sizeBytes: 0 } }]) {
      const restored = fixture({ ...(f.record.payload as object), ...patch }); expect(restored.record.reject).toBe(true); restored.draft.select(file); await restored.draft.save(revision); expect(restored.upload).not.toHaveBeenCalled();
    }
    const bad = fixture(); select(bad.draft); bad.upload.mockResolvedValueOnce({ ...receipt, committedRevision: revision }); await bad.draft.save(revision); expect(bad.draft.snapshot().status).toBe("uncertain");
  });
});
