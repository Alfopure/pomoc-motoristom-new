# Telnyx operations runbook

Operational procedures for the telephony stack of this copy of the dispatch app. The contract the code implements is in [`../telnyx-data-contract.md`](../telnyx-data-contract.md); resource identifiers are in [`telnyx-setup.md`](./telnyx-setup.md).

Rules that apply to every procedure below:

- Never touch the original production project (Supabase `sjcsrygkkmersoczpunh`, Vercel `pomoc-motoristom-dispecing`, `dispecing.linkapomoci.sk`).
- Secrets stay in Vercel environment variables and the owner's private notes. Never paste an API key, SIP password or WebRTC token into a document, a commit or a ticket.
- Live calls and live SMS cost money and reach real people. Both kill switches are `false` by default; flip them on immediately before a test and back off afterwards.
- Applying a Supabase migration or seed is a separate, explicitly requested operation against this copy's project (`ifpaeegaesdmljfkdvcn`) only.

## 1. Spikes to run against the real account

Time-boxed verifications that cannot be done offline. Record the outcome (date, session id, result) in this section after each run.

### S1 — `telnyxIDs` correlation on the inbound WebRTC invite

**Why.** Auto-answer of an outbound click-to-call depends on the browser being able to tell *which* incoming WebRTC invite belongs to the leg the server just dialled. The primary discriminator is `call.telnyxIDs.telnyxCallControlId` matching the `operatorLegCallControlId` returned by `POST /api/telephony/calls`; the `X-PM-Auto-Answer` custom header is a nice-to-have.

**How.** Log in as an operator on the `dev` branch alias with `TELNYX_LIVE_CALLS_ENABLED=true` and `motorist_telephony_settings.live_calls_enabled=true`. Open the browser console, dial your own mobile from a case. In the `telnyx.notification` handler log `call.telnyxIDs` and `call.options.customHeaders` (the webphone exposes both on the SDK call object; `src/lib/telephony/telnyx-webphone.ts` already correlates on `telnyxCallControlId`).

**Pass criteria.** `telnyxIDs.telnyxCallControlId` is present on the invite and equals the value the route returned. Note separately whether custom headers survive to the SDK.

**If it fails.** `rememberExpectedLeg`/`matchExpectedLeg` fall back to a 90 s TTL window; auto-answer must then be replaced by an explicit "Prijať" click in the PhoneBar. Do not guess by caller number.

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

**Emergency stop (fastest path).** Set the database column to `false` for the organisation. Everything provider-affecting starts answering `423` with the Slovak kill-switch message within one request; in-call cleanup commands (`hangup`, `bridge`, playback and conference actions) stay allowed so a live call can always be torn down.

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

- **Rotate one operator:** delete the operator's `motorist_operator_devices` row (or clear `telnyx_credential_id`) and delete the matching telephony credential in Telnyx. The next `POST /api/telephony/webphone/token` provisions a new one.
- **Kick a stale tab:** issuing a new token rotates `device_session_id`; the previous tab's next heartbeat gets `409` and disconnects with a Slovak message. Only one active device per operator per environment is allowed.
- **Departing employee:** deactivate the profile *and* delete the Telnyx credential; deactivating the profile alone leaves a registerable SIP credential behind.

## 5. Adding a phone number (line)

1. Buy the number in Telnyx (Bratislava fixed line; SMS is not available on these numbers) and complete any regulatory requirement.
2. Assign it to the Call Control application of the target environment.
3. Read the canonical E.164 string and the number id from `GET /v2/phone_numbers`. Use the string exactly as returned — one existing number carries a spurious leading zero and the app normalises on read.
4. Insert a row into `motorist_telephony_lines`: `phone_number` (canonical), `telnyx_number_id`, `label`, `partner_name`, `ring_plan_id`, optionally `ivr_menu_id` and `business_hours_id`, `environment`, `active = true`. Unique on `(organization_id, phone_number)`.
5. Add the number to `docs/operations/telnyx-setup.md`.
6. Verify: an inbound call resolves to the right line label and partner name in the PhoneBar and in the call log. Use `simulate-inbound` (section 7) if the DID is not reachable yet.

Never point a new number at a Call Control application of another environment: the webhook rejects events whose `connection_id` does not belong to the environment, and the call would be dropped silently with `unverified_connection`.

## 6. Raising caps

| Cap | Where | Default |
| --- | --- | --- |
| Daily spend, per-minute destination price, concurrency, destination whitelist | Telnyx outbound voice profile (one per environment) | prod 20 USD/day, concurrency 10, EU27; dev 2 USD/day, concurrency 4, SK+CZ |
| `max_ring_fanout` (legs dialled per ring step) | `motorist_telephony_settings` | 8 |
| `max_concurrent_legs` (per organisation) | `motorist_telephony_settings` | 9 |
| `daily_leg_soft_cap` (alerting) | `motorist_telephony_settings` | seeded value |
| `park_max_minutes` (park guard before the callback prompt) | `motorist_telephony_settings` | 30 |
| `destination_allowlist` (dial prefixes) | `motorist_telephony_settings` | SK, CZ |
| Outbound rate limit | `OUTBOUND_RATE_LIMIT` in `src/server/telephony/call-actions.ts` | 10 calls/min per operator (code change) |

Raise the Telnyx profile cap and the database cap together: the database cap protects the ring engine from fanning out beyond the provider's concurrency, and the provider cap protects the account from a runaway loop. When a step finds no capacity it is skipped in favour of the next step or the plan fallback, so an under-sized `max_concurrent_legs` silently shortens ring plans.

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
- Conferences expire after 4 hours, which is why parked and waiting customers are deliberately kept **out** of the conference and held on a `gather_using_audio` MOH tick loop instead.

## 9. Routine checks

- `GET /api/telephony/cron` (bearer `CRON_SECRET`) — the single scheduled job; `status: "degraded"` means a sub-job failed.
- `motorist_telnyx_webhook_events`: rows with `status = 'failed'`, or `attempts > 1`, indicate lost or retried webhooks.
- `motorist_job_incidents` under `telephony.telnyx.webhook|commands|actions`.
- `motorist_telephony_daily_usage` against `daily_leg_soft_cap`.
- The ledger prune job (`telephony.ledger.prune` in `motorist_job_controls`) is seeded **disabled**; enable it when retention should start running, otherwise the cron keeps reporting `disabled` and raw payloads accumulate.

## 10. Official references

- Telnyx Call Control: https://developers.telnyx.com/docs/voice/programmable-voice/call-control
- Telnyx webhook signature verification: https://developers.telnyx.com/docs/development/webhooks
- Telnyx WebRTC JS SDK: https://developers.telnyx.com/docs/voice/webrtc/js-sdk
- Telnyx Messaging: https://developers.telnyx.com/docs/messaging
- Vercel cron jobs: https://vercel.com/docs/cron-jobs
- Supabase Realtime Broadcast from the database: https://supabase.com/docs/guides/realtime/broadcast
