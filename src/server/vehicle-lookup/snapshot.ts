import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { lookupIdentityConflict, normalizeVehicleIdentifier, readVehicleLookupSnapshot, type VehicleIdentity, type VehicleLookupResult, type VehicleLookupSnapshot } from "@/lib/vehicle-lookup";
import { requireSupabaseServiceEnv } from "@/lib/supabase/env";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sign(result: VehicleLookupResult, organizationId: string, key: string) { return createHmac("sha256", key).update(canonical(["vehicle-lookup-v1", organizationId, result])).digest("base64url"); }
function signingKey() { return process.env.VEHICLE_LOOKUP_SIGNING_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || requireSupabaseServiceEnv().serviceKey; }
export function sealVehicleLookup(result: VehicleLookupResult, organizationId: string, key = signingKey()): VehicleLookupSnapshot {
  return { result, proof: sign(result, organizationId, key) };
}
export function verifyVehicleLookup(value: unknown, organizationId: string, identity: VehicleIdentity, key = signingKey()): VehicleLookupSnapshot | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || JSON.stringify(value).length > 50_000) throw new Error("Neplatný výsledok dohľadania vozidla.");
  const snapshot = value as VehicleLookupSnapshot;
  if (!snapshot.result || snapshot.result.version !== 1 || !Array.isArray(snapshot.result.sources) || typeof snapshot.proof !== "string" || !/^[\w-]{43}$/.test(snapshot.proof)) throw new Error("Neplatný výsledok dohľadania vozidla.");
  const expected = Buffer.from(sign(snapshot.result, organizationId, key));
  const actual = Buffer.from(snapshot.proof);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Výsledok dohľadania sa nepodarilo overiť. Dohľadajte vozidlo znova.");
  const conflict = lookupIdentityConflict(snapshot.result, identity);
  if (conflict) throw new Error(conflict);
  return snapshot;
}

export function lookupSnapshotForSave(input: { vehicleLookup?: VehicleLookupSnapshot | null; licensePlate?: string; vin?: string }, organizationId: string, existing?: { identity: VehicleIdentity; snapshot?: unknown }): VehicleLookupSnapshot | null | undefined {
  const identity = { plate: input.licensePlate ?? existing?.identity.plate, vin: input.vin ?? existing?.identity.vin };
  if (input.vehicleLookup === undefined) {
    const changed = existing && (["plate", "vin"] as const).some((field) => normalizeVehicleIdentifier(identity[field] ?? "") !== normalizeVehicleIdentifier(existing.identity[field] ?? ""));
    return changed && existing.snapshot ? null : undefined;
  }
  return verifyVehicleLookup(input.vehicleLookup, organizationId, identity);
}

export function readVerifiedVehicleLookup(value: unknown, organizationId: string, identity: VehicleIdentity): VehicleLookupSnapshot | undefined {
  if (!readVehicleLookupSnapshot(value)) return undefined;
  try { return verifyVehicleLookup(value, organizationId, identity) ?? undefined; } catch { return undefined; }
}
