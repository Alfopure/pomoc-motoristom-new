import { describe, expect, it, vi } from "vitest";
import type { DraftPort } from "../drafts/port";
import { MobileApiError } from "../lib/api";
import { EmployeeTasksStore } from "./store";
import { commandId, otherId, receipt, stubApi, taskId, userId } from "./fixtures.test-helper";

function memory(initial: unknown = null) {
  let value = initial;
  const copy = (v: unknown) => JSON.parse(JSON.stringify(v));
  const port: DraftPort = {
    load: () => value, changed: payload => { value = copy(payload); },
    prepare: vi.fn(async payload => { value = copy(typeof payload === "function" ? payload() : payload); return { finish: async (next: object) => { value = copy(next); return true; } }; }),
    current: () => true, settled: () => true, reject: vi.fn(),
    acceptsScope: v => Boolean(v && typeof v === "object" && "userId" in v && v.userId === userId),
  };
  return { port, read: () => copy(value) };
}
const edited = (store: EmployeeTasksStore) => store.editCreate({ title: "Skontrolovať auto", target: { kind: "person", userId: otherId }, targetLabel: "Kolega" });

describe("employee task writes", () => {
  it("retains a draft and its recipient across module unmount/recreation", () => {
    const durable = memory(), original = new EmployeeTasksStore(stubApi(), userId, { id: () => commandId, createPort: durable.port });
    edited(original); original.dispose();
    const restored = new EmployeeTasksStore(stubApi(), userId, { id: () => commandId, createPort: durable.port });
    expect(restored.snapshot().create.input).toMatchObject({ title: "Skontrolovať auto", target: { userId: otherId }, targetLabel: "Kolega" });
    expect(restored.snapshot().revoked).toBe(false);
  });

  it("prepares durable state before transport and refuses a failed local write", async () => {
    const durable = memory(), create = vi.fn();
    vi.mocked(durable.port.prepare).mockRejectedValueOnce(new Error("storage full"));
    const store = new EmployeeTasksStore(stubApi({ create }), userId, { id: () => commandId, createPort: durable.port });
    edited(store); await store.create();
    expect(create).not.toHaveBeenCalled(); expect(store.snapshot().create).toMatchObject({ status: "editing", pending: null });
  });

  it("restores a legitimate unfinished whitespace title without revoking access", () => {
    const durable = memory(), first = new EmployeeTasksStore(stubApi(), userId, { id: () => commandId, createPort: durable.port });
    first.editCreate({ title: "  " }); first.dispose();
    const restored = new EmployeeTasksStore(stubApi(), userId, { id: () => commandId, createPort: durable.port });
    expect(restored.snapshot()).toMatchObject({ revoked: false, create: { input: { title: "  " }, status: "editing" } });
  });

  it("retries the exact create envelope after an uncertain response and restart", async () => {
    const durable = memory(), create = vi.fn().mockRejectedValueOnce(new MobileApiError("lost response", 503)).mockImplementationOnce(async input => receipt(input.commandId));
    const original = new EmployeeTasksStore(stubApi({ create }), userId, { id: () => commandId, createPort: durable.port });
    edited(original); await original.create(); expect(original.snapshot().create.status).toBe("uncertain");
    original.editCreate({ title: "Do not change an already sent payload" });
    expect(original.snapshot().create.input.title).toBe("Skontrolovať auto"); original.dispose();
    const restored = new EmployeeTasksStore(stubApi({ create }), userId, { id: () => otherId, createPort: durable.port });
    await restored.retryCreate();
    expect(create).toHaveBeenCalledTimes(2); expect(create.mock.calls[1][0]).toEqual(create.mock.calls[0][0]);
    expect(restored.snapshot().create.status).toBe("saved");
  });

  it("a later refusal does not prove an earlier uncertain creation absent", async () => {
    const create = vi.fn().mockRejectedValueOnce(new MobileApiError("lost", 503)).mockRejectedValueOnce(new MobileApiError("changed", 409));
    const store = new EmployeeTasksStore(stubApi({ create }), userId, { id: () => commandId });
    edited(store); await store.create(); await store.retryCreate();
    expect(store.snapshot().create).toMatchObject({ status: "uncertain", pending: { commandId } });
  });

  it("retains input after a known validation refusal and uses a new command on edit", async () => {
    const create = vi.fn().mockRejectedValueOnce(new MobileApiError("invalid", 400)).mockImplementationOnce(async input => receipt(input.commandId));
    const ids = vi.fn().mockReturnValueOnce(commandId).mockReturnValueOnce(otherId);
    const store = new EmployeeTasksStore(stubApi({ create }), userId, { id: ids });
    edited(store); await store.create(); expect(store.snapshot().create.input.title).toBe("Skontrolovať auto");
    store.editCreate({ title: "Doplniť dokumenty" }); await store.create();
    expect(create.mock.calls[1][0].commandId).toBe(otherId); expect(create.mock.calls[1][0].title).toBe("Doplniť dokumenty");
  });

  it("keeps an uncertain assignment frozen through retry and command restore", async () => {
    const durable = memory(), command = vi.fn().mockRejectedValueOnce(new MobileApiError("lost", 0)).mockImplementationOnce(async (_id, input) => receipt(input.commandId));
    const first = new EmployeeTasksStore(stubApi({ command }), userId, { id: () => commandId, commandPort: () => durable.port });
    await first.command(taskId, { action: "assign", expectedRevision: 1, target: { kind: "person", userId: otherId } });
    await first.command(taskId, { action: "complete", expectedRevision: 1 }); expect(command).toHaveBeenCalledOnce(); first.dispose();
    const restored = new EmployeeTasksStore(stubApi({ command }), userId, { id: () => otherId, commandPort: () => durable.port });
    expect(restored.commandState(taskId).status).toBe("uncertain"); await restored.retryCommand(taskId);
    expect(command.mock.calls[1]).toEqual(command.mock.calls[0]);
  });

  it("preserves an unsent comment on conflict and clears it durably after send", async () => {
    const durable = memory(), command = vi.fn().mockRejectedValueOnce(new MobileApiError("new revision", 409)).mockImplementationOnce(async (_id, input) => receipt(input.commandId));
    const store = new EmployeeTasksStore(stubApi({ command }), userId, { id: () => commandId, commandPort: () => durable.port });
    store.editComment(taskId, "Doklady sú pripravené");
    await store.command(taskId, { action: "comment", body: store.commandState(taskId).draftText, expectedRevision: 1 });
    expect(store.commandState(taskId)).toMatchObject({ status: "editing", draftText: "Doklady sú pripravené" });
    await store.command(taskId, { action: "comment", body: store.commandState(taskId).draftText, expectedRevision: 2 });
    expect(store.commandState(taskId).draftText).toBe(""); expect(durable.read().draftText).toBe("");
    store.editComment(taskId, "Ďalšia rozpracovaná správa");
    expect(durable.read()).toMatchObject({ status: "editing", pending: null, receipt: null, draftText: "Ďalšia rozpracovaná správa" });
  });

  it("erases sensitive task state on lost authorization and stops later writes", async () => {
    let revoke = () => {};
    const create = vi.fn();
    const store = new EmployeeTasksStore(stubApi({ create, subscribeAccessLoss: listener => { revoke = listener; return () => {}; } }), userId, { id: () => commandId });
    edited(store); store.editComment(taskId, "Private work note"); revoke(); await store.create();
    expect(store.snapshot()).toMatchObject({ revoked: true, commands: {}, create: { input: { title: "" } } });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a persisted create belonging to another account", () => {
    const durable = memory({ version: 1, userId: otherId, status: "editing", input: {}, pending: null, receipt: null });
    const store = new EmployeeTasksStore(stubApi(), userId, { id: () => commandId, createPort: durable.port });
    expect(store.snapshot().revoked).toBe(true); expect(durable.port.reject).toHaveBeenCalledOnce();
  });
});
