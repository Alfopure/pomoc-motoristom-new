import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: m.rpc }),
}));
vi.mock("./case-handoff", () => ({
  handoffSession: m.session,
  getCaseHandoffContext: vi.fn(),
}));
vi.mock("./mobile/push-outbox", () => ({ queueWorkPush: m.push }));
import { commandCaseWork, parseCaseWork } from "./case-work";
import { isCaseWorkReceipt } from "@/domain/case-work";
const id = (n: number) =>
  `72000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (n = 1) => ({
  commandId: id(n),
  kind: "delivery",
  target: { type: "person", id: id(50) },
  pickup: "Žilina",
  destination: "Servis",
  instructions: "Iba pre túto prácu",
  scheduledAt: null,
  plannedEndAt: null,
  fleetAssetId: null,
  cycleId: null,
  branchId: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  m.session.mockResolvedValue({
    actor: { userId: id(90), organizationId: id(91) },
  });
});
describe("independent case work", () => {
  it("one invalid item does not lock other valid items or discard their receipts", async () => {
    m.rpc.mockResolvedValue({
      data: {
        commandId: id(1),
        kind: "delivery",
        owner: "logistics",
        id: id(71),
        status: "assigned",
      },
      error: null,
    });
    const result = await commandCaseWork(id(80), {
      items: [
        item(),
        {
          ...item(2),
          scheduledAt: "2026-11-05T12:00:00Z",
          plannedEndAt: "2026-11-05T11:00:00Z",
        },
      ],
    });
    expect(result.results[0]).toHaveProperty("receipt");
    expect(result.results[1]).toMatchObject({ commandId: id(2), status: 400 });
    expect(m.rpc).toHaveBeenCalledOnce();
  });
  it("rejects invalid calendar dates rather than shifting their day", () =>
    expect(() =>
      parseCaseWork({
        items: [{ ...item(), scheduledAt: "2026-02-30T10:00:00Z" }],
      }),
    ).toThrow());

  it("bounds the batch and refuses duplicate command IDs and authority fields", () => {
    for (const input of [
      { items: [] },
      { items: Array.from({ length: 13 }, () => item()) },
      { items: [item(), item()] },
      { items: [{ ...item(), organizationId: id(2) }] },
    ])
      expect(() => parseCaseWork(input)).toThrow();
  });
  it("requires pickup, collection cycle and a real end after start", () => {
    for (const change of [
      { pickup: " " },
      { kind: "collection" },
      { scheduledAt: null, plannedEndAt: "2026-11-05T13:00:00Z" },
      { scheduledAt: "wrong" },
    ])
      expect(() =>
        parseCaseWork({ items: [{ ...item(), ...change }] }),
      ).toThrow();
  });
  it("preserves distinct notes and recipient identities", () => {
    const rows = parseCaseWork({
      items: [
        item(),
        {
          ...item(2),
          kind: "tow",
          target: { type: "branch", id: id(60) },
          instructions: "Druhý pokyn",
        },
      ],
    });
    expect(rows.map((i) => i.instructions)).toEqual([
      "Iba pre túto prácu",
      "Druhý pokyn",
    ]);
  });
  it("validates each server receipt against the original intent", () => {
    const i = parseCaseWork({ items: [item()] })[0];
    expect(
      isCaseWorkReceipt(
        {
          commandId: i.commandId,
          kind: "delivery",
          owner: "branch",
          id: id(3),
          status: "assigned",
        },
        i,
      ),
    ).toBe(false);
  });
  it("rejects malformed IDs and unexpected states as unconfirmed", () => {
    const i = parseCaseWork({ items: [item()] })[0];
    for (const change of [{ id: "-".repeat(36) }, { status: "done" }])
      expect(
        isCaseWorkReceipt(
          {
            commandId: i.commandId,
            kind: "delivery",
            owner: "logistics",
            id: id(3),
            status: "assigned",
            ...change,
          },
          i,
        ),
      ).toBe(false);
  });
  it("retains a successful first item when a second RPC fails, and retry uses the original item", async () => {
    m.rpc
      .mockResolvedValueOnce({
        data: {
          commandId: id(1),
          kind: "delivery",
          owner: "logistics",
          id: id(71),
          status: "assigned",
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { code: "22023" } });
    const result = await commandCaseWork(id(80), { items: [item(), item(2)] });
    expect(result.results[0]).toHaveProperty("receipt.id", id(71));
    expect(result.results[1]).toMatchObject({ commandId: id(2), status: 400 });
    expect(m.rpc.mock.calls.map((c) => c[1].p_item.commandId)).toEqual([
      id(1),
      id(2),
    ]);
    expect(m.push).toHaveBeenCalledOnce();
  });
  it("does not trust malformed receipts as a successful handoff", async () => {
    m.rpc.mockResolvedValue({ data: { commandId: id(1) }, error: null });
    expect(
      (await commandCaseWork(id(80), { items: [item()] })).results[0],
    ).toMatchObject({ status: 503 });
    expect(m.push).not.toHaveBeenCalled();
  });
});
