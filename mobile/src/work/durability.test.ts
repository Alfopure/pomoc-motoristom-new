import { describe, expect, it, vi } from "vitest";
import { TaskCreateDraft, TaskCommand } from "./commands";
import { DraftNotSentError, type DraftPort } from "../drafts/port";

import { WorkStore } from "./store";
import { workflowCodec } from "./draft-codecs";
import type { WorkApi } from "./api";
import { MobileApiError } from "../lib/api";
import { deferred, jsonCopy, memoryPort } from "./draft-test-port";
const caseId = "00000000-0000-4000-8000-000000000002";
function port(): DraftPort { return { load: () => null, changed: vi.fn(), prepare: vi.fn().mockRejectedValue(new DraftNotSentError()), current: () => true, acceptsScope: () => true, settled: () => true, reject: vi.fn() }; }
describe("task durable preparation", () => {
  it("does not send a create when durable preparation fails", async () => {
    const createTask = vi.fn(), storage = port(), draft = new TaskCreateDraft({ createTask }, caseId, storage);
    draft.edit({ title: "Uložiť koncept" }); await draft.submit();
    expect(storage.prepare).toHaveBeenCalledOnce(); expect(createTask).not.toHaveBeenCalled();
    expect(draft.snapshot().status).toBe("editing"); expect(draft.snapshot().error).toContain("neodoslala");
  });
});
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000009" }));
const taskId = "00000000-0000-4000-8000-000000000003", commandId = "00000000-0000-4000-8000-000000000004";
const scope = { ok: true as const, apiVersion: 1 as const, environment: "test" as const, profileId: "00000000-0000-4000-8000-000000000001", checkedAt: "2026-10-12T14:00:00Z" };
const input = { action: "start" as const, commandId, expectedRevision: 2 };
const receipt = { ...scope, taskId, commandId, committedRevision: 3, currentRevision: 3, refreshRequired: true as const };
const created = { ...scope, caseId, taskId, refreshRequired: true as const };
function command(storage = memoryPort(), send = vi.fn(async () => receipt)) { return { ...storage, send, draft: new TaskCommand(send, { port: storage.port, codec: workflowCodec(taskId) }) }; }
describe("durable task replay and receipts", () => {
  it("awaits WAL, single-flights before await and fences scope loss before network", async () => {
    const f = command(), waiting = deferred<Awaited<ReturnType<DraftPort["prepare"]>>>();
    vi.mocked(f.port.prepare).mockImplementationOnce(() => waiting.promise);
    const saving = f.draft.submit(input); await f.draft.submit(input); expect(f.send).not.toHaveBeenCalled(); expect(f.draft.snapshot().status).toBe("saving");
    f.record.live = false; waiting.resolve({ finish: vi.fn(async () => true) }); await saving;
    expect(f.send).not.toHaveBeenCalled(); expect(f.draft.snapshot().status).toBe("editing");
  });
  it("restores saving as uncertain with exact command; no automatic send", async () => {
    const f = command(), wait = deferred<typeof receipt>(); f.send.mockImplementationOnce(() => wait.promise);
    const saving = f.draft.submit(input); await Promise.resolve();
    const restored = command(memoryPort(jsonCopy(f.record.payload)));
    expect(restored.draft.snapshot().status).toBe("uncertain"); expect(restored.send).not.toHaveBeenCalled();
    await restored.draft.reconcile(); expect(restored.send).toHaveBeenCalledWith(input);
    wait.resolve(receipt); await saving;
  });
  it.each([401, 403, 409, 422])("later denial %i preserves exact pending authority", async status => {
    const f = command(); f.send.mockRejectedValueOnce(new MobileApiError("unknown", 0)).mockRejectedValueOnce(new MobileApiError("denied", status));
    await f.draft.submit(input); const original = f.draft.exportDraft().pending; await f.draft.reconcile();
    expect(f.draft.snapshot().status).toBe("uncertain"); expect(f.draft.exportDraft().pending).toEqual(original);
    expect(f.record.payload).toMatchObject({ status: "uncertain", pending: input });
  });
  it("later failed local preflight retains uncertain original and sends nothing", async () => {
    const f = command(); f.send.mockRejectedValueOnce(new MobileApiError("unknown", 0)); await f.draft.submit(input);
    vi.mocked(f.port.prepare).mockRejectedValueOnce(new DraftNotSentError()); await f.draft.reconcile();
    expect(f.send).toHaveBeenCalledOnce(); expect(f.draft.snapshot().status).toBe("uncertain"); expect(f.draft.exportDraft().pending).toEqual(input);
  });
  it("records a late receipt before disposal fence but never updates disposed UI", async () => {
    const f = command(), waiting = deferred<typeof receipt>(); f.send.mockImplementationOnce(() => waiting.promise);
    const saving = f.draft.submit(input); await Promise.resolve(); f.draft.dispose(); waiting.resolve(receipt); expect(await saving).toBeUndefined();
    expect(f.record.payload).toMatchObject({ status: "saved", receipt }); expect(f.draft.snapshot().receipt).toBeNull();
  });
  it("known save stays saved if receipt disk write fails; reset cannot issue duplicate", async () => {
    const f = command(); f.record.finishOk = false; await f.draft.submit(input);
    expect(f.draft.snapshot()).toMatchObject({ status: "saved", receipt }); expect(f.draft.snapshot().error).toContain("miestne");
    f.draft.reset(); await f.draft.submit({ ...input, expectedRevision: 3 }); expect(f.send).toHaveBeenCalledOnce();
    expect(f.record.payload).toMatchObject({ status: "saving", pending: input });
  });
  it.each([
    { version: 2, status: "editing", pending: null, receipt: null },
    { version: 1, status: "uncertain", pending: { ...input, expectedRevision: 0 }, receipt: null },
    { version: 1, status: "saved", pending: input, receipt: { ...receipt, profileId: taskId } },
    { version: 1, status: "saved", pending: input, receipt: { ...receipt, commandId: taskId } },
    { version: 1, status: "editing", pending: null, receipt: null, token: "forbidden" },
  ])("rejects malformed restore without memory-only send fallback %j", async value => {
    const f = command(memoryPort(value)); await f.draft.submit(input); expect(f.record.reject).toBe(true); expect(f.send).not.toHaveBeenCalled();
  });
});
describe("durable create and shared composer", () => {
  it("restores frozen UTC create separately from local text and resets review freshness", async () => {
    const storage = memoryPort(), createTask = vi.fn().mockRejectedValue(new MobileApiError("unknown", 0));
    const draft = new TaskCreateDraft({ createTask }, caseId, storage.port); draft.edit({ title: " Úloha ", dueAt: "2026-10-12 14:30" }); await draft.submit();
    const restored = new TaskCreateDraft({ createTask }, caseId, memoryPort(jsonCopy(storage.record.payload)).port);
    expect(restored.exportDraft().pending?.dueAt).toBe(new Date(2026, 9, 12, 14, 30).toISOString());
    expect(restored.snapshot()).toMatchObject({ status: "uncertain", reviewed: false, input: { title: " Úloha ", dueAt: "2026-10-12 14:30" } });
    restored.review(restored.snapshot().reviewAfter); restored.allowRetry(); expect(restored.snapshot().status).toBe("uncertain");
    restored.review(restored.snapshot().reviewAfter + 1); restored.allowRetry(); expect(restored.snapshot().status).toBe("editing"); expect(createTask).toHaveBeenCalledOnce();
  });
  it("persists late create success and blocks fresh/reset after local receipt failure", async () => {
    const storage = memoryPort(), createTask = vi.fn(async () => created), draft = new TaskCreateDraft({ createTask }, caseId, storage.port);
    storage.record.finishOk = false; draft.edit({ title: "Úloha" }); await draft.submit(); draft.reset(); await draft.submit();
    expect(draft.snapshot()).toMatchObject({ status: "saved", receipt: created }); expect(createTask).toHaveBeenCalledOnce();
    const waiting = deferred<typeof created>(), later = memoryPort(), late = new TaskCreateDraft({ createTask: () => waiting.promise }, caseId, later.port);
    late.edit({ title: "Late" }); const saving = late.submit(); await Promise.resolve(); late.dispose(); waiting.resolve(created); await saving;
    expect(later.record.payload).toMatchObject({ status: "saved", receipt: created });
  });
  it.each([undefined, null, commandId])("restores composer fields and reviewer tri-state %s across one shared store", reviewer => {
    const storage = memoryPort(), api = {} as WorkApi, first = new WorkStore(api, () => {}, () => storage.port).task(taskId);
    first.body = "Rozpracovaná správa"; first.comment = "Výsledok"; first.reviewerId = reviewer;
    const restoredStore = new WorkStore(api, () => {}, () => memoryPort(jsonCopy(storage.record.payload)).port), restored = restoredStore.task(taskId);
    expect(restored.body).toBe(first.body); expect(restored.comment).toBe(first.comment); expect(restored.reviewerId).toBe(reviewer); expect(restoredStore.task(taskId)).toBe(restored);
  });
  it("does not revive an unsent workflow WAL when a sibling later prepares", async () => {
    const storage = memoryPort(), api = { transition: vi.fn(), sendMessage: vi.fn<WorkApi["sendMessage"]>(async (id, input) => ({ ...scope, taskId: id, refreshRequired: true, message: { id: input.clientMessageId, taskId: id, authorProfileId: scope.profileId, authorName: "MOCK", createdAt: scope.checkedAt, ...input } })) } as unknown as WorkApi;
    const store = new WorkStore(api, () => {}, () => storage.port), retained = store.task(taskId);
    vi.mocked(storage.port.prepare).mockRejectedValueOnce(new DraftNotSentError());
    await retained.workflow.submit(input);
    await retained.message.submit({ body: "Sibling", clientMessageId: commandId });
    expect(api.transition).not.toHaveBeenCalled();
    expect(storage.record.payload).toMatchObject({ workflow: { status: "editing", pending: null }, message: { status: "saved" } });
  });
  it("merges message outcomes with concurrent unsent comment edits instead of overwriting them", async () => {
    const storage = memoryPort(), waiting = deferred<unknown>();
    const api = { sendMessage: () => waiting.promise } as unknown as WorkApi;
    const task = new WorkStore(api, () => {}, () => storage.port).task(taskId);
    const sending = task.message.submit({ clientMessageId: commandId, body: "Presné" }); await Promise.resolve(); task.comment = "Novší komentár";
    waiting.resolve({ ...scope, taskId, message: { id: commandId, taskId, authorProfileId: scope.profileId, authorName: "Operátor", body: "Presné", createdAt: scope.checkedAt, clientMessageId: commandId }, refreshRequired: true }); await sending;
    expect(storage.record.payload).toMatchObject({ comment: "Novší komentár", message: { status: "saved" } });
  });
});

describe("composite late outcomes after account disposal", () => {
  it("keeps both frozen pending commands and merges late receipts without exporting disposed controllers", async () => {
    const storage = memoryPort(), workflow = deferred<typeof receipt>(), message = deferred<unknown>();
    const transition = vi.fn(() => workflow.promise), sendMessage = vi.fn(() => message.promise);
    const store = new WorkStore({ transition, sendMessage } as unknown as WorkApi, () => {}, () => storage.port), retained = store.task(taskId);
    retained.body = "Presná správa"; retained.comment = "Súbežný koncept";
    const savingWorkflow = retained.workflow.submit(input), messageInput = { body: retained.body, clientMessageId: commandId };
    const savingMessage = retained.message.submit(messageInput);
    await vi.waitFor(() => { expect(transition).toHaveBeenCalledOnce(); expect(sendMessage).toHaveBeenCalledOnce(); });
    store.dispose(); storage.record.live = false;
    workflow.resolve(receipt); expect(await savingWorkflow).toBeUndefined();
    expect(storage.record.payload).toMatchObject({ comment: "Súbežný koncept", workflow: { status: "saved", pending: input, receipt }, message: { status: "saving", pending: messageInput } });
    const sent = { ...scope, taskId, refreshRequired: true, message: { id: commandId, taskId, authorProfileId: scope.profileId, authorName: "Operátor", createdAt: scope.checkedAt, ...messageInput } };
    message.resolve(sent); expect(await savingMessage).toBeUndefined();
    expect(storage.record.payload).toMatchObject({ workflow: { status: "saved", pending: input, receipt }, message: { status: "saved", pending: messageInput, receipt: sent } });
    const restoredPort = memoryPort(storage.record.payload), restored = new WorkStore({} as WorkApi, () => {}, () => restoredPort.port).task(taskId);
    expect(restoredPort.record.reject).toBe(false); expect(restored.workflow.snapshot().status).toBe("saved"); expect(restored.message.snapshot().status).toBe("saved");
  });
  it("rejects the entire composite before showing a partially valid composer", () => {
    const storage = memoryPort({ version: 1, taskId, body: "sensitive malformed", comment: "partial", reviewer: { kind: "selected", id: commandId }, workflow: { version: 2 }, message: {} });
    const restored = new WorkStore({} as WorkApi, () => {}, () => storage.port).task(taskId);
    expect(storage.record.reject).toBe(true); expect(restored.body).toBe(""); expect(restored.comment).toBe(""); expect(restored.reviewerId).toBeUndefined();
  });
});

describe("closed workspace ownership", () => {
  it("cannot allocate a new controller after the workspace was disposed", () => {
    const store = new WorkStore({} as WorkApi, () => {}); store.dispose();
    expect(() => store.task(taskId)).toThrow(DraftNotSentError); expect(() => store.create(caseId)).toThrow(DraftNotSentError); expect(() => store.attachment(caseId)).toThrow(DraftNotSentError);
  });
});
