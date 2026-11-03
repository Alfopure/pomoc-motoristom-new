import type { MobileCaseOverview, MobileCaseCreated, MobileCaseCreateInput, MobileCaseDetail, MobileCaseDispatchers, MobileCaseFilter, MobileCaseNoteInput, MobileCaseNoteAdded, MobileCases, MobileCaseSummary, MobileCaseUpdateInput, MobileCaseUpdated, MobileScope, MobileCaseOwnerContext, MobileCaseOwnerInput, MobileCaseOwnerAssigned } from "../../../src/lib/mobile-api";
import { isMobileCaseStatus, isMobileCasePriority, isClosedCaseStatus } from "../../../src/lib/mobile-case-filters";
import { MobileApiError, type MobileTransport } from "../lib/api";
import { createHandoffApi } from "../handoff/api";
import { createWorkApi } from "../work/api";
import type { MapRequest, MapSource } from "./map-bridge";
import { draftDate } from "../drafts/port";
import { caseMap, compareRevisions } from "./location";
import type { MobileConfig } from "../lib/config";

const invalid = () => new MobileApiError("Odpoveď prípadov sa nepodarilo overiť. Obnovte údaje.", 502);
const isText = (value: unknown): value is string => typeof value === "string";
const isNullableText = (value: unknown): value is string | null => value === null || isText(value);
const isId = (value: unknown): value is string => isText(value) && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const isDate = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function summary(value: unknown): MobileCaseSummary {
  const item = object(value), owner = object(item.owner), contact = object(item.contact), vehicle = object(item.vehicle);
  if (!isId(item.id) || !isText(item.caseNumber) || !item.caseNumber || !isText(item.status) || !item.status
    || !isText(item.statusLabel) || !isText(item.priorityLabel) || !isText(item.priority) || !["urgent", "high", "normal", "low"].includes(item.priority)
    || !(owner.id === null || isId(owner.id)) || !isNullableText(owner.name) || typeof owner.mine !== "boolean"
    || !isNullableText(contact.name) || !isNullableText(contact.phone) || !isNullableText(vehicle.licensePlate) || !isNullableText(vehicle.description)
    || !isNullableText(item.pickupAddress) || !isNullableText(item.destinationAddress) || !isText(item.summary)
    || !isDate(item.createdAt) || !isDate(item.updatedAt)) throw invalid();
  return { id: item.id, caseNumber: item.caseNumber, status: item.status, statusLabel: item.statusLabel,
    priority: item.priority as MobileCaseSummary["priority"], priorityLabel: item.priorityLabel,
    owner: { id: owner.id, name: owner.name, mine: owner.mine }, contact: { name: contact.name, phone: contact.phone },
    vehicle: { licensePlate: vehicle.licensePlate, description: vehicle.description }, pickupAddress: item.pickupAddress,
    destinationAddress: item.destinationAddress, summary: item.summary, createdAt: item.createdAt, updatedAt: item.updatedAt };
}

function warnings(value: unknown): MobileCaseCreated["warnings"] {
  if (!Array.isArray(value) || value.length > 50) throw invalid();
  return value.map(value => {
    const warning = object(value);
    if (!isText(warning.code) || !isText(warning.field) || !isText(warning.message)) throw invalid();
    return { code: warning.code, field: warning.field, message: warning.message };
  });
}

export function createCasesApi(config: MobileConfig, profileId: string, getToken: () => Promise<string | null>, transport: MobileTransport = fetch, expectedOrganization?: string) {
  if (expectedOrganization !== undefined && !isId(expectedOrganization)) throw new MobileApiError("Organizáciu sa nepodarilo overiť.", 400);
  function scope(body: Record<string, unknown>): MobileScope {
    if (body.ok !== true || body.apiVersion !== 1 || body.environment !== config.environment || body.profileId !== profileId || !isDate(body.checkedAt)) throw invalid();
    return { ok: true, apiVersion: 1, environment: config.environment, profileId, checkedAt: body.checkedAt };
  }
  async function request(path: string, input?: MobileCaseCreateInput | MobileCaseUpdateInput | MobileCaseNoteInput | MobileCaseOwnerInput, signal?: AbortSignal, method?: "PATCH") {
    const token = await getToken();
    if (!token) throw new MobileApiError("Prihláste sa do aplikácie.", 401);
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20_000);
    try {
      const response = await transport(config.apiOrigin + "/api/mobile/v1/cases" + path, {
        method: method ?? (input === undefined ? "GET" : "POST"), credentials: "omit", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, Accept: "application/json",
          ...(expectedOrganization ? { "X-PM-Expected-Organization": expectedOrganization } : {}),
          ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      let value: unknown;
      try { value = await response.json(); } catch { throw invalid(); }
      const body = object(value);
      if (!response.ok) throw new MobileApiError(isText(body.error) ? body.error : "Prípady sa nepodarilo načítať.", response.status, isText(body.code) ? body.code : undefined);
      scope(body);
      return body;
    } catch (error) {
      if (error instanceof MobileApiError || signal?.aborted) throw error;
      throw new MobileApiError("Spojenie sa prerušilo. Skontrolujte pripojenie.", 0);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  return {
    mapSource: async (input: MapRequest, signal?: AbortSignal): Promise<MapSource> => {
      if (!expectedOrganization || !isId(input.nonce) || !(input.caseId === null || isId(input.caseId)) || !["view", "pick"].includes(input.mode) || !["pickup", "destination"].includes(input.target)) throw new MobileApiError("Mapu sa nepodarilo bezpečne pripraviť.", 400);
      const token = await getToken();
      if (signal?.aborted) throw new MobileApiError("Mapa bola zatvorená.", 0);
      if (!token) throw new MobileApiError("Prihláste sa do aplikácie.", 401);
      return { uri: config.apiOrigin + "/api/mobile/v1/maps/picker" + (input.caseId ? "?caseId=" + input.caseId : ""),
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, "X-PM-Expected-Organization": expectedOrganization,
          "X-PM-Map-Mode": input.mode, "X-PM-Map-Target": input.target, "X-PM-Map-Nonce": input.nonce },
        identity: { version: 1, ...input, environment: config.environment, profileId, organizationId: expectedOrganization } };
    },
    work: createWorkApi(config, profileId, getToken, transport, undefined, expectedOrganization),
    handoffs: createHandoffApi(config, profileId, getToken, transport, expectedOrganization),
    list: async (filter: MobileCaseFilter, signal?: AbortSignal): Promise<MobileCases & { requestedAt: number }> => {
      const requestedAt = Date.now();
      const status = filter.status ?? null, priority = filter.priority ?? null;
      if (status !== null && !isMobileCaseStatus(status) || priority !== null && !isMobileCasePriority(priority)
        || status !== null && isClosedCaseStatus(status) && filter.category !== "all") throw new MobileApiError("Vyberte platný stav a prioritu prípadu.", 400);
      const q = filter.q.trim(), ownerId = filter.ownerId ?? null;
      if (ownerId !== null && (!isId(ownerId) || filter.ownership !== "all")) throw new MobileApiError("Vyberte platného dispečera.", 400);
      const params = new URLSearchParams({ ownership: filter.ownership, category: filter.category, q, limit: "25" });
      if (ownerId) params.set("ownerId", ownerId);
      if (status) params.set("status", status);
      if (priority) params.set("priority", priority);
      if (filter.cursor) params.set("cursor", filter.cursor);
      const body = await request("?" + params.toString(), undefined, signal), selection = object(body.selection);
      // Older servers may omit inactive optional filters. Every selected
      // owner, status and priority must be echoed exactly before rows reach the UI.
      if (selection.ownership !== filter.ownership || selection.category !== filter.category || selection.q !== q || (selection.ownerId ?? null) !== ownerId
        || (selection.status ?? null) !== status || (selection.priority ?? null) !== priority
        || !Array.isArray(body.cases) || body.cases.length > 25 || !isNullableText(body.nextCursor)
        || body.nextCursor === "" || (body.nextCursor !== null && body.nextCursor === filter.cursor)) throw invalid();
      const cases = body.cases.map(summary);
      if (cases.some(item => status !== null && item.status !== status || priority !== null && item.priority !== priority)) throw invalid();
      if (filter.ownership === "unassigned" && cases.some(item => item.owner.id !== null || item.owner.mine) || new Set(cases.map(item => item.id)).size !== cases.length || (ownerId !== null && cases.some(item => item.owner.id !== ownerId))) throw invalid();
      return { ...scope(body), requestedAt, cases, nextCursor: body.nextCursor, selection: { ownership: filter.ownership, category: filter.category, q, ownerId, status, priority } };
    },
    overview: async (signal?: AbortSignal): Promise<MobileCaseOverview> => {
      const body = await request("/overview", undefined, signal), counts = object(body.counts);
      const names = ["open", "mine", "unassigned", "urgent"] as const;
      if (names.some(name => typeof counts[name] !== "number" || !Number.isSafeInteger(counts[name]) || (counts[name] as number) < 0)) throw invalid();
      return { ...scope(body), counts: { open: counts.open as number, mine: counts.mine as number, unassigned: counts.unassigned as number, urgent: counts.urgent as number } };
    },
    ownerContext: async (id: string, signal?: AbortSignal): Promise<MobileCaseOwnerContext> => {
      if (!isId(id)) throw new MobileApiError("Prípad sa nenašiel.", 404);
      const body = await request("/" + id + "/owner", undefined, signal), owner = object(body.owner), caps = object(body.capabilities);
      if (body.caseId !== id || !draftDate(body.caseRevision) || typeof body.available !== "boolean"
        || !(owner.id === null || isId(owner.id)) || !isNullableText(owner.name) || typeof owner.mine !== "boolean" || owner.mine !== (owner.id === profileId)
        || typeof caps.take !== "boolean" || typeof caps.assign !== "boolean" || !Array.isArray(body.targets) || body.targets.length > 200
        || !body.available && (caps.take || caps.assign || body.targets.length) || caps.take && owner.id !== null) throw invalid();
      const targets = body.targets.map(value => { const target = object(value);
        if (!isId(target.id) || !isText(target.name) || !target.name.trim() || target.name.length > 320) throw invalid();
        return { id: target.id, name: target.name }; });
      if (new Set(targets.map(item => item.id)).size !== targets.length || caps.take && !targets.some(item => item.id === profileId)) throw invalid();
      return { ...scope(body), caseId: id, caseRevision: body.caseRevision, owner: { id: owner.id, name: owner.name, mine: owner.mine }, available: body.available,
        capabilities: { take: caps.take, assign: caps.assign }, targets };
    },
    assignOwner: async (id: string, input: MobileCaseOwnerInput): Promise<MobileCaseOwnerAssigned> => {
      if (!isId(id) || !isId(input.mutationId) || !isId(input.ownerId) || !draftDate(input.expectedUpdatedAt)) throw new MobileApiError("Neplatné priradenie prípadu.", 400);
      const body = await request("/" + id + "/owner", input);
      if (body.caseId !== id || body.mutationId !== input.mutationId || body.ownerId !== input.ownerId || !draftDate(body.committedRevision)
        || compareRevisions(body.committedRevision, input.expectedUpdatedAt) < 0 || body.refreshRequired !== true) throw invalid();
      return { ...scope(body), caseId: id, mutationId: input.mutationId, ownerId: input.ownerId, committedRevision: body.committedRevision, refreshRequired: true };
    },
    dispatchers: async (signal?: AbortSignal): Promise<MobileCaseDispatchers> => {
      const body = await request("/dispatchers", undefined, signal);
      if (!Array.isArray(body.dispatchers) || body.dispatchers.length > 200) throw invalid();
      const dispatchers = body.dispatchers.map(value => {
        const dispatcher = object(value);
        if (!isId(dispatcher.id) || !isText(dispatcher.name) || !dispatcher.name.trim() || typeof dispatcher.active !== "boolean") throw invalid();
        return { id: dispatcher.id, name: dispatcher.name, active: dispatcher.active };
      });
      if (new Set(dispatchers.map(item => item.id)).size !== dispatchers.length) throw invalid();
      return { ...scope(body), dispatchers };
    },
    detail: async (id: string, signal?: AbortSignal): Promise<MobileCaseDetail> => {
      if (!isId(id)) throw new MobileApiError("Prípad sa nenašiel.", 404);
      const body = await request("/" + encodeURIComponent(id), undefined, signal), item = object(body.case), base = summary(item);
      if (base.id !== id || !isText(item.mainNote) || !isNullableText(item.incidentDescription)
        || !Array.isArray(item.jobTypeLabels) || !item.jobTypeLabels.every(isText) || !Array.isArray(item.timeline) || item.timeline.length > 50) throw invalid();
      const editable = object(item.editable);
      const textFields = ["contactName", "contactPhone", "licensePlate", "vehicleMake", "vehicleModel", "manualPickupAddress", "manualDestinationAddress", "incidentDescription", "note"] as const;
      if (textFields.some(field => !isText(editable[field])) || editable.status !== base.status || editable.priority !== base.priority
        || !Array.isArray(editable.jobTypes) || editable.jobTypes.length > 4 || new Set(editable.jobTypes).size !== editable.jobTypes.length
        || editable.jobTypes.some(value => !isText(value) || !["tow", "replacement_vehicle", "onsite_assistance", "vehicle_recovery"].includes(value))
        || !Array.isArray(item.statusOptions) || item.statusOptions.length !== 6) throw invalid();
      const statusOptions = item.statusOptions.map(value => {
        const option = object(value);
        if (!isText(option.value) || !["open", "completed_assisted", "completed_no_assistance", "waiting_for_docs", "cancelled", "futile_trip"].includes(option.value) || !isText(option.label) || !option.label.trim()) throw invalid();
        return { value: option.value as MobileCaseUpdateInput["status"] & string, label: option.label };
      });
      if (new Set(statusOptions.map(option => option.value)).size !== statusOptions.length) throw invalid();
      const fields = Object.fromEntries(textFields.map(field => [field, editable[field]])) as Required<Omit<MobileCaseCreateInput, "priority" | "jobTypes" | "pickup" | "destination">>;
      const timeline = item.timeline.map(value => {
        const event = object(value);
        if (!isId(event.id) || !isText(event.title) || !isNullableText(event.body) || !isDate(event.createdAt) || !isNullableText(event.actorName)) throw invalid();
        return { id: event.id, title: event.title, body: event.body, createdAt: event.createdAt, actorName: event.actorName };
      });
      let map;
      try { map = item.map === undefined ? undefined : caseMap(item.map); } catch { throw invalid(); }
      return { ...scope(body), case: { ...base, ...(map === undefined ? {} : { map }), mainNote: item.mainNote, incidentDescription: item.incidentDescription, jobTypeLabels: item.jobTypeLabels, editable: { ...fields, status: base.status, priority: base.priority, jobTypes: editable.jobTypes as NonNullable<MobileCaseCreateInput["jobTypes"]> }, statusOptions, timeline } };
    },
    addNote: async (id: string, input: MobileCaseNoteInput): Promise<MobileCaseNoteAdded> => {
      if (!isId(id) || !isId(input.mutationId)) throw new MobileApiError("Chýba platná identita poznámky.", 400);
      const body = await request("/" + encodeURIComponent(id) + "/notes", input);
      if (body.caseId !== id || body.mutationId !== input.mutationId || body.eventId !== input.mutationId || body.refreshRequired !== true) throw invalid();
      return { ...scope(body), caseId: id, mutationId: input.mutationId, eventId: input.mutationId, refreshRequired: true, warnings: warnings(body.warnings) };
    },
    update: async (id: string, input: MobileCaseUpdateInput): Promise<MobileCaseUpdated> => {
      if (!isId(id) || !isId(input.mutationId) || !isDate(input.expectedUpdatedAt)) throw new MobileApiError("Chýba platná identita uloženia alebo revízia prípadu.", 400);
      const body = await request("/" + encodeURIComponent(id), input, undefined, "PATCH");
      if (body.caseId !== id || body.mutationId !== input.mutationId || !isDate(body.committedRevision) || body.refreshRequired !== true) throw invalid();
      return { ...scope(body), caseId: id, mutationId: input.mutationId, committedRevision: body.committedRevision, refreshRequired: true, warnings: warnings(body.warnings) };
    },
    create: async (input: MobileCaseCreateInput): Promise<MobileCaseCreated> => {
      const body = await request("", input);
      if (!isId(body.caseId) || !isText(body.caseNumber) || !body.caseNumber) throw invalid();
      return { ...scope(body), caseId: body.caseId, caseNumber: body.caseNumber, warnings: warnings(body.warnings) };
    },
  };
}
export type CasesApi = ReturnType<typeof createCasesApi>;
