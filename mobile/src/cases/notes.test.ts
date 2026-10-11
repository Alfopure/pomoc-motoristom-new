import { describe, expect, it, vi } from "vitest";
import { MobileApiError } from "../lib/api";
import { CaseNoteDraft } from "./notes";
import type { MobileCaseNoteAdded } from "../../../src/lib/mobile-api";
vi.mock("expo-crypto", () => ({ randomUUID: () => "71000000-0000-4000-8000-000000000001" }));
const id = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const receipt: MobileCaseNoteAdded = { ok: true, apiVersion: 1, environment: "test", profileId: id(2), checkedAt: "2026-10-11T20:00:00Z",
  caseId: id(3), mutationId: id(4), eventId: id(4), warnings: [], refreshRequired: true };
const setup = () => { const api = { addNote: vi.fn().mockResolvedValue(receipt) }; const uuid = vi.fn(() => id(4)); return { api, uuid, draft: new CaseNoteDraft(api, id(3), uuid) }; };
describe("retained case note operation", () => {
  it("blocks same-tick double submit and confirms only once", async () => {
    const { api, draft, uuid } = setup(); draft.edit("  Poznámka\nDruhý riadok  ");
    await Promise.all([draft.submit(), draft.submit()]); expect(api.addNote).toHaveBeenCalledTimes(1); expect(uuid).toHaveBeenCalledTimes(1);
    expect(api.addNote).toHaveBeenCalledWith(id(3), { mutationId: id(4), note: "Poznámka\nDruhý riadok" });
    expect(draft.snapshot()).toMatchObject({ status: "saved", receipt });
    await draft.submit(); await draft.reconcile(); expect(api.addNote).toHaveBeenCalledTimes(1);
  });
  it("retains exact UUID/body after uncertainty and rejects editing until receipt", async () => {
    const { api, draft, uuid } = setup(); api.addNote.mockRejectedValueOnce(new MobileApiError("Offline", 0)); draft.edit("Pôvodná poznámka");
    await draft.submit(); draft.edit("Nový text"); draft.newNote(); await draft.submit(); expect(api.addNote).toHaveBeenCalledTimes(1);
    expect(draft.snapshot()).toMatchObject({ status: "uncertain", note: "Pôvodná poznámka" });
    await draft.reconcile(); expect(api.addNote.mock.calls[1]).toEqual(api.addNote.mock.calls[0]); expect(uuid).toHaveBeenCalledTimes(1);
    expect(draft.snapshot().status).toBe("saved");
  });
  it.each([401, 403, 400, 409, 422, 503])("keeps the uncertain command when reconciliation fails with %s", async status => {
    const { api, draft, uuid } = setup(); api.addNote.mockRejectedValueOnce(new MobileApiError("Timeout", 0)).mockRejectedValueOnce(new MobileApiError("Overenie odmietnuté", status));
    draft.edit("Poznámka"); await draft.submit(); await draft.reconcile(); draft.edit("Iná"); await draft.submit();
    expect(draft.snapshot()).toMatchObject({ status: "uncertain", note: "Poznámka" }); expect(api.addNote).toHaveBeenCalledTimes(2); expect(uuid).toHaveBeenCalledTimes(1);
    expect(api.addNote.mock.calls[1]).toEqual(api.addNote.mock.calls[0]);
  });
  it("allows correction after a definitive rejection of the first attempt", async () => {
    const { api, draft, uuid } = setup(); api.addNote.mockRejectedValueOnce(new MobileApiError("Neplatná poznámka", 400));
    draft.edit("Poznámka"); await draft.submit(); expect(draft.snapshot().status).toBe("editing"); draft.edit("Opravená"); await draft.submit();
    expect(api.addNote).toHaveBeenCalledTimes(2); expect(uuid).toHaveBeenCalledTimes(2);
  });
  it("retains a confirmed receipt including warnings without another write", async () => {
    const { api, draft } = setup(); const warned = { ...receipt, warnings: [{ code: "case_note_audit_incomplete", field: "note", message: "Audit nie je potvrdený." }] };
    api.addNote.mockResolvedValue(warned); draft.edit("Poznámka"); expect(await draft.submit()).toEqual(warned);
    await draft.reconcile(); expect(api.addNote).toHaveBeenCalledTimes(1); expect(draft.snapshot().receipt).toEqual(warned);
    draft.newNote(); expect(draft.snapshot()).toMatchObject({ note: "", status: "editing", receipt: null });
  });
  it("ignores a late receipt after account disposal and cannot submit again", async () => {
    const { api, draft } = setup(); let resolve!: (value: MobileCaseNoteAdded) => void;
    api.addNote.mockReturnValue(new Promise(done => { resolve = done; })); draft.edit("Súkromná poznámka"); const pending = draft.submit(); draft.dispose(); resolve(receipt); await pending;
    expect(draft.snapshot().receipt).toBeNull(); await draft.submit(); await draft.reconcile(); expect(api.addNote).toHaveBeenCalledTimes(1);
  });
  it("repairs audit using the exact committed command without losing note success", async () => {
    const { api, draft, uuid } = setup();
    api.addNote.mockResolvedValueOnce({ ...receipt, warnings: [{ code: "case_note_audit_incomplete", field: "note", message: "Audit chýba." }] });
    draft.edit("Poznámka"); await draft.submit(); await draft.repairAudit();
    expect(api.addNote.mock.calls[1]).toEqual(api.addNote.mock.calls[0]); expect(uuid).toHaveBeenCalledTimes(1);
    expect(draft.snapshot()).toMatchObject({ status: "saved", receipt, repairing: false });
  });
  it("keeps committed identity and warning after audit repair fails", async () => {
    const { api, draft } = setup(); const warned = { ...receipt, warnings: [{ code: "case_note_audit_incomplete", field: "note", message: "Audit chýba." }] };
    api.addNote.mockResolvedValueOnce(warned).mockRejectedValueOnce(new MobileApiError("Prístup zamietnutý", 403));
    draft.edit("Poznámka"); await draft.submit(); await draft.repairAudit();
    expect(draft.snapshot()).toMatchObject({ status: "saved", receipt: warned, repairing: false });
    expect(draft.snapshot().error).toContain("uložená");
  });
  it("prevents another note or simultaneous audit retry while repairing", async () => {
    const { api, draft } = setup(); let resolve!: (value: MobileCaseNoteAdded) => void;
    api.addNote.mockResolvedValueOnce({ ...receipt, warnings: [{ code: "case_note_audit_incomplete", field: "note", message: "Audit chýba." }] });
    draft.edit("Poznámka"); await draft.submit(); api.addNote.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const pending = draft.repairAudit(); draft.newNote(); await draft.repairAudit(); await draft.submit();
    expect(draft.snapshot()).toMatchObject({ status: "saved", note: "Poznámka", repairing: true }); expect(api.addNote).toHaveBeenCalledTimes(2);
    resolve(receipt); await pending;
  });
});
