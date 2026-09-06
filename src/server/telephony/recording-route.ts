import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { assertSameOriginRequest, requireDefaultMotoristActor, type MotoristActor } from "@/server/api-auth";
import { configErrorResponse } from "./config-route";
import { ConfigServiceError } from "./config-service";
import { CallActionError } from "./call-actions";
import { MutationError } from "@/server/motorist-mutations";
import { recordingError } from "./recording-service";
import type { Database } from "@/lib/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

export const RECORDING_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
export async function readRecordingBody(request: Request, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) recordingError("Očakáva sa JSON.", 415);
  if (Number(request.headers.get("content-length")) > maxBytes) recordingError("Požiadavka je príliš veľká.", 413);
  const reader = request.body?.getReader();
  if (!reader) recordingError("Chýbajú údaje.");
  let count = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      count += value.byteLength; if (count > maxBytes) { await reader.cancel(); recordingError("Požiadavka je príliš veľká.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* generic validation below */ }
  return recordingError("Neplatné údaje.");
}
export async function recordingRoute(request: Request, run: (input: {
  admin: SupabaseClient<Database>; actor: MotoristActor; body: Record<string, unknown>;
}) => Promise<unknown>): Promise<Response> {
  try {
    const mutation = !["GET", "HEAD"].includes(request.method);
    if (mutation) assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor([...RECORDING_ROLES]);
    const body = mutation ? await readRecordingBody(request) : {};
    const result = await run({ admin: createSupabaseAdminClient(), actor, body });
    if (result instanceof Response) return result;
    return Response.json(result, { headers: { "Cache-Control": "private, no-store", "Vary": "Cookie" } });
  } catch (error) {
    const response = error instanceof ConfigServiceError || error instanceof CallActionError || error instanceof MutationError
      ? configErrorResponse(error, "Záznam sa nepodarilo spracovať.")
      : Response.json({ error: "Záznam sa nepodarilo spracovať." }, { status: 503 });
    response.headers.set("Cache-Control", "private, no-store"); return response;
  }
}
