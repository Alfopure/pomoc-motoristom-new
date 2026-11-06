import type { TowingCreateInput } from "../../../src/domain/towing/creation";
import type { TowingCommand, TowingFields, TowingOrder, TowingWorkspace } from "../../../src/domain/towing/types";
import { CASH_CATEGORIES, isCashCategory, isCashBreakdown, cashBreakdownTotal, isCashCategories } from "../../../src/domain/towing/cash-categories";
import type {
  MobileBranchCommand, MobileBranchExecution, MobileBranchGroup, MobileBranchRequest, MobileBranchView, MobileBranchWorkspace, MobileDeliveryPositionInput,
  MobileFieldTowingOptions, MobileFieldCash, MobileFieldCashCommand, MobileTowingOwner, MobileTowingRealizedItem, MobileWorkConflict, MobileOperation, MobileOperationCommand, MobileOperationEvidence, MobileTowingAttachment, MobileTowingCommand, MobileTowingFields, MobileTowingOrder,
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

/** Conflict metadata is checked as strictly as successful work projections. */
export class FieldWorkConflictError extends MobileApiError {
  constructor(message: string, code: string | undefined, readonly conflict: MobileWorkConflict) { super(message, 409, code); }
}
function parseConflict(value: unknown): MobileWorkConflict {
  const v = object(value), kind = one(v.kind, ["physical", "schedule"] as const);
  if (v.blocker === null) return { kind, blocker: null };
  const b = object(v.blocker);
  check(kind === "physical" && id(b.id) && nullable(b.number, 160));
  return { kind, blocker: { kind: one(b.kind, ["operation", "towing"] as const), id: (b.id as string).toLowerCase(), number: b.number as string | null } };
}
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
  let assistance: MobileOperation["assistance"];
  if (v.assistance !== undefined) {
    if (v.assistance === null) assistance = null;
    else { const a = object(v.assistance); check(nullable(a.name, 300) && nullable(a.reference, 300)); assistance = { name: a.name as string | null, reference: a.reference as string | null }; }
  }
  return { ...(assistance !== undefined ? { assistance } : {}), id: (v.id as string).toLowerCase(), kind: one(v.kind, ["delivery", "collection", "transfer"] as const),
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
function parseRealizedItems(value: unknown): MobileTowingRealizedItem[] {
  const ids = new Set<string>();
  return list(value, 50, raw => {
    const v = object(raw);
    check(id(v.id) && !ids.has(v.id.toLowerCase()) && text(v.description, 2000) && text(v.quantity, 20) && (v.quantity === "" || /^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(v.quantity)) && text(v.unit, 40));
    ids.add((v.id as string).toLowerCase());
    const item: MobileTowingRealizedItem = { id: v.id as string, kind: one(v.kind, ["tow", "repair", "transport", "storage", "relocation"] as const), description: v.description as string, quantity: v.quantity as string, unit: v.unit as string };
    for (const key of ["parkingId", "parkingName", "parkingAddress", "destination"] as const) {
      if (v[key] === undefined) continue;
      check(text(v[key], 2000) && (key !== "parkingId" || id(v[key]))); item[key] = v[key] as string;
    }
    return item;
  });
}
function parseOwner(value: unknown): MobileTowingOwner | null {
  if (value === null) return null;
  const v = object(value); check(text(v.name, 2000));
  const result: MobileTowingOwner = { name: v.name as string };
  for (const key of ["phone", "email", "address", "companyId"] as const) { if (v[key] === undefined) continue; check(text(v[key], 2000)); result[key] = v[key] as string; }
  return result;
}
function cashCategory(value: unknown) { if (!isCashCategory(value)) throw invalid(); return value; }
function cashSplit(value: unknown, total: number) { if (!isCashBreakdown(value) || cashBreakdownTotal(value) !== total) throw invalid(); return value; }
function cashCategories(value: unknown, balance: number, reserved: number) {
  if (!isCashCategories(value) || CASH_CATEGORIES.reduce((sum, key) => sum + value[key].balanceCents, 0) !== balance || CASH_CATEGORIES.reduce((sum, key) => sum + value[key].reservedCents, 0) !== reserved) throw invalid(); return value;
}
function parseCash(value: unknown): MobileFieldCash {
  const v = object(value); let account: MobileFieldCash["account"] = null;
  if (v.account !== null) { const a = object(v.account); check(id(a.id) && Number.isSafeInteger(a.balanceCents) && count(a.reservedCents) && positive(a.revision)); account = { id: a.id as string, balanceCents: a.balanceCents as number, reservedCents: a.reservedCents as number, revision: a.revision as number, ...(a.categories === undefined ? {} : { categories: cashCategories(a.categories, a.balanceCents as number, a.reservedCents as number) }) }; }
  return { account, handovers: list(v.handovers, 100, raw => { const h = object(raw); check(id(h.id) && positive(h.amountCents) && positive(h.revision) && date(h.createdAt));
    return { id: h.id as string, amountCents: h.amountCents as number, revision: h.revision as number, createdAt: h.createdAt as string, ...(h.cashBreakdown === undefined ? {} : { cashBreakdown: cashSplit(h.cashBreakdown, h.amountCents as number) }), status: one(h.status, ["pending", "accepted", "rejected", "cancelled"] as const) }; }) };
}
const FIELD_TEXT = ["plate", "vin", "destination", "contact", "noContactReason", "driverNotes", "performedQuantity", "photoException", "assistanceReference", "assistancePartnerName", "parkingName", "parkingAddress"] as const;
export function parseTowingOrder(value: unknown): MobileTowingOrder {
  const v = object(value), f = object(v.fields);
  check(id(v.id) && text(v.number, 64) && positive(v.revision) && positive(v.assignmentGeneration) && date(v.updatedAt)
    && text(f.subjectDescription, 10_000) && text(f.pickup, 10_000) && nullableDate(f.plannedAt) && nullableDate(f.startedAt) && nullableDate(f.finishedAt)
    && FIELD_TEXT.every(key => nullable(f[key], 10_000)));
  check((f.requesterName === undefined || nullable(f.requesterName, 300)) && (f.dispatchInstructions === undefined || nullable(f.dispatchInstructions, 4000)));
  let customer: MobileTowingFields["customer"] = null;
  if (f.customer !== null) { const c = object(f.customer); check(text(c.name, 2000) && nullable(c.phone, 2000)); customer = { name: c.name as string, phone: c.phone as string | null }; }
  check((f.odometer === undefined || nullable(f.odometer, 100)) && (f.handoverRecipientName === undefined || nullable(f.handoverRecipientName, 300))
    && (f.handedOverAt === undefined || nullableDate(f.handedOverAt)) && (f.handoverException === undefined || nullable(f.handoverException, 4000)));
  const references: Partial<MobileTowingFields> = {};
  for (const key of ["branchId", "fleetAssetId", "requesterId", "assistancePartnerId", "parkingId"] as const) {
    if (f[key] !== undefined) { check(f[key] === null || id(f[key])); references[key] = f[key] as string | null; }
  }
  if (f.requesterType !== undefined) references.requesterType = f.requesterType === null ? null : one(f.requesterType, ["assistance", "selfpayer"] as const);
  if (f.requester !== undefined) references.requester = parseOwner(f.requester);
  if (f.recipient !== undefined) references.recipient = parseOwner(f.recipient);
  const fields = { ...references,
    ...(f.odometer !== undefined ? { odometer: f.odometer as string | null } : {}),
    ...(f.paymentIntent !== undefined ? { paymentIntent: f.paymentIntent === null ? null : one(f.paymentIntent, ["partner_invoice", "deferred_invoice", "card_terminal", "cash_terminal", "cash_other"] as const) } : {}),
    ...(f.realizedItems !== undefined ? { realizedItems: parseRealizedItems(f.realizedItems) } : {}),
    ...(f.owner !== undefined ? { owner: parseOwner(f.owner) } : {}),
    ...(f.handoverRecipientName !== undefined ? { handoverRecipientName: f.handoverRecipientName as string | null } : {}),
    ...(f.handedOverAt !== undefined ? { handedOverAt: f.handedOverAt as string | null } : {}),
    ...(f.handoverException !== undefined ? { handoverException: f.handoverException as string | null } : {}),
    ...(f.requesterName !== undefined ? { requesterName: f.requesterName as string | null } : {}),
    ...(f.dispatchInstructions !== undefined ? { dispatchInstructions: f.dispatchInstructions as string | null } : {}), serviceType: one(f.serviceType, ["tow", "repair", "transport", "storage", "relocation"] as const), subjectType: one(f.subjectType, ["vehicle", "machine", "material"] as const),
    subjectDescription: f.subjectDescription as string, pickup: f.pickup as string, plannedAt: f.plannedAt as string | null, startedAt: f.startedAt as string | null,
    finishedAt: f.finishedAt as string | null, startSource: f.startSource === null ? null : one(f.startSource, ["assignment", "manual"] as const), customer,
    ...Object.fromEntries(FIELD_TEXT.map(key => [key, f[key] as string | null])) } as MobileTowingFields;
  check((v.authorizedCollectionCents === undefined || v.authorizedCollectionCents === null || count(v.authorizedCollectionCents)) && (v.dueCents === undefined || v.dueCents === null || count(v.dueCents)));
  const payments = v.payments === undefined ? undefined : list(v.payments, 100, raw => { const p = object(raw); check(id(p.id) && id(p.receiptId) && Number.isSafeInteger(p.amountCents) && date(p.createdAt));
    return { id: p.id as string, receiptId: p.receiptId as string, amountCents: p.amountCents as number, method: one(p.method, ["cash", "card", "bank", "other"] as const), ...(p.cashCategory === undefined ? {} : { cashCategory: p.cashCategory === null ? null : cashCategory(p.cashCategory) }), createdAt: p.createdAt as string }; });
  return { ...(v.authorizedCollectionCents !== undefined ? { authorizedCollectionCents: v.authorizedCollectionCents as number | null } : {}),
    ...(v.dueCents !== undefined ? { dueCents: v.dueCents as number | null } : {}), ...(payments !== undefined ? { payments } : {}), id: (v.id as string).toLowerCase(), number: v.number as string, revision: v.revision as number, assignmentGeneration: v.assignmentGeneration as number,
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
  let assistance: MobileOperation["assistance"];
  if (v.assistance !== undefined) {
    if (v.assistance === null) assistance = null;
    else { const a = object(v.assistance); check(nullable(a.name, 300) && nullable(a.reference, 300)); assistance = { name: a.name as string | null, reference: a.reference as string | null }; }
  }
  return { ...(assistance !== undefined ? { assistance } : {}), id: (v.id as string).toLowerCase(), kind: one(v.kind, ["delivery", "collection", "transfer", "tow"] as const), status: one(v.status, ["queued", "claimed", "assigned", "cancelled"] as const),
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
/** Office projections remain separate from the own-assignment driver projection. */
function parseOfficeOrder(value: unknown): TowingOrder {
  const v = object(value), f = object(v.fields);
  check(id(v.id) && text(v.number, 160) && positive(v.revision) && count(v.assignmentGeneration)
    && (v.driverId === null || id(v.driverId)) && date(v.createdAt) && date(v.updatedAt));
  one(v.workStatus, ["draft", "assigned", "in_progress", "submitted", "needs_changes", "cancelled"] as const);
  one(v.billingStatus, ["not_ready", "ready", "invoiced", "not_required"] as const);
  one(v.paymentStatus, ["unpriced", "unpaid", "partial", "paid", "overpaid"] as const);
  one(f.serviceType, ["tow", "repair", "transport", "storage", "relocation"] as const);
  one(f.subjectType, ["vehicle", "machine", "material"] as const);
  check(text(f.subjectDescription, 10000) && text(f.pickup, 10000));
  for (const key of ["destination", "contact", "noContactReason", "plate", "vin", "driverNotes", "dispatchInstructions", "photoException", "assistanceReference", "handoverRecipientName", "handoverException"])
    check(f[key] === undefined || text(f[key], 10000));
  for (const key of ["plannedAt", "startedAt", "finishedAt", "handedOverAt"]) check(f[key] === undefined || date(f[key]));
  for (const key of ["owner", "requester", "customer", "recipient"]) {
    if (f[key] === undefined) continue;
    const party = object(f[key]); check(text(party.name, 2000));
    for (const field of ["phone", "email", "address", "companyId", "taxId"]) check(party[field] === undefined || text(party[field], 2000));
  }
  if (f.realizedItems !== undefined) parseRealizedItems(f.realizedItems);
  check((v.authorizedCollectionCents === null || count(v.authorizedCollectionCents)) && (v.dueCents === null || Number.isSafeInteger(v.dueCents)) && Number.isSafeInteger(v.receivedCents));
  check(Array.isArray(v.attachments) && v.attachments.length <= 1000);
  return { ...v, fields: f as unknown as TowingFields } as unknown as TowingOrder;
}
function parseOfficeWorkspace(value: unknown, memberId: string): TowingWorkspace {
  const v = object(value), actor = object(v.actor);
  check(v.view === "office" && actor.id === memberId && actor.active === true && id(actor.organizationId) && text(actor.displayName, 300)
    && Array.isArray(actor.capabilities) && actor.capabilities.every(item => typeof item === "string") && actor.capabilities.includes("operate"));
  const orders = list(v.orders, 50, parseOfficeOrder);
  for (const key of ["members", "branches", "fleet"]) check(Array.isArray(v[key]) && (v[key] as unknown[]).length <= 3000);
  for (const member of v.members as unknown[]) { const m = object(member); check(id(m.id) && text(m.displayName, 300) && Array.isArray(m.capabilities)); }
  for (const key of ["branches", "fleet"]) for (const raw of v[key] as unknown[]) { const item = object(raw); check(id(item.id) && text(item.name, 2000)); }
  const cashAccounts = list(v.cashAccounts, 2000, raw => {
    const account = object(raw); check(id(account.id) && (account.driverId === null || id(account.driverId)) && Number.isSafeInteger(account.balanceCents) && count(account.reservedCents) && positive(account.revision));
    return { ...account, ...(account.categories === undefined ? {} : { categories: cashCategories(account.categories, account.balanceCents as number, account.reservedCents as number) }) };
  });
  const handovers = list(v.handovers, 2000, raw => {
    const handover = object(raw); check(id(handover.id) && id(handover.driverId) && positive(handover.amountCents) && positive(handover.revision) && date(handover.createdAt));
    one(handover.status, ["pending", "accepted", "rejected", "cancelled"] as const);
    return { ...handover, ...(handover.cashBreakdown === undefined ? {} : { cashBreakdown: cashSplit(handover.cashBreakdown, handover.amountCents as number) }) };
  });
  return { ...v, orders, cashAccounts, handovers } as unknown as TowingWorkspace;
}

export type FieldWorkApi = ReturnType<typeof createFieldWorkApi>;
/** `memberId` comes from the verified field identity; every answer must be for it. */
export function createFieldWorkApi(config: MobileConfig, memberId: string, getToken: () => Promise<string | null>, transport: MobileTransport = fetch,
  uploadTransport: () => Promise<MobileTransport> = async () => transport, current: () => boolean = () => true) {
  async function request(path: string, init: { method: "GET" | "POST" | "DELETE"; body?: unknown; binary?: { bytes: Uint8Array; contentType: string }; signal?: AbortSignal; timeout?: number }) {
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
      if (!response.ok && response.status === 409 && record.conflict !== undefined) throw new FieldWorkConflictError(
        text(record.error, 1000) ? record.error : "Prácu blokuje iná jazda.", typeof record.code === "string" ? record.code : undefined, parseConflict(record.conflict));
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
    towingOfficeUrl: (orderId: string) => config.apiOrigin + "/zakazky?orderId=" + pathId(orderId, "Odťah sa nenašiel."),
    towingOptions: async (signal?: AbortSignal): Promise<MobileFieldTowingOptions> => {
      const body = await request("towing/options", { method: "GET", signal });
      const references = (value: unknown, max: number) => list(value, max, raw => { const item = object(raw); check(id(item.id) && text(item.name, 2000)); return { id: item.id as string, name: item.name as string }; });
      const fleet = body.fleet === undefined ? undefined : list(body.fleet, 2000, raw => {
        const item = object(raw); check(id(item.id) && text(item.name, 2000) && (item.plate === undefined || text(item.plate, 100))
          && (item.branchId === undefined || id(item.branchId)) && (item.status === undefined || text(item.status, 100)));
        return item as { id: string; name: string; plate?: string; branchId?: string; status?: string };
      });
      return { parking: list(body.parking, 200, raw => { const p = object(raw); check(id(p.id) && text(p.name, 2000) && text(p.address, 4000)); return { id: p.id as string, name: p.name as string, address: p.address as string }; }),
        ...(fleet ? { fleet } : {}), ...(body.branches === undefined ? {} : { branches: references(body.branches, 200) }),
        ...(body.partners === undefined ? {} : { partners: references(body.partners, 2000) }), ...(body.members === undefined ? {} : { members: references(body.members, 200) }) };
    },
    createTowing: async (command: TowingCreateInput): Promise<{ commandId: string; targetId: string; revision: number; order: MobileTowingOrder | null }> => {
      const body = await request("towing/create", { method: "POST", body: command });
      check(body.commandId === command.commandId && body.targetId === command.targetId && positive(body.revision));
      const order = body.order === null ? null : parseTowingOrder(body.order);
      check(order === null || order.id === command.targetId);
      return { commandId: command.commandId, targetId: command.targetId, revision: body.revision as number, order };
    },
    towingOffice: async (filters: Record<string, string> = {}, signal?: AbortSignal): Promise<TowingWorkspace> => {
      const body = await request("towing/office?" + new URLSearchParams(filters), { method: "GET", signal });
      return parseOfficeWorkspace(body.workspace, memberId);
    },
    towingOfficeOrder: async (orderId: string, signal?: AbortSignal): Promise<TowingOrder> => {
      const target = pathId(orderId, "Odťah sa nenašiel.");
      const order = parseOfficeOrder((await request("towing/office/" + target, { method: "GET", signal })).order);
      check(order.id === target); return order;
    },
    towingOfficeCommand: async (command: TowingCommand): Promise<{ commandId: string; targetId: string; revision: number; order: TowingOrder | null }> => {
      const body = await request("towing/office/commands", { method: "POST", body: command });
      check(body.commandId === command.commandId && body.targetId === command.targetId && positive(body.revision));
      const order = body.order === null ? null : parseOfficeOrder(body.order);
      check(order === null || order.id === command.targetId);
      return { commandId: command.commandId, targetId: command.targetId, revision: body.revision as number, order };
    },
    cash: async (signal?: AbortSignal): Promise<MobileFieldCash> => parseCash((await request("cash", { method: "GET", signal })).cash),
    cashCommand: async (command: MobileFieldCashCommand): Promise<MobileFieldCash> => {
      const body = await request("cash/commands", { method: "POST", body: command });
      check(body.commandId === command.commandId && positive(body.revision));
      return parseCash(body.cash);
    },
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
    /** The secret for sending this operation's position in the background; kept only in the Keychain. */
    operationTracker: async (operationId: string): Promise<{ token: string; expiresAt: string }> => {
      const body = await request("operations/" + pathId(operationId, "Jazda sa nenašla.") + "/tracker", { method: "POST" });
      check(typeof body.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.token) && date(body.expiresAt));
      return { token: body.token as string, expiresAt: body.expiresAt as string };
    },
    operationUntrack: async (operationId: string): Promise<void> => {
      if (!id(operationId)) return;
      await request("operations/" + operationId.toLowerCase() + "/tracker", { method: "DELETE", timeout: 4_000 });
    },
    towing: async (orderId: string, signal?: AbortSignal): Promise<MobileTowingOrder> => {
      const target = pathId(orderId, "Zákazka sa nenašla.");
      const order = parseTowingOrder((await request("towing/" + target, { method: "GET", signal })).order);
      check(order.id === target);
      return order;
    },
    /** `order` null: it left the driver's list (e.g. after Odovzdať). */
    towingCommand: async (orderId: string, command: MobileTowingCommand): Promise<{ order: MobileTowingOrder | null; cash?: MobileFieldCash }> => {
      const target = pathId(orderId, "Zákazka sa nenašla.");
      const body = await request("towing/" + target + "/commands", { method: "POST", body: command });
      check(body.commandId === command.commandId && positive(body.revision));
      const cash = body.cash === undefined ? undefined : parseCash(body.cash);
      if (body.order === null) return { order: null, ...(cash !== undefined ? { cash } : {}) };
      const order = parseTowingOrder(body.order);
      check(order.id === target);
      return { order, ...(cash !== undefined ? { cash } : {}) };
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
