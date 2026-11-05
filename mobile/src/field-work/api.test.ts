import { describe, expect, it, vi } from "vitest";
import type { MobileTransport } from "../lib/api";
import { createFieldWorkApi } from "./api";

const id = (n: number) => `97000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1), MEMBER = id(2), OP = id(3), ORDER = id(4), CMD = id(5), REQUEST = id(6), GROUP = id(7);
const at = "2026-10-28T08:00:00+00:00";
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "unused" };
const scope = { ok: true, apiVersion: 1, environment: "test", memberId: MEMBER, checkedAt: at };
const operation = { id: OP, kind: "delivery", status: "accepted", revision: 4, caseNumber: "PM-1", vehicle: "Golf", from: "A", to: "B", scheduledAt: at, plannedEndAt: null, startedAt: null,
  updatedAt: at, customer: { name: "Klient", phone: "+421900000000" }, instructions: null, vehicleConfirmed: true, evidenceState: "pending",
  evidence: [{ id: id(8), stage: "pickup", observedAt: at, source: "observed", person: "Ján", note: "", photo: true, odometer: 100, fuel: "1/2", missingReason: null, damageStatus: null }] };
const order = { id: ORDER, number: "OT-1", revision: 3, assignmentGeneration: 1, workStatus: "in_progress", updatedAt: at, attachments: [],
  fields: { serviceType: "tow", subjectType: "vehicle", subjectDescription: "Octavia", pickup: "D1", destination: null, plate: null, vin: null, contact: null, noContactReason: null,
    plannedAt: null, startedAt: at, finishedAt: null, startSource: "manual", driverNotes: null, performedQuantity: null, photoException: null, assistanceReference: null,
    assistancePartnerName: null, parkingName: null, parkingAddress: null, customer: null } };
const request = { id: REQUEST, kind: "delivery", status: "queued", revision: 2, groupId: GROUP, groupName: "Žilina", caseNumber: null, customer: null, vehicle: null, pickup: "A", destination: "B",
  dueAt: null, note: "", routedAt: at, claimedByMe: false, claimedByName: null, claimedAt: null, execution: null };
function api(reply: (url: string, init: RequestInit) => unknown, status = 200) {
  const transport = vi.fn<MobileTransport>(async (url, init) => Response.json(reply(url, init), { status }));
  return { transport, client: createFieldWorkApi(config, MEMBER, async () => "jwt", transport, async () => transport) };
}

describe("field work API", () => {
  it("accepts older operation contracts and separates assistance from the internal number", async () => {
    await expect(api(() => ({ ...scope, operation })).client.operation(OP)).resolves.not.toHaveProperty("assistance");
    await expect(api(() => ({ ...scope, operation: { ...operation, assistance: { name: "Asistencia", reference: "AS-42" } } })).client.operation(OP))
      .resolves.toMatchObject({ caseNumber: "PM-1", assistance: { name: "Asistencia", reference: "AS-42" } });
    await expect(api(() => ({ ...scope, operation: { ...operation, assistance: { name: 42, reference: null } } })).client.operation(OP)).rejects.toMatchObject({ status: 502 });
  });
  it("validates physical blockers and rejects malformed or scheduled blocker links", async () => {
    const conflict = { kind: "physical", blocker: { kind: "towing", id: ORDER, number: "OT-1" } };
    await expect(api(() => ({ ok: false, error: "Dokončite inú prácu", code: "work_refused", conflict }), 409).client.operationCommand(OP, { commandId: CMD, action: "start", expectedRevision: 4, payload: {} }))
      .rejects.toMatchObject({ status: 409, code: "work_refused", conflict });
    for (const bad of [{ ...conflict, kind: "schedule" }, { ...conflict, blocker: { ...conflict.blocker, id: "../secret" } }]) {
      await expect(api(() => ({ ok: false, conflict: bad }), 409).client.operationCommand(OP, { commandId: CMD, action: "start", expectedRevision: 4, payload: {} }))
        .rejects.toMatchObject({ status: 502 });
    }
  });
  it("projects optional requester and dispatch instructions without accepting malformed values", async () => {
    const fields = { ...order.fields, requesterName: "Asistencia", dispatchInstructions: "Kľúče na recepcii" };
    await expect(api(() => ({ ...scope, order: { ...order, fields } })).client.towing(ORDER)).resolves.toMatchObject({ fields: { requesterName: "Asistencia", dispatchInstructions: "Kľúče na recepcii" } });
    await expect(api(() => ({ ...scope, order: { ...order, fields: { ...fields, dispatchInstructions: "x".repeat(4001) } } })).client.towing(ORDER)).rejects.toMatchObject({ status: 502 });
  });
  it("validates own cash and confirms proposals for the same immutable command", async () => {
    const cash = { account: { id: id(40), balanceCents: 12000, reservedCents: 2000, revision: 4 }, handovers: [] };
    await expect(api(() => ({ ...scope, cash })).client.cash()).resolves.toEqual(cash);
    const command = { commandId: CMD, handoverId: id(41), type: "propose_handover" as const, expectedRevision: 0 as const, payload: { amountCents: 1000, accountRevision: 4 } };
    const proposal = api(() => ({ ...scope, commandId: CMD, revision: 1, cash }));
    await expect(proposal.client.cashCommand(command)).resolves.toEqual(cash);
    expect(JSON.parse(String(proposal.transport.mock.calls[0][1].body))).toEqual(command);
    await expect(api(() => ({ ...scope, commandId: id(99), revision: 1, cash })).client.cashCommand(command)).rejects.toMatchObject({ status: 502 });
    await expect(api(() => ({ ...scope, cash: { ...cash, account: { ...cash.account, balanceCents: 1.25 } } })).client.cash()).rejects.toMatchObject({ status: 502 });
  });
  it("checks structured work and exact own receipts, without turning payment intent into money", async () => {
    const fields = { ...order.fields, paymentIntent: "cash_terminal", odometer: "12345", owner: { name: "Ján", companyId: "123", address: "Adresa" }, realizedItems: [
      { id: id(42), kind: "transport", description: "Prevoz", quantity: "10.5", unit: "km", destination: "Servis" },
    ] };
    const payment = { id: id(43), receiptId: id(44), amountCents: 1234, method: "card", createdAt: at };
    await expect(api(() => ({ ...scope, order: { ...order, fields, payments: [], authorizedCollectionCents: 15000, dueCents: 16000 } })).client.towing(ORDER))
      .resolves.toMatchObject({ fields, payments: [], authorizedCollectionCents: 15000, dueCents: 16000 });
    await expect(api(() => ({ ...scope, order: { ...order, fields, payments: [payment] } })).client.towing(ORDER)).resolves.toMatchObject({ payments: [payment] });
    await expect(api(() => ({ ...scope, order: { ...order, payments: [{ ...payment, amountCents: 12.34 }] } })).client.towing(ORDER)).rejects.toMatchObject({ status: 502 });
    await expect(api(() => ({ ...scope, order: { ...order, fields: { ...fields, realizedItems: [fields.realizedItems[0], fields.realizedItems[0]] } } })).client.towing(ORDER)).rejects.toMatchObject({ status: 502 });
  });
  it("reads own work and checks the whole contract", async () => {
    const { client, transport } = api(() => ({ ...scope, operations: [operation], towing: null, unavailable: [] }));
    await expect(client.work()).resolves.toMatchObject({ operations: [{ id: OP, customer: { name: "Klient" } }], towing: null, unavailable: [] });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://test.dispecing.linkapomoci.sk/api/mobile/v1/field/work");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer jwt");
    expect(new Headers(init.headers).get("x-pm-app-environment")).toBe("test");
    for (const bad of [{ memberId: id(99) }, { environment: "production" }, { operations: [{ ...operation, status: "draft" }] }, { operations: [{ ...operation, evidence: [{ ...operation.evidence[0], stage: "x" }] }] }]) {
      await expect(api(() => ({ ...scope, operations: [operation], towing: null, unavailable: [], ...bad })).client.work()).rejects.toMatchObject({ status: 502 });
    }
  });
  it("keeps the server's refusal and a lost connection apart", async () => {
    await expect(api(() => ({ ok: false, error: "Jazda vám už nie je pridelená.", code: "work_refused" }), 403).client.operation(OP)).rejects.toMatchObject({ status: 403, message: "Jazda vám už nie je pridelená." });
    const offline = createFieldWorkApi(config, MEMBER, async () => "jwt", async () => { throw new TypeError("offline"); });
    await expect(offline.operation(OP)).rejects.toMatchObject({ status: 0 });
    await expect(offline.operation("../me")).rejects.toMatchObject({ status: 404 });
  });
  it("confirms a step only for the same command and a fresh revision", async () => {
    const command = { commandId: CMD, action: "start" as const, expectedRevision: 4, payload: {} };
    await expect(api(() => ({ ...scope, commandId: CMD, committedRevision: 5, operation: { ...operation, revision: 5 } })).client.operationCommand(OP, command)).resolves.toMatchObject({ revision: 5 });
    await expect(api(() => ({ ...scope, commandId: id(9), committedRevision: 5, operation: { ...operation, revision: 5 } })).client.operationCommand(OP, command)).rejects.toMatchObject({ status: 502 });
    await expect(api(() => ({ ...scope, commandId: CMD, committedRevision: 6, operation: { ...operation, revision: 5 } })).client.operationCommand(OP, command)).rejects.toMatchObject({ status: 502 });
  });
  it("uploads evidence bytes with their type and accepts only this operation's reference", async () => {
    const reference = `${ORG}/${OP}/${id(10)}.jpg`;
    const { client, transport } = api(() => ({ ...scope, reference }));
    await expect(client.operationFile(OP, new Uint8Array([255, 216, 255]), "image/jpeg")).resolves.toBe(reference);
    expect(new Headers(transport.mock.calls[0][1].headers).get("content-type")).toBe("image/jpeg");
    await expect(api(() => ({ ...scope, reference: `${ORG}/${id(11)}/${id(10)}.jpg` })).client.operationFile(OP, new Uint8Array([1]), "image/jpeg")).rejects.toMatchObject({ status: 502 });
  });
  it("gets and revokes the operation's background secret with the sign-in session", async () => {
    const { client, transport } = api(() => ({ ...scope, token: "t".repeat(43), expiresAt: "2026-11-05T08:00:00.000Z" }));
    await expect(client.operationTracker(OP)).resolves.toEqual({ token: "t".repeat(43), expiresAt: "2026-11-05T08:00:00.000Z" });
    expect(transport.mock.calls[0][0]).toBe(`https://test.dispecing.linkapomoci.sk/api/mobile/v1/field/operations/${OP}/tracker`);
    expect(transport.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "omit" });
    await expect(api(() => ({ ...scope, token: "short", expiresAt: at })).client.operationTracker(OP)).rejects.toMatchObject({ status: 502 });
    const revoke = api(() => ({ ...scope, revoked: true }));
    await revoke.client.operationUntrack(OP);
    expect(revoke.transport.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
    await revoke.client.operationUntrack("../me");
    expect(revoke.transport).toHaveBeenCalledTimes(1);
  });
  it("reads towing orders and tells a handed-over order apart", async () => {
    await expect(api(() => ({ ...scope, order })).client.towing(ORDER)).resolves.toMatchObject({ number: "OT-1", fields: { pickup: "D1" } });
    const command = { commandId: CMD, type: "submit" as const, expectedRevision: 3, assignmentGeneration: 1, payload: {} };
    await expect(api(() => ({ ...scope, commandId: CMD, revision: 4, order: null })).client.towingCommand(ORDER, command)).resolves.toEqual({ order: null });
    await expect(api(() => ({ ...scope, order: { ...order, fields: { ...order.fields, serviceType: "cash" } } })).client.towing(ORDER)).rejects.toMatchObject({ status: 502 });
  });
  it("reads the branch and checks its command receipt", async () => {
    const group = { id: GROUP, name: "Žilina", receivesNew: true, counts: { queued: 1, claimed: 0, active: 0, overdue: 0 }, members: [{ id: MEMBER, name: "Ja", role: "lead", canDeliver: true, canDrive: false }] };
    const { client, transport } = api(() => ({ ...scope, view: "open", groups: [group], requests: [request], totalCount: 1, canOperateTowing: false }));
    await expect(client.branch("open")).resolves.toMatchObject({ groups: [{ id: GROUP }], requests: [{ id: REQUEST, status: "queued" }] });
    expect(transport.mock.calls[0][0]).toBe("https://test.dispecing.linkapomoci.sk/api/mobile/v1/field/branch?view=open");
    const command = { commandId: CMD, action: "claim" as const, requestId: REQUEST, expectedRevision: 2, payload: {} };
    await expect(api(() => ({ ...scope, commandId: CMD, committedRevision: 3, request: { ...request, status: "claimed", revision: 3, claimedByMe: true } })).client.branchCommand(command))
      .resolves.toMatchObject({ status: "claimed", claimedByMe: true });
    await expect(api(() => ({ ...scope, commandId: CMD, committedRevision: 3, request: { ...request, id: id(12) } })).client.branchCommand(command)).rejects.toMatchObject({ status: 502 });
  });
});
