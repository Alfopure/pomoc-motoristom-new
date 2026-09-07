import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { notConfiguredResponse, telephonyLogger } from "@/server/telephony/runtime";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";
import { verifyTelnyxRequest } from "@/server/telephony/telnyx/signature";
import { applyTelnyxMessageStatus, parseTelnyxMessageEvent } from "@/server/telephony/telnyx/sms-status";
import { receiveTelnyxSms } from "@/server/telephony/telnyx/sms-inbound";
import { getSmsChannel } from "@/server/sms-channel";
import { SmsWorkflowError } from "@/server/sms-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Signed delivery receipts and durable inbound SMS. Profile and receiving
 * number isolate environments; unknown outgoing IDs and failed writes retry.
 */
export async function POST(request: Request) {
  const config = getTelnyxConfig();
  if (!config.configured || !config.publicKey) {
    return notConfiguredResponse();
  }

  const raw = await request.text();
  if (raw.length > 256_000) return Response.json({ error: "payload_too_large" }, { status: 413 });
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
    const event = parseTelnyxMessageEvent(envelope);
    if (!event) return Response.json({ error: "invalid_event" }, { status: 400 });
    if (!config.messagingProfileId) return Response.json({ error: "messaging_profile_not_configured" }, { status: 503 });
    if (event?.payload.messaging_profile_id !== config.messagingProfileId) return Response.json({ ok: true, outcome: "foreign_profile" });
    if (event.type === "message.received") {
      const channel = getSmsChannel();
      if (!channel) return Response.json({ error: "inbound_not_enabled" }, { status: 503 });
      const received = await receiveTelnyxSms(createSupabaseAdminClient(), envelope, channel);
      telephonyLogger({ scope: "sms-webhook", ...received });
      return Response.json({ ok: true, ...received });
    }
    const result = await applyTelnyxMessageStatus(createSupabaseAdminClient(), envelope, { messagingProfileId: config.messagingProfileId });
    // A receipt may beat the send response that stores provider_message_id.
    if (result.outcome === "unknown_message") return Response.json({ error: "message_not_recorded_yet" }, { status: 503 });
    telephonyLogger({ scope: "sms-webhook", outcome: result.outcome, providerMessageId: result.providerMessageId, status: result.status });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    telephonyLogger({ level: "error", scope: "sms-webhook", message: "status update failed", error: error instanceof Error ? error.message : String(error) });
    return Response.json({ error: "processing_failed" }, { status: error instanceof SmsWorkflowError ? error.status : 500 });
  }
}
