import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";

import { SwhouseClient } from "./client";
import { findStaleBranchTargets } from "./branch-mapping";
import { getCodelistMaps } from "./codelists";
import { swhouseConfigFromEnv, type SwhouseConfig } from "./config";
import { normalizeFleet, normalizePlateForPairing } from "./replacement-vehicles";
import type { SwhouseCarOccupancyRaw, SwhouseReplacementVehicle } from "./types";

/**
 * Fáza 2: SWHouse ako zdroj pravdy rosteru náhradnej flotily.
 * - načíta autoritatívny getCarsOccupancyAll (voľné aj obsadené, s pobočkou),
 * - upsertne SWHouse flotilu (ownerType 3/4) do motorist_external_vehicle_records (provider client_vehicle_db),
 * - re-source: pre každé SWHouse auto zabezpečí motorist_fleet_assets riadok (match po ŠPZ / nový) + potvrdený link,
 * - Commander ostáva GPS vrstva (jeho vlastný sync + linky), occupancy je živý overlay.
 * Zmiznuté provider záznamy soft-deaktivuje a ich SWHouse link odmietne. Samotné
 * assety nemaže: Commander GPS ani historické priradenia sa tak nestratia.
 */

const SOURCE_PROVIDER = "client_vehicle_db" as const;
const MIN_AUTHORITATIVE_FLEET_SIZE = 20;
const MAX_SHRINK_RATIO = 0.5;

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type Tables = Database["public"]["Tables"];
type OrganizationRow = Tables["motorist_organizations"]["Row"];
type FleetAssetRow = Tables["motorist_fleet_assets"]["Row"];
type FleetAssetLinkInsert = Tables["motorist_fleet_asset_links"]["Insert"];
type FleetAssetInsert = Tables["motorist_fleet_assets"]["Insert"];
type AssetLite = Pick<FleetAssetRow, "id" | "license_plate" | "vin" | "metadata" | "make" | "model" | "branch_id">;

export type SwhouseFleetSyncResult = {
  provider: "client_vehicle_db";
  dryRun: boolean;
  status: "success" | "failed";
  /** Počet SWHouse flotilových áut (ownerType 3/4) načítaných z getCars. */
  fleetCount: number;
  recordsUpserted: number;
  recordsDeactivated: number;
  linksRejected: number;
  assetsCreated: number;
  assetsMatched: number;
  linksCreated: number;
  ghostCount: number;
  ambiguousPlates: string[];
  unmappedBranchIds: number[];
  error: string | null;
};

export async function syncSwhouseFleet(options?: {
  dryRun?: boolean;
  client?: SwhouseClient;
  config?: SwhouseConfig;
  allCars?: SwhouseCarOccupancyRaw[];
}): Promise<SwhouseFleetSyncResult> {
  const dryRun = options?.dryRun ?? false;
  const base: SwhouseFleetSyncResult = {
    provider: SOURCE_PROVIDER,
    dryRun,
    status: "success",
    fleetCount: 0,
    recordsUpserted: 0,
    recordsDeactivated: 0,
    linksRejected: 0,
    assetsCreated: 0,
    assetsMatched: 0,
    linksCreated: 0,
    ghostCount: 0,
    ambiguousPlates: [],
    unmappedBranchIds: [],
    error: null,
  };

  let config: SwhouseConfig;
  try {
    config = options?.config ?? swhouseConfigFromEnv();
  } catch (error) {
    return { ...base, status: "failed", error: error instanceof Error ? error.message : "SWHouse nie je nakonfigurovaný." };
  }

  const client = options?.client ?? new SwhouseClient(config);

  // 1) Načítaj produkčný autoritatívny roster + číselníky.
  const allOccupancy = options?.allCars
    ? { ok: true, status: 200, data: options.allCars }
    : await client.getCarsOccupancyAll({ fresh: true });
  if (!allOccupancy.ok || !Array.isArray(allOccupancy.data)) {
    return {
      ...base,
      status: "failed",
      error: `SWHouse getCarsOccupancyAll zlyhal (HTTP ${allOccupancy.status}).`,
    };
  }
  let maps;
  try {
    maps = await getCodelistMaps(client, config.codelistTtlMs);
  } catch {
    maps = undefined;
  }
  const fleet = dedupeByCarId(
    normalizeFleet(
      allOccupancy.data,
      maps ?? { manufacturers: new Map(), colors: new Map(), carTypes: new Map(), ownerTypes: new Map(), branches: new Map(), expiresAt: 0 },
      config.branchMap,
      config.fleetOwnerTypeIds,
    ),
  );
  base.fleetCount = fleet.length;
  base.unmappedBranchIds = Array.from(
    new Set(
      fleet
        .map((vehicle) => vehicle.swhouseBranchId)
        .filter((branchId): branchId is number => branchId != null && !config.branchMap[String(branchId)]),
    ),
  ).sort((left, right) => left - right);

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const knownBranchIds = await loadBranchIds(supabase, organization.id);
  const staleBranchTargets = findStaleBranchTargets(config.branchMap, knownBranchIds);
  if (staleBranchTargets.length > 0) {
    return {
      ...base,
      status: "failed",
      error: `SWHOUSE_BRANCH_MAP odkazuje na ${staleBranchTargets.length} neexistujúce pobočky; existujúce dáta sa nezmenili.`,
    };
  }
  const existingActiveRecords = await loadActiveFleetRecordIdentities(supabase, organization.id);
  const transitionError = validateAuthoritativeFleetTransition(
    existingActiveRecords.map((record) => record.source_vehicle_id),
    fleet.map((vehicle) => String(vehicle.carId)),
  );
  if (transitionError) {
    return { ...base, status: "failed", error: transitionError };
  }

  // 2) Upsert external records + odpoj a soft-deaktivuj záznamy, ktoré už
  // autoritatívny endpoint nevracia. Nikdy nemaž fleet asset automaticky.
  const now = new Date().toISOString();
  const currentCarIds = new Set(fleet.map((vehicle) => String(vehicle.carId)));
  const missingRecords = existingActiveRecords.filter((record) => !currentCarIds.has(record.source_vehicle_id));
  base.recordsDeactivated = missingRecords.length;

  if (!dryRun) {
    await upsertExternalRecords(supabase, organization.id, fleet, now);
    base.linksRejected = await rejectLinksForMissingRecords(
      supabase,
      organization.id,
      missingRecords.map((record) => record.id),
      now,
    );
    await deactivateRecords(supabase, organization.id, missingRecords.map((record) => record.id), now);
  } else {
    base.linksRejected = await countConfirmedLinksForRecords(
      supabase,
      organization.id,
      missingRecords.map((record) => record.id),
    );
  }
  base.recordsUpserted = fleet.length;

  // 3) Načítaj (upsertnuté) external records a existujúce dáta pre reconcile.
  const records = dryRun
    ? buildDryRunFleetRecords(existingActiveRecords, currentCarIds)
    : await loadFleetRecords(supabase, organization.id, currentCarIds);
  const recordByCarId = new Map(records.map((record) => [record.source_vehicle_id, record]));

  const missingRecordIds = new Set(missingRecords.map((record) => record.id));
  const confirmedLinks = (await loadConfirmedSwhouseLinks(supabase, organization.id)).filter(
    (link) => !dryRun || !missingRecordIds.has(link.external_vehicle_record_id),
  );
  const linkedExternalIds = new Set(confirmedLinks.map((link) => link.external_vehicle_record_id));
  const linkedAssetIds = new Set(confirmedLinks.map((link) => link.fleet_asset_id));

  const assets = await loadReplacementAssets(supabase, organization.id);
  if (!dryRun) {
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const assetIdByRecord = new Map(confirmedLinks.map((link) => [link.external_vehicle_record_id, link.fleet_asset_id]));
    const changes = fleet.flatMap((vehicle) => {
      const record = recordByCarId.get(String(vehicle.carId));
      const assetId = record ? assetIdByRecord.get(record.id) : null;
      const asset = assetId ? assetById.get(assetId) : undefined;
      if (!asset) return [];
      const next = { license_plate: vehicle.ecv || asset.license_plate, vin: vehicle.vin || asset.vin,
        make: vehicle.make ?? asset.make, model: vehicle.model || asset.model, branch_id: vehicle.branchInternalId ?? asset.branch_id };
      if (Object.entries(next).every(([key, value]) => asset[key as keyof typeof next] === value)) return [];
      return [{ id: asset.id, next }];
    });
    for (let offset = 0; offset < changes.length; offset += 4) {
      await Promise.all(changes.slice(offset, offset + 4).map(async ({ id, next }) => {
        await throwOnResult(await supabase.from("motorist_fleet_assets").update(next).eq("organization_id", organization.id).eq("id", id));
        Object.assign(assetById.get(id)!, next);
      }));
    }
  }
  const ghostAssets = assets.filter((asset) => !linkedAssetIds.has(asset.id));
  base.ghostCount = ghostAssets.length;

  // plate → assety (len tie, ktoré ešte nie sú SWHouse-linkované)
  const plateToAssets = new Map<string, AssetLite[]>();
  const vinToAssets = new Map<string, AssetLite[]>();
  for (const asset of assets) {
    if (linkedAssetIds.has(asset.id)) {
      continue;
    }
    const plate = normalizePlateForPairing(asset.license_plate);
    if (plate) {
      const list = plateToAssets.get(plate) ?? [];
      list.push(asset);
      plateToAssets.set(plate, list);
    }

    const vin = normalizePlateForPairing(asset.vin);
    if (vin) {
      const vinList = vinToAssets.get(vin) ?? [];
      vinList.push(asset);
      vinToAssets.set(vin, vinList);
    }
  }

  const usedAssetIds = new Set<string>();
  const ambiguous = new Set<string>();
  const newAssetRows: FleetAssetInsert[] = [];
  const matchedUpdates: Array<{ assetId: string; vin: string | null; metadata: Json }> = [];
  // link plán: buď na existujúci assetId, alebo na nový (identifikovaný cez carId)
  const linkPlan: Array<{
    carId: string;
    recordId: string;
    plate: string;
    existingAssetId: string | null;
    matchMethod: "vin" | "license_plate" | "existing_external_id";
  }> = [];

  for (const vehicle of fleet) {
    const carId = String(vehicle.carId);
    const record = recordByCarId.get(carId);
    if (!record || linkedExternalIds.has(record.id)) {
      continue; // buď ešte neexistuje (len dryRun), alebo už spárované
    }
    const plate = normalizePlateForPairing(vehicle.ecv);
    const vin = normalizePlateForPairing(vehicle.vin);
    const plateCandidates = (plate ? plateToAssets.get(plate) ?? [] : []).filter((asset) => !usedAssetIds.has(asset.id));
    const vinCandidates = (vin ? vinToAssets.get(vin) ?? [] : []).filter((asset) => !usedAssetIds.has(asset.id));
    const exactVinAmongPlate = plateCandidates.filter((asset) => normalizePlateForPairing(asset.vin) === vin && Boolean(vin));
    const uniquePlate = plateCandidates.length === 1 ? plateCandidates[0] : null;
    const uniqueVin = vinCandidates.length === 1 ? vinCandidates[0] : null;
    const uniquePlateVin = normalizePlateForPairing(uniquePlate?.vin);
    const selected =
      exactVinAmongPlate.length === 1
        ? { asset: exactVinAmongPlate[0], method: "vin" as const }
        : uniqueVin && (plateCandidates.length === 0 || plateCandidates.some((asset) => asset.id === uniqueVin.id))
          ? { asset: uniqueVin, method: "vin" as const }
          : uniquePlate && (!vin || !uniquePlateVin)
            ? { asset: uniquePlate, method: "license_plate" as const }
            : null;

    if (selected) {
      const asset = selected.asset;
      usedAssetIds.add(asset.id);
      base.assetsMatched += 1;
      const nextVin = asset.vin && asset.vin.trim() ? asset.vin : vehicle.vin || null;
      const nextMeta = mergeSwhouseMeta(asset.metadata, vehicle.carId);
      matchedUpdates.push({ assetId: asset.id, vin: nextVin, metadata: nextMeta });
      linkPlan.push({
        carId,
        recordId: record.id,
        plate,
        existingAssetId: asset.id,
        matchMethod: selected.method,
      });
    } else if (plateCandidates.length === 0 && vinCandidates.length === 0) {
      base.assetsCreated += 1;
      newAssetRows.push(buildNewAssetRow(organization.id, vehicle));
      linkPlan.push({
        carId,
        recordId: record.id,
        plate,
        existingAssetId: null,
        matchMethod: "existing_external_id",
      });
    } else {
      ambiguous.add(plate || `VIN:${vin}`);
    }
  }
  base.ambiguousPlates = [...ambiguous].sort();
  base.linksCreated = linkPlan.length;
  base.ghostCount = Math.max(0, ghostAssets.length - base.assetsMatched);

  if (dryRun) {
    return base;
  }

  // 4) Zapíš nové assety, dopočítaj ich id cez external_id (=carId), spáruj linky.
  const newAssetIdByCarId = new Map<string, string>();
  if (newAssetRows.length > 0) {
    const inserted = await supabase.from("motorist_fleet_assets").insert(newAssetRows).select("id,external_id");
    await throwOnResult(inserted);
    for (const row of inserted.data ?? []) {
      if (row.external_id) {
        newAssetIdByCarId.set(row.external_id, row.id);
      }
    }
  }

  // update VIN/metadata na matched assetoch (len keď treba)
  for (const update of matchedUpdates) {
    const result = await supabase
      .from("motorist_fleet_assets")
      .update({ vin: update.vin, metadata: update.metadata, updated_at: now })
      .eq("id", update.assetId)
      .eq("organization_id", organization.id);
    await throwOnResult(result);
  }

  const linkRows: FleetAssetLinkInsert[] = [];
  for (const plan of linkPlan) {
    const assetId = plan.existingAssetId ?? newAssetIdByCarId.get(plan.carId);
    if (!assetId) {
      continue;
    }
    linkRows.push({
      organization_id: organization.id,
      fleet_asset_id: assetId,
      external_vehicle_record_id: plan.recordId,
      source_provider: SOURCE_PROVIDER,
      link_status: "confirmed",
      match_method: plan.matchMethod,
      match_confidence: plan.matchMethod === "license_plate" ? 0.9 : 1,
      confirmed_at: now,
      confirmed_by: null,
      metadata: toJson({ source: "swhouse_sync", swhouseCarId: Number(plan.carId), normalizedLicensePlate: plan.plate || null }),
    });
  }
  if (linkRows.length > 0) {
    const links = await supabase.from("motorist_fleet_asset_links").insert(linkRows);
    await throwOnResult(links);
  }

  return base;
}

async function upsertExternalRecords(
  supabase: AdminClient,
  organizationId: string,
  fleet: SwhouseReplacementVehicle[],
  now: string,
) {
  if (fleet.length === 0) {
    return;
  }
  const previous = await supabase.from("motorist_external_vehicle_records")
    .select("source_vehicle_id,latest_payload_snapshot")
    .eq("organization_id", organizationId).eq("source_provider", SOURCE_PROVIDER);
  await throwOnResult(previous);
  const previousById = new Map((previous.data ?? []).map((row) => [row.source_vehicle_id, row.latest_payload_snapshot]));
  const rows = fleet.map((vehicle) => ({
    organization_id: organizationId,
    source_provider: SOURCE_PROVIDER,
    source_vehicle_id: String(vehicle.carId),
    normalized_license_plate: normalizePlateForPairing(vehicle.ecv) || null,
    normalized_vin: normalizePlateForPairing(vehicle.vin) || null,
    label: buildLabel(vehicle),
    make: vehicle.make,
    model: vehicle.model || null,
    kind_hint: "replacement_car" as const,
    source_active: true,
    source_deleted_at: null,
    latest_payload_snapshot: toJson({
      ...payloadRecord(previousById.get(String(vehicle.carId))),
      carId: vehicle.carId,
      ecv: vehicle.ecv,
      vin: vehicle.vin,
      ownerType: vehicle.ownerType,
      swhouseBranchId: vehicle.swhouseBranchId,
      swhouseBranchName: vehicle.swhouseBranchName,
      color: vehicle.color,
      rentTo: vehicle.rentTo,
      details: vehicle.details ?? {},
      sourceEndpoint: "carOccupancy/getCarsOccupancyAll",
    }),
    last_seen_at: now,
    last_imported_at: now,
  }));
  const result = await supabase
    .from("motorist_external_vehicle_records")
    .upsert(rows, { onConflict: "organization_id,source_provider,source_vehicle_id" });
  await throwOnResult(result);
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type FleetRecordIdentity = {
  id: string;
  source_vehicle_id: string;
};

async function loadActiveFleetRecordIdentities(
  supabase: AdminClient,
  organizationId: string,
): Promise<FleetRecordIdentity[]> {
  const result = await supabase
    .from("motorist_external_vehicle_records")
    .select("id,source_vehicle_id")
    .eq("organization_id", organizationId)
    .eq("source_provider", SOURCE_PROVIDER)
    .eq("source_active", true);
  await throwOnResult(result);
  return result.data ?? [];
}

async function loadBranchIds(supabase: AdminClient, organizationId: string): Promise<string[]> {
  const result = await supabase
    .from("motorist_branches")
    .select("id")
    .eq("organization_id", organizationId);
  await throwOnResult(result);
  return (result.data ?? []).map((branch) => branch.id);
}

async function deactivateRecords(
  supabase: AdminClient,
  organizationId: string,
  recordIds: string[],
  now: string,
) {
  if (recordIds.length === 0) return;
  const result = await supabase
    .from("motorist_external_vehicle_records")
    .update({ source_active: false, source_deleted_at: now, updated_at: now })
    .eq("organization_id", organizationId)
    .eq("source_provider", SOURCE_PROVIDER)
    .in("id", recordIds);
  await throwOnResult(result);
}

async function countConfirmedLinksForRecords(
  supabase: AdminClient,
  organizationId: string,
  recordIds: string[],
): Promise<number> {
  if (recordIds.length === 0) return 0;
  const result = await supabase
    .from("motorist_fleet_asset_links")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("source_provider", SOURCE_PROVIDER)
    .eq("link_status", "confirmed")
    .in("external_vehicle_record_id", recordIds);
  await throwOnResult(result);
  return result.count ?? 0;
}

async function rejectLinksForMissingRecords(
  supabase: AdminClient,
  organizationId: string,
  recordIds: string[],
  now: string,
): Promise<number> {
  const count = await countConfirmedLinksForRecords(supabase, organizationId, recordIds);
  if (count === 0) return 0;
  const result = await supabase
    .from("motorist_fleet_asset_links")
    .update({ link_status: "rejected", rejected_at: now, updated_at: now })
    .eq("organization_id", organizationId)
    .eq("source_provider", SOURCE_PROVIDER)
    .eq("link_status", "confirmed")
    .in("external_vehicle_record_id", recordIds);
  await throwOnResult(result);
  return count;
}

async function loadFleetRecords(supabase: AdminClient, organizationId: string, carIds: Set<string>) {
  const result = await supabase
    .from("motorist_external_vehicle_records")
    .select("id,source_vehicle_id,normalized_license_plate,normalized_vin")
    .eq("organization_id", organizationId)
    .eq("source_provider", SOURCE_PROVIDER)
    .eq("source_active", true);
  await throwOnResult(result);
  return (result.data ?? []).filter((record) => carIds.has(record.source_vehicle_id));
}

async function loadConfirmedSwhouseLinks(supabase: AdminClient, organizationId: string) {
  const result = await supabase
    .from("motorist_fleet_asset_links")
    .select("fleet_asset_id,external_vehicle_record_id")
    .eq("organization_id", organizationId)
    .eq("source_provider", SOURCE_PROVIDER)
    .eq("link_status", "confirmed");
  await throwOnResult(result);
  return result.data ?? [];
}

function buildDryRunFleetRecords(existing: FleetRecordIdentity[], currentCarIds: Set<string>): FleetRecordIdentity[] {
  const byCarId = new Map(
    existing
      .filter((record) => currentCarIds.has(record.source_vehicle_id))
      .map((record) => [record.source_vehicle_id, record]),
  );
  for (const carId of currentCarIds) {
    if (!byCarId.has(carId)) {
      byCarId.set(carId, { id: `dry-run:${carId}`, source_vehicle_id: carId });
    }
  }
  return [...byCarId.values()];
}

/**
 * Fail-closed ochrana pred prázdnym/chybným endpointom alebo náhodným prepnutím
 * na inú databázu. Bežné prírastky a menšie vyradenia prejdú; podozrivý prepad
 * alebo takmer nulový prekryv musí najprv skontrolovať človek.
 */
export function validateAuthoritativeFleetTransition(
  existingCarIds: Iterable<string>,
  incomingCarIds: Iterable<string>,
  options: { minFleetSize?: number; maxShrinkRatio?: number } = {},
): string | null {
  const existing = new Set(existingCarIds);
  const incoming = new Set(incomingCarIds);
  const minFleetSize = options.minFleetSize ?? MIN_AUTHORITATIVE_FLEET_SIZE;
  const maxShrinkRatio = options.maxShrinkRatio ?? MAX_SHRINK_RATIO;

  if (incoming.size < minFleetSize) {
    return `SWHouse autoritatívny roster je pod bezpečným minimom (${incoming.size}/${minFleetSize}); existujúce dáta sa nezmenili.`;
  }
  if (existing.size === 0) return null;

  const retained = [...incoming].filter((carId) => existing.has(carId)).length;
  if (incoming.size < Math.ceil(existing.size * maxShrinkRatio)) {
    return `SWHouse roster sa podozrivo zmenšil (${existing.size} → ${incoming.size}); existujúce dáta sa nezmenili.`;
  }
  if (existing.size >= minFleetSize && retained < Math.ceil(Math.min(existing.size, incoming.size) * 0.2)) {
    return `SWHouse roster má podozrivo malý prekryv (${retained} vozidiel); existujúce dáta sa nezmenili.`;
  }
  return null;
}

async function loadReplacementAssets(supabase: AdminClient, organizationId: string) {
  const result = await supabase
    .from("motorist_fleet_assets")
    .select("id,license_plate,vin,metadata,make,model,branch_id")
    .eq("organization_id", organizationId)
    .eq("kind", "replacement_car");
  await throwOnResult(result);
  return (result.data ?? []) as AssetLite[];
}

function buildNewAssetRow(organizationId: string, vehicle: SwhouseReplacementVehicle): FleetAssetInsert {
  return {
    organization_id: organizationId,
    kind: "replacement_car",
    label: buildLabel(vehicle),
    license_plate: vehicle.ecv || null,
    status: "available",
    branch_id: vehicle.branchInternalId ?? null,
    vin: vehicle.vin || null,
    make: vehicle.make,
    model: vehicle.model || null,
    source_system: SOURCE_PROVIDER,
    external_id: String(vehicle.carId),
    location_source: SOURCE_PROVIDER,
    metadata: toJson({ source: "swhouse_sync", swhouseCarId: vehicle.carId }),
  };
}

function buildLabel(vehicle: SwhouseReplacementVehicle): string {
  const name = [vehicle.make, vehicle.model].filter((part) => part && part.trim()).join(" ").trim();
  return name || vehicle.ecv || `SWHouse ${vehicle.carId}`;
}

function mergeSwhouseMeta(metadata: Json | null, carId: number): Json {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  return toJson({ ...base, swhouseCarId: carId });
}

function dedupeByCarId(vehicles: SwhouseReplacementVehicle[]): SwhouseReplacementVehicle[] {
  return Array.from(new Map(vehicles.map((vehicle) => [vehicle.carId, vehicle])).values());
}

async function resolveOrganization(supabase: AdminClient): Promise<OrganizationRow> {
  const organizationId = process.env.MOTORIST_ORGANIZATION_ID?.trim();
  const query = organizationId
    ? supabase.from("motorist_organizations").select("*").eq("id", organizationId).maybeSingle()
    : supabase
        .from("motorist_organizations")
        .select("*")
        .eq("slug", process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || "pomoc-motoristom")
        .maybeSingle();
  const result = await query;
  await throwOnResult(result);
  if (!result.data?.active) {
    throw new Error("Active organization was not found.");
  }
  return result.data;
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

async function throwOnResult(result: { error: unknown }) {
  if (result.error) {
    throw result.error;
  }
}
