import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { getSupabasePublicEnv } from "@/lib/supabase/env";
import { recordingError, recordingPermissions, recordingUuid, requireRecordingSource } from "./recording-service";
import { sourceRestricted } from "./recording-source";
import { RECORDINGS_BUCKET } from "./recording-storage";

export const AUDIO_RANGE_MAX = 8 * 1024 * 1024;
export function recordingByteRange(header: string | null, total: number): { start: number; end: number } {
  if (!Number.isSafeInteger(total) || total <= 0) return recordingError("Veľkosť nahrávky nie je overená.", 409);
  if (!header) return { start: 0, end: Math.min(total, AUDIO_RANGE_MAX) - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !match[1] && !match[2]) return recordingError("Neplatný rozsah zvuku.", 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
  const end = match[1] && match[2] ? Number(match[2]) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start || !match[1] && Number(match[2]) === 0) return recordingError("Rozsah je mimo nahrávky.", 416);
  return { start, end: Math.min(end, total - 1, start + AUDIO_RANGE_MAX - 1) };
}
export async function getRecordingAudio(admin: SupabaseClient<Database>, actor: MotoristActor, callId: string, recordingId: string, request: Request): Promise<Response> {
  recordingUuid(recordingId);
  const [rows, permission] = await Promise.all([requireRecordingSource(admin, actor, callId), recordingPermissions(admin, actor)]);
  if (!permission.full) recordingError("Na prehrávanie nahrávok nemáš oprávnenie.", 403);
  const r = rows.recordings.find((row) => row.id === recordingId);
  if (!r) recordingError("Nahrávka sa nenašla.", 404);
  if (sourceRestricted(rows)) recordingError("Nahrávka už nie je dostupná.", 410);
  const prefix = `${actor.organizationId}/${callId}/${recordingId}/`;
  if (r.status !== "available" || r.storage_bucket !== RECORDINGS_BUCKET || !r.storage_path?.startsWith(prefix)
    || !/^r\d+\.(wav|mp3)$/.test(r.storage_path.slice(prefix.length)) || !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"].includes(r.mime_type ?? "")) recordingError("Nahrávka ešte nie je pripravená.", 409);
  const total = r.bytes ?? 0;
  let range: { start: number; end: number };
  try { range = recordingByteRange(request.headers.get("range"), total); }
  catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 416) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}`, "Cache-Control": "private, no-store" } });
    throw error;
  }
  const signed = await admin.storage.from(RECORDINGS_BUCKET).createSignedUrl(r.storage_path, 60);
  if (signed.error || !signed.data?.signedUrl) recordingError("Prehrávanie sa nepodarilo pripraviť.", 503);
  const storageOrigin = getSupabasePublicEnv()?.url;
  const url = new URL(signed.data.signedUrl);
  if (!storageOrigin || url.origin !== new URL(storageOrigin).origin || url.protocol !== "https:" || url.username || url.password) recordingError("Úložisko nahrávok nie je dostupné.", 503);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  const upstream = await fetch(url, { cache: "no-store", redirect: "error", signal, headers: { Range: `bytes=${range.start}-${range.end}`, "Accept-Encoding": "identity" } });
  const expected = range.end - range.start + 1;
  if (upstream.status !== 206 || upstream.headers.get("content-range") !== `bytes ${range.start}-${range.end}/${total}`
    || Number(upstream.headers.get("content-length")) !== expected || !upstream.body) {
    await upstream.body?.cancel(); recordingError("Úložisko nevrátilo požadovaný úsek.", 503);
  }
  // Re-check after signing/downloading headers so a concurrent deletion cannot
  // turn a valid old signed URL into a new authorized browser stream.
  const refreshed = await requireRecordingSource(admin, actor, callId);
  if (sourceRestricted(refreshed) || !(await recordingPermissions(admin, actor)).full) {
    await upstream.body.cancel(); recordingError("Prístup k nahrávke sa zmenil.", 410);
  }
  let delivered = 0;
  const stream = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { delivered += chunk.byteLength; if (delivered > expected) controller.error(new Error("audio_range_overflow")); else controller.enqueue(chunk); },
    flush(controller) { if (delivered !== expected) controller.error(new Error("audio_range_incomplete")); },
  }));
  return new Response(stream, { status: 206, headers: { "Content-Type": r.mime_type!, "Content-Length": String(expected),
    "Content-Range": `bytes ${range.start}-${range.end}/${total}`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
    "Vary": "Cookie, Range", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" } });
}
