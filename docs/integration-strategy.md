# Integration Strategy

## Rule

External providers are adapters. The application core owns cases, calls, tasks, audit, reporting, and workflow. Provider payloads are normalized at the edge of the system.

## VIPTel

VIPTel is the first telephony provider.

- WebSocket: realtime call, queue, and agent events.
- REST: active calls, history/CDR, call details, recordings, queues, extensions, agent state, and click-to-call.
- SMS: localization links, ETA updates, case confirmations, and future 2-way messages.

VIPTel is accessed only through server-side bridge/API code. The browser receives normalized Supabase data.

## Supabase

Supabase is the application platform:

- Postgres for canonical state and event history,
- Auth for users and roles,
- Realtime for active UI projections,
- Storage for private recordings and attachments,
- Edge Functions for short server-side tasks where suitable.

A long-running VIPTel WebSocket listener may require a separate worker service with stable outbound IP and health monitoring.

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

Fleet data may later come from Webdispečink, Commander, a mobile driver app, or manual operator updates. The first foundation only defines the `FleetLocationProvider` boundary and stores fleet asset records.

## AI

AI is downstream of recordings/transcripts. It must not block call handling, case creation, or dispatch operations. Transcript and scoring jobs should be asynchronous and clearly visible as pending, failed, or complete.

## Failure Handling

Each provider integration needs:

- server-side credentials,
- retries with backoff,
- idempotency keys,
- raw payload storage where legally allowed,
- reconciliation/backfill path,
- operator-visible degraded state.
