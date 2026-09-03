# Telnyx data contract (stub)

This copy of the dispatch app replaces the previous telephony provider with Telnyx Call Control, Telnyx WebRTC and Telnyx Messaging. The authoritative design (state machine, webhook contract, ring plans, table definitions, phase plan) is maintained outside the repository in the owner's approved plan; this file records only the contract the code depends on. No secrets or personal data belong here.

## Status

- Phase 0 (done): previous provider removed; telephony UI in "Telefónia nie je nakonfigurovaná" mode; schema and types provider-neutral (`provider_session_id`, providers `telnyx` / `telnyx_sms`); `SmsTransport` seam with `notConfiguredTransport`.
- Phase 1: infrastructure, `getTelnyxConfig()`, `scripts/assert-target-project.mjs`, Vercel cron.
- Phase 2: core telephony (webhook ledger, call sessions/legs, ring plans, presence, PhoneBar, SMS transport).
- Phases 3-5: configuration UI, IVR/callbacks/conference/park/supervision/wallboard, hardening.

## Identifiers

- `provider_session_id` on `motorist_calls`, `motorist_call_events` and `motorist_call_recordings` carries the Telnyx `call_session_id`. It is the only correlation key across legs and events.
- `provider_call_id` on `motorist_calls` carries the customer leg `call_control_id`.
- Phone numbers are stored in the canonical E.164 string returned by `GET /v2/phone_numbers` and normalised on every inbound `to`/`from`.
- Every Telnyx command carries a deterministic `command_id` (`uuidv5(sessionId|legId|step|intent)`); every persisted row is an upsert on a natural key.

## Routes (Phase 2)

- `POST /api/telephony/telnyx/webhook` and `POST /api/sms/telnyx/webhook`: public, Ed25519 signature over `${timestamp}|${rawBody}` (tolerance 300 s), claim ledger before processing, control events always return 200 after compensation.
- `POST /api/telephony/webphone/token`, `POST /api/telephony/devices/heartbeat`, `GET/POST /api/telephony/presence`: session-guarded, one active device per operator enforced server-side.
- `POST /api/telephony/calls` and `POST /api/telephony/calls/[id]/{hold,unhold,transfer,consult,complete-transfer,cancel-consult,park,pickup,hangup}`: session-guarded, same-origin, rate-limited, kill-switch checked.
- `GET /api/telephony/cron`: bearer `CRON_SECRET`, invoked by the single Vercel cron every 5 minutes.

All routes are registered in `src/server/route-auth-registry.ts`; `route-auth.test.ts` and `route-csrf.test.ts` enforce it.

## Tables added by the Telnyx migrations

`motorist_telnyx_webhook_events` (claim ledger, service-role only), `motorist_call_sessions`, `motorist_call_legs`, `motorist_ring_groups`, `motorist_ring_group_members`, `motorist_ring_plans`, `motorist_ring_plan_steps`, `motorist_ring_attempts`, `motorist_business_hours` (+ intervals, exceptions), `motorist_ivr_menus` (+ options), `motorist_callback_requests`, `motorist_operator_devices`, `motorist_operator_presence`, `motorist_pause_reasons`, `motorist_operator_telephony_settings`, `motorist_telephony_settings` (database kill switches), `motorist_telephony_daily_usage`. `motorist_telephony_lines` is extended with `telnyx_number_id`, `partner_name`, `ring_plan_id`, `ivr_menu_id`, `business_hours_id`, `environment`.

## Environment

See the `TELNYX_*` block in `.env.example`. Preview and `dev` use the dev resources, `main` the production resources listed in [`operations/telnyx-setup.md`](./operations/telnyx-setup.md). `TELNYX_LIVE_CALLS_ENABLED` and `TELNYX_SMS_LIVE_SENDS` default to `false` and fail closed.
