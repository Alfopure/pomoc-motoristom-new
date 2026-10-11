import { describe, expect, it, vi } from "vitest";
import type { MobileCaseCreated } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { CasesApi } from "./api";
import { CaseDraft } from "./draft";
const created: MobileCaseCreated = { ok: true, apiVersion: 1, environment: "test", profileId: "profile", checkedAt: "2026-10-11T12:00:00Z",
  caseId: "00000000-0000-4000-8000-000000000001", caseNumber: "2026-001", warnings: [{ code: "missing", field: "contactPhone", message: "Doplňte telefón." }] };
function fixture() {
  const api: Pick<CasesApi, "create" | "detail"> = { detail: vi.fn(), create: vi.fn().mockResolvedValue(created) };
  return { api, draft: new CaseDraft(api) };
}
describe("case draft save lifecycle", () => {
  it("blocks same-tick double taps and freezes the submitted input while saving", async () => {
    const f = fixture(); let resolve!: (value: MobileCaseCreated) => void;
    vi.mocked(f.api.create).mockReturnValue(new Promise(done => { resolve = done; }));
    f.draft.edit({ contactName: "Kontakt", note: "Rozpracované" });
    const save = f.draft.submit(); const duplicate = f.draft.submit(); f.draft.edit({ contactName: "Changed" });
    expect(f.api.create).toHaveBeenCalledTimes(1); expect(f.draft.snapshot().input.contactName).toBe("Kontakt");
    resolve(created); await Promise.all([save, duplicate]);
    expect(f.draft.snapshot()).toMatchObject({ status: "saved", created });
  });
  it.each([0, 408, 500, 502, 503])("preserves uncertain creation (%i) until fresh list review AND deliberate acknowledgement", async status => {
    const f = fixture(); f.draft.edit({ contactName: "Kontakt", licensePlate: "BA123AB" });
    vi.mocked(f.api.create).mockRejectedValueOnce(new MobileApiError("Unknown save result", status));
    await f.draft.submit(); expect(f.draft.snapshot()).toMatchObject({ status: "uncertain", created: null, input: { contactName: "Kontakt", licensePlate: "BA123AB" } });
    await f.draft.submit(); f.draft.allowRetry(); await f.draft.submit(); expect(f.api.create).toHaveBeenCalledTimes(1);
    f.draft.reviewList(f.draft.snapshot().reviewAfter - 1); f.draft.allowRetry(); expect(f.draft.snapshot().status).toBe("uncertain");
    f.draft.reviewList(f.draft.snapshot().reviewAfter + 1); await f.draft.submit(); expect(f.api.create).toHaveBeenCalledTimes(1);
    f.draft.allowRetry(); await f.draft.submit(); expect(f.api.create).toHaveBeenCalledTimes(2); expect(f.draft.snapshot().created).toEqual(created);
  });
  it("allows an explicit corrected submit after definitive validation failure, preserving the draft", async () => {
    const f = fixture(); f.draft.edit({ contactName: "Original", note: "Keep this" });
    vi.mocked(f.api.create).mockRejectedValueOnce(new MobileApiError("Doplňte platnú hodnotu.", 400));
    await f.draft.submit(); expect(f.draft.snapshot()).toMatchObject({ status: "editing", error: "Doplňte platnú hodnotu.", input: { note: "Keep this" } });
    f.draft.edit({ contactName: "Corrected" }); await f.draft.submit();
    expect(f.api.create).toHaveBeenLastCalledWith(expect.objectContaining({ contactName: "Corrected", note: "Keep this" }));
  });
  it("keeps the successful POST identity and warnings even if detail refresh fails", async () => {
    const f = fixture(); await f.draft.submit();
    vi.mocked(f.api.detail).mockRejectedValue(new MobileApiError("Detail temporarily unavailable", 503));
    await expect(f.api.detail(created.caseId)).rejects.toMatchObject({ status: 503 });
    await f.draft.submit(); expect(f.api.create).toHaveBeenCalledTimes(1);
    expect(f.draft.snapshot()).toMatchObject({ status: "saved", created });
    f.draft.newDraft(); expect(f.draft.snapshot()).toMatchObject({ status: "editing", created: null });
  });
  it("does not clear an unsaved or uncertain draft when reopening the form", async () => {
    const f = fixture(); f.draft.edit({ manualPickupAddress: "Bratislava" }); f.draft.newDraft();
    expect(f.draft.snapshot().input.manualPickupAddress).toBe("Bratislava");
    vi.mocked(f.api.create).mockRejectedValue(new TypeError("Network ended")); await f.draft.submit(); f.draft.newDraft();
    expect(f.draft.snapshot()).toMatchObject({ status: "uncertain", input: { manualPickupAddress: "Bratislava" } });
  });
  it("does not navigate or expose a late result after account disposal", async () => {
    const f = fixture(); let resolve!: (value: MobileCaseCreated) => void;
    vi.mocked(f.api.create).mockReturnValue(new Promise(done => { resolve = done; }));
    const listener = vi.fn(), off = f.draft.subscribe(listener); const save = f.draft.submit();
    f.draft.dispose(); listener.mockClear(); resolve(created); await save;
    expect(listener).not.toHaveBeenCalled(); expect(f.draft.snapshot().created).toBeNull(); off();
    const next = fixture(); expect(next.draft.snapshot().input.contactName).toBeUndefined();
  });
  it("does not count a list response obtained while the save was still pending as uncertainty review", async () => {
    const f = fixture(); let reject!: (error: Error) => void;
    vi.mocked(f.api.create).mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const save = f.draft.submit(); now.mockReturnValue(2000);
      const listBeforeFailure = Date.now(); now.mockReturnValue(3000);
      reject(new MobileApiError("Timeout", 0)); await save;
      f.draft.reviewList(listBeforeFailure); f.draft.allowRetry();
      expect(f.draft.snapshot().status).toBe("uncertain"); expect(f.draft.snapshot().reviewedList).toBe(false);
      f.draft.reviewList(4000); f.draft.allowRetry(); expect(f.draft.snapshot().status).toBe("editing");
    } finally { now.mockRestore(); }
  });

});
