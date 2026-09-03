# Architecture

## Direction

This project is moving from a clickable dispatcher demo toward a production foundation for a first real client. The architecture should stay concrete enough for Pomoc Motoristom, but avoid hard-coding choices that would make a future client or provider swap expensive. The previous telephony provider was removed wholesale; the telephony provider going forward is Telnyx (see [`telnyx-data-contract.md`](./telnyx-data-contract.md)).

The intended shape is a modular monolith:

- Next.js on Vercel (region `fra1`) handles the dispatcher UI, app-facing server routes, provider webhooks and provider REST clients.
- Supabase Postgres is the operational source of truth.
- Supabase Auth identifies users and roles.
- Supabase Realtime Broadcast pushes active call and presence changes to the UI from database triggers on the private topic `org:<organization_id>:telephony`; polling remains a fully sufficient fallback and relaxes its cadence when the channel is connected.
- Supabase Storage keeps attachments, photos and generated documents.
- Telnyx is integrated through signed webhooks and server-side REST calls, never through provider credentials in the browser. The browser phone registers with WebRTC using a short-lived token minted by the server.
- Maps, routing, SMS, fleet locations, telephony, and AI are accessed through provider interfaces.

There is no long-running listener process: the provider pushes events to route handlers, and one Vercel cron (every 5 minutes) reconciles, sweeps and prunes.

## Runtime Components

### Dispatcher Web App

The web app owns the operator experience: phone bar, cases, map, tasks, reports, and settings. It should read from domain services rather than importing vendor SDKs or raw integration payloads in UI components.

### Supabase

Supabase stores normalized application data and event history:

- canonical records such as cases, contacts, vehicles, branches, fleet assets, calls, and tasks,
- append-only integration events such as call events and a webhook ledger,
- audit entries for operational and security-relevant changes,
- private storage objects for attachments.

### Telephony Webhook Pipeline (Telnyx)

Provider events arrive at `/api/telephony/telnyx/webhook`, are signature-verified (Ed25519), claimed in an idempotent ledger, serialized per call session by a lease lock plus a version CAS, reduced by a pure state machine and persisted. Provider-affecting commands (answer, dial, bridge, hold, transfer, hangup) are issued synchronously from route handlers with deterministic command ids; failures trigger compensating commands and an incident row instead of blind retries. SMS delivery statuses use the same shape at `/api/sms/telnyx/webhook`.

The telephony server modules live under `src/server/telephony/`:

- `telnyx/` — REST client, signature verification, client state, command ids, webhook ledger, event processor.
- `state/` — event parsing, the pure reducer (`transitions.ts`) and the effects layer that persists a transition and executes its commands.
- `routing/` — business hours, operator eligibility, ring plans and groups, operator reservation.
- `call-actions.ts`, `presence-service.ts`, `operator-devices.ts`, `active-calls.ts`, `cron-jobs.ts`, `session-runner.ts`, `runtime.ts` — the services the API routes call.

Application-owned routing (ring groups, ring plans, business hours, IVR, waiting room) is deliberately in Postgres and not in the provider: the provider has no queue of its own, and the routing rules must be editable by a manager without a deployment.

### Provider Adapters

External systems are hidden behind provider contracts:

- `TelephonyProvider`
- `SmsTransport`
- `GeocodingProvider`
- `RoutingProvider`
- `FleetLocationProvider`

The UI and domain workflow depend on these contracts, not on provider payloads. Without `TELNYX_API_KEY` the app runs in the "Telefónia nie je nakonfigurovaná" mode: call history, callbacks, directory, outcomes and call-to-case linking work, while telephony routes answer `503` and the UI shows the notice.

## Data Flow

1. The provider emits a signed webhook (or the operator triggers a command through an authenticated route).
2. The route handler validates, deduplicates (claim ledger) and persists raw + normalized event data.
3. Supabase updates active projections such as `calls`, operator presence and call sessions.
4. The dispatcher UI refreshes through polling, and immediately on a Realtime Broadcast message when the channel is up.
5. The operator links a call to a case or classifies it as informational.
6. Case changes write business timeline entries and audit records.
7. Missed calls create callback tasks; after-hours callers can request a callback.

## Design Rules

- Store every phone call as a call log; only some calls become cases.
- Keep `provider_session_id` as the primary external correlation key for call records.
- Store raw external payloads for debugging, but drive app behavior from normalized columns.
- Scope production data by `organization_id` from the first migration.
- Keep the current mock demo working without Supabase, telephony, or Google credentials.
- Treat map routing and fleet locations as operational services, not as UI-only map code.
- Every provider-affecting action is guarded by env and database kill switches and fails closed.
