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
const STATUS_RANK: Record<SmsStatus, number> = { queued: 0, received: 0, sent: 1, delivered: 2, failed: 2 };

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

export async function applyTelnyxMessageStatus(admin: AdminClient, envelope: unknown, options: { now?: () => Date } = {}): Promise<SmsStatusResult> {
  const now = (options.now ?? (() => new Date()))();
  const event = parseTelnyxMessageEvent(envelope);
  const empty: SmsStatusResult = { outcome: "not_applicable", providerMessageId: null, status: null, detail: null, smsMessageId: null };
  if (!event || !event.type.startsWith("message.")) return empty;
  if (!event.providerMessageId) return { ...empty, outcome: "not_applicable", detail: "missing message id" };

  const providerStatus = event.providerStatus;
  const mapped = providerStatus ? TELNYX_MESSAGE_STATUS_MAP[providerStatus] : undefined;
  if (!mapped) {
    return { outcome: "ignored", providerMessageId: event.providerMessageId, status: null, detail: providerStatus, smsMessageId: null };
  }

  const existing = await admin.from("motorist_sms_messages").select("*").eq("provider_message_id", event.providerMessageId).maybeSingle();
  if (existing.error) throw new Error(`sms message lookup failed: ${existing.error.message}`);
  if (!existing.data) {
    return { outcome: "unknown_message", providerMessageId: event.providerMessageId, status: mapped, detail: providerStatus, smsMessageId: null };
  }

  const row = existing.data;
  if (STATUS_RANK[mapped] < STATUS_RANK[row.status]) {
    return { outcome: "ignored", providerMessageId: event.providerMessageId, status: row.status, detail: `late ${providerStatus}`, smsMessageId: row.id };
  }

  const timestamp = event.occurredAt ?? now.toISOString();
  const values: Database["public"]["Tables"]["motorist_sms_messages"]["Update"] = {
    status: mapped,
    status_detail: providerStatus,
    raw_payload: toJson({ event_id: event.id, event_type: event.type, payload: event.payload }),
    last_attempt_at: timestamp,
  };
  if (mapped === "sent" && !row.sent_at) values.sent_at = timestamp;
  if (mapped === "delivered") {
    values.delivered_at = row.delivered_at ?? timestamp;
    if (!row.sent_at) values.sent_at = timestamp;
    values.error = null;
  }
  if (mapped === "failed") values.error = event.errors.join("; ") || `Telnyx: ${providerStatus}`;

  const updated = await admin.from("motorist_sms_messages").update(values).eq("id", row.id).select("id").maybeSingle();
  if (updated.error) throw new Error(`sms status update failed: ${updated.error.message}`);

  return { outcome: "updated", providerMessageId: event.providerMessageId, status: mapped, detail: providerStatus, smsMessageId: row.id };
}
