import "server-only";
import { vinFromRegistration } from "@/lib/fleet-pairing";

import { createHash } from "node:crypto";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import { CommanderClient, CommanderConfigError, type CommanderResponse } from "./client";

export type CommanderSyncMode = "vehicles" | "positions" | "rides" | "full";

export type CommanderSyncRequest = {
  mode: CommanderSyncMode;
  dryRun?: boolean;
  datetimeStart?: number;
  datetimeEnd?: number;
};

export type CommanderSyncResult = SyncCounters & {
  provider: "commander";
  mode: CommanderSyncMode;
  dryRun: boolean;
  status: "success" | "partial" | "failed";
  syncRunId: string | null;
  endpointErrors: EndpointError[];
};

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type Tables = Database["public"]["Tables"];
type OrganizationRow = Tables["motorist_organizations"]["Row"];
type ExternalVehicleRecordRow = Tables["motorist_external_vehicle_records"]["Row"];
type FleetAssetRow = Tables["motorist_fleet_assets"]["Row"];
type FleetAssetLinkRow = Tables["motorist_fleet_asset_links"]["Row"];
type FleetCurrentPositionRow = Tables["motorist_fleet_current_positions"]["Row"];

type SyncCounters = {
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  linkedCount: number;
  candidateCount: number;
  skippedCount: number;
  errorCount: number;
  successfulEndpointCount: number;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  rateLimitReset: string | null;
  retryAfterSeconds: number | null;
};

type EndpointError = {
  endpoint: string;
  status: number;
  message: string;
};

type ParsedVehicle = {
  sourceVehicleId: string;
  normalizedLicensePlate: string | null;
  normalizedVin: string | null;
  label: string | null;
  make: string | null;
  model: string | null;
  active: boolean;
  deletedAt: string | null;
  lastSeenAt: string | null;
  raw: Record<string, unknown>;
};

type ParsedPosition = {
  sourceVehicleId: string;
  gpsTime: string;
  lat: number;
  lng: number;
  speedKmh: number | null;
  headingDegrees: number | null;
  ignitionOn: boolean | null;
  odometerM: number | null;
  payloadHash: string;
  raw: Record<string, unknown>;
};

type ParsedRide = {
  sourceVehicleId: string;
  sourceTripId: string;
  startedAt: string;
  endedAt: string | null;
  startLat: number | null;
  startLng: number | null;
  stopLat: number | null;
  stopLng: number | null;
  startAddress: string | null;
  stopAddress: string | null;
  durationS: number | null;
  distanceM: number | null;
  odometerStartM: number | null;
  odometerEndM: number | null;
  driverId: string | null;
  driverName: string | null;
  normalizedLicensePlate: string | null;
  raw: Record<string, unknown>;
};

const SOURCE_PROVIDER = "commander" as const;
const DEFAULT_RIDES_LOOKBACK_SECONDS = 24 * 60 * 60;
// Ctíme `retry-after` (a 429) reálnym backoffom pred ďalším paging requestom; strop, nech jeden beh nevisí donekonečna.
const RATE_LIMIT_MAX_BACKOFF_SECONDS = 30;
const RATE_LIMIT_MAX_RETRIES = 2;

/**
 * Koľko milisekúnd počkať pred ďalším Commander requestom podľa rate-limit hlavičiek.
 * 429 alebo prítomný `retry-after` → počkaj retry-after sekúnd (capnuté); inak 0. Čistá funkcia (testovateľná).
 */
export function rateLimitBackoffMs(
  response: CommanderResponse<unknown>,
  capSeconds: number = RATE_LIMIT_MAX_BACKOFF_SECONDS,
): number {
  const retryAfter = response.rateLimit.retryAfterSeconds;
  const rateLimited = response.status === 429 || (typeof retryAfter === "number" && retryAfter > 0);
  if (!rateLimited) {
    return 0;
  }
  const seconds = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : 1;
  return Math.min(seconds, capSeconds) * 1000;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Zopakuje TEN ISTÝ request po 429, až po `retry-after`, a vráti celú históriu pokusov. */
export async function requestWithRateLimitRetry<T>(
  request: () => Promise<CommanderResponse<T>>,
  options: { maxRetries?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<CommanderResponse<T>[]> {
  const maxRetries = options.maxRetries ?? RATE_LIMIT_MAX_RETRIES;
  const sleepFn = options.sleepFn ?? sleep;
  const responses: CommanderResponse<T>[] = [];

  for (let retry = 0; ; retry += 1) {
    const response = await request();
    responses.push(response);

    if (response.status !== 429 || retry >= maxRetries) {
      return responses;
    }

    await sleepFn(rateLimitBackoffMs(response));
  }
}

export async function syncCommander(request: CommanderSyncRequest): Promise<CommanderSyncResult> {
  const client = new CommanderClient();
  const counters = emptyCounters();
  const endpointErrors: EndpointError[] = [];

  if (request.dryRun) {
    await runCommanderFetches(client, request, counters, endpointErrors, null, null);
    return syncResult(request.mode, true, null, counters, endpointErrors);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const syncRunId = await createSyncRun(supabase, organization.id, request.mode);

  try {
    await runCommanderFetches(client, request, counters, endpointErrors, supabase, organization);
    const status = statusFromCounters(counters, endpointErrors);
    await finishSyncRun(supabase, syncRunId, status, counters, endpointErrors);
    await updateIntegrationStatus(supabase, organization.id, status, endpointErrors);
    return syncResult(request.mode, false, syncRunId, counters, endpointErrors);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Commander sync failed.";
    counters.errorCount += 1;
    endpointErrors.push({ endpoint: "sync", status: 500, message });
    await finishSyncRun(supabase, syncRunId, "failed", counters, endpointErrors);
    await updateIntegrationStatus(supabase, organization.id, "failed", endpointErrors);
    return syncResult(request.mode, false, syncRunId, counters, endpointErrors, "failed");
  }
}

export function isCommanderConfigError(error: unknown): error is CommanderConfigError {
  return error instanceof CommanderConfigError;
}

async function runCommanderFetches(
  client: CommanderClient,
  request: CommanderSyncRequest,
  counters: SyncCounters,
  endpointErrors: EndpointError[],
  supabase: AdminClient | null,
  organization: OrganizationRow | null,
) {
  if (request.mode === "vehicles" || request.mode === "full") {
    const response = await client.listVehicles();
    captureRateLimit(counters, response);
    await recordRawEvent(supabase, organization?.id, response);

    if (!response.ok) {
      recordEndpointError(endpointErrors, counters, response);
    } else {
      counters.successfulEndpointCount += 1;
      const vehicles = arrayFromPayload(response.data?.vehicles).map(parseVehicle).filter(isPresent);
      counters.fetchedCount += vehicles.length;
      if (supabase && organization) {
        await syncVehicles(supabase, organization.id, vehicles, counters);
      }
    }
  }

  if (request.mode === "positions" || request.mode === "full") {
    const responses = await fetchAllPositions(client);
    for (const response of responses) {
      captureRateLimit(counters, response);
      await recordRawEvent(supabase, organization?.id, response);

      if (!response.ok) {
        recordEndpointError(endpointErrors, counters, response);
        continue;
      }

      counters.successfulEndpointCount += 1;
      const positions = arrayFromPayload(response.data?.positions).map(parsePosition);
      counters.fetchedCount += positions.length;
      const validPositions = positions.filter(isPresent);
      counters.skippedCount += positions.length - validPositions.length;

      if (supabase && organization) {
        await syncPositions(supabase, organization.id, validPositions, counters);
      }
    }
  }

  if (request.mode === "rides" || request.mode === "full") {
    const { datetimeStart, datetimeEnd } = rideWindow(request);
    const responses = await fetchAllRides(client, datetimeStart, datetimeEnd);
    for (const response of responses) {
      captureRateLimit(counters, response);
      await recordRawEvent(supabase, organization?.id, response);

      if (!response.ok) {
        recordEndpointError(endpointErrors, counters, response);
        continue;
      }

      counters.successfulEndpointCount += 1;
      const rides = arrayFromPayload(response.data?.rides).map(parseRide).filter(isPresent);
      counters.fetchedCount += rides.length;

      if (supabase && organization) {
        await syncRides(supabase, organization.id, rides, counters);
      }
    }
  }
}

async function fetchAllPositions(client: CommanderClient) {
  const responses: Array<Awaited<ReturnType<CommanderClient["listLastPositions"]>>> = [];
  let page = 1;
  let totalPages = 1;

  do {
    const pageResponses = await requestWithRateLimitRetry(() => client.listLastPositions(page));
    const response = pageResponses[pageResponses.length - 1];
    // Do ďalšieho spracovania posuň iba konečný výsledok. Obnovený 429 nesmie
    // označiť inak úspešný sync ako partial ani zapísať chybný raw event.
    responses.push(response);

    if (!response.ok) {
      break;
    }

    totalPages = positiveInteger(response.data?.totalPages) ?? 1;
    page += 1;

    if (page <= totalPages) {
      const backoff = rateLimitBackoffMs(response);
      if (backoff > 0) {
        await sleep(backoff);
      }
    }
  } while (page <= totalPages);

  return responses;
}

async function fetchAllRides(client: CommanderClient, datetimeStart: number, datetimeEnd: number) {
  const responses: Array<Awaited<ReturnType<CommanderClient["listAllRides"]>>> = [];
  let page = 1;
  let totalPages = 1;

  do {
    const pageResponses = await requestWithRateLimitRetry(() => client.listAllRides({ datetimeStart, datetimeEnd, page }));
    const response = pageResponses[pageResponses.length - 1];
    responses.push(response);

    if (!response.ok) {
      break;
    }

    totalPages = positiveInteger(response.data?.totalPages) ?? 1;
    page += 1;

    if (page <= totalPages) {
      const backoff = rateLimitBackoffMs(response);
      if (backoff > 0) {
        await sleep(backoff);
      }
    }
  } while (page <= totalPages);

  return responses;
}

async function syncVehicles(supabase: AdminClient, organizationId: string, vehicles: ParsedVehicle[], counters: SyncCounters) {
  if (vehicles.length === 0) {
    return new Map<string, ExternalVehicleRecordRow>();
  }

  const sourceIds = vehicles.map((vehicle) => vehicle.sourceVehicleId);
  const existing = await supabase
    .from("motorist_external_vehicle_records")
    .select("id,source_vehicle_id")
    .eq("organization_id", organizationId)
    .eq("source_provider", SOURCE_PROVIDER)
    .in("source_vehicle_id", sourceIds);
  await throwOnResult(existing);
  const existingIds = new Set((existing.data ?? []).map((record) => record.source_vehicle_id));
  const now = new Date().toISOString();

  const upsert = await supabase
    .from("motorist_external_vehicle_records")
    .upsert(
      vehicles.map((vehicle) => ({
        organization_id: organizationId,
        source_provider: SOURCE_PROVIDER,
        source_vehicle_id: vehicle.sourceVehicleId,
        normalized_license_plate: vehicle.normalizedLicensePlate,
        normalized_vin: vehicle.normalizedVin,
        label: vehicle.label,
        make: vehicle.make,
        model: vehicle.model,
        kind_hint: "replacement_car" as const,
        source_active: vehicle.active,
        source_deleted_at: vehicle.deletedAt,
        latest_payload_snapshot: toJson(vehicle.raw),
        last_seen_at: vehicle.lastSeenAt,
        last_imported_at: now,
      })),
      { onConflict: "organization_id,source_provider,source_vehicle_id" },
    )
    .select("*");
  await throwOnResult(upsert);

  counters.createdCount += vehicles.filter((vehicle) => !existingIds.has(vehicle.sourceVehicleId)).length;
  counters.updatedCount += vehicles.filter((vehicle) => existingIds.has(vehicle.sourceVehicleId)).length;

  const records = new Map((upsert.data ?? []).map((record) => [record.source_vehicle_id, record]));
  await createCandidateLinks(supabase, organizationId, Array.from(records.values()), counters);
  return records;
}

async function syncPositions(supabase: AdminClient, organizationId: string, positions: ParsedPosition[], counters: SyncCounters) {
  if (positions.length === 0) {
    return;
  }

  const samplePositions = dedupeSamplePositions(positions, counters);
  const currentPositions = latestPositionByVehicle(samplePositions);

  const records = await ensureExternalRecords(
    supabase,
    organizationId,
    samplePositions.map((position) => ({
      sourceVehicleId: position.sourceVehicleId,
      normalizedLicensePlate: null,
      normalizedVin: null,
      label: null,
      make: null,
      model: null,
      active: true,
      deletedAt: null,
      lastSeenAt: position.gpsTime,
      raw: { source: "last-positions" },
    })),
    counters,
  );
  const externalIds = Array.from(records.values()).map((record) => record.id);
  const confirmedLinks = await confirmedLinksByExternalId(supabase, organizationId, externalIds);
  const now = new Date().toISOString();

  const sampleRows = samplePositions.map((position) => {
    const record = records.get(position.sourceVehicleId);
    const link = record ? confirmedLinks.get(record.id) : undefined;

    return {
      organization_id: organizationId,
      external_vehicle_record_id: requireRecord(record, position.sourceVehicleId).id,
      fleet_asset_id: link?.fleet_asset_id ?? null,
      source_provider: SOURCE_PROVIDER,
      source_vehicle_id: position.sourceVehicleId,
      sampled_at: position.gpsTime,
      lat: position.lat,
      lng: position.lng,
      speed_kmh: position.speedKmh,
      heading_degrees: position.headingDegrees,
      ignition_on: position.ignitionOn,
      odometer_m: position.odometerM,
      payload_hash: position.payloadHash,
      latest_payload_snapshot: toJson(position.raw),
      received_at: now,
    };
  });
  const samples = await supabase
    .from("motorist_fleet_position_samples")
    .upsert(sampleRows, { onConflict: "organization_id,source_provider,source_vehicle_id,sampled_at" });
  await throwOnResult(samples);

  const current = await supabase
    .from("motorist_fleet_current_positions")
    .select("*")
    .eq("organization_id", organizationId)
    .in("external_vehicle_record_id", externalIds);
  await throwOnResult(current);
  const currentByExternalId = new Map((current.data ?? []).map((row) => [row.external_vehicle_record_id, row]));
  const currentRows = [];

  for (const position of currentPositions) {
    const record = requireRecord(records.get(position.sourceVehicleId), position.sourceVehicleId);
    const link = confirmedLinks.get(record.id);
    const existing = currentByExternalId.get(record.id);
    const decision = currentPositionDecision(existing, position);

    if (decision === "skip") {
      counters.skippedCount += 1;
      continue;
    }

    if (existing) {
      counters.updatedCount += 1;
    } else {
      counters.createdCount += 1;
    }

    currentRows.push({
      organization_id: organizationId,
      external_vehicle_record_id: record.id,
      fleet_asset_id: link?.fleet_asset_id ?? null,
      source_provider: SOURCE_PROVIDER,
      source_vehicle_id: position.sourceVehicleId,
      gps_time: position.gpsTime,
      lat: position.lat,
      lng: position.lng,
      speed_kmh: position.speedKmh,
      heading_degrees: position.headingDegrees,
      ignition_on: position.ignitionOn,
      odometer_m: position.odometerM,
      payload_hash: position.payloadHash,
      latest_payload_snapshot: toJson(position.raw),
      received_at: now,
    });
  }

  if (currentRows.length > 0) {
    const currentUpsert = await supabase
      .from("motorist_fleet_current_positions")
      .upsert(currentRows, { onConflict: "organization_id,external_vehicle_record_id" });
    await throwOnResult(currentUpsert);
  }
}

async function syncRides(supabase: AdminClient, organizationId: string, rides: ParsedRide[], counters: SyncCounters) {
  if (rides.length === 0) {
    return;
  }

  const records = await ensureExternalRecords(
    supabase,
    organizationId,
    rides.map((ride) => ({
      sourceVehicleId: ride.sourceVehicleId,
      normalizedLicensePlate: ride.normalizedLicensePlate,
      normalizedVin: null,
      label: null,
      make: null,
      model: null,
      active: true,
      deletedAt: null,
      lastSeenAt: ride.endedAt ?? ride.startedAt,
      raw: { source: "all-rides" },
    })),
    counters,
  );
  const externalIds = Array.from(records.values()).map((record) => record.id);
  const confirmedLinks = await confirmedLinksByExternalId(supabase, organizationId, externalIds);
  const existing = await supabase
    .from("motorist_fleet_trips")
    .select("source_trip_id")
    .eq("organization_id", organizationId)
    .eq("source_provider", SOURCE_PROVIDER)
    .in("source_trip_id", rides.map((ride) => ride.sourceTripId));
  await throwOnResult(existing);
  const existingIds = new Set((existing.data ?? []).map((trip) => trip.source_trip_id));
  const rows = rides.map((ride) => {
    const record = requireRecord(records.get(ride.sourceVehicleId), ride.sourceVehicleId);
    const link = confirmedLinks.get(record.id);

    return {
      organization_id: organizationId,
      external_vehicle_record_id: record.id,
      fleet_asset_id: link?.fleet_asset_id ?? null,
      source_provider: SOURCE_PROVIDER,
      source_vehicle_id: ride.sourceVehicleId,
      source_trip_id: ride.sourceTripId,
      status: "details_unavailable" as const,
      started_at: ride.startedAt,
      ended_at: ride.endedAt,
      start_lat: ride.startLat,
      start_lng: ride.startLng,
      stop_lat: ride.stopLat,
      stop_lng: ride.stopLng,
      start_address: ride.startAddress,
      stop_address: ride.stopAddress,
      duration_s: ride.durationS,
      distance_m: ride.distanceM,
      odometer_start_m: ride.odometerStartM,
      odometer_end_m: ride.odometerEndM,
      driver_id: ride.driverId,
      driver_name: ride.driverName,
      latest_payload_snapshot: toJson(ride.raw),
      imported_at: new Date().toISOString(),
    };
  });
  const result = await supabase.from("motorist_fleet_trips").upsert(rows, { onConflict: "organization_id,source_provider,source_trip_id" });
  await throwOnResult(result);

  counters.createdCount += rides.filter((ride) => !existingIds.has(ride.sourceTripId)).length;
  counters.updatedCount += rides.filter((ride) => existingIds.has(ride.sourceTripId)).length;
}

async function ensureExternalRecords(
  supabase: AdminClient,
  organizationId: string,
  vehicles: ParsedVehicle[],
  counters: SyncCounters,
) {
  const unique = Array.from(new Map(vehicles.map((vehicle) => [vehicle.sourceVehicleId, vehicle])).values());
  if (unique.length === 0) {
    return new Map<string, ExternalVehicleRecordRow>();
  }

  const sourceIds = unique.map((vehicle) => vehicle.sourceVehicleId);
  const existing = await supabase
    .from("motorist_external_vehicle_records")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("source_provider", SOURCE_PROVIDER)
    .in("source_vehicle_id", sourceIds);
  await throwOnResult(existing);

  const existingIds = new Set((existing.data ?? []).map((record) => record.source_vehicle_id));
  const missing = unique.filter((vehicle) => !existingIds.has(vehicle.sourceVehicleId));

  if (missing.length > 0) {
    const insert = await supabase
      .from("motorist_external_vehicle_records")
      .insert(
        missing.map((vehicle) => ({
          organization_id: organizationId,
          source_provider: SOURCE_PROVIDER,
          source_vehicle_id: vehicle.sourceVehicleId,
          normalized_license_plate: vehicle.normalizedLicensePlate,
          normalized_vin: vehicle.normalizedVin,
          label: vehicle.label,
          make: vehicle.make,
          model: vehicle.model,
          kind_hint: "replacement_car" as const,
          source_active: vehicle.active,
          source_deleted_at: vehicle.deletedAt,
          latest_payload_snapshot: toJson(vehicle.raw),
          last_seen_at: vehicle.lastSeenAt,
          last_imported_at: new Date().toISOString(),
        })),
      );
    await throwOnResult(insert);
    counters.createdCount += missing.length;
  }

  const refreshed = await supabase
    .from("motorist_external_vehicle_records")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("source_provider", SOURCE_PROVIDER)
    .in("source_vehicle_id", sourceIds);
  await throwOnResult(refreshed);

  return new Map((refreshed.data ?? []).map((record) => [record.source_vehicle_id, record]));
}

async function createCandidateLinks(
  supabase: AdminClient,
  organizationId: string,
  externalRecords: ExternalVehicleRecordRow[],
  counters: SyncCounters,
) {
  const candidates = externalRecords.filter((record) => record.normalized_vin || record.normalized_license_plate);
  if (candidates.length === 0) {
    return;
  }

  const assetsResult = await supabase
    .from("motorist_fleet_assets")
    .select("id,license_plate,vin")
    .eq("organization_id", organizationId);
  await throwOnResult(assetsResult);
  const assets = assetsResult.data ?? [];
  const existingLinks = await supabase
    .from("motorist_fleet_asset_links")
    .select("fleet_asset_id,external_vehicle_record_id,link_status")
    .eq("organization_id", organizationId)
    .in("external_vehicle_record_id", candidates.map((record) => record.id));
  await throwOnResult(existingLinks);
  const existingPairs = new Set((existingLinks.data ?? []).map((link) => `${link.external_vehicle_record_id}:${link.fleet_asset_id}`));
  const rows = [];

  for (const record of candidates) {
    const match = bestFleetMatch(record, assets);
    if (!match || existingPairs.has(`${record.id}:${match.asset.id}`)) {
      continue;
    }

    rows.push({
      organization_id: organizationId,
      fleet_asset_id: match.asset.id,
      external_vehicle_record_id: record.id,
      source_provider: SOURCE_PROVIDER,
      link_status: "candidate" as const,
      match_method: match.method,
      match_confidence: match.confidence,
      metadata: {
        normalizedLicensePlate: record.normalized_license_plate,
        normalizedVin: record.normalized_vin,
      },
    });
  }

  if (rows.length === 0) {
    return;
  }

  const insert = await supabase.from("motorist_fleet_asset_links").insert(rows);
  await throwOnResult(insert);
  counters.candidateCount += rows.length;
}

function bestFleetMatch(record: ExternalVehicleRecordRow, assets: Array<Pick<FleetAssetRow, "id" | "license_plate" | "vin">>) {
  const vinMatches = record.normalized_vin
    ? assets.filter((asset) => normalizeVin(asset.vin) === record.normalized_vin)
    : [];
  if (vinMatches.length === 1) {
    return { asset: vinMatches[0], method: "vin" as const, confidence: 1 };
  }

  const plateMatches = record.normalized_license_plate
    ? assets.filter((asset) => normalizeLicensePlate(asset.license_plate) === record.normalized_license_plate)
    : [];
  if (plateMatches.length === 1) {
    return { asset: plateMatches[0], method: "license_plate" as const, confidence: 0.9 };
  }

  return null;
}

function dedupeSamplePositions(positions: ParsedPosition[], counters: SyncCounters) {
  const bySampleKey = new Map<string, ParsedPosition>();

  for (const position of positions) {
    const key = `${position.sourceVehicleId}:${position.gpsTime}`;
    const existing = bySampleKey.get(key);

    if (!existing || comparePositionTieBreak(position, existing) > 0) {
      bySampleKey.set(key, position);
    }
  }

  counters.skippedCount += positions.length - bySampleKey.size;
  return Array.from(bySampleKey.values()).sort(comparePositionOrder);
}

function latestPositionByVehicle(positions: ParsedPosition[]) {
  const byVehicle = new Map<string, ParsedPosition>();

  for (const position of positions) {
    const existing = byVehicle.get(position.sourceVehicleId);
    if (!existing || compareCurrentPosition(position, existing) > 0) {
      byVehicle.set(position.sourceVehicleId, position);
    }
  }

  return Array.from(byVehicle.values()).sort(comparePositionOrder);
}

function compareCurrentPosition(a: ParsedPosition, b: ParsedPosition) {
  const timeDelta = new Date(a.gpsTime).getTime() - new Date(b.gpsTime).getTime();
  return timeDelta || comparePositionTieBreak(a, b);
}

function comparePositionOrder(a: ParsedPosition, b: ParsedPosition) {
  return a.sourceVehicleId.localeCompare(b.sourceVehicleId) || a.gpsTime.localeCompare(b.gpsTime) || comparePositionTieBreak(a, b);
}

function comparePositionTieBreak(a: ParsedPosition, b: ParsedPosition) {
  return a.payloadHash.localeCompare(b.payloadHash) || JSON.stringify(a.raw).localeCompare(JSON.stringify(b.raw));
}

async function confirmedLinksByExternalId(supabase: AdminClient, organizationId: string, externalIds: string[]) {
  if (externalIds.length === 0) {
    return new Map<string, FleetAssetLinkRow>();
  }

  const links = await supabase
    .from("motorist_fleet_asset_links")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("source_provider", SOURCE_PROVIDER)
    .eq("link_status", "confirmed")
    .in("external_vehicle_record_id", externalIds);
  await throwOnResult(links);
  return new Map((links.data ?? []).map((link) => [link.external_vehicle_record_id, link]));
}

function currentPositionDecision(existing: FleetCurrentPositionRow | undefined, incoming: ParsedPosition) {
  if (!existing) {
    return "upsert";
  }

  const existingTime = new Date(existing.gps_time).getTime();
  const incomingTime = new Date(incoming.gpsTime).getTime();

  if (incomingTime > existingTime) {
    return "upsert";
  }

  if (incomingTime === existingTime && existing.payload_hash !== incoming.payloadHash) {
    return "upsert";
  }

  return "skip";
}

async function createSyncRun(supabase: AdminClient, organizationId: string, mode: CommanderSyncMode) {
  const result = await supabase
    .from("motorist_fleet_sync_runs")
    .insert({
      organization_id: organizationId,
      provider: SOURCE_PROVIDER,
      mode,
      status: "running",
    })
    .select("id")
    .single();
  await throwOnResult(result);

  if (!result.data) {
    throw new Error("Commander sync run was not created.");
  }

  return result.data.id;
}

async function finishSyncRun(
  supabase: AdminClient,
  syncRunId: string,
  status: "success" | "partial" | "failed",
  counters: SyncCounters,
  endpointErrors: EndpointError[],
) {
  const result = await supabase
    .from("motorist_fleet_sync_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      fetched_count: counters.fetchedCount,
      created_count: counters.createdCount,
      updated_count: counters.updatedCount,
      linked_count: counters.linkedCount,
      candidate_count: counters.candidateCount,
      skipped_count: counters.skippedCount,
      error_count: counters.errorCount,
      rate_limit_limit: counters.rateLimitLimit,
      rate_limit_remaining: counters.rateLimitRemaining,
      rate_limit_reset: counters.rateLimitReset,
      retry_after_seconds: counters.retryAfterSeconds,
      endpoint_errors: toJson(endpointErrors),
      error_summary: endpointErrors.map((error) => `${error.endpoint}: ${error.message}`).join("; ") || null,
    })
    .eq("id", syncRunId);
  await throwOnResult(result);
}

async function updateIntegrationStatus(
  supabase: AdminClient,
  organizationId: string,
  status: "success" | "partial" | "failed",
  endpointErrors: EndpointError[],
) {
  const now = new Date().toISOString();
  const integrationStatus = status === "success" ? "live" : status === "partial" ? "degraded" : "degraded";
  const result = await supabase
    .from("motorist_organization_integrations")
    .upsert(
      {
        organization_id: organizationId,
        provider: SOURCE_PROVIDER,
        enabled: true,
        status: integrationStatus,
        enabled_features: ["vehicles", "last_positions", "all_rides"],
        base_url: process.env.COMMANDER_API_BASE_URL?.trim() || "https://online.commander-systems.com/api/v1",
        secret_ref: "COMMANDER_API_USERNAME,COMMANDER_API_PASSWORD",
        ...(status === "success"
          ? { last_success_at: now, last_error: null }
          : {
              last_error_at: now,
              last_error: endpointErrors.map((error) => error.message).join("; ") || "Commander sync failed.",
            }),
      },
      { onConflict: "organization_id,provider" },
    );
  await throwOnResult(result);
}

async function recordRawEvent(supabase: AdminClient | null, organizationId: string | undefined, response: CommanderResponse<unknown>) {
  if (!supabase || !organizationId) {
    return;
  }

  const result = await supabase.from("motorist_integration_raw_events").insert({
    organization_id: organizationId,
    provider: SOURCE_PROVIDER,
    channel: "rest",
    direction: "inbound",
    event_type: `commander.${response.endpoint}`,
    correlation_id: response.path,
    status_code: response.status,
    payload: toJson({
      path: response.path,
      ok: response.ok,
      data: response.data,
      error: response.error,
    }),
    headers_safe: toJson(response.headersSafe),
    processed_at: new Date().toISOString(),
    error: response.error,
  });
  await throwOnResult(result);
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

function parseVehicle(value: unknown): ParsedVehicle | null {
  const raw = objectRecord(value);
  if (!raw) {
    return null;
  }

  const sourceVehicleId = stringValue(raw.vehicleId);
  if (!sourceVehicleId) {
    return null;
  }

  const deleted = booleanValue(raw.deleted) ?? false;

  return {
    sourceVehicleId,
    normalizedLicensePlate: normalizeLicensePlate(raw.vehicleRegistrationPlate),
    normalizedVin: normalizeVin(raw.vehicleVIN) ?? vinFromRegistration(raw.vehicleRegistrationPlate),
    label: stringValue(raw.vehicleName) ?? stringValue(raw.vehicleRegistrationPlate),
    make: stringValue(raw.vehicleManufacturer) ?? stringValue(raw.vehicleMake),
    model: stringValue(raw.vehicleModel),
    active: !deleted,
    deletedAt: deleted ? new Date().toISOString() : null,
    lastSeenAt: dateValue(raw.lastCommunication),
    raw,
  };
}

function parsePosition(value: unknown): ParsedPosition | null {
  const raw = objectRecord(value);
  if (!raw) {
    return null;
  }

  const sourceVehicleId = stringValue(raw.vehicleId);
  const gpsTime = dateValue(raw.gpsTime);
  const lat = numberValue(raw.gpsLat);
  const lng = numberValue(raw.gpsLon);

  if (!sourceVehicleId || !gpsTime || !validLat(lat) || !validLng(lng) || (lat === 0 && lng === 0) || Date.parse(gpsTime) > Date.now() + 60_000) {
    return null;
  }

  return {
    sourceVehicleId,
    gpsTime,
    lat,
    lng,
    speedKmh: nonNegative(numberValue(raw.gpsSpeed) ?? numberValue(raw.canSpeed)),
    headingDegrees: headingValue(raw.gpsAzimut),
    ignitionOn: booleanValue(raw.carIgnition),
    odometerM: nonNegative(numberValue(raw.canOdometer)),
    payloadHash: payloadHash(raw),
    raw,
  };
}

function parseRide(value: unknown): ParsedRide | null {
  const raw = objectRecord(value);
  if (!raw) {
    return null;
  }

  const sourceVehicleId = stringValue(raw.vehicleId);
  const sourceTripId = stringValue(raw.rideId);
  const startedAt = dateValue(raw.startTime);

  if (!sourceVehicleId || !sourceTripId || !startedAt) {
    return null;
  }

  return {
    sourceVehicleId,
    sourceTripId,
    startedAt,
    endedAt: dateValue(raw.stopTime),
    startLat: nullableLat(raw.latStart),
    startLng: nullableLng(raw.lonStart),
    stopLat: nullableLat(raw.latStop),
    stopLng: nullableLng(raw.lonStop),
    startAddress: stringValue(raw.startAddress),
    stopAddress: stringValue(raw.stopAddress),
    durationS: positiveInteger(raw.duration),
    distanceM: nonNegative(numberValue(raw.distance)),
    odometerStartM: nonNegative(numberValue(raw.odometerStart)),
    odometerEndM: nonNegative(numberValue(raw.odometerStop)),
    driverId: stringValue(raw.driverId),
    driverName: stringValue(raw.driverName),
    normalizedLicensePlate: normalizeLicensePlate(raw.vehicleRegistrationPlate),
    raw,
  };
}

function recordEndpointError(endpointErrors: EndpointError[], counters: SyncCounters, response: CommanderResponse<unknown>) {
  counters.errorCount += 1;
  endpointErrors.push({
    endpoint: response.endpoint,
    status: response.status,
    message: response.error ?? "Commander endpoint failed.",
  });
}

function statusFromCounters(counters: SyncCounters, endpointErrors: EndpointError[]) {
  if (endpointErrors.length === 0) {
    return "success";
  }

  if (counters.successfulEndpointCount > 0 || counters.fetchedCount > 0 || counters.createdCount > 0 || counters.updatedCount > 0) {
    return "partial";
  }

  return "failed";
}

function syncResult(
  mode: CommanderSyncMode,
  dryRun: boolean,
  syncRunId: string | null,
  counters: SyncCounters,
  endpointErrors: EndpointError[],
  statusOverride?: CommanderSyncResult["status"],
): CommanderSyncResult {
  return {
    provider: SOURCE_PROVIDER,
    mode,
    dryRun,
    status: statusOverride ?? statusFromCounters(counters, endpointErrors),
    syncRunId,
    endpointErrors,
    ...counters,
  };
}

function emptyCounters(): SyncCounters {
  return {
    fetchedCount: 0,
    createdCount: 0,
    updatedCount: 0,
    linkedCount: 0,
    candidateCount: 0,
    skippedCount: 0,
    errorCount: 0,
    successfulEndpointCount: 0,
    rateLimitLimit: null,
    rateLimitRemaining: null,
    rateLimitReset: null,
    retryAfterSeconds: null,
  };
}

function rideWindow(request: CommanderSyncRequest) {
  const datetimeEnd = request.datetimeEnd ?? Math.floor(Date.now() / 1000);
  const datetimeStart = request.datetimeStart ?? datetimeEnd - DEFAULT_RIDES_LOOKBACK_SECONDS;
  return { datetimeStart, datetimeEnd };
}

function captureRateLimit(counters: SyncCounters, response: CommanderResponse<unknown>) {
  counters.rateLimitLimit = response.rateLimit.limit ?? counters.rateLimitLimit;
  counters.rateLimitRemaining = response.rateLimit.remaining ?? counters.rateLimitRemaining;
  counters.rateLimitReset = response.rateLimit.reset ?? counters.rateLimitReset;
  counters.retryAfterSeconds = response.rateLimit.retryAfterSeconds ?? counters.retryAfterSeconds;
}

function arrayFromPayload(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(",", ".").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function booleanValue(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : null;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "zapnute", "zapnuté"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", "vypnute", "vypnuté"].includes(normalized)) {
      return false;
    }
  }

  return null;
}

function dateValue(value: unknown) {
  const numeric = numberValue(value);
  if (numeric && numeric > 0) {
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const text = stringValue(value);
  if (!text) {
    return null;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeLicensePlate(value: unknown) {
  const text = stringValue(value);
  return text ? text.toUpperCase().replace(/[^A-Z0-9]/g, "") || null : null;
}

function normalizeVin(value: unknown) {
  const text = stringValue(value);
  return text ? text.toUpperCase().replace(/[^A-Z0-9]/g, "") || null : null;
}

function validLat(value: number | null): value is number {
  return value !== null && value >= -90 && value <= 90;
}

function validLng(value: number | null): value is number {
  return value !== null && value >= -180 && value <= 180;
}

function nullableLat(value: unknown) {
  const parsed = numberValue(value);
  return validLat(parsed) ? parsed : null;
}

function nullableLng(value: unknown) {
  const parsed = numberValue(value);
  return validLng(parsed) ? parsed : null;
}

function headingValue(value: unknown) {
  const parsed = numberValue(value);
  if (parsed === null) {
    return null;
  }

  const normalized = parsed % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function nonNegative(value: number | null) {
  return value !== null && value >= 0 ? value : null;
}

function positiveInteger(value: unknown) {
  const parsed = numberValue(value);
  return parsed !== null && parsed >= 0 ? Math.round(parsed) : null;
}

function payloadHash(value: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireRecord(record: ExternalVehicleRecordRow | undefined, sourceVehicleId: string) {
  if (!record) {
    throw new Error(`External vehicle record ${sourceVehicleId} was not created.`);
  }

  return record;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

async function throwOnResult(result: { error: unknown }) {
  if (result.error) {
    throw result.error;
  }
}
