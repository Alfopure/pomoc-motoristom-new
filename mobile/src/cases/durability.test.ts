import { describe, expect, it, vi } from "vitest";
import type { MobileCaseDetailData, MobileCaseNoteAdded, MobileCaseUpdated } from "../../../src/lib/mobile-api";
import { DraftVault, type DraftScope } from "../drafts/vault";
import { MobileApiError } from "../lib/api";
import { CaseDraft } from "./draft";
import { CaseEdit } from "./edit";
import { CaseNoteDraft } from "./notes";
import { CaseOwnerDraft } from "./owner";
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000009" }));
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const caseId = id(1), profileId = id(2), command = id(9), date = "2026-10-12T14:00:00.123456Z";
const reply = { ok: true as const, apiVersion: 1 as const, environment: "test" as const, profileId, checkedAt: "2026-10-12T14:02:00Z" };
const source: MobileCaseDetailData = { id: caseId, caseNumber: "PM-MOCK", status: "open", statusLabel: "Otvorený", priority: "normal", priorityLabel: "Bežná",
  owner: { id: profileId, name: "MOCK", mine: true }, contact: { name: "Meno", phone: "+421900000000" }, vehicle: { licensePlate: "BA123AA", description: null },
  pickupAddress: "Adresa", destinationAddress: null, summary: "Porucha", createdAt: date, updatedAt: date, mainNote: "", incidentDescription: "Porucha", jobTypeLabels: [], timeline: [], statusOptions: [{ value: "open", label: "Otvorený" }],
  editable: { contactName: "Meno", contactPhone: "+421900000000", licensePlate: "BA123AA", vehicleMake: "", vehicleModel: "", manualPickupAddress: "Adresa", manualDestinationAddress: "", incidentDescription: "Porucha", note: "", priority: "normal", jobTypes: [], status: "open" } };
const noteReceipt: MobileCaseNoteAdded = { ...reply, caseId, mutationId: command, eventId: command, warnings: [], refreshRequired: true };
const editReceipt: MobileCaseUpdated = { ...reply, caseId, mutationId: command, committedRevision: "2026-10-12T14:01:00.654321Z", warnings: [], refreshRequired: true };
let user = 2000;
async function fixture() {
  const files = new Map<string, string>(); let gen = 100;
  const driver = { getItem: async (key: string) => files.get(key) ?? null, setItem: vi.fn(async (key: string, value: string) => { files.set(key, value); }), removeItem: async (key: string) => { files.delete(key); } };
  const scope: DraftScope = { environment: "test", projectUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", userId: id(user++), profileId, organizationId: id(3) };
  const options = { durable: true, uuid: () => id(gen++), current: () => true, revalidate: vi.fn(async () => {}) };
  const vault = await DraftVault.open(driver, scope, options);
  return { files, driver, scope, options, vault };
}
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe("case controllers using actual account vault", () => {
  it("restores the saved case and handoff continuation after a late receipt without creating again", async () => {
    const f = await fixture(), late = deferred<import("../../../src/lib/mobile-api").MobileCaseCreated>();
    const created = { ...reply, caseId, caseNumber: "PM-SAVED", warnings: [] };
    const api = { create: vi.fn(() => late.promise) };
    const draft = new CaseDraft(api, f.vault.bind("case-create"));
    draft.edit({ contactName: "Pristavenie" }); const save = draft.submit("handoff");
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());
    draft.dispose(); f.vault.close(); late.resolve(created); await save;
    const vault = await DraftVault.open(f.driver, f.scope, f.options);
    const restored = new CaseDraft(api, vault.bind("case-create"));
    expect(restored.snapshot()).toMatchObject({ status: "saved", afterSave: "handoff", created });
    await restored.submit("handoff"); expect(api.create).toHaveBeenCalledOnce();
    restored.dispose(); vault.close();
  });
  it("retains save-and-handoff intent across an uncertain create restart without automatic retry", async () => {
    const f = await fixture(), api = { create: vi.fn().mockRejectedValue(new MobileApiError("Unknown", 0)) };
    const draft = new CaseDraft(api, f.vault.bind("case-create"));
    await draft.submit("handoff"); draft.dispose(); f.vault.close();
    const vault = await DraftVault.open(f.driver, f.scope, f.options), restored = new CaseDraft(api, vault.bind("case-create"));
    expect(restored.snapshot()).toMatchObject({ status: "uncertain", afterSave: "handoff", created: null, reviewedList: false });
    await restored.submit(); restored.allowRetry(); expect(api.create).toHaveBeenCalledOnce();
    expect(restored.snapshot().status).toBe("uncertain"); restored.dispose(); vault.close();
  });
  it.each([1, 2])("restores existing version %i create drafts with ordinary save destination", async version => {
    const f = await fixture(), api = { create: vi.fn() }, port = f.vault.bind("case-create");
    const input = { contactName: "Pôvodný koncept", ...(version === 2 ? { pickup: { label: "Miesto", address: "Adresa", lat: 48, lng: 17, provider: "manual" as const } } : {}) };
    port.changed({ version, input, status: "editing", submitted: null, created: null }); await f.vault.flush();
    const restored = new CaseDraft(api, f.vault.bind("case-create"));
    expect(restored.snapshot()).toMatchObject({ status: "editing", afterSave: "detail", input });
    expect(api.create).not.toHaveBeenCalled(); restored.dispose(); f.vault.close();
  });
  it.each([undefined, "send", { caseId }])("rejects an invalid persisted create continuation (%j)", async afterSave => {
    const f = await fixture(), api = { create: vi.fn() }, port = f.vault.bind("case-create");
    port.changed({ version: 3, input: {}, status: "editing", submitted: null, created: null, ...(afterSave === undefined ? {} : { afterSave }) }); await f.vault.flush();
    const restored = new CaseDraft(api, f.vault.bind("case-create"));
    expect(restored.snapshot().error).toBeTruthy(); await restored.submit("handoff");
    expect(api.create).not.toHaveBeenCalled(); restored.dispose(); f.vault.close();
  });
  it("restarts unknown owner assignment from actual WAL and records its exact late receipt after disposal", async () => {
    const f = await fixture(), late = deferred<import("../../../src/lib/mobile-api").MobileCaseOwnerAssigned>();
    const context = { ...reply, caseId, caseRevision: date, owner: { id: null, name: null, mine: false }, available: true, capabilities: { take: true, assign: true }, targets: [{ id: profileId, name: "Ja" }] };
    const receipt = { ...reply, caseId, mutationId: command, ownerId: profileId, committedRevision: date, refreshRequired: true as const };
    const api = { ownerContext: vi.fn(async () => context), assignOwner: vi.fn().mockRejectedValueOnce(new MobileApiError("Unknown", 503)).mockImplementationOnce(() => late.promise) };
    const first = new CaseOwnerDraft(api, caseId, () => command, f.vault.bind("case.owner", caseId));
    await first.refresh(); first.select(profileId); await first.submit(); const sent = api.assignOwner.mock.calls[0][1]; first.dispose(); f.vault.close();
    const reopened = await DraftVault.open(f.driver, f.scope, f.options), uuid = vi.fn(() => id(10));
    const restored = new CaseOwnerDraft(api, caseId, uuid, reopened.bind("case.owner", caseId));
    expect(restored.snapshot().status).toBe("uncertain"); expect(api.assignOwner).toHaveBeenCalledOnce();
    const checking = restored.reconcile(); await vi.waitFor(() => expect(api.assignOwner).toHaveBeenCalledTimes(2));
    expect(api.assignOwner.mock.calls[1][1]).toEqual(sent); expect(uuid).not.toHaveBeenCalled();
    restored.dispose(); reopened.close(); late.resolve(receipt); await checking;
    const lastVault = await DraftVault.open(f.driver, f.scope, f.options), saved = new CaseOwnerDraft(api, caseId, uuid, lastVault.bind("case.owner", caseId));
    expect(saved.snapshot()).toMatchObject({ status: "saved", receipt }); saved.dispose(); lastVault.close();
  });

  it("restores unsent case and note text without any server mutation", async () => {
    const f = await fixture(), create = vi.fn(), api = { addNote: vi.fn() };
    const draft = new CaseDraft({ create }, f.vault.bind("case-create")), note = new CaseNoteDraft(api, caseId, () => command, f.vault.bind("case-note", caseId));
    draft.edit({ contactName: "Rozpísané", note: "Dlhý text", jobTypes: ["tow"] }); note.edit("Rozpísaná poznámka"); await f.vault.flush(); draft.dispose(); note.dispose();
    const restored = new CaseDraft({ create }, f.vault.bind("case-create")), restoredNote = new CaseNoteDraft(api, caseId, () => command, f.vault.bind("case-note", caseId));
    expect(restored.snapshot().input).toMatchObject({ contactName: "Rozpísané", note: "Dlhý text" }); expect(restoredNote.snapshot().note).toBe("Rozpísaná poznámka"); expect(create).not.toHaveBeenCalled(); expect(api.addNote).not.toHaveBeenCalled(); restored.dispose(); restoredNote.dispose(); f.vault.close();
  });
  it("restores an unsent edit against its original microsecond baseline and requires explicit rebase", async () => {
    const f = await fixture(), api = { update: vi.fn(async () => ({ ...editReceipt, mutationId: id(10) })), detail: vi.fn() };
    const edit = new CaseEdit(api, source, () => command, f.vault.bind("case-edit", caseId)); edit.edit({ note: "Moja zmena" }); await f.vault.flush(); edit.dispose();
    const fresh = { ...source, updatedAt: "2026-10-12T14:00:00.123457Z", editable: { ...source.editable, contactName: "Kolega" } };
    const restored = new CaseEdit(api, fresh, () => id(10), f.vault.bind("case-edit", caseId));
    expect(restored.snapshot()).toMatchObject({ status: "conflict", base: { updatedAt: date }, input: { note: "Moja zmena" }, latest: { editable: { contactName: "Kolega" } } });
    await restored.save(); expect(api.update).not.toHaveBeenCalled(); restored.rebase(); await restored.save();
    expect(api.update).toHaveBeenCalledExactlyOnceWith(caseId, { note: "Moja zmena", expectedUpdatedAt: fresh.updatedAt, mutationId: id(10) }); restored.dispose(); f.vault.close();
  });
  it("an unknown edit survives restart and later auth rejection with the same command and revision", async () => {
    const f = await fixture(), api = { update: vi.fn().mockRejectedValueOnce(new MobileApiError("network", 0)).mockRejectedValueOnce(new MobileApiError("auth", 403)).mockResolvedValue(editReceipt), detail: vi.fn() };
    const first = new CaseEdit(api, source, () => command, f.vault.bind("case-edit", caseId)); first.edit({ note: "Presné telo" }); await first.save(); const sent = api.update.mock.calls[0][1]; first.dispose();
    const uuid = vi.fn(() => id(10)), restored = new CaseEdit(api, { ...source, updatedAt: editReceipt.committedRevision }, uuid, f.vault.bind("case-edit", caseId));
    expect(restored.snapshot().status).toBe("uncertain"); restored.edit({ note: "Nesmie nahradiť" }); await restored.refresh(); await restored.save(); expect(restored.snapshot().status).toBe("uncertain"); await restored.save();
    expect(api.update.mock.calls.map(call => call[1])).toEqual([sent, sent, sent]); expect(uuid).not.toHaveBeenCalled(); expect(api.detail).not.toHaveBeenCalled(); expect(restored.snapshot().status).toBe("committed"); restored.dispose(); f.vault.close();
  });
  it("fresh resume detail updates a retained unsent editor without replacing its changes", async () => {
    const f = await fixture(), api = { update: vi.fn(), detail: vi.fn() }, edit = new CaseEdit(api, source, () => command, f.vault.bind("case-edit", caseId));
    edit.edit({ note: "Keep retained" }); edit.observeFreshSource({ ...source, updatedAt: "2026-10-12T14:00:00.123457Z", editable: { ...source.editable, contactName: "Changed colleague" } });
    expect(edit.snapshot()).toMatchObject({ status: "conflict", input: { note: "Keep retained" }, latest: { editable: { contactName: "Changed colleague" } } });
    await edit.save(); expect(api.update).not.toHaveBeenCalled(); edit.dispose(); f.vault.close();
  });
  it.each([0, 408, 429, 503])("unknown note %i restores exact UUID/text and never retries automatically", async status => {
    const f = await fixture(), api = { addNote: vi.fn().mockRejectedValueOnce(new MobileApiError("unknown", status)).mockResolvedValue(noteReceipt) };
    const first = new CaseNoteDraft(api, caseId, () => command, f.vault.bind("case-note", caseId)); first.edit(" Presný text "); await first.submit(); first.dispose();
    const uuid = vi.fn(() => id(10)), restored = new CaseNoteDraft(api, caseId, uuid, f.vault.bind("case-note", caseId)); expect(restored.snapshot().status).toBe("uncertain"); expect(api.addNote).toHaveBeenCalledOnce();
    restored.edit("Iný text"); await restored.submit(); expect(api.addNote).toHaveBeenCalledOnce(); await restored.reconcile();
    expect(api.addNote).toHaveBeenLastCalledWith(caseId, { mutationId: command, note: "Presný text" }); expect(uuid).not.toHaveBeenCalled(); expect(restored.snapshot().status).toBe("saved"); restored.dispose(); f.vault.close();
  });
  it("captures a late edit receipt after both controller and account close", async () => {
    const f = await fixture(), network = deferred<MobileCaseUpdated>(), api = { update: vi.fn(() => network.promise), detail: vi.fn() };
    const edit = new CaseEdit(api, source, () => command, f.vault.bind("case-edit", caseId)); edit.edit({ note: "Late" }); const saving = edit.save(); await vi.waitFor(() => expect(api.update).toHaveBeenCalledOnce());
    edit.dispose(); f.vault.close(); network.resolve(editReceipt); await saving;
    const reopened = await DraftVault.open(f.driver, f.scope, f.options), restored = new CaseEdit(api, source, () => id(10), reopened.bind("case-edit", caseId));
    expect(restored.snapshot()).toMatchObject({ status: "committed", receipt: { mutationId: command } }); expect(api.update).toHaveBeenCalledOnce(); restored.dispose(); reopened.close();
  });
  it("known note success stays saved after local receipt failure and reset waits for actual retry acknowledgement", async () => {
    const f = await fixture(), api = { addNote: vi.fn(async () => { f.driver.setItem.mockRejectedValueOnce(new Error("disk")); return noteReceipt; }) };
    const note = new CaseNoteDraft(api, caseId, () => command, f.vault.bind("case-note", caseId)); note.edit("Uložené"); await note.submit(); expect(note.snapshot().status).toBe("saved"); note.newNote(); expect(note.snapshot().note).toBe("Uložené");
    await f.vault.retry(); note.newNote(); expect(note.snapshot()).toMatchObject({ status: "editing", note: "", receipt: null }); expect(api.addNote).toHaveBeenCalledOnce(); note.dispose(); f.vault.close();
  });
  it("local authority failure publishes an unsent editing projection rather than an unknown write", async () => {
    const f = await fixture(), api = { addNote: vi.fn() }; f.options.revalidate.mockRejectedValueOnce(new Error("offline"));
    const note = new CaseNoteDraft(api, caseId, () => command, f.vault.bind("case-note", caseId)); note.edit("Neodoslané"); await note.submit(); await f.vault.flush(); note.dispose();
    const restored = new CaseNoteDraft(api, caseId, () => id(10), f.vault.bind("case-note", caseId)); expect(restored.snapshot()).toMatchObject({ status: "editing", note: "Neodoslané" }); expect(api.addNote).not.toHaveBeenCalled(); restored.dispose(); f.vault.close();
  });
  it("non-idempotent unknown new case requires a new post-restore list review and explicit acknowledgement", async () => {
    const f = await fixture(), create = vi.fn().mockRejectedValue(new MobileApiError("network", 0));
    const draft = new CaseDraft({ create }, f.vault.bind("case-create")); draft.edit({ contactName: "Exact" }); await draft.submit(); draft.dispose();
    const restored = new CaseDraft({ create }, f.vault.bind("case-create")); restored.allowRetry(); expect(restored.snapshot().status).toBe("uncertain"); await restored.submit(); expect(create).toHaveBeenCalledOnce();
    restored.reviewList(restored.snapshot().reviewAfter - 1); restored.allowRetry(); expect(restored.snapshot().status).toBe("uncertain");
    restored.reviewList(restored.snapshot().reviewAfter + 1); restored.allowRetry(); expect(restored.snapshot().status).toBe("editing"); expect(create).toHaveBeenCalledOnce(); restored.dispose(); f.vault.close();
  });
  it("rejects a malformed or foreign note receipt without exposing its saved private text", async () => {
    const f = await fixture(), api = { addNote: vi.fn() }, port = f.vault.bind("case-note", caseId);
    port.changed({ version: 1, caseId, note: "Must not expose", status: "saved", pending: { mutationId: command, note: "Must not expose" }, receipt: { ...noteReceipt, profileId: id(99) } }); await f.vault.flush();
    const restored = new CaseNoteDraft(api, caseId, () => command, f.vault.bind("case-note", caseId)); expect(restored.snapshot().note).toBe(""); expect(f.vault.snapshot().error).toBeTruthy(); await restored.submit(); expect(api.addNote).not.toHaveBeenCalled(); restored.dispose(); f.vault.close();
  });
});

describe("phase8 selected-point WAL", () => {
  it("restores nested selected point command without inferred manual address after actual vault reopen", async () => {
    const f = await fixture(), point = { label: "Miesto", address: "Nová adresa", lat: 0, lng: 0, provider: "manual" as const };
    const api = { update: vi.fn().mockRejectedValueOnce(new MobileApiError("unknown", 0)).mockResolvedValue(editReceipt), detail: vi.fn() };
    const edit = new CaseEdit(api, source, () => command, f.vault.bind("case-edit", caseId)); edit.selectPlace("pickup", point); await edit.save(); edit.dispose(); f.vault.close();
    const vault = await DraftVault.open(f.driver, f.scope, f.options), restored = new CaseEdit(api, source, () => id(10), vault.bind("case-edit", caseId));
    expect(restored.snapshot().status).toBe("uncertain"); expect(api.update).toHaveBeenCalledOnce(); await restored.save();
    expect(api.update.mock.calls[1][1]).toEqual(api.update.mock.calls[0][1]); expect(api.update.mock.calls[1][1]).not.toHaveProperty("manualPickupAddress"); expect(api.update.mock.calls[1][1].pickup).toEqual(point);
    restored.dispose(); vault.close();
  });
});
