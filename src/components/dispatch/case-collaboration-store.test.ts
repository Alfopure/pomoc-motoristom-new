import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseCollaborationStore } from "./case-collaboration-store";
import { activeCaseEditors, type CaseLiveSnapshot } from "@/domain/case-collaboration";
import type { DispatchCase } from "@/domain/types";
const card = { id: "case-a", updatedAt: "2026-09-19T10:00:00.000001Z", mainNote: "original", tasks: [{ id: "task-a" }] } as DispatchCase;
const snapshot = (patch: Partial<CaseLiveSnapshot> = {}): CaseLiveSnapshot => ({ available: true, ids: [card.id], changes: [], versions: { [card.id]: 1 }, notifications: [], editors: [], more: false, ...patch });
afterEach(() => vi.useRealTimers());
describe("case collaboration contract", () => {
  it("merges comments without losing tasks, removes deleted cards, and ignores older case revisions", async () => {
    const response = vi.fn().mockResolvedValueOnce(Response.json(snapshot({ changes: [{ ...card, mainNote: "remote comment" }] })))
      .mockResolvedValueOnce(Response.json(snapshot({ changes: [{ ...card, updatedAt: "2026-09-19T09:00:00Z", mainNote: "old" }] })))
      .mockResolvedValueOnce(Response.json(snapshot({ ids: [], versions: {} })));
    const store = new CaseCollaborationStore([card], response);
    await store.refresh(); expect(store.getSnapshot().cases[0]).toMatchObject({ mainNote: "remote comment", tasks: card.tasks });
    await store.refresh(); expect(store.getSnapshot().cases[0].mainNote).toBe("remote comment");
    await store.refresh(); expect(store.getSnapshot().cases).toEqual([]); store.stop();
  });
  it("hides within 30 seconds even offline; a late response after revoke cannot restore private data", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(Response.json(snapshot()));
    const store = new CaseCollaborationStore([card], read);
    await store.refresh(); expect(store.getSnapshot().hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000); expect(store.getSnapshot().hidden).toBe(true);
    let finish!: (response: Response) => void;
    read.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const pending = store.refresh(); store.revoke(); finish(Response.json(snapshot({ changes: [card] })));
    await pending; expect(store.getSnapshot().cases).toEqual([]); expect(store.getSnapshot().denied).toBe(true); store.stop();
  });
  it("coalesces 20 invalidations and deduplicates concurrent requests", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockImplementation(async () => Response.json(snapshot()));
    const store = new CaseCollaborationStore([card], read); store.start(); await store.refresh();
    await vi.advanceTimersByTimeAsync(550); read.mockClear();
    for (let i = 0; i < 20; i++) store.invalidate();
    await vi.advanceTimersByTimeAsync(550); expect(read).toHaveBeenCalledTimes(1); store.stop();
  });
  it("clears immediately on 403 and retains compatibility only before schema activation", async () => {
    const read = vi.fn().mockResolvedValueOnce(Response.json(snapshot({ available: false })))
      .mockResolvedValueOnce(Response.json(snapshot())).mockResolvedValueOnce(Response.json(snapshot({ available: false })))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const store = new CaseCollaborationStore([card], read);
    await store.refresh(); expect(store.getSnapshot()).toMatchObject({ available: false, hidden: false });
    await store.refresh(); await store.refresh(); expect(store.getSnapshot()).toMatchObject({ available: true, stale: true });
    await store.refresh(); expect(store.getSnapshot()).toMatchObject({ denied: true, cases: [], editors: [], notifications: [] }); store.stop();
  });
  it("deduplicates colleagues but preserves independent sessions and expires abandoned drafts", () => {
    const editor = { sessionId: "one", profileId: "colleague", displayName: "Jana", caseId: "case-a", draftId: null, expiresAt: new Date(60_000).toISOString() };
    const entries = [editor, { ...editor, sessionId: "two" }];
    expect(activeCaseEditors(entries, 0, "case-a")).toHaveLength(1);
    expect(activeCaseEditors(entries.slice(1), 0, "case-a")).toHaveLength(1);
    expect(activeCaseEditors(entries, 60_000, "case-a")).toEqual([]);
    expect(activeCaseEditors(entries, 0, "case-a", "colleague")).toEqual([]);
  });
  it("does not resurrect deletions from old props or discard a local creation during an older read", async () => {
    const read = vi.fn().mockResolvedValueOnce(Response.json(snapshot({ ids: [], versions: {} })));
    const store = new CaseCollaborationStore([card], read); await store.refresh(); store.acceptCases([card]);
    expect(store.getSnapshot().cases).toEqual([]);
    let finish!: (response: Response) => void;
    read.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const pending = store.refresh(); const created = { ...card, id: "new" }; store.acceptCases([created]); finish(Response.json(snapshot({ ids: [], versions: {} })));
    await pending; expect(store.getSnapshot().cases).toEqual([created]); store.stop();
  });
  it("bounds reads for 20 clients in idle and a 20-change/2-second burst", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockImplementation(async () => Response.json(snapshot()));
    const stores = Array.from({ length: 20 }, () => new CaseCollaborationStore([card], read));
    stores.forEach(store => store.start()); await vi.advanceTimersByTimeAsync(60_000);
    // Replaces 10s location checks + 60s notifications (at least 7 per minute/client).
    expect(read.mock.calls.length).toBe(60);
    read.mockClear();
    for (let change = 0; change < 20; change++) { stores.forEach(store => store.invalidate()); await vi.advanceTimersByTimeAsync(100); }
    await vi.advanceTimersByTimeAsync(600);
    expect(read.mock.calls.length).toBeLessThanOrEqual(80);
    stores.forEach(store => store.stop());
  });
});
