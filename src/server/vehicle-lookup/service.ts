import "server-only";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseServiceEnv } from "@/lib/supabase/env";
import type { MotoristActor } from "@/server/api-auth";
import type { VehicleLookupResponse, VehicleLookupResult, VehicleQuery } from "@/lib/vehicle-lookup";
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
  const queryHash = createHash("sha256").update(JSON.stringify([query.kind, query.value, query.country, query.checkedForDate, 1])).digest("hex");
  const { data, error } = await admin.rpc("motorist_vehicle_lookup_claim", { p_organization_id: actor.organizationId, p_profile_id: actor.profileId, p_query_hash: queryHash });
  if (error || !data) throw new VehicleLookupError("Dohľadávanie je dočasne nedostupné. Údaje môžete vyplniť ručne.");
  const claim = data as unknown as Claim;
  if (claim.status === "cached") return { snapshot: sealVehicleLookup(claim.result, actor.organizationId), cached: true };
  if (claim.status === "pending") throw new VehicleLookupError("Práve prebieha iné dohľadávanie. Skúste o chvíľu znova.", 409, 5);
  if (claim.status === "rate_limited") throw new VehicleLookupError("Dosiahli ste limit dohľadávania. Skúste o minútu znova.", 429, 60);
  if (claim.status !== "reserved") throw new VehicleLookupError("Automatické dohľadávanie je momentálne vypnuté.");
  let result: VehicleLookupResult | undefined;
  try {
    result = await executeVehicleLookup(query, claim.providers, deadline);
    return { snapshot: sealVehicleLookup(result, actor.organizationId), cached: false };
  } finally {
    const skp = result?.sources.find((source) => source.source === "skp");
    const success = Boolean(result && result.sources.filter((source) => source.source === "skp" || source.source === "stkonline").every((source) => source.status === "found") && result.sources.every((source) => !["unavailable", "challenge_required", "rate_limited"].includes(source.status)));
    const finish = await admin.rpc("motorist_vehicle_lookup_finish", {
      p_organization_id: actor.organizationId, p_token: claim.token, p_query_hash: queryHash,
      p_result: (result ?? null) as unknown as Json, p_success: success,
      p_skp_failed: !skp || skp.status === "unsupported" ? null : ["unavailable", "challenge_required", "rate_limited"].includes(skp.status),
    });
    if (finish.error) console.error("vehicle_lookup_finish_failed");
  }
}
