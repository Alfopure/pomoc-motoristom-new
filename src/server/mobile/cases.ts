import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCaseDetailSnapshot } from "@/data/case-detail-repository";
import { mapCase } from "@/data/dispatch-repository";
import { compareCaseRevisions, type CaseDetailData } from "@/data/case-detail";
import { jobTypeLabels } from "@/domain/case-card";
import { casePriorityLabels, caseStatusLabels, isMobileCaseStatus, isMobileCasePriority, isClosedCaseStatus, MOBILE_CLOSED_CASE_STATUSES } from "@/lib/mobile-case-filters";
import type { MobileCaseCreateInput, MobileCaseCreated, MobileCaseDetailData, MobileCaseDispatcher, MobileCaseFilter, MobileCaseSummary, MobileCaseUpdateInput, MobileCaseUpdated, MobileCaseUpdateStatus } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { isHistoryTimestamp } from "@/lib/telephony/call-history-query";
import { isUuid } from "@/lib/telephony/uuid";
import type { MotoristActor } from "@/server/api-auth";
import { CaseCreationCommittedError, createCase, updateCase } from "@/server/motorist-mutations";
import { MutationError } from "@/server/mutation-error";
import { humansOnly } from "@/server/profile-kind";
import { readMobileJsonBody } from "./body";
import { mobileCaseMap, mobileLocationChanges, parseMobilePlaceSelection } from "./case-locations";

type Admin = SupabaseClient<Database>;
type CaseRow = Database["public"]["Tables"]["motorist_cases"]["Row"];
type Selection = Pick<MobileCaseFilter, "ownership" | "category" | "q"> & Required<Pick<MobileCaseFilter, "ownerId" | "status" | "priority">>;
type Cursor = { createdAt: string; id: string; selection: string };
export type MobileCaseQuery = Selection & { limit: number; cursor: Cursor | null };
const UPDATE_STATUSES = ["open", "completed_assisted", "completed_no_assistance", "waiting_for_docs", "cancelled", "futile_trip"] as const satisfies readonly MobileCaseUpdateStatus[];
const SEARCH_LIMIT = 100;
const DISPATCHER_LIMIT = 200;
const DISPATCHER_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
const STRING_LIMITS = { contactName: 200, contactPhone: 64, licensePlate: 32, vehicleMake: 80, vehicleModel: 120,
  manualPickupAddress: 500, manualDestinationAddress: 500, incidentDescription: 5000, note: 10000 } as const;

function badInput(message = "Neplatné údaje prípadu."): never { throw new MutationError(message, 400); }

export function parseMobileCaseQuery(params: URLSearchParams): MobileCaseQuery {
  const allowed = new Set(["ownership", "category", "q", "cursor", "limit", "ownerId", "status", "priority"]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) badInput("Neplatný filter prípadov.");
  const ownership = params.get("ownership") ?? "all", category = params.get("category") ?? "open";
  if (ownership !== "mine" && ownership !== "all" && ownership !== "unassigned" || category !== "open" && category !== "all") badInput("Neplatný filter prípadov.");
  const ownerId = params.get("ownerId");
  if (ownerId !== null && (ownership !== "all" || !isUuid(ownerId))) badInput("Neplatný filter dispečera.");
  const status = params.get("status"), priority = params.get("priority");
  if (status !== null && !isMobileCaseStatus(status) || priority !== null && !isMobileCasePriority(priority)) badInput("Neplatný stav alebo priorita prípadu.");
  if (category === "open" && isClosedCaseStatus(status)) badInput("Ukončený stav vyžaduje zobrazenie všetkých prípadov.");
  const q = (params.get("q") ?? "").trim();
  if (q.length > 120 || /[\u0000-\u001f]/.test(q)) badInput("Vyhľadávanie môže mať najviac 120 znakov.");
  const rawLimit = params.get("limit") ?? "25";
  if (!/^[1-9]\d?$/.test(rawLimit) || Number(rawLimit) > 25) badInput("Neplatná veľkosť stránky.");
  let cursor: Cursor | null = null;
  const raw = params.get("cursor");
  if (raw) {
    try {
      if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      if (!value || value.v !== 1 || !isUuid(value.id) || !isHistoryTimestamp(value.createdAt) ||
        typeof value.selection !== "string" || !/^[a-f0-9]{64}$/.test(value.selection)) throw new Error();
      cursor = { id: value.id, createdAt: value.createdAt, selection: value.selection };
    } catch { badInput("Stránka prípadov už nie je platná. Obnovte zoznam."); }
  }
  return { ownership, category, q, ownerId, status, priority, limit: Number(rawLimit), cursor };
}

function selectionKey(actor: MotoristActor, query: Selection) {
  const scope = [actor.organizationId, actor.profileId, query.ownership, query.category, query.q];
  // Keep existing unfiltered cursors valid for clients that send explicit ownership.
  if (query.ownerId) scope.push(query.ownerId);
  if (query.status !== null || query.priority !== null) scope.push("case-filters-v1", "status", query.status ?? "", "priority", query.priority ?? "");
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

function caseDispatchers(admin: Admin, actor: MotoristActor, signal: AbortSignal) {
  return humansOnly(admin.from("motorist_profiles").select("id,display_name,active")
    .eq("organization_id", actor.organizationId).in("role", DISPATCHER_ROLES)).abortSignal(signal);
}

export async function listMobileCaseDispatchers(actor: MotoristActor, signal?: AbortSignal, admin: Admin = createSupabaseAdminClient()): Promise<MobileCaseDispatcher[]> {
  const deadline = AbortSignal.timeout(8_000), abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const { data, error } = await caseDispatchers(admin, actor, abort)
    .order("display_name").order("id").limit(DISPATCHER_LIMIT + 1);
  if (error) throw new MutationError("Dispečerov sa nepodarilo načítať.", 503);
  if ((data?.length ?? 0) > DISPATCHER_LIMIT) throw new MutationError("Zoznam dispečerov je príliš veľký. Kontaktujte správcu.", 503, "case_dispatchers_limit");
  return (data ?? []).map(profile => ({ id: profile.id, name: profile.display_name, active: profile.active }));
}

function filteredCases(admin: Admin, actor: MotoristActor, query: Selection, signal: AbortSignal) {
  let read = admin.from("motorist_cases").select("*").eq("organization_id", actor.organizationId).abortSignal(signal);
  if (query.ownership === "mine") read = read.eq("owner_id", actor.profileId);
  else if (query.ownership === "unassigned") read = read.is("owner_id", null);
  else if (query.ownerId) read = read.eq("owner_id", query.ownerId);
  if (query.category === "open") for (const status of MOBILE_CLOSED_CASE_STATUSES) read = read.neq("status", status);
  if (query.status !== null) read = read.eq("status", query.status);
  if (query.priority !== null) read = read.eq("priority", query.priority);
  return read;
}

/** Separate parameterized filters avoid interpolating user text in PostgREST OR grammar. */
async function searchCaseIds(admin: Admin, actor: MotoristActor, query: Selection, signal: AbortSignal): Promise<string[] | null> {
  if (!query.q) return null;
  const pattern = `%${query.q.replace(/[\\%_]/g, character => `\\${character}`)}%`;
  const [numbers, summaries, names, phones, plates] = await Promise.all([
    filteredCases(admin, actor, query, signal).ilike("case_number", pattern).limit(SEARCH_LIMIT + 1).select("id"),
    filteredCases(admin, actor, query, signal).ilike("summary", pattern).limit(SEARCH_LIMIT + 1).select("id"),
    admin.from("motorist_contacts").select("id").eq("organization_id", actor.organizationId).ilike("name", pattern).limit(SEARCH_LIMIT + 1).abortSignal(signal),
    admin.from("motorist_contacts").select("id").eq("organization_id", actor.organizationId).ilike("phone", pattern).limit(SEARCH_LIMIT + 1).abortSignal(signal),
    admin.from("motorist_vehicles").select("id").eq("organization_id", actor.organizationId).ilike("license_plate", pattern).limit(SEARCH_LIMIT + 1).abortSignal(signal),
  ]);
  const results = [numbers, summaries, names, phones, plates];
  if (results.some(result => result.error)) throw new MutationError("Prípady sa nepodarilo vyhľadať.", 503);
  if (results.some(result => (result.data?.length ?? 0) > SEARCH_LIMIT)) badInput("Vyhľadávanie je príliš široké. Spresnite text.");
  const contacts = [...new Set([...(names.data ?? []), ...(phones.data ?? [])].map(row => row.id))];
  const vehicles = (plates.data ?? []).map(row => row.id);
  if (contacts.length > SEARCH_LIMIT) badInput("Vyhľadávanie je príliš široké. Spresnite text.");
  const [contactCases, vehicleCases] = await Promise.all([
    contacts.length ? filteredCases(admin, actor, query, signal).in("contact_id", contacts).limit(SEARCH_LIMIT + 1).select("id") : { data: [], error: null },
    vehicles.length ? filteredCases(admin, actor, query, signal).in("vehicle_id", vehicles).limit(SEARCH_LIMIT + 1).select("id") : { data: [], error: null },
  ]);
  if (contactCases.error || vehicleCases.error) throw new MutationError("Prípady sa nepodarilo vyhľadať.", 503);
  const ids = [...new Set([...(numbers.data ?? []), ...(summaries.data ?? []), ...(contactCases.data ?? []), ...(vehicleCases.data ?? [])].map(row => row.id))];
  if (ids.length > SEARCH_LIMIT) badInput("Vyhľadávanie je príliš široké. Spresnite text.");
  return ids;
}

export function mobileCaseSummary(detail: CaseDetailData, actor: MotoristActor): MobileCaseSummary {
  const primary = detail.customerDetails.contacts?.find(contact => contact.isPrimary) ?? detail.customerDetails.contacts?.[0];
  return { id: detail.id, caseNumber: detail.caseNumber, status: detail.status, statusLabel: caseStatusLabels[detail.status],
    priority: detail.priority, priorityLabel: casePriorityLabels[detail.priority],
    owner: { id: detail.ownerId === "unassigned" ? null : detail.ownerId, name: detail.ownerName ?? null, mine: detail.ownerId === actor.profileId },
    contact: { name: primary?.name || detail.contact.name || null, phone: primary?.phone || detail.contact.phone || null },
    vehicle: { licensePlate: detail.vehicle.licensePlate || null, description: [detail.vehicle.make, detail.vehicle.model].filter(Boolean).join(" ") || null },
    pickupAddress: detail.pickup?.address ?? detail.locationDetails.manualPickupAddress ?? null,
    destinationAddress: detail.destination?.address ?? detail.locationDetails.manualDestinationAddress ?? null,
    summary: detail.summary, createdAt: detail.createdAt, updatedAt: detail.updatedAt };
}

export async function listMobileCases(actor: MotoristActor, query: MobileCaseQuery, signal?: AbortSignal, admin: Admin = createSupabaseAdminClient()) {
  const deadline = AbortSignal.timeout(8_000), abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const key = selectionKey(actor, query);
  if (query.cursor && query.cursor.selection !== key) badInput("Stránka patrí inému filtru. Obnovte zoznam.");
  if (query.ownerId) {
    const { data, error } = await caseDispatchers(admin, actor, abort).eq("id", query.ownerId).maybeSingle();
    if (error) throw new MutationError("Dispečera sa nepodarilo overiť.", 503);
    if (!data) badInput("Vybraný dispečer sa nenašiel.");
  }
  const ids = await searchCaseIds(admin, actor, query, abort);
  const selection = { ownership: query.ownership, category: query.category, q: query.q, ownerId: query.ownerId, status: query.status, priority: query.priority };
  if (ids?.length === 0) return { cases: [], nextCursor: null, selection };
  const page = () => {
    let read = filteredCases(admin, actor, query, abort);
    if (ids) read = read.in("id", ids);
    return read.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
  };
  // Two bounded reads express the lexicographic cursor without raw OR syntax.
  // Preserve database microseconds rather than round-tripping through Date.
  const pages = query.cursor ? await Promise.all([
    page().eq("created_at", query.cursor.createdAt).lt("id", query.cursor.id),
    page().lt("created_at", query.cursor.createdAt),
  ]) : [await page()];
  if (pages.some(result => result.error)) throw new MutationError("Prípady sa nepodarilo načítať.", 503);
  const rows = pages.flatMap(result => result.data ?? []).slice(0, query.limit + 1);
  const selected = rows.slice(0, query.limit);
  const unique = (field: "contact_id" | "vehicle_id" | "owner_id" | "pickup_location_id" | "destination_location_id") =>
    [...new Set(selected.map(row => row[field]).filter((id): id is string => Boolean(id)))];
  const contacts = unique("contact_id"), vehicles = unique("vehicle_id"), owners = unique("owner_id");
  const locations = [...new Set([...unique("pickup_location_id"), ...unique("destination_location_id")])];
  const [contactRows, vehicleRows, locationRows, profileRows] = await Promise.all([
    contacts.length ? admin.from("motorist_contacts").select("*").eq("organization_id", actor.organizationId).in("id", contacts).abortSignal(abort) : { data: [], error: null },
    vehicles.length ? admin.from("motorist_vehicles").select("*").eq("organization_id", actor.organizationId).in("id", vehicles).abortSignal(abort) : { data: [], error: null },
    locations.length ? admin.from("motorist_locations").select("*").eq("organization_id", actor.organizationId).in("id", locations).abortSignal(abort) : { data: [], error: null },
    owners.length ? admin.from("motorist_profiles").select("*").eq("organization_id", actor.organizationId).in("id", owners).abortSignal(abort) : { data: [], error: null },
  ]);
  if ([contactRows, vehicleRows, locationRows, profileRows].some(result => result.error)) throw new MutationError("Súvisiace údaje prípadov sa nepodarilo načítať.", 503);
  const context = { contactsById: new Map((contactRows.data ?? []).map(row => [row.id, row])),
    vehiclesById: new Map((vehicleRows.data ?? []).map(row => [row.id, row])), locationById: new Map((locationRows.data ?? []).map(row => [row.id, row])),
    profilesById: new Map((profileRows.data ?? []).map(row => [row.id, row])), tasks: [], events: [] };
  const last = selected.at(-1);
  return { cases: selected.map(caseRow => mobileCaseSummary(mapCase({ ...context, caseRow }), actor)), selection,
    nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({ v: 1, id: last.id, createdAt: last.created_at, selection: key })).toString("base64url") : null };
}

export async function getMobileCase(actor: MotoristActor, id: string, signal?: AbortSignal, admin: Admin = createSupabaseAdminClient()): Promise<MobileCaseDetailData> {
  if (!isUuid(id)) badInput("Neplatný prípad.");
  const snapshot = await loadCaseDetailSnapshot(id, actor, signal, admin),
    detail = snapshot.detail;
  const summary = mobileCaseSummary(detail, actor);
  return { ...summary, mainNote: detail.mainNote, incidentDescription: detail.incidentDetails.description ?? null, map: mobileCaseMap(snapshot),
    editable: { contactName: summary.contact.name ?? "", contactPhone: summary.contact.phone ?? "", licensePlate: detail.vehicle.licensePlate,
      vehicleMake: detail.vehicle.make, vehicleModel: detail.vehicle.model, manualPickupAddress: summary.pickupAddress ?? "",
      manualDestinationAddress: summary.destinationAddress ?? "", incidentDescription: detail.incidentDetails.description ?? "",
      note: detail.mainNote, priority: detail.priority, jobTypes: detail.jobTypes, status: detail.status },
    statusOptions: UPDATE_STATUSES.map(value => ({ value, label: caseStatusLabels[value] })),
    jobTypeLabels: detail.jobTypes.map(type => jobTypeLabels[type]),
    timeline: detail.timeline.slice(0, 50).map(event => ({ id: event.id, title: event.title, body: event.body || null, createdAt: event.time, actorName: event.actor || null })) };
}

export function parseMobileCaseCreate(value: unknown): MobileCaseCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) badInput();
  const input: MobileCaseCreateInput = {};
  for (const [key, field] of Object.entries(value)) {
    if (Object.hasOwn(STRING_LIMITS, key)) {
      const name = key as keyof typeof STRING_LIMITS;
      if (typeof field !== "string" || field.length > STRING_LIMITS[name] || field.includes("\0")) badInput(`Neplatné pole: ${name}.`);
      input[name] = field.trim();
    } else if (key === "pickup" || key === "destination") {
      input[key] = parseMobilePlaceSelection(field);
    } else if (key === "priority") {
      if (typeof field !== "string" || !Object.hasOwn(casePriorityLabels, field)) badInput("Neplatná priorita.");
      input.priority = field as MobileCaseCreateInput["priority"];
    } else if (key === "jobTypes") {
      if (!Array.isArray(field) || field.length > 4 || field.some(item => typeof item !== "string" || !Object.hasOwn(jobTypeLabels, item)) || new Set(field).size !== field.length) badInput("Neplatné typy zákazky.");
      input.jobTypes = field;
    } else badInput("Formulár obsahuje nepovolené pole.");
  }
  if (input.pickup !== undefined && input.manualPickupAddress !== undefined
    || input.destination !== undefined && input.manualDestinationAddress !== undefined) badInput("Pre jedno miesto vyberte mapu alebo ručnú adresu.");
  return input;
}

export function parseMobileCaseUpdate(value: unknown): MobileCaseUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) badInput();
  const { expectedUpdatedAt, mutationId, status, ...fields } = value as Record<string, unknown>;
  if (expectedUpdatedAt === undefined) throw new MutationError("Pred uložením načítajte aktuálnu revíziu prípadu.", 428, "CASE_REVISION_REQUIRED");
  if (!isHistoryTimestamp(expectedUpdatedAt)) badInput("Neplatná revízia prípadu.");
  if (typeof mutationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mutationId)) badInput("Neplatná identita uloženia.");
  if (status !== undefined && !UPDATE_STATUSES.includes(status as MobileCaseUpdateStatus)) badInput("Neplatný stav prípadu.");
  const changes = parseMobileCaseCreate(fields);
  if (!Object.keys(changes).length && status === undefined) badInput("Vyberte údaje na úpravu.");
  return { ...changes, expectedUpdatedAt, mutationId, ...(status !== undefined ? { status: status as MobileCaseUpdateStatus } : {}) };
}

export async function readMobileCaseCreate(request: Request): Promise<MobileCaseCreateInput> {
  return parseMobileCaseCreate(await readMobileJsonBody(request));
}

export async function readMobileCaseUpdate(request: Request): Promise<MobileCaseUpdateInput> {
  return parseMobileCaseUpdate(await readMobileJsonBody(request));
}

export async function updateMobileCase(actor: MotoristActor, id: string, input: MobileCaseUpdateInput): Promise<Pick<MobileCaseUpdated, "caseId" | "mutationId" | "committedRevision" | "warnings" | "refreshRequired">> {
  if (!isUuid(id)) badInput("Neplatný prípad.");
  const parsed = parseMobileCaseUpdate(input);
  // A manual address replaces the old mapped location. Presence, including clearing,
  // produces the same payload on replay; omitted addresses keep their references.
  const changes = mobileLocationChanges(parsed);
  try {
    const { caseRow, warnings } = await updateCase(id, changes, actor.profileId, actor.organizationId, { synchronizePrimaryContact: true });
    if (!caseRow || caseRow.id !== id || caseRow.organization_id !== actor.organizationId || !isHistoryTimestamp(caseRow.updated_at)
      || compareCaseRevisions(caseRow.updated_at, parsed.expectedUpdatedAt) < 0) {
      throw new MutationError("Výsledok uloženia sa nepodarilo overiť.", 503, "CASE_SAVE_UNCONFIRMED");
    }
    return { caseId: id, mutationId: parsed.mutationId, committedRevision: caseRow.updated_at, warnings, refreshRequired: true };
  } catch (error) {
    if (error instanceof MutationError && (error.status < 500 || error.code === "CASE_SAVE_UNCONFIRMED")) throw error;
    throw new MutationError("Výsledok uloženia sa nepodarilo overiť. Overte tú istú požiadavku znova.", 503, "CASE_SAVE_UNCONFIRMED");
  }
}

export async function createMobileCase(actor: MotoristActor, input: MobileCaseCreateInput): Promise<Pick<MobileCaseCreated, "caseId" | "caseNumber" | "warnings">> {
  const parsed = parseMobileCaseCreate(input);
  let result: { caseRow: CaseRow; warnings: MobileCaseCreated["warnings"] };
  try { result = await createCase(mobileLocationChanges(parsed), actor.profileId, actor.organizationId); }
  catch (error) {
    if (!(error instanceof CaseCreationCommittedError)) {
      if (error instanceof MutationError && error.status < 500) throw error;
      throw new MutationError("Uloženie sa nepodarilo potvrdiť. Pred ďalším pokusom skontrolujte zoznam prípadov.", 503, "case_create_uncertain");
    }
    console.error("Mobile case bookkeeping incomplete", { caseId: error.caseRow.id, organizationId: actor.organizationId, phase: error.phase });
    result = { caseRow: error.caseRow, warnings: [...error.warnings, { code: "case_history_incomplete", field: "case", message: "Prípad je uložený, ale jeho história alebo audit nie sú úplné. Nevytvárajte ho znovu." }] };
  }
  if (result.caseRow.organization_id !== actor.organizationId || result.caseRow.owner_id !== actor.profileId) throw new MutationError("Uloženie prípadu sa nepodarilo overiť.", 503, "case_create_uncertain");
  return { caseId: result.caseRow.id, caseNumber: result.caseRow.case_number, warnings: result.warnings };
}
