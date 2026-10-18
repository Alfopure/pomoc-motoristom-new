import { describe, expect, it, vi } from "vitest";
import type { MobileCallWrapUp } from "../../../src/lib/mobile-call-wrap-up";
import { MobileApiError } from "../lib/api";
import type { CallWrapUpApi } from "./wrap-up-api";
import { WrapUpStore } from "./wrap-up-store";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function data(change: Partial<MobileCallWrapUp> = {}): MobileCallWrapUp {
  return { ok: true, apiVersion: 1, environment: "test", profileId: "p", organizationId: "o", checkedAt: "2026-10-18T09:00:00Z", callId: "call", number: "+421905111222",
    linkedCaseId: null, linkedCase: null, outcome: null, callbackScheduling: "queue", suggestions: [], matchesAvailable: true, ...change };
}
function setup(first = data()) {
  const api = { read: vi.fn().mockResolvedValue(first), saveOutcome: vi.fn(), linkCase: vi.fn() } as unknown as CallWrapUpApi & Record<"read" | "saveOutcome" | "linkCase", ReturnType<typeof vi.fn>>;
  let n = 0; const uuid = vi.fn(() => "m" + ++n);
  const store = new WrapUpStore(api, "call", uuid); const linked = vi.fn(); store.setLinkedListener(linked);
  return { api, uuid, store, linked };
}

describe("after-call store", () => {
  it("reads only while visible and keeps a typed outcome across hiding", async () => {
    const f = setup(); await f.store.refresh(); expect(f.api.read).not.toHaveBeenCalled();
    f.store.setActive(true); await f.store.refresh();
    f.store.openEditor(); f.store.choose("reached"); f.store.editNote("Dovolané");
    f.store.setActive(false);
    expect(f.store.snapshot()).toMatchObject({ data: null, editor: { outcome: "reached", note: "Dovolané" } });
  });
  it("prefills the current outcome and saves once with one identity", async () => {
    const f = setup(data({ outcome: { value: "callback", label: "Zavolať naspäť", note: "Po 11", callbackMinutes: 60, at: null } }));
    f.store.setActive(true); await f.store.refresh();
    f.store.openEditor(); expect(f.store.snapshot().editor).toMatchObject({ outcome: "callback", note: "Po 11", callbackMinutes: 60, mutationId: "m1", sent: false });
    f.api.saveOutcome.mockResolvedValue({ replayed: false });
    const work = f.store.save(); expect(await f.store.save()).toBe(false); await work;
    expect(f.api.saveOutcome).toHaveBeenCalledExactlyOnceWith("call", { mutationId: "m1", outcome: "callback", note: "Po 11", callbackMinutes: 60 });
    expect(f.store.snapshot()).toMatchObject({ editor: null, notice: { tone: "info", message: expect.stringContaining("naplánované") } });
  });
  it("repeats a lost save with the same identity but treats an edit as a new command", async () => {
    const f = setup(); f.store.setActive(true); await f.store.refresh();
    f.store.openEditor(); f.store.choose("not_reached");
    f.api.saveOutcome.mockRejectedValueOnce(new MobileApiError("offline", 0)).mockResolvedValue({ replayed: true });
    await f.store.save(); await tick();
    expect(f.store.snapshot().notice?.message).toContain("nezapíše dvakrát"); expect(f.api.read).toHaveBeenCalledTimes(2);
    await f.store.save();
    expect(f.api.saveOutcome.mock.calls.map(call => call[1].mutationId)).toEqual(["m1", "m1"]);
    expect(f.store.snapshot().notice?.message).toBe("Tento výsledok už bol uložený.");
    f.store.openEditor(); f.store.choose("reached");
    f.api.saveOutcome.mockRejectedValueOnce(new MobileApiError("offline", 0)); await f.store.save();
    f.store.editNote("Nová poznámka");
    expect(f.store.snapshot().editor).toMatchObject({ mutationId: "m3", sent: false });
  });
  it("does not offer a callback that nothing would schedule", async () => {
    const f = setup(data({ callbackScheduling: "unavailable" })); f.store.setActive(true); await f.store.refresh();
    f.store.openEditor(); f.store.choose("callback");
    expect(f.store.canSave()).toBe(false); expect(await f.store.save()).toBe(false); expect(f.api.saveOutcome).not.toHaveBeenCalled();
    f.store.choose("reached"); expect(f.store.canSave()).toBe(true);
  });
  it("links from the link it read, re-reads the call card and reports refusal", async () => {
    const f = setup(data({ linkedCaseId: "a" })); f.store.setActive(true); await f.store.refresh();
    f.api.linkCase.mockResolvedValueOnce({ changed: true });
    expect(await f.store.link("b")).toBe(true);
    expect(f.api.linkCase).toHaveBeenCalledWith("call", { caseId: "b", expectedCaseId: "a" });
    expect(f.linked).toHaveBeenCalledTimes(1); expect(f.store.snapshot().notice?.message).toContain("časovej osi");
    f.api.linkCase.mockRejectedValueOnce(new MobileApiError("Hovor medzitým priradil kolega k inému prípadu.", 409));
    expect(await f.store.link("c")).toBe(false);
    expect(f.store.snapshot().notice).toEqual({ tone: "error", message: "Hovor medzitým priradil kolega k inému prípadu." });
    expect(f.linked).toHaveBeenCalledTimes(2);
  });
  it("does not start a second write while a hidden one is still in flight", async () => {
    const f = setup(); f.store.setActive(true); await f.store.refresh();
    f.store.openEditor(); f.store.choose("reached");
    let resolve!: (value: unknown) => void; f.api.saveOutcome.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const first = f.store.save(); f.store.setActive(false); f.store.setActive(true); await f.store.refresh();
    expect(await f.store.save()).toBe(false); expect(await f.store.link("b")).toBe(false);
    resolve({ replayed: false }); await first;
    expect(f.api.saveOutcome).toHaveBeenCalledTimes(1);
    f.api.saveOutcome.mockResolvedValue({ replayed: true });
    expect(await f.store.save()).toBe(true);
  });
  it("drops a late answer after hiding", async () => {
    const f = setup(); f.store.setActive(true); await f.store.refresh();
    let resolve!: (value: unknown) => void; f.api.linkCase.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const work = f.store.link("b"); f.store.setActive(false); resolve({ changed: true }); await work;
    expect(f.linked).not.toHaveBeenCalled(); expect(f.store.snapshot().notice).toBeNull();
  });
});
