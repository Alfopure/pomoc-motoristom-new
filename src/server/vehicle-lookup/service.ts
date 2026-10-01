import "server-only";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseServiceEnv } from "@/lib/supabase/env";
import { isTestLiveDeployment } from "@/lib/app-environment";
import type { MotoristActor } from "@/server/api-auth";
import { lookupIdentityConflict, type VehicleLookupResponse, type VehicleLookupResult, type VehicleQuery } from "@/lib/vehicle-lookup";
import { sealVehicleLookup } from "./snapshot";
import { executeVehicleLookup, type LookupProviders } from "./execute";
import type { Database, Json } from "@/lib/supabase/database.types";

export class VehicleLookupError extends Error { constructor(message: string, public status = 503, public retryAfter?: number) { super(message); } }
type Claim = { status: "cached"; result: VehicleLookupResult } | { status: "reserved"; token: string; providers: LookupProviders } | { status: "pending" | "disabled" | "rate_limited" };

export async function lookupVehicle(query: VehicleQuery, actor: MotoristActor): Promise<VehicleLookupResponse> {
  const deadline = Date.now() + 45_000;
  const { url, serviceKey } = requireSupabaseServiceEnv();
  const admin = createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(init?.signal ? [init.signal] : [])]) }) },
  });
  const databazaEnabled = Boolean(process.env.DATABAZA_VOZIDIEL_API_KEY?.trim());
  const czechProviders = query.country === "CZ" ? {
    autokuk: process.env.VERCEL_ENV !== "preview" && Boolean(process.env.CZ_AUTOKUK_API_KEY?.trim()),
    rsv: process.env.VERCEL_ENV !== "preview" && Boolean(process.env.CZ_RSV_API_KEY?.trim()),
    mycarplate: myCarPlateAllowed(url),
    ...(process.env.VERCEL_ENV === "preview" ? { vpic: false } : {}),
  } : undefined;
  const queryHash = createHash("sha256").update(JSON.stringify(query.country === "CZ"
    ? [query.kind, query.value, query.country, query.checkedForDate, 5, czechProviders]
    : [query.kind, query.value, query.country, query.checkedForDate, 4, databazaEnabled])).digest("hex");
  const { data, error } = await admin.rpc("motorist_vehicle_lookup_claim", { p_organization_id: actor.organizationId, p_profile_id: actor.profileId, p_query_hash: queryHash });
  if (error || !data) throw new VehicleLookupError("Dohľadávanie je dočasne nedostupné. Údaje môžete vyplniť ručne.");
  const claim = data as unknown as Claim;
  if (claim.status === "cached") return { snapshot: sealVehicleLookup(claim.result, actor.organizationId), cached: true };
  if (claim.status === "pending") throw new VehicleLookupError("Práve prebieha iné dohľadávanie. Skúste o chvíľu znova.", 409, 5);
  if (claim.status === "rate_limited") throw new VehicleLookupError("Dosiahli ste limit dohľadávania. Skúste o minútu znova.", 429, 60);
  if (claim.status !== "reserved") throw new VehicleLookupError("Automatické dohľadávanie je momentálne vypnuté.");
  let result: VehicleLookupResult | undefined;
  try {
    result = await executeVehicleLookup(query, { ...claim.providers, ...(czechProviders ?? { databazavozidiel: databazaEnabled }) }, deadline);
    return { snapshot: sealVehicleLookup(result, actor.organizationId), cached: false };
  } finally {
    const skp = result?.sources.find((source) => source.source === "skp");
    const primarySource = query.country === "CZ"
      ? czechProviders?.autokuk ? "autokuk" : czechProviders?.mycarplate && query.kind === "plate" ? "mycarplate" : czechProviders?.rsv ? "rsv" : undefined
      : databazaEnabled ? "databazavozidiel" : "stkonline";
    const success = Boolean(result && primarySource && result.sources.find((source) => source.source === primarySource)?.status === "found"
      && (query.country === "CZ" || skp?.status === "found")
      && !lookupIdentityConflict(result, {})
      && result.sources.every((source) => query.country === "CZ" && source.source === "vpic" || !["unavailable", "challenge_required", "rate_limited"].includes(source.status)));
    const finish = await admin.rpc("motorist_vehicle_lookup_finish", {
      p_organization_id: actor.organizationId, p_token: claim.token, p_query_hash: queryHash,
      p_result: (result ?? null) as unknown as Json, p_success: success,
      p_skp_failed: query.country === "CZ" || !skp || skp.status === "unsupported" ? null : ["unavailable", "challenge_required", "rate_limited"].includes(skp.status),
    });
    if (finish.error) console.error("vehicle_lookup_finish_failed");
  }
}

/** Guest access is limited to local development or the dedicated stable TEST
 * deployment. A production rollout requires a redistribution licence and key. */
function myCarPlateAllowed(supabaseUrl: string): boolean {
  if (process.env.VERCEL_ENV === "preview") return false;
  if (process.env.CZ_MYCARPLATE_LICENSED === "true" && Boolean(process.env.CZ_MYCARPLATE_API_KEY?.trim())) return true;
  const testDatabase = supabaseUrl === "https://nzpnqdstvkfncflgqlny.supabase.co";
  if (process.env.NODE_ENV === "development" && !process.env.VERCEL_ENV) {
    const host = new URL(supabaseUrl).hostname;
    if (testDatabase || host === "localhost" || host === "127.0.0.1") return true;
  }
  return testDatabase && isTestLiveDeployment();
}
