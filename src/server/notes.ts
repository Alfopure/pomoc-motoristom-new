import "server-only";
import type { MotoristActor } from "./api-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { MutationError } from "./mutation-error";
import { NOTE_BODY_LIMIT, NOTE_RECIPIENT_LIMIT, NOTE_TITLE_LIMIT, type NoteColleague, type PersonalNote } from "@/domain/notes";

export const NOTE_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function noteId(value: string): string {
  if (!uuid.test(value)) throw new MutationError("Neplatná poznámka.", 400);
  return value;
}
export function noteResponse(value: unknown, status = 200) { return Response.json(value, { status, headers }); }
export function noteErrorResponse(error: unknown) {
  // Database errors may contain notebook content. Do not log or return them.
  return noteResponse({ error: error instanceof MutationError ? error.message : "Poznámky sa nepodarilo načítať alebo uložiť. Skúste to znova." }, error instanceof MutationError ? error.status : 503);
}
export async function readNoteBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > 310_000) throw new MutationError("Poznámka je príliš veľká.", 413);
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new MutationError("Neplatný formát poznámky.", 400); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MutationError("Neplatný formát poznámky.", 400);
  return input as Record<string, unknown>;
}
export function validateNoteInput(input: Record<string, unknown>, create = false) {
  if (typeof input.title !== "string" || input.title.length > NOTE_TITLE_LIMIT || typeof input.body !== "string" || input.body.length > NOTE_BODY_LIMIT) throw new MutationError("Skontrolujte názov a text poznámky.", 400);
  const recipients = input.recipientProfileIds ?? [];
  if (!Array.isArray(recipients) || recipients.length > NOTE_RECIPIENT_LIMIT || recipients.some(id => typeof id !== "string" || !uuid.test(id)) || new Set(recipients).size !== recipients.length) throw new MutationError("Skontrolujte príjemcov poznámky.", 400);
  const expectedRevision = create ? null : revisionInput(input.expectedRevision);
  return { p_title: input.title, p_body: input.body, p_recipients: recipients as string[], p_expected_revision: expectedRevision };
}
export function revisionInput(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_646) throw new MutationError("Chýba platná verzia poznámky.", 400);
  return value;
}
async function notebookRpc<T>(actor: MotoristActor, action: string, args: Record<string, unknown> = {}): Promise<T> {
  // Intentionally use the authenticated session, never a service-role client.
  // The function independently checks auth.uid(), active actor/org and owner/share
  // inside the same transaction as every read or revision-checked mutation.
  const client = await createSupabaseServerClient();
  const { data, error } = await client.rpc("motorist_notebook", { p_organization_id: actor.organizationId, p_actor_profile_id: actor.profileId, p_action: action, ...args });
  if (error) {
    const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 : error.code === "PT409" || error.code === "40001" ? 409 : error.code === "22023" ? 400 : 503;
    const message = status === 409 ? "Poznámka sa zmenila v inom okne. Načítajte aktuálnu verziu pred ďalšou úpravou." : status === 403 || status === 404 ? "Poznámka nie je dostupná alebo už nemáte oprávnenie." : "Poznámku sa nepodarilo spracovať. Skúste to znova.";
    throw new MutationError(message, status);
  }
  return data as T;
}
export function loadNotes(actor: MotoristActor) { return notebookRpc<PersonalNote[]>(actor, "list"); }
export function loadNoteColleagues(actor: MotoristActor) { return notebookRpc<NoteColleague[]>(actor, "colleagues"); }
export function loadNote(actor: MotoristActor, id: string) { return notebookRpc<PersonalNote>(actor, "get", { p_note_id: noteId(id) }); }
export function saveNote(actor: MotoristActor, input: Record<string, unknown>, id?: string) { return notebookRpc<PersonalNote>(actor, id ? "save" : "create", { ...validateNoteInput(input, !id), ...(id ? { p_note_id: noteId(id) } : {}) }); }
export function deleteNote(actor: MotoristActor, id: string, revision: unknown) { return notebookRpc<{ deleted: true }>(actor, "delete", { p_note_id: noteId(id), p_expected_revision: revisionInput(revision) }); }
