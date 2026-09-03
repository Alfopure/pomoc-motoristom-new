import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { notConfiguredResponse, telephonyLogger } from "@/server/telephony/runtime";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";
import { verifyTelnyxRequest } from "@/server/telephony/telnyx/signature";
import { applyTelnyxMessageStatus } from "@/server/telephony/telnyx/sms-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Telnyx messaging delivery-status webhook.
 *
 * Same signature contract as the call-control webhook; the body carries
 * `message.sent` / `message.finalized`, whose per-recipient status is mirrored
 * onto `motorist_sms_messages`. Unknown message ids are acknowledged (the row
 * may belong to another environment sharing the messaging profile).
 */
export async function POST(request: Request) {
  const config = getTelnyxConfig();
  if (!config.configured || !config.publicKey) {
    return notConfiguredResponse();
  }

  const raw = await request.text();
  const verified = verifyTelnyxRequest(request.headers, raw, { publicKey: config.publicKey });
  if (!verified.ok) {
    telephonyLogger({ level: "warn", scope: "sms-webhook", verified: false, reason: verified.reason });
    return Response.json({ error: "invalid_signature", reason: verified.reason }, { status: 400 });
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const result = await applyTelnyxMessageStatus(createSupabaseAdminClient(), envelope);
    telephonyLogger({ scope: "sms-webhook", outcome: result.outcome, providerMessageId: result.providerMessageId, status: result.status });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    telephonyLogger({ level: "error", scope: "sms-webhook", message: "status update failed", error: error instanceof Error ? error.message : String(error) });
    return Response.json({ error: "processing_failed" }, { status: 500 });
  }
}
