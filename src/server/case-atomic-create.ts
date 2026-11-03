import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateCaseInput } from "@/data/case-inputs";
import type { Database } from "@/lib/supabase/database.types";
import { caseMutationIdentity, type CaseMutationIdentity, type CaseRelatedWrite } from "./case-atomic-save";
import { MutationError } from "./mutation-error";

export function caseCreationIdentity(input: CreateCaseInput): CaseMutationIdentity | undefined {
  const { creationCommandId, ...payload } = input;
  // Presence identifies the editor, not the creation intent or its contents.
  delete (payload as Record<string, unknown>).editorSessionId;
  if (!creationCommandId && input.partnerOrigin) throw new MutationError("Partnerský prípad vyžaduje identitu uloženia.", 400);
  return caseMutationIdentity({ ...payload, mutationId: creationCommandId });
}

export async function commitAtomicCaseCreation(client: SupabaseClient<Database>, input: {
  organizationId: string; actorId: string; identity: CaseMutationIdentity;
  casePatch: Record<string, unknown>; related: CaseRelatedWrite[];
  eventBody: string; eventPayload: Record<string, unknown>; partnerOrigin?: CreateCaseInput["partnerOrigin"];
}) {
  // This RPC owns case, related rows, partner origin, history, audit and receipt.
  const { data, error } = await (client as SupabaseClient).rpc("motorist_create_case_atomic", {
    p_organization_id: input.organizationId, p_actor_id: input.actorId,
    p_command_id: input.identity.mutationId, p_fingerprint: input.identity.fingerprint,
    p_case_patch: input.casePatch, p_related: input.related,
    p_event_body: input.eventBody, p_event_payload: input.eventPayload,
    p_partner_origin: input.partnerOrigin ?? null,
  });
  if (error?.code === "PT422") throw new MutationError("Pôvodné uloženie má iný obsah. Najprv overte jeho výsledok.", 422, "CASE_CREATION_MISMATCH");
  if (error?.code === "42501") throw new MutationError("Nemáte oprávnenie vytvoriť tento prípad alebo jeho partnerský pôvod.", 403);
  if (error && ["22023", "22P02", "23514", "23502", "P0001"].includes(error.code)) throw new MutationError("Skontrolujte údaje nového prípadu a partnerského pôvodu.", 400);
  if (error) throw new MutationError("Výsledok vytvorenia nie je potvrdený. Zopakujte pôvodné uloženie.", 503, "CASE_CREATION_UNCONFIRMED");
  return data as Database["public"]["Tables"]["motorist_cases"]["Row"];
}
