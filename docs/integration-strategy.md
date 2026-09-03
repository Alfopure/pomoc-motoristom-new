# Integration Strategy

## Rule

External providers are adapters. The application core owns cases, calls, tasks, audit, reporting, and workflow. Provider payloads are normalized at the edge of the system.

## Telephony (Telnyx)

Telnyx is the telephony and SMS provider for this copy. The previous provider was removed entirely; until the Telnyx phases land, the app runs in the "Telefónia nie je nakonfigurovaná" mode.

- Call Control REST API: answer, dial, bridge, hold, transfer, conference, playback, gather, hangup, issued server-side with deterministic command ids and a 5 s timeout.
- Signed webhooks: every call, conference and message event is Ed25519-verified, claimed in an idempotent ledger and processed per call session.
- WebRTC: the browser phone registers with a per-operator credential using a short-lived JWT minted by the server; provider credentials never reach the browser.
- SMS: outbound only, alpha sender `PomocMotor`, delivery receipts via webhook. Inbound SMS is not available on Slovak fixed numbers.
- Environments: separate Call Control app, credential connection, outbound voice profile and messaging profile for dev/preview and production. Kill switches `TELNYX_LIVE_CALLS_ENABLED` and `TELNYX_SMS_LIVE_SENDS` plus database settings fail closed.

Resource identifiers live in [`operations/telnyx-setup.md`](./operations/telnyx-setup.md); the data contract in [`telnyx-data-contract.md`](./telnyx-data-contract.md).

## Supabase

Supabase is the application platform:

- Postgres for canonical state and event history,
- Auth for users and roles,
- Realtime Broadcast for active UI projections (planned; polling first),
- Storage for private attachments.

No long-running listener is needed: the provider pushes webhooks to Vercel route handlers, and one Vercel cron (every 5 minutes) handles reconciliation, sweeping and retention.

## Maps and Routing

Google Maps is the preferred first production provider for maps, Places autocomplete, geocoding, and route estimates. The application should depend on `GeocodingProvider` and `RoutingProvider`, not Google SDK types.

Route estimates are stored with provider metadata so the UI can show stale/degraded information if the provider fails.

The browser demo uses a restricted `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` for Maps JavaScript API and Places autocomplete. Route preview calls the internal `/api/maps/route` bridge, which uses server-only `GOOGLE_MAPS_API_KEY` with Google Routes API for real driving distance/time; otherwise the UI keeps the deterministic fallback estimate.

Current implementation details:

- browser key is used only for map rendering, AdvancedMarkerElement, and PlaceAutocompleteElement,
- optional `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` enables Advanced Markers without legacy marker warnings,
- server key is never shipped to the browser and is used only by route handlers,
- selected Places addresses are normalized to text address, GPS coordinates, Google Place ID, and provider `google_places`,
- route status is operator-visible as `Google live`, `Fallback`, or `Routes unavailable`.

## Fleet Locations

Fleet data comes from WebDispečink (tow vehicles), Commander (replacement cars) and SWHouse (replacement-vehicle occupancy) through server-side adapters and sync routes. The `FleetLocationProvider` boundary keeps the map independent of the provider.

## AI

AI is downstream of recordings/transcripts. It must not block call handling, case creation, or dispatch operations. Transcript and scoring jobs should be asynchronous and clearly visible as pending, failed, or complete. Recording is out of scope for the Telnyx rollout, so these jobs stay disabled.

## Failure Handling

Each provider integration needs:

- server-side credentials,
- retries with backoff (or compensation for real-time call commands),
- idempotency keys,
- raw payload storage where legally allowed,
- reconciliation/backfill path,
- operator-visible degraded state.
