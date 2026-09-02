import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { MutationError } from "@/server/motorist-mutations";

type AdminClient = SupabaseClient<Database>;

const PROVIDER = "viptel";
const SCHEMA_MARKER_COLUMN = "workplace_seat_generation";

/**
 * Returns the seats that were explicitly bootstrapped into the additive
 * hot-desk schema. A historical `assignmentMode=workplace_claim` is not a
 * schema marker: seat 20 used that lifecycle before the lease tables existed.
 *
 * Deploying application code before the migration is supported. Only the
 * precise PostgREST/Postgres "column missing" response is treated as an old
 * schema; every other read failure remains fail-closed.
 */
export async function findBootstrappedWorkplaceExtensionIds(
  client: AdminClient,
  organizationId: string,
  filters: { extensionIds?: readonly string[]; extensions?: readonly string[] },
) {
  return new Set((await loadBootstrappedWorkplaceExtensions(client, organizationId, filters)).keys());
}

export async function loadBootstrappedWorkplaceExtensions(
  client: AdminClient,
  organizationId: string,
  filters: { extensionIds?: readonly string[]; extensions?: readonly string[] },
) {
  const extensionIds = [...new Set(filters.extensionIds ?? [])];
  const extensions = [...new Set(filters.extensions ?? [])];
  if (extensionIds.length === 0 && extensions.length === 0) return new Map<string, string>();

  let query = client
    .from("motorist_telephony_extensions")
    .select("id, workplace_seat_generation")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("active", true);
  if (extensionIds.length > 0) query = query.in("id", extensionIds);
  if (extensions.length > 0) query = query.in("extension", extensions);
  const result = await query;
  if (result.error) {
    if (isMissingWorkplaceSchemaMarkerError(result.error)) return new Map<string, string>();
    throw new MutationError("Stav schémy dynamických pracovísk sa nepodarilo bezpečne overiť.", 500);
  }
  return new Map((result.data ?? []).flatMap((row) =>
    typeof row.workplace_seat_generation === "string" && row.workplace_seat_generation.length > 0
      ? [[row.id, row.workplace_seat_generation] as const]
      : []));
}

export function isMissingWorkplaceSchemaMarkerError(error: unknown) {
  const record = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const code = typeof record.code === "string" ? record.code : "";
  const message = [record.message, record.details, record.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return (code === "PGRST204" || code === "42703") &&
    message.includes(SCHEMA_MARKER_COLUMN) &&
    (message.includes("does not exist") || message.includes("could not find") || message.includes("schema cache"));
}
