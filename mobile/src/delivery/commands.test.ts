import { describe, expect, it, vi } from "vitest";
import { MobileApiError } from "../lib/api";
import { memoryStorage, type StorageDriver } from "../lib/session-storage";
import { DeliveryCommands, deliveryCommandsKey, type DeliveryCommandScope } from "./commands";
import { delivery } from "./fixtures";

const scope: DeliveryCommandScope = { environment: "test", apiOrigin: "https://test.dispecing.linkapomoci.sk", projectUrl: "https://nzpnqdstvkfncflgqlny.supabase.co",
  userId: "11111111-1111-4111-8111-111111111111", memberId: "77777777-7777-4777-8777-777777777777" };
const ID = delivery().id, COMMAND = "33333333-3333-4333-8333-333333333333", NOW = Date.parse("2026-10-22T10:00:00Z");
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup(storage: StorageDriver = memoryStorage(), changed: Partial<DeliveryCommandScope> = {}) {
  let current = true;
  const api = { command: vi.fn(async () => delivery({ status: "accepted", revision: 2, tracking: true })), read: vi.fn(async () => delivery({ status: "accepted", revision: 2 })) };
  const options = { current: () => current, uuid: vi.fn(() => COMMAND), clock: () => NOW };
  const commands = new DeliveryCommands(storage, { ...scope, ...changed }, api, options);
  return { commands, api, options, storage, depart: () => { current = false; } };
}

describe("durable delivery steps", () => {
  it("commits an intent before transport and removes it only after confirmation", async () => {
    const { commands, storage, api } = setup(); await commands.load();
    api.command.mockImplementationOnce(async () => {
      const saved = JSON.parse((await storage.getItem(commands.key))!);
      expect(saved.records[0].command).toEqual({ commandId: COMMAND, action: "accept", expectedRevision: 1, publishedVersion: 1 });
      return delivery({ revision: 2, status: "accepted" });
    });
    expect((await commands.start(delivery(), "accept"))?.status).toBe("accepted");
    expect(commands.snapshot()).toMatchObject({ ready: true, busy: false, pending: [] });
    expect(JSON.parse((await storage.getItem(commands.key))!).records).toEqual([]);
  });

  it("locks in the same frame, including while the intent is being written", async () => {
    const held = deferred<void>(), storage = memoryStorage();
    const local = setup({ ...storage, setItem: vi.fn(async (key, value) => { await held.promise; await storage.setItem(key, value); }) });
    await local.commands.load();
    const first = local.commands.start(delivery(), "accept");
    await local.commands.start(delivery(), "accept");
    expect(local.api.command).not.toHaveBeenCalled(); held.resolve(); await first;
    expect(local.api.command).toHaveBeenCalledOnce(); expect(local.options.uuid).toHaveBeenCalledOnce();
  });

  it.each([0, 408, 429, 500, 502, 503, 504])("keeps a possibly committed step after status %s", async status => {
    const { commands, api } = setup(); await commands.load();
    api.command.mockRejectedValueOnce(new MobileApiError("lost", status));
    await commands.start(delivery(), "accept");
    expect(commands.snapshot().pending[0]).toMatchObject({ status: "uncertain", command: { commandId: COMMAND } });
    await commands.dismiss(ID); await commands.start(delivery(), "reject", { comment: "iná požiadavka" });
    expect(api.command).toHaveBeenCalledOnce();
    await commands.retry(ID);
    expect(api.command.mock.calls[1]).toEqual(api.command.mock.calls[0]);
    expect(commands.snapshot().pending).toEqual([]);
  });

  it("restores an uncertain step after restart without sending anything automatically", async () => {
    const first = setup(); await first.commands.load(); first.api.command.mockRejectedValueOnce(new TypeError("offline"));
    await first.commands.start(delivery({ status: "accepted", revision: 4, publishedVersion: 2 }), "update", { eta: "2026-10-22T10:30:00.000Z" });
    first.commands.dispose();
    const second = setup(first.storage); await second.commands.load();
    expect(second.api.command).not.toHaveBeenCalled();
    await second.commands.retry(ID);
    expect(second.api.command.mock.calls[0]).toEqual(first.api.command.mock.calls[0]);
    expect(second.options.uuid).not.toHaveBeenCalled();
  });

  it("preserves a multiline reason and excludes cards, GPS and credentials from persistence", async () => {
    const { commands, api, storage } = setup(); await commands.load(); api.command.mockRejectedValueOnce(new MobileApiError("offline", 0));
    await commands.start(delivery(), "reject", { comment: "Porucha\nČakám na pomoc" });
    const saved = JSON.parse((await storage.getItem(commands.key))!);
    expect(Object.keys(saved.records[0]).sort()).toEqual(["command", "createdAt", "deliveryId"]);
    expect(saved.records[0].command.comment).toBe("Porucha\nČakám na pomoc");
    expect(JSON.stringify(saved)).not.toMatch(/MOCK|ZA999AB|token|latitude|longitude|card/);
  });

  it("never sends when local storage fails or has not loaded", async () => {
    const storage = memoryStorage(), local = setup({ ...storage, setItem: async () => { throw new Error("full"); } });
    await local.commands.start(delivery(), "accept"); expect(local.api.command).not.toHaveBeenCalled();
    await local.commands.load(); await local.commands.start(delivery(), "accept");
    expect(local.api.command).not.toHaveBeenCalled(); expect(local.commands.snapshot().error).toContain("Neodoslal sa");
  });

  it("does not overwrite an unreadable pending record", async () => {
    const local = setup(); await local.storage.setItem(local.commands.key, "broken");
    await local.commands.load(); await local.commands.start(delivery(), "accept");
    expect(local.commands.snapshot().ready).toBe(false); expect(local.api.command).not.toHaveBeenCalled();
    expect(await local.storage.getItem(local.commands.key)).toBe("broken");
  });

  it("keeps intents separate for account, membership and environment", async () => {
    const first = setup(); await first.commands.load(); first.api.command.mockRejectedValueOnce(new Error("offline")); await first.commands.start(delivery(), "accept");
    for (const changes of [{ userId: "22222222-2222-4222-8222-222222222222" }, { memberId: "88888888-8888-4888-8888-888888888888" },
      { environment: "production" as const, apiOrigin: "https://dispecing.linkapomoci.sk", projectUrl: "https://ifpaeegaesdmljfkdvcn.supabase.co" }]) {
      const next = setup(first.storage, changes); await next.commands.load(); expect(next.commands.snapshot().pending).toEqual([]);
      await first.storage.setItem(next.commands.key, (await first.storage.getItem(first.commands.key))!);
      const forged = setup(first.storage, changes); await forged.commands.load(); expect(forged.commands.snapshot().ready).toBe(false);
    }
    expect(() => deliveryCommandsKey({ ...scope, apiOrigin: "https://wrong.example" })).toThrow();
  });

  it.each(["dispose", "account", "access"])("does not send when %s changes during local preparation", async reason => {
    const held = deferred<void>(), storage = memoryStorage();
    const local = setup({ ...storage, setItem: async (key, value) => { await held.promise; await storage.setItem(key, value); } }); await local.commands.load();
    const starting = local.commands.start(delivery(), "accept");
    if (reason === "dispose") local.commands.dispose(); else if (reason === "access") local.commands.setActive(false); else local.depart(); held.resolve(); await starting;
    expect(local.api.command).not.toHaveBeenCalled();
    const next = setup(storage); await next.commands.load(); expect(next.commands.snapshot().pending[0].command.commandId).toBe(COMMAND);
  });

  it("leaves a late result for the same account to verify on its next login", async () => {
    const held = deferred<ReturnType<typeof delivery>>(), first = setup(); await first.commands.load(); first.api.command.mockReturnValueOnce(held.promise);
    const starting = first.commands.start(delivery(), "accept"); await vi.waitFor(() => expect(first.api.command).toHaveBeenCalled());
    first.depart(); held.resolve(delivery({ status: "accepted", revision: 2 })); expect(await starting).toBeNull();
    const next = setup(first.storage); await next.commands.load(); expect(next.commands.snapshot().pending).toHaveLength(1);
  });

  it("requires an explicit rejection and a fresh read before dismissing", async () => {
    const local = setup(); await local.commands.load(); local.api.command.mockRejectedValueOnce(new MobileApiError("changed", 409));
    await local.commands.start(delivery(), "accept"); await local.commands.dismiss(ID); expect(local.commands.snapshot().pending).toHaveLength(1);
    await local.commands.review(ID); expect(local.commands.snapshot().pending[0].reviewed).toBe(true);
    await local.commands.dismiss(ID); expect(local.commands.snapshot().pending).toEqual([]);
  });

  it("does not dismiss a rejection when the current state cannot be read", async () => {
    const local = setup(); await local.commands.load(); local.api.command.mockRejectedValueOnce(new MobileApiError("changed", 409));
    await local.commands.start(delivery(), "accept"); local.api.read.mockRejectedValueOnce(new MobileApiError("no access", 403));
    await local.commands.review(ID); await local.commands.dismiss(ID); expect(local.commands.snapshot().pending).toHaveLength(1);
  });

  it("a failed later review invalidates an earlier successful review", async () => {
    const local = setup(); await local.commands.load(); local.api.command.mockRejectedValueOnce(new MobileApiError("changed", 409));
    await local.commands.start(delivery(), "accept"); await local.commands.review(ID);
    expect(local.commands.snapshot().pending[0].reviewed).toBe(true);
    local.api.read.mockRejectedValueOnce(new MobileApiError("no access", 403)); await local.commands.review(ID); await local.commands.dismiss(ID);
    expect(local.commands.snapshot().pending[0].reviewed).toBe(false);
  });

  it("lets the person close an explicit rejection after the delivery disappeared", async () => {
    const local = setup(); await local.commands.load(); local.api.command.mockRejectedValueOnce(new MobileApiError("gone", 404));
    await local.commands.start(delivery(), "accept"); local.api.read.mockRejectedValueOnce(new MobileApiError("gone", 404));
    await local.commands.review(ID); await local.commands.dismiss(ID); expect(local.commands.snapshot().pending).toEqual([]);
  });

  it("keeps the confirmed intent if local cleanup fails, so retry cannot repeat a new step", async () => {
    let writes = 0; const storage = memoryStorage();
    const local = setup({ ...storage, setItem: async (key, value) => { if (++writes === 2) throw new Error("disk"); await storage.setItem(key, value); } });
    await local.commands.load(); expect(await local.commands.start(delivery(), "accept")).not.toBeNull();
    expect(local.commands.snapshot().pending[0].status).toBe("confirmed");
    await local.commands.start(delivery({ status: "accepted", revision: 2 }), "en_route"); expect(local.api.command).toHaveBeenCalledOnce();
    await local.commands.retry(ID); expect(local.api.command.mock.calls[1]).toEqual(local.api.command.mock.calls[0]);
    expect(local.commands.snapshot().pending).toEqual([]);
  });

  it("does not create a step for an expired, closed or incompatible state", async () => {
    const local = setup(); await local.commands.load();
    await local.commands.start(delivery({ expiresAt: new Date(NOW).toISOString() }), "accept");
    await local.commands.start(delivery({ status: "completed" }), "blocked", { comment: "problem" });
    await local.commands.start(delivery(), "complete"); await local.commands.start(delivery(), "update");
    expect(local.api.command).not.toHaveBeenCalled();
  });

  it("pauses new steps and retries during logout without losing the pending intent", async () => {
    const local = setup(); await local.commands.load(); local.api.command.mockRejectedValueOnce(new MobileApiError("offline", 0));
    await local.commands.start(delivery(), "accept"); local.commands.setActive(false); await local.commands.retry(ID);
    expect(local.commands.snapshot().enabled).toBe(false); expect(local.api.command).toHaveBeenCalledOnce();
    local.commands.setActive(true); await local.commands.retry(ID); expect(local.api.command).toHaveBeenCalledTimes(2);
    expect(local.commands.snapshot().pending).toEqual([]);
  });

  it("keeps a step recoverable when logout interrupts a reply and then fails", async () => {
    const held = deferred<ReturnType<typeof delivery>>(), local = setup(); await local.commands.load(); local.api.command.mockReturnValueOnce(held.promise);
    const starting = local.commands.start(delivery(), "accept"); await vi.waitFor(() => expect(local.api.command).toHaveBeenCalled());
    local.commands.setActive(false); held.resolve(delivery({ status: "accepted", revision: 2 })); expect(await starting).toBeNull();
    expect(local.commands.snapshot().pending[0].status).toBe("uncertain"); local.commands.setActive(true); await local.commands.retry(ID);
    expect(local.api.command.mock.calls[1]).toEqual(local.api.command.mock.calls[0]);
  });
});
