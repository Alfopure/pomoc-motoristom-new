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
