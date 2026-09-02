import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

import { SwhouseClient } from "./client";
import { swhouseConfigFromEnv, type SwhouseConfig } from "./config";
import { normalizePlateForPairing } from "./replacement-vehicles";
import type { SwhouseCarOccupancyRaw, SwhouseFleetOccupancy } from "./types";

/**
 * T2 — occupancy sync (samostatný ~5-min job, ODDELENÝ od hodinového rosteru).
 * Lacný payload: getCarsOccupancy (len voľné autá) + DB roster (client_vehicle_db) na určenie flotily.
 * occupiedPlates = roster (ownerType 3/4) mínus 5-min voľné; zapíše point-in-time snapshot.
 * Reusuje motorist_fleet_sync_runs + last_success_at pre observabilitu (vzor commander sync).
 */

const ROSTER_PROVIDER = "client_vehicle_db" as const;

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type Tables = Database["public"]["Tables"];
type OrganizationRow = Tables["motorist_organizations"]["Row"];

export type SwhouseOccupancySyncResult = {
  provider: "client_vehicle_db";
  mode: "occupancy";
  status: "success" | "failed";
  syncRunId: string | null;
  rosterCount: number;
  freeCount: number;
  occupiedCount: number;
  error: string | null;
};

/**
 * Odvodí occupied/free ŠPZ z voľných áut (SWHouse) + rosteru flotily (DB).
 * Voľné ŠPZ filtruje na nakonfigurované owner typy a aktívny DB roster;
 * ghost/cudzie autá preto nemôžu vyzerať ako overene voľné.
 * Čistá funkcia — testovateľná bez siete a DB.
 */
export function computeOccupancyFromRoster(
  freeRaw: SwhouseCarOccupancyRaw[],
  rosterPlates: string[],
  fleetOwnerTypeIds: number[],
): SwhouseFleetOccupancy {
  const roster = new Set(rosterPlates.map(normalizePlateForPairing).filter(Boolean));
  const allowedOwnerTypes = new Set(fleetOwnerTypeIds);
  const free = new Set<string>();

  for (const car of freeRaw) {
    const plate = normalizePlateForPairing(car?.ecv);
    if (car.carId > 0 && allowedOwnerTypes.has(car.ownerTypeId ?? -1) && plate && roster.has(plate)) {
      free.add(plate);
    }
  }

  return {
    freePlates: [...free].sort(),
    occupiedPlates: [...roster].filter((plate) => !free.has(plate)).sort(),
  };
}

export async function syncSwhouseOccupancy(options?: {
  client?: SwhouseClient;
  config?: SwhouseConfig;
}): Promise<SwhouseOccupancySyncResult> {
  const base: SwhouseOccupancySyncResult = {
    provider: ROSTER_PROVIDER,
    mode: "occupancy",
    status: "success",
    syncRunId: null,
    rosterCount: 0,
    freeCount: 0,
    occupiedCount: 0,
    error: null,
  };

  let config: SwhouseConfig;
  try {
    config = options?.config ?? swhouseConfigFromEnv();
  } catch (error) {
    return { ...base, status: "failed", error: error instanceof Error ? error.message : "SWHouse nie je nakonfigurovaný." };
  }

  const client = options?.client ?? new SwhouseClient(config);
  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const syncRunId = await createSyncRun(supabase, organization.id);
  base.syncRunId = syncRunId;

  try {
    const occupancy = await client.getCarsOccupancy();
    if (!occupancy.ok || !Array.isArray(occupancy.data)) {
      throw new Error(`SWHouse getCarsOccupancy zlyhal (HTTP ${occupancy.status}).`);
    }

    const rosterPlates = await loadRosterPlates(supabase, organization.id);
    if (rosterPlates.length === 0) {
      throw new Error("SWHouse roster je prázdny; occupancy snapshot sa nedá bezpečne odvodiť.");
    }
    const paired = computeOccupancyFromRoster(occupancy.data, rosterPlates, config.fleetOwnerTypeIds);

    base.rosterCount = rosterPlates.length;
    base.freeCount = paired.freePlates.length;
    base.occupiedCount = paired.occupiedPlates.length;

    const captured = new Date().toISOString();
    const insert = await supabase.from("motorist_fleet_replacement_occupancy").upsert(
      {
        organization_id: organization.id,
        captured_at: captured,
        occupied_plates: paired.occupiedPlates,
        free_plates: paired.freePlates,
        source: "swhouse",
      },
      { onConflict: "organization_id" },
    );
    await throwOnResult(insert);

    await finishSyncRun(supabase, syncRunId, "success", base, null);
    await updateIntegrationStatus(supabase, organization.id, config.baseUrl, "success", null);
    return base;
  } catch (error) {
    const message = error instanceof Error ? error.message : "SWHouse occupancy sync zlyhal.";
    await finishSyncRun(supabase, syncRunId, "failed", base, message);
    await updateIntegrationStatus(supabase, organization.id, config.baseUrl, "failed", message);
    return { ...base, status: "failed", error: message };
  }
}

/** Normalizované ŠPZ celej SWHouse flotily z DB rosteru (client_vehicle_db, aktívne záznamy). */
async function loadRosterPlates(supabase: AdminClient, organizationId: string): Promise<string[]> {
  const result = await supabase
    .from("motorist_external_vehicle_records")
    .select("normalized_license_plate")
    .eq("organization_id", organizationId)
    .eq("source_provider", ROSTER_PROVIDER)
    .eq("source_active", true);
  await throwOnResult(result);
  const plates: string[] = [];
  for (const record of result.data ?? []) {
    const plate = normalizePlateForPairing(record.normalized_license_plate);
    if (plate) {
      plates.push(plate);
    }
  }
  return plates;
}

async function createSyncRun(supabase: AdminClient, organizationId: string): Promise<string> {
  const result = await supabase
    .from("motorist_fleet_sync_runs")
    .insert({
      organization_id: organizationId,
      provider: ROSTER_PROVIDER,
      mode: "occupancy",
      status: "running",
    })
    .select("id")
    .single();
  await throwOnResult(result);
  if (!result.data) {
    throw new Error("SWHouse occupancy sync run was not created.");
  }
  return result.data.id;
}

async function finishSyncRun(
  supabase: AdminClient,
  syncRunId: string,
  status: "success" | "failed",
  result: SwhouseOccupancySyncResult,
  error: string | null,
) {
  const update = await supabase
    .from("motorist_fleet_sync_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      fetched_count: result.freeCount,
      updated_count: status === "success" ? 1 : 0,
      error_count: status === "failed" ? 1 : 0,
      error_summary: error,
      metadata: { rosterCount: result.rosterCount, freeCount: result.freeCount, occupiedCount: result.occupiedCount },
    })
    .eq("id", syncRunId);
  await throwOnResult(update);
}

async function updateIntegrationStatus(
  supabase: AdminClient,
  organizationId: string,
  baseUrl: string,
  status: "success" | "failed",
  error: string | null,
) {
  const now = new Date().toISOString();
  const result = await supabase.from("motorist_organization_integrations").upsert(
    {
      organization_id: organizationId,
      provider: ROSTER_PROVIDER,
      enabled: true,
      status: status === "success" ? "live" : "degraded",
      enabled_features: ["replacement_roster", "replacement_occupancy"],
      base_url: baseUrl,
      secret_ref: "SWHOUSE_BASIC_USERNAME,SWHOUSE_LOGIN_USERNAME",
      ...(status === "success" ? { last_success_at: now, last_error: null } : { last_error_at: now, last_error: error ?? "SWHouse occupancy sync zlyhal." }),
    },
    { onConflict: "organization_id,provider" },
  );
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

async function throwOnResult(result: { error: unknown }) {
  if (result.error) {
    throw result.error;
  }
}
