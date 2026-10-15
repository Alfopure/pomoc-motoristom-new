import type { MobileToolFleet, MobileToolFleetAsset, MobileToolFleetFilter, MobileToolLookup, MobileToolLookupInput, MobileToolPoint, MobileToolRoute, MobileToolRouteInput } from "../../../src/lib/mobile-tools";
import { MOBILE_TOOL_FLEET_KINDS, MOBILE_TOOL_FLEET_STATUSES, MOBILE_TOOL_FLEET_MAX_ASSETS, MOBILE_TOOL_FLEET_PAGE_SIZE, MOBILE_TOOL_ROUTE_MAX_INTERMEDIATES } from "../../../src/lib/mobile-tools";
import { parseMobileMapPreview } from "../../../src/lib/mobile-map-preview";
import { parseVehicleLookupInput, vehicleFieldLabels, vehicleSourceLabels } from "../../../src/lib/vehicle-lookup";
import { MobileApiError, type MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";

export class ToolsApiError extends MobileApiError {
  constructor(message: string, status: number, code?: string, readonly retryAfterSeconds?: number) { super(message, status, code); }
}
const invalid = (): never => { throw new ToolsApiError("Odpoveď nástrojov sa nepodarilo overiť. Obnovte údaje.", 502); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): value is string {
  if (typeof value !== "string" || value.length > max || !empty && !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const date = (value: unknown): value is string => text(value, 40) && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const nullableText = (value: unknown, max: number) => value === null || text(value, max);
const integer = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
function point(value: unknown): MobileToolPoint {
  const v = object(value, ["lat", "lng"]);
  if (typeof v.lat !== "number" || !Number.isFinite(v.lat) || Math.abs(v.lat) > 90 || typeof v.lng !== "number" || !Number.isFinite(v.lng) || Math.abs(v.lng) > 180) return invalid();
  return { lat: v.lat, lng: v.lng };
}
function routeInput(value: unknown): Required<MobileToolRouteInput> {
  const v = object(value, ["origin", "destination", "intermediates"]), via = v.intermediates === undefined ? [] : v.intermediates;
  if (!Array.isArray(via) || via.length > MOBILE_TOOL_ROUTE_MAX_INTERMEDIATES) return invalid();
  return { origin: point(v.origin), destination: point(v.destination), intermediates: via.map(point) };
}
function fleetFilter(value: unknown): MobileToolFleetFilter {
  const v = object(value, ["q", "kind", "status", "offset"]);
  if (!text(v.q, 80, true) || typeof v.kind !== "string" || !["all", ...MOBILE_TOOL_FLEET_KINDS].includes(v.kind)
    || typeof v.status !== "string" || !["all", ...MOBILE_TOOL_FLEET_STATUSES].includes(v.status) || !integer(v.offset, MOBILE_TOOL_FLEET_MAX_ASSETS)) return invalid();
  return { q: v.q.trim(), kind: v.kind as MobileToolFleetFilter["kind"], status: v.status as MobileToolFleetFilter["status"], offset: v.offset };
}
function fleetAsset(value: unknown): MobileToolFleetAsset {
  const v = object(value, ["id", "kind", "label", "licensePlate", "make", "model", "status", "internalStatus", "occupancy", "occupancyCheckedAt", "availabilityVerified", "point", "gps"]);
  if (!id(v.id) || !text(v.label, 200) || !text(v.licensePlate, 30) || !nullableText(v.make, 100) || !nullableText(v.model, 150)
    || !MOBILE_TOOL_FLEET_KINDS.includes(v.kind as MobileToolFleetAsset["kind"]) || !MOBILE_TOOL_FLEET_STATUSES.includes(v.status as MobileToolFleetAsset["status"])
    || !MOBILE_TOOL_FLEET_STATUSES.includes(v.internalStatus as MobileToolFleetAsset["status"])
    || v.occupancy !== null && !["occupied", "free", "unverified", "stale"].includes(v.occupancy as string)
    || !nullableDate(v.occupancyCheckedAt) || v.availabilityVerified !== null && typeof v.availabilityVerified !== "boolean") return invalid();
  if (v.point !== null) point(v.point);
  if (v.gps !== null) {
    const gps = object(v.gps, ["source", "positionTime", "syncedAt", "stale"]);
    if (v.point === null || !text(gps.source, 80) || !nullableDate(gps.positionTime) || !nullableDate(gps.syncedAt) || typeof gps.stale !== "boolean") return invalid();
  }
  return v as unknown as MobileToolFleetAsset;
}
const scopeKeys = ["ok", "apiVersion", "environment", "profileId", "organizationId", "checkedAt"];

export function createToolsApi(config: MobileConfig, profileId: string, organizationId: string, getToken: () => Promise<string | null>, transport: MobileTransport = fetch, current: () => boolean = () => true) {
  if (!id(profileId) || !id(organizationId)) throw new ToolsApiError("Účet nástrojov sa nepodarilo overiť.", 400);
  const assertCurrent = () => { if (!current()) throw new ToolsApiError("Prihlásenie alebo organizácia sa zmenili. Otvorte nástroje znova.", 401); };
  async function request(path: string, keys: string[], input: unknown, signal: AbortSignal | undefined, budget: number) {
    const controller = new AbortController(); let timedOut = false, sent = false;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort(); }, budget);
    try {
      assertCurrent();
      const token = await getToken();
      assertCurrent();
      if (controller.signal.aborted) throw new ToolsApiError("Požiadavka bola zrušená.", 0);
      if (!token) throw new ToolsApiError("Prihláste sa do aplikácie.", 401);
      sent = true;
      const response = await transport(config.apiOrigin + "/api/mobile/v1/tools/" + path, {
        method: input === undefined ? "GET" : "POST", credentials: "omit", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, Accept: "application/json", "X-PM-App-Environment": config.environment, "X-PM-Expected-Organization": organizationId,
          ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      if (Number(response.headers.get("content-length")) > 1_500_000) return invalid();
      const raw = await response.text();
      assertCurrent();
      if (controller.signal.aborted) throw new ToolsApiError("Požiadavka bola zrušená.", 0);
      if (raw.length > 1_500_000) return invalid();
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return invalid(); }
      if (!response.ok) {
        const error = object(value, ["ok", "error", "code"]), rawRetry = response.headers.get("retry-after");
        const retry = rawRetry !== null && /^\d{1,3}$/.test(rawRetry) && Number(rawRetry) <= 300 ? Number(rawRetry) : undefined;
        throw new ToolsApiError(text(error.error, 1000) ? error.error : "Nástroj je dočasne nedostupný.", response.status, text(error.code, 100) ? error.code : undefined, retry);
      }
      const body = object(value, [...scopeKeys, ...keys]);
      if (body.ok !== true || body.apiVersion !== 1 || body.environment !== config.environment || body.profileId !== profileId || body.organizationId !== organizationId || !date(body.checkedAt)) return invalid();
      return body;
    } catch (error) {
      if (timedOut && sent && path === "vehicle-lookup") throw new ToolsApiError("Overenie sa nemuselo prerušiť na serveri. Pred opakovaním chvíľu počkajte.", 0, undefined, 5);
      if (error instanceof MobileApiError) throw error;
      throw new ToolsApiError(signal?.aborted ? "Požiadavka bola zrušená." : "Spojenie sa prerušilo. Skontrolujte pripojenie a skúste znova.", 0);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  const validateInput = <T>(read: () => T): T => { try { return read(); } catch { throw new ToolsApiError("Skontrolujte zadané údaje nástroja.", 400); } };
  return {
    lookup: async (input: MobileToolLookupInput, signal?: AbortSignal): Promise<MobileToolLookup> => {
      const parsed = validateInput(() => {
        const value = object(input, ["kind", "value", "country", "knownIdentity"]);
        if (value.knownIdentity !== undefined) object(value.knownIdentity, ["plate", "vin", "country"]);
        return parseVehicleLookupInput(input);
      });
      const body = await request("vehicle-lookup", ["query", "result", "cached", "conflict"], { kind: parsed.query.kind, country: parsed.query.country, value: parsed.query.value,
        ...(input.knownIdentity ? { knownIdentity: parsed.knownIdentity } : {}) }, signal, 55_000);
      const query = object(body.query, ["kind", "value", "country", "checkedForDate"]), result = object(body.result, ["id", "fetchedAt", "sources"]);
      if (query.kind !== parsed.query.kind || query.country !== parsed.query.country || query.value !== parsed.query.value
        || !text(query.checkedForDate, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(query.checkedForDate) || !Number.isFinite(Date.parse(query.checkedForDate))
        || !id(result.id) || !date(result.fetchedAt) || !Array.isArray(result.sources) || result.sources.length > 8 || typeof body.cached !== "boolean" || !nullableText(body.conflict, 1000)) return invalid();
      const seen = new Set<string>();
      for (const value of result.sources) {
        const source = object(value, ["source", "status", "fetchedAt", "facts", "warnings", "candidates"]);
        if (!text(source.source, 30) || !Object.hasOwn(vehicleSourceLabels, source.source) || seen.has(source.source) || typeof source.status !== "string"
          || !["found", "not_found", "ambiguous", "challenge_required", "rate_limited", "unavailable", "unsupported"].includes(source.status) || !date(source.fetchedAt)
          || !Array.isArray(source.warnings) || source.warnings.length > 20 || source.warnings.some(warning => !text(warning, 1000))
          || !Array.isArray(source.candidates) || source.candidates.length > 20) return invalid();
        seen.add(source.source);
        const facts = object(source.facts, Object.keys(vehicleFieldLabels));
        for (const value of Object.values(facts)) {
          const fact = object(value, ["value", "quality"]);
          if (!text(fact.value, 180) || typeof fact.quality !== "string" || !["reported", "decoded", "partial"].includes(fact.quality)) return invalid();
        }
        for (const value of source.candidates) {
          const identity = object(value, ["plate", "vin", "country"]);
          if (Object.values(identity).some(value => !text(value, 30))) return invalid();
        }
      }
      return body as unknown as MobileToolLookup;
    },
    route: async (input: MobileToolRouteInput, signal?: AbortSignal): Promise<MobileToolRoute> => {
      const normalized = validateInput(() => routeInput(input));
      const body = await request("route", ["request", "route"], normalized, signal, 25_000);
      if (JSON.stringify(routeInput(body.request)) !== JSON.stringify(normalized)) return invalid();
      const route = object(body.route, ["distanceMeters", "durationSeconds", "encodedPolyline", "legs", "provider", "calculatedAt"]);
      if (route.provider !== "google-routes" || !date(route.calculatedAt) || !Array.isArray(route.legs) || route.legs.length !== normalized.intermediates.length + 1) return invalid();
      for (const value of [route, ...route.legs]) {
        const leg = object(value, value === route ? Object.keys(route) : ["distanceMeters", "durationSeconds", "encodedPolyline"]);
        if (typeof leg.distanceMeters !== "number" || !Number.isFinite(leg.distanceMeters) || leg.distanceMeters < 0
          || typeof leg.durationSeconds !== "number" || !Number.isFinite(leg.durationSeconds) || leg.durationSeconds < 0) return invalid();
        try { parseMobileMapPreview({ points: [{ lat: 0, lng: 0, label: "Trasa" }], encodedPolyline: leg.encodedPolyline }); } catch { return invalid(); }
      }
      return body as unknown as MobileToolRoute;
    },
    fleet: async (input: MobileToolFleetFilter, signal?: AbortSignal): Promise<MobileToolFleet> => {
      const filter = validateInput(() => fleetFilter(input));
      const body = await request("fleet?" + new URLSearchParams({ q: filter.q, kind: filter.kind, status: filter.status, offset: String(filter.offset) }), ["selection", "assets", "total", "nextOffset", "snapshot", "gpsLastSuccessAt"], undefined, signal, 12_000);
      if (JSON.stringify(fleetFilter(body.selection)) !== JSON.stringify(filter) || body.snapshot !== "stored" || !nullableDate(body.gpsLastSuccessAt)
        || !integer(body.total, MOBILE_TOOL_FLEET_MAX_ASSETS) || !Array.isArray(body.assets) || body.assets.length > MOBILE_TOOL_FLEET_PAGE_SIZE
        || body.assets.length !== Math.min(MOBILE_TOOL_FLEET_PAGE_SIZE, Math.max(0, body.total - filter.offset))) return invalid();
      const expectedNext = filter.offset + body.assets.length < body.total ? filter.offset + body.assets.length : null;
      if (body.nextOffset !== expectedNext) return invalid();
      const assets = body.assets.map(fleetAsset);
      if (new Set(assets.map(asset => asset.id)).size !== assets.length || assets.some(asset => filter.kind !== "all" && asset.kind !== filter.kind || filter.status !== "all" && asset.status !== filter.status
        || !`${asset.label} ${asset.licensePlate} ${asset.make ?? ""} ${asset.model ?? ""}`.toLocaleLowerCase("sk").includes(filter.q.toLocaleLowerCase("sk")))) return invalid();
      return body as unknown as MobileToolFleet;
    },
  };
}
export type ToolsApi = ReturnType<typeof createToolsApi>;
