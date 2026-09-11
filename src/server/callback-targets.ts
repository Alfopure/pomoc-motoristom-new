import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { CallbackTargetResolution } from "@/lib/telephony/callback-target";
import type { MotoristActor } from "./api-auth";
import { MutationError } from "./mutation-error";

export type CallbackPolicy = { sourceContactId: string; nonCallback: boolean; targetContactId: string | null; verificationId: string | null; revision: number; verifiedAt: string | null };
type Admin = SupabaseClient<Database>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function failure(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === "42501") throw new MutationError("Na túto zmenu kontaktu nemáte oprávnenie.", 403);
  if (error.code === "P0002") throw new MutationError("Kontakt alebo požiadavka sa nenašla.", 404);
  if (error.code === "PT409" || error.code === "40001") throw new MutationError("Cieľ sa medzitým zmenil. Overte kontakt znova.", 409);
  if (error.code === "22023") throw new MutationError("Vyberte platný overený kontaktný cieľ.", 400);
  throw new MutationError("Overený cieľ sa nepodarilo načítať.", 503);
}

export async function resolveCallbackTarget(admin: Admin, organizationId: string, originalNumber: string): Promise<CallbackTargetResolution> {
  const result = await admin.rpc("motorist_resolve_callback_target", { p_organization_id: organizationId, p_number: originalNumber });
  // An unapplied migration cannot contain policies. Other failures fail closed.
  if (result.error?.code === "PGRST202") {
    const policyProbe = await admin.from("motorist_contact_callback_policies").select("source_contact_id").limit(1);
    if (policyProbe.error?.code === "PGRST205" || policyProbe.error?.code === "42P01") return { originalNumber, dialNumber: originalNumber, status: "original", sourceContactId: null, sourceName: null, targetContactId: null, targetName: null, verificationId: null };
    throw new MutationError("Overenie cieľa nie je dostupné. Skúste to znova.", 503);
  }
  failure(result.error);
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data) || !("status" in result.data)) throw new MutationError("Overený cieľ sa nepodarilo načítať.", 503);
  return result.data as unknown as CallbackTargetResolution;
}

export async function readCallbackPolicy(admin: Admin, actor: MotoristActor, contactId: string): Promise<CallbackPolicy> {
  if (!uuid.test(contactId)) throw new MutationError("Neplatný kontakt.", 400);
  const result = await admin.rpc("motorist_contact_callback_policy", { p_organization_id: actor.organizationId, p_actor_id: actor.profileId, p_contact_id: contactId, p_action: "get" });
  failure(result.error); return result.data as unknown as CallbackPolicy;
}

export async function saveCallbackPolicy(admin: Admin, actor: MotoristActor, contactId: string, input: unknown): Promise<CallbackPolicy> {
  if (actor.role !== "manager" && actor.role !== "admin") throw new MutationError("Overenie cieľa upravuje správca adresára.", 403);
  if (!input || typeof input !== "object" || Array.isArray(input) || !uuid.test(contactId)) throw new MutationError("Neplatný kontakt.", 400);
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some(key => !["nonCallback", "targetContactId", "verified", "expectedRevision"].includes(key)) || typeof data.nonCallback !== "boolean" || !Number.isInteger(data.expectedRevision) || Number(data.expectedRevision) < 0
    || data.targetContactId !== null && (typeof data.targetContactId !== "string" || !uuid.test(data.targetContactId))
    || data.targetContactId && (data.nonCallback !== true || data.verified !== true)) throw new MutationError("Alternatívny cieľ vyžaduje výslovné overenie kontaktu.", 400);
  const result = await admin.rpc("motorist_contact_callback_policy", { p_organization_id: actor.organizationId, p_actor_id: actor.profileId, p_contact_id: contactId, p_action: "save", p_non_callback: data.nonCallback, p_target_contact_id: data.targetContactId as string | null, p_expected_revision: Number(data.expectedRevision), p_verified: data.verified === true });
  failure(result.error); return result.data as unknown as CallbackPolicy;
}

export async function approveCallbackTarget(admin: Admin, organizationId: string, actorProfileId: string, requestId: string, verificationId: string) {
  if (!uuid.test(verificationId)) throw new MutationError("Cieľ spätného volania treba výslovne potvrdiť.", 400);
  const result = await admin.rpc("motorist_approve_callback_target", { p_organization_id: organizationId, p_actor_id: actorProfileId, p_request_id: requestId, p_verification_id: verificationId });
  failure(result.error); return result.data as unknown as CallbackTargetResolution;
}
