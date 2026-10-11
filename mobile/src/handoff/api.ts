import type { MobileCaseHandoffs, MobileHandoffGrant, MobileHandoffInput, MobileHandoffLink, MobileHandoffResult, MobileHandoffSnapshot, MobileScope } from '../../../src/lib/mobile-api';
import { MobileApiError, type MobileTransport } from '../lib/api';
import type { MobileConfig } from '../lib/config';
const invalid = () => new MobileApiError('Odpoveď odovzdania sa nepodarilo overiť. Obnovte údaje.', 502);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 2147483647;
// Match the server's strict ISO/PostgreSQL timestamp boundary, retaining microseconds.
function date(v: unknown): v is string {
  if (!text(v, 64) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v)))
    return false;
  const day = new Date(v.slice(0, 10) + 'T00:00:00Z');
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === v.slice(0, 10);
}
const nullableDate = (v: unknown) => v === null || date(v);
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw invalid();
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(k => !(k in v)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k)))
    throw invalid();
}
function strings(v: Record<string, unknown>, limits: Record<string, number>) {
  if (Object.entries(limits).some(([k, max]) => !text(v[k], max)))
    throw invalid();
}
function enums(v: unknown, choices: string[]) {
  if (!Array.isArray(v) || v.length > choices.length || new Set(v).size !== v.length || v.some(x => !choices.includes(x)))
    throw invalid();
}
function vehicle(v: unknown, enhanced = false) {
  const o = object(v);
  keys(o, ['make', 'model', 'plate', ...(enhanced ? ['color', 'driveable', 'conditionFlags'] : [])]);
  strings(o, { make: 160, model: 160, plate: 80 });
  if (enhanced) {
    strings(o, { color: 160 });
    if (o.driveable !== null && typeof o.driveable !== 'boolean')
      throw invalid();
    enums(o.conditionFlags, ['immobile', 'locked', 'no_keys', 'blocked_wheel', 'after_accident', 'overturned', 'in_ditch']);
  }
}
function place(v: unknown) {
  if (v === null)
    return;
  const o = object(v);
  keys(o, ['address', 'lat', 'lng']);
  strings(o, { address: 2000 });
  for (const [field, max] of [['lat', 90], ['lng', 180]] as const) {
    const coordinate = o[field];
    if (coordinate !== null && (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || Math.abs(coordinate) > max))
      throw invalid();
  }
}
/** Every accepted field is rendered in the preview; unknown additions require an app update. */
export function parseSnapshot(value: unknown): MobileHandoffSnapshot {
  const v = object(value), enhanced = v.schemaVersion === 3;
  if (v.schemaVersion !== undefined && !enhanced)
    throw invalid();
  keys(v, ['caseNumber', 'action', 'contact', 'vehicle', 'pickup', 'destination', ...(enhanced ? ['schemaVersion', 'assistance', 'replacement', 'incident', 'caseCreatedAt', 'firstCallAt'] : [])], ['instructions', 'scheduledAt']);
  strings(v, { caseNumber: 160, action: 200 });
  const contact = object(v.contact);
  keys(contact, ['name', 'phone']);
  strings(contact, { name: 320, phone: 80 });
  vehicle(v.vehicle, enhanced);
  place(v.pickup);
  place(v.destination);
  if (v.instructions !== undefined && !text(v.instructions, 2000) || v.scheduledAt !== undefined && !nullableDate(v.scheduledAt))
    throw invalid();
  if (enhanced) {
    const assistance = object(v.assistance);
    keys(assistance, ['name', 'reference']);
    strings(assistance, { name: 160, reference: 160 });
    const r = object(v.replacement);
    keys(r, ['needed', 'category', 'requestedType', 'preferences', 'status', 'deliveryPlace', 'vehicle']);
    strings(r, { requestedType: 160, deliveryPlace: 500 });
    if (r.needed !== null && typeof r.needed !== 'boolean' || !['', 'small_car', 'wagon', 'suv', 'van'].includes(r.category as string) || !['not_needed', 'not_provided', 'assigned', 'provided', 'pending'].includes(r.status as string))
      throw invalid();
    enums(r.preferences, ['automatic', 'manual', 'suv', 'wagon', 'van', 'ev']);
    if (r.vehicle !== null)
      vehicle(r.vehicle);
    const incident = object(v.incident);
    keys(incident, ['description', 'passengersCount', 'access']);
    strings(incident, { description: 1000, access: 500 });
    if (incident.passengersCount !== null && (typeof incident.passengersCount !== 'number' || !Number.isInteger(incident.passengersCount) || incident.passengersCount < 0 || incident.passengersCount > 50))
      throw invalid();
    if (!nullableDate(v.caseCreatedAt) || !nullableDate(v.firstCallAt))
      throw invalid();
  }
  return JSON.parse(JSON.stringify(v)) as MobileHandoffSnapshot;
}
function grant(value: unknown): MobileHandoffGrant {
  const v = object(value);
  if (!id(v.id) || !['offered', 'accepted', 'en_route', 'arrived', 'completed', 'rejected', 'cancelled', 'expired'].includes(v.status as string) || !integer(v.revision) || !integer(v.publishedVersion) || !text(v.recipientName, 160) || !text(v.recipientPhone, 30) || !date(v.expiresAt) || !date(v.createdAt) || !nullableDate(v.openedAt) || !nullableDate(v.eta) || !nullableDate(v.publishedAt) || !(v.createdBy === null || text(v.createdBy, 320)) || typeof v.canRenew !== 'boolean' || typeof v.recoverable !== 'boolean' || !Array.isArray(v.events) || v.events.length > 200)
    throw invalid();
  const events = v.events.map(value => {
    const e = object(value);
    if (!id(e.id) || !['issue', 'publish', 'renew', 'extend', 'recover', 'accept', 'reject', 'en_route', 'arrived', 'complete', 'update', 'blocked', 'revoke'].includes(e.action as string) || !text(e.comment, 1000) || !text(e.actor, 320) || !date(e.createdAt))
      throw invalid();
    return {
      id: e.id, action: e.action as string, comment: e.comment, actor: e.actor, createdAt: e.createdAt
    };
  });
  if (new Set(events.map(e => e.id)).size !== events.length)
    throw invalid();
  return {
    id: v.id, status: v.status as MobileHandoffGrant['status'], revision: v.revision, publishedVersion: v.publishedVersion, recipientName: v.recipientName, recipientPhone: v.recipientPhone, expiresAt: v.expiresAt, createdAt: v.createdAt, openedAt: v.openedAt as string | null, eta: v.eta as string | null, createdBy: v.createdBy as string | null, publishedAt: v.publishedAt as string | null, canRenew: v.canRenew, recoverable: v.recoverable, published: v.published === null ? null : parseSnapshot(v.published), events
  };
}
function link(value: unknown, origin: string, minRevision: number): MobileHandoffLink {
  const v = object(value);
  if (v.status === 'not_requested')
    return { status: 'not_requested' };
  if (v.status === 'unavailable' && v.warning === 'link_unavailable')
    return { status: 'unavailable', warning: 'link_unavailable' };
  if (v.status !== 'available' || typeof v.url !== 'string' || !date(v.expiresAt) || Date.parse(v.expiresAt) <= Date.now() || !integer(v.currentRevision) || v.currentRevision < minRevision)
    throw invalid();
  const prefix = origin + '/handoff#token=';
  if (!v.url.startsWith(prefix) || !/^[A-Za-z0-9_-]{43}$/.test(v.url.slice(prefix.length)))
    throw invalid();
  return {
    status: 'available', url: v.url, expiresAt: v.expiresAt, currentRevision: v.currentRevision
  };
}
export function createHandoffApi(config: MobileConfig, profileId: string, getToken: () => Promise<string | null>, transport: MobileTransport = fetch) {
  function scope(v: Record<string, unknown>): MobileScope {
    if (v.ok !== true || v.apiVersion !== 1 || v.environment !== config.environment || v.profileId !== profileId || !date(v.checkedAt))
      throw invalid();
    return {
      ok: true, apiVersion: 1, environment: config.environment, profileId, checkedAt: v.checkedAt
    };
  }
  async function request(caseId: string, input?: MobileHandoffInput, signal?: AbortSignal) {
    if (!id(caseId))
      throw new MobileApiError('Prípad sa nenašiel.', 404);
    const token = await getToken();
    if (!token)
      throw new MobileApiError('Prihláste sa do aplikácie.', 401);
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted)
      abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 20000);
    try {
      const response = await transport(config.apiOrigin + '/api/mobile/v1/cases/' + caseId + '/handoffs', {
        method: input ? 'POST' : 'GET', credentials: 'omit', signal: controller.signal, headers: {
          Authorization: 'Bearer ' + token, 'X-PM-App-Environment': config.environment, Accept: 'application/json', ...(input ? { 'Content-Type': 'application/json' } : {})
        }, ...(input ? { body: JSON.stringify(input) } : {})
      });
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > 2 * 1024 * 1024)
        throw invalid();
      let value: unknown;
      try {
        value = JSON.parse(raw);
      }
      catch {
        throw invalid();
      }
      const body = object(value);
      if (!response.ok) {
        const code = text(body.code, 100) ? body.code : undefined;
        const message = ['MOBILE_RESPONSE_TOO_LARGE', 'MOBILE_HANDOFF_CONTEXT_TOO_LARGE'].includes(code ?? '') ? 'História odovzdaní je príliš veľká na mobilné zobrazenie. Otvorte prípad vo webovom dispečingu.' : code === 'MOBILE_HANDOFF_SCHEMA_UNSUPPORTED' ? 'Tieto údaje vyžadujú novšiu verziu aplikácie. Aktualizujte aplikáciu alebo použite webový dispečing.' : text(body.error, 1000) ? body.error : 'Odovzdanie sa nepodarilo dokončiť.';
        throw new MobileApiError(message, response.status, code);
      }
      scope(body);
      if (body.caseId !== caseId)
        throw invalid();
      return body;
    }
    catch (error) {
      if (error instanceof MobileApiError || signal?.aborted)
        throw error;
      throw new MobileApiError('Spojenie sa prerušilo. Overte pôvodnú požiadavku.', 0);
    }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    context: async (caseId: string, signal?: AbortSignal): Promise<MobileCaseHandoffs> => {
      const body = await request(caseId, undefined, signal);
      if (typeof body.previewVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewVersion) || typeof body.enhanced !== 'boolean' || !Array.isArray(body.handoffs) || body.handoffs.length > 50)
        throw invalid();
      const handoffs = body.handoffs.map(grant);
      if (new Set(handoffs.map(h => h.id)).size !== handoffs.length)
        throw invalid();
      return {
        ...scope(body), caseId, previewVersion: body.previewVersion, preview: parseSnapshot(body.preview), handoffs, enhanced: body.enhanced
      };
    },
    command: async (caseId: string, input: MobileHandoffInput): Promise<MobileHandoffResult> => {
      const body = await request(caseId, input);
      if (body.commandId !== input.commandId || !id(body.handoffId) || 'handoffId' in input && body.handoffId !== input.handoffId || !integer(body.currentRevision))
        throw invalid();
      if (input.action === 'recover') {
        if (body.kind !== 'link')
          throw invalid();
        const available = link(body.link, config.apiOrigin, body.currentRevision);
        if (available.status !== 'available')
          throw invalid();
        return {
          ...scope(body), kind: 'link', caseId, handoffId: body.handoffId, commandId: input.commandId, currentRevision: body.currentRevision, link: available
        };
      }
      const expected = input.action === 'issue' ? 1 : input.expectedRevision + 1;
      if (body.kind !== 'mutation' || body.action !== input.action || body.committedRevision !== expected || body.currentRevision < expected || body.refreshRequired !== true)
        throw invalid();
      // Link validation must never erase independently verified durable commit proof.
      let available: MobileHandoffLink = { status: 'not_requested' };
      if (input.action === 'issue' || input.action === 'renew') {
        try {
          available = link(body.link, config.apiOrigin, body.currentRevision);
          if (available.status === 'not_requested')
            throw invalid();
        }
        catch {
          available = { status: 'unavailable', warning: 'link_unavailable' };
        }
      }
      return {
        ...scope(body), kind: 'mutation', caseId, handoffId: body.handoffId, commandId: input.commandId, action: input.action, committedRevision: expected, currentRevision: body.currentRevision, refreshRequired: true, link: available
      };
    }
  };
}
export type HandoffApi = ReturnType<typeof createHandoffApi>;
