import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadDispatchNotifications, mapCase } from "@/data/dispatch-repository";
import type { Database } from "@/lib/supabase/database.types";
import type { MotoristActor } from "./api-auth";
import { MutationError } from "./mutation-error";
import type { CaseEditorPresence, CaseLiveSnapshot } from "@/domain/case-collaboration";

export const COLLABORATION_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RpcClient = { rpc: (name: string, input: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> };
type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
export type CaseSnapshotDetails = {
  cases: Row<"motorist_cases">[]; events: Row<"motorist_case_events">[]; submissions: Row<"motorist_location_submissions">[];
  contacts: Row<"motorist_contacts">[]; vehicles: Row<"motorist_vehicles">[]; locations: Row<"motorist_locations">[]; profiles: Row<"motorist_profiles">[];
};
type Manifest = { versions: Record<string, number>; editors: CaseEditorPresence[]; details: CaseSnapshotDetails; more: boolean };
export const collaborationHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export function collaborationError(error: unknown) {
  return Response.json({ error: error instanceof MutationError ? error.message : "Živé aktualizácie sú dočasne nedostupné." },
    { status: error instanceof MutationError ? error.status : 503, headers: collaborationHeaders });
}
export async function collaborationBody(request: Request) {
  const text = await request.text();
  if (text.length > 750_000) throw new MutationError("Požiadavka je príliš veľká.", 413);
  let value: unknown; try { value = JSON.parse(text); } catch { throw new MutationError("Neplatná požiadavka.", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationError("Neplatná požiadavka.", 400);
  return value as Record<string, unknown>;
}
export function editorSessionId(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value)) throw new MutationError("Neplatná relácia editora.", 400);
  return value;
}
async function collaborationRpc(actor: MotoristActor, action: string, input: Record<string, unknown> = {}, client: RpcClient = createSupabaseAdminClient() as unknown as RpcClient) {
  const { data, error } = await client.rpc("motorist_case_collaboration", {
    p_organization_id: actor.organizationId, p_actor_profile_id: actor.profileId, p_action: action, p_input: input,
  });
  if (error) {
    if (["PGRST202", "42883", "42P01"].includes(error.code ?? "")) return null;
    throw new MutationError("Spoluprácu na prípadoch sa nepodarilo overiť.", error.code === "42501" ? 403 : error.code === "22023" ? 400 : 503);
  }
  return data;
}
export async function loadCaseLiveSnapshot(actor: MotoristActor, input: Record<string, unknown>, signal?: AbortSignal): Promise<CaseLiveSnapshot> {
  const supplied = input.versions;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied) || Object.entries(supplied).some(([id, value]) => !uuid.test(id) || !Number.isSafeInteger(value) || Number(value) < 1)) throw new MutationError("Neplatné verzie prípadov.", 400);
  signal?.throwIfAborted();
  const manifest = await collaborationRpc(actor, "snapshot", { versions: supplied }) as Manifest | null;
  if (!manifest) return { available: false, ids: [], changes: [], versions: {}, editors: [], notifications: [], more: false };
  const known = supplied as Record<string, number>;
  const resourceKeys: (keyof CaseSnapshotDetails)[] = ["cases", "events", "submissions", "contacts", "vehicles", "locations", "profiles"];
  if (!manifest.details || !resourceKeys.every(key => Array.isArray(manifest.details[key])) || manifest.details.cases.length > 40 || manifest.details.events.length > 8_000) throw new MutationError("Neplatná verzia živých aktualizácií.", 503);
  const details = manifest.details;
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map(row => [row.id, row]));
  const contactsById = byId(details.contacts), vehiclesById = byId(details.vehicles), locationById = byId(details.locations), profilesById = byId(details.profiles);
  const eventsByCase = new Map<string, typeof details.events>();
  for (const event of details.events) {
    const events = eventsByCase.get(event.case_id) ?? []; events.push(event); eventsByCase.set(event.case_id, events);
  }
  const submissionsByCase = new Map(details.submissions.map(item => [item.case_id, item]));
  const changes = details.cases.map(caseRow => {
    const detail = mapCase({ caseRow, contactsById, vehiclesById, locationById, profilesById,
      customerLocationSubmission: submissionsByCase.get(caseRow.id), events: eventsByCase.get(caseRow.id) ?? [], tasks: [] });
    Reflect.deleteProperty(detail, "tasks");
    return detail;
  });
  // Acknowledge only unchanged or actually delivered cards. Undelivered rows
  // remain unknown and are requested by the next bounded continuation.
  const versions = Object.fromEntries(Object.entries(manifest.versions).filter(([id, revision]) => known[id] === revision));
  for (const row of details.cases) versions[row.id] = manifest.versions[row.id];
  const notifications = await loadDispatchNotifications(actor.organizationId, actor.profileId);
  if (await collaborationRpc(actor, "authorize") === null) throw new MutationError("Oprávnenie k aktualizáciám sa nepodarilo overiť.", 503);
  signal?.throwIfAborted();
  return { available: true, ids: Object.keys(manifest.versions), changes, versions, editors: manifest.editors, notifications, more: manifest.more };
}
export async function updateCaseEditorPresence(actor: MotoristActor, input: Record<string, unknown>, client?: RpcClient) {
  if (Object.keys(input).some(key => !["action", "sessionId", "caseId"].includes(key))) throw new MutationError("Relácia editora obsahuje nepovolené údaje.", 400);
  if (input.action !== "heartbeat" && input.action !== "leave") throw new MutationError("Neplatná aktivita editora.", 400);
  const sessionId = editorSessionId(input.sessionId);
  const caseId = input.caseId === null || input.caseId === undefined ? null : editorSessionId(input.caseId);
  const result = await collaborationRpc(actor, input.action, { sessionId, caseId }, client);
  return { available: result !== null, ...(result as Record<string, unknown> | null ?? {}) };
}
/** Called only with the case id returned by the authorized create operation. */
export async function finishCaseEditorDraft(actor: MotoristActor, sessionId: string, caseId: string) {
  await collaborationRpc(actor, "commit", { sessionId: editorSessionId(sessionId), caseId: editorSessionId(caseId) });
}
