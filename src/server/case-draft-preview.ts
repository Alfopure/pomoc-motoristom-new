import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { MAX_DRAFT_PREVIEW_BYTES, parseCaseDraftPreview, type CaseDraftPreviewSnapshot } from "@/domain/case-draft-preview";
import type { MotoristActor } from "./api-auth";
import { editorSessionId } from "./case-collaboration";
import { MutationError } from "./mutation-error";

type RpcClient = { rpc: (name: string, input: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }> };
const unavailable: CaseDraftPreviewSnapshot = { available: false, preview: null, sequence: 0, updatedAt: null, expiresAt: "", displayName: "" };

/** Bound the envelope before parsing; the shared parser also bounds UTF-8 content. */
export async function caseDraftPreviewBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_DRAFT_PREVIEW_BYTES + 1024) {
          await reader.cancel();
          throw new MutationError("Náhľad prípadu je príliš veľký.", 413);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
  }
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new MutationError("Neplatná požiadavka.", 400); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MutationError("Neplatná požiadavka.", 400);
  return input as Record<string, unknown>;
}

function parseSnapshot(value: unknown): CaseDraftPreviewSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid draft snapshot");
  const input = value as Record<string, unknown>;
  if (input.available !== true || !Number.isSafeInteger(input.sequence) || Number(input.sequence) < 0
    || typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt))
    || typeof input.displayName !== "string"
    || (input.updatedAt !== null && (typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))))) throw new Error("Invalid draft snapshot");
  const preview = input.preview === null ? null : parseCaseDraftPreview(input.preview);
  if ((preview === null) !== (input.sequence === 0) || (preview === null) !== (input.updatedAt === null)) throw new Error("Invalid draft snapshot");
  return { available: true, preview, sequence: Number(input.sequence), updatedAt: input.updatedAt as string | null, expiresAt: input.expiresAt, displayName: input.displayName };
}

async function draftPreviewRpc(actor: MotoristActor, sessionId: string, action: "read" | "publish", input: Record<string, unknown>, signal?: AbortSignal, client: RpcClient = createSupabaseAdminClient() as unknown as RpcClient) {
  signal?.throwIfAborted();
  const { data, error } = await client.rpc("motorist_case_draft_preview", {
    p_organization_id: actor.organizationId, p_actor_profile_id: actor.profileId,
    p_session_id: sessionId, p_action: action, p_input: input,
  });
  signal?.throwIfAborted();
  if (error) {
    if (["PGRST202", "42883", "42P01"].includes(error.code ?? "")) return { ...unavailable };
    if (error.code === "42501") throw new MutationError("Prístup k náhľadu prípadu nie je povolený.", 403);
    if (error.code === "P0002") throw new MutationError("Tento návrh už nie je otvorený.", 404);
    throw new MutationError("Náhľad prípadu sa nepodarilo načítať.", error.code === "22023" ? 400 : 503);
  }
  try { return parseSnapshot(data); }
  catch { throw new MutationError("Neplatná odpoveď náhľadu prípadu.", 503); }
}

export async function loadCaseDraftPreview(actor: MotoristActor, sessionId: unknown, signal?: AbortSignal, client?: RpcClient) {
  return draftPreviewRpc(actor, editorSessionId(sessionId), "read", {}, signal, client);
}

export async function publishCaseDraftPreview(actor: MotoristActor, sessionId: unknown, input: Record<string, unknown>, signal?: AbortSignal, client?: RpcClient) {
  const id = editorSessionId(sessionId);
  if (Object.keys(input).some(key => key !== "sequence" && key !== "preview")
    || !Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1) throw new MutationError("Neplatná aktualizácia návrhu.", 400);
  let preview;
  try { preview = parseCaseDraftPreview(input.preview); }
  catch { throw new MutationError("Náhľad obsahuje nepovolené alebo príliš dlhé údaje.", 400); }
  return draftPreviewRpc(actor, id, "publish", { sequence: input.sequence, preview }, signal, client);
}
