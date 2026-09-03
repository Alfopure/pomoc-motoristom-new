# Telnyx data contract

This copy of the dispatch app runs telephony on Telnyx Call Control (voice), Telnyx WebRTC (browser phone) and Telnyx Messaging (outbound SMS). There is no listener process and no command outbox: Vercel route handlers receive signed webhooks, reduce them into a call state machine and issue REST commands synchronously.

This file is the contract the code depends on — webhook handling, event classes, the state machine, the routing tables, command identity and retention. Operational procedures live in [`operations/telnyx-runbook.md`](./operations/telnyx-runbook.md); resource identifiers in [`operations/telnyx-setup.md`](./operations/telnyx-setup.md). No secrets and no personal data belong in either file.

## Status

- Phase 0 (done): previous provider removed; telephony UI in "Telefónia nie je nakonfigurovaná" mode; schema and types provider-neutral (`provider_session_id`, providers `telnyx` / `telnyx_sms`); `SmsTransport` seam with `notConfiguredTransport`.
- Phase 1 (done): infrastructure, `getTelnyxConfig()`, `scripts/assert-target-project.mjs`, Vercel cron, pre-recorded Slovak prompts in `public/telephony/`.
- Phase 2 (this document): webhook pipeline, call sessions/legs, ring plans, business hours, IVR entry, presence and devices, browser phone (PhoneBar), waiting room, hold/transfer/park, SMS transport, Realtime broadcast.
- Phases 3-5: configuration UI, callbacks/conference/supervision/wallboard, hardening (chaos tests, health endpoint, reconciliation).

## Identifiers and correlation

- `motorist_call_sessions.telnyx_session_id` and `provider_session_id` on `motorist_calls` / `motorist_call_events` / `motorist_call_recordings` carry the Telnyx `call_session_id`. It is the only correlation key across legs and events.
- `motorist_call_legs.telnyx_call_control_id` is the leg key. Every leg write is an upsert on that column, because the REST response and the `call.initiated` webhook race; whichever arrives first creates the row, the other one patches it.
- `motorist_calls.provider_call_id` carries the customer leg `call_control_id`.
- Leg ownership (session id, role, operator) is read from `client_state`, never from row order. `client_state` is base64 JSON with one-letter wire keys and stays under the 200-byte Telnyx budget: `s` session id, `r` role, `o` operator profile id, `p` ring step, `i` intent, `a` auto-answer.
- Phone numbers are stored canonically (`+421232408718`). The first purchased DID is stored by Telnyx with an extra leading zero (`+4210232408700`), so every inbound `to`/`from` goes through `normalizeE164()` (`src/server/telephony/phone/normalize-e164.ts`) before a line lookup.

## Webhook contract

Route: `POST /api/telephony/telnyx/webhook` (`runtime = "nodejs"`, `dynamic = "force-dynamic"`, `maxDuration = 10`). SMS delivery statuses use `POST /api/sms/telnyx/webhook`. Both are `public` in `src/server/route-auth-registry.ts`; the signature is the authentication.

1. `const raw = await request.text()` before any parsing.
2. Verify `telnyx-signature-ed25519` over `${telnyx-timestamp}|${raw}` with the Ed25519 public key (`TELNYX_PUBLIC_KEY`, raw 32-byte key base64; the verifier prepends the SPKI DER prefix). Tolerance 300 s. Failure → `400`.
3. `TELNYX_PUBLIC_KEY` missing or `getTelnyxConfig().configured === false` → `503` with the Slovak not-configured message. Nothing can be verified, so the request is not labelled forged.
4. Reject events whose `payload.connection_id` is neither `TELNYX_CALL_CONTROL_APP_ID` nor `TELNYX_CREDENTIAL_CONNECTION_ID` of this environment → `200 {outcome: "unverified_connection"}`.
5. **Claim, not insert.** `motorist_telnyx_claim_webhook_event(...)` upserts the ledger row and returns `claimed` (we own it), `duplicate` (already `processed` → return 200 at once) or `busy` (another invocation holds a claim younger than 30 s → return 200 without processing). A `failed` or stale `queued` row is reclaimed, so retries are a real recovery path. The RPC also returns `event_claimed_at`; the closing `processed`/`failed` update is scoped to that stamp, so an invocation whose claim was taken over cannot release the new owner's claim.
6. Acquire the per-session lease (`motorist_session_lease_acquire`, TTL 4 s, 50-150 ms jittered retries for at most 3 s), run the reducer, persist under a `version` CAS (retry budget 20), release the lease. The lease is renewed before every dial of a ring fan-out, which can otherwise outlive its TTL.
7. Sweep at most `INLINE_SWEEP_LIMIT` (2) other overdue sessions, and only within `INLINE_SWEEP_BUDGET_MS` (4 s) of the event's own start, so the sweep can never consume the route's `maxDuration = 10`. The exhaustive pass belongs to `/api/telephony/cron`.
8. Structured log per event: `{eventId, type, sessionId, verified, claim, ms, commands[]}`.

Failover: the Call Control application's failover URL points at the same route on the project's `*.vercel.app` alias. Double delivery is safe because of the claim.

### Event classes

| Class | Types | Handling |
| --- | --- | --- |
| Control | `call.initiated`, `call.answered`, `call.bridged`, `call.hangup`, `call.gather.ended`, `call.playback.ended`, `call.dtmf.received`, `call.hold`, `call.unhold`, `call.refer.*`, `conference.created`, `conference.ended`, `conference.participant.joined`, `conference.participant.left` | Processed synchronously. Commands are best-effort with compensation (failed `answer` → `hangup`; failed fan-out → next step or fallback; failed `bridge` → hang up the operator leg, customer to `waiting`). The route answers **200** once the event was attached to a session and compensation was attempted, writes `status='failed'` + `error` to the ledger and raises a `motorist_job_incidents` row; Telnyx retries are not a real-time recovery path (`first_command_timeout_secs: 20` would already have torn the call down). A failure *before* the session exists (session lookup, `call.initiated` session creation) answers **500** instead: nothing was issued yet and the redelivery a few seconds later is the only thing that can rescue the call. |
| Bookkeeping | `call.cost`, `call.speak.*`, `call.playback.started`, `message.*`, unknown types | May answer 500 so Telnyx retries; the claim semantics make reprocessing safe. |

App intents (`hold`, `unhold`, `park`, `pickup`, `blind_transfer`, `consult`, `complete_transfer`, `cancel_consult`, `hangup`, `sweep`) enter the same reducer as `{kind: "app"}` events, so an operator action and a webhook are serialised by the same lease.

### Command identity

Every Telnyx command carries `command_id = uuidv5("<sessionId>|<legId>|<step>|<intent>")` under a fixed namespace (`src/server/telephony/telnyx/command-id.ts`). Intents in use: `answer`, `bridge`, `bridge:own`, `bridge:rejoin`, `dial:outbound`, `dial:internal`, `dial:consult`, `dial:pickup`, `ring`, `hangup`, `playback:greeting`, `playback:moh`, `playback:all_busy`, `playback:callback_confirmed`, `playback_stop`, `gather_stop`, `transfer`, `conference:create`, `conference:join`, `conference:leave*`, `conference:hold*`, `conference:unhold*`. A retried webhook therefore replays the same command id and Telnyx deduplicates it.

Every DB write is an upsert on a natural key: legs on `telnyx_call_control_id`, ledger on `event_id`, call events on `event_fingerprint = event_id`, ring attempts on `(session_id, step_index, profile_id | external_number)` (a `23505` means the operator already has an open offer elsewhere and is skipped).

## Call state machine

`motorist_call_sessions.state`, reducer in `src/server/telephony/state/transitions.ts` (pure) and `effects.ts` (persistence + commands).

| State | Entered by | Actions |
| --- | --- | --- |
| `received` | `call.initiated` on one of our DIDs (`to` normalised first) | `answer` with `client_state {sid, role:"customer"}`; upsert session + customer leg; `findCallerMatches` → `metadata.match` |
| `greeting` | customer `call.answered` | business-hours lookup; closed → `after_hours`; line has an IVR menu → `ivr`; otherwise ring step 0 |
| `ivr` | `call.gather.ended` | `gather_using_audio` with the pre-recorded Slovak prompt (`maximum_tries`, `invalid_audio_url` delegated to Telnyx); digit → option; no valid digit → the line's default ring plan |
| `ringing` | plan advance (guarded) | MOH on the customer leg; fan-out per eligible member; `motorist_ring_attempts` rows |
| `talking` | first operator `call.answered` + successful reservation | stop MOH; `bridge`; hang up the losing legs; presence `on_call`; write `motorist_calls` |
| `held` | `POST …/hold` | promote to a conference if needed; `conferences/{id}/actions/hold {call_control_ids, audio_url}`; unhold reverses |
| `consulting` | attended transfer start | promote; customer held; dial the target with `link_to`; on answer `join` (3-way) or operator `leave` (completes the transfer) |
| `conference` | add-party / supervision (Phase 4) | promote; dial with `link_to`; `join` on answer |
| `waiting` / `parked` | IVR wait, overflow, operator park, lost operator leg | customer leaves the conference (or is unbridged); the music is one detached `playback_start {loop: "infinity"}` and the state machine's heartbeat is a separate silent `gather {timeout_millis: MOH_TICK_TIMEOUT_MS = 60 s}`, so re-arming the tick never interrupts the audio (the sweeper re-arms after `WAITING_TICK_STALE_MS` = 2 ticks, min 90 s); the row appears in the čakáreň; pickup dials the picker's WebRTC leg and bridges; after `park_max_minutes` the callback prompt replaces the indefinite park |
| `after_hours` | greeting outside business hours | after-hours prompt as the callback gather in one round trip |
| `callback_offered` | caller pressed 1 | `motorist_callback_requests` row + confirmation prompt + `hangup` |
| `missed` | all steps exhausted, or the customer hung up while ringing | plan fallback; callback task; remaining legs cancelled |
| `wrap_up` | customer `call.hangup` while `talking` | presence `after_call_work` until `wrap_up_until`; "ukončiť wrap-up" endpoint |
| `ended` | last leg `call.hangup` | finalise `motorist_calls` (`duration_seconds`, `wait_seconds`, `end_reason`) |
| `failed` | unrecoverable command failure | compensation ran; incident row written |

Transitions are defined on leg rows (`answered_at`, `bridged_at`, `ended_at`), so an out-of-order `call.bridged` before `call.answered` is still safe.

Bridging asymmetry: inbound calls bridge **from the customer leg** with `park_after_unbridge: "self"`, so an operator drop parks the customer in the waiting room; outbound and internal calls bridge from the operator leg at dial time with `play_ringtone` (`cz`).

Lazy conference: an ordinary two-party call is bridged only. The session is promoted to a Telnyx conference (`name: "sess-<session_id>"`) on the first hold, attended transfer, add-party, park or supervise. Promotion runs **on the operator leg** (`conference_create` there, `conference_join` for the customer): creating the conference ends the bridge, and `park_after_unbridge: "self"` protects only the leg that carries it — the customer. Promoting from the customer side would risk hanging up the operator's WebRTC leg, which no compensation could restore. "Already exists" → look up by name and `join`. Any other error leaves the call bridged, the PhoneBar shows the degraded chip and the action is refused; the conversation continues.

Every leg the app creates carries `time_limit_secs = LEG_TIME_LIMIT_SECS` (4 h). It is a backstop for the one case the app cannot clean up itself: a `POST /v2/calls` whose HTTP response times out while Telnyx did create the leg, so its `call_control_id` is never learnt. Such a leg is also hung up by the reducer as soon as any webhook for it arrives (its `client_state.sid` points at a session that is already terminal).

### `motorist_calls.status` derivation

`callStatusForSession(state, direction, answered_at)`: `received|greeting|ivr|after_hours|callback_offered` → `incoming` (inbound) / `outbound`; `ringing` → `ringing_agent` (inbound) / `outbound`; `talking|held|consulting|conference|parked` → `answered`; `waiting` → `answered` once `answered_at` is set, otherwise `incoming`/`outbound`; `missed` → `missed`; `failed` → `failed`; `wrap_up|ended` → `ended` when answered, otherwise `missed` for inbound. Terminal statuses (`missed`, `abandoned_queue`, `ended`, `failed`) are never overwritten.

### `motorist_call_sessions.metadata`

Free-form JSON companion to the typed columns (`SessionMeta` in `src/server/telephony/state/types.ts`). Keys in use: `match` (top `CallerMatch`, count, degraded flag), `ring` (frozen `plan`, `mode`, `active_step`, `step_started_at`, `step_deadline_at`, `exhausted`, `fallback`), `outbound`, `internal`, `transfer`, `consult`, `callback`, `hangup`, `conference`, `park`, `ivr`, `after_hours`, `pickup`, `waiting` (`since`, `reason`, `ticks`, `last_tick_at`), `line_label`, `partner_name`.

`current_step` counts **started** steps: starting step *k* runs `motorist_advance_ring_step(sid, k)` and the winner sets `current_step = k + 1`. The index of the step that is actually ringing is `metadata.ring.active_step`. This gives one uniform CAS guard, step 0 included.

## Ring plans, groups, eligibility

Configuration tables (org-scoped, member-readable, manager/admin writable):

| Table | Shape |
| --- | --- |
| `motorist_telephony_lines` | DID ↔ `ring_plan_id`, `ivr_menu_id`, `business_hours_id`, `telnyx_number_id`, `partner_name`, `environment`, `active`; unique `(organization_id, phone_number)` |
| `motorist_ring_plans` | `fallback_kind` `external_number|waiting_room|callback_prompt|hangup_message`, `fallback_number` |
| `motorist_ring_plan_steps` | `step_index`, `ring_group_id`, `timeout_secs` (5-120), `strategy` `all|ordered` |
| `motorist_ring_groups` / `motorist_ring_group_members` | `member_kind` `operator|external_number`, `profile_id`, `external_number`, `position`, `ring_secs` (5-120, null → step timeout), `last_offered_at`, `last_answered_at` |
| `motorist_ring_attempts` | `(session_id, step_index, member)` with `result` `pending|offered|answered|no_answer|skipped_offline|busy|cancelled|failed` |
| `motorist_business_hours` (+ `_intervals`, `_exceptions`) | `Europe/Bratislava`, several intervals per weekday (lunch break, split shift), date exceptions with `closed` or replacement intervals |
| `motorist_ivr_menus` / `motorist_ivr_options` | `digit`, `action`, `target_ring_plan_id`, `target_number`, `label`, `prompt_media_url`, `tts_text` |
| `motorist_telephony_settings` | one row per org: `live_calls_enabled`, `sms_live_sends`, `daily_leg_soft_cap`, `park_max_minutes`, `destination_allowlist`, `max_ring_fanout`, `max_concurrent_legs` |

- `materialiseRingPlan()` **freezes** the plan into `metadata.ring.plan` at ring start and `enterWaiting()` freezes `park_max_minutes` into `metadata.waiting.max_minutes`; configuration edits never alter a live call.
- Strategy `all` dials every eligible member at once for `step.timeout_secs`. Strategy `ordered` dials one member at a time in `position` order, each for `max(5, member.ring_secs ?? step.timeout_secs)`; the step ends when the list is exhausted.
- Eligibility: `external_number` members are always eligible (coverage of last resort when every browser is closed). Operators need `presence.status = 'available'` (or `after_call_work` past `wrap_up_until`), `device_seen_at` within 120 s and no open `offered|answered` attempt. The real liveness truth is the dial result: an immediate `call.hangup` with `USER_NOT_REGISTERED`/`UNALLOCATED_NUMBER` marks the attempt `skipped_offline` and does not consume step time.
- Atomic reservation: `motorist_reserve_operator(profile_id, session_id)` CAS-updates `motorist_operator_presence` to `on_call`; 0 rows → hang that leg up immediately and mark the attempt `cancelled`. The RPC is re-entrant for the session that already holds the reservation, because a lost `version` CAS makes the runner re-run the guard. A partial unique index on `motorist_ring_attempts (profile_id) where result = 'offered'` guarantees one open offer per operator.
- Caps: `MAX_RING_FANOUT` 8 per step, `MAX_CONCURRENT_LEGS` 9 per organisation (both overridable per organisation in `motorist_telephony_settings`). The concurrent-leg count includes the caller's own leg, so `max_concurrent_legs` must stay ≥ `max_ring_fanout + 1` (and ≥ 2); validation refuses anything lower, because at 1 no phone can ever ring. Only legs started in the last 4 hours count. When no capacity is left the step stays armed and is re-checked every `CAPACITY_RETRY_SECS` (5 s) for at most `CAPACITY_WAIT_MAX_MS` (30 s) before the plan moves on; reaching the cap opens a `telephony.routing.capacity` incident.
- Billing counters: every dial writes `motorist_telephony_daily_usage.legs` and every SMS `sms_count` (RPC `motorist_telephony_usage_add`). Operator-initiated legs (click-to-call, internal call, PSTN transfer/consult target) are refused with 429 once `legs >= daily_leg_soft_cap`; inbound routing is never blocked by it.
- Sweeper triggers: end of every webhook, `GET /api/telephony/calls/active` (throttled to one sweep per 5 s per instance), Telnyx-driven MOH gather ticks on unbridged customer legs, and the 5-minute Vercel cron.

## Database RPCs

All `SECURITY DEFINER`, `search_path = ''`, revoked from `public`/`anon`/`authenticated`, granted to `service_role`.

| RPC | Contract |
| --- | --- |
| `motorist_telnyx_claim_webhook_event(p_event_id, p_event_type, p_payload, …, p_stale_after_ms := 30000)` | `outcome` `claimed|duplicate|busy`, plus `event_status`, `event_attempts`, `event_claimed_at` |
| `motorist_session_lease_acquire(p_session_id, p_token, p_ttl_ms := 4000)` | boolean; re-entrant for the same token |
| `motorist_session_lease_release(p_session_id, p_token)` | boolean |
| `motorist_reserve_operator(p_profile_id, p_session_id)` | boolean (CAS on presence); re-entrant for the session that already holds it |
| `motorist_telephony_usage_add(p_organization_id, p_day, p_legs, p_minutes, p_sms)` | integer (new `legs` value); atomic upsert of `motorist_telephony_daily_usage` |
| `app_private.motorist_normalize_e164(p_value, p_default_cc := '421')` | text; trigger `motorist_telephony_lines_normalize` keeps `phone_number` canonical |
| `motorist_advance_ring_step(p_session_id, p_expected_step)` | boolean (CAS on `current_step`) |
| `motorist_replace_ring_plan(p_organization_id, p_document, p_expected_version)` | jsonb (`{groups,plans,business_hours,pause_reasons}` counts plus the new `routing_version`); transactional replace of the routing-configuration sections present in the document, under an advisory lock, refusing a stale version (`stale_document`). The two-argument form is gone: while the migrations are not applied PostgREST answers `PGRST202` and the service maps it to a 503 that names the missing migration. |

`motorist_replace_ring_plan` is the write path of the Phase 3 configuration screens. A section absent from the document is left untouched; members and steps are deleted and re-inserted (their positions are unique, so an in-place swap would trip the constraint) while `last_offered_at`/`last_answered_at` travel with the member id. Deleting a group a surviving step still uses, a plan a line or an IVR option still points at, or business hours a line still uses aborts the transaction (`ring_group_in_use`, `ring_plan_in_use`, `business_hours_in_use`), and a row id owned by another organisation aborts with `cross_organization`. Document validation (at least one step per plan, timeouts 5–120 s, member ring seconds ≥ 5 s, no empty group in a plan, contiguous positions, row ids unique across the whole payload, E.164 members inside `destination_allowlist`, an open business-hours exception needs at least one interval, pause length ≤ 480 min, no cross-organisation reference) runs in `src/server/telephony/config-service.ts` before the RPC is called; a section over its size cap is refused before the payload is mapped at all; every applied change writes a `motorist_audit_log` row with a compact diff. A call in progress is never affected — its plan is frozen by `materialiseRingPlan` at call start.

## Browser phone auto-answer

An invite is answered without operator action when it is the operator leg of a dial this tab started. The discriminator is `telnyxIDs.telnyxCallControlId` against the legs recorded by `expectOperatorLeg()`; because the SIP invite usually beats the route response, the currently ringing call is re-evaluated whenever a new expected leg is registered. Server-initiated legs (pickup) return their `operatorLegCallControlId` in the action response, so they are correlated the same way. The `X-PM-Auto-Answer: 1` invite header is only a tiebreaker: it may decide when this tab has exactly one outstanding leg it asked for whose id has not arrived yet, and never answers on its own (it carries no session identity). Everything else rings.

## Realtime

`app_private.motorist_broadcast_telephony_change()` fires `realtime.broadcast_changes` from row triggers on `motorist_call_sessions`, `motorist_call_legs` and `motorist_operator_presence` to the private topic `org:<organization_id>:telephony`. On `motorist_call_sessions` the UPDATE trigger carries a `WHEN` clause that ignores lease-only writes (`lease_token`, `lease_until`, `updated_at`, `version`), which otherwise rang the doorbell three times per processed webhook; the same `WHEN` clause keeps `updated_at` from being refreshed by the lease, so the stale-session safety net can still see real inactivity. A `realtime.messages` select policy authorises `authenticated` through `app_private.motorist_is_org_member(split_part(realtime.topic(), ':', 2)::uuid)`; the uuid cast is guarded by a regex so a foreign topic cannot raise.

The browser calls `supabase.realtime.setAuth(accessToken)` on session load and refresh, subscribes once per browser per organisation (`src/lib/telephony/realtime-client.ts`) and refetches `calls/active` on every message. When the channel is connected the poll cadence relaxes to 3 s visible / 10 s hidden; on `CLOSED|CHANNEL_ERROR|TIMED_OUT` it falls back to the fast polling table and reopens with jittered backoff. Polling alone is always sufficient; Realtime is only a latency optimisation.

## Routes

| Route | Auth | Notes |
| --- | --- | --- |
| `POST /api/telephony/telnyx/webhook` | `public` | Ed25519 signature, claim ledger |
| `POST /api/sms/telnyx/webhook` | `public` | Ed25519 signature; monotone delivery-status ranking |
| `GET /api/telephony/cron` | `bearer CRON_SECRET` | ring sweep (plus orphan-leg and leaked ring-offer cleanup), stuck-session detection, ledger prune |
| `POST /api/telephony/webphone/token` | `session` | mints a short-lived WebRTC JWT, rotates `device_session_id`; refuses with `409` while the current device is live and its operator is `ringing`/`on_call`, unless the body carries `{"takeover": true}` or the tab's own `{"deviceSessionId": …}` (a scheduled refresh of its own credential is never a takeover). A `409` while already registered keeps the socket and retries the renewal; the PhoneBar offers "Prevziať telefón" for the terminal `failed`/`superseded` statuses |
| `POST /api/telephony/devices/heartbeat` | `session` | stale `device_session_id` → `409`, the tab disconnects; a `registrationState: "unregistered"` beacon (sent on `pagehide`) clears `device_seen_at` so the ring plan stops allocating steps to a closed tab |
| `GET/POST /api/telephony/presence`, `POST /api/telephony/presence/end-wrap-up` | `session` | presence + pause reasons; mirrored into `motorist_operator_statuses` |
| `POST /api/telephony/calls`, `POST /api/telephony/calls/internal` | `session` | click-to-call / colleague call; kill switch, rate limit 10/min per operator, destination allowlist |
| `GET /api/telephony/calls/active` | `session` | console snapshot (calls, waiting room, presence, `organizationId`); also sweeper trigger (b): throttled to one pass per 5 s per instance, bounded by `ACTIVE_SWEEP_LIMIT`/`ACTIVE_SWEEP_BUDGET_MS` and run **after** the snapshot so it can never delay the poll |
| `POST /api/telephony/calls/[id]/{hold,unhold,park,pickup,transfer,consult,complete-transfer,cancel-consult,hangup}` | `session` | shared guard: same-origin → actor → not-configured → action |
| `GET /api/telephony/calls/[id]/transfer-targets` | `session` | colleagues + external targets |
| `POST /api/telephony/dev/simulate-inbound` | `session`, admin | non-production only; injects a synthetic `call.initiated`/`call.answered` |

Every mutation route calls `assertSameOriginRequest` **before** authentication, and every route is registered in `src/server/route-auth-registry.ts`; `src/app/api/route-auth.test.ts` and `route-csrf.test.ts` enforce both. Mute and DTMF are browser-side (`@telnyx/webrtc`) and have no routes.

Degraded mode: when `getTelnyxConfig().configured === false`, every telephony session route answers `503` with the Slovak not-configured message (after the session guard, so anonymous callers still get `401`/`403`) and the UI shows the notice. A configured-but-switched-off stack answers `423` instead ("Živé hovory sú vypnuté (kill switch)." / "Odosielanie SMS je vypnuté (kill switch).").

## SMS

`resolveSmsTransport()` returns the Telnyx transport whenever `TELNYX_API_KEY` exists, otherwise `notConfiguredTransport`. Sends go to `POST /v2/messages {from: TELNYX_SMS_ALPHA_SENDER, to, text, messaging_profile_id}` with an `Idempotency-Key` header; `motorist_sms_messages.idempotency_key` is unique and remains the audit link. `preflight(to)` runs before any row is inserted — kill switches, the destination allowlist and the rate limit (peeked, not consumed) — so a blocked send leaves no audit rows. The alphanumeric sender is one-way: inbound `message.received` events are acknowledged as `not_applicable` and the composer shows a Slovak notice that replies must be handled by phone.

The transport re-checks both guards before the HTTP call (second line of defence): the recipient must pass the same `destination_allowlist` as a voice destination (403 otherwise) and the organisation may send at most `SMS_RATE_LIMIT` (20) messages per minute (429; the limiter is consumed here, not in `preflight`). A delivered send increments `motorist_telephony_daily_usage.sms_count`.

## Retention

| Data | Policy |
| --- | --- |
| `motorist_telnyx_webhook_events` | `processed` rows deleted after 30 days; `payload` nulled after 7 days for `call.playback.*`, `call.speak.*` and `call.cost`. Job `telephony.ledger.prune` in `motorist_job_controls`, run by the 5-minute cron; seeded **disabled**, so the cron reports `disabled` until it is enabled. |
| `motorist_calls.raw_latest_payload` | emptied after 30 days (Phase 5 job). The column is `jsonb not null default '{}'` (inherited from the foundation schema), so the job writes `'{}'::jsonb`, not `NULL`. |
| `motorist_call_events.raw_payload` | emptied after 90 days (Phase 5 job) with the same `'{}'::jsonb` contract — GDPR Art. 5(1)(e) storage limitation, see [`data-model.md`](./data-model.md). |
| Recordings / transcripts | Recording stays disabled for the Telnyx rollout; the tables exist but are not populated. |

The ledger holds caller numbers inside raw payloads, so the prune job is the data-minimisation control, not a housekeeping nicety.

## Environment

See the `TELNYX_*` block in `.env.example`. Preview and `dev` use the dev Call Control application, credential connection, voice profile and messaging profile; `main` uses the production ones ([`operations/telnyx-setup.md`](./operations/telnyx-setup.md)). `TELNYX_LIVE_CALLS_ENABLED` and `TELNYX_SMS_LIVE_SENDS` default to `false`, are ANDed with `motorist_telephony_settings.live_calls_enabled` / `sms_live_sends`, and a missing settings row means "off".
