import { describe, expect, it, vi } from "vitest";
import type { MobileCallbackRequest, MobileCallbacks } from "../../../src/lib/mobile-callbacks";
import { MobileApiError } from "../lib/api";
import type { CallbacksApi } from "./api";
import { CallbackQueueStore } from "./store";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function request(id: string, change: Partial<MobileCallbackRequest> = {}): MobileCallbackRequest {
  return { id, number: "+421905111222", name: null, status: "open", origin: "missed", originDetail: null, sourceLabel: "Zmeškaný hovor", lineLabel: null, partnerName: null,
    caseId: null, claimant: null, claimedAt: null, deadlineAt: "2026-10-18T09:30:00Z", createdAt: "2026-10-18T09:00:00Z", resolvedAt: null, notes: null, lastCalledAt: null,
    actions: { claim: true, takeover: false, call: true, resolve: true, blockedReason: null }, ...change };
}
function page(open: MobileCallbackRequest[], change: Partial<MobileCallbacks> = {}): MobileCallbacks {
  return { ok: true, apiVersion: 1, environment: "test", profileId: "p", organizationId: "o", checkedAt: "2026-10-18T09:00:00Z",
    counts: { open: open.length, requested: 0, missed: open.length, manual: 0, unknown: 0 }, open, resolved: [], nextCursor: null, resetPage: false, ...change };
}
function setup(first = page([request("a"), request("b")])) {
  const api = { list: vi.fn().mockResolvedValue(first), claim: vi.fn(), resolve: vi.fn() } as unknown as CallbacksApi & { list: ReturnType<typeof vi.fn>; claim: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> };
  const target = vi.fn().mockResolvedValue({ status: "original", originalNumber: "+421905111222", dialNumber: "+421905111222", sourceName: null, targetName: null, verificationId: null });
  const store = new CallbackQueueStore(api, target);
  return { api, target, store };
}

describe("callback queue store", () => {
  it("reads only while visible and drops a late answer after hiding", async () => {
    const f = setup(); await f.store.refresh(); expect(f.api.list).not.toHaveBeenCalled();
    let resolve!: (value: MobileCallbacks) => void;
    f.api.list.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    f.store.setActive(true); const work = f.store.refresh();
    expect(f.api.list.mock.calls[0][1].aborted).toBe(false);
    f.store.setActive(false); expect(f.api.list.mock.calls[0][1].aborted).toBe(true);
    resolve(page([request("late")])); await work;
    expect(f.store.snapshot().open).toEqual([]); expect(f.store.snapshot().loading).toBe(false);
  });
  it("appends the next page and restarts when the queue changed under the cursor", async () => {
    const f = setup(page([request("a")], { nextCursor: "c1" })); f.store.setActive(true); await f.store.refresh();
    f.api.list.mockResolvedValueOnce(page([request("a"), request("b")], { nextCursor: null }));
    await f.store.loadMore();
    expect(f.api.list).toHaveBeenLastCalledWith("c1", expect.any(AbortSignal));
    expect(f.store.snapshot().open.map(item => item.id)).toEqual(["a", "b"]);
    f.api.list.mockResolvedValueOnce(page([request("a")], { nextCursor: "c2" }));
    await f.store.refresh();
    f.api.list.mockResolvedValueOnce(page([], { resetPage: true })).mockResolvedValueOnce(page([request("z")]));
    await f.store.loadMore();
    expect(f.store.snapshot().open.map(item => item.id)).toEqual(["z"]);
  });
  it("claims once, shows the server receipt and re-reads", async () => {
    const f = setup(); f.store.setActive(true); await f.store.refresh();
    f.api.claim.mockResolvedValue({ request: request("a", { status: "scheduled", claimant: { id: "p", name: "Ja", mine: true }, actions: { claim: false, takeover: false, call: true, resolve: true, blockedReason: null } }) });
    const work = f.store.claim("a"); expect(await f.store.claim("b")).toBe(false);
    await work; await tick();
    expect(f.api.claim).toHaveBeenCalledExactlyOnceWith("a");
    expect(f.store.snapshot().notice).toEqual({ id: "a", message: "Požiadavku ste prevzali.", tone: "info" });
    expect(f.api.list).toHaveBeenCalledTimes(2);
  });
  it("does not offer a claim the server did not allow", async () => {
    const f = setup(page([request("a", { actions: { claim: false, takeover: false, call: false, resolve: false, blockedReason: "Požiadavku má prevzatú Peter." } })]));
    f.store.setActive(true); await f.store.refresh();
    expect(await f.store.claim("a")).toBe(false); f.store.openEditor("a", "done");
    expect(f.api.claim).not.toHaveBeenCalled(); expect(f.store.snapshot().editor).toBeNull();
  });
  it("treats a lost answer as unknown and re-reads instead of retrying", async () => {
    const f = setup(); f.store.setActive(true); await f.store.refresh();
    f.api.claim.mockRejectedValue(new MobileApiError("offline", 0));
    expect(await f.store.claim("a")).toBe(false); await tick();
    expect(f.store.snapshot().notice?.message).toContain("akciu neopakujte naslepo");
    expect(f.api.claim).toHaveBeenCalledTimes(1); expect(f.api.list).toHaveBeenCalledTimes(2);
  });
  it("passes a server refusal through", async () => {
    const f = setup(); f.store.setActive(true); await f.store.refresh();
    f.api.claim.mockRejectedValue(new MobileApiError("Požiadavku medzitým prevzal Peter.", 409, "already_claimed"));
    await f.store.claim("a");
    expect(f.store.snapshot().notice).toEqual({ id: "a", message: "Požiadavku medzitým prevzal Peter.", tone: "error" });
  });
  it("resolves from the note editor, moves the row to the closed list and adjusts counts", async () => {
    const f = setup(); f.store.setActive(true); await f.store.refresh();
    f.store.openEditor("a", "done"); f.store.editNotes("  Dovolané ");
    const done = request("a", { status: "done", deadlineAt: null, resolvedAt: "2026-10-18T09:10:00Z", notes: "Dovolané", actions: { claim: false, takeover: false, call: false, resolve: false, blockedReason: "Požiadavka je už uzavretá." } });
    f.api.resolve.mockResolvedValue({ request: done });
    let reread!: (value: MobileCallbacks) => void; f.api.list.mockReturnValueOnce(new Promise(resolve => { reread = resolve; }));
    expect(await f.store.resolve()).toBe(true);
    expect(f.api.resolve).toHaveBeenCalledWith("a", { status: "done", notes: "Dovolané" });
    expect(f.store.snapshot()).toMatchObject({ editor: null, open: [expect.objectContaining({ id: "b" })], resolved: [done], counts: { open: 1, missed: 1 } });
    reread(page([request("b")], { resolved: [done] })); await tick();
  });
  it("keeps typed notes across hiding but closes them when the request is no longer open", async () => {
    const f = setup(); f.store.setActive(true); await f.store.refresh();
    f.store.openEditor("a", "cancelled"); f.store.editNotes("Duplicitné");
    f.store.setActive(false); expect(f.store.snapshot().editor).toEqual({ id: "a", status: "cancelled", notes: "Duplicitné" });
    f.store.setActive(true); await f.store.refresh(); expect(f.store.snapshot().editor?.notes).toBe("Duplicitné");
    f.api.list.mockResolvedValueOnce(page([request("b")])); await f.store.refresh();
    expect(f.store.snapshot().editor).toBeNull(); expect(f.store.snapshot().notice?.message).toContain("už nie je otvorená");
  });
  it("keeps a note for a request beyond the refreshed first page", async () => {
    const f = setup(page([request("a")], { nextCursor: "c1" })); f.store.setActive(true); await f.store.refresh();
    f.api.list.mockResolvedValueOnce(page([request("a"), request("far")], { nextCursor: null })); await f.store.loadMore();
    f.store.openEditor("far", "done"); f.store.editNotes("Rozpísané");
    f.api.list.mockResolvedValueOnce(page([request("a")], { nextCursor: "c2" })); await f.store.refresh();
    expect(f.store.snapshot().editor).toEqual({ id: "far", status: "done", notes: "Rozpísané" });
    f.api.list.mockResolvedValueOnce(page([request("a")], { nextCursor: null })); await f.store.refresh();
    expect(f.store.snapshot().editor).toBeNull();
  });
  it("checks the directory before ringing back and refuses a blocked number", async () => {
    const f = setup(); f.store.setActive(true); await f.store.refresh();
    expect(await f.store.prepareCall("a")).toEqual({ kind: "dial", number: "+421905111222" });
    expect(f.target).toHaveBeenCalledWith("+421905111222");
    f.target.mockResolvedValueOnce({ status: "blocked", originalNumber: "+421905111222", dialNumber: null, sourceName: null, targetName: null, verificationId: null });
    expect(await f.store.prepareCall("a")).toBeNull();
    expect(f.store.snapshot().notice).toMatchObject({ id: "a", tone: "error", message: expect.stringContaining("nedá volať späť") });
    f.target.mockRejectedValueOnce(new MobileApiError("Overenie cieľa nie je dostupné.", 503));
    expect(await f.store.prepareCall("a")).toBeNull(); expect(f.store.snapshot().notice?.message).toBe("Overenie cieľa nie je dostupné.");
    expect(f.store.snapshot().pending).toBeNull();
  });
  it("does not prepare a call the server did not allow", async () => {
    const f = setup(page([request("a", { number: null, actions: { claim: true, takeover: false, call: false, resolve: true, blockedReason: null } })]));
    f.store.setActive(true); await f.store.refresh();
    expect(await f.store.prepareCall("a")).toBeNull(); expect(f.target).not.toHaveBeenCalled();
  });
  it("re-reads after the phone starts a callback and reports its error", async () => {
    const f = setup(); f.store.setActive(true); await f.store.refresh();
    f.store.callStarted("a", null); await tick();
    expect(f.store.snapshot().notice?.message).toContain("vytáča"); expect(f.api.list).toHaveBeenCalledTimes(2);
    f.store.callStarted("a", "Požiadavka je už uzavretá."); expect(f.store.snapshot().notice).toMatchObject({ tone: "error", message: "Požiadavka je už uzavretá." });
  });
});
