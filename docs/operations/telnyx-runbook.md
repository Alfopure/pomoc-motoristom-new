# Telnyx operations runbook

Operational procedures for the telephony stack of this copy of the dispatch app. The contract the code implements is in [`../telnyx-data-contract.md`](../telnyx-data-contract.md); resource identifiers are in [`telnyx-setup.md`](./telnyx-setup.md).

Rules that apply to every procedure below:

- Never touch the original production project (Supabase `sjcsrygkkmersoczpunh`, Vercel `pomoc-motoristom-dispecing`, `dispecing.linkapomoci.sk`).
- Secrets stay in Vercel environment variables and the owner's private notes. Never paste an API key, SIP password or WebRTC token into a document, a commit or a ticket.
- Live calls and live SMS cost money and reach real people. Both kill switches are `false` by default; flip them on immediately before a test and back off afterwards.
- Applying a Supabase migration or seed is a separate, explicitly requested operation against this copy's project (`ifpaeegaesdmljfkdvcn`) only.
- **The settings screens ("Nastavenia → Telefonovanie") must not be reachable on a database without migrations `20260918100000_ring_config_rpc.sql` and `20260919100000_telnyx_phase3_fixes.sql`.** Until both are applied, `motorist_replace_ring_plan(uuid, jsonb, integer)` does not exist (every configuration save answers 503 with a message naming the migration) and the foundation policies still let any organisation member `PATCH` the routing tables straight through PostgREST — a dispatcher could repoint a production number and a manager could flip the admin-only kill switches, with no validation, no transaction and no audit row. Verify after applying:

```sql
-- 1 row, three arguments
select p.oid::regprocedure from pg_proc p
 where p.proname = 'motorist_replace_ring_plan';
-- must be empty: no write privilege for the session roles on the routing tables
select table_name, grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon', 'authenticated')
   and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
   and table_name like 'motorist_ring%' or table_name in
     ('motorist_business_hours', 'motorist_business_hours_intervals', 'motorist_business_hours_exceptions',
      'motorist_ivr_menus', 'motorist_ivr_options', 'motorist_pause_reasons',
      'motorist_operator_telephony_settings', 'motorist_telephony_settings', 'motorist_telephony_lines');
-- must list only `select` policies for those tables
select tablename, policyname, cmd from pg_policies where schemaname = 'public' and tablename like 'motorist_%';
```

## 1. Spikes to run against the real account

Time-boxed verifications that cannot be done offline. Record the outcome (date, session id, result) in this section after each run.

### S1 — `telnyxIDs` correlation on the inbound WebRTC invite

**Why.** Auto-answer of an outbound click-to-call depends on the browser being able to tell *which* incoming WebRTC invite belongs to the leg the server just dialled. The primary discriminator is `call.telnyxIDs.telnyxCallControlId` matching the `operatorLegCallControlId` returned by `POST /api/telephony/calls`; the `X-PM-Auto-Answer` custom header is a nice-to-have.

**How.** Log in as an operator on the `dev` branch alias with `TELNYX_LIVE_CALLS_ENABLED=true` and `motorist_telephony_settings.live_calls_enabled=true`. Open the browser console, dial your own mobile from a case. In the `telnyx.notification` handler log `call.telnyxIDs` and `call.options.customHeaders` (the webphone exposes both on the SDK call object; `src/lib/telephony/telnyx-webphone.ts` already correlates on `telnyxCallControlId`).

**Pass criteria.** `telnyxIDs.telnyxCallControlId` is present on the invite and equals the value the route returned. Note separately whether custom headers survive to the SDK.

**If it fails.** `rememberExpectedLeg`/`matchExpectedLeg` fall back to a 90 s TTL window; auto-answer must then be replaced by an explicit "Prijať" click in the PhoneBar. Do not guess by caller number. The `X-PM-Auto-Answer` header is only a tiebreaker inside that window (it carries no session identity), so it cannot substitute for the id.

**Result.** _Not yet run._

### S6 — Conference promotion must not drop the operator leg

**Why.** Hold, consult, attended transfer, park and supervision all promote a bridged call to a conference. Creating a conference from a bridged leg ends the bridge, and Telnyx documents `park_after_unbridge: "self"` as the only thing that saves a leg when its bridge ends. Inbound calls are bridged **from the customer leg** with that flag, so the customer is protected and the operator is not — which is why the code creates the conference **on the operator leg** and joins the customer. This has to be confirmed against the real API before hold/consult are used in production: a compensation can restore database state, but it cannot resurrect a hung-up WebRTC leg.

**How.** On the `dev` alias with both kill switches on, take a real inbound call, press "Podržať", then "Pokračovať". Watch the PhoneBar and `motorist_call_legs` for the session.

**Pass criteria.** Both legs stay open (`ended_at is null`), the session reaches `held` and returns to `talking` on unhold, the operator hears the caller again and `motorist_job_incidents` gains no `telephony.telnyx.commands` row.

**If it fails** (the operator leg drops on promotion): add `hold_after_unbridge: true` (or `park_after_unbridge: "opposite"`) to the original bridge, and extend the `conference_create` compensation with a re-dial of the operator leg instead of the database-only rollback. Until then, keep hold/consult off in production and use blind transfer.

**Result.** _Not yet run._

### S2 — Slovak TTS availability (secondary)

Pre-recorded Slovak prompts in `public/telephony/` are primary and are served from `TELNYX_MEDIA_BASE_URL`. TTS (`Azure.sk-SK-ViktoriaNeural`) is used only when that variable is unset. If TTS quality or availability is unacceptable, the answer is to fix the media base URL, not to change the code path.

**Result.** _Not yet run; not blocking._

### S3 — Caller-ID presentation on the first outbound call

**Status: done (2026-09-03).**

- `POST /v2/calls` with `from` = the first DID is rejected in both spellings (`+421232408700`, `+4210232408700`) with error `10010` "Unverified origination number". The malformed E.164 record Telnyx stores for that number breaks origination; **inbound on it still works**.
- `from = +421232408718` places calls normally. An outbound call to the owner's mobile rang and displayed `+421 2 324 087 18` correctly — no Local Calling and no porting needed for CLI presentation on this route.
- Decision: `TELNYX_DEFAULT_FROM_NUMBER = +421232408718`. Environment-only change; no code depends on which DID is the default.
- Follow-up: ask Telnyx support to correct the E.164 record of number ID `3040091148564563176`, or replace that number. Until then the first DID must not be used as an origination number anywhere (line configuration, operator default outbound line).

### S5 — EU data residency

**Why.** The account holder is an EU company handling Slovak callers' personal data; residency must be evidenced, not assumed.

**How.**
1. Confirm in writing from Telnyx: account data locality (the account is provisioned `DEU`), where call media is anchored, where webhook payloads and call events are stored, and where TTS processing happens if TTS is ever used.
2. Confirm the signed DPA and the sub-processor list.
3. Verify the anchorsite override (`Frankfurt, Germany`) on both the Call Control application and the credential connection.
4. After each production deploy, verify in the Vercel dashboard that the telephony route handlers really run in `fra1` (`vercel.json` pins `regions: ["fra1"]`, but a per-route override would be invisible in the code).
5. Confirm the Supabase project region is `eu-central-1`.

**Pass criteria.** Written provider confirmation on file, anchorsites set, `fra1` verified per route, no US region in the deployment inspector.

**Result.** _Anchorsites configured and the account is provisioned with `DEU` data locality; written confirmation and the DPA evidence are still outstanding._

## 2. Stuck call

A "stuck" session is one that is not in `ended`/`failed` and has had no leg event for a long time — usually a lost webhook, a cold-start timeout or a command that failed after the leg had already gone.

0. **Note.** Staleness is judged from `motorist_call_sessions.updated_at`, and the session lease deliberately does **not** refresh it (`20260917100000_telnyx_fixes_round2.sql`); the ring sweep additionally carries its pre-lease verdict into the `sweep` event. A `wrap_up`/`missed` session whose last leg webhook was lost is finalised by that path after `STALE_FINALISE_MS` (2 min).
1. **Detect.** The 5-minute cron job `telephony.sessions.stuck` reports sessions untouched for more than 15 minutes and pushes a synthetic `sweep` event through the reducer. `GET /api/telephony/cron` (bearer `CRON_SECRET`) returns the per-job summary; a `degraded` status means at least one job failed.
2. **Confirm the call is really gone.** Ask the operator, or check `GET /v2/calls/{call_control_id}` in the Telnyx portal. A parked customer in the čakáreň is *not* stuck: it is a supported state with a MOH gather tick every 60 s.
3. **Operator-side fix (preferred).** The owning operator (or a senior dispatcher) presses "Zložiť" in the PhoneBar, which posts `/api/telephony/calls/[id]/hangup`. This runs the normal reducer path and finalises `motorist_calls`.
4. **Provider-side fix.** If the leg still exists on Telnyx but the app has lost it, hang the leg up through the Telnyx portal or `POST /v2/calls/{call_control_id}/actions/hangup`. The resulting `call.hangup` webhook drives the session to `ended` by itself.
5. **Database-side fix (last resort).** Only when no leg exists anywhere: set the session to `ended` and finalise the call log. Never edit `motorist_call_legs` by hand while a leg is live — the reducer keys off leg timestamps.
6. **Root cause.** Look at `motorist_telnyx_webhook_events` for the session: `status='failed'` rows carry `error`; `attempts > 1` means Telnyx retried. Failed commands raise `motorist_job_incidents` rows under `telephony.telnyx.webhook|commands|actions`.

If several sessions are stuck at once, treat it as an outage: check the webhook URL, the deployment status and the Telnyx status page before touching individual calls.

## 3. Kill switches

Two independent layers, ANDed. Both must be on for a provider-affecting command; a missing settings row counts as off.

| Layer | Calls | SMS | Where |
| --- | --- | --- | --- |
| Environment | `TELNYX_LIVE_CALLS_ENABLED` | `TELNYX_SMS_LIVE_SENDS` | Vercel project env, per environment scope; requires a redeploy of that environment |
| Database | `motorist_telephony_settings.live_calls_enabled` | `motorist_telephony_settings.sms_live_sends` | one row per organisation; takes effect on the next request, no redeploy |

**Emergency stop (fastest path).** Set the database column to `false` for the organisation. Everything that *creates* a leg or a message (`dial`, `transfer`, `sendMessage`) starts answering `423` with the Slovak kill-switch message within one request; commands that only steer an existing call (`answer`, `hangup`, `bridge`, playback, gather and conference actions) stay allowed so an inbound call can still be answered and any live call can always be torn down.

Scope note: the calls switch does **not** block `answer`, so inbound calls are still picked up, greeted and routed while it is off — only outbound legs (including ring fan-out and transfers) are refused. A test that must reach an operator's phone therefore needs the switch **on**.

**Enabling for a live test.** Flip the environment variable for the target environment (only `dev`/Preview unless the owner asks for production), redeploy, then flip the database column. Turn both back off immediately after the test and record what was tested.

Note that `transfer` is gated by the calls switch as well, because a blind transfer creates a billable target leg.

## 4. Credential rotation

### Telnyx API key (`TELNYX_API_KEY`)

1. Create a second API key in the Telnyx portal (do not delete the old one yet).
2. Update `TELNYX_API_KEY` in the Vercel environment scopes that need it and redeploy.
3. Verify: log in, PhoneBar reaches "Registrované" (the token route uses the API key), and `GET /api/telephony/cron` is `ok`.
4. Delete the old key in the portal.

### Webhook public key (`TELNYX_PUBLIC_KEY`)

The value comes from `GET /v2/public_key`. It is account-wide and rarely changes. If it does: update the variable and redeploy **before** the old key stops being used, otherwise every webhook answers `400`. With the variable missing the routes answer `503`, not `400` — nothing can be verified, so nothing is labelled forged.

### Per-operator WebRTC credentials

Credentials live in `motorist_operator_devices` (one row per `(profile_id, environment)`) and are provisioned lazily on the first token request (`ensureOperatorCredential`). Tokens are short-lived JWTs; the browser refreshes at 50 % of the remaining lifetime and reconnects with a fresh token on a `401`.

- **Rotate one operator:** press „Nové prihlasovacie údaje" in Nastavenia → Telefonovanie → Operátori (or `POST /api/telephony/operators/{id}/credential { "rotate": true }`). The route mints a new credential, **deletes the superseded one at Telnyx** and revokes the browser session; the audit row carries both ids (`credentialId`, `revokedCredentialId`). A delete Telnyx refuses answers `502`: the old identity is then still registerable and has to be removed in the portal by hand.
- **Kick a stale tab:** issuing a new token rotates `device_session_id`; the previous tab's next heartbeat gets `409` and disconnects with a Slovak message. Only one active device per operator per environment is allowed. Note that this alone is cooperative — a tab that never sends the heartbeat keeps its registration until its token expires (24 h).
- **Departing employee:** press „Odpojiť telefón" (`POST /api/telephony/operators/{id}/disconnect`) and deactivate the profile. The disconnect deletes the Telnyx credential and clears `telnyx_credential_id`/`sip_username`, so no token minted earlier can re-register; the audit row records `deletedCredentialId`. If the response is `502`, delete the credential in the Telnyx portal before the profile is deactivated.

## 5. Adding a phone number (line)

1. Buy the number in Telnyx (Bratislava fixed line; SMS is not available on these numbers) and complete any regulatory requirement.
2. Assign it to the Call Control application of the target environment.
3. Read the canonical E.164 string and the number id from `GET /v2/phone_numbers`. Use the string exactly as returned — one existing number carries a spurious leading zero and the app normalises on read.
4. Insert a row into `motorist_telephony_lines`: `phone_number` (canonical), `telnyx_number_id`, `label`, `partner_name`, `ring_plan_id`, optionally `ivr_menu_id` and `business_hours_id`, `environment`, `active = true`. Unique on `(organization_id, phone_number)`.
5. Add the number to `docs/operations/telnyx-setup.md`.
6. Verify: an inbound call resolves to the right line label and partner name in the PhoneBar and in the call log. Use `simulate-inbound` (section 7) if the DID is not reachable yet.

Never point a new number at a Call Control application of another environment: the webhook rejects events whose `connection_id` does not belong to the environment, and the call would be dropped silently with `unverified_connection`.

**External escalation number in a ring group.** `supabase/seed.sql` and `scripts/seed-demo-data.mjs` ship the last member of "Dispečing B" with the placeholder `+421900000000`. A real mobile is personal data and must never be committed: set it directly on that row in the target project after seeding

```sql
update public.motorist_ring_group_members
   set external_number = '+421…'
 where id = '00000000-0000-4000-8000-000000002223';
```

and remember that re-running the seed does **not** overwrite it (`on conflict (id) do nothing`). While the placeholder is in place, that ring step simply fails to answer and the plan moves on to its fallback.

## 6. Raising caps

| Cap | Where | Default |
| --- | --- | --- |
| Daily spend, per-minute destination price, concurrency, destination whitelist | Telnyx outbound voice profile (one per environment) | prod 20 USD/day, concurrency 10, EU27; dev 2 USD/day, concurrency 4, SK+CZ |
| `max_ring_fanout` (legs dialled per ring step) | `motorist_telephony_settings` | 8 |
| `max_concurrent_legs` (per organisation, **includes the caller's own leg**, so it must stay ≥ `max_ring_fanout + 1`) | `motorist_telephony_settings` | 9 |
| `daily_leg_soft_cap` (enforced on operator-initiated legs) | `motorist_telephony_settings` | seeded value (500) |
| `park_max_minutes` (park guard before the callback prompt) | `motorist_telephony_settings` | 30 |
| `destination_allowlist` (dial prefixes) | `motorist_telephony_settings` | SK, CZ |
| Outbound rate limit | `OUTBOUND_RATE_LIMIT` in `src/server/telephony/call-actions.ts`; enforced in-memory **and** against `motorist_call_sessions` created by the operator in the last 60 s | 10 calls/min per operator (code change) |
| SMS rate limit | `SMS_RATE_LIMIT` in `src/lib/integrations/telnyx/sms-client.ts` | 20 SMS/min per organisation (code change) |
| SMS destinations | `destination_allowlist` (the same list as voice), checked in the transport before the send | SK, CZ |

Every dialled leg is counted into `motorist_telephony_daily_usage.legs` (RPC
`motorist_telephony_usage_add`) and every SMS into `sms_count`. Once `legs`
reaches `daily_leg_soft_cap`, click-to-call, internal calls and PSTN
transfer/consult targets are refused with 429 (`daily_cap_reached`); inbound
calls are never refused by the cap.

Raise the Telnyx profile cap and the database cap together: the database cap protects the ring engine from fanning out beyond the provider's concurrency, and the provider cap protects the account from a runaway loop. A step that finds no capacity stays armed for `CAPACITY_WAIT_MAX_MS` (30 s, re-checked by the sweep every 5 s) and only then moves on to the next step or the fallback; hitting the cap opens an incident under `telephony.routing.capacity`. Legs are counted only when they were started in the last 4 hours, and `telephony.ring.sweep` closes leg rows whose session is terminal or that are older than that window, so a lost `call.hangup` webhook cannot silently disable inbound ringing.

## 7. Simulating an inbound call

`POST /api/telephony/dev/simulate-inbound` pushes a synthetic `call.initiated` (and by default `call.answered`) through the real webhook processor, so business hours, IVR, ring plans and the waiting room can be exercised without a reachable DID.

- Admin role, same-origin, session cookie. It refuses on the production deployment (`VERCEL_ENV=production` → `403`) and while telephony is not configured (`503`).
- Run it from the browser console of the `dev` branch alias while logged in as an admin:

  ```js
  await fetch("/api/telephony/dev/simulate-inbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: "+421232408718", from: "+421910000000" }),
  }).then((r) => r.json());
  ```

- Body: `to` (required, one of our lines), `from` (default `+421900000000`), `callControlId`, `callSessionId`, `answer: false` to stop after `call.initiated`.
- The response returns the created `sessionId` and, per injected event, the outcome and the list of executed commands (a `!` suffix marks a failed command).
- **The commands are real.** With the kill switches on, the fan-out dials real operator legs and real external members. Keep `live_calls_enabled` off unless the point of the run is to make phones ring.

## 8. Degraded conference mode

Hold, attended transfer, add-party, park and supervision need the session to be promoted from a plain bridge to a Telnyx conference. Promotion is lazy: an ordinary two-party call never pays for a conference.

- "Conference already exists" is handled: the code looks the conference up by name (`sess-<session_id>`) and joins it.
- Any other promotion error leaves the call **bridged and talking**. The action is refused, the PhoneBar shows the degraded chip ("rozšírené funkcie nedostupné") and the client marks the session degraded until the next successful unhold. The conversation is never dropped to gain a feature.
- Operator workaround while degraded: use a blind transfer (which does not require the conference) or ask the caller to be called back.
- Diagnose from `motorist_job_incidents` under `telephony.telnyx.commands` and from the ledger row of the triggering event; a repeated failure across sessions points at the Call Control application configuration rather than at one call.
- Conferences expire after 4 hours, which is why parked and waiting customers are deliberately kept **out** of the conference and held on a detached `playback_start {loop: "infinity"}` with a silent 60 s `gather` heartbeat instead.
- Verify on the first live park that `call.gather.ended` for a waiting caller arrives about once per minute (not every 5 s) and that the music has no gap: the silent tick sets **both** `timeout_millis` and `initial_timeout_millis` to 60 s, because Telnyx defaults the wait for the first digit to 5 s. A faster cadence in `motorist_telnyx_webhook_events` means the parameter was ignored — lower `MOH_TICK_TIMEOUT_MS` expectations accordingly and raise the sweep budget.
- Promotion is issued on the **operator** leg (`conference_create` there, `conference_join` for the customer) because the inbound bridge protects only the customer with `park_after_unbridge: "self"`. Confirm this with spike S6 before enabling hold/consult in production.
- **Supervision of a call that is not yet a conference costs the caller a short silence.** Promotion is lazy, so the first "Počúvať" on a plain bridged call issues `conference_create` on the operator leg (which unbridges the customer) and only then `conference_join` for the customer — one HTTP round trip later. Hold, consult and park accept the same gap because the caller expects a change at that moment; monitoring is supposed to be inaudible, so the SupervisePanel says so and the manager can wait for a call that is already on hold or in a three-way. Removing the gap altogether means promoting every inbound call to its conference at answer time, which buys a conference (and its 4-hour expiry) for every two-party call — deliberately not done. If a failed join forces the compensation, the caller hears a second, longer gap while the bridge is restored.

## 9. Routine checks

- `GET /api/telephony/health` (bearer `CRON_SECRET`) — one call answers "is the exchange working?". It reports per check (`configuration`, `sessions`, `webhooks`, `ledger`, `incidents`, `usage`, `devices`) and answers **503** when any check is `fail`, so an uptime monitor can watch it without parsing the body. `skipped` means telephony is not configured in that environment — it is deliberately not `ok`, so a half-provisioned preview never looks healthy.
- `GET /api/telephony/cron` (bearer `CRON_SECRET`) — the single scheduled job; `status: "degraded"` means a sub-job failed.
- `motorist_telnyx_webhook_events`: rows with `status = 'failed'`, or `attempts > 1`, indicate lost or retried webhooks.
- `motorist_job_incidents` under `telephony.telnyx.webhook|commands|actions` and `telephony.routing.capacity` (the org-wide leg cap was reached). Open rows close themselves (`status = 'recovered'`) after the first clean run of that job — a webhook processed, a transition applied with no failed command, or the leg count back under the cap — at most one check per minute per instance, so an incident that stays open means the failure is still happening.
- The ring sweep also repairs bookkeeping the reducer could not: `orphanLegsClosed` (legs left open by a lost `call.hangup`) and `staleAttemptsClosed` (leaked `offered` ring attempts, which would otherwise keep their operator out of *every* future ring plan through the global partial unique index).
- `motorist_telephony_daily_usage` against `daily_leg_soft_cap` (legs and SMS are written by the app; the cap is enforced, not only alerted).
- `telephony.telnyx.reconcile` asks Telnyx about the legs of sessions that have been quiet for three minutes and replays the `call.hangup` that never arrived. `deadLegs > 0` in the cron summary means webhook deliveries were lost — check the Telnyx portal's webhook delivery log for that window before assuming it was a one-off.
- `telephony.alerts` mails the failing health checks to `ALERT_EMAIL_TO`, at most once per problem per day (`motorist_telephony_alerts`, key `<deň>:<check>:<status>`). No `ALERT_EMAIL_TO` means the job reports `skipped` and writes nothing, so the first address that is configured still hears about the problem. To force a re-send, delete the row for that key. An escalation (`warn` → `fail`) is a new key and is always delivered.
- The ledger prune job (`telephony.ledger.prune` in `motorist_job_controls`) is seeded **disabled**; enable it when retention should start running, otherwise the cron keeps reporting `disabled` and raw payloads accumulate.

## 10. Test coverage gaps

- **`e2e/telephony-phonebar.spec.ts` is deliberately not written yet (deferred past Phase 2).** The PhoneBar flow (ringing → answer → hold → transfer → hangup) needs the `@telnyx/webrtc` SDK stubbed inside the browser as well as `/api/telephony/{calls/active,webphone/token,devices/heartbeat}`, which is a Playwright harness of its own; the state machine behind it is covered end-to-end offline (`src/server/telephony/state/transitions.test.ts`, `call-actions.test.ts`, `src/lib/telephony/telnyx-webphone.test.ts`, `src/components/dispatch/phone-bar-model.test.ts`). Write it together with the Phase 4 supervision UI, or replace it with the manual acceptance script in section 7 until then.

## 11. Official references

- Telnyx Call Control: https://developers.telnyx.com/docs/voice/programmable-voice/call-control
- Telnyx webhook signature verification: https://developers.telnyx.com/docs/development/webhooks
- Telnyx WebRTC JS SDK: https://developers.telnyx.com/docs/voice/webrtc/js-sdk
- Telnyx Messaging: https://developers.telnyx.com/docs/messaging
- Vercel cron jobs: https://vercel.com/docs/cron-jobs
- Supabase Realtime Broadcast from the database: https://supabase.com/docs/guides/realtime/broadcast
