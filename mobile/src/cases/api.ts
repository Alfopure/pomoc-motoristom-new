import type { MobileCaseCreated, MobileCaseCreateInput, MobileCaseDetail, MobileCaseDispatchers, MobileCaseFilter, MobileCases, MobileCaseSummary, MobileScope } from "../../../src/lib/mobile-api";
import { MobileApiError, type MobileTransport } from "../lib/api";
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
    || !isText(item.statusLabel) || !isText(item.priorityLabel) || !["urgent", "high", "normal", "low"].includes(String(item.priority))
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

export function createCasesApi(config: MobileConfig, profileId: string, getToken: () => Promise<string | null>, transport: MobileTransport = fetch) {
  function scope(body: Record<string, unknown>): MobileScope {
    if (body.ok !== true || body.apiVersion !== 1 || body.environment !== config.environment || body.profileId !== profileId || !isDate(body.checkedAt)) throw invalid();
    return { ok: true, apiVersion: 1, environment: config.environment, profileId, checkedAt: body.checkedAt };
  }
  async function request(path: string, input?: MobileCaseCreateInput, signal?: AbortSignal) {
    const token = await getToken();
    if (!token) throw new MobileApiError("Prihláste sa do aplikácie.", 401);
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20_000);
    try {
      const response = await transport(config.apiOrigin + "/api/mobile/v1/cases" + path, {
        method: input === undefined ? "GET" : "POST", credentials: "omit", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, Accept: "application/json",
          ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      let value: unknown;
      try { value = await response.json(); } catch { throw invalid(); }
      const body = object(value);
      if (!response.ok) throw new MobileApiError(isText(body.error) ? body.error : "Prípady sa nepodarilo načítať.", response.status);
      scope(body);
      return body;
    } catch (error) {
      if (error instanceof MobileApiError || signal?.aborted) throw error;
      throw new MobileApiError("Spojenie sa prerušilo. Skontrolujte pripojenie.", 0);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  return {
    list: async (filter: MobileCaseFilter, signal?: AbortSignal): Promise<MobileCases & { requestedAt: number }> => {
      const requestedAt = Date.now();
      const q = filter.q.trim(), ownerId = filter.ownerId ?? null;
      if (ownerId !== null && (!isId(ownerId) || filter.ownership !== "all")) throw new MobileApiError("Vyberte platného dispečera.", 400);
      const params = new URLSearchParams({ ownership: filter.ownership, category: filter.category, q, limit: "25" });
      if (ownerId) params.set("ownerId", ownerId);
      if (filter.cursor) params.set("cursor", filter.cursor);
      const body = await request("?" + params.toString(), undefined, signal), selection = object(body.selection);
      // Older servers omit ownerId only for an unfiltered list; a selected
      // dispatcher must always be echoed exactly before rows reach the UI.
      if (selection.ownership !== filter.ownership || selection.category !== filter.category || selection.q !== q || (selection.ownerId ?? null) !== ownerId
        || !Array.isArray(body.cases) || body.cases.length > 25 || !isNullableText(body.nextCursor)
        || body.nextCursor === "" || (body.nextCursor !== null && body.nextCursor === filter.cursor)) throw invalid();
      const cases = body.cases.map(summary);
      if (new Set(cases.map(item => item.id)).size !== cases.length || (ownerId !== null && cases.some(item => item.owner.id !== ownerId))) throw invalid();
      return { ...scope(body), requestedAt, cases, nextCursor: body.nextCursor, selection: { ownership: filter.ownership, category: filter.category, q, ownerId } };
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
      const timeline = item.timeline.map(value => {
        const event = object(value);
        if (!isId(event.id) || !isText(event.title) || !isNullableText(event.body) || !isDate(event.createdAt) || !isNullableText(event.actorName)) throw invalid();
        return { id: event.id, title: event.title, body: event.body, createdAt: event.createdAt, actorName: event.actorName };
      });
      return { ...scope(body), case: { ...base, mainNote: item.mainNote, incidentDescription: item.incidentDescription, jobTypeLabels: item.jobTypeLabels, timeline } };
    },
    create: async (input: MobileCaseCreateInput): Promise<MobileCaseCreated> => {
      const body = await request("", input);
      if (!isId(body.caseId) || !isText(body.caseNumber) || !body.caseNumber || !Array.isArray(body.warnings) || body.warnings.length > 50) throw invalid();
      const warnings = body.warnings.map(value => {
        const warning = object(value);
        if (!isText(warning.code) || !isText(warning.field) || !isText(warning.message)) throw invalid();
        return { code: warning.code, field: warning.field, message: warning.message };
      });
      return { ...scope(body), caseId: body.caseId, caseNumber: body.caseNumber, warnings };
    },
  };
}
export type CasesApi = ReturnType<typeof createCasesApi>;
