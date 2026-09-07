import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { SmsChannel } from "@/server/sms-channel";
import { normalizeSmsRecipient, SmsWorkflowError } from "@/server/sms-errors";
import { parseTelnyxMessageEvent } from "./sms-status";

/** A single durable insert precedes the acknowledgement. No case is inferred from a phone number. */
export async function receiveTelnyxSms(admin: SupabaseClient<Database>, envelope: unknown, channel: SmsChannel, now = new Date()) {
  const event = parseTelnyxMessageEvent(envelope);
  if (!event || event.type !== "message.received") return { outcome: "ignored" };
  if (event.payload.messaging_profile_id !== channel.messagingProfileId) return { outcome: "foreign_profile" };
  if (!event.providerMessageId) throw new SmsWorkflowError("Chýba ID prijatej SMS.", 400);
  const from = record(event.payload.from).phone_number;
  const sender = normalizeSmsRecipient(from, "Odosielateľ prijatej SMS");
  const recipients = Array.isArray(event.payload.to) ? event.payload.to : [];
  const ours = recipients.some((recipient) => {
    try { return normalizeSmsRecipient(record(recipient).phone_number) === channel.number; } catch { return false; }
  });
  if (!ours) return { outcome: "foreign_number" };
  if (event.direction && event.direction !== "inbound") throw new SmsWorkflowError("Neplatný smer prijatej SMS.", 400);
  const body = typeof event.payload.text === "string" ? event.payload.text : "";
  const key = `telnyx:inbound:${channel.messagingProfileId}:${event.providerMessageId}`;
  const fingerprint = createHash("sha256").update(JSON.stringify([sender, channel.number, body])).digest("hex");
  const receivedAt = typeof event.payload.received_at === "string" ? event.payload.received_at : event.occurredAt;
  const createdAt = receivedAt && Number.isFinite(Date.parse(receivedAt)) ? new Date(receivedAt).toISOString() : now.toISOString();
  const signal = AbortSignal.timeout(1500);
  const inserted = await admin.from("motorist_sms_messages").insert({
    organization_id: channel.organizationId, provider: "telnyx_sms", provider_message_id: event.providerMessageId,
    messaging_profile_id: channel.messagingProfileId, from_sender: sender, from_label: sender, to_number: channel.number,
    direction: "inbound", status: "received", status_detail: "received_unread", body,
    case_id: null, call_id: null, template_key: null, idempotency_key: key, request_fingerprint: fingerprint,
    created_at: createdAt, raw_payload: {
      source: "telnyx_inbound", inbox: { assigned_profile_id: null, received_at: now.toISOString() },
      provider_event: { id: event.id, type: event.type, occurred_at: event.occurredAt, payload: event.payload } as Json,
    },
  }).select("id").abortSignal(signal).single();
  if (!inserted.error && inserted.data) return { outcome: "stored", smsMessageId: inserted.data.id };
  if (inserted.error?.code === "23505") {
    const previous = await admin.from("motorist_sms_messages").select("id, direction, request_fingerprint")
      .eq("organization_id", channel.organizationId).eq("provider", "telnyx_sms").eq("idempotency_key", key)
      .abortSignal(signal).maybeSingle();
    if (!previous.error && previous.data?.direction === "inbound" && previous.data.request_fingerprint === fingerprint) {
      return { outcome: "duplicate", smsMessageId: previous.data.id };
    }
  }
  // This also covers an uncertain database timeout: Telnyx retries the same ID.
  throw new SmsWorkflowError("Prijatú SMS sa nepodarilo trvalo uložiť.", 503);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
