import { describe, expect, it, vi } from "vitest";
import { NotebookStore } from "./notebook-store";
import type { PersonalNote } from "@/domain/notes";
const note: PersonalNote = { id: "note-a", ownerProfileId: "a", title: "Private", body: "Secret", revision: 1, updatedAt: "2026-09-10", recipientProfileIds: [], canEdit: true };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("notebook in-memory access lifecycle", () => {
  it("clears revoked content and rejects an older delayed read", async () => {
    const old = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(response({ notes: [note] })).mockReturnValueOnce(old.promise).mockResolvedValueOnce(response({ notes: [] }));
    const store = new NotebookStore(fetcher); await store.refresh(); store.select(note.id); store.edit(note.id, { body: "Draft" });
    const delayed = store.refresh(); await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ notes: [], drafts: {}, selectedId: null });
    old.resolve(response({ notes: [note] })); await delayed;
    expect(store.getSnapshot().notes).toEqual([]);
  });
  it("identity invalidation discards all state and late results cannot repopulate it", async () => {
    const old = deferred<Response>();
    const store = new NotebookStore(vi.fn().mockResolvedValueOnce(response({ notes: [note] })).mockReturnValueOnce(old.promise));
    await store.refresh(); store.edit(note.id, { title: "Draft" }); const pending = store.refresh(); store.dispose();
    old.resolve(response({ notes: [note] })); await pending; await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ notes: [], drafts: {}, colleagues: [], selectedId: null });
  });
  it("hides previously displayed content before reconnect verification and stays hidden on network failure", async () => {
    const store = new NotebookStore(vi.fn().mockResolvedValueOnce(response({ notes: [note] })).mockRejectedValueOnce(new Error("offline")));
    await store.refresh(); const pending = store.reauthorize(); expect(store.getSnapshot().hidden).toBe(true); await pending;
    expect(store.getSnapshot().hidden).toBe(true);
  });
  it("preserves newer typing while a save commits an older draft and serializes own saves", async () => {
    const saved = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(response({ notes: [note] })).mockReturnValueOnce(saved.promise);
    const store = new NotebookStore(fetcher); await store.refresh(); store.edit(note.id, { body: "first" });
    const pending = store.save(); expect(store.save()).toBe(pending); store.edit(note.id, { body: "second" });
    saved.resolve(response({ note: { ...note, body: "first", revision: 2 } })); expect(await pending).toBe(false);
    expect(store.getSnapshot().drafts[note.id].body).toBe("second"); expect(store.getSnapshot().notes[0].revision).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps conflict text and never retries against a newer revision without explicit reload", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ notes: [note] })).mockResolvedValueOnce(response({}, 409));
    const store = new NotebookStore(fetcher); await store.refresh(); store.edit(note.id, { body: "keep" });
    expect(await store.save()).toBe(false); expect(await store.save()).toBe(false);
    expect(store.getSnapshot().drafts[note.id].body).toBe("keep"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("read-only recipients cannot create an editable draft", async () => {
    const store = new NotebookStore(vi.fn().mockResolvedValueOnce(response({ notes: [{ ...note, canEdit: false }] })));
    await store.refresh(); store.edit(note.id, { body: "no" }); expect(store.getSnapshot().drafts).toEqual({});
  });
  it("removes content when a save discovers revoked access", async () => {
    const store = new NotebookStore(vi.fn().mockResolvedValueOnce(response({ notes: [note] })).mockResolvedValueOnce(response({}, 403)));
    await store.refresh(); store.edit(note.id, { body: "edit" }); await store.save(); expect(store.getSnapshot().notes).toEqual([]); expect(store.getSnapshot().drafts).toEqual({});
  });
});

it("changes capability on the same store, purges private drafts and rejects old responses after re-enable", async () => {
  const pending = deferred<Response>(); let count = 0;
  const store = new NotebookStore(async () => ++count === 1 ? response({ notes: [note] }) : count === 2 ? pending.promise : response({ notes: [{ ...note, id: "new-note" }] }));
  await store.refresh(); store.edit(note.id, { body: "Private draft" }); const reading = store.refresh();
  store.setEnabled(false); expect(store.enabled).toBe(false); expect(store.getSnapshot()).toMatchObject({ notes: [], drafts: {}, hidden: true });
  store.setEnabled(true); await store.refresh();
  pending.resolve(response({ notes: [note] })); await reading;
  expect(store.getSnapshot().notes.map(note => note.id)).toEqual(["new-note"]); expect(store.getSnapshot().drafts).toEqual({});
});

const mutationCases = (["create", "save", "delete"] as const).flatMap(action => [401, 403].map(status => ({ action, status })));
describe("notebook mutation authorization generations", () => {
  it.each(mutationCases)("ignores late $action HTTP$status while a newly authorized draft is saving", async ({ action, status }) => {
    const staleMutation = deferred<Response>(), freshMutation = deferred<Response>();
    const freshNote = { ...note, id: "fresh-note", title: "Newly authorized note" };
    let reenabled = false;
    const store = new NotebookStore(async (_url, init) => {
      if (!init?.method) return response({ notes: [reenabled ? freshNote : note] });
      return reenabled ? freshMutation.promise : staleMutation.promise;
    });
    await store.refresh(); store.select(note.id);
    if (action === "save") store.edit(note.id, { body: "Old private draft" });
    const pending = action === "create" ? store.create() : action === "save" ? store.save() : store.deleteSelected();
    store.setEnabled(false); store.setEnabled(true); reenabled = true;
    await store.refresh(); store.select(freshNote.id); store.edit(freshNote.id, { body: "Keep this newer draft" });
    const freshSave = store.save(), before = store.getSnapshot();
    expect(before.saving).toBe(true);
    staleMutation.resolve(response({}, status)); await pending;
    expect(store.getSnapshot()).toBe(before);
    expect(store.save()).toBe(freshSave);
    freshMutation.resolve(response({ note: { ...freshNote, revision: 2, body: "Keep this newer draft" } }));
    expect(await freshSave).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ saving: false, drafts: {}, notes: [{ id: freshNote.id, revision: 2, body: "Keep this newer draft" }] });
  });
  it.each(mutationCases)("still clears private content for current $action HTTP$status", async ({ action, status }) => {
    const store = new NotebookStore(async (_url, init) => init?.method ? response({}, status) : response({ notes: [note] }));
    await store.refresh(); store.select(note.id); store.edit(note.id, { body: "Private current draft" });
    if (action === "create") await store.create();
    else if (action === "save") await store.save();
    else await store.deleteSelected();
    expect(store.getSnapshot()).toMatchObject({ notes: [], drafts: {}, selectedId: null, saving: false });
  });
});
