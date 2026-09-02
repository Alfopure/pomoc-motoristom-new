# Architecture

## Direction

This project is moving from a clickable dispatcher demo toward a production foundation for a first real client. The architecture should stay concrete enough for Pomoc Motoristom, but avoid hard-coding choices that would make a future client or provider swap expensive.

The intended shape is a modular monolith:

- Next.js handles the dispatcher UI and app-facing server routes.
- Supabase Postgres is the operational source of truth.
- Supabase Auth identifies users and roles.
- Supabase Realtime pushes active call, case, and operator projections to the UI.
- Supabase Storage keeps recordings, attachments, photos, and generated documents.
- VIPTel is integrated through a server-side bridge, never directly from the browser.
- Maps, routing, SMS, fleet locations, telephony, and AI are accessed through provider interfaces.

## Runtime Components

### Dispatcher Web App

The web app owns the operator experience: call bar, cases, map, tasks, reports, and settings. It should read from domain services rather than importing vendor SDKs or raw integration payloads in UI components.

### Supabase

Supabase stores normalized application data and event history:

- canonical records such as cases, contacts, vehicles, branches, fleet assets, calls, and tasks,
- append-only integration events such as VIPTel call events,
- audit entries for operational and security-relevant changes,
- private storage objects for recordings and attachments.

### VIPTel Bridge

The VIPTel bridge is a server-side process that receives WebSocket events, reconciles via REST, normalizes payloads, and writes to Supabase. It may run as a Supabase Edge Function only for short-lived operations; a long-lived WebSocket listener should be evaluated as a small worker service if Supabase Edge Functions are not suitable.

### Provider Adapters

External systems are hidden behind provider contracts:

- `TelephonyProvider`
- `SmsProvider`
- `GeocodingProvider`
- `RoutingProvider`
- `FleetLocationProvider`

The first concrete telephony adapter will be VIPTel. The UI and domain workflow should depend on provider contracts, not VIPTel-specific payloads.

## Data Flow

1. VIPTel emits realtime WebSocket events.
2. The bridge validates, deduplicates, and persists raw + normalized event data.
3. Supabase updates active projections such as `calls`, `operator_statuses`, and `telephony_queues`.
4. Supabase Realtime notifies the dispatcher UI.
5. The operator links a call to a case or classifies it as informational.
6. Case changes write business timeline entries and audit records.
7. After call end, background work fetches recording metadata/file and optionally starts transcript and AI summary jobs.

## Design Rules

- Store every phone call as a call log; only some calls become cases.
- Keep `viptel_unique_id` as the primary external correlation key for VIPTel call records.
- Store raw external payloads for debugging, but drive app behavior from normalized columns.
- Scope production data by `organization_id` from the first migration.
- Keep the current mock demo working without Supabase, VIPTel, or Google credentials.
- Treat map routing and fleet locations as operational services, not as UI-only map code.
