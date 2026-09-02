import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createWebdispecinkClient,
  getWebdispecinkConfig,
  serializeWebdispecinkError,
  type WebdispecinkCar,
  type WebdispecinkPosition,
} from "@/lib/integrations/webdispecink/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import { resolveDefaultOrganizationId } from "./default-organization";
import { MutationError } from "./motorist-mutations";

type AdminClient = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];
type FleetAssetRow = Tables["motorist_fleet_assets"]["Row"];
type FleetProviderVehicleRow = Tables["motorist_fleet_provider_vehicles"]["Row"];
type BranchRow = Tables["motorist_branches"]["Row"];
type WebdispecinkSyncMode = "catalog" | "positions" | "full";

type WebdispecinkSyncInput = {
  mode?: WebdispecinkSyncMode;
};

type ProviderVehicleActionInput =
  | {
      action: "link";
      fleetAssetId: string;
    }
  | {
      action: "import";
      branchId: string;
      kind?: "tow_truck" | "replacement_car";
    };

const PROVIDER = "webdispecink";
const FLEET_INTEGRATION_PROVIDER = "fleet";
const DEFAULT_SOAP_URL = "https://api.webdispecink.cz/code/WebDispecinkServiceNet.php";
const DEFAULT_STALE_AFTER_MINUTES = 10;

export type WebdispecinkSyncSummary = {
  mode: WebdispecinkSyncMode;
  catalogCount: number;
  positionCount: number;
  providerVehicleCount: number;
  linkedVehicleCount: number;
  updatedAssetPositions: number;
  unmappedPositionCount: number;
  missingPointCount: number;
  syncedAt: string;
};

export async function syncWebdispecinkFleet(input: WebdispecinkSyncInput = {}): Promise<WebdispecinkSyncSummary> {
  const mode = input.mode ?? "positions";
  validateSyncMode(mode);

  const supabase = createSupabaseAdminClient();
  const organizationId = await resolveDefaultOrganizationId();
  const syncedAt = new Date().toISOString();
  let summary: WebdispecinkSyncSummary | null = null;

  try {
    const config = getWebdispecinkConfig();
    const client = createWebdispecinkClient(config);
    await client.login();

    const [cars, positions] = await Promise.all([
      mode === "catalog" || mode === "full" ? client.listCars() : Promise.resolve([]),
      mode === "positions" || mode === "full" ? client.listPositions() : Promise.resolve([]),
    ]);

    if (cars.length > 0) {
      await upsertCatalogVehicles(supabase, organizationId, cars, syncedAt);
    }

    if (positions.length > 0) {
      await upsertPositionSnapshots(supabase, organizationId, positions, syncedAt);
    }

    const providerVehicles = await loadProviderVehicles(supabase, organizationId);
    const fleetAssets = await loadFleetAssets(supabase, organizationId);
    const linkedProviderVehicles = await autoLinkProviderVehicles(supabase, organizationId, providerVehicles, fleetAssets);
    const positionUpdateStats =
      positions.length > 0
        ? await updateFleetAssetPositions(supabase, organizationId, linkedProviderVehicles, fleetAssets, positions, syncedAt)
        : { updatedAssetPositions: 0, unmappedPositionCount: 0, missingPointCount: 0 };
    const refreshedProviderVehicles = await loadProviderVehicles(supabase, organizationId);

    summary = {
      mode,
      catalogCount: cars.length,
      positionCount: positions.length,
      providerVehicleCount: refreshedProviderVehicles.length,
      linkedVehicleCount: refreshedProviderVehicles.filter((vehicle) => vehicle.linked_asset_id).length,
      updatedAssetPositions: positionUpdateStats.updatedAssetPositions,
      unmappedPositionCount: positionUpdateStats.unmappedPositionCount,
      missingPointCount: positionUpdateStats.missingPointCount,
      syncedAt,
    };

    await updateFleetIntegrationStatus(supabase, organizationId, {
      status: "live",
      last_success_at: syncedAt,
      last_error_at: null,
      last_error: null,
    });
    await recordSyncEvent(supabase, organizationId, summary);

    return summary;
  } catch (error) {
    const serialized = serializeWebdispecinkError(error);
    await updateFleetIntegrationStatus(supabase, organizationId, {
      status: "degraded",
      last_error_at: syncedAt,
      last_error: serialized.message,
    });
    await recordSyncEvent(supabase, organizationId, summary ?? { mode, syncedAt, error: serialized.message });
    throw error;
  }
}

export async function updateWebdispecinkProviderVehicle(vehicleId: string, input: ProviderVehicleActionInput) {
  const supabase = createSupabaseAdminClient();
  const organizationId = await resolveDefaultOrganizationId();
  const vehicle = await getProviderVehicle(supabase, organizationId, vehicleId);

  if (input.action === "link") {
    const asset = await getFleetAsset(supabase, organizationId, input.fleetAssetId);
    await linkProviderVehicleToAsset(supabase, organizationId, vehicle, asset, new Date().toISOString());
    return { vehicleId: vehicle.id, assetId: asset.id };
  }

  const branch = await getBranch(supabase, organizationId, input.branchId);
  const asset = await importProviderVehicle(supabase, organizationId, vehicle, branch, input.kind ?? "tow_truck");
  return { vehicleId: vehicle.id, assetId: asset.id };
}

function validateSyncMode(mode: string): asserts mode is WebdispecinkSyncMode {
  if (!["catalog", "positions", "full"].includes(mode)) {
    throw new MutationError("Neplatný režim WebDispečink synchronizácie.", 400);
  }
}

async function upsertCatalogVehicles(supabase: AdminClient, organizationId: string, cars: WebdispecinkCar[], syncedAt: string) {
  const rows = cars.map((car) => ({
    organization_id: organizationId,
    provider: PROVIDER,
    external_id: car.externalId,
    label: car.licensePlate ?? car.unitName ?? `WebDispečink ${car.externalId}`,
    license_plate: car.licensePlate ?? null,
    driver_name: car.driverName ?? null,
    unit_name: car.unitName ?? null,
    object_number: car.objectNumber ?? null,
    vehicle_type: car.type ?? null,
    online: car.online ?? null,
    disabled: car.disabled ?? null,
    odometer_km: car.odometerKm ?? null,
    raw_catalog: car.raw as Json,
    last_catalog_sync_at: syncedAt,
  }));

  if (rows.length === 0) {
    return;
  }

  const { error } = await supabase.from("motorist_fleet_provider_vehicles").upsert(rows, {
    onConflict: "organization_id,provider,external_id",
  });

  if (error) {
    throw new MutationError("Katalóg WebDispečink vozidiel sa nepodarilo uložiť.", 500);
  }
}

async function upsertPositionSnapshots(supabase: AdminClient, organizationId: string, positions: WebdispecinkPosition[], syncedAt: string) {
  const rows = positions.map((position) => ({
    organization_id: organizationId,
    provider: PROVIDER,
    external_id: position.externalId,
    latest_position_at: position.positionTime ?? null,
    latest_local_position_at: position.localPositionTime ?? null,
    speed_kph: position.speedKph ?? null,
    odometer_km: position.odometerKm ?? null,
    raw_position: position.raw as Json,
    last_position_sync_at: syncedAt,
  }));

  if (rows.length === 0) {
    return;
  }

  const { error } = await supabase.from("motorist_fleet_provider_vehicles").upsert(rows, {
    onConflict: "organization_id,provider,external_id",
  });

  if (error) {
    throw new MutationError("Polohy WebDispečink vozidiel sa nepodarilo uložiť.", 500);
  }
}

async function autoLinkProviderVehicles(
  supabase: AdminClient,
  organizationId: string,
  providerVehicles: FleetProviderVehicleRow[],
  fleetAssets: FleetAssetRow[],
) {
  const assetsByExternalId = new Map(
    fleetAssets
      .filter((asset) => asset.source_system === PROVIDER && asset.external_id)
      .map((asset) => [asset.external_id!, asset]),
  );
  // Guard: WebDispečink páruje LEN odťahovky. Bez tohto by SWHouse-sourced náhradné auto s rovnakou
  // ŠPZ mohlo prevziať odťahovkovú GPS (autoLink matchoval globálne cez všetky kindy).
  const assetsByPlate = uniqueFleetAssetsByPlate(fleetAssets.filter((asset) => asset.kind === "tow_truck"));
  const nextVehicles: FleetProviderVehicleRow[] = [];

  for (const vehicle of providerVehicles) {
    const normalizedPlate = normalizePlate(vehicle.license_plate);
    const linkedAsset = vehicle.linked_asset_id
      ? fleetAssets.find((asset) => asset.id === vehicle.linked_asset_id)
      : assetsByExternalId.get(vehicle.external_id) ?? (normalizedPlate ? assetsByPlate.get(normalizedPlate) : undefined);

    if (!linkedAsset) {
      nextVehicles.push(vehicle);
      continue;
    }

    if (vehicle.linked_asset_id !== linkedAsset.id) {
      const { data, error } = await supabase
        .from("motorist_fleet_provider_vehicles")
        .update({ linked_asset_id: linkedAsset.id })
        .eq("organization_id", organizationId)
        .eq("id", vehicle.id)
        .select("*")
        .single();

      if (error || !data) {
        throw new MutationError("Vozidlo WebDispečinku sa nepodarilo napárovať.", 500);
      }

      nextVehicles.push(data);
      continue;
    }

    nextVehicles.push(vehicle);
  }

  return nextVehicles;
}

async function updateFleetAssetPositions(
  supabase: AdminClient,
  organizationId: string,
  providerVehicles: FleetProviderVehicleRow[],
  fleetAssets: FleetAssetRow[],
  positions: WebdispecinkPosition[],
  syncedAt: string,
) {
  const providerByExternalId = new Map(providerVehicles.map((vehicle) => [vehicle.external_id, vehicle]));
  const assetsById = new Map(fleetAssets.map((asset) => [asset.id, asset]));
  let updatedAssetPositions = 0;
  let unmappedPositionCount = 0;
  let missingPointCount = 0;

  for (const position of positions) {
    const providerVehicle = providerByExternalId.get(position.externalId);

    if (!position.point) {
      missingPointCount += 1;
      continue;
    }

    if (!providerVehicle?.linked_asset_id) {
      unmappedPositionCount += 1;
      continue;
    }

    const asset = assetsById.get(providerVehicle.linked_asset_id);

    if (!asset) {
      unmappedPositionCount += 1;
      continue;
    }

    const location = await upsertLiveLocation(supabase, organizationId, providerVehicle, asset, position, syncedAt);
    const lastSeenAt = position.positionTime ?? position.localPositionTime ?? syncedAt;
    const metadata = mergeFleetAssetGpsMetadata(asset.metadata, providerVehicle, position, syncedAt);
    const { error } = await supabase
      .from("motorist_fleet_assets")
      .update({
        current_location_id: location.id,
        last_seen_at: lastSeenAt,
        source_system: PROVIDER,
        external_id: providerVehicle.external_id,
        location_source: PROVIDER,
        metadata,
      })
      .eq("organization_id", organizationId)
      .eq("id", asset.id);

    if (error) {
      throw new MutationError("GPS poloha vozidla sa nepodarila zapísať do flotily.", 500);
    }

    await updateProviderVehiclePositionLink(supabase, organizationId, providerVehicle.id, location.id, position, syncedAt);
    assetsById.set(asset.id, {
      ...asset,
      current_location_id: location.id,
      last_seen_at: lastSeenAt,
      source_system: PROVIDER,
      external_id: providerVehicle.external_id,
      location_source: PROVIDER,
      metadata,
    });
    updatedAssetPositions += 1;
  }

  return { updatedAssetPositions, unmappedPositionCount, missingPointCount };
}

async function linkProviderVehicleToAsset(
  supabase: AdminClient,
  organizationId: string,
  vehicle: FleetProviderVehicleRow,
  asset: FleetAssetRow,
  syncedAt: string,
) {
  const latestPosition = positionFromProviderVehicle(vehicle);
  let locationId = vehicle.latest_location_id;
  let lastSeenAt = vehicle.latest_position_at;

  if (latestPosition?.point) {
    const location = await upsertLiveLocation(supabase, organizationId, vehicle, asset, latestPosition, syncedAt);
    locationId = location.id;
    lastSeenAt = latestPosition.positionTime ?? latestPosition.localPositionTime ?? syncedAt;
  }

  const metadata = latestPosition ? mergeFleetAssetGpsMetadata(asset.metadata, vehicle, latestPosition, syncedAt) : asset.metadata;
  const { error: assetError } = await supabase
    .from("motorist_fleet_assets")
    .update({
      ...(locationId ? { current_location_id: locationId } : {}),
      ...(lastSeenAt ? { last_seen_at: lastSeenAt } : {}),
      source_system: PROVIDER,
      external_id: vehicle.external_id,
      location_source: locationId ? PROVIDER : asset.location_source,
      metadata,
    })
    .eq("organization_id", organizationId)
    .eq("id", asset.id);

  if (assetError) {
    throw new MutationError("Fleet asset sa nepodarilo napárovať na WebDispečink.", 500);
  }

  const { error: vehicleError } = await supabase
    .from("motorist_fleet_provider_vehicles")
    .update({
      linked_asset_id: asset.id,
      latest_location_id: locationId,
    })
    .eq("organization_id", organizationId)
    .eq("id", vehicle.id);

  if (vehicleError) {
    throw new MutationError("WebDispečink vozidlo sa nepodarilo označiť ako napárované.", 500);
  }
}

async function importProviderVehicle(
  supabase: AdminClient,
  organizationId: string,
  vehicle: FleetProviderVehicleRow,
  branch: BranchRow,
  kind: "tow_truck" | "replacement_car",
) {
  const syncedAt = new Date().toISOString();
  const latestPosition = positionFromProviderVehicle(vehicle);
  const label = providerVehicleAssetLabel(vehicle);
  const locationId = vehicle.latest_location_id ?? branch.location_id;
  const { data, error } = await supabase
    .from("motorist_fleet_assets")
    .insert({
      organization_id: organizationId,
      kind,
      label,
      license_plate: vehicle.license_plate,
      status: "available",
      category: kind === "tow_truck" ? "personal_tow" : "wagon",
      branch_id: branch.id,
      current_location_id: locationId,
      last_seen_at: vehicle.latest_position_at ?? syncedAt,
      source_system: PROVIDER,
      external_id: vehicle.external_id,
      location_source: vehicle.latest_location_id ? PROVIDER : "manual",
      metadata: {
        source: PROVIDER,
        importedFromProviderVehicleId: vehicle.id,
        gps: {
          source: PROVIDER,
          externalId: vehicle.external_id,
          positionTime: vehicle.latest_position_at,
          syncedAt: vehicle.last_position_sync_at,
          speedKph: vehicle.speed_kph,
          staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES,
        },
      },
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new MutationError("Vozidlo z WebDispečinku sa nepodarilo importovať do flotily.", 500);
  }

  let importedAsset = data;
  let importedLocationId = vehicle.latest_location_id;

  if (latestPosition?.point) {
    const location = await upsertLiveLocation(supabase, organizationId, vehicle, importedAsset, latestPosition, syncedAt);
    const lastSeenAt = latestPosition.positionTime ?? latestPosition.localPositionTime ?? syncedAt;
    const metadata = mergeFleetAssetGpsMetadata(importedAsset.metadata, vehicle, latestPosition, syncedAt);
    const { data: updatedAsset, error: updateError } = await supabase
      .from("motorist_fleet_assets")
      .update({
        current_location_id: location.id,
        last_seen_at: lastSeenAt,
        location_source: PROVIDER,
        metadata,
      })
      .eq("organization_id", organizationId)
      .eq("id", importedAsset.id)
      .select("*")
      .single();

    if (updateError || !updatedAsset) {
      throw new MutationError("Importované vozidlo sa nepodarilo presunúť na GPS polohu.", 500);
    }

    importedAsset = updatedAsset;
    importedLocationId = location.id;
  }

  const { error: linkError } = await supabase
    .from("motorist_fleet_provider_vehicles")
    .update({ linked_asset_id: importedAsset.id, latest_location_id: importedLocationId })
    .eq("organization_id", organizationId)
    .eq("id", vehicle.id);

  if (linkError) {
    throw new MutationError("Importované vozidlo sa nepodarilo spätne napárovať.", 500);
  }

  return importedAsset;
}

async function upsertLiveLocation(
  supabase: AdminClient,
  organizationId: string,
  vehicle: FleetProviderVehicleRow,
  asset: FleetAssetRow,
  position: WebdispecinkPosition,
  syncedAt: string,
) {
  if (!position.point) {
    throw new MutationError("WebDispečink poloha nemá súradnice.", 400);
  }

  const label = `${asset.label} GPS`;
  const address = [position.addressCity, position.addressState].filter(Boolean).join(", ") || "Aktuálna poloha WebDispečink";
  const payload = {
    organization_id: organizationId,
    label,
    address,
    lat: position.point.lat,
    lng: position.point.lng,
    provider: PROVIDER,
    metadata: {
      source: PROVIDER,
      externalId: vehicle.external_id,
      providerVehicleId: vehicle.id,
      assetId: asset.id,
      positionTime: position.positionTime,
      localPositionTime: position.localPositionTime,
      syncedAt,
      speedKph: position.speedKph,
      odometerKm: position.odometerKm,
    },
  };

  if (vehicle.latest_location_id) {
    const { data, error } = await supabase
      .from("motorist_locations")
      .update(payload)
      .eq("organization_id", organizationId)
      .eq("id", vehicle.latest_location_id)
      .select("*")
      .maybeSingle();

    if (!error && data) {
      return data;
    }
  }

  const { data, error } = await supabase.from("motorist_locations").insert(payload).select("*").single();

  if (error || !data) {
    throw new MutationError("Aktuálna GPS lokácia sa nepodarila uložiť.", 500);
  }

  return data;
}

async function updateProviderVehiclePositionLink(
  supabase: AdminClient,
  organizationId: string,
  vehicleId: string,
  locationId: string,
  position: WebdispecinkPosition,
  syncedAt: string,
) {
  const { error } = await supabase
    .from("motorist_fleet_provider_vehicles")
    .update({
      latest_location_id: locationId,
      latest_position_at: position.positionTime ?? null,
      latest_local_position_at: position.localPositionTime ?? null,
      speed_kph: position.speedKph ?? null,
      odometer_km: position.odometerKm ?? null,
      raw_position: position.raw as Json,
      last_position_sync_at: syncedAt,
    })
    .eq("organization_id", organizationId)
    .eq("id", vehicleId);

  if (error) {
    throw new MutationError("Provider GPS stav sa nepodarilo aktualizovať.", 500);
  }
}

async function loadProviderVehicles(supabase: AdminClient, organizationId: string) {
  const { data, error } = await supabase
    .from("motorist_fleet_provider_vehicles")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER);

  if (error) {
    throw new MutationError("WebDispečink vozidlá sa nepodarilo načítať.", 500);
  }

  return data ?? [];
}

async function loadFleetAssets(supabase: AdminClient, organizationId: string) {
  const { data, error } = await supabase.from("motorist_fleet_assets").select("*").eq("organization_id", organizationId);

  if (error) {
    throw new MutationError("Flotila sa nepodarila načítať.", 500);
  }

  return data ?? [];
}

async function getProviderVehicle(supabase: AdminClient, organizationId: string, vehicleId: string) {
  const { data, error } = await supabase
    .from("motorist_fleet_provider_vehicles")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("id", vehicleId)
    .maybeSingle();

  if (error) {
    throw new MutationError("WebDispečink vozidlo sa nepodarilo načítať.", 500);
  }

  if (!data) {
    throw new MutationError("WebDispečink vozidlo neexistuje.", 404);
  }

  return data;
}

async function getFleetAsset(supabase: AdminClient, organizationId: string, assetId: string) {
  const { data, error } = await supabase
    .from("motorist_fleet_assets")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", assetId)
    .maybeSingle();

  if (error) {
    throw new MutationError("Fleet asset sa nepodarilo načítať.", 500);
  }

  if (!data) {
    throw new MutationError("Fleet asset neexistuje.", 404);
  }

  return data;
}

async function getBranch(supabase: AdminClient, organizationId: string, branchId: string) {
  const { data, error } = await supabase
    .from("motorist_branches")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", branchId)
    .maybeSingle();

  if (error) {
    throw new MutationError("Pobočku sa nepodarilo načítať.", 500);
  }

  if (!data) {
    throw new MutationError("Pobočka neexistuje.", 404);
  }

  return data;
}

async function updateFleetIntegrationStatus(
  supabase: AdminClient,
  organizationId: string,
  update: {
    status: "not_configured" | "configured" | "live" | "degraded" | "disabled";
    last_success_at?: string | null;
    last_error_at?: string | null;
    last_error?: string | null;
  },
) {
  const config = {
    source: PROVIDER,
    refreshSeconds: 60,
    catalogRefreshHours: 12,
    staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES,
    monthlyFreeLimit: 60_000,
  };
  const { error } = await supabase.from("motorist_organization_integrations").upsert(
    {
      organization_id: organizationId,
      provider: FLEET_INTEGRATION_PROVIDER,
      enabled: true,
      enabled_features: ["webdispecink_catalog", "webdispecink_positions"],
      base_url: configuredEnv("WEBDISPECINK_SOAP_URL") ?? DEFAULT_SOAP_URL,
      secret_ref: "env:WEBDISPECINK_COMPANY_CODE,WEBDISPECINK_USERNAME,WEBDISPECINK_PASSWORD",
      config,
      ...update,
    },
    { onConflict: "organization_id,provider" },
  );

  if (error) {
    console.warn("WebDispecink integration status update failed:", error.message);
  }
}

async function recordSyncEvent(supabase: AdminClient, organizationId: string, payload: Record<string, unknown>) {
  const { error } = await supabase.from("motorist_integration_raw_events").insert({
    organization_id: organizationId,
    provider: PROVIDER,
    channel: "rest",
    direction: "outbound",
    event_type: "fleet_sync",
    payload: payload as Json,
    headers_safe: {},
    processed_at: new Date().toISOString(),
    error: typeof payload.error === "string" ? payload.error : null,
  });

  if (error) {
    console.warn("WebDispecink sync event log failed:", error.message);
  }
}

function uniqueFleetAssetsByPlate(fleetAssets: FleetAssetRow[]) {
  const counts = new Map<string, number>();
  const assets = new Map<string, FleetAssetRow>();

  for (const asset of fleetAssets) {
    const plate = normalizePlate(asset.license_plate);

    if (!plate) {
      continue;
    }

    counts.set(plate, (counts.get(plate) ?? 0) + 1);
    assets.set(plate, asset);
  }

  for (const [plate, count] of counts) {
    if (count > 1) {
      assets.delete(plate);
    }
  }

  return assets;
}

function positionFromProviderVehicle(vehicle: FleetProviderVehicleRow): WebdispecinkPosition | null {
  const raw = jsonRecord(vehicle.raw_position);
  const lat = numberValue(raw.latitude) ?? numberValue(raw.Zs);
  const lng = numberValue(raw.longitude) ?? numberValue(raw.Zd);

  if (typeof lat !== "number" || typeof lng !== "number") {
    return null;
  }

  return {
    externalId: vehicle.external_id,
    point: { lat, lng },
    positionTime: vehicle.latest_position_at ?? undefined,
    localPositionTime: vehicle.latest_local_position_at ?? undefined,
    speedKph: vehicle.speed_kph ?? undefined,
    odometerKm: vehicle.odometer_km ?? undefined,
    raw: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value ?? "")])),
  };
}

function mergeFleetAssetGpsMetadata(
  metadata: Json,
  vehicle: FleetProviderVehicleRow,
  position: WebdispecinkPosition,
  syncedAt: string,
): Json {
  const current = jsonRecord(metadata);

  return {
    ...current,
    gps: {
      ...jsonRecord(current.gps),
      source: PROVIDER,
      externalId: vehicle.external_id,
      providerVehicleId: vehicle.id,
      positionTime: position.positionTime,
      localPositionTime: position.localPositionTime,
      syncedAt,
      speedKph: position.speedKph,
      odometerKm: position.odometerKm,
      staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES,
    },
  };
}

function normalizePlate(value: string | null | undefined) {
  const normalized = value?.replace(/[\s-]/g, "").trim().toUpperCase();
  return normalized || undefined;
}

function providerVehicleAssetLabel(vehicle: FleetProviderVehicleRow) {
  return vehicle.license_plate ?? vehicle.label ?? `WebDispečink ${vehicle.external_id}`;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function configuredEnv(name: string) {
  const value = process.env[name]?.trim();
  return value && !value.startsWith("replace-with") && value !== "TODO" ? value : undefined;
}
