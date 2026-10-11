import { describe, expect, it, vi } from "vitest";
import { TaskCreateDraft, TaskCommand } from "./commands";
import { MobileApiError } from "../lib/api";
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
describe("retained task commands", () => {
  it("single-flights exact immutable command through unknown outcome and later denial", async () => {
    const send = vi.fn().mockRejectedValueOnce(new MobileApiError("timeout", 0)).mockRejectedValueOnce(new MobileApiError("inactive", 403)).mockResolvedValue({ ok: true });
    const draft = new TaskCommand(send); const input = { commandId: "id", expectedRevision: 2, action: "start" };
    await draft.submit(input); input.expectedRevision = 99;
    await draft.reconcile(); expect(draft.snapshot().status).toBe("uncertain");
    await draft.reconcile(); expect(send.mock.calls.map(c => c[0])).toEqual(Array(3).fill({ commandId: "id", expectedRevision: 2, action: "start" }));
    expect(draft.snapshot().status).toBe("saved"); await draft.reconcile(); expect(send).toHaveBeenCalledTimes(3);
  });
  it("ignores duplicate presses and late result after account disposal", async () => {
    const waiting = deferred<{ ok: boolean }>(), send = vi.fn(() => waiting.promise), draft = new TaskCommand(send);
    const first = draft.submit({ body: "hello" }); await draft.submit({ body: "second" }); draft.dispose(); waiting.resolve({ ok: true });
    expect(await first).toBeUndefined(); expect(send).toHaveBeenCalledTimes(1); expect(draft.snapshot().receipt).toBeNull();
  });
  it("initial definitive rejection permits edited new command but uncertain generic409 does not", async () => {
    const send = vi.fn().mockRejectedValueOnce(new MobileApiError("conflict", 409)).mockRejectedValueOnce(new MobileApiError("timeout", 0)).mockRejectedValueOnce(new MobileApiError("conflict", 409));
    const draft = new TaskCommand(send); await draft.submit({ expectedRevision: 1 }); expect(draft.snapshot().status).toBe("editing");
    await draft.submit({ expectedRevision: 2 }); await draft.reconcile(); expect(draft.snapshot().status).toBe("uncertain");
    await draft.submit({ expectedRevision: 3 }); expect(send).toHaveBeenCalledTimes(3);
  });
  it("requires a first-page read started after creation uncertainty and explicit acknowledgment", async () => {
    const createTask = vi.fn().mockRejectedValue(new MobileApiError("timeout", 0)); const draft = new TaskCreateDraft({ createTask }, "case");
    draft.edit({ title: "Odťah" }); const started = Date.now(); await draft.submit();
    draft.review(started); draft.allowRetry(); expect(draft.snapshot().status).toBe("uncertain");
    draft.review(draft.snapshot().reviewAfter + 1); expect(draft.snapshot().status).toBe("uncertain");
    draft.allowRetry(); expect(draft.snapshot().status).toBe("editing"); expect(draft.snapshot().input.title).toBe("Odťah");
  });
});

describe("task create deadline and late receipts", () => {
  it("rejects impossible local dates without POST; converts a valid local time", async () => {
    const createTask = vi.fn().mockResolvedValue({ taskId: "saved" }), draft = new TaskCreateDraft({ createTask }, "case");
    draft.edit({ title: "X", dueAt: "2026-02-30 14:30" }); await draft.submit(); expect(createTask).not.toHaveBeenCalled();
    draft.edit({ dueAt: "2026-10-12 14:30" }); await draft.submit(); expect(createTask.mock.calls[0][1].dueAt).toBe(new Date(2026, 9, 12, 14, 30).toISOString());
  });
  it("does not emit saved identity after account disposal", async () => {
    const waiting = deferred<never>(), createTask = vi.fn(() => waiting.promise), draft = new TaskCreateDraft({ createTask }, "case");
    draft.edit({ title: "X" }); const save = draft.submit(); draft.dispose(); waiting.resolve({ taskId: "saved" } as never);
    expect(await save).toBeUndefined(); expect(draft.snapshot().receipt).toBeNull();
  });
});

describe("older task messages", () => {
  it("keeps chronological order across reverse-chronological pages without duplicates", async () => {
    const { orderedMessages } = await import("./commands");
    const message = (id: string) => ({ id, taskId: "task", authorProfileId: "actor", authorName: "Actor", body: id, createdAt: "2026-01-01", clientMessageId: id });
    const pages = [{ messages: [message("3"), message("4")] }, { messages: [message("1"), message("2"), message("3")] }];
    expect(orderedMessages(pages).map(v => v.id)).toEqual(["1", "2", "3", "4"]); expect(pages[0].messages[0].id).toBe("3");
  });
});

describe("reviewer selection", () => {
  it("distinguishes an untouched server reviewer from an explicitly cleared choice", async () => {
    const { selectedReviewer } = await import("./commands");
    expect(selectedReviewer(undefined, "original")).toBe("original");
    expect(selectedReviewer(null, "original")).toBeNull();
    expect(selectedReviewer("other", "original")).toBe("other");
  });
});
