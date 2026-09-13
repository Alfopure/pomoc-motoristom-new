import { describe, expect, it, vi } from "vitest";
import type { WorkspaceTask } from "@/domain/task-workspace";
import type { TaskWorkflowCommand } from "@/domain/task-workflow";
import { TaskWorkspaceStore } from "./task-workspace-store";
const task = (patch: Partial<WorkspaceTask> = {}): WorkspaceTask => ({ id: "task-1", title: "Original", workflowVersion: 1, workflowState: "todo", reviewerProfileId: null, status: "open", assignedTo: "solver", dueAt: "2027-01-01T10:00:00Z", reminderAt: "2027-01-01T09:00:00Z", priority: "normal", kind: "other", caseId: "case-1", caseIds: ["case-1", "case-2"], caseLinks: [], revision: 4, updatedAt: "2026-09-10T10:00:00Z", originLocked: false, provenance: "manual", origins: [], ...patch });
const response = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
const receipt = (command: TaskWorkflowCommand, saved: WorkspaceTask = task({ workflowState: "in_progress", revision: 5 })) => ({ task: saved, commandId: command.commandId, committedRevision: 5 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { resolve, promise }; }

describe("persistent task workflow store", () => {
  it("requires a real server capability, including for an empty task list", async () => {
    const fetcher = vi.fn(() => response({ tasks: [], workflowEnabled: true }));
    const store = new TaskWorkspaceStore(true, "solver", fetcher);
    expect(store.getSnapshot().workflowEnabled).toBe(false);
    await store.refresh(); expect(store.getSnapshot().workflowEnabled).toBe(true);
    const unavailable = new TaskWorkspaceStore(true, "solver", fetcher, [task({ workflowVersion: undefined })]);
    expect(await unavailable.workflow("task-1", "start")).toBe(false);
    expect(unavailable.getSnapshot().error).toContain("ešte nie sú"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("sends a stage-only command with a canonical revision and leaves all unrelated task data intact", async () => {
    const commands: TaskWorkflowCommand[] = [];
    const store = new TaskWorkspaceStore(true, "solver", async (url, init) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [], nextCursor: null });
      const command = JSON.parse(String(init?.body)); commands.push(command);
      return Response.json(receipt(command));
    }, [task()]);
    expect(await store.workflow("task-1", "start")).toBe(true);
    expect(commands[0]).toMatchObject({ action: "start", expectedRevision: 4 });
    expect(Object.keys(commands[0]).sort()).toEqual(["action", "commandId", "expectedRevision"]);
    expect(store.getSnapshot().tasks[0]).toMatchObject({ workflowState: "in_progress", dueAt: task().dueAt, reminderAt: task().reminderAt, assignedTo: "solver", caseIds: ["case-1", "case-2"] });
  });
  it("holds exact UUID, revision and payload across lost acknowledgement, later refresh and retry", async () => {
    const commands: TaskWorkflowCommand[] = []; let stage = task();
    const store = new TaskWorkspaceStore(true, "solver", async (url, init) => {
      if (url === "/api/tasks") return Response.json({ tasks: [stage], workflowEnabled: true });
      if (url.endsWith("/messages")) return Response.json({ messages: [], nextCursor: null });
      const command = JSON.parse(String(init?.body)); commands.push(command);
      if (commands.length === 1) { stage = task({ workflowState: "in_review", reviewerProfileId: "reviewer", revision: 5 }); throw new TypeError("Connection lost"); }
      return Response.json(receipt(command, stage));
    }, [stage]);
    expect(await store.workflow("task-1", "submit_review", { reviewerProfileId: "reviewer", comment: "  Hotové  " })).toBe(false);
    expect(store.dirty).toBe(true); await store.refresh();
    expect(store.getSnapshot().tasks[0].workflowState).toBe("in_review");
    expect(await store.retryWorkflow("task-1")).toBe(true);
    expect(commands[1]).toEqual(commands[0]); expect(commands[1].comment).toBe("Hotové");
    expect(store.getSnapshot().pendingWorkflow).toEqual({}); expect(store.dirty).toBe(false);
  });
  it("prevents a different command or generic edit from replacing an uncertain attempt", async () => {
    const fetcher = vi.fn(() => { throw new TypeError("Offline"); });
    const store = new TaskWorkspaceStore(true, "solver", fetcher, [task()]);
    await store.workflow("task-1", "start");
    expect(await store.workflow("task-1", "complete")).toBe(false);
    store.edit("task-1", { title: "Newer draft" }); expect(await store.saveTask("task-1")).toBe(false);
    expect(await store.link("task-1", "case-3")).toBe(false); expect(await store.deleteTask("task-1")).toBe(false);
    store.discard(); expect(store.dirty).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retains malformed acknowledgements as uncertain instead of declaring success", async () => {
    const store = new TaskWorkspaceStore(true, "solver", () => response({ ...receipt({ action: "start", commandId: "wrong", expectedRevision: 4 }), commandId: "wrong" }), [task()]);
    expect(await store.workflow("task-1", "start")).toBe(false);
    expect(store.getSnapshot().pendingWorkflow["task-1"]).toBeDefined(); expect(store.getSnapshot().tasks[0].workflowState).toBe("todo");
  });
  it("marks explicit revision conflict without retaining a rejected command", async () => {
    const store = new TaskWorkspaceStore(true, "solver", url => url.endsWith("/messages") ? response({ messages: [], nextCursor: null }) : response({ error: "Súbežná zmena" }, 409), [task()]);
    expect(await store.workflow("task-1", "start")).toBe(false);
    expect(store.getSnapshot().pendingWorkflow).toEqual({}); expect(store.getSnapshot().conflicts).toContain("task-1"); expect(store.getSnapshot().tasks[0].workflowState).toBe("todo");
  });
  it("preserves typing during the command and requires explicit conflict resolution", async () => {
    const wait = deferred<Response>(); let command!: TaskWorkflowCommand;
    const store = new TaskWorkspaceStore(true, "solver", (url, init) => { if (url.endsWith("/messages")) return response({ messages: [], nextCursor: null }); command = JSON.parse(String(init?.body)); return wait.promise; }, [task()]);
    const save = store.workflow("task-1", "start"); store.edit("task-1", { title: "Typed while saving" });
    wait.resolve(Response.json(receipt(command))); expect(await save).toBe(true);
    expect(store.getSnapshot().drafts["task-1"]).toMatchObject({ revision: 4, value: { title: "Typed while saving" } }); expect(store.getSnapshot().conflicts).toContain("task-1");
  });
  it("keeps the newest authorized canonical state returned by an idempotent receipt", async () => {
    const store = new TaskWorkspaceStore(true, "solver", (url, init) => url.endsWith("/messages") ? response({ messages: [], nextCursor: null }) : response(receipt(JSON.parse(String(init?.body)), task({ status: "done", workflowState: "done", revision: 8 }))), [task()]);
    expect(await store.workflow("task-1", "start")).toBe(true);
    expect(store.getSnapshot().tasks[0]).toMatchObject({ revision: 8, status: "done", workflowState: "done" });
  });
  it("revocation removes pending commands and late responses cannot restore private tasks", async () => {
    const wait = deferred<Response>(); let command!: TaskWorkflowCommand;
    const store = new TaskWorkspaceStore(true, "solver", (url, init) => { if (url === "/api/tasks") return response({ tasks: [], workflowEnabled: true }); command = JSON.parse(String(init?.body)); return wait.promise; }, [task()]);
    const save = store.workflow("task-1", "start"); await store.refresh();
    wait.resolve(Response.json(receipt(command))); expect(await save).toBe(false);
    expect(store.getSnapshot().tasks).toEqual([]); expect(store.getSnapshot().pendingWorkflow).toEqual({});
  });
  it("existing quick-status helpers use the workflow endpoint when the capability is enabled", async () => {
    const urls: string[] = [];
    const store = new TaskWorkspaceStore(true, "solver", (url, init) => { urls.push(url); if (url.endsWith("/messages")) return response({ messages: [], nextCursor: null }); return response(receipt(JSON.parse(String(init?.body)), task({ status: "done", workflowState: "done", revision: 5 }))); }, [task()]);
    expect(await store.setTaskStatus("task-1", "done")).toBe(true); expect(urls[0]).toBe("/api/tasks/task-1/workflow");
  });
});
