import { describe, expect, it, vi } from "vitest";
import type { MobileCaseDetailData, MobileCaseUpdated } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import { CaseEdit } from "./edit";
const id = "00000000-0000-4000-8000-000000000001", mutationId = "00000000-0000-4000-8000-000000000002";
const source: MobileCaseDetailData = { id, caseNumber: "PM-1", status: "dispatched", statusLabel: "Vyslané", priority: "normal", priorityLabel: "Bežná",
  owner: { id, name: "Operátor", mine: true }, contact: { name: "Pôvodné meno", phone: "0900" }, vehicle: { licensePlate: "BA123AA", description: "Make Model" },
  pickupAddress: "Mapped pickup", destinationAddress: null, summary: "Porucha", createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00.123456Z",
  mainNote: "Pôvodná poznámka", incidentDescription: "Porucha", jobTypeLabels: ["Odťah"], timeline: [], statusOptions: [{ value: "open", label: "Otvorený" }],
  editable: { contactName: "Pôvodné meno", contactPhone: "0900", licensePlate: "BA123AA", vehicleMake: "Make", vehicleModel: "Model", manualPickupAddress: "Mapped pickup",
    manualDestinationAddress: "", incidentDescription: "Porucha", note: "Pôvodná poznámka", priority: "normal", jobTypes: ["tow"], status: "dispatched" } };
const scope = { ok: true as const, apiVersion: 1 as const, environment: "test" as const, profileId: id, checkedAt: "2026-10-11T12:01:00Z" };
const receipt: MobileCaseUpdated = { ...scope, caseId: id, mutationId, committedRevision: "2026-10-11T12:01:00.654321Z", warnings: [], refreshRequired: true };
function fixture() {
  const api = { update: vi.fn().mockResolvedValue(receipt), detail: vi.fn().mockResolvedValue({ ...scope, case: { ...source, updatedAt: receipt.committedRevision } }) };
  const uuid = vi.fn().mockReturnValueOnce(mutationId).mockReturnValue("00000000-0000-4000-8000-000000000003");
  return { api, uuid, edit: new CaseEdit(api, source, uuid) };
}
describe("revision-safe mobile editor", () => {
  it("sends only changed fields with exact microsecond revision; leaves nonwritable current status untouched", async () => {
    const f = fixture(); f.edit.edit({ contactName: "Nové meno" }); await f.edit.save();
    expect(f.api.update).toHaveBeenCalledExactlyOnceWith(id, { contactName: "Nové meno", expectedUpdatedAt: source.updatedAt, mutationId });
    expect(f.edit.snapshot().status).toBe("committed");
  });
  it.each(["open", "completed_assisted", "completed_no_assistance", "waiting_for_docs", "cancelled", "futile_trip"])("saves supported status %s without unrelated fields", async status => {
    const f = fixture(); f.edit.edit({ status }); await f.edit.save();
    expect(f.api.update).toHaveBeenCalledExactlyOnceWith(id, { status, expectedUpdatedAt: source.updatedAt, mutationId });
  });
  it("does not mutate an unchanged editor or send unsupported status", async () => {
    const f = fixture(); await f.edit.save(); expect(f.api.update).not.toHaveBeenCalled();
    f.edit.edit({ status: "assigned" }); await f.edit.save(); expect(f.api.update).not.toHaveBeenCalled();
    f.edit.edit({ status: "open" }); f.edit.edit({ status: source.editable.status, note: "Only note" }); await f.edit.save();
    expect(f.api.update).toHaveBeenCalledExactlyOnceWith(id, { note: "Only note", expectedUpdatedAt: source.updatedAt, mutationId });
  });
  it("preserves the draft if creating a mutation identity fails", async () => {
    const f = fixture(); f.uuid.mockReset().mockImplementation(() => { throw new Error("Unavailable"); }); f.edit.edit({ note: "Keep" });
    await f.edit.save(); expect(f.api.update).not.toHaveBeenCalled(); expect(f.edit.snapshot()).toMatchObject({ status: "editing", input: { note: "Keep" } });
    expect(f.edit.snapshot().error).toContain("pripraviť");
  });
  it("blocks same-tick duplicate saves and edits while pending", async () => {
    const f = fixture(); let done!: (value: MobileCaseUpdated) => void; f.api.update.mockReturnValue(new Promise(resolve => { done = resolve; }));
    f.edit.edit({ note: "Zmena" }); const first = f.edit.save(); await f.edit.save(); f.edit.edit({ note: "Lost edit" });
    expect(f.api.update).toHaveBeenCalledTimes(1); expect(f.edit.snapshot().input.note).toBe("Zmena"); done(receipt); await first;
  });
  it.each([0, 408, 500, 502, 503])("reconciles only the identical frozen request after uncertain %i", async status => {
    const f = fixture(); f.api.update.mockRejectedValueOnce(new MobileApiError("Unconfirmed", status, "CASE_SAVE_UNCONFIRMED"));
    f.edit.edit({ note: "Exact text", manualPickupAddress: "" }); await f.edit.save(); const request = f.api.update.mock.calls[0][1];
    f.edit.edit({ note: "Must not replace" }); await f.edit.refresh(); f.edit.rebase(); expect(f.edit.snapshot().status).toBe("uncertain");
    expect(f.api.detail).not.toHaveBeenCalled(); await f.edit.save(); expect(f.uuid).toHaveBeenCalledTimes(1);
    expect(f.api.update.mock.calls[1][1]).toBe(request); expect(f.api.update.mock.calls[1][1]).toEqual({ note: "Exact text", manualPickupAddress: "", expectedUpdatedAt: source.updatedAt, mutationId });
  });
  it.each([400, 401, 403, 409, 422])("keeps the original uncertain operation after a later reconciliation denial %i", async status => {
    const f = fixture(); f.api.update.mockRejectedValueOnce(new MobileApiError("Unknown", 0)).mockRejectedValueOnce(new MobileApiError("Later rejection", status));
    f.edit.edit({ note: "Original" }); await f.edit.save(); await f.edit.save(); expect(f.edit.snapshot().status).toBe("uncertain");
    f.edit.edit({ note: "Must stay frozen" }); await f.edit.save(); expect(f.uuid).toHaveBeenCalledTimes(1);
    expect(f.api.update.mock.calls[2][1]).toBe(f.api.update.mock.calls[0][1]); expect(f.api.update.mock.calls[2][1].note).toBe("Original");
  });
  it.each([401, 403, 404])("recovers an initial definitive %i only after a fresh scoped read and explicit rebase", async status => {
    const f = fixture(); f.api.update.mockRejectedValueOnce(new MobileApiError("Denied", status));
    f.edit.edit({ note: "Preserve local delta" }); await f.edit.save();
    expect(f.edit.snapshot()).toMatchObject({ status: "blocked", canRecover: true });
    f.edit.rebase(); await f.edit.save(); expect(f.api.update).toHaveBeenCalledTimes(1);
    f.api.detail.mockResolvedValue({ ...scope, case: { ...source, updatedAt: "2026-10-11T12:04:00.000001Z", editable: { ...source.editable, contactName: "New server name" } } });
    await f.edit.refresh(); expect(f.edit.snapshot().status).toBe("blocked");
    expect(f.edit.snapshot().input.contactName).toBe(source.editable.contactName);
    f.edit.rebase(); expect(f.edit.snapshot()).toMatchObject({ status: "editing", input: { note: "Preserve local delta", contactName: "New server name" } });
    await f.edit.save(); expect(f.api.update.mock.calls[1][1]).toEqual({ note: "Preserve local delta", expectedUpdatedAt: "2026-10-11T12:04:00.000001Z", mutationId: "00000000-0000-4000-8000-000000000003" });
  });
  it("preserves the exact uncertain command even after a typed revision conflict", async () => {
    const f = fixture(); f.api.update.mockRejectedValueOnce(new MobileApiError("Unknown", 0)).mockRejectedValueOnce(new MobileApiError("Conflict", 409, "CASE_REVISION_CONFLICT"));
    f.edit.edit({ note: "Original uncertain" }); await f.edit.save(); await f.edit.save();
    expect(f.edit.snapshot()).toMatchObject({ status: "uncertain", canRecover: false });
    await f.edit.refresh(); f.edit.rebase(); await f.edit.save();
    expect(f.api.detail).not.toHaveBeenCalled(); expect(f.api.update.mock.calls[2][1]).toBe(f.api.update.mock.calls[0][1]); expect(f.uuid).toHaveBeenCalledTimes(1);
  });
  it("keeps denied recovery blocked, and explicitly discards only after an authorized fresh read", async () => {
    const f = fixture(); f.api.update.mockRejectedValueOnce(new MobileApiError("Denied", 403)); f.edit.edit({ note: "Keep" }); await f.edit.save();
    f.api.detail.mockRejectedValueOnce(new MobileApiError("Still denied", 403)); await f.edit.refresh(); f.edit.reload();
    expect(f.edit.snapshot()).toMatchObject({ status: "blocked", input: { note: "Keep" }, latest: null });
    await f.edit.refresh(); f.edit.reload(); expect(f.edit.snapshot()).toMatchObject({ status: "editing", input: source.editable });
    await f.edit.save(); expect(f.api.update).toHaveBeenCalledTimes(1);
  });
  it.each([new MobileApiError("Environment", 409, "environment_mismatch"), new MobileApiError("Mismatch", 422, "CASE_MUTATION_MISMATCH"), new MobileApiError("Unknown conflict", 409)])("cannot recover a protocol/identity denial %j", async error => {
    const f = fixture(); f.api.update.mockRejectedValueOnce(error); f.edit.edit({ note: "Keep" }); await f.edit.save();
    expect(f.edit.snapshot()).toMatchObject({ status: "blocked", canRecover: false });
    await f.edit.refresh(); f.edit.rebase(); f.edit.reload(); await f.edit.save();
    expect(f.api.detail).not.toHaveBeenCalled(); expect(f.api.update).toHaveBeenCalledTimes(1);
  });
  it("does not rebase a denied editor during a pending recovery read or after account disposal", async () => {
    const f = fixture(); f.api.update.mockRejectedValueOnce(new MobileApiError("Denied", 403)); f.edit.edit({ note: "Keep" }); await f.edit.save();
    let resolve!: (value: unknown) => void; f.api.detail.mockReturnValue(new Promise(done => { resolve = done; })); const reading = f.edit.refresh();
    f.edit.rebase(); f.edit.reload(); expect(f.edit.snapshot().status).toBe("blocked"); f.edit.dispose(); resolve({ ...scope, case: source }); await reading;
    expect(f.edit.snapshot().latest).toBeNull(); expect(f.edit.snapshot().input.note).toBe("Keep");
  });
  it("retains local changes on conflict; explicit rebase keeps unrelated latest server fields", async () => {
    const f = fixture(); f.api.update.mockRejectedValueOnce(new MobileApiError("Conflict", 409, "CASE_REVISION_CONFLICT"));
    f.edit.edit({ note: "Local note" }); await f.edit.save(); expect(f.edit.snapshot().status).toBe("conflict");
    const latest = { ...source, updatedAt: "2026-10-11T12:02:00.999999Z", editable: { ...source.editable, contactName: "Server name", note: "Server note" } };
    f.api.detail.mockResolvedValue({ ...scope, case: latest }); await f.edit.refresh(); expect(f.edit.snapshot().input.note).toBe("Local note");
    f.edit.rebase(); expect(f.edit.snapshot().input).toMatchObject({ contactName: "Server name", note: "Local note" });
    await f.edit.save(); expect(f.api.update.mock.calls[1][1]).toEqual({ note: "Local note", expectedUpdatedAt: latest.updatedAt, mutationId: "00000000-0000-4000-8000-000000000003" });
  });
  it("reload after conflict explicitly discards local edits only when latest read succeeded", async () => {
    const f = fixture(); f.api.update.mockRejectedValue(new MobileApiError("Conflict", 409, "CASE_REVISION_CONFLICT")); f.edit.edit({ note: "Local" }); await f.edit.save();
    f.edit.reload(); expect(f.edit.snapshot().input.note).toBe("Local"); await f.edit.refresh(); f.edit.reload(); expect(f.edit.snapshot().input.note).toBe(source.editable.note);
  });
  it.each([new MobileApiError("Wrong environment", 409, "environment_mismatch"), new MobileApiError("Denied", 403), new MobileApiError("Identity reused", 422, "CASE_MUTATION_MISMATCH")])("never offers rebase on access/identity failure %j", async error => {
    const f = fixture(); f.api.update.mockRejectedValue(error); f.edit.edit({ note: "Keep" }); await f.edit.save();
    expect(f.edit.snapshot().status).toBe("blocked"); f.edit.rebase(); await f.edit.save(); expect(f.api.update).toHaveBeenCalledTimes(1); expect(f.edit.snapshot().input.note).toBe("Keep");
  });
  it.each(["rebase", "reload"] as const)("cannot %s during a second conflict read and lose unsaved data", async action => {
    const f = fixture(); f.api.update.mockRejectedValueOnce(new MobileApiError("Conflict", 409, "CASE_REVISION_CONFLICT"));
    f.edit.edit({ note: "Keep local" }); await f.edit.save(); await f.edit.refresh();
    let done!: (value: unknown) => void; f.api.detail.mockReturnValue(new Promise(resolve => { done = resolve; })); const read = f.edit.refresh();
    f.edit[action](); expect(f.edit.snapshot().status).toBe("conflict"); done({ ...scope, case: source }); await read;
    expect(f.edit.snapshot().input.note).toBe("Keep local"); expect(f.edit.snapshot().status).toBe("conflict"); expect(f.api.update).toHaveBeenCalledTimes(1);
  });
  it("never replaces confirmed edits with an older canonical revision, including within one millisecond", async () => {
    const f = fixture(); f.edit.edit({ note: "Confirmed" }); await f.edit.save();
    f.api.detail.mockResolvedValueOnce({ ...scope, case: { ...source, updatedAt: "2026-10-11T12:01:00.654320Z" } });
    await f.edit.refresh(); expect(f.edit.snapshot()).toMatchObject({ status: "committed", input: { note: "Confirmed" } }); expect(f.edit.snapshot().error).toContain("revíziu");
    await f.edit.save(); expect(f.api.update).toHaveBeenCalledTimes(1); await f.edit.refresh(); expect(f.edit.snapshot().status).toBe("saved");
  });
  it("confirmed receipt plus failed refresh permits GET-only retry", async () => {
    const f = fixture(); f.edit.edit({ note: "Saved" }); await f.edit.save(); f.api.detail.mockRejectedValueOnce(new MobileApiError("Refresh failed", 503));
    await f.edit.refresh(); expect(f.edit.snapshot()).toMatchObject({ status: "committed", receipt }); await f.edit.save(); await f.edit.refresh();
    expect(f.api.update).toHaveBeenCalledTimes(1); expect(f.api.detail).toHaveBeenCalledTimes(2); expect(f.edit.snapshot().status).toBe("saved");
  });
  it("ignores late save/refresh after account disposal and cancels hidden reads", async () => {
    const f = fixture(); let done!: (value: MobileCaseUpdated) => void; f.api.update.mockReturnValue(new Promise(resolve => { done = resolve; }));
    f.edit.edit({ note: "Local" }); const save = f.edit.save(); f.edit.dispose(); done(receipt); await save; expect(f.edit.snapshot().receipt).toBeNull();
    const g = fixture(); g.edit.edit({ note: "Local" }); await g.edit.save(); let resolveDetail!: (value: unknown) => void;
    g.api.detail.mockReturnValue(new Promise(resolve => { resolveDetail = resolve; })); const read = g.edit.refresh(); const signal = g.api.detail.mock.calls[0][1];
    g.edit.setActive(false); expect(signal.aborted).toBe(true); resolveDetail({ ...scope, case: source }); await read; expect(g.edit.snapshot().status).toBe("committed");
    await g.edit.refresh(); expect(g.api.detail).toHaveBeenCalledTimes(1);
  });
});

describe("selected location command boundaries", () => {
  const point = { label: "Vybrané", address: "Nová adresa", lat: 0, lng: 0, provider: "manual" as const };
  it("applies only a local selection, omits legacy manual field, freezes independent nested command", async () => {
    let finish!: (receipt: MobileCaseUpdated) => void;
    const update = vi.fn((_id: string, _input: unknown) => new Promise<MobileCaseUpdated>(resolve => { finish = resolve; }));
    const edit = new CaseEdit({ update, detail: vi.fn() }, source, () => mutationId), selection = { ...point };
    edit.selectPlace("pickup", selection); selection.lat = 50; expect(update).not.toHaveBeenCalled();
    const saving = edit.save(); expect(update).toHaveBeenCalledOnce();
    const sent = update.mock.calls[0][1] as { pickup: typeof point; manualPickupAddress?: string };
    expect(sent.pickup).toEqual(point); expect(sent).not.toHaveProperty("manualPickupAddress"); expect(Object.isFrozen(sent.pickup)).toBe(true);
    finish({ ok: true, apiVersion: 1, environment: "test", profileId: id, checkedAt: source.updatedAt, caseId: id, mutationId, committedRevision: "2026-10-11T13:00:00Z", warnings: [], refreshRequired: true }); await saving;
  });
  it("manual editing explicitly removes selected coordinates while a note does not", () => {
    const edit = new CaseEdit({ update: vi.fn(), detail: vi.fn() }, source, () => mutationId);
    edit.selectPlace("destination", point); edit.edit({ note: "Note" }); expect(edit.snapshot().input.destination).toEqual(point);
    edit.edit({ manualDestinationAddress: "Ručný opis" }); expect(edit.snapshot().input).not.toHaveProperty("destination");
  });
});
