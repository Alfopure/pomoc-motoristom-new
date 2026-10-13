import { afterEach, describe, expect, it, vi } from "vitest";
import { towingClient, TowingRequestError, deliveryStatus } from "./client";
const command = { commandId: "11111111-1111-4111-8111-111111111111", targetId: "22222222-2222-4222-8222-222222222222", type: "create_order" as const, payload: {} };
afterEach(() => vi.unstubAllGlobals());
describe("towing server acknowledgements", () => {
  it("reads persisted nested delivery status and leaves missing acceptance unconfirmed", () => {
    expect(deliveryStatus({ result: { delivery: { status: "unknown" } } })).toBe("unknown");
    expect(deliveryStatus({ delivery: { status: "failed" } })).toBe("failed");
    expect(deliveryStatus({ result: { delivery: { status: "accepted" } } })).toBe("accepted");
    expect(deliveryStatus({ ok: true })).toBeUndefined();
  });
  it("rejects HTTP success that does not acknowledge the exact intended command", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...command, commandId: "different", revision: 1 })));
    await expect(towingClient.command(command)).rejects.toMatchObject({ code: "unconfirmed_ack", status: 0 });
  });
  it("keeps a lost reply unconfirmed instead of claiming a server rejection or success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network lost")));
    await expect(towingClient.command(command)).rejects.toBeInstanceOf(TowingRequestError);
    await expect(towingClient.command(command)).rejects.toMatchObject({ status: 0 });
  });
  it("exposes revision conflict and accepts only a matching complete acknowledgement", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: "Údaje sa zmenili", code: "revision_conflict" }, { status: 409 })).mockResolvedValueOnce(Response.json({ commandId: command.commandId, targetId: command.targetId, revision: 1 }));
    vi.stubGlobal("fetch", fetch);
    await expect(towingClient.command(command)).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
    await expect(towingClient.command(command)).resolves.toMatchObject({ commandId: command.commandId, revision: 1 });
  });
});
