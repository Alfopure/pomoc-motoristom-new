import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

/**
 * Webhook claim ledger (`motorist_telnyx_webhook_events`).
 *
 * Telnyx delivers at-least-once, unordered and with a failover URL that can
 * hit the same handler twice within milliseconds. `claimWebhookEvent` wraps
 * the `motorist_telnyx_claim_webhook_event_v2` RPC which inserts the row or takes
 * over a stale claim atomically:
 *
 * - `claimed`   → this invocation owns the event and must process it, then
 *                 call `markProcessed` or `markFailed`.
 * - `duplicate` → the event was already processed; acknowledge with 200.
 * - `busy`      → another invocation holds a fresh claim (< `staleAfterMs`);
 *                 leave the owner alone; control events request redelivery.
 */

type AdminClient = SupabaseClient<Database>;
type ClaimRpcResult = Database["public"]["Functions"]["motorist_telnyx_claim_webhook_event_v2"]["Returns"][number];

export type WebhookClaimOutcome = ClaimRpcResult["outcome"];
export type WebhookEventStatus = ClaimRpcResult["event_status"];

export const WEBHOOK_CLAIM_STALE_AFTER_MS = 30_000;

export type ClaimWebhookEventInput = {
  eventId: string;
  eventType: string;
  payload: Json;
  organizationId: string;
  callSessionId?: string | null;
  callLegId?: string | null;
  callControlId?: string | null;
  connectionId?: string | null;
  /** ISO timestamp from the Telnyx envelope (`occurred_at`). */
  occurredAt?: string | null;
  staleAfterMs?: number;
  replay?: "cron" | "correlation";
};

export type WebhookClaim = {
  outcome: WebhookClaimOutcome;
  status: WebhookEventStatus;
  attempts: number;
  /** Claim stamp of this invocation; the release is scoped to it. */
  claimedAt: string | null;
  receivedAt: string | null;
  retryState: string;
  terminalReason: string | null;
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

const OUTCOMES: ReadonlySet<string> = new Set<WebhookClaimOutcome>(["claimed", "duplicate", "busy", "terminal"]);
const STATUSES: ReadonlySet<string> = new Set<WebhookEventStatus>(["queued", "processed", "failed"]);

function parseClaimRow(eventId: string, row: unknown): WebhookClaim {
  if (!row || typeof row !== "object") {
    throw new WebhookLedgerError("Claim RPC returned no row", eventId);
  }
  const record = row as Record<string, unknown>;
  const outcome = record.outcome;
  const status = record.event_status;
  const attempts = Number(record.event_attempts ?? 0);
  const claimedAt = typeof record.event_claimed_at === "string" ? record.event_claimed_at : null;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome) || typeof status !== "string" || !STATUSES.has(status)) {
    throw new WebhookLedgerError("Claim RPC returned an unexpected row", eventId, row);
  }
  if (outcome === "claimed" && (!claimedAt || !Number.isFinite(Date.parse(claimedAt)) || typeof record.event_received_at !== "string" || !Number.isFinite(Date.parse(record.event_received_at)))) {
    throw new WebhookLedgerError("Claim RPC returned no valid ownership/receipt stamp", eventId);
  }
  return { outcome: outcome as WebhookClaimOutcome, status: status as WebhookEventStatus, attempts: Number.isFinite(attempts) ? attempts : 0, claimedAt,
    receivedAt: typeof record.event_received_at === "string" ? record.event_received_at : null,
    retryState: typeof record.event_retry_state === "string" ? record.event_retry_state : "ready",
    terminalReason: typeof record.event_terminal_reason === "string" ? record.event_terminal_reason : null };
}

export async function claimWebhookEvent(client: AdminClient, input: ClaimWebhookEventInput): Promise<WebhookClaim> {
  const eventId = input.eventId.trim();
  if (!eventId) throw new WebhookLedgerError("eventId is required", eventId);

  const { data, error } = await client
    .rpc("motorist_telnyx_claim_webhook_event_v2", {
      p_event_id: eventId,
      p_event_type: input.eventType,
      p_payload: input.payload,
      p_organization_id: input.organizationId,
      p_call_session_id: input.callSessionId ?? null,
      p_call_leg_id: input.callLegId ?? null,
      p_call_control_id: input.callControlId ?? null,
      p_connection_id: input.connectionId ?? null,
      p_occurred_at: input.occurredAt ?? null,
      p_stale_after_ms: input.staleAfterMs ?? WEBHOOK_CLAIM_STALE_AFTER_MS,
      p_delivery: !input.replay,
      p_correlation: input.replay === "correlation",
    })
    .single();

  if (error) {
    throw new WebhookLedgerError(`Claim RPC failed: ${error.message}`, eventId, error);
  }
  return parseClaimRow(eventId, data);
}

type FinishOptions = { now?: () => Date; claimedAt?: string | null; logger?: (entry: Record<string, unknown>) => void };

async function finish(client: AdminClient, eventId: string, result: "processed" | "deferred" | "awaiting_correlation" | "failed", failure: unknown, options: FinishOptions): Promise<boolean> {
  // Never issue an unscoped release: a missing stamp is not proof of ownership.
  if (!options.claimedAt) throw new WebhookLedgerError("Owned claim stamp is required", eventId);
  const message = failure instanceof Error ? `${failure.name}: ${failure.message}` : failure == null ? null : String(failure);
  const { data, error } = await client.rpc("motorist_telnyx_finish_webhook_event_v2", {
    p_event_id: eventId, p_claimed_at: options.claimedAt, p_result: result, p_error: message?.slice(0, 2000) ?? null,
  });
  if (error) throw new WebhookLedgerError(`Could not finish event: ${error.message}`, eventId, error);
  const owned = data === true;
  if (!owned) options.logger?.({ level: "warn", scope: "webhook", eventId, message: "claim lost before finish", result });
  return owned;
}

/** Atomic claim-CAS completion; processed/dead-letter rows cannot be reversed. */
export function markWebhookEventProcessed(client: AdminClient, eventId: string, options: FinishOptions = {}): Promise<boolean> {
  return finish(client, eventId, "processed", null, options);
}

/** Only proven pre-effect failures are deferrals; ambiguous effects keep their failure budget. */
export function markWebhookEventFailed(client: AdminClient, eventId: string, failure: unknown,
  options: FinishOptions & { releaseForRetry?: boolean; awaitingCorrelation?: boolean } = {},
): Promise<boolean> {
  return finish(client, eventId, options.awaitingCorrelation ? "awaiting_correlation" : options.releaseForRetry ? "deferred" : "failed", failure, options);
}

/** Small description helper for structured webhook logs. */
export function describeWebhookClaim(claim: WebhookClaim): string {
  return `${claim.outcome}(${claim.status}#${claim.attempts})`;
}
