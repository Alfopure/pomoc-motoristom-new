import { describe, expect, it, vi } from "vitest";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { TaskWorkspaceStore } from "./task-workspace-store";
const task = (overrides: Partial<WorkspaceTask> = {}): WorkspaceTask => ({ id: "task-1", title: "Original", caseId: "", caseIds: [], caseLinks: [], revision: 1, originLocked: false, provenance: "manual", origins: [], updatedAt: "2026-09-10T10:00:00Z", assignedTo: "unassigned", dueAt: "", priority: "normal", status: "open", kind: "other", ...overrides });
const reply = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(fn => { resolve = fn; }); return { resolve, promise }; }
describe("shared task workspace", () => {
  it("does no network work before capability activation", async () => {
    const fetcher = vi.fn(); const store = new TaskWorkspaceStore(false, undefined, fetcher);
    await store.refresh(); await store.create(); await store.loadMessages("task-1");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("starts standalone and protects any task draft field", () => {
    const store = new TaskWorkspaceStore(true);
    expect(store.getSnapshot().createDraft.caseIds).toEqual([]);
    store.editCreate({ priority: "urgent" }); expect(store.dirty).toBe(true);
    store.discard(); expect(store.dirty).toBe(false);
  });
  it("retains failed edit and revision", async () => {
    const store = new TaskWorkspaceStore(true, undefined, () => reply({ error: "Offline" }, 503), [task()]);
    store.edit("task-1", { title: "Draft" }); expect(await store.saveTask("task-1")).toBe(false);
    expect(store.getSnapshot().drafts["task-1"]).toMatchObject({ value: { title: "Draft" }, revision: 1 });
  });
  it("preserves newer typing during save and advances only its base revision", async () => {
    const response = deferred<Response>(); const store = new TaskWorkspaceStore(true, undefined, () => response.promise, [task()]);
    store.edit("task-1", { title: "Sent" }); const save = store.saveTask("task-1");
    store.edit("task-1", { title: "Newer" }); response.resolve(Response.json({ task: task({ title: "Sent", revision: 2 }) }));
    expect(await save).toBe(true); expect(store.getSnapshot().drafts["task-1"]).toMatchObject({ value: { title: "Newer" }, revision: 2 });
  });
  it("keeps conflicting task edits until explicit reload", async () => {
    const store = new TaskWorkspaceStore(true, undefined, () => reply({ error: "Conflict" }, 409), [task()]);
    store.edit("task-1", { title: "Mine" }); await store.saveTask("task-1");
    expect(store.getSnapshot().conflicts).toContain("task-1"); expect(store.getSnapshot().drafts["task-1"].value.title).toBe("Mine");
  });
  it("reuses pending chat UUID after uncertain failure and does not duplicate acknowledgement", async () => {
    const requests: { body: string; clientMessageId: string }[] = [];
    const store = new TaskWorkspaceStore(true, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      if (requests.length === 1) throw new Error("Connection lost");
      return Response.json({ message: { id: "message-1", taskId: "task-1", authorName: "Me", authorProfileId: "me", createdAt: "2026-09-10T10:00:00Z", ...body } });
    }, [task()]);
    store.editChat("task-1", "Hello"); expect(await store.sendMessage("task-1")).toBe(false);
    expect(await store.sendMessage("task-1")).toBe(true); expect(requests[1]).toEqual(requests[0]);
    expect(store.getSnapshot().chats["task-1"].messages).toHaveLength(1); expect(store.getSnapshot().chatDrafts["task-1"]).toBeUndefined();
  });
  it("preserves newer chat typing during acknowledgement", async () => {
    const response = deferred<Response>(); const store = new TaskWorkspaceStore(true, undefined, () => response.promise, [task()]);
    store.editChat("task-1", "Sent"); const send = store.sendMessage("task-1"); store.editChat("task-1", "Newer");
    response.resolve(Response.json({ message: { id: "message-1", body: "Sent" } })); await send;
    expect(store.getSnapshot().chatDrafts["task-1"]).toBe("Newer");
  });
  it("blocks oversized messages locally", async () => {
    const fetcher = vi.fn(); const store = new TaskWorkspaceStore(true, undefined, fetcher, [task()]);
    store.editChat("task-1", "x".repeat(10001)); expect(await store.sendMessage("task-1")).toBe(false); expect(fetcher).not.toHaveBeenCalled();
  });
  it("discards revoked tasks and chat drafts atomically on an authorized refresh", async () => {
    const store = new TaskWorkspaceStore(true, undefined, () => reply({ tasks: [] }), [task()]);
    store.edit("task-1", { title: "Draft" }); store.editChat("task-1", "Private"); await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ tasks: [], drafts: {}, chatDrafts: {} });
  });
  it("prevents late save response from restoring a task removed by authorized refresh", async () => {
    const response = deferred<Response>(); const store = new TaskWorkspaceStore(true, undefined, (url) => url === "/api/tasks" ? reply({ tasks: [] }) : response.promise, [task()]);
    store.edit("task-1", { title: "Draft" }); const save = store.saveTask("task-1"); await store.refresh();
    response.resolve(Response.json({ task: task({ title: "Draft", revision: 2 }) })); await save;
    expect(store.getSnapshot().tasks).toEqual([]);
  });
  it("paginates older chat and deduplicates overlapping pages", async () => {
    const urls: string[] = [];
    const first = { id: "2", createdAt: "2026-09-10T10:00:00Z", body: "Recent" };
    const older = { id: "1", createdAt: "2026-09-09T10:00:00Z", body: "Old" };
    const store = new TaskWorkspaceStore(true, undefined, url => { urls.push(url); return reply(url.includes("beforeId") ? { messages: [older, first], nextCursor: null } : { messages: [first], nextCursor: { createdAt: first.createdAt, id: first.id } }); }, [task()]);
    await store.loadMessages("task-1"); await store.loadMessages("task-1", true);
    expect(urls[1]).toContain("beforeId=2"); expect(store.getSnapshot().chats["task-1"].messages.map(message => message.id)).toEqual(["1", "2"]);
  });
  it.each([false, true])("keeps every chat message reachable after a disjoint refresh (just sent: %s)", async (justSent) => {
    const messages = Array.from({ length: 201 }, (_, index) => ({ id: String(index + 1).padStart(3, "0"), createdAt: "2026-09-10T10:00:00Z", body: `Message ${index + 1}` }));
    let availableCount = 100;
    const store = new TaskWorkspaceStore(true, undefined, (url, init) => {
      if (init?.method === "POST") return reply({ message: messages[200] });
      const beforeId = new URL(url, "https://fixture.test").searchParams.get("beforeId");
      const available = messages.slice(0, availableCount).filter(message => !beforeId || message.id < beforeId);
      const page = available.slice(-50);
      return reply({ messages: page, nextCursor: available.length > 50 ? { id: page[0].id, createdAt: page[0].createdAt } : null });
    }, [task()]);
    await store.loadMessages("task-1");
    availableCount = justSent ? 201 : 200;
    if (justSent) { store.editChat("task-1", "Message 201"); await store.sendMessage("task-1"); }
    await store.loadMessages("task-1");
    // Another poll must preserve progress into the missing interval.
    await store.loadMessages("task-1", true);
    const gapCursor = store.getSnapshot().chats["task-1"].nextCursor;
    await store.loadMessages("task-1");
    expect(store.getSnapshot().chats["task-1"].nextCursor).toEqual(gapCursor);
    for (let page = 0; page < 5 && store.getSnapshot().chats["task-1"].nextCursor; page++) await store.loadMessages("task-1", true);
    expect(store.getSnapshot().chats["task-1"].nextCursor).toBeNull();
    expect(store.getSnapshot().chats["task-1"].messages.map(message => message.id)).toEqual(messages.slice(0, availableCount).map(message => message.id));
  });
  it("opens an authorized task missing from a stale list by task ID", async () => {
    const fetcher = vi.fn((url: string) => reply(url.endsWith("/messages") ? { messages: [], nextCursor: null } : { task: task() }));
    const store = new TaskWorkspaceStore(true, undefined, fetcher);
    await store.open("task-1");
    expect(fetcher).toHaveBeenCalledWith("/api/tasks/task-1", expect.objectContaining({ cache: "no-store" }));
    expect(store.getSnapshot().selectedId).toBe("task-1");
  });
  it("a late deep link cannot replace a more recent task choice", async () => {
    const response = deferred<Response>();
    const store = new TaskWorkspaceStore(true, undefined, url => url.endsWith("/messages") ? reply({ messages: [], nextCursor: null }) : response.promise, [task({ id: "task-2" })]);
    const opening = store.open("task-1"); store.select("task-2"); response.resolve(Response.json({ task: task() })); await opening;
    expect(store.getSnapshot().selectedId).toBe("task-2");
    expect(store.getSnapshot().tasks.map(item => item.id)).toEqual(["task-2"]);
  });
  it("keeps independent task and chat drafts when selecting another task", () => {
    const store = new TaskWorkspaceStore(true, undefined, () => reply({ messages: [], nextCursor: null }), [task(), task({ id: "task-2" })]);
    store.edit("task-1", { title: "First draft" }); store.editChat("task-1", "First chat"); store.select("task-2"); store.edit("task-2", { title: "Second draft" });
    expect(store.getSnapshot().drafts["task-1"].value.title).toBe("First draft"); expect(store.getSnapshot().chatDrafts["task-1"]).toBe("First chat");
  });
  it("sends an independent reminder without resetting saved reminder channels on edits", async () => {
    const fetcher = vi.fn((...args: [string, RequestInit?]) => { void args; return reply({ task: task({ revision: 2 }) }); });
    const store = new TaskWorkspaceStore(true, undefined, fetcher, [task()]);
    store.edit("task-1", { reminderAt: "2026-10-01T12:00:00Z" }); await store.saveTask("task-1");
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(payload.reminderAt).toBe("2026-10-01T12:00:00.000Z"); expect(payload).not.toHaveProperty("reminderChannels");
  });

});

describe("task list authority and capability changes", () => {
  it("unversioned props cannot erase an exact opened task or its draft", async () => {
    const store = new TaskWorkspaceStore(true, undefined, url => reply(url.endsWith("/messages") ? { messages: [], nextCursor: null } : { task: task() }));
    await store.open("task-1"); store.edit("task-1", { title: "Unsaved exact task" });
    store.setTasks([]);
    expect(store.getSnapshot().drafts["task-1"].value.title).toBe("Unsaved exact task");
    expect(store.getSnapshot().selectedId).toBe("task-1");
  });
  it("unversioned props cannot erase a newly created task", async () => {
    const store = new TaskWorkspaceStore(true, undefined, () => reply({ task: task() }));
    store.editCreate({ title: "New" }); await store.create(); store.editChat("task-1", "New task chat draft");
    store.setTasks([]);
    expect(store.getSnapshot().tasks).toHaveLength(1); expect(store.getSnapshot().chatDrafts["task-1"]).toBe("New task chat draft");
  });
  it("a list requested before an exact open cannot erase the exact response", async () => {
    const list = deferred<Response>();
    const store = new TaskWorkspaceStore(true, undefined, url => url === "/api/tasks" ? list.promise : reply(url.endsWith("/messages") ? { messages: [], nextCursor: null } : { task: task() }));
    const refreshing = store.refresh(); await store.open("task-1"); store.edit("task-1", { title: "Draft" });
    list.resolve(Response.json({ tasks: [] })); await refreshing;
    expect(store.getSnapshot().drafts["task-1"].value.title).toBe("Draft");
  });
  it("reauthorizes the list when a focused notification supersedes the resume check", async () => {
    const resumeList = deferred<Response>(), renewedList = deferred<Response>();
    let listReads = 0;
    const store = new TaskWorkspaceStore(true, undefined, url => url === "/api/tasks"
      ? ++listReads === 1 ? resumeList.promise : renewedList.promise
      : reply(url.endsWith("/messages") ? { messages: [], nextCursor: null } : { task: task() }), [task(), task({ id: "removed" })]);
    const resume = store.reauthorize();
    await store.open("task-1");
    expect(listReads).toBe(2);
    expect(store.getSnapshot().hidden).toBe(true);
    renewedList.resolve(Response.json({ tasks: [task()] }));
    await vi.waitFor(() => expect(store.getSnapshot().hidden).toBe(false));
    resumeList.resolve(Response.json({ tasks: [task(), task({ id: "removed" })] })); await resume;
    expect(store.getSnapshot().selectedId).toBe("task-1");
    expect(store.getSnapshot().tasks.map(task => task.id)).toEqual(["task-1"]);
  });
  it("a list resolving during an exact read preserves the draft, then a subsequent authorized omission purges it", async () => {
    const exact = deferred<Response>();
    const store = new TaskWorkspaceStore(true, undefined, url => url === "/api/tasks" ? reply({ tasks: [] }) : url.endsWith("/messages") ? reply({ messages: [], nextCursor: null }) : exact.promise, [task()]);
    store.edit("task-1", { title: "Keep until exact authorization" }); const opening = store.open("task-1"); await store.refresh();
    expect(store.getSnapshot().drafts["task-1"]).toBeDefined();
    exact.resolve(Response.json({ task: task() })); await opening;
    expect(store.getSnapshot().drafts["task-1"]).toBeDefined();
    await store.refresh(); store.setTasks([task()]);
    expect(store.getSnapshot()).toMatchObject({ tasks: [], drafts: {}, selectedId: null });
  });
  it("an authoritative omission cannot be undone by stale props", async () => {
    const store = new TaskWorkspaceStore(true, undefined, () => reply({ tasks: [] }), [task()]);
    await store.refresh(); store.setTasks([task({ revision: 99 })]); expect(store.getSnapshot().tasks).toEqual([]);
  });
  it("disabling clears only this private store and ignores late success/auth failures after re-enable", async () => {
    const stale = deferred<Response>(); let count = 0;
    const store = new TaskWorkspaceStore(true, undefined, () => ++count === 1 ? stale.promise : reply({ tasks: [task({ id: "fresh" })] }), [task()]);
    store.edit("task-1", { title: "Private" }); const read = store.refresh();
    store.setEnabled(false); store.setTasks([task()]); store.editChat("task-1", "Stale callback");
    expect(store.getSnapshot()).toMatchObject({ tasks: [], drafts: {}, chatDrafts: {}, hidden: true });
    store.setEnabled(true); await store.refresh();
    stale.resolve(Response.json({ error: "Old session denied" }, { status: 403 })); await read;
    expect(store.getSnapshot().tasks.map(task => task.id)).toEqual(["fresh"]); expect(store.getSnapshot().hidden).toBe(false);
  });
});
