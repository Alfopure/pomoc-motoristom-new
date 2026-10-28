import "server-only";
import type { TowingCapability, TowingMember, TowingRole } from "@/domain/towing/types";
import type { Json } from "@/lib/supabase/database.types";
import type {
  MobileOperation, MobileOperationAction, MobileOperationCommand, MobileOperationEvidence, MobileOperationEvidenceInput,
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
import { readDeliveryPosition } from "./delivery";
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
    if (match) throw new MutationError(match[2], match[1], "work_refused");
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
  [/Driver physically busy|Driver capacity conflict/, 409, "Máte rozpracovanú inú prácu. Najprv ju dokončite."],
  [/Fresh free source required/, 409, "Vozidlo podľa evidencie nie je voľné. Kontaktujte dispečera."],
  [/Interval required/, 409, "Plánovaný koniec jazdy už uplynul. Požiadajte dispečera o nový termín."],
  [/Assignment revoked/, 403, "Jazda vám už nie je pridelená."],
  [/Assignment required/, 409, "Tento krok teraz nie je možný. Načítajte jazdu znova."],
  [/Terminal operation/, 409, "Jazda je už ukončená."],
  [/Invalid transition/, 409, "Tento krok teraz nie je možný. Načítajte jazdu znova."],
  [/Revision conflict|Command conflict/, 409, "Jazda sa medzitým zmenila. Načítajte ju znova a krok zopakujte."],
  [/Confirmed fleet asset required/, 400, "Poškodenie možno nahlásiť až pri potvrdenom vozidle. Kontaktujte dispečera."],
  [/Damage description and resolver required/, 400, "Pri poškodení opíšte, čo sa stalo, a uveďte, kto ho vyrieši."],
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
export function projectOperation(value: unknown, memberId: string, instructions: string | null = null): MobileOperation {
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
    instructions: open ? instructions : null, vehicleConfirmed: typeof op.fleetAssetId === "string" && isUuid(op.fleetAssetId),
    evidenceState: op.evidenceState === "complete" ? "complete" : "pending", evidence: op.evidence.map(projectEvidence),
  };
}
type OperationContext = { legacy: boolean; instructions: string | null };
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
type WorkspaceRow = { id: string; owner?: unknown; status?: unknown };
const LEGACY = "Toto pristavenie nájdete v module Pristavenia.";
/** Own logistics work, without legacy deliveries; an id the context does not confirm as this member's is not shown. */
async function ownOperations(actor: MobileFieldActor, filters: Record<string, unknown>): Promise<{ rows: WorkspaceRow[]; context: Map<string, OperationContext>; legacy: Set<string> }> {
  const workspace = await operationsWorkspaceFor(actor, { ...filters, mine: true });
  if (!workspace || !Array.isArray(workspace.operations)) unconfirmed();
  // A legacy draft keeps its former recipient; it is nobody's work until assigned again.
  const rows = (workspace.operations as WorkspaceRow[]).filter(row => row.owner === "logistics" && row.status !== "draft");
  const context = await operationContext(actor, rows.map(row => row.id));
  const legacy = new Set(rows.filter(row => context.get(row.id)?.legacy !== false).map(row => row.id));
  return { rows: rows.filter(row => !legacy.has(row.id)), context, legacy };
}
export async function loadFieldOperations(actor: MobileFieldActor): Promise<MobileOperation[] | null> {
  if (!actor.capabilities.includes("deliver")) return null;
  const { rows, context } = await ownOperations(actor, { view: "open", limit: 100 });
  // One operation that cannot be shown must not hide the others.
  const operations = rows.flatMap(row => { try { return [projectOperation(row, actor.memberId, context.get(row.id)?.instructions ?? null)]; } catch { return []; } });
  if (operations.length < rows.length) console.warn(JSON.stringify({ event: "mobile.work", skipped: rows.length - operations.length }));
  return operations;
}
async function ownOperation(actor: MobileFieldActor, operationId: string): Promise<{ row: WorkspaceRow; instructions: string | null }> {
  const own = await ownOperations(actor, { id: operationId });
  if (own.legacy.has(operationId)) throw new MutationError(LEGACY, 404, "work_in_deliveries");
  const row = own.rows.find(item => item.id === operationId);
  if (!row) throw new MutationError("Jazda už nie je dostupná. Dispečer ju mohol zrušiť alebo prideliť inému.", 404);
  return { row, instructions: own.context.get(operationId)?.instructions ?? null };
}
export async function readFieldOperation(actor: MobileFieldActor, id: string): Promise<MobileOperation> {
  requireDeliver(actor);
  const { row, instructions } = await ownOperation(actor, pathId(id, "Jazda sa nenašla."));
  return projectOperation(row, actor.memberId, instructions);
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
  const receipt = await commandOperationFor(actor, { ...command, operationId, payload: command.payload as Record<string, unknown> }, refiner(operationRefusals));
  if (!receipt || String(receipt.commandId).toLowerCase() !== command.commandId || !positive(receipt.committedRevision)) unconfirmed();
  // The receipt carries no customer contact; the fresh read does, while it is still assigned.
  const fresh = await ownOperation(actor, operationId).then(own => projectOperation(own.row, actor.memberId, own.instructions)).catch(() => null);
  const operation = fresh && fresh.revision >= receipt.committedRevision ? fresh : projectOperation(receipt.operation, actor.memberId);
  return { commandId: command.commandId, committedRevision: receipt.committedRevision, operation };
}
export async function uploadFieldOperationFile(actor: MobileFieldActor, id: string, request: Request): Promise<{ reference: string }> {
  requireDeliver(actor);
  return uploadOperationFile(pathId(id, "Jazda sa nenašla."), request, { userId: actor.userId, organizationId: actor.organizationId, memberId: actor.memberId });
}
/** Stored only while the member's own operation is accepted and open; the database decides and throttles. */
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

// --- Odťahy -----------------------------------------------------------------

const SERVICE_TYPES = ["tow", "repair", "transport", "storage", "relocation"];
const SUBJECT_TYPES = ["vehicle", "machine", "material"];
const TOWING_STATUSES = ["assigned", "in_progress", "needs_changes"];
const ATTACHMENT_KINDS = ["work", "handover", "scan"];
const DRIVER_FIELDS = ["startedAt", "finishedAt", "driverNotes", "performedQuantity", "photoException", "destination"] as const;
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
  [/Completion incomplete/, 400, "Doplňte začiatok a koniec práce a cieľ. Ostatné údaje zákazky doplní kancelária."],
  [/Confirm actual work time/, 400, "Potvrďte skutočný začiatok práce."],
  [/Uploads pending/, 409, "Počkajte, kým sa dokončí nahrávanie príloh."],
  [/Storage requires an identified parking site/, 400, "Uskladnenie potrebuje parkovisko; doplní ho kancelária."],
  [/Driver physically busy/, 409, "Máte rozpracovaný iný odťah. Najprv ho odovzdajte."],
  [/Driver capacity conflict/, 409, "Máte rozbehnutú inú jazdu. Najprv ju dokončite."],
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
/** Allowlisted driver projection: work fields and attachments; no cents, payments, office notes or other parties. */
export function projectTowingOrder(value: unknown, memberId: string): MobileTowingOrder {
  const order = record(value), fields = record(order.fields);
  if (typeof order.id !== "string" || !isUuid(order.id) || !text(order.number, 64) || !positive(order.revision) || !positive(order.assignmentGeneration)
    || String(order.driverId ?? "").toLowerCase() !== memberId || !TOWING_STATUSES.includes(order.workStatus as string) || !isHistoryTimestamp(order.updatedAt)
    || !SERVICE_TYPES.includes(fields.serviceType as string) || !SUBJECT_TYPES.includes(fields.subjectType as string)
    || !text(fields.subjectDescription ?? "", 10_000) || !text(fields.pickup ?? "", 10_000)
    || !(fields.startSource === undefined || fields.startSource === "assignment" || fields.startSource === "manual") || !Array.isArray(order.attachments) || order.attachments.length > 60) unconfirmed();
  const party = fields.customer && typeof fields.customer === "object" ? fields.customer as Record<string, unknown> : null;
  const projected: MobileTowingFields = {
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
  if (typeof body.commandId !== "string" || !isUuid(body.commandId) || !["start", "update_order", "submit", "abandon_attachment"].includes(body.type as string)
    || !positive(body.expectedRevision) || !positive(body.assignmentGeneration)) invalid("Neplatný krok zákazky.");
  const payload = input(body.payload, "Neplatný krok zákazky.");
  const base = { commandId: body.commandId.toLowerCase(), type: body.type as MobileTowingCommand["type"], expectedRevision: body.expectedRevision, assignmentGeneration: body.assignmentGeneration };
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
  onlyKeys(fields, DRIVER_FIELDS, "Tieto údaje zákazky doplní kancelária.");
  if (!Object.keys(fields).length) invalid("Nie je čo uložiť.");
  const out: MobileTowingDriverFields = {};
  for (const key of DRIVER_FIELDS) {
    if (!(key in fields)) continue;
    const raw = fields[key];
    if (raw !== null && (typeof raw !== "string" || raw.length > 4000)) invalid("Skontrolujte dĺžku údajov zákazky.");
    const valueText = typeof raw === "string" ? raw.trim() || null : null;
    if ((key === "startedAt" || key === "finishedAt") && valueText !== null && (!isHistoryTimestamp(valueText) || Date.parse(valueText) > Date.now() + 5 * 60_000)) invalid("Čas práce nie je platný.");
    out[key] = valueText;
  }
  if (out.startedAt && out.finishedAt && Date.parse(out.finishedAt) < Date.parse(out.startedAt)) invalid("Koniec práce nemôže byť pred jej začiatkom.");
  return { ...base, payload: { fields: out } };
}
export async function commandFieldTowing(actor: MobileFieldActor, id: string, value: unknown): Promise<{ commandId: string; revision: number; order: MobileTowingOrder | null }> {
  requireDrive(actor);
  const orderId = pathId(id, "Zákazka sa nenašla."), command = readTowingCommand(value);
  // The assignment generation keeps the RPC on the driver's own-assignment path.
  const parsed = parseTowingCommand({ ...command, targetId: orderId });
  const result = await executeTowingCommand(towingMember(actor), parsed, refiner(towingRefusals));
  if (String(result.commandId).toLowerCase() !== command.commandId || !positive(result.revision)) unconfirmed();
  // null only when the order really left the list; a failed read leaves the step to be confirmed again (it replays).
  return { commandId: command.commandId, revision: result.revision, order: await ownOrder(actor, orderId) };
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
