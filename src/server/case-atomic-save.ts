import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { MutationError } from "./mutation-error";

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
  casePatch: Record<string, unknown>; related: CaseRelatedWrite[]; fieldLabels: Record<string, unknown>;
}) {
  // All preprocessing is read-only; this is the sole write boundary for case editing.
  const result = await client.rpc("motorist_save_case_atomic", {
    p_organization_id: input.organizationId, p_actor_id: input.actorId, p_case_id: input.caseId,
    p_expected_updated_at: input.expectedUpdatedAt, p_case_patch: input.casePatch as Json,
    p_related: input.related as unknown as Json, p_field_labels: input.fieldLabels as Json,
  });
  if (result.error) {
    if (result.error.code === "40001") throw new MutationError("Prípad medzitým zmenil iný používateľ. Načítajte aktuálny stav; vaše zmeny zostávajú v editore.", 409, "CASE_REVISION_CONFLICT");
    if (result.error.code === "42501") throw new MutationError("Nemáte oprávnenie upraviť tento prípad.", 403);
    if (result.error.code === "P0002") throw new MutationError("Prípad alebo súvisiace údaje sa nenašli.", 404);
    throw new MutationError("Uloženie prípadu zlyhalo. Žiadna časť zmeny nebola uložená.", 500);
  }
  return result.data as unknown as Database["public"]["Tables"]["motorist_cases"]["Row"];
}
