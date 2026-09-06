import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyScribeSignature } from "@/lib/integrations/asr/scribe-async";
import { acceptScribeWebhook } from "@/server/telephony/recording-asr";
import { RecordingProcessingError } from "@/server/telephony/recording-jobs";
export const runtime = "nodejs";
export const maxDuration = 15;
export async function POST(request: Request) {
  const max = 4_000_000;
  if (Number(request.headers.get("content-length")) > max) return Response.json({ error: "payload_too_large" }, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "payload_missing" }, { status: 400 });
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > max) { await reader.cancel(); return Response.json({ error: "payload_too_large" }, { status: 413 }); }
      chunks.push(value);
    }
  } catch { return Response.json({ error: "payload_invalid" }, { status: 400 }); }
  finally { reader.releaseLock(); }
  const raw = Buffer.concat(chunks).toString("utf8"), signature = request.headers.get("elevenlabs-signature");
  if (!verifyScribeSignature(raw, signature, process.env.ELEVENLABS_SCRIBE_WEBHOOK_SECRET ?? "")) return Response.json({ error: "signature_invalid" }, { status: 401 });
  try {
    const result = await acceptScribeWebhook(createSupabaseAdminClient(), raw, signature, AbortSignal.timeout(10_000));
    return Response.json({ status: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof RecordingProcessingError ? error.code : "scribe_accept_failed";
    return Response.json({ error: code }, { status: code === "scribe_signature_invalid" ? 401 : code === "scribe_payload_invalid" ? 400 : 503 });
  }
}
