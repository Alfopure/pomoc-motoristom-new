import "server-only";
import { canUseMapsIntegration } from "@/lib/app-environment";
import type { FleetData } from "@/data/dispatch-types";
import { loadFleetData } from "@/data/dispatch-repository";
import { validFleetPoint, isFreshFleetTimestamp } from "@/lib/fleet-observation";
import { isUuid } from "@/lib/telephony/uuid";
import { MOBILE_TOOL_FLEET_KINDS, MOBILE_TOOL_FLEET_STATUSES, MOBILE_TOOL_FLEET_MAX_ASSETS, MOBILE_TOOL_FLEET_PAGE_SIZE, MOBILE_TOOL_ROUTE_MAX_INTERMEDIATES, type MobileToolFleet, type MobileToolFleetAsset, type MobileToolFleetFilter, type MobileToolLookup, type MobileToolRoute, type MobileToolRouteInput, type MobileToolPoint } from "@/lib/mobile-tools";
import { parseVehicleLookupInput, lookupIdentityConflict, vehicleFieldLabels, vehicleSourceLabels, type VehicleIdentity, type VehicleLookupResponse, type VehicleFacts } from "@/lib/vehicle-lookup";
import { lookupVehicle, VehicleLookupError } from "@/server/vehicle-lookup/service";
import { computeDrivingRoute } from "@/server/driving-route";
import { MutationError } from "@/server/mutation-error";
import type { MotoristActor } from "@/server/api-auth";

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function only(row: Record<string, unknown>, keys: string[]) { if (Object.keys(row).some(key => !keys.includes(key))) throw new MutationError("Formulár obsahuje nepovolené pole.", 400); }
function text(value: unknown, max: number, empty = false): value is string { return typeof value === "string" && value.length <= max && (empty || value.trim().length > 0) && !/[\x00-\x1f\x7f]/.test(value); }
function timestamp(value: unknown): string | null { return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null; }
function resultError(): never { throw new MutationError("Uložený výsledok nie je úplný alebo je príliš veľký.", 503, "mobile_tools_incomplete"); }
export function parseToolLookup(value: unknown) {
  if (!record(value)) throw new MutationError("Neplatné vyhľadávanie vozidla.", 400);
  only(value, ["kind", "value", "country", "knownIdentity"]);
  if (typeof value.kind !== "string" || !["plate", "vin"].includes(value.kind) || !text(value.value, 30)) throw new MutationError("Zadajte EČV alebo VIN.", 400);
  if (value.knownIdentity !== undefined) {
    if (!record(value.knownIdentity)) throw new MutationError("Neplatná identita vozidla.", 400);
    only(value.knownIdentity, ["plate", "vin", "country"]);
    for (const v of Object.values(value.knownIdentity)) if (!text(v, 30, true)) throw new MutationError("Neplatná identita vozidla.", 400);
  }
  try { return parseVehicleLookupInput(value); } catch (error) { throw new MutationError(error instanceof Error ? error.message : "Neplatné vyhľadávanie.", 400); }
}
export function parseToolRoute(value: unknown): Required<MobileToolRouteInput> {
  if (!record(value)) throw new MutationError("Vyberte štart a cieľ.", 400);
  only(value, ["origin", "destination", "intermediates"]);
  const point = (v: unknown): MobileToolPoint => {
    if (!record(v)) throw new MutationError("Neplatný bod trasy.", 400);
    only(v, ["lat", "lng"]);
    if (typeof v.lat !== "number" || !Number.isFinite(v.lat) || Math.abs(v.lat) > 90 || typeof v.lng !== "number" || !Number.isFinite(v.lng) || Math.abs(v.lng) > 180) throw new MutationError("Neplatné súradnice.", 400);
    return { lat: v.lat, lng: v.lng };
  };
  const via = value.intermediates ?? [];
  if (!Array.isArray(via) || via.length > MOBILE_TOOL_ROUTE_MAX_INTERMEDIATES || value.intermediates === null) throw new MutationError("Príliš veľa bodov prejazdu.", 400);
  return { origin: point(value.origin), destination: point(value.destination), intermediates: via.map(point) };
}
export function parseToolFleetFilter(params: URLSearchParams): MobileToolFleetFilter {
  for (const key of params.keys()) if (!["q", "kind", "status", "offset"].includes(key) || params.getAll(key).length !== 1) throw new MutationError("Neplatný filter flotily.", 400);
  const q = (params.get("q") ?? "").trim(), kind = params.get("kind") ?? "all", status = params.get("status") ?? "all", rawOffset = params.get("offset") ?? "0";
  if (!text(q, 80, true) || !["all", ...MOBILE_TOOL_FLEET_KINDS].includes(kind) || !["all", ...MOBILE_TOOL_FLEET_STATUSES].includes(status) || !/^(0|[1-9]\d*)$/.test(rawOffset) || Number(rawOffset) > MOBILE_TOOL_FLEET_MAX_ASSETS) throw new MutationError("Neplatný filter flotily.", 400);
  return { q, kind: kind as MobileToolFleetFilter["kind"], status: status as MobileToolFleetFilter["status"], offset: Number(rawOffset) };
}
export function projectToolLookup(value: VehicleLookupResponse, known: VehicleIdentity): Omit<MobileToolLookup, keyof import("@/lib/mobile-tools").MobileToolsScope> {
  const result = value.snapshot.result;
  if (result.version !== 1 || !isUuid(result.id) || !timestamp(result.fetchedAt) || !Array.isArray(result.sources) || result.sources.length > 8 || typeof value.cached !== "boolean") resultError();
  const seen = new Set<string>();
  const sources = result.sources.map(source => {
    if (typeof source.source !== "string" || !Object.hasOwn(vehicleSourceLabels, source.source) || seen.has(source.source) || typeof source.status !== "string" || !["found", "not_found", "ambiguous", "challenge_required", "rate_limited", "unavailable", "unsupported"].includes(source.status) || !timestamp(source.fetchedAt) || !record(source.facts) || !Array.isArray(source.warnings) || source.warnings.length > 20 || source.warnings.some(w => !text(w, 1000))) resultError();
    seen.add(source.source);
    const facts: VehicleFacts = {};
    for (const [key, fact] of Object.entries(source.facts)) {
      if (!Object.hasOwn(vehicleFieldLabels, key) || !record(fact) || !text(fact.value, 180) || typeof fact.quality !== "string" || !["reported", "decoded", "partial"].includes(fact.quality)) resultError();
      facts[key as keyof VehicleFacts] = { value: fact.value, quality: fact.quality as "reported" | "decoded" | "partial" };
    }
    const candidates = source.candidates ?? [];
    if (!Array.isArray(candidates) || candidates.length > 20) resultError();
    const identities = candidates.map(candidate => {
      if (!record(candidate) || Object.keys(candidate).some(k => !["plate", "vin", "country"].includes(k)) || Object.values(candidate).some(v => !text(v, 30))) resultError();
      return { ...(candidate.plate ? { plate: candidate.plate } : {}), ...(candidate.vin ? { vin: candidate.vin } : {}), ...(candidate.country ? { country: candidate.country } : {}) };
    });
    return { source: source.source, status: source.status, fetchedAt: source.fetchedAt, facts, warnings: [...source.warnings], candidates: identities };
  });
  return { query: { kind: result.query.kind, value: result.query.value, country: result.query.country, checkedForDate: result.query.checkedForDate }, result: { id: result.id, fetchedAt: result.fetchedAt, sources }, cached: value.cached, conflict: lookupIdentityConflict(result, known) ?? null };
}
export async function lookupToolVehicle(actor: MotoristActor, input: unknown) {
  const parsed = parseToolLookup(input);
  // Vehicle providers spend live integration quota too. Do not even claim a
  // lookup reservation from Preview or disabled dedicated TEST deployments.
  if (!canUseMapsIntegration()) throw new MutationError("Dohľadávanie vozidla nie je v tomto prostredí aktivované.", 503, "mobile_lookup_disabled");
  try {
    const result = await lookupVehicle(parsed.query, actor);
    if (["kind", "value", "country", "checkedForDate"].some(key => result.snapshot.result.query[key as keyof typeof parsed.query] !== parsed.query[key as keyof typeof parsed.query])) resultError();
    return projectToolLookup(result, parsed.knownIdentity);
  } catch (error) {
    if (error instanceof VehicleLookupError) throw new ToolLookupError(error.message, error.status, error.retryAfter);
    throw error;
  }
}
export class ToolLookupError extends MutationError { constructor(message: string, status: number, readonly retryAfter?: number) { super(message, status); } }
export async function routeTool(input: unknown, signal?: AbortSignal): Promise<Pick<MobileToolRoute, "request" | "route">> {
  const request = parseToolRoute(input);
  const route = await computeDrivingRoute(request, { signal, strict: true });
  return { request, route: { ...route, encodedPolyline: route.encodedPolyline!, legs: route.legs.map(leg => ({ ...leg, encodedPolyline: leg.encodedPolyline! })) } };
}
export function projectToolFleet(data: FleetData, selection: MobileToolFleetFilter): Pick<MobileToolFleet, "assets" | "selection" | "total" | "nextOffset" | "snapshot" | "gpsLastSuccessAt"> {
  if (!Array.isArray(data.fleetAssets) || data.fleetAssets.length > MOBILE_TOOL_FLEET_MAX_ASSETS) resultError();
  const seen = new Set<string>();
  const assets = data.fleetAssets.map((asset): MobileToolFleetAsset => {
    if (!isUuid(asset.id) || seen.has(asset.id) || !MOBILE_TOOL_FLEET_KINDS.includes(asset.kind) || !MOBILE_TOOL_FLEET_STATUSES.includes(asset.status) || !MOBILE_TOOL_FLEET_STATUSES.includes(asset.internalStatus ?? asset.status) || !text(asset.label, 200) || !text(asset.licensePlate, 30) || asset.make !== undefined && !text(asset.make, 100) || asset.model !== undefined && !text(asset.model, 150)) resultError();
    seen.add(asset.id);
    const futurePosition = Date.parse(asset.gps?.positionTime ?? "") > Date.now() + 60_000;
    const point = !futurePosition && asset.positionKnown === true && validFleetPoint(asset.point) ? { lat: asset.point.lat, lng: asset.point.lng } : null;
    const gps = point && asset.gps && text(asset.gps.source, 80) ? { source: asset.gps.source, positionTime: timestamp(asset.gps.positionTime), syncedAt: timestamp(asset.gps.syncedAt), stale: asset.gps.stale !== false || !isFreshFleetTimestamp(asset.gps.positionTime) } : null;
    const occupancy = asset.occupancy ?? null;
    if (occupancy !== null && !["occupied", "free", "unverified", "stale"].includes(occupancy)) resultError();
    return { id: asset.id, kind: asset.kind, label: asset.label, licensePlate: asset.licensePlate, make: asset.make ?? null, model: asset.model ?? null, status: asset.status, internalStatus: asset.internalStatus ?? asset.status, occupancy,
      occupancyCheckedAt: timestamp(asset.swhouse?.checkedAt), availabilityVerified: typeof asset.availabilityVerified === "boolean" ? asset.availabilityVerified : null, point, gps };
  }).filter(asset => (selection.kind === "all" || asset.kind === selection.kind) && (selection.status === "all" || asset.status === selection.status) && `${asset.label} ${asset.licensePlate} ${asset.make ?? ""} ${asset.model ?? ""}`.toLocaleLowerCase("sk").includes(selection.q.toLocaleLowerCase("sk")))
    .sort((a, b) => a.label.localeCompare(b.label, "sk") || a.id.localeCompare(b.id));
  const page = assets.slice(selection.offset, selection.offset + MOBILE_TOOL_FLEET_PAGE_SIZE);
  return { selection, assets: page, total: assets.length, nextOffset: selection.offset + page.length < assets.length ? selection.offset + page.length : null, snapshot: "stored", gpsLastSuccessAt: timestamp(data.commanderGpsLastSuccessAt) };
}
export async function fleetTool(actor: MotoristActor, selection: MobileToolFleetFilter, signal?: AbortSignal) {
  return projectToolFleet(await loadFleetData(actor.organizationId, signal, { maxRows: 1000 }), selection);
}
