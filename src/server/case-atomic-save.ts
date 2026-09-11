import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { MutationError } from "./mutation-error";

export type CaseMutationIdentity = { mutationId: string; fingerprint: string };
export function caseMutationIdentity(input: Record<string, unknown>): CaseMutationIdentity | undefined {
  if (input.mutationId === undefined) return undefined;
  if (typeof input.mutationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.mutationId)) {
    throw new MutationError("Neplatná identita uloženia.", 400);
  }
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)])) : value;
  const { mutationId, ...payload } = input;
  return { mutationId, fingerprint: createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex") };
}
function mutationFailure(error: { code?: string }): never {
  if (error.code === "PT422") throw new MutationError("Identita uloženia už patrí iným zmenám. Rozpracované údaje zostávajú v editore.", 422, "CASE_MUTATION_MISMATCH");
  if (error.code === "PT409" || error.code === "40001") throw new MutationError("Prípad medzitým zmenil iný používateľ. Načítajte aktuálny stav; vaše zmeny zostávajú v editore.", 409, "CASE_REVISION_CONFLICT");
  if (error.code === "42501") throw new MutationError("Nemáte oprávnenie upraviť tento prípad.", 403);
  if (error.code === "P0002") throw new MutationError("Prípad alebo súvisiace údaje sa nenašli.", 404);
  throw new MutationError("Výsledok uloženia sa nepodarilo overiť. Rozpracované údaje zostávajú v editore.", 500, "CASE_SAVE_UNCONFIRMED");
}
export async function readCaseMutationResult(client: SupabaseClient<Database>, organizationId: string, actorId: string, caseId: string, identity: CaseMutationIdentity) {
  const { data, error } = await client.rpc("motorist_case_mutation_result", {
    p_organization_id: organizationId, p_actor_id: actorId, p_case_id: caseId,
    p_mutation_id: identity.mutationId, p_fingerprint: identity.fingerprint,
  });
  if (error) mutationFailure(error);
  return data as unknown as Database["public"]["Tables"]["motorist_cases"]["Row"] | null;
}

type RelatedTable = "motorist_contacts" | "motorist_vehicles" | "motorist_locations";
export type CaseRelatedWrite = { table: RelatedTable; id: string; insert: boolean; patch: Record<string, unknown>; expectedUpdatedAt?: string };
export class CaseWritePlan {
  readonly writes: CaseRelatedWrite[] = [];
  write(table: RelatedTable, id: string | null, patch: Record<string, unknown>, expectedUpdatedAt?: string) {
    const nextId = id ?? randomUUID();
    this.writes.push({ table, id: nextId, insert: !id, patch, expectedUpdatedAt });
    return nextId;
  }
}
export async function commitAtomicCaseSave(client: SupabaseClient<Database>, input: {
  organizationId: string; actorId: string; caseId: string; expectedUpdatedAt: string;
  identity?: CaseMutationIdentity;
  casePatch: Record<string, unknown>; related: CaseRelatedWrite[]; fieldLabels: Record<string, unknown>;
}) {
  // All preprocessing is read-only; this is the sole write boundary for case editing.
  const result = await client.rpc("motorist_save_case_atomic", {
    p_organization_id: input.organizationId, p_actor_id: input.actorId, p_case_id: input.caseId,
    p_expected_updated_at: input.expectedUpdatedAt, p_case_patch: input.casePatch as Json,
    p_related: input.related as unknown as Json, p_field_labels: input.fieldLabels as Json,
    ...(input.identity ? { p_mutation_id: input.identity.mutationId, p_fingerprint: input.identity.fingerprint } : {}),
  });
  if (result.error) mutationFailure(result.error);
  return result.data as unknown as Database["public"]["Tables"]["motorist_cases"]["Row"];
}
