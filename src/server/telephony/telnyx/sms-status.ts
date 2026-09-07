import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { toJson } from "../state/types";

/**
 * Telnyx messaging delivery-status webhook (`/api/sms/telnyx/webhook`).
 *
 * Telnyx sends `message.sent` / `message.finalized` (and `message.received`
 * for inbound, which the alphanumeric sender never produces) with the
 * per-recipient status inside `payload.to[]`. We mirror that status onto the
 * `motorist_sms_messages` row identified by `provider_message_id`; the row is
 * the audit source for the case timeline.
 *
 * Delivery is at-least-once and unordered, so the update never moves a message
 * backwards: once `delivered`/`failed` is written a late `sent` is ignored.
 */

type AdminClient = SupabaseClient<Database>;
type SmsStatus = Database["public"]["Tables"]["motorist_sms_messages"]["Row"]["status"];

/** Terminal-first ranking; a lower rank never overwrites a higher one. */
const STATUS_RANK: Record<SmsStatus, number> = { queued: 0, received: 0, sent: 1, failed: 3, delivered: 4 };
function rank(status: SmsStatus, detail: string | null) { return detail === "delivery_unconfirmed" ? 2 : STATUS_RANK[status]; }

export const TELNYX_MESSAGE_STATUS_MAP: Record<string, SmsStatus> = {
  queued: "queued",
  sending: "queued",
  sent: "sent",
  delivery_unconfirmed: "sent",
  delivered: "delivered",
  sending_failed: "failed",
  delivery_failed: "failed",
  expired: "failed",
  rejected: "failed",
};

export type SmsStatusOutcome = "updated" | "ignored" | "unknown_message" | "not_applicable";

export type SmsStatusResult = {
  outcome: SmsStatusOutcome;
  providerMessageId: string | null;
  status: SmsStatus | null;
  detail: string | null;
  smsMessageId: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type ParsedMessageEvent = {
  id: string;
  type: string;
  occurredAt: string | null;
  providerMessageId: string | null;
  providerStatus: string | null;
  direction: string | null;
  errors: string[];
  payload: Record<string, unknown>;
};

export function parseTelnyxMessageEvent(envelope: unknown): ParsedMessageEvent | null {
  const data = asRecord(asRecord(envelope).data);
  const id = str(data.id);
  const type = str(data.event_type);
  if (!id || !type) return null;
  const payload = asRecord(data.payload);
  const recipients = Array.isArray(payload.to) ? payload.to.map(asRecord) : [];
  const errors = (Array.isArray(payload.errors) ? payload.errors.map(asRecord) : [])
    .map((entry) => [str(entry.code), str(entry.title), str(entry.detail)].filter(Boolean).join(" — "))
    .filter((entry) => entry.length > 0);

  return {
    id,
    type,
    occurredAt: str(data.occurred_at),
    providerMessageId: str(payload.id),
    providerStatus: str(recipients[0]?.status) ?? str(payload.status),
    direction: str(payload.direction),
    errors,
    payload,
  };
}

export async function applyTelnyxMessageStatus(admin: AdminClient, envelope: unknown, options: { now?: () => Date; messagingProfileId?: string } = {}): Promise<SmsStatusResult> {
  const now = (options.now ?? (() => new Date()))();
  const event = parseTelnyxMessageEvent(envelope);
  const empty: SmsStatusResult = { outcome: "not_applicable", providerMessageId: null, status: null, detail: null, smsMessageId: null };
  if (!event || !["message.sent", "message.finalized"].includes(event.type) || event.direction === "inbound") return empty;
  if (!event.providerMessageId) return { ...empty, detail: "missing message id" };
  if (options.messagingProfileId && event.payload.messaging_profile_id !== options.messagingProfileId) return { ...empty, detail: "foreign messaging profile" };
  const providerStatus = event.providerStatus;
  const mapped = providerStatus ? TELNYX_MESSAGE_STATUS_MAP[providerStatus] : undefined;
  if (!mapped) return { ...empty, outcome: "ignored", providerMessageId: event.providerMessageId, detail: providerStatus };

  // Optimistic compare-and-swap retries after a competing receipt. Both status
  // and detail are predicates, so sent -> delivery_unconfirmed is protected too.
  for (let attempt = 0; attempt < 4; attempt++) {
    let lookup = admin.from("motorist_sms_messages").select("*").eq("provider", "telnyx_sms").eq("direction", "outbound").eq("provider_message_id", event.providerMessageId);
    if (options.messagingProfileId) lookup = lookup.eq("messaging_profile_id", options.messagingProfileId);
    const existing = await lookup.maybeSingle();
    if (existing.error) throw new Error(`sms message lookup failed: ${existing.error.message}`);
    if (!existing.data) return { outcome: "unknown_message", providerMessageId: event.providerMessageId, status: mapped, detail: providerStatus, smsMessageId: null };
    const row = existing.data;
    const ignored: SmsStatusResult = { outcome: "ignored", providerMessageId: event.providerMessageId, status: row.status, detail: row.status_detail, smsMessageId: row.id };
    const recipient = (Array.isArray(event.payload.to) ? event.payload.to : []).map(asRecord).find((to) => to.phone_number === row.to_number);
    const sender = str(asRecord(event.payload.from).phone_number);
    if (!recipient || (row.from_sender && row.from_sender !== sender)) return { ...ignored, detail: "recipient or sender mismatch" };
    const payload = asRecord(row.raw_payload);
    const previousEvent = asRecord(payload.provider_event);
    if (previousEvent.id === event.id) return ignored;
    const currentRank = rank(row.status, row.status_detail);
    const nextRank = rank(mapped, providerStatus);
    if (nextRank < currentRank || (nextRank === currentRank && (currentRank >= 2 || row.status_detail === providerStatus))) return ignored;
    if (nextRank === currentRank && typeof previousEvent.occurred_at === "string" && event.occurredAt && Date.parse(event.occurredAt) <= Date.parse(previousEvent.occurred_at)) return ignored;
    const timestamp = event.occurredAt && Number.isFinite(Date.parse(event.occurredAt)) ? new Date(event.occurredAt).toISOString() : now.toISOString();
    const values: Database["public"]["Tables"]["motorist_sms_messages"]["Update"] = {
      status: mapped, status_detail: providerStatus,
      raw_payload: toJson({ ...payload, provider_event: { id: event.id, type: event.type, occurred_at: timestamp, payload: event.payload } }),
    };
    if (mapped === "sent" && !row.sent_at) values.sent_at = timestamp;
    if (mapped === "delivered") {
      values.delivered_at = row.delivered_at ?? timestamp;
      if (!row.sent_at) values.sent_at = timestamp;
      values.error = null;
    }
    if (mapped === "failed") values.error = event.errors.join("; ") || `Telnyx: ${providerStatus}`;
    let update = admin.from("motorist_sms_messages").update(values).eq("id", row.id).eq("organization_id", row.organization_id).eq("status", row.status);
    update = row.status_detail == null ? update.is("status_detail", null) : update.eq("status_detail", row.status_detail);
    if (row.updated_at) update = update.eq("updated_at", row.updated_at);
    const updated = await update.select("id").maybeSingle();
    if (updated.error) throw new Error(`sms status update failed: ${updated.error.message}`);
    if (updated.data) return { outcome: "updated", providerMessageId: event.providerMessageId, status: mapped, detail: providerStatus, smsMessageId: row.id };
  }
  throw new Error("sms status update contention; retry receipt");
}
