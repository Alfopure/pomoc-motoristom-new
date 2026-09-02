# Data Model

## Model Shape

The foundation data model is single-client first and multi-client-ready. Seed data can contain one organization, but core tables include `organization_id` so a later client can be introduced without rewriting every table.

In the hosted Supabase project, this application uses a `motorist_` table prefix in the `public` schema because the project already contained unrelated tables such as `profiles`. For example, the logical `calls` table is deployed as `motorist_calls`, and `cases` is deployed as `motorist_cases`.

## Core Tables

### Organization and Users

- `motorist_organizations`: client account, slug, display name, active flag.
- `motorist_organization_profiles`: branding, default locale, timezone, emergency line labels, enabled modules.
- `motorist_profiles`: Supabase Auth user profile, organization, role, extension, active flag.
- `motorist_operator_statuses`: status history for availability, ringing, on-call, after-call work, pause, and offline.

### Telephony

- `motorist_telephony_lines`: configured public numbers such as `0850 005 006`.
- `motorist_telephony_queues`: VIPTel queue mapping and display labels.
- `motorist_telephony_extensions`: operator extension mapping.
- `motorist_calls`: latest normalized state of each call.
- `motorist_call_events`: append-only event history from VIPTel WebSocket/REST.
- `motorist_call_recordings`: recording metadata and private storage reference.
- `motorist_queue_memberships`: current VIPTel queue membership and pause/in-use state per extension.
- `motorist_queue_snapshots`: time-series snapshots for queue SLA and later reporting.
- `motorist_telephony_commands`: auditable outbound commands such as click-to-call, hangup, redirect and queue pause.

Every VIPTel call row stores `viptel_unique_id` when available. `call_events` also stores raw and normalized payloads for traceability.

### Cases

- `motorist_cases`: operational assistance case, status, priority, source, owner, contact, vehicle, pickup, destination, summary, close reason.
- `motorist_case_events`: business timeline and audit-friendly case history.
- `motorist_case_tasks`: callbacks, confirmations, document requests, dispatch follow-ups.
- `motorist_contacts`: clients, assistance companies, branches, partners.
- `motorist_vehicles`: client vehicles, technical constraints, drivability.

Calls and cases are deliberately separate. A call can stay unassigned, be linked to an existing case, or create a new case.

### Operations and Map Data

- `motorist_locations`: address, latitude, longitude, provider place id, confidence.
- `motorist_branches`: client branch/standpoint records.
- `motorist_fleet_assets`: tow trucks, replacement cars, or future tracked resources. V1 also keeps lightweight crew fields (`assigned_driver_name`, phone and status) directly on the asset; a later employee module can split this into staff tables without changing the operator workflow.
- `motorist_external_vehicle_records`: external vehicle catalog rows from Commander or a client vehicle database. These rows are not business fleet assets and do not appear on the map by themselves.
- `motorist_fleet_asset_links`: confirmed, candidate, or rejected relationship between an external vehicle record and a business fleet asset. A confirmed Commander link is required before Commander GPS can power a replacement car on the map.
- `motorist_fleet_current_positions`: latest GPS position per external vehicle. For Commander replacement cars, GPS freshness is evaluated from `gps_time`.
- `motorist_fleet_position_samples`: append-only GPS sample history for audit, reporting, and later trip-book generation.
- `motorist_fleet_provider_vehicles`: WebDispečink provider-side catalog/current state for tow vehicles.
- `motorist_route_estimates`: cached provider route result with distance, duration, polyline, provider metadata, and freshness.
- `motorist_sms_messages`: canonical outbound/inbound SMS row, provider message id, delivery state, body template reference, idempotency and worker claim fields.
- `motorist_sms_attempts`: one audit row per provider send attempt, with sanitized request/response payload, provider status, error class and retry timing.
- `motorist_integration_raw_events`: append-only raw REST/WebSocket/SMS payload log. This is the first write target for provider bridges before normalizing into operational tables.
- `motorist_call_transcripts`: optional transcript, summary and extracted fields for recordings.

### Audit

- `motorist_audit_log`: actor, action, entity, before/after payload references, source, IP/user-agent where available.

Audit must cover case changes, call-to-case linking, SMS sends, recording access, integration setting changes, branch/fleet changes, and security-sensitive admin actions.

## Status Defaults

Call statuses:

- `incoming`
- `ringing_agent`
- `answered`
- `missed`
- `abandoned_queue`
- `outbound`
- `ended`
- `failed`

Case statuses remain aligned with the existing domain model: `new`, `triage`, `open`, `waiting_for_client`, `scheduled`, `assigned`, `dispatched`, `in_progress`, `waiting_for_docs`, `completed_assisted`, `completed_no_assistance`, `rejected`, `cancelled`, `futile_trip`.

Operator statuses:

- `available`
- `ringing`
- `on_call`
- `after_call_work`
- `working_case`
- `paused`
- `offline`

## Fleet Asset Vs External Vehicle

`motorist_fleet_assets` is the business vehicle record used by dispatch, map selection, reservations, rental status, documents, service state, and operator workflows.

`motorist_external_vehicle_records` is a provider-side vehicle record. Commander records are candidates for replacement cars; WebDispečink remains the GPS provider for tow vehicles through provider-specific tables.

`motorist_fleet_asset_links` is the explicit decision layer between the two. Only `link_status = 'confirmed'` allows an external GPS source to be projected onto a business fleet asset. Rejected Commander records stay out of the map and out of operational fleet workflows.

## Migration Rules

- Use migrations for all schema changes.
- Enable RLS on app tables from the first migration.
- Use `organization_id` on operational tables.
- Avoid storing secrets in database rows; store references or non-sensitive metadata.
- Store recordings in private storage and keep metadata in relational tables.
