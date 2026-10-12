import { describe, expect, it, vi } from "vitest";
import { createSessionStorage, type StorageDriver } from "../lib/session-storage";
import { DraftNotSentError, draftDate } from "./port";
import { DraftVault, draftStorageKey, flushAccountDrafts, type DraftScope } from "./vault";

let identity = 1000;
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const resource = id(1);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const files = new Map<string, string>(); let generation = 100;
  const driver: StorageDriver = { getItem: vi.fn(async key => files.get(key) ?? null), setItem: vi.fn(async (key, value) => { files.set(key, value); }), removeItem: vi.fn(async key => { files.delete(key); }) };
  const scope: DraftScope = { environment: "test", projectUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", userId: id(identity++), profileId: id(2), organizationId: id(3) };
  const options = { durable: true, uuid: () => id(generation++), current: () => true, revalidate: vi.fn(async () => {}) };
  return { files, driver, scope, options, open: () => DraftVault.open(driver, scope, options) };
}

describe("account draft vault protocol", () => {
  it("awaits the storage acknowledgement and fresh authority before releasing a transport ticket", async () => {
    const f = fixture(), vault = await f.open(), port = vault.bind("case-note", resource), gate = deferred<void>();
    vi.mocked(f.driver.setItem).mockImplementationOnce(async (key, value) => { await gate.promise; f.files.set(key, value); });
    let released = false;
    const preparing = port.prepare({ status: "saving", commandId: id(9) }).then(write => { released = true; return write; });
    await vi.waitFor(() => expect(f.driver.setItem).toHaveBeenCalledOnce());
    expect(released).toBe(false); expect(f.options.revalidate).toHaveBeenCalledOnce();
    gate.resolve(); const write = await preparing;
    expect(JSON.parse(f.files.get(draftStorageKey(f.scope))!).records[0].payload.commandId).toBe(id(9));
    expect(await write.finish({ status: "saved", commandId: id(9) })).toBe(true); vault.close();
  });
  it("blocks transport after failed local write and keeps the previous durable envelope", async () => {
    const f = fixture(), vault = await f.open(), port = vault.bind("case-note", resource);
    port.changed({ text: "Pôvodné" }); await vault.flush(); const old = f.files.get(draftStorageKey(f.scope));
    vi.mocked(f.driver.setItem).mockRejectedValueOnce(new Error("disk full"));
    await expect(port.prepare({ status: "saving", commandId: id(9) })).rejects.toBeInstanceOf(DraftNotSentError);
    expect(f.files.get(draftStorageKey(f.scope))).toBe(old); expect(port.settled()).toBe(false);
    await vault.retry(); expect(port.settled()).toBe(true); vault.close();
  });
  it("preserves concurrent records through shared whole-envelope writes", async () => {
    const f = fixture(), a = await f.open(), b = await f.open();
    a.bind("case-note", resource).changed({ text: "A" }); b.bind("case-edit", id(4)).changed({ text: "B" });
    await Promise.all([a.flush(), b.flush()]);
    expect(JSON.parse(f.files.get(draftStorageKey(f.scope))!).records.map((r: { payload: unknown }) => r.payload)).toEqual([{ text: "A" }, { text: "B" }]);
    a.close(); b.close();
  });
  it("settles a captured receipt after close without losing the original command", async () => {
    const f = fixture(), vault = await f.open(), port = vault.bind("case-note", resource), write = await port.prepare({ commandId: id(9), status: "saving" });
    vault.close(); expect(port.current()).toBe(false);
    expect(await write.finish({ commandId: id(9), status: "saved" })).toBe(true);
    const restored = await f.open(); expect(restored.bind("case-note", resource).load()).toEqual({ commandId: id(9), status: "saved" }); restored.close();
  });
  it("a late receipt cannot overwrite a rebound or explicitly discarded record", async () => {
    const f = fixture(), vault = await f.open(), first = vault.bind("case-note", resource), write = await first.prepare({ commandId: id(9) });
    const second = vault.bind("case-note", resource); second.changed({ text: "New incarnation" }); await vault.flush();
    expect(await write.finish({ text: "Late receipt" })).toBe(false); expect(second.load()).toEqual({ text: "New incarnation" });
    const newer = await second.prepare({ text: "New saving" }); await vault.discardAll();
    expect(await newer.finish({ text: "Cannot resurrect" })).toBe(false); expect(vault.snapshot().records).toEqual([]); vault.close();
  });
  it("retains a reset barrier when the confirmed receipt exceeds the storage budget", async () => {
    const f = fixture(), vault = await f.open(), port = vault.bind("case-note", resource), write = await port.prepare({ status: "saving" });
    expect(await write.finish({ status: "saved", text: "x".repeat(64_001) })).toBe(false);
    expect(vault.snapshot().error).toContain("Výsledok"); expect(port.settled()).toBe(false);
    await vault.retry(); expect(port.settled()).toBe(false); vault.close();
  });
  it("failed receipt persistence remains unsettled until the actual outcome is acknowledged", async () => {
    const f = fixture(), vault = await f.open(), port = vault.bind("case-note", resource), write = await port.prepare({ status: "saving" });
    vi.mocked(f.driver.setItem).mockRejectedValueOnce(new Error("locked"));
    expect(await write.finish({ status: "saved" })).toBe(false); expect(port.settled()).toBe(false);
    await vault.retry(); expect(port.settled()).toBe(true);
    const restored = vault.bind("case-note", resource); expect(restored.load()).toEqual({ status: "saved" }); expect(restored.settled()).toBe(true);
    vault.close();
  });
  it("corrupt or foreign envelopes fail closed and cannot be overwritten by bind", async () => {
    for (const value of ["{broken", JSON.stringify({ v: 2, records: [] }), JSON.stringify({ v: 1, scope: { wrong: true }, records: [] })]) {
      const f = fixture(); f.files.set(draftStorageKey(f.scope), value); const vault = await f.open();
      expect(vault.snapshot().ready).toBe(false); expect(() => vault.bind("case-note", resource)).toThrow(); expect(f.driver.setItem).not.toHaveBeenCalled();
      await vault.discardAll(); expect(vault.snapshot().ready).toBe(true); expect(f.files.size).toBe(0); vault.close();
    }
  });
  it("an old retry read cannot resurrect drafts after discardAll", async () => {
    const f = fixture(), vault = await f.open(); vault.bind("case-note", resource).changed({ text: "private" }); await vault.flush();
    const envelope = f.files.get(draftStorageKey(f.scope))!; vault.close(); await Promise.resolve();
    const changedScope = { ...f.scope, userId: id(identity++) }, key = draftStorageKey(changedScope);
    const value = JSON.parse(envelope); value.scope = changedScope;
    const read = deferred<string | null>(); let fail = true;
    const storage = { ...f.driver, getItem: async () => { if (fail) { fail = false; throw new Error("locked"); } return read.promise; } };
    const reopened = await DraftVault.open(storage, changedScope, f.options), retry = reopened.retry();
    await Promise.resolve(); await reopened.discardAll(); read.resolve(JSON.stringify(value)); await retry;
    expect(reopened.snapshot()).toMatchObject({ ready: true, records: [], error: null }); expect(f.files.has(key)).toBe(false); reopened.close();
  });
  it("scope revalidation and session changes prevent transport, while receipt completion stays bound", async () => {
    const f = fixture(); let current = true; const vault = await DraftVault.open(f.driver, f.scope, { ...f.options, current: () => current });
    const port = vault.bind("case-note", resource); f.options.revalidate.mockImplementationOnce(async () => { current = false; });
    await expect(port.prepare({ commandId: id(9) })).rejects.toBeInstanceOf(DraftNotSentError); expect(f.driver.setItem).not.toHaveBeenCalled(); vault.close();
  });
  it("does not persist tokens, URLs, media bytes, caches or oversized text", async () => {
    const f = fixture(), vault = await f.open(), port = vault.bind("case-note", resource);
    for (const payload of [{ url: "https://signed" }, { nested: { access_token: "secret" } }, { bytes: [1] }, { context: {} }, { text: "x".repeat(64_001) }]) {
      await expect(port.prepare(payload)).rejects.toBeInstanceOf(DraftNotSentError);
    }
    expect(f.driver.setItem).not.toHaveBeenCalled(); expect(vault.snapshot().records).toEqual([]); vault.close();
  });
  it("isolates users, organizations, projects and environments in the authority key", () => {
    const f = fixture(), keys = [f.scope, { ...f.scope, userId: id(8) }, { ...f.scope, organizationId: id(8) }, { ...f.scope, profileId: id(8) }, { ...f.scope, environment: "production" as const, projectUrl: "https://ifpaeegaesdmljfkdvcn.supabase.co" }].map(draftStorageKey);
    expect(new Set(keys).size).toBe(keys.length); expect(() => draftStorageKey({ ...f.scope, projectUrl: "http://invalid" })).toThrow();
  });
  it("logout waits for older organization ledgers and rejects unsaved record-level projections", async () => {
    const f = fixture(), vault = await f.open(), port = vault.bind("case-note", resource), oldScope = { ...f.scope, organizationId: id(20) };
    const previous = await DraftVault.open(f.driver, oldScope, f.options); previous.bind("case-note", resource).changed({ text: "Older organization" });
    port.changed({ text: "Previous" }); await vault.flush(); port.changed({ text: "x".repeat(64_001) });
    await expect(flushAccountDrafts(f.scope)).rejects.toBeInstanceOf(DraftNotSentError);
    expect(JSON.parse(f.files.get(draftStorageKey(oldScope))!).records[0].payload.text).toBe("Older organization");
    await vault.discard("case-note." + resource); await expect(flushAccountDrafts(f.scope)).resolves.toBeUndefined(); previous.close(); vault.close();
  });
  it("discard-one cannot lose another record's rejected newer projection or race an active preparation", async () => {
    const f = fixture(), vault = await f.open(), a = vault.bind("case-note", resource), b = vault.bind("case-edit", id(4));
    a.changed({ text: "A" }); b.changed({ text: "Previous B" }); await vault.flush(); b.changed({ text: "x".repeat(64_001) });
    await expect(vault.discard("case-note." + resource)).rejects.toThrow("Iný formulár"); expect(vault.snapshot().records).toHaveLength(2); expect(b.current()).toBe(true);
    b.changed({ text: "Corrected B" }); await vault.flush(); const gate = deferred<void>(); f.options.revalidate.mockImplementationOnce(() => gate.promise);
    const preparing = b.prepare({ text: "Saving B" }); expect(vault.snapshot().busy).toBe(true);
    await expect(vault.discard("case-note." + resource)).rejects.toThrow("prebiehajúcej"); gate.resolve(); const write = await preparing;
    await expect(vault.discard("case-note." + resource)).rejects.toThrow("prebiehajúcej"); await write.finish({ text: "Saved B" });
    expect(await vault.discard("case-note." + resource)).toEqual({ resetSafe: true }); expect(vault.snapshot().records[0].payload).toEqual({ text: "Saved B" }); vault.close();
  });
  it("deferred deletion reports success without allowing a remount over a newly rejected sibling projection", async () => {
    const f = fixture(), vault = await f.open(), a = vault.bind("case-note", resource), b = vault.bind("case-edit", id(4)); a.changed({ text: "A" }); b.changed({ text: "B" }); await vault.flush();
    const gate = deferred<void>(); vi.mocked(f.driver.setItem).mockImplementationOnce(async (key, value) => { await gate.promise; f.files.set(key, value); });
    const deleting = vault.discard("case-note." + resource); await vi.waitFor(() => expect(vault.snapshot().saving).toBe(true)); b.changed({ text: "x".repeat(64_001) }); gate.resolve();
    expect(await deleting).toEqual({ resetSafe: false }); expect(vault.snapshot().records.map(record => record.key)).toEqual(["case-edit." + id(4)]); expect(b.current()).toBe(true); expect(vault.snapshot().error).toBeTruthy();
    b.changed({ text: "Repaired B" }); await vault.flush(); expect(vault.snapshot()).toMatchObject({ error: null, busy: false, saving: false });
    expect(vault.bind("case-note", resource).load()).toBeNull(); expect(vault.bind("case-edit", id(4)).load()).toEqual({ text: "Repaired B" }); vault.close();
  });
  it("chunk failure keeps the previous authority and all previous text recoverable", async () => {
    const f = fixture(), storage = createSessionStorage(f.driver, f.options.uuid), vault = await DraftVault.open(storage, f.scope, f.options), port = vault.bind("case-note", resource);
    port.changed({ text: "Pôvodný koncept" }); await vault.flush(); const manifest = f.files.get(draftStorageKey(f.scope));
    const normal = f.driver.setItem; let writes = 0;
    f.driver.setItem = async (key, value) => { if (++writes === 2) throw new Error("chunk full"); await normal(key, value); };
    await expect(port.prepare({ text: "x".repeat(2000), status: "saving" })).rejects.toBeInstanceOf(DraftNotSentError);
    expect(f.files.get(draftStorageKey(f.scope))).toBe(manifest);
    expect(JSON.parse((await storage.getItem(draftStorageKey(f.scope)))!).records[0].payload).toEqual({ text: "Pôvodný koncept" });
    f.driver.setItem = normal; await vault.retry(); vault.close();
  });
  it("a manifest write that becomes visible then rejects blocks transport and fails closed on read", async () => {
    const f = fixture(), storage = createSessionStorage(f.driver, f.options.uuid), vault = await DraftVault.open(storage, f.scope, f.options), port = vault.bind("case-note", resource);
    port.changed({ text: "Previous" }); await vault.flush(); const normal = f.driver.setItem, key = draftStorageKey(f.scope);
    f.driver.setItem = async (name, value) => { await normal(name, value); if (name === key) throw new Error("manifest visible but commit not acknowledged"); };
    await expect(port.prepare({ status: "saving", commandId: id(9) })).rejects.toBeInstanceOf(DraftNotSentError);
    await expect(storage.getItem(key)).rejects.toThrow("Incomplete"); expect(vault.snapshot().error).toBeTruthy();
    f.driver.setItem = normal; await vault.retry(); expect(JSON.parse((await storage.getItem(key))!).records[0].payload.status).toBe("saving"); vault.close();
  });
});

describe("draft timestamp boundary", () => {
  it("preserves database microseconds and explicit offsets while rejecting calendar rollover", () => {
    for (const date of ["2026-10-12T15:00:00Z", "2026-10-12 15:00:00.123456+00:00", "2024-02-29T12:00:00+02:00"]) expect(draftDate(date)).toBe(true);
    for (const date of ["1", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-12T24:00:00Z", "2026-10-12", "2026-10-12T00:00:00+24:00"]) expect(draftDate(date)).toBe(false);
  });
});
