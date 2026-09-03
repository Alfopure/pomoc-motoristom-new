# Data Model

## Model Shape

The foundation data model is single-client first and multi-client-ready. Seed data can contain one organization, but core tables include `organization_id` so a later client can be introduced without rewriting every table.

This application uses a `motorist_` table prefix in the `public` schema. For example, the logical `calls` table is deployed as `motorist_calls`, and `cases` is deployed as `motorist_cases`.

## Core Tables

### Organization and Users

- `motorist_organizations`: client account, slug, display name, active flag.
- `motorist_organization_profiles`: branding, default locale, timezone, emergency line labels, enabled modules.
- `motorist_organization_integrations`: one row per provider (`telnyx`, `telnyx_sms`, `google_maps`, `fleet`, `ai`, `commander`, `client_vehicle_db`, ...) with status, enabled features, base URL and last success/error metadata. Secrets are referenced by env name, never stored.
- `motorist_profiles`: Supabase Auth user profile, organization, role, active flag.
- `motorist_operator_statuses`: status history for availability, ringing, on-call, after-call work, pause, and offline.

### Telephony

- `motorist_telephony_lines`: configured public numbers (one row per line) with a label and partner name, e.g. `Neutrálna linka`, `Allianz Assistance`. Inbound calls resolve the dialled number to a line so the partner is visible in the phone bar, call log and case.
- `motorist_telephony_queues`: legacy label table kept only for call-history labels; it will be replaced by ring groups.
- `motorist_calls`: latest normalized state of each call (`provider`, `provider_session_id`, `provider_call_id`, direction, status, numbers, `line_id`, `received_number`, `end_reason`, timings, `case_id`, `raw_latest_payload`).
- `motorist_call_events`: append-only event history keyed by `provider_session_id` with raw and normalized payloads.
- `motorist_call_recordings`: recording metadata and private storage reference. Recording is out of scope for the Telnyx rollout; the table stays but is not populated.
- `motorist_call_transcripts`: optional transcript, summary and extracted fields for recordings (senior+ access).

Every call row stores `provider_session_id` when available. It is the only correlation key between legs, events and the call log.

#### Telnyx runtime tables

Written by the webhook pipeline through the service role; organization members may read them. Full column semantics are in [`telnyx-data-contract.md`](./telnyx-data-contract.md).

- `motorist_telnyx_webhook_events`: idempotency ledger keyed by the provider `event_id` (`status` `queued|processed|failed`, `attempts`, `claimed_at`, `error`, raw `payload`). No grants to `anon`/`authenticated`; the claim RPC is the only writer.
- `motorist_call_sessions`: one row per provider call session (`telnyx_session_id`, `state`, `version`, `lease_token`/`lease_until`, `line_id`, `ring_plan_id`, `current_step`, `conference_id`, `customer_leg_id`, `answered_by_profile_id`, `case_id`, timings, `metadata`).
- `motorist_call_legs`: one row per provider leg (`telnyx_call_control_id` unique, `role` `customer|operator|consult|supervisor|external`, `profile_id`, numbers, `state`, `hangup_cause`, `client_state`).
- `motorist_ring_attempts`: one row per offered ring member per step, with the attempt `result`. A partial unique index on `(profile_id) where result = 'offered'` guarantees a single open offer per operator.
- `motorist_operator_presence` and `motorist_operator_devices`: current availability (`status`, `current_session_id`, `pause_reason_id`, `wrap_up_until`) and the browser phone registration (`telnyx_credential_id`, `sip_username`, `device_seen_at`, `device_session_id`, one row per `(profile_id, environment)`). Presence changes continue to be mirrored into `motorist_operator_statuses` for history.
- `motorist_callback_requests`: after-hours and missed-call callbacks (`caller_number`, `source`, `status`, `session_id`, `case_id`, `claimed_by`, `due_at`).
- `motorist_telephony_daily_usage`: per-day leg/minute/SMS counters behind the soft cap alert.

#### Telnyx configuration tables

Member-readable, manager/admin writable, org-scoped: `motorist_ring_groups`, `motorist_ring_group_members`, `motorist_ring_plans`, `motorist_ring_plan_steps`, `motorist_business_hours` (+ `_intervals`, `_exceptions`), `motorist_ivr_menus` (+ `motorist_ivr_options`), `motorist_pause_reasons`, `motorist_operator_telephony_settings` (per operator: default outbound line, wrap-up seconds, auto-answer, ring volume) and `motorist_telephony_settings` (one row per organization: the database kill switches `live_calls_enabled`/`sms_live_sends`, `daily_leg_soft_cap`, `park_max_minutes`, `destination_allowlist`, `max_ring_fanout`, `max_concurrent_legs`).

`motorist_telephony_lines` is extended with `telnyx_number_id`, `partner_name`, `ring_plan_id`, `ivr_menu_id`, `business_hours_id`, `environment` and `active`, and is unique on `(organization_id, phone_number)`.

#### Telephony RPCs

`motorist_telnyx_claim_webhook_event`, `motorist_session_lease_acquire`/`_release`, `motorist_reserve_operator` and `motorist_advance_ring_step` are all `SECURITY DEFINER` with `search_path = ''`, revoked from `public`/`anon`/`authenticated` and granted to `service_role` only. They exist because PostgREST cannot hold a transaction across the TypeScript reducer, so serialization and atomic claims must live inside single statements.

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
- `motorist_sms_messages`: canonical outbound SMS row (`provider = 'telnyx_sms'`), provider message id, delivery state, body template reference, idempotency and retry fields.
- `motorist_sms_attempts`: one audit row per provider send attempt, with sanitized request/response payload, provider status, error class and retry timing.
- `motorist_integration_raw_events`: append-only raw provider payload log. This is the first write target for fleet syncs and transcript processing before normalizing into operational tables.

### Runtime

- `motorist_job_controls`, `motorist_job_runs`, `motorist_job_incidents`, `motorist_worker_status`: job runtime ledger for manual one-shot jobs and the cron; `motorist_worker_status.last_webhook_at` records the freshness of the provider webhook stream. Telephony uses the job control rows `telephony.ring.sweep`, `telephony.sessions.stuck`, `telephony.ledger.prune` (seeded disabled) and `telephony.telnyx.reconcile`, and raises incidents under `telephony.telnyx.webhook|commands|actions`.

### Audit

- `motorist_audit_log`: actor, action, entity, before/after payload references, source, IP/user-agent where available.

Audit must cover case changes, call-to-case linking, SMS sends, recording access, integration setting changes, branch/fleet changes, and security-sensitive admin actions.

## Retention

- `motorist_telnyx_webhook_events`: `processed` rows are deleted after 30 days and the `payload` of high-volume, low-value events (`call.playback.*`, `call.speak.*`, `call.cost`) is nulled after 7 days, by the `telephony.ledger.prune` job on the 5-minute cron.
- `motorist_calls.raw_latest_payload` is nulled after 30 days and `motorist_call_events.raw_payload` after 90 days.
- These payloads contain caller numbers, so retention is a GDPR Art. 5(1)(e) storage-limitation control rather than housekeeping. Recording and transcripts stay disabled for the Telnyx rollout.

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

Call session states (`motorist_call_sessions.state`): `received`, `greeting`, `ivr`, `ringing`, `talking`, `held`, `consulting`, `conference`, `parked`, `waiting`, `wrap_up`, `after_hours`, `callback_offered`, `missed`, `failed`, `ended`. `motorist_calls.status` is derived from the session state and direction; terminal call statuses are never overwritten.

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
- This copy's database was created empty for the Telnyx rollout, so the kept migrations were edited in place during the provider swap (`provider_session_id`, `telnyx`/`telnyx_sms` provider values, no PBX extension tables). From Phase 1 onward, add new timestamped migrations instead of editing applied ones.
- Regenerate `src/lib/supabase/database.types.ts` after every schema change and keep repository mappings, domain types and tests in sync.
