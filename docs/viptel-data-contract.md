# VIPTel Data Contract

## Purpose

VIPTel provides telephony events, call history, queue/agent state, recordings, click-to-call, and SMS capabilities. The app stores VIPTel data in normalized Supabase tables and keeps raw payloads for traceability.

## Correlation

`viptel_unique_id` is the main external key for a call. It must be stored on:

- `calls.viptel_unique_id`
- `call_events.viptel_unique_id`
- `call_recordings.viptel_unique_id`

If an event arrives before a normalized call row exists, the bridge creates or upserts the call using `viptel_unique_id`.

## WebSocket Events

The bridge should normalize:

- call start,
- call answer,
- call end,
- API-created call,
- queue join,
- queue left,
- agent add/remove,
- agent pause/unpause.

Every received event writes one `call_events` row unless it is a duplicate.

## REST Reconciliation

Use REST for:

- active calls,
- call list and detail,
- call recordings,
- queue status,
- extension/agent data,
- click-to-call,
- backfill after bridge downtime.

Reconciliation updates normalized rows without deleting raw event history.

## Idempotency

Event ingestion must be idempotent. The first implementation should derive an event fingerprint from provider, `viptel_unique_id`, event type, provider timestamp if present, and a stable hash of the raw payload.

Duplicates should not create extra timeline records, duplicate missed calls, or duplicate recording jobs.

## Call to Case Rules

- Every call is stored.
- A call may remain unassigned.
- A call may create a new case.
- A call may be attached to an existing case.
- Informational calls stay in the call log and can still produce callback tasks.

## Recording Flow

After call end:

1. Mark the call as ended.
2. Schedule recording lookup.
3. Fetch metadata via REST.
4. Store the file in private Supabase Storage when allowed.
5. Insert or update `call_recordings`.
6. Queue transcript only if enabled for the organization.

## Failure Modes

- WebSocket drops: bridge reconnects and REST backfills missing calls.
- REST rate limit: retry with backoff and mark reconciliation as delayed.
- Recording unavailable: keep call complete and show recording status pending/failed.
- Unknown payload: store raw event, mark it unhandled, alert integration monitoring.
