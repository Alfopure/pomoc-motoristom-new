import type {
  MobileBranchCommand, MobileBranchExecution, MobileBranchGroup, MobileBranchRequest, MobileBranchView, MobileBranchWorkspace, MobileDeliveryPositionInput,
  MobileOperation, MobileOperationCommand, MobileOperationEvidence, MobileTowingAttachment, MobileTowingCommand, MobileTowingFields, MobileTowingOrder,
} from "../../../src/lib/mobile-api";
import { MobileApiError, type MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";

/** Moja práca and Pobočka on the dispatch server: every answer is checked before it
 * reaches a screen; a field outside the contract makes the whole answer untrusted. */
const invalid = () => new MobileApiError("Odpoveď sa nepodarilo overiť. Obnovte údaje.", 502);
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const id = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const nullable = (v: unknown, max: number): v is string | null => v === null || text(v, max);
const date = (v: unknown): v is string => text(v, 64) && Number.isFinite(Date.parse(v));
const nullableDate = (v: unknown): v is string | null => v === null || date(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => count(v) && v >= 1;
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
}
function check(condition: unknown) { if (!condition) throw invalid(); }
function list<T>(v: unknown, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > max) throw invalid();
  return v.map(parse);
}
const one = <T extends string>(v: unknown, values: readonly T[]): T => { check(values.includes(v as T)); return v as T; };

function evidence(value: unknown): MobileOperationEvidence {
  const v = object(value);
  check(id(v.id) && date(v.observedAt) && nullable(v.person, 300) && text(v.note, 2000) && typeof v.photo === "boolean"
    && (v.odometer === null || typeof v.odometer === "number" && Number.isFinite(v.odometer)) && nullable(v.fuel, 100) && nullable(v.missingReason, 1000));
  return { id: (v.id as string).toLowerCase(), stage: one(v.stage, ["pickup", "handover", "inspection", "damage"] as const), observedAt: v.observedAt as string,
    source: one(v.source, ["observed", "reported", "exception"] as const), person: v.person as string | null, note: v.note as string, photo: v.photo as boolean,
    odometer: v.odometer as number | null, fuel: v.fuel as string | null, missingReason: v.missingReason as string | null,
    damageStatus: v.damageStatus === null ? null : one(v.damageStatus, ["open", "resolved"] as const) };
}
export function parseOperation(value: unknown): MobileOperation {
  const v = object(value);
  check(id(v.id) && positive(v.revision) && nullable(v.caseNumber, 160) && nullable(v.vehicle, 300) && text(v.from, 1000) && text(v.to, 1000)
    && nullableDate(v.scheduledAt) && nullableDate(v.plannedEndAt) && nullableDate(v.startedAt) && date(v.updatedAt) && nullable(v.instructions, 4000)
    && typeof v.vehicleConfirmed === "boolean");
  let customer: MobileOperation["customer"] = null;
  if (v.customer !== null) { const c = object(v.customer); check(text(c.name, 300) && text(c.phone, 64)); customer = { name: c.name as string, phone: c.phone as string }; }
  return { id: (v.id as string).toLowerCase(), kind: one(v.kind, ["delivery", "collection", "transfer"] as const),
    status: one(v.status, ["assigned", "accepted", "en_route", "arrived", "collected", "completed", "cancelled"] as const), revision: v.revision as number,
    caseNumber: v.caseNumber as string | null, vehicle: v.vehicle as string | null, from: v.from as string, to: v.to as string,
    scheduledAt: v.scheduledAt as string | null, plannedEndAt: v.plannedEndAt as string | null, startedAt: v.startedAt as string | null, updatedAt: v.updatedAt as string,
    customer, instructions: v.instructions as string | null, vehicleConfirmed: v.vehicleConfirmed as boolean,
    evidenceState: one(v.evidenceState, ["pending", "complete"] as const), evidence: list(v.evidence, 200, evidence) };
}
function attachment(value: unknown): MobileTowingAttachment {
  const v = object(value);
  check(id(v.id) && text(v.name, 300) && text(v.mimeType, 100) && date(v.createdAt));
  return { id: (v.id as string).toLowerCase(), kind: one(v.kind, ["work", "handover", "scan"] as const), name: v.name as string, mimeType: v.mimeType as string,
    status: one(v.status, ["pending", "ready", "abandoned"] as const), createdAt: v.createdAt as string };
}
const FIELD_TEXT = ["plate", "vin", "destination", "contact", "noContactReason", "driverNotes", "performedQuantity", "photoException", "assistanceReference", "assistancePartnerName", "parkingName", "parkingAddress"] as const;
export function parseTowingOrder(value: unknown): MobileTowingOrder {
  const v = object(value), f = object(v.fields);
  check(id(v.id) && text(v.number, 64) && positive(v.revision) && positive(v.assignmentGeneration) && date(v.updatedAt)
    && text(f.subjectDescription, 10_000) && text(f.pickup, 10_000) && nullableDate(f.plannedAt) && nullableDate(f.startedAt) && nullableDate(f.finishedAt)
    && FIELD_TEXT.every(key => nullable(f[key], 10_000)));
  let customer: MobileTowingFields["customer"] = null;
  if (f.customer !== null) { const c = object(f.customer); check(text(c.name, 2000) && nullable(c.phone, 2000)); customer = { name: c.name as string, phone: c.phone as string | null }; }
  const fields = { serviceType: one(f.serviceType, ["tow", "repair", "transport", "storage", "relocation"] as const), subjectType: one(f.subjectType, ["vehicle", "machine", "material"] as const),
    subjectDescription: f.subjectDescription as string, pickup: f.pickup as string, plannedAt: f.plannedAt as string | null, startedAt: f.startedAt as string | null,
    finishedAt: f.finishedAt as string | null, startSource: f.startSource === null ? null : one(f.startSource, ["assignment", "manual"] as const), customer,
    ...Object.fromEntries(FIELD_TEXT.map(key => [key, f[key] as string | null])) } as MobileTowingFields;
  return { id: (v.id as string).toLowerCase(), number: v.number as string, revision: v.revision as number, assignmentGeneration: v.assignmentGeneration as number,
    workStatus: one(v.workStatus, ["assigned", "in_progress", "needs_changes"] as const), updatedAt: v.updatedAt as string, fields, attachments: list(v.attachments, 60, attachment) };
}
function execution(value: unknown): MobileBranchExecution | null {
  if (value === null) return null;
  const v = object(value);
  check(text(v.status, 40) && count(v.revision) && (v.assigneeId === null || id(v.assigneeId)) && nullable(v.assignee, 300) && nullableDate(v.scheduledAt)
    && nullableDate(v.plannedEndAt) && nullableDate(v.confirmedAt) && nullableDate(v.startedAt) && nullableDate(v.finishedAt) && typeof v.done === "boolean" && typeof v.cancelled === "boolean");
  return { owner: one(v.owner, ["logistics", "towing_order"] as const), status: v.status as string, revision: v.revision as number, assigneeId: v.assigneeId as string | null,
    assignee: v.assignee as string | null, scheduledAt: v.scheduledAt as string | null, plannedEndAt: v.plannedEndAt as string | null, confirmedAt: v.confirmedAt as string | null,
    startedAt: v.startedAt as string | null, finishedAt: v.finishedAt as string | null, done: v.done as boolean, cancelled: v.cancelled as boolean };
}
export function parseBranchRequest(value: unknown): MobileBranchRequest {
  const v = object(value);
  check(id(v.id) && positive(v.revision) && id(v.groupId) && text(v.groupName, 200) && nullable(v.caseNumber, 160) && nullable(v.vehicle, 300) && text(v.pickup, 1000)
    && text(v.destination, 1000) && nullableDate(v.dueAt) && text(v.note, 4000) && date(v.routedAt) && typeof v.claimedByMe === "boolean" && nullable(v.claimedByName, 300) && nullableDate(v.claimedAt));
  let customer: MobileBranchRequest["customer"] = null;
  if (v.customer !== null) { const c = object(v.customer); check(text(c.name, 300) && text(c.phone, 64)); customer = { name: c.name as string, phone: c.phone as string }; }
  return { id: (v.id as string).toLowerCase(), kind: one(v.kind, ["delivery", "collection", "transfer", "tow"] as const), status: one(v.status, ["queued", "claimed", "assigned", "cancelled"] as const),
    revision: v.revision as number, groupId: (v.groupId as string).toLowerCase(), groupName: v.groupName as string, caseNumber: v.caseNumber as string | null, customer,
    vehicle: v.vehicle as string | null, pickup: v.pickup as string, destination: v.destination as string, dueAt: v.dueAt as string | null, note: v.note as string,
    routedAt: v.routedAt as string, claimedByMe: v.claimedByMe as boolean, claimedByName: v.claimedByName as string | null, claimedAt: v.claimedAt as string | null, execution: execution(v.execution) };
}
function group(value: unknown): MobileBranchGroup {
  const v = object(value), c = object(v.counts);
  check(id(v.id) && text(v.name, 200) && typeof v.receivesNew === "boolean" && count(c.queued) && count(c.claimed) && count(c.active) && count(c.overdue));
  return { id: (v.id as string).toLowerCase(), name: v.name as string, receivesNew: v.receivesNew as boolean,
    counts: { queued: c.queued as number, claimed: c.claimed as number, active: c.active as number, overdue: c.overdue as number },
    members: list(v.members, 200, item => { const m = object(item); check(id(m.id) && text(m.name, 300) && typeof m.canDeliver === "boolean" && typeof m.canDrive === "boolean");
      return { id: (m.id as string).toLowerCase(), name: m.name as string, role: one(m.role, ["lead", "member"] as const), canDeliver: m.canDeliver as boolean, canDrive: m.canDrive as boolean }; }) };
}

export type FieldWorkList = { operations: MobileOperation[] | null; towing: MobileTowingOrder[] | null; unavailable: ("operations" | "towing")[] };
export type BranchSnapshot = Omit<MobileBranchWorkspace, "ok" | "apiVersion" | "environment" | "memberId" | "checkedAt">;
export type FieldWorkApi = ReturnType<typeof createFieldWorkApi>;
/** `memberId` comes from the verified field identity; every answer must be for it. */
export function createFieldWorkApi(config: MobileConfig, memberId: string, getToken: () => Promise<string | null>, transport: MobileTransport = fetch,
  uploadTransport: () => Promise<MobileTransport> = async () => transport, current: () => boolean = () => true) {
  async function request(path: string, init: { method: "GET" | "POST"; body?: unknown; binary?: { bytes: Uint8Array; contentType: string }; signal?: AbortSignal; timeout?: number }) {
    if (!current()) throw new MobileApiError("Prihlásenie sa zmenilo. Otvorte svoj účet znova.", 401);
    const token = await getToken();
    if (!current()) throw new MobileApiError("Prihlásenie sa zmenilo. Otvorte svoj účet znova.", 401);
    if (!token) throw new MobileApiError("Prihlásenie vypršalo. Prihláste sa znova.", 401);
    const controller = new AbortController(), abort = () => controller.abort();
    if (init.signal?.aborted) abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, init.timeout ?? (init.binary ? 60_000 : 15_000));
    try {
      const send = init.binary ? await uploadTransport() : transport;
      const response = await send(config.apiOrigin + "/api/mobile/v1/field/" + path, {
        method: init.method, credentials: "omit", signal: controller.signal,
        ...(init.binary ? { body: init.binary.bytes as BodyInit } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, Accept: "application/json",
          ...(init.binary ? { "Content-Type": init.binary.contentType } : init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      });
      let body: unknown;
      try { body = await response.json(); } catch { throw invalid(); }
      if (!current()) throw new MobileApiError("Prihlásenie sa zmenilo. Otvorte svoj účet znova.", 401);
      const record = object(body);
      if (!response.ok) throw new MobileApiError(text(record.error, 1000) ? record.error : "Požiadavku sa nepodarilo dokončiť.", response.status, typeof record.code === "string" ? record.code : undefined);
      if (record.ok !== true || record.apiVersion !== 1 || record.environment !== config.environment || record.memberId !== memberId) throw invalid();
      return record;
    } catch (error) {
      if (error instanceof MobileApiError) throw error;
      if (init.signal?.aborted) throw error;
      throw new MobileApiError("Spojenie sa prerušilo. Výsledok overte pred ďalším krokom.", 0);
    } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
  }
  const pathId = (value: string, message: string) => { if (!id(value)) throw new MobileApiError(message, 404); return value.toLowerCase(); };
  return {
    work: async (signal?: AbortSignal): Promise<FieldWorkList> => {
      const body = await request("work", { method: "GET", signal });
      const unavailable = list(body.unavailable ?? [], 2, item => one(item, ["operations", "towing"] as const));
      return { operations: body.operations === null ? null : list(body.operations, 100, parseOperation), towing: body.towing === null ? null : list(body.towing, 100, parseTowingOrder), unavailable };
    },
    operation: async (operationId: string, signal?: AbortSignal): Promise<MobileOperation> => {
      const target = pathId(operationId, "Jazda sa nenašla.");
      const operation = parseOperation((await request("operations/" + target, { method: "GET", signal })).operation);
      check(operation.id === target);
      return operation;
    },
    operationCommand: async (operationId: string, command: MobileOperationCommand): Promise<MobileOperation> => {
      const target = pathId(operationId, "Jazda sa nenašla.");
      const body = await request("operations/" + target + "/commands", { method: "POST", body: command });
      const operation = parseOperation(body.operation);
      check(operation.id === target && body.commandId === command.commandId && positive(body.committedRevision) && operation.revision >= (body.committedRevision as number));
      return operation;
    },
    /** A JPEG/PNG/PDF for the operation's doklad; returns the private reference for the evidence command. */
    operationFile: async (operationId: string, bytes: Uint8Array, contentType: string): Promise<string> => {
      const target = pathId(operationId, "Jazda sa nenašla.");
      const body = await request("operations/" + target + "/files", { method: "POST", binary: { bytes, contentType } });
      check(text(body.reference, 200) && new RegExp("^[0-9a-f-]{36}/" + target + "/[0-9a-f-]{36}\\.(jpg|jpeg|png|webp|pdf)$").test(body.reference as string));
      return body.reference as string;
    },
    operationPosition: async (operationId: string, position: MobileDeliveryPositionInput): Promise<{ stored: boolean; active: boolean }> => {
      const body = await request("operations/" + pathId(operationId, "Jazda sa nenašla.") + "/position", { method: "POST", body: position, timeout: 10_000 });
      check(typeof body.stored === "boolean" && typeof body.active === "boolean");
      return { stored: body.stored as boolean, active: body.active as boolean };
    },
    towing: async (orderId: string, signal?: AbortSignal): Promise<MobileTowingOrder> => {
      const target = pathId(orderId, "Zákazka sa nenašla.");
      const order = parseTowingOrder((await request("towing/" + target, { method: "GET", signal })).order);
      check(order.id === target);
      return order;
    },
    /** `order` null: it left the driver's list (e.g. after Odovzdať). */
    towingCommand: async (orderId: string, command: MobileTowingCommand): Promise<{ order: MobileTowingOrder | null }> => {
      const target = pathId(orderId, "Zákazka sa nenašla.");
      const body = await request("towing/" + target + "/commands", { method: "POST", body: command });
      check(body.commandId === command.commandId && positive(body.revision));
      if (body.order === null) return { order: null };
      const order = parseTowingOrder(body.order);
      check(order.id === target);
      return { order };
    },
    /** Multipart with the form fields the server's attachment intent needs; the ids make a retry replay-safe. */
    towingAttachment: async (orderId: string, form: { bytes: Uint8Array; contentType: string }, commandId: string): Promise<{ attachmentId: string; revision: number }> => {
      const target = pathId(orderId, "Zákazka sa nenašla.");
      const body = await request("towing/" + target + "/attachments", { method: "POST", binary: form });
      check(body.commandId === commandId && id(body.attachmentId) && positive(body.revision));
      return { attachmentId: (body.attachmentId as string).toLowerCase(), revision: body.revision as number };
    },
    branch: async (view: MobileBranchView, signal?: AbortSignal): Promise<BranchSnapshot> => {
      const body = await request("branch?view=" + view, { method: "GET", signal });
      check(body.view === view && count(body.totalCount) && typeof body.canOperateTowing === "boolean");
      return { view, groups: list(body.groups, 50, group), requests: list(body.requests, 200, parseBranchRequest), totalCount: body.totalCount as number, canOperateTowing: body.canOperateTowing as boolean };
    },
    branchCommand: async (command: MobileBranchCommand): Promise<MobileBranchRequest> => {
      const body = await request("branch/commands", { method: "POST", body: command });
      const result = parseBranchRequest(body.request);
      check(body.commandId === command.commandId && positive(body.committedRevision) && result.id === command.requestId);
      return result;
    },
  };
}
