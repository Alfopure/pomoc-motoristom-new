import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { MobileCaseOwnerAssigned, MobileCaseOwnerContext, MobileCaseOwnerInput } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/telephony/uuid";
import { isHistoryTimestamp } from "@/lib/telephony/call-history-query";
import { compareCaseRevisions } from "@/data/case-detail";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { readMobileJsonBody } from "./body";
import { pushCaseAssigned } from "./push-events";

type Client = SupabaseClient<Database>;
type Context = Omit<MobileCaseOwnerContext, "ok" | "apiVersion" | "environment" | "profileId" | "checkedAt">;
type Receipt = Pick<MobileCaseOwnerAssigned, "caseId" | "mutationId" | "committedRevision" | "ownerId" | "refreshRequired">;
const ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
const CLOSED = new Set(["completed_assisted", "completed_no_assistance", "rejected", "cancelled", "futile_trip"]);
const LIMIT = 200;
const unconfirmed = () => new MutationError("Výsledok priradenia nie je potvrdený. Overte tú istú požiadavku znova.", 503, "CASE_SAVE_UNCONFIRMED");

export function parseMobileCaseOwner(value: unknown): MobileCaseOwnerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationError("Neplatné priradenie.", 400);
  const input = value as Record<string, unknown>;
  if (input.expectedUpdatedAt === undefined) throw new MutationError("Najprv načítajte aktuálnu revíziu prípadu.", 428, "CASE_REVISION_REQUIRED");
  if (Object.keys(input).some(key => !["mutationId", "expectedUpdatedAt", "ownerId"].includes(key))
    || !isHistoryTimestamp(input.expectedUpdatedAt) || typeof input.ownerId !== "string" || !isUuid(input.ownerId)
    || typeof input.mutationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.mutationId)) {
    throw new MutationError("Neplatná revízia alebo dispečer priradenia.", 400);
  }
  return { mutationId: input.mutationId.toLowerCase(), expectedUpdatedAt: input.expectedUpdatedAt, ownerId: input.ownerId.toLowerCase() };
}
export async function readMobileCaseOwner(request: Request) { return parseMobileCaseOwner(await readMobileJsonBody(request)); }

function missingRpc(error: { code: string; message: string }, name: string) {
  return ["PGRST202", "42883"].includes(error.code) && new RegExp(`(?:^|[^a-zA-Z0-9_])${name}(?:[^a-zA-Z0-9_]|$)`).test(error.message);
}

export async function getMobileCaseOwner(actor: MotoristActor, caseId: string, signal?: AbortSignal, client: Client = createSupabaseAdminClient()): Promise<Context> {
  if (!isUuid(caseId)) throw new MutationError("Neplatný prípad.", 400);
  caseId = caseId.toLowerCase();
  const abort = AbortSignal.any([AbortSignal.timeout(8_000), ...(signal ? [signal] : [])]);
  const readCase = () => client.from("motorist_cases").select("id,owner_id,status,updated_at")
    .eq("organization_id", actor.organizationId).eq("id", caseId).abortSignal(abort).maybeSingle();
  const { data: row, error } = await readCase();
  if (error) throw new MutationError("Priradenie sa nepodarilo načítať.", 503);
  if (!row) throw new MutationError("Prípad sa nenašiel.", 404);
  if (!isHistoryTimestamp(row.updated_at) || row.owner_id !== null && !isUuid(row.owner_id)) throw new MutationError("Priradenie sa nepodarilo overiť.", 503);
  const { data: owner, error: ownerError } = row.owner_id
    ? await client.from("motorist_profiles").select("id,display_name").eq("organization_id", actor.organizationId).eq("id", row.owner_id).abortSignal(abort).maybeSingle()
    : { data: null, error: null };
  if (ownerError) throw new MutationError("Dispečera sa nepodarilo načítať.", 503);
  const { data: version, error: versionError } = await client.rpc("motorist_case_owner_version").abortSignal(abort);
  if (versionError && !missingRpc(versionError, "motorist_case_owner_version")) throw new MutationError("Dostupnosť priradenia sa nepodarilo overiť.", 503);
  const available = !versionError && version === 1;
  const targets: Context["targets"] = [];
  let actorEligible = false;
  if (available) {
    const { data, error: targetError } = await client.from("motorist_profiles").select("id,display_name,user_id")
      .eq("organization_id", actor.organizationId).eq("active", true).eq("access_status", "active").eq("kind", "human").not("user_id", "is", null)
      .in("role", ROLES).order("display_name").order("id").limit(LIMIT + 1).abortSignal(abort);
    if (targetError) throw new MutationError("Dispečerov sa nepodarilo načítať.", 503);
    if ((data?.length ?? 0) > LIMIT) throw new MutationError("Zoznam dispečerov je príliš veľký.", 503, "case_dispatchers_limit");
    for (const target of data ?? []) {
      if (!isUuid(target.id) || typeof target.display_name !== "string" || !target.display_name || target.display_name.length > 200) throw new MutationError("Zoznam dispečerov sa nepodarilo overiť.", 503);
      targets.push({ id: target.id, name: target.display_name });
      if (target.id === actor.profileId && target.user_id === actor.userId) actorEligible = true;
    }
  }
  // Do not combine a newer owner/revision with an older context snapshot.
  const verified = await readCase();
  if (verified.error || !verified.data || verified.data.updated_at !== row.updated_at) throw new MutationError("Prípad sa počas načítania zmenil. Obnovte priradenie.", 503);
  const assign = available && actorEligible && (row.owner_id !== null || !CLOSED.has(row.status));
  return { caseId, caseRevision: row.updated_at, owner: { id: row.owner_id, name: owner?.display_name ?? null, mine: row.owner_id === actor.profileId },
    available, capabilities: { take: assign && row.owner_id === null, assign }, targets };
}

export async function assignMobileCaseOwner(actor: MotoristActor, caseId: string, value: MobileCaseOwnerInput, client: Client = createSupabaseAdminClient()): Promise<Receipt> {
  if (!isUuid(caseId)) throw new MutationError("Neplatný prípad.", 400);
  caseId = caseId.toLowerCase();
  const input = parseMobileCaseOwner(value);
  // Domain separation preserves V1 editor receipt semantics even with UUID reuse.
  const fingerprint = createHash("sha256").update(JSON.stringify(["case.owner.v1", input.expectedUpdatedAt, input.ownerId])).digest("hex");
  const { data, error } = await client.rpc("motorist_assign_case_owner", {
    p_organization_id: actor.organizationId, p_actor_id: actor.profileId, p_actor_user_id: actor.userId, p_case_id: caseId,
    p_owner_id: input.ownerId, p_expected_updated_at: input.expectedUpdatedAt, p_mutation_id: input.mutationId, p_fingerprint: fingerprint,
  }).abortSignal(AbortSignal.timeout(12_000));
  if (error) {
    if (missingRpc(error, "motorist_assign_case_owner")) {
      throw new MutationError("Priradenie dispečera zatiaľ nie je dostupné.", 503, "assignment_unavailable");
    }
    if (error.code === "PT409") throw new MutationError("Prípad sa zmenil. Načítajte aktuálne priradenie a porovnajte zmenu.", 409, "CASE_REVISION_CONFLICT");
    if (error.code === "PT422") throw new MutationError("Identita priradenia už patrí inej požiadavke.", 422, "CASE_MUTATION_MISMATCH");
    if (error.code === "42501") throw new MutationError("Nemáte oprávnenie zmeniť dispečera.", 403);
    if (error.code === "P0002") throw new MutationError("Prípad sa nenašiel.", 404);
    if (error.code === "22023") throw new MutationError("Vybraný dispečer alebo stav prípadu už neumožňuje priradenie. Obnovte údaje.", 400);
    throw unconfirmed();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)
    || data.organizationId !== actor.organizationId || data.actorId !== actor.profileId || data.caseId !== caseId
    || data.mutationId !== input.mutationId || data.ownerId !== input.ownerId || !isHistoryTimestamp(data.committedRevision)
    || compareCaseRevisions(data.committedRevision, input.expectedUpdatedAt) < 0) throw unconfirmed();
  pushCaseAssigned(client, { organizationId: actor.organizationId, caseId, ownerId: input.ownerId, actorProfileId: actor.profileId, committedRevision: data.committedRevision });
  return { caseId, mutationId: input.mutationId, ownerId: input.ownerId, committedRevision: data.committedRevision, refreshRequired: true };
}
