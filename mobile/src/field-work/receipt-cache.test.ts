import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { MobileFieldCash, MobileTowingOrder } from "../../../src/lib/mobile-api";
import { memoryStorage } from "../lib/session-storage";
import { WorkCommands } from "./commands";
import { newerCash, newerTowing } from "./model";
import { cacheWorkReceipt } from "./receipt-cache";
const id = (n: number) => `98000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const member = id(1), orderId = id(2), scope = ["field", "test"];
const order: MobileTowingOrder = { id: orderId, number: "OT-2", revision: 7, assignmentGeneration: 2, workStatus: "in_progress", updatedAt: "2026-11-05T08:00:00Z", attachments: [], payments: [],
  fields: { serviceType: "tow", subjectType: "vehicle", subjectDescription: "Golf", plate: null, vin: null, pickup: "A", destination: "B", contact: null, noContactReason: null,
    plannedAt: null, startedAt: null, finishedAt: null, startSource: null, driverNotes: null, performedQuantity: null, photoException: null, assistanceReference: null, assistancePartnerName: null, parkingName: null, parkingAddress: null, customer: null } };
const payment = { id: id(3), receiptId: id(4), amountCents: 1000, method: "cash" as const, createdAt: "2026-11-05T09:00:00Z" };
const before: MobileFieldCash = { account: { id: id(5), balanceCents: 0, reservedCents: 0, revision: 1 }, handovers: [] };
const after: MobileFieldCash = { account: { ...before.account!, balanceCents: 1000, revision: 2 }, handovers: [] };
function client() {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  c.setQueryDefaults([...scope, "towing", orderId], { structuralSharing: (previous, next) => newerTowing(previous as MobileTowingOrder | undefined, next as MobileTowingOrder) });
  c.setQueryDefaults([...scope, "work-cash", member], { structuralSharing: (previous, next) => newerCash(previous as MobileFieldCash | undefined, next as MobileFieldCash) });
  return c;
}
describe("acknowledged financial cache", () => {
  it("cancels a delayed prepayment GET before clearing the outbox and never erases the receipt at the same order revision", async () => {
    const c = client(), key = [...scope, "towing", orderId], cashKey = [...scope, "work-cash", member];
    c.setQueryData(key, order); c.setQueryData(cashKey, before);
    let finish!: (value: MobileTowingOrder) => void;
    const poll = c.fetchQuery({ queryKey: key, queryFn: () => new Promise<MobileTowingOrder>(resolve => { finish = resolve; }) }).catch(() => null);
    const commands = new WorkCommands(memoryStorage(), { environment: "test", apiOrigin: "https://test.dispecing.linkapomoci.sk", projectUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", userId: id(10), memberId: member }, async () => {
      const paid = { ...order, payments: [payment] };
      await cacheWorkReceipt(c, scope, member, { kind: "towing", id: orderId, order: paid, cash: after }, () => true);
      expect(c.getQueryData<MobileTowingOrder>(key)?.payments).toEqual([payment]);
      return { order: paid };
    }, { current: () => true });
    await commands.load();
    await commands.start({ kind: "towing", id: orderId }, { commandId: id(11), type: "receive_payment", expectedRevision: 7, assignmentGeneration: 2, payload: { receiptId: payment.receiptId, amountCents: 1000, method: "cash", accountRevision: 1 } }, "Prijatá platba");
    expect(commands.snapshot().pending).toEqual([]);
    finish(order); await poll;
    expect(c.getQueryData<MobileTowingOrder>(key)?.payments).toEqual([payment]);
    c.setQueryData(key, order); c.setQueryData(cashKey, before);
    expect(c.getQueryData<MobileTowingOrder>(key)?.payments).toEqual([payment]);
    expect(c.getQueryData<MobileFieldCash>(cashKey)?.account).toEqual(after.account);
    commands.dispose(); c.clear();
  });
  it("keeps confirmed handover status and reservations against older cash reads", async () => {
    const c = client(), cashKey = [...scope, "work-cash", member];
    const handover = { id: id(20), amountCents: 500, status: "pending" as const, revision: 1, createdAt: "2026-11-05T09:01:00Z" };
    const pending = { account: { ...after.account!, revision: 3, reservedCents: 500 }, handovers: [handover] };
    await cacheWorkReceipt(c, scope, member, { kind: "cash", cash: pending }, () => true);
    c.setQueryData(cashKey, after);
    expect(c.getQueryData(cashKey)).toEqual(pending);
    const accepted = { account: { ...after.account!, revision: 4, balanceCents: 500 }, handovers: [{ ...handover, status: "accepted" as const, revision: 2 }] };
    c.setQueryData(cashKey, accepted); c.setQueryData(cashKey, pending);
    expect(c.getQueryData(cashKey)).toEqual(accepted); c.clear();
  });
  it("does not install another account's late receipt and resets receipt knowledge on a new assignment", async () => {
    const c = client();
    await expect(cacheWorkReceipt(c, scope, member, { kind: "cash", cash: after }, () => false)).rejects.toMatchObject({ status: 401 });
    expect(c.getQueryData([...scope, "work-cash", member])).toBeUndefined();
    expect(newerTowing({ ...order, payments: [payment] }, { ...order, revision: 8, assignmentGeneration: 3 }).payments).toEqual([]);
    expect(newerTowing({ ...order, revision: 8, assignmentGeneration: 3, payments: [] }, { ...order, payments: [payment] }).assignmentGeneration).toBe(3);
    expect(newerTowing({ ...order, revision: 8, payments: [] }, { ...order, payments: [payment] }).payments).toEqual([payment]); c.clear();
  });
});
