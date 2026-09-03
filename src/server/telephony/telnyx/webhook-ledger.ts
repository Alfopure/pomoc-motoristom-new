import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

/**
 * Webhook claim ledger (`motorist_telnyx_webhook_events`).
 *
 * Telnyx delivers at-least-once, unordered and with a failover URL that can
 * hit the same handler twice within milliseconds. `claimWebhookEvent` wraps
 * the `motorist_telnyx_claim_webhook_event` RPC which inserts the row or takes
 * over a stale claim atomically:
 *
 * - `claimed`   → this invocation owns the event and must process it, then
 *                 call `markProcessed` or `markFailed`.
 * - `duplicate` → the event was already processed; acknowledge with 200.
 * - `busy`      → another invocation holds a fresh claim (< `staleAfterMs`);
 *                 acknowledge with 200 and do nothing.
 */

type AdminClient = SupabaseClient<Database>;
type ClaimRpcResult = Database["public"]["Functions"]["motorist_telnyx_claim_webhook_event"]["Returns"][number];

export type WebhookClaimOutcome = ClaimRpcResult["outcome"];
export type WebhookEventStatus = ClaimRpcResult["event_status"];

export const WEBHOOK_CLAIM_STALE_AFTER_MS = 30_000;

export type ClaimWebhookEventInput = {
  eventId: string;
  eventType: string;
  payload: Json;
  organizationId?: string | null;
  callSessionId?: string | null;
  callLegId?: string | null;
  callControlId?: string | null;
  connectionId?: string | null;
  /** ISO timestamp from the Telnyx envelope (`occurred_at`). */
  occurredAt?: string | null;
  staleAfterMs?: number;
};

export type WebhookClaim = {
  outcome: WebhookClaimOutcome;
  status: WebhookEventStatus;
  attempts: number;
};

export class WebhookLedgerError extends Error {
  constructor(
    message: string,
    readonly eventId: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WebhookLedgerError";
  }
}

const OUTCOMES: ReadonlySet<string> = new Set<WebhookClaimOutcome>(["claimed", "duplicate", "busy"]);
const STATUSES: ReadonlySet<string> = new Set<WebhookEventStatus>(["queued", "processed", "failed"]);

function parseClaimRow(eventId: string, row: unknown): WebhookClaim {
  if (!row || typeof row !== "object") {
    throw new WebhookLedgerError("Claim RPC returned no row", eventId);
  }
  const record = row as Record<string, unknown>;
  const outcome = record.outcome;
  const status = record.event_status;
  const attempts = Number(record.event_attempts ?? 0);
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome) || typeof status !== "string" || !STATUSES.has(status)) {
    throw new WebhookLedgerError("Claim RPC returned an unexpected row", eventId, row);
  }
  return { outcome: outcome as WebhookClaimOutcome, status: status as WebhookEventStatus, attempts: Number.isFinite(attempts) ? attempts : 0 };
}

export async function claimWebhookEvent(client: AdminClient, input: ClaimWebhookEventInput): Promise<WebhookClaim> {
  const eventId = input.eventId.trim();
  if (!eventId) throw new WebhookLedgerError("eventId is required", eventId);

  const { data, error } = await client
    .rpc("motorist_telnyx_claim_webhook_event", {
      p_event_id: eventId,
      p_event_type: input.eventType,
      p_payload: input.payload,
      p_organization_id: input.organizationId ?? null,
      p_call_session_id: input.callSessionId ?? null,
      p_call_leg_id: input.callLegId ?? null,
      p_call_control_id: input.callControlId ?? null,
      p_connection_id: input.connectionId ?? null,
      p_occurred_at: input.occurredAt ?? null,
      p_stale_after_ms: input.staleAfterMs ?? WEBHOOK_CLAIM_STALE_AFTER_MS,
    })
    .single();

  if (error) {
    throw new WebhookLedgerError(`Claim RPC failed: ${error.message}`, eventId, error);
  }
  return parseClaimRow(eventId, data);
}

/** Marks an owned event as processed and releases the claim. */
export async function markWebhookEventProcessed(client: AdminClient, eventId: string, options: { now?: () => Date } = {}): Promise<void> {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const { error } = await client
    .from("motorist_telnyx_webhook_events")
    .update({ status: "processed", processed_at: now, error: null, claimed_at: null })
    .eq("event_id", eventId);
  if (error) throw new WebhookLedgerError(`Could not mark event processed: ${error.message}`, eventId, error);
}

/**
 * Marks an owned event as failed. The claim timestamp is left in place so a
 * retry can only take over after `staleAfterMs`; `error` is truncated so a
 * huge stack trace never blocks the update.
 */
export async function markWebhookEventFailed(client: AdminClient, eventId: string, failure: unknown): Promise<void> {
  const message = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
  const { error } = await client
    .from("motorist_telnyx_webhook_events")
    .update({ status: "failed", error: message.slice(0, 2000) })
    .eq("event_id", eventId);
  if (error) throw new WebhookLedgerError(`Could not mark event failed: ${error.message}`, eventId, error);
}

/** Small description helper for structured webhook logs. */
export function describeWebhookClaim(claim: WebhookClaim): string {
  return `${claim.outcome}(${claim.status}#${claim.attempts})`;
}
