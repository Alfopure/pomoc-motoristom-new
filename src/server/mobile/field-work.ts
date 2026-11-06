import "server-only";
import { CASH_CATEGORIES, isCashCategory, isCashBreakdown, cashBreakdownTotal, isCashCategories } from "@/domain/towing/cash-categories";
import { randomBytes } from "node:crypto";
import type { TowingCapability, TowingMember, TowingRole } from "@/domain/towing/types";
import type { Json } from "@/lib/supabase/database.types";
import type {
  MobileFieldTowingOptions, MobileFieldCash, MobileFieldCashCommand, MobileTowingOwner, MobileTowingRealizedItem, MobileOperation, MobileOperationAction, MobileOperationCommand, MobileOperationEvidence, MobileOperationEvidenceInput,
  MobileTowingAttachment, MobileTowingCommand, MobileTowingDriverFields, MobileTowingFields, MobileTowingOrder,
} from "@/lib/mobile-api";
import { isHistoryTimestamp } from "@/lib/telephony/call-history-query";
import { isUuid } from "@/lib/telephony/uuid";
import { MutationError } from "@/server/mutation-error";
import { commandOperationFor, operationsWorkspaceFor } from "@/server/operations";
import { uploadOperationFile } from "@/server/operations/files";
import { towingEnabled } from "@/server/towing/auth";
import { uploadTowingAttachment } from "@/server/towing/files";
import { TowingError } from "@/server/towing/http";
import { executeTowingCommand, loadTowingWorkspace, parseTowingCommand } from "@/server/towing/service";
import { readDeliveryPosition, readTrackPositions, trackerHash } from "./delivery";
import { FieldWorkConflictError } from "./field-work-conflict";
import { fieldAdmin, missingSchema, type MobileFieldActor } from "./field-auth";

/** Moja práca in the app: the member's own logistics operations (`deliver`) and towing
 * orders (`drive`) through the existing RPCs, which re-authorize every read and command.
 * Even a member with office rights acts here only on work assigned to them. */
type Refusal = [RegExp, number, string];
type RpcError = { code?: string; message?: string };

/** Web services raise TowingError; the mobile API answers with MutationError. */
export function asMobileError(error: unknown): unknown {
  return error instanceof TowingError ? new MutationError(error.message, error.status, error.code) : error;
}
function unconfirmed(): never { throw new MutationError("Prácu sa nepodarilo overiť. Skúste znova.", 503, "work_unconfirmed"); }
function invalid(message: string): never { throw new MutationError(message, 400); }
function refiner(refusals: Refusal[]) {
  return (error: RpcError) => {
    const match = refusals.find(([pattern]) => pattern.test(error.message ?? ""));
    if (match) {
      if (/Driver physically busy/.test(error.message ?? "")) throw new FieldWorkConflictError(match[2], { kind: "physical", blocker: null });
      if (/Capacity conflict|Driver capacity conflict/.test(error.message ?? "")) throw new FieldWorkConflictError(match[2], { kind: "schedule", blocker: null }, /Driver capacity conflict/.test(error.message ?? ""));
      throw new MutationError(match[2], match[1], "work_refused");
    }
  };
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : unconfirmed();
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const optionalText = (value: unknown, max: number): string | null => value === null || value === undefined || value === "" ? null : text(value, max) ? value : unconfirmed();
const optionalDate = (value: unknown): string | null => value === null || value === undefined || value === "" ? null : isHistoryTimestamp(value) ? value : unconfirmed();
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
function pathId(value: string, message: string): string {
  if (!isUuid(value)) throw new MutationError(message, 404);
  return value.toLowerCase();
}
function onlyKeys(body: Record<string, unknown>, keys: readonly string[], message: string) {
  if (Object.keys(body).some(key => !keys.includes(key))) invalid(message);
}
function input(value: unknown, message: string): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid(message);
}

// --- Jazdy, odvozy a presuny -------------------------------------------------

const KINDS = ["delivery", "collection", "transfer"] as const;
const STATUSES = ["assigned", "accepted", "en_route", "arrived", "collected", "completed", "cancelled"] as const;
const STAGES = ["pickup", "handover", "inspection", "damage"] as const;
const SOURCES = ["observed", "reported", "exception"] as const;
const FIELD_ACTIONS: readonly MobileOperationAction[] = ["accept", "start", "arrive", "collect", "complete", "evidence"];
const operationRefusals: Refusal[] = [
  [/Capacity conflict/, 409, "Vy alebo vozidlo máte v tomto čase inú potvrdenú jazdu. Kontaktujte dispečera."],
  [/Driver physically busy/, 409, "Máte rozpracovanú inú prácu. Najprv ju dokončite."],
  [/Driver capacity conflict/, 409, "Termín jazdy sa prekrýva s inou prácou. Kontaktujte dispečera a upravte plán."],
  [/Fresh free source required/, 409, "Vozidlo podľa evidencie nie je voľné. Kontaktujte dispečera."],
  [/Interval required/, 409, "Plánovaný koniec jazdy už uplynul. Požiadajte dispečera o nový termín."],
  [/Assignment revoked/, 403, "Jazda vám už nie je pridelená."],
  [/Assignment required/, 409, "Tento krok teraz nie je možný. Načítajte jazdu znova."],
  [/Terminal operation/, 409, "Jazda je už ukončená."],
  [/Invalid transition/, 409, "Tento krok teraz nie je možný. Načítajte jazdu znova."],
  [/Revision conflict|Command conflict/, 409, "Jazda sa medzitým zmenila. Načítajte ju znova a krok zopakujte."],
  [/Confirmed fleet asset required/, 400, "Poškodenie možno nahlásiť až pri potvrdenom vozidle. Kontaktujte dispečera."],
  [/Damage description and resolver required/, 400, "Pri poškodení opíšte, čo sa stalo, a uveďte, kto ho vyrieši."],
  [/Handover evidence required/, 400, "Pred odovzdaním doplňte doklad odovzdania: osobu, kilometre, palivo a fotografiu, alebo dôvod chýbajúcich údajov."],
  [/Evidence or explicit missing reason required/, 400, "Doplňte osobu, kilometre, palivo a fotografiu, alebo napíšte, prečo chýbajú."],
  [/Private operation file required/, 400, "Fotografia sa nenašla. Nahrajte ju znova."],
  [/Future observation/, 400, "Čas zistenia nemôže byť v budúcnosti."],
  [/Office evidence permission required/, 403, "Doklady k ukončenej jazde doplní dispečer."],
];

function requireDeliver(actor: MobileFieldActor) {
  if (!actor.capabilities.includes("deliver")) throw new MutationError("Nemáte prístup k jazdám.", 403, "mobile_no_work_access");
}
function projectEvidence(value: unknown): MobileOperationEvidence {
  const item = record(value);
  if (typeof item.id !== "string" || !isUuid(item.id) || !(STAGES as readonly unknown[]).includes(item.stage) || !isHistoryTimestamp(item.observedAt)
    || !(SOURCES as readonly unknown[]).includes(item.source) || !text(item.note ?? "", 2000)
    || !(item.odometer === null || item.odometer === undefined || typeof item.odometer === "number" && Number.isFinite(item.odometer) && item.odometer >= 0)
    || !(item.damageStatus === null || item.damageStatus === undefined || item.damageStatus === "open" || item.damageStatus === "resolved")) unconfirmed();
  return { id: item.id.toLowerCase(), stage: item.stage as MobileOperationEvidence["stage"], observedAt: item.observedAt as string, source: item.source as MobileOperationEvidence["source"],
    person: optionalText(item.person, 300), note: (item.note as string | undefined) ?? "", photo: typeof item.photoReference === "string" && item.photoReference.length > 0,
    odometer: (item.odometer as number | null | undefined) ?? null, fuel: optionalText(item.fuel, 100), missingReason: optionalText(item.missingReason, 1000),
    damageStatus: (item.damageStatus as MobileOperationEvidence["damageStatus"] | undefined) ?? null };
}
/** Allowlisted: no cycle, owner or other members' data; the customer only while it is open. */
export function projectOperation(value: unknown, memberId: string, instructions: string | null = null, assistance?: MobileOperation["assistance"]): MobileOperation {
  const op = record(value);
  if (op.owner !== "logistics" || typeof op.id !== "string" || !isUuid(op.id) || !(KINDS as readonly unknown[]).includes(op.kind)
    || !(STATUSES as readonly unknown[]).includes(op.status) || !positive(op.revision) || String(op.assigneeId ?? "").toLowerCase() !== memberId
    || !text(op.from ?? "", 1000) || !text(op.to ?? "", 1000) || !isHistoryTimestamp(op.updatedAt) || !Array.isArray(op.evidence) || op.evidence.length > 200) unconfirmed();
  const status = op.status as MobileOperation["status"], open = status !== "completed" && status !== "cancelled";
  const customer = open && op.customer && typeof op.customer === "object" ? op.customer as Record<string, unknown> : null;
  return {
    id: op.id.toLowerCase(), kind: op.kind as MobileOperation["kind"], status, revision: op.revision as number,
    caseNumber: optionalText(op.caseNumber, 160), vehicle: optionalText(op.vehicle, 300), from: (op.from as string | undefined) ?? "", to: (op.to as string | undefined) ?? "",
    scheduledAt: optionalDate(op.scheduledAt), plannedEndAt: optionalDate(op.plannedEndAt), startedAt: optionalDate(op.startedAt), updatedAt: op.updatedAt as string,
    customer: customer && text(customer.name, 300) && text(customer.phone, 64) && (customer.name || customer.phone) ? { name: customer.name, phone: customer.phone } : null,
    ...(assistance !== undefined ? { assistance: open ? assistance : null } : {}),
    instructions: open ? instructions : null, vehicleConfirmed: typeof op.fleetAssetId === "string" && isUuid(op.fleetAssetId),
    evidenceState: op.evidenceState === "complete" ? "complete" : "pending", evidence: op.evidence.map(projectEvidence),
  };
}
type OperationContext = { legacy: boolean; instructions: string | null; assistance?: MobileOperation["assistance"] };
/** Per own operation: whether it belongs to a legacy app delivery (then it stays in
 * Pristavenia only) and the branch request's note for the executor. */
async function operationContext(actor: MobileFieldActor, ids: string[]): Promise<Map<string, OperationContext>> {
  if (!ids.length) return new Map();
  const { data, error } = await fieldAdmin().rpc("motorist_field_operations_context", { p_user_id: actor.userId, p_organization_id: actor.organizationId, p_operation_ids: ids });
  if (error) {
    if (missingSchema(error.code)) throw new MutationError("Moja práca ešte nie je v tomto prostredí zapnutá.", 503, "work_unavailable");
    if (error.code === "42501") throw new MutationError("Nemáte prístup k jazdám.", 403, "mobile_no_work_access");
    unconfirmed();
  }
  const context = record(data ?? {});
  return new Map(Object.entries(context).map(([key, value]) => {
    const item = record(value);
    if (typeof item.legacy !== "boolean" || !(item.instructions === null || item.instructions === undefined || text(item.instructions, 4000))) unconfirmed();
    return [key.toLowerCase(), { legacy: item.legacy, instructions: (item.instructions as string | null | undefined) ?? null }];
  }));
}
type WorkspaceRow = { id: string; owner?: unknown; status?: unknown; caseId?: unknown };
const LEGACY = "Toto pristavenie nájdete v module Pristavenia.";
/** Own logistics work, without legacy deliveries; an id the context does not confirm as this member's is not shown. */
async function ownOperations(actor: MobileFieldActor, filters: Record<string, unknown>): Promise<{ rows: WorkspaceRow[]; context: Map<string, OperationContext>; legacy: Set<string> }> {
  const workspace = await operationsWorkspaceFor(actor, { ...filters, mine: true });
  if (!workspace || !Array.isArray(workspace.operations)) unconfirmed();
  if (filters.view === "open" && workspace.totalCount > 50) {
    const next = await operationsWorkspaceFor(actor, { ...filters, mine: true, offset: 50 });
    if (!next || !Array.isArray(next.operations)) unconfirmed();
    workspace.operations = [...workspace.operations, ...next.operations];
  }
  // A legacy draft keeps its former recipient; it is nobody's work until assigned again.
  const rows = (workspace.operations as WorkspaceRow[]).filter(row => row.owner === "logistics" && row.status !== "draft");
  const context = await operationContext(actor, rows.map(row => row.id));
  const legacy = new Set(rows.filter(row => context.get(row.id)?.legacy !== false).map(row => row.id));
  const own = rows.filter(row => !legacy.has(row.id));
  // Case IDs come exclusively from the authorized own-work RPC, never from client input.
  const caseIds = [...new Set(own.flatMap(row => typeof row.caseId === "string" && isUuid(row.caseId) ? [row.caseId] : []))];
  if (caseIds.length) {
    const { data, error } = await fieldAdmin().from("motorist_cases").select("id,assistance_name:customer_details->>assistanceServiceName,assistance_case_reference:customer_details->>assistanceReference,assistance_reference")
      .eq("organization_id", actor.organizationId).in("id", caseIds);
    if (error || !Array.isArray(data)) unconfirmed();
    const cases = new Map(data.map(row => [row.id, row]));
    for (const row of own) {
      const source = cases.get(row.caseId as string), item = context.get(row.id);
      if (item) item.assistance = source ? { name: optionalText(source.assistance_name, 300),
        reference: optionalText(source.assistance_case_reference || source.assistance_reference, 300) } : null;
    }
  }
  return { rows: own, context, legacy };
}
export async function loadFieldOperations(actor: MobileFieldActor): Promise<MobileOperation[] | null> {
  if (!actor.capabilities.includes("deliver")) return null;
  const { rows, context } = await ownOperations(actor, { view: "open", limit: 50 });
  // One operation that cannot be shown must not hide the others.
  const operations = rows.flatMap(row => { try { return [projectOperation(row, actor.memberId, context.get(row.id)?.instructions ?? null, context.get(row.id)?.assistance)]; } catch { return []; } });
  if (operations.length < rows.length) console.warn(JSON.stringify({ event: "mobile.work", skipped: rows.length - operations.length }));
  return operations;
}
async function ownOperation(actor: MobileFieldActor, operationId: string): Promise<{ row: WorkspaceRow; instructions: string | null; assistance?: MobileOperation["assistance"] }> {
  const own = await ownOperations(actor, { id: operationId });
  if (own.legacy.has(operationId)) throw new MutationError(LEGACY, 404, "work_in_deliveries");
  const row = own.rows.find(item => item.id === operationId);
  if (!row) throw new MutationError("Jazda už nie je dostupná. Dispečer ju mohol zrušiť alebo prideliť inému.", 404);
  return { row, instructions: own.context.get(operationId)?.instructions ?? null, assistance: own.context.get(operationId)?.assistance };
}
export async function readFieldOperation(actor: MobileFieldActor, id: string): Promise<MobileOperation> {
  requireDeliver(actor);
  const { row, instructions, assistance } = await ownOperation(actor, pathId(id, "Jazda sa nenašla."));
  return projectOperation(row, actor.memberId, instructions, assistance);
}

const REFERENCE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$/;
function readEvidence(value: unknown): MobileOperationEvidenceInput {
  const body = input(value, "Neplatný doklad.");
  onlyKeys(body, ["stage", "source", "observedAt", "person", "note", "photoReference", "odometer", "fuel", "missingReason", "damageResolver"], "Neplatný doklad.");
  const optional = (key: string, max: number) => {
    const raw = body[key];
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "string" || raw.length > max) invalid("Skontrolujte dĺžku údajov dokladu.");
    return raw.trim() || null;
  };
  if (!["pickup", "handover", "damage"].includes(body.stage as string) || !(SOURCES as readonly unknown[]).includes(body.source)) invalid("Vyberte časť jazdy a pôvod údaja.");
  if (!isHistoryTimestamp(body.observedAt) || Date.parse(body.observedAt) > Date.now() + 60_000) invalid("Čas zistenia nie je platný.");
  if (typeof body.note !== "string" || body.note.length > 2000) invalid("Zistenia môžu mať najviac 2000 znakov.");
  const odometer = body.odometer;
  if (!(odometer === null || odometer === undefined || typeof odometer === "number" && Number.isFinite(odometer) && odometer >= 0 && odometer <= 10_000_000)) invalid("Stav kilometrov nie je platný.");
  const photoReference = optional("photoReference", 200);
  if (photoReference && !REFERENCE.test(photoReference)) invalid("Fotografia sa nenašla. Nahrajte ju znova.");
  const evidence: MobileOperationEvidenceInput = {
    stage: body.stage as MobileOperationEvidenceInput["stage"], source: body.source as MobileOperationEvidenceInput["source"], observedAt: new Date(body.observedAt as string).toISOString(),
    person: optional("person", 300), note: body.note.trim(), photoReference, odometer: (odometer as number | null | undefined) ?? null,
    fuel: optional("fuel", 100), missingReason: optional("missingReason", 1000),
  };
  // The same rules as the RPC, so the person reads what is missing before anything is sent.
  if (evidence.source === "exception" && !evidence.missingReason) invalid("Pri výnimke napíšte, prečo údaje chýbajú.");
  if (evidence.stage !== "damage" && !evidence.person && !evidence.missingReason) invalid("Uveďte, kto vozidlo odovzdal alebo prevzal, alebo prečo to nejde.");
  if ((evidence.odometer === null || !evidence.fuel) && !evidence.missingReason) invalid("Doplňte kilometre a palivo, alebo napíšte, prečo chýbajú.");
  if (!evidence.photoReference && !evidence.missingReason) invalid("Pridajte fotografiu alebo napíšte, prečo chýba.");
  if (evidence.stage === "damage") {
    const resolver = optional("damageResolver", 300);
    if (!evidence.note || !resolver) invalid("Pri poškodení opíšte, čo sa stalo, a uveďte, kto ho vyrieši.");
    evidence.damageResolver = resolver;
  } else if (body.damageResolver !== undefined && body.damageResolver !== null) invalid("Riešiteľa uveďte iba pri poškodení.");
  return evidence;
}
export function readOperationCommand(value: unknown): MobileOperationCommand {
  const body = input(value, "Neplatný krok jazdy.");
  onlyKeys(body, ["commandId", "action", "expectedRevision", "payload"], "Neplatný krok jazdy.");
  if (typeof body.commandId !== "string" || !isUuid(body.commandId) || !FIELD_ACTIONS.includes(body.action as MobileOperationAction) || !positive(body.expectedRevision)) invalid("Neplatný krok jazdy.");
  const payload = input(body.payload, "Neplatný krok jazdy.");
  if (body.action !== "evidence" && Object.keys(payload).length) invalid("Neplatný krok jazdy.");
  return { commandId: body.commandId.toLowerCase(), action: body.action as MobileOperationAction, expectedRevision: body.expectedRevision,
    payload: body.action === "evidence" ? readEvidence(payload) : {} };
}
export async function commandFieldOperation(actor: MobileFieldActor, id: string, value: unknown): Promise<{ commandId: string; committedRevision: number; operation: MobileOperation }> {
  requireDeliver(actor);
  const operationId = pathId(id, "Jazda sa nenašla."), command = readOperationCommand(value);
  const { row } = await ownOperation(actor, operationId);
  // Even a member with office rights adds doklady to a closed jazda only on the web.
  if (command.action === "evidence" && (row.status === "completed" || row.status === "cancelled")) throw new MutationError("Doklady k ukončenej jazde doplní dispečer na webe.", 403, "work_refused");
  const receipt = await commandOperationFor(actor, { ...command, operationId, payload: command.payload as Record<string, unknown> }, refiner(operationRefusals)).catch(error => enrichConflict(actor, { kind: "operation", id: operationId }, error));
  if (!receipt || String(receipt.commandId).toLowerCase() !== command.commandId || !positive(receipt.committedRevision)) unconfirmed();
  // The receipt carries no customer contact; the fresh read does, while it is still assigned.
  const fresh = await ownOperation(actor, operationId).then(own => projectOperation(own.row, actor.memberId, own.instructions, own.assistance)).catch(() => null);
  const operation = fresh && fresh.revision >= receipt.committedRevision ? fresh : projectOperation(receipt.operation, actor.memberId);
  return { commandId: command.commandId, committedRevision: receipt.committedRevision, operation };
}
export async function uploadFieldOperationFile(actor: MobileFieldActor, id: string, request: Request): Promise<{ reference: string }> {
  requireDeliver(actor);
  return uploadOperationFile(pathId(id, "Jazda sa nenašla."), request, { userId: actor.userId, organizationId: actor.organizationId, memberId: actor.memberId });
}
/** Stored only while the member's own operation is started and open; the database decides and throttles. */
export async function recordOperationPosition(actor: MobileFieldActor, id: string, value: unknown): Promise<{ stored: boolean; active: boolean }> {
  requireDeliver(actor);
  const operationId = pathId(id, "Jazda sa nenašla."), position = readDeliveryPosition(value);
  const { data, error } = await fieldAdmin().rpc("motorist_operation_position", { p_user_id: actor.userId, p_organization_id: actor.organizationId,
    p_operation_id: operationId, p_input: position as unknown as Json });
  if (error) {
    if (missingSchema(error.code)) throw new MutationError("Poloha počas jazdy ešte nie je v tomto prostredí zapnutá.", 503, "work_position_unavailable");
    if (error.code === "42501") throw new MutationError("Nemáte prístup k jazdám.", 403, "mobile_no_work_access");
    if (error.code === "P0002") throw new MutationError("Jazda sa nenašla.", 404);
    if (["22023", "22P02", "22007", "22008"].includes(error.code ?? "")) throw new MutationError("Neplatná poloha.", 400);
    unconfirmed();
  }
  const result = data as { stored?: unknown; active?: unknown } | null;
  if (typeof result?.stored !== "boolean" || typeof result.active !== "boolean") unconfirmed();
  return { stored: result.stored, active: result.active };
}

/** A database without 20261028150000 has no background secrets: the open app still sends. */
function trackerError(error: RpcError): never {
  if (missingSchema(error.code)) throw new MutationError("Poloha na pozadí počas jazdy ešte nie je v tomto prostredí zapnutá.", 503, "work_background_unavailable");
  if (error.code === "42501") throw new MutationError("Nemáte prístup k jazdám.", 403, "mobile_no_work_access");
  if (error.code === "P0002") throw new MutationError("Jazda sa nenašla.", 404);
  if (error.code === "PT409" && error.message === "Not tracking") throw new MutationError("Polohu môžete posielať až po vyrazení, kým je jazda otvorená.", 409, "work_not_tracking");
  if (["22023", "22P02", "22007", "22008"].includes(error.code ?? "")) throw new MutationError("Neplatná požiadavka polohy.", 400);
  return unconfirmed();
}
async function trackerCall(actor: MobileFieldActor, id: string, action: "issue" | "revoke", tokenHash: string | null): Promise<Record<string, unknown>> {
  requireDeliver(actor);
  const { data, error } = await fieldAdmin().rpc("motorist_operation_tracker", { p_user_id: actor.userId, p_organization_id: actor.organizationId,
    p_operation_id: pathId(id, "Jazda sa nenašla."), p_action: action, p_token_hash: tokenHash });
  if (error) trackerError(error);
  return record(data);
}
/** A secret for the member's own started operation, so the phone can send its position
 * in the background (app closed, phone locked) without the sign-in session. Only its
 * hash reaches the database; it ends with the work, a new secret or the member's logout. */
export async function issueOperationTracker(actor: MobileFieldActor, id: string): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const data = await trackerCall(actor, id, "issue", trackerHash(token));
  if (!isHistoryTimestamp(data.expiresAt)) unconfirmed();
  return { token, expiresAt: data.expiresAt as string };
}
export async function revokeOperationTracker(actor: MobileFieldActor, id: string): Promise<{ revoked: boolean }> {
  if ((await trackerCall(actor, id, "revoke", null)).revoked !== true) unconfirmed();
  return { revoked: true };
}
/** What the phone kept since its last send, by the operation's secret; `active` false: stop. */
export async function trackOperationPositions(token: string, value: unknown): Promise<{ stored: number; active: boolean }> {
  const positions = readTrackPositions(value);
  const { data, error } = await fieldAdmin().rpc("motorist_operation_track", { p_token_hash: trackerHash(token), p_positions: positions as unknown as Json });
  if (error) {
    if (missingSchema(error.code)) throw new MutationError("Poloha počas jazdy ešte nie je v tomto prostredí zapnutá.", 503, "work_position_unavailable");
    if (["22023", "22P02", "22007", "22008"].includes(error.code ?? "")) throw new MutationError("Neplatné polohy.", 400);
    unconfirmed();
  }
  const result = data as { stored?: unknown; active?: unknown } | null;
  if (typeof result?.stored !== "number" || !Number.isSafeInteger(result.stored) || result.stored < 0 || typeof result.active !== "boolean") unconfirmed();
  return { stored: result.stored, active: result.active };
}

// --- Odťahy -----------------------------------------------------------------

const SERVICE_TYPES = ["tow", "repair", "transport", "storage", "relocation"];
const SUBJECT_TYPES = ["vehicle", "machine", "material"];
const TOWING_STATUSES = ["assigned", "in_progress", "needs_changes"];
const ATTACHMENT_KINDS = ["work", "handover", "scan"];
const DRIVER_FIELDS = ["startedAt", "finishedAt", "driverNotes", "performedQuantity", "photoException", "destination", "subjectDescription", "plate", "vin", "odometer", "handoverRecipientName", "handedOverAt", "handoverException", "pickup", "contact", "noContactReason", "branchId", "fleetAssetId", "plannedAt", "assistanceReference", "assistancePartnerId", "requesterId", "parkingId"] as const;
const PAYMENT_INTENTS = ["partner_invoice", "deferred_invoice", "card_terminal", "cash_terminal", "cash_other"] as const;
// The towing RPC writes `now()::text` ("2026-10-28 08:00:00.123456+00"); the web writes ISO.
const TOWING_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?)$/;
/** A towing time as ISO; a time without its zone or unreadable is shown as missing, never guessed. */
export function towingTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 64) return null;
  const match = TOWING_TIME.exec(value.trim());
  if (!match) return null;
  const [, day, minutes, seconds = ":00", zone] = match;
  const offset = zone === "Z" ? "Z" : zone.length === 3 ? zone + ":00" : zone.includes(":") ? zone : zone.slice(0, 3) + ":" + zone.slice(3);
  const time = Date.parse(day + "T" + minutes + seconds.replace(/(\.\d{3})\d+$/, "$1") + offset);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
const towingRefusals: Refusal[] = [
  [/Photographs required/, 400, "Pridajte fotografiu práce (pri odťahu a prevoze aj odovzdania) alebo napíšte, prečo fotografie chýbajú."],
  [/Realized item requires description, positive quantity and unit/, 400, "Doplňte opis, kladné množstvo a jednotku každého úkonu."],
  [/Storage item requires an identified parking site/, 400, "Pri uskladnení vyberte konkrétne parkovisko."],
  [/Transport item requires a destination/, 400, "Pri preprave doplňte cieľ každého úkonu."],
  [/Invalid handover|Handover facts incomplete/, 400, "Doplňte príjemcu a čas odovzdania alebo vysvetlite výnimku."],
  [/Completion incomplete/, 400, "Doplňte začiatok a koniec práce a cieľ. Ostatné údaje zákazky doplní kancelária."],
  [/Confirm actual work time/, 400, "Potvrďte skutočný začiatok práce."],
  [/Cash revision conflict/, 409, "Stav pokladne sa zmenil. Obnovte ho pred ďalším dokladom."],
  [/Receipt identity conflict|Command identity conflict/, 409, "Doklad už existuje s inými údajmi. Overte pôvodný príjem; nevytvárajte ho znova."],
  [/Insufficient available cash/, 400, "Na odovzdanie nie je dosť voľnej hotovosti."],
  [/Invalid payment/, 400, "Skontrolujte presnú prijatú sumu a spôsob úhrady."],
  [/Uploads pending/, 409, "Počkajte, kým sa dokončí nahrávanie príloh."],
  [/Storage requires an identified parking site/, 400, "Uskladnenie potrebuje parkovisko; doplní ho kancelária."],
  [/Driver physically busy/, 409, "Máte rozpracovaný iný odťah. Najprv ho odovzdajte."],
  [/Driver capacity conflict/, 409, "Termín jazdy sa prekrýva s inou prácou. Kontaktujte dispečera a upravte plán."],
  [/End precedes start/, 400, "Koniec práce nemôže byť pred jej začiatkom."],
  [/Record only work cannot/, 409, "Túto zákazku vedie kancelária ako záznam; v teréne sa nevykonáva."],
  [/Invalid transition/, 409, "Tento krok teraz nie je možný. Načítajte zákazku znova."],
  [/Order revision conflict|Command identity conflict/, 409, "Zákazka sa medzitým zmenila. Načítajte ju znova a krok zopakujte."],
  [/Towing access denied|Driver fields denied/, 403, "Zákazka vám už nie je pridelená."],
  [/Attachment limit/, 400, "Zákazka má už najväčší povolený počet príloh."],
  [/Attachment unavailable/, 404, "Príloha už nie je rozpracovaná alebo patrí inému prideleniu."],
];
export function towingMember(actor: MobileFieldActor): TowingMember {
  return { id: actor.memberId, userId: actor.userId, organizationId: actor.organizationId, displayName: actor.displayName, roles: actor.roles as TowingRole[],
    capabilities: actor.capabilities as TowingCapability[], active: true, version: actor.version, ...(actor.email ? { email: actor.email } : {}) };
}
function requireDrive(actor: MobileFieldActor) {
  if (!actor.capabilities.includes("drive")) throw new MutationError("Nemáte prístup k odťahom.", 403, "mobile_no_towing_access");
  if (!towingEnabled()) throw new MutationError("Odťahy ešte nie sú v tomto prostredí zapnuté.", 503, "towing_unavailable");
}
function projectAttachment(value: unknown): MobileTowingAttachment {
  const item = record(value);
  if (typeof item.id !== "string" || !isUuid(item.id) || !ATTACHMENT_KINDS.includes(item.kind as string) || !text(item.name, 300) || !text(item.mimeType, 100)
    || !["pending", "ready", "abandoned"].includes(item.status as string) || !isHistoryTimestamp(item.createdAt)) unconfirmed();
  return { id: item.id.toLowerCase(), kind: item.kind as MobileTowingAttachment["kind"], name: item.name, mimeType: item.mimeType,
    status: item.status as MobileTowingAttachment["status"], createdAt: item.createdAt as string };
}
function nullableCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) unconfirmed();
  return value as number;
}
function readOwner(value: unknown): MobileTowingOwner {
  const owner = input(value, "Neplatný vlastník vozidla.");
  onlyKeys(owner, ["name", "phone", "email", "address", "companyId"], "Upravte iba prevádzkové kontaktné údaje.");
  if (!text(owner.name, 2000)) invalid("Vyplňte meno vlastníka.");
  const result: MobileTowingOwner = { name: "" };
  for (const key of ["name", "phone", "email", "address", "companyId"] as const) {
    if (owner[key] === undefined || owner[key] === null) continue;
    if (!text(owner[key], 2000)) invalid("Skontrolujte údaje vlastníka.");
    result[key] = (owner[key] as string).trim();
  }
  return result;
}
function readRealizedItems(value: unknown): MobileTowingRealizedItem[] {
  if (!Array.isArray(value) || value.length > 50) invalid("Zadajte najviac 50 vykonaných úkonov.");
  const ids = new Set<string>();
  return value.map(raw => {
    const item = input(raw, "Neplatný vykonaný úkon.");
    onlyKeys(item, ["id", "kind", "description", "quantity", "unit", "parkingId", "parkingName", "parkingAddress", "destination"], "Neplatný vykonaný úkon.");
    if (typeof item.id !== "string" || !isUuid(item.id) || ids.has(item.id.toLowerCase()) || !SERVICE_TYPES.includes(item.kind as string)
      || !text(item.description, 2000) || !text(item.quantity, 20) || item.quantity !== "" && !/^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(item.quantity)
      || !text(item.unit, 40)) invalid("Skontrolujte druh, množstvo a jednotku úkonu.");
    ids.add(item.id.toLowerCase());
    const out: MobileTowingRealizedItem = { id: item.id.toLowerCase(), kind: item.kind as MobileTowingRealizedItem["kind"], description: item.description as string, quantity: item.quantity as string, unit: item.unit as string };
    for (const key of ["parkingId", "parkingName", "parkingAddress", "destination"] as const) {
      if (item[key] === undefined || item[key] === null) continue;
      if (!text(item[key], 2000) || key === "parkingId" && !isUuid(item[key] as string)) invalid("Skontrolujte parkovisko a cieľ úkonu.");
      out[key] = item[key] as string;
    }
    return out;
  });
}
/** Own-assignment operational projection; office notes, prices and invoice data stay private. */
export function projectTowingOrder(value: unknown, memberId: string): MobileTowingOrder {
  const order = record(value), fields = record(order.fields);
  if (typeof order.id !== "string" || !isUuid(order.id) || !text(order.number, 64) || !positive(order.revision) || !positive(order.assignmentGeneration)
    || String(order.driverId ?? "").toLowerCase() !== memberId || !TOWING_STATUSES.includes(order.workStatus as string) || !isHistoryTimestamp(order.updatedAt)
    || !SERVICE_TYPES.includes(fields.serviceType as string) || !SUBJECT_TYPES.includes(fields.subjectType as string)
    || !text(fields.subjectDescription ?? "", 10_000) || !text(fields.pickup ?? "", 10_000)
    || !(fields.startSource === undefined || fields.startSource === "assignment" || fields.startSource === "manual") || !Array.isArray(order.attachments) || order.attachments.length > 60) unconfirmed();
  const party = fields.customer && typeof fields.customer === "object" ? fields.customer as Record<string, unknown> : null;
  const requester = fields.requester && typeof fields.requester === "object" ? fields.requester as Record<string, unknown> : null;
  const owner = fields.owner ? readOwner(fields.owner) : null;
  const projected: MobileTowingFields = {
    odometer: optionalText(fields.odometer, 100), paymentIntent: fields.paymentIntent == null ? null : PAYMENT_INTENTS.includes(fields.paymentIntent as typeof PAYMENT_INTENTS[number]) ? fields.paymentIntent as MobileTowingFields["paymentIntent"] : unconfirmed(),
    realizedItems: fields.realizedItems === undefined ? [] : readRealizedItems(fields.realizedItems), owner,
    handoverRecipientName: optionalText(fields.handoverRecipientName, 300), handedOverAt: towingTime(fields.handedOverAt), handoverException: optionalText(fields.handoverException, 4000),
    requesterName: optionalText(requester?.name, 300), dispatchInstructions: optionalText(fields.dispatchInstructions, 4000),
    requester: requester ? readOwner(requester) : null, recipient: fields.recipient ? readOwner(fields.recipient) : null,
    requesterType: fields.requesterType == null ? null : ["assistance", "selfpayer"].includes(fields.requesterType as string)
      ? fields.requesterType as "assistance" | "selfpayer" : unconfirmed(),
    branchId: optionalText(fields.branchId, 36), fleetAssetId: optionalText(fields.fleetAssetId, 36),
    assistancePartnerId: optionalText(fields.assistancePartnerId, 36), requesterId: optionalText(fields.requesterId, 36), parkingId: optionalText(fields.parkingId, 36),
    serviceType: fields.serviceType as MobileTowingFields["serviceType"], subjectType: fields.subjectType as MobileTowingFields["subjectType"],
    subjectDescription: (fields.subjectDescription as string | undefined) ?? "", pickup: (fields.pickup as string | undefined) ?? "",
    plate: optionalText(fields.plate, 100), vin: optionalText(fields.vin, 100), destination: optionalText(fields.destination, 10_000),
    contact: optionalText(fields.contact, 10_000), noContactReason: optionalText(fields.noContactReason, 10_000),
    plannedAt: towingTime(fields.plannedAt), startedAt: towingTime(fields.startedAt), finishedAt: towingTime(fields.finishedAt),
    startSource: (fields.startSource as MobileTowingFields["startSource"] | undefined) ?? null,
    driverNotes: optionalText(fields.driverNotes, 10_000), performedQuantity: optionalText(fields.performedQuantity, 10_000), photoException: optionalText(fields.photoException, 10_000),
    assistanceReference: optionalText(fields.assistanceReference, 300), assistancePartnerName: optionalText(fields.assistancePartnerName, 300),
    parkingName: optionalText(fields.parkingName, 300), parkingAddress: optionalText(fields.parkingAddress, 2000),
    customer: party && text(party.name, 2000) && party.name ? { name: party.name, phone: optionalText(party.phone, 2000) } : null,
  };
  return { id: order.id.toLowerCase(), number: order.number, revision: order.revision, assignmentGeneration: order.assignmentGeneration,
    workStatus: order.workStatus as MobileTowingOrder["workStatus"], updatedAt: order.updatedAt as string, fields: projected,
    authorizedCollectionCents: nullableCents(order.authorizedCollectionCents), dueCents: nullableCents(order.dueCents),
    payments: Array.isArray(order.payments) ? order.payments.filter(value => record(value).driverId === memberId).sort((a, b) => Date.parse(String(record(b).createdAt)) - Date.parse(String(record(a).createdAt))).slice(0, 100).map(value => {
      const p = record(value);
      if (typeof p.id !== "string" || !isUuid(p.id) || typeof p.receiptId !== "string" || !isUuid(p.receiptId) || !Number.isSafeInteger(p.amountCents) || !["cash", "card", "bank", "other"].includes(p.method as string) || !isHistoryTimestamp(p.createdAt)) unconfirmed();
      return { id: p.id, receiptId: p.receiptId, amountCents: p.amountCents as number, method: p.method as "cash" | "card" | "bank" | "other", ...(p.cashCategory !== undefined ? { cashCategory: p.cashCategory === null ? null : isCashCategory(p.cashCategory) ? p.cashCategory : unconfirmed() } : {}), createdAt: p.createdAt as string };
    }) : [],
    attachments: order.attachments.map(projectAttachment).filter(item => item.status !== "abandoned") };
}
async function driverOrders(actor: MobileFieldActor, filters: Record<string, unknown>): Promise<unknown[]> {
  const workspace = await loadTowingWorkspace(towingMember(actor), "driver", { limit: 50, offset: 0, ...filters });
  return workspace.orders;
}
export async function loadFieldTowing(actor: MobileFieldActor): Promise<MobileTowingOrder[] | null> {
  if (!actor.capabilities.includes("drive") || !towingEnabled()) return null;
  const rows = await driverOrders(actor, {});
  const orders = rows.flatMap(row => { try { return [projectTowingOrder(row, actor.memberId)]; } catch { return []; } });
  if (orders.length < rows.length) console.warn(JSON.stringify({ event: "mobile.work", towingSkipped: rows.length - orders.length }));
  return orders;
}
async function ownOrder(actor: MobileFieldActor, orderId: string): Promise<MobileTowingOrder | null> {
  const row = (await driverOrders(actor, { orderId })).find(item => record(item).id === orderId);
  return row ? projectTowingOrder(row, actor.memberId) : null;
}
export async function readFieldTowing(actor: MobileFieldActor, id: string): Promise<MobileTowingOrder> {
  requireDrive(actor);
  const order = await ownOrder(actor, pathId(id, "Zákazka sa nenašla."));
  if (!order) throw new MutationError("Zákazka už nie je vo vašom zozname. Mohla byť odovzdaná, prepridelená alebo zrušená.", 404);
  return order;
}
export function readTowingCommand(value: unknown): MobileTowingCommand {
  const body = input(value, "Neplatný krok zákazky.");
  onlyKeys(body, ["commandId", "type", "expectedRevision", "assignmentGeneration", "payload"], "Neplatný krok zákazky.");
  if (typeof body.commandId !== "string" || !isUuid(body.commandId) || !["start", "update_order", "submit", "abandon_attachment", "receive_payment"].includes(body.type as string)
    || !positive(body.expectedRevision) || !positive(body.assignmentGeneration)) invalid("Neplatný krok zákazky.");
  const payload = input(body.payload, "Neplatný krok zákazky.");
  const base = { commandId: body.commandId.toLowerCase(), type: body.type as MobileTowingCommand["type"], expectedRevision: body.expectedRevision, assignmentGeneration: body.assignmentGeneration };
  if (body.type === "receive_payment") {
    onlyKeys(payload, ["receiptId", "amountCents", "method", "accountRevision", "cashCategory"], "Neplatný príjmový doklad.");
    if (typeof payload.receiptId !== "string" || !isUuid(payload.receiptId) || !positive(payload.amountCents) || !["cash", "card"].includes(payload.method as string)
      || payload.method === "cash" && !positive(payload.accountRevision) || payload.accountRevision !== undefined && !positive(payload.accountRevision)) invalid("Zadajte presnú prijatú sumu a spôsob úhrady. Obnovte stav pokladne.");
    if (payload.cashCategory !== undefined && (payload.method !== "cash" || !isCashCategory(payload.cashCategory))) invalid("Vyberte kategóriu prijatej hotovosti.");
    return { ...base, payload: { ...(payload.cashCategory !== undefined ? { cashCategory: payload.cashCategory as "regular" | "other" | "unclassified" } : {}), receiptId: payload.receiptId.toLowerCase(), amountCents: payload.amountCents as number, method: payload.method as "cash" | "card", ...(payload.accountRevision !== undefined ? { accountRevision: payload.accountRevision as number } : {}) } };
  }
  if (body.type === "abandon_attachment") {
    // Only an own unfinished upload of the current assignment; the RPC re-checks both.
    onlyKeys(payload, ["id", "reason"], "Neplatný krok zákazky.");
    if (typeof payload.id !== "string" || !isUuid(payload.id) || typeof payload.reason !== "string" || !payload.reason.trim() || payload.reason.length > 1000) invalid("Vyberte prílohu a napíšte dôvod.");
    return { ...base, payload: { id: payload.id.toLowerCase(), reason: payload.reason.trim() } };
  }
  if (body.type !== "update_order") {
    if (Object.keys(payload).length) invalid("Neplatný krok zákazky.");
    return { ...base, payload: {} };
  }
  onlyKeys(payload, ["fields"], "Neplatné údaje zákazky.");
  const fields = input(payload.fields, "Neplatné údaje zákazky.");
  onlyKeys(fields, [...DRIVER_FIELDS, "paymentIntent", "owner", "requester", "recipient", "requesterType", "serviceType", "subjectType", "realizedItems"], "Tieto údaje zákazky doplní kancelária.");
  if (!Object.keys(fields).length) invalid("Nie je čo uložiť.");
  const out: MobileTowingDriverFields = {};
  if ("owner" in fields) out.owner = readOwner(fields.owner);
  if ("requester" in fields) out.requester = readOwner(fields.requester);
  if ("recipient" in fields) out.recipient = readOwner(fields.recipient);
  if ("requesterType" in fields) {
    if (fields.requesterType !== null && !["assistance", "selfpayer"].includes(fields.requesterType as string)) invalid("Vyberte typ objednávateľa.");
    out.requesterType = fields.requesterType as "assistance" | "selfpayer" | null;
  }
  if ("serviceType" in fields) {
    if (!SERVICE_TYPES.includes(fields.serviceType as string)) invalid("Vyberte druh výkonu.");
    out.serviceType = fields.serviceType as MobileTowingFields["serviceType"];
  }
  if ("subjectType" in fields) {
    if (!SUBJECT_TYPES.includes(fields.subjectType as string)) invalid("Vyberte druh predmetu zákazky.");
    out.subjectType = fields.subjectType as MobileTowingFields["subjectType"];
  }
  if ("realizedItems" in fields) out.realizedItems = readRealizedItems(fields.realizedItems);
  if ("paymentIntent" in fields) {
    if (fields.paymentIntent !== null && !PAYMENT_INTENTS.includes(fields.paymentIntent as typeof PAYMENT_INTENTS[number])) invalid("Vyberte spôsob plánovanej úhrady.");
    out.paymentIntent = fields.paymentIntent as MobileTowingFields["paymentIntent"];
  }
  for (const key of DRIVER_FIELDS) {
    if (!(key in fields)) continue;
    const raw = fields[key];
    if (raw !== null && (typeof raw !== "string" || raw.length > 4000)) invalid("Skontrolujte dĺžku údajov zákazky.");
    const valueText = typeof raw === "string" ? raw.trim() || null : null;
    if (["branchId", "fleetAssetId", "assistancePartnerId", "requesterId", "parkingId"].includes(key) && valueText !== null && !isUuid(valueText)) invalid("Vyberte platnú položku zo zoznamu.");
    if (key === "plannedAt" && valueText !== null && !isHistoryTimestamp(valueText)) invalid("Plánovaný čas nie je platný.");
    if ((key === "startedAt" || key === "finishedAt" || key === "handedOverAt") && valueText !== null && (!isHistoryTimestamp(valueText) || Date.parse(valueText) > Date.now() + 5 * 60_000)) invalid("Čas práce nie je platný.");
    out[key] = valueText;
  }
  if (out.startedAt && out.finishedAt && Date.parse(out.finishedAt) < Date.parse(out.startedAt)) invalid("Koniec práce nemôže byť pred jej začiatkom.");
  return { ...base, payload: { fields: out } };
}
export async function commandFieldTowing(actor: MobileFieldActor, id: string, value: unknown): Promise<{ commandId: string; revision: number; order: MobileTowingOrder | null; cash?: MobileFieldCash }> {
  requireDrive(actor);
  const orderId = pathId(id, "Zákazka sa nenašla."), command = readTowingCommand(value);
  // The assignment generation keeps the RPC on the driver's own-assignment path.
  const parsed = parseTowingCommand({ ...command, targetId: orderId });
  const result = await executeTowingCommand(towingMember(actor), parsed, refiner(towingRefusals)).catch(error => enrichConflict(actor, { kind: "towing", id: orderId }, error));
  if (String(result.commandId).toLowerCase() !== command.commandId || !positive(result.revision) || command.type === "receive_payment" && result.targetId !== orderId) unconfirmed();
  // null only when the order really left the list; a failed read leaves the step to be confirmed again (it replays).
  return { commandId: command.commandId, revision: result.revision, order: await ownOrder(actor, orderId), ...(command.type === "receive_payment" ? { cash: await loadFieldCash(actor) } : {}) };
}
/** Work and handover photos and paper scans, as multipart (file, attachmentId, commandId, kind, expectedRevision, assignmentGeneration). */
export async function uploadFieldTowingAttachment(actor: MobileFieldActor, id: string, request: Request): Promise<{ commandId: string; revision: number; attachmentId: string }> {
  requireDrive(actor);
  const orderId = pathId(id, "Zákazka sa nenašla.");
  if (!await ownOrder(actor, orderId)) throw new MutationError("Zákazka už nie je vo vašom zozname.", 404);
  const result = await uploadTowingAttachment(towingMember(actor), orderId, request, { requireAssignmentGeneration: true });
  const attachmentId = result.result?.attachmentId;
  if (typeof attachmentId !== "string" || !isUuid(attachmentId) || !positive(result.revision)) unconfirmed();
  return { commandId: String(result.commandId).toLowerCase(), revision: result.revision, attachmentId: attachmentId.toLowerCase() };
}

/** Resolve only after a real physical refusal, through the member’s authorized work projections.
 * Failure or ambiguity leaves the refusal intact and never discloses a guessed ID. */
async function enrichConflict(actor: MobileFieldActor, target: { kind: "operation" | "towing"; id: string }, error: unknown): Promise<never> {
  if (error instanceof FieldWorkConflictError && error.resolvePhysical) {
    const [operations, towing] = await Promise.allSettled([loadFieldOperations(actor), loadFieldTowing(actor)]);
    const candidates = [
      ...(operations.status === "fulfilled" ? operations.value ?? [] : []).filter(op => ["en_route", "arrived", "collected"].includes(op.status))
        .map(op => ({ kind: "operation" as const, id: op.id, number: op.caseNumber })),
      ...(towing.status === "fulfilled" ? towing.value ?? [] : []).filter(order => order.workStatus === "in_progress")
        .map(order => ({ kind: "towing" as const, id: order.id, number: order.number })),
    ].filter(item => item.kind !== target.kind || item.id !== target.id);
    if (candidates.length === 1) throw new FieldWorkConflictError("Máte rozpracovanú inú prácu. Najprv ju dokončite.", { kind: "physical", blocker: candidates[0] });
    if (error.conflict.kind === "physical") throw new FieldWorkConflictError("Ďalší krok blokuje rozpracovaná práca. Kontaktujte dispečera.", error.conflict);
  }
  throw error;
}

/** Driver view, then explicit own-member filtering even for a dual-role account. */
export async function loadFieldCash(actor: MobileFieldActor): Promise<MobileFieldCash> {
  requireDrive(actor);
  const workspace = await loadTowingWorkspace(towingMember(actor), "driver", { limit: 1, offset: 0 });
  const accounts = (workspace.cashAccounts ?? []).filter(row => row.driverId === actor.memberId);
  if (accounts.length > 1) unconfirmed();
  const source = accounts[0];
  if (source && (!isUuid(source.id) || !Number.isSafeInteger(source.balanceCents) || !Number.isSafeInteger(source.reservedCents) || source.reservedCents < 0 || !positive(source.revision))) unconfirmed();
  if (source?.categories !== undefined && (!isCashCategories(source.categories) || CASH_CATEGORIES.reduce((sum, key) => sum + source.categories![key].balanceCents, 0) !== source.balanceCents || CASH_CATEGORIES.reduce((sum, key) => sum + source.categories![key].reservedCents, 0) !== source.reservedCents)) unconfirmed();
  const account = source ? { id: source.id, balanceCents: source.balanceCents, reservedCents: source.reservedCents, revision: source.revision, ...(source.categories ? { categories: source.categories } : {}) } : null;
  const handovers = (workspace.handovers ?? []).filter(row => row.driverId === actor.memberId).slice(0, 100).map(row => {
    if (!isUuid(row.id) || !positive(row.amountCents) || !positive(row.revision) || !["pending", "accepted", "rejected", "cancelled"].includes(row.status) || !isHistoryTimestamp(row.createdAt)) unconfirmed();
    if (row.cashBreakdown !== undefined && (!isCashBreakdown(row.cashBreakdown) || cashBreakdownTotal(row.cashBreakdown) !== row.amountCents)) unconfirmed();
    return { id: row.id, amountCents: row.amountCents, status: row.status, revision: row.revision, createdAt: row.createdAt, ...(row.cashBreakdown ? { cashBreakdown: row.cashBreakdown } : {}) };
  });
  return { account, handovers };
}
function validatedCashBreakdown(value: unknown, total: number) {
  if (!isCashBreakdown(value) || cashBreakdownTotal(value) !== total) invalid("Rozpis hotovosti sa musí rovnať odovzdávanej sume.");
  return value;
}
export function readCashCommand(value: unknown): MobileFieldCashCommand {
  const body = input(value, "Neplatné odovzdanie hotovosti.");
  onlyKeys(body, ["commandId", "handoverId", "type", "expectedRevision", "payload"], "Neplatné odovzdanie hotovosti.");
  const payload = input(body.payload, "Neplatné odovzdanie hotovosti.");
  onlyKeys(payload, ["amountCents", "accountRevision", "cashBreakdown"], "Neplatné odovzdanie hotovosti.");
  if (typeof body.commandId !== "string" || !isUuid(body.commandId) || typeof body.handoverId !== "string" || !isUuid(body.handoverId)
    || body.type !== "propose_handover" || body.expectedRevision !== 0 || !positive(payload.amountCents) || !positive(payload.accountRevision)) invalid("Zadajte presnú sumu a obnovte stav svojej pokladne.");
  return { commandId: body.commandId.toLowerCase(), handoverId: body.handoverId.toLowerCase(), type: "propose_handover", expectedRevision: 0,
    payload: { amountCents: payload.amountCents as number, accountRevision: payload.accountRevision as number, ...(payload.cashBreakdown !== undefined ? { cashBreakdown: validatedCashBreakdown(payload.cashBreakdown, payload.amountCents as number) } : {}) } };
}
export async function commandFieldCash(actor: MobileFieldActor, value: unknown): Promise<{ commandId: string; revision: number; cash: MobileFieldCash }> {
  requireDrive(actor);
  const command = readCashCommand(value);
  const result = await executeTowingCommand(towingMember(actor), parseTowingCommand({ commandId: command.commandId, targetId: command.handoverId,
    type: command.type, expectedRevision: 0, payload: command.payload }), refiner(towingRefusals));
  if (String(result.commandId).toLowerCase() !== command.commandId || !positive(result.revision) || result.targetId !== command.handoverId) unconfirmed();
  return { commandId: command.commandId, revision: result.revision, cash: await loadFieldCash(actor) };
}

export async function loadFieldTowingOptions(actor: MobileFieldActor): Promise<MobileFieldTowingOptions> {
  const office = actor.capabilities.includes("operate");
  if (!office) requireDrive(actor);
  if (!towingEnabled()) throw new MutationError("Odťahy ešte nie sú v tomto prostredí zapnuté.", 503, "towing_unavailable");
  const [workspace, fleet, branches, partners] = await Promise.all([
    loadTowingWorkspace(towingMember(actor), office ? "office" : "driver", { limit: 1, offset: 0 }),
    fieldAdmin().from("motorist_fleet_assets").select("id,label,license_plate,status,branch_id")
      .eq("organization_id", actor.organizationId).eq("kind", "tow_truck").order("label").limit(2000),
    fieldAdmin().from("motorist_branches").select("id,name").eq("organization_id", actor.organizationId)
      .eq("active", true).order("name").limit(200),
    fieldAdmin().from("motorist_contacts").select("id,name").eq("organization_id", actor.organizationId)
      .in("role", ["assistance", "partner"]).order("name").limit(2000),
  ]);
  if (fleet.error || !Array.isArray(fleet.data) || branches.error || !Array.isArray(branches.data)
    || partners.error || !Array.isArray(partners.data)) unconfirmed();
  const reference = (row: { id: string; name: string }) => {
    if (!isUuid(row.id) || !text(row.name, 2000)) unconfirmed();
    return { id: row.id, name: row.name };
  };
  return { parking: (workspace.parking ?? []).filter(row => row.active).slice(0, 200).map(row => {
    if (!isUuid(row.id) || !text(row.name, 2000) || !text(row.address, 4000)) unconfirmed();
    return { id: row.id, name: row.name, address: row.address };
  }), branches: branches.data.map(reference), partners: partners.data.map(reference),
    fleet: fleet.data.map(row => {
      if (!isUuid(row.id) || !text(row.label, 2000)) unconfirmed();
      return { id: row.id, name: row.label,
        ...(row.license_plate ? { plate: String(row.license_plate) } : {}),
        ...(row.branch_id && isUuid(row.branch_id) ? { branchId: row.branch_id } : {}),
        ...(typeof row.status === "string" ? { status: row.status } : {}) };
    }), ...(office ? { members: workspace.members.filter(row => row.active && row.capabilities.includes("drive")).slice(0, 200)
      .map(row => reference({ id: row.id, name: row.displayName })) } : {}) };
}
