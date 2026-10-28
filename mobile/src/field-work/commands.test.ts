import { describe, expect, it, vi } from "vitest";
import { MobileApiError } from "../lib/api";
import { memoryStorage } from "../lib/session-storage";
import { WorkCommands, parseWorkIntent, workCommandsKey, type WorkIntent } from "./commands";

const id = (n: number) => `96000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = id(1), MEMBER = id(2), OP = id(3), REQUEST = id(4);
const scope = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", projectUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", userId: USER, memberId: MEMBER };
const accept = (n: number) => ({ commandId: id(n), action: "accept" as const, expectedRevision: 2, payload: {} });
async function ready(send: (intent: WorkIntent) => Promise<unknown>, storage = memoryStorage()) {
  const commands = new WorkCommands(storage, scope, send, { current: () => true, clock: () => Date.parse("2026-10-28T08:00:00Z") });
  await commands.load();
  return { commands, storage };
}

describe("stored work steps", () => {
  it("is scoped to the environment, project, user and member", () => {
    expect(workCommandsKey(scope)).toBe(`pm-work-commands-v1.test.nzpnqdstvkfncflgqlny.${USER}.${MEMBER}`);
    expect(() => workCommandsKey({ ...scope, apiOrigin: "https://dispecing.linkapomoci.sk" })).toThrow();
  });
  it("keeps the intent before sending and forgets it once confirmed", async () => {
    const storage = memoryStorage();
    const send = vi.fn(async () => { expect(JSON.parse((await storage.getItem(workCommandsKey(scope)))!).records).toHaveLength(1); return { ok: true }; });
    const { commands } = await ready(send, storage);
    await expect(commands.start({ kind: "operation", id: OP }, accept(10), "Prijať jazdu")).resolves.toEqual({ ok: true });
    expect(commands.snapshot().pending).toEqual([]);
    expect(JSON.parse((await storage.getItem(workCommandsKey(scope)))!).records).toEqual([]);
  });
  it("retries an uncertain step with the same command id and blocks a second one meanwhile", async () => {
    const send = vi.fn().mockRejectedValueOnce(new MobileApiError("offline", 0)).mockResolvedValueOnce({ ok: true });
    const { commands, storage } = await ready(send);
    expect(await commands.start({ kind: "operation", id: OP }, accept(11), "Prijať jazdu")).toBeNull();
    expect(commands.snapshot().pending[0]).toMatchObject({ status: "uncertain", label: "Prijať jazdu" });
    expect(await commands.start({ kind: "operation", id: OP }, accept(12), "Prijať jazdu")).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    // After a restart the step is restored but never sent on its own.
    const restored = new WorkCommands(storage, scope, send, { current: () => true });
    await restored.load();
    expect(restored.snapshot().pending).toMatchObject([{ status: "uncertain", command: { commandId: id(11) } }]);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(restored.retry({ kind: "operation", id: OP })).resolves.toEqual({ ok: true });
    expect(send.mock.calls[1][0]).toMatchObject({ command: { commandId: id(11) } });
  });
  it("lets a refused step be closed only after it was refused", async () => {
    const send = vi.fn().mockRejectedValueOnce(new MobileApiError("Jazda sa medzitým zmenila.", 409)).mockRejectedValueOnce(new MobileApiError("down", 503));
    const { commands } = await ready(send);
    await commands.start({ kind: "branch", id: REQUEST }, { commandId: id(13), action: "claim", requestId: REQUEST, expectedRevision: 1, payload: {} }, "Prevziať");
    expect(commands.snapshot().pending[0]).toMatchObject({ status: "rejected", message: "Jazda sa medzitým zmenila." });
    await commands.dismiss({ kind: "branch", id: REQUEST });
    expect(commands.snapshot().pending).toEqual([]);
    await commands.start({ kind: "operation", id: OP }, accept(14), "Prijať jazdu");
    await commands.dismiss({ kind: "operation", id: OP });
    expect(commands.snapshot().pending).toHaveLength(1);
  });
  it("refuses malformed or mismatched stored intents", () => {
    const base = { target: { kind: "towing", id: OP }, label: "Začať prácu", createdAt: "2026-10-28T08:00:00Z" };
    expect(parseWorkIntent({ ...base, command: { commandId: id(15), type: "start", expectedRevision: 3, assignmentGeneration: 1, payload: {} } })).toMatchObject({ label: "Začať prácu" });
    expect(() => parseWorkIntent({ ...base, command: { commandId: id(15), type: "receive_payment", expectedRevision: 3, assignmentGeneration: 1, payload: {} } })).toThrow();
    expect(parseWorkIntent({ ...base, command: { commandId: id(18), type: "abandon_attachment", expectedRevision: 3, assignmentGeneration: 1, payload: { id: id(19), reason: "Nedokončené" } } }).command)
      .toMatchObject({ type: "abandon_attachment" });
    expect(() => parseWorkIntent({ ...base, command: { commandId: id(15), type: "start", expectedRevision: 3, payload: {} } })).toThrow();
    expect(() => parseWorkIntent({ ...base, target: { kind: "branch", id: REQUEST }, command: { commandId: id(16), action: "claim", requestId: OP, expectedRevision: 1, payload: {} } })).toThrow();
    expect(() => parseWorkIntent({ ...base, target: { kind: "operation", id: OP }, command: { commandId: id(17), action: "assign", expectedRevision: 1, payload: {} } })).toThrow();
  });
});
