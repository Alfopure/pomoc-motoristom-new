# Telnyx operations runbook

Operational procedures for the dispatch application's telephony stack. Production is `https://dispecing.linkapomoci.sk` (`main`, Vercel `pomoc-motoristom-dispatching`, Supabase `ifpaeegaesdmljfkdvcn`). Stable TEST is `https://test.dispecing.linkapomoci.sk` (`dev`, Vercel `pomoc-motoristom-test`, Supabase `nzpnqdstvkfncflgqlny`). Both dedicated projects deploy to their own Vercel Production target. The contract the code implements is in [`../telnyx-data-contract.md`](../telnyx-data-contract.md); resource identifiers are in [`telnyx-setup.md`](./telnyx-setup.md).

Rules that apply to every procedure below:

- Never touch the retired VIPTel project (Supabase `sjcsrygkkmersoczpunh`, Vercel `pomoc-motoristom-dispatching-old`, `dev.dispecing.linkapomoci.sk`, or its listener). That Supabase still hosts another live application. The current production domain belongs to this repository.
- Secrets stay in Vercel environment variables and the owner's private notes. Never paste an API key, SIP password or WebRTC token into a document, a commit or a ticket.
- Live calls and SMS use the authorized configuration of the identified production or dedicated TEST project. Ordinary branch Preview keeps live integrations disabled and must not operate stable TEST devices or routing. Preserve TEST-owned resources, signed webhooks and per-operation provenance even for cleanup. TEST uses the [authorized phone policy](test-phone-number-policy.md), including ordinary calling without an individual tester list; do not automatically contact copied historical customers.
- Applying a Supabase migration or seed is a separate, explicitly requested operation with exact SQL and target project: TEST `nzpnqdstvkfncflgqlny` or production `ifpaeegaesdmljfkdvcn`. TEST approval does not authorize production. Do not seed a copied snapshot or apply every pending migration.
- **The settings screens ("Nastavenia → Telefonovanie") must not be reachable on a database without migrations `20260918100000_ring_config_rpc.sql` and `20260919100000_telnyx_phase3_fixes.sql`.** Until both are applied, `motorist_replace_ring_plan(uuid, jsonb, integer)` does not exist (every configuration save answers 503 with a message naming the migration) and the foundation policies still let any organisation member `PATCH` the routing tables straight through PostgREST — a dispatcher could repoint a production number and a manager could flip the admin-only kill switches, with no validation, no transaction and no audit row. Verify after applying:

```sql
-- 1 row, three arguments
select p.oid::regprocedure from pg_proc p
 where p.proname = 'motorist_replace_ring_plan';
-- must be empty: no write privilege for the session roles on the routing tables
select table_name, grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon', 'authenticated')
   and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
   and (table_name like 'motorist_ring%' or table_name in
     ('motorist_business_hours', 'motorist_business_hours_intervals', 'motorist_business_hours_exceptions',
      'motorist_ivr_menus', 'motorist_ivr_options', 'motorist_pause_reasons',
      'motorist_operator_telephony_settings', 'motorist_telephony_settings', 'motorist_telephony_lines'));
-- must list only `select` policies for those tables
select tablename, policyname, cmd from pg_policies where schemaname = 'public' and tablename like 'motorist_%';
```

## 1. Spikes to run against the real account

Time-boxed verifications that cannot be done offline. Record the outcome (date, session id, result) in this section after each run.

### S1 — `telnyxIDs` correlation on the inbound WebRTC invite

**Why.** Auto-answer of an outbound click-to-call depends on the browser being able to tell *which* incoming WebRTC invite belongs to the leg the server just dialled. The primary discriminator is `call.telnyxIDs.telnyxCallControlId` matching the `operatorLegCallControlId` returned by `POST /api/telephony/calls`; the `X-PM-Auto-Answer` custom header is a nice-to-have.

**How.** Log in as an operator on canonical stable TEST with verified TEST configuration, `TELNYX_LIVE_CALLS_ENABLED=true` and `motorist_telephony_settings.live_calls_enabled=true`. Open the browser console, dial your own mobile from a case using the TEST caller ID. In the `telnyx.notification` handler log `call.telnyxIDs` and `call.options.customHeaders` (the webphone exposes both on the SDK call object; `src/lib/telephony/telnyx-webphone.ts` already correlates on `telnyxCallControlId`).

**Pass criteria.** `telnyxIDs.telnyxCallControlId` is present on the invite and equals the value the route returned. Note separately whether custom headers survive to the SDK.

**If it fails.** `rememberExpectedLeg`/`matchExpectedLeg` fall back to a 90 s TTL window; auto-answer must then be replaced by an explicit "Prijať" click in the PhoneBar. Do not guess by caller number. The `X-PM-Auto-Answer` header is only a tiebreaker inside that window (it carries no session identity), so it cannot substitute for the id.

**Result.** _Not yet run._

### S6 — Conference promotion must not drop the operator leg

**Why.** Hold, consult, attended transfer, park and supervision all promote a bridged call to a conference. Creating a conference from a bridged leg ends the bridge, and Telnyx documents `park_after_unbridge: "self"` as the only thing that saves a leg when its bridge ends. Inbound calls are bridged **from the customer leg** with that flag, so the customer is protected and the operator is not — which is why the code creates the conference **on the operator leg** and joins the customer. This has to be confirmed against the real API before hold/consult are used in production: a compensation can restore database state, but it cannot resurrect a hung-up WebRTC leg.

**How.** On canonical stable TEST with the calls environment and database switches enabled, take a real inbound call to the TEST number, press "Podržať", then "Pokračovať". Watch the PhoneBar and `motorist_call_legs` for the session. Record the deployment commit, timestamps and whether recording was enabled; inspect the same window in server/database logs.

**Pass criteria.** Both legs stay open (`ended_at is null`), the session reaches `held` and returns to `talking` on unhold, the operator hears the caller again and `motorist_job_incidents` gains no `telephony.telnyx.commands` row.

**If it fails.** Distinguish a provider hangup on promotion from a database timeout or rejected command using the exact session and timestamps. Review any provider flag or compensation change against the current implementation and repeat the live TEST. A failed attempt does not establish a cause by itself or authorize a production configuration change.

**Latest recorded attempt (2026-10-06).** The “Nahrávanie overenie pripravenosti” workspace recorded bidirectional audio followed by a hold error after 22.4 s with recording disabled, alongside database connection timeouts. This is evidence about that TEST attempt, not a new live test or proof of a general/production failure. Hold/unhold, transfer, termination and recording still need a successful run on the final TEST candidate.

### S7.0 — Join with hold on the first hold (call-speed S7b)

**Why.** With `hold_join_with_hold` frozen into a session, its first hold sends `conference_create` on the operator leg and then `conference_join` for the customer with `hold: true` and `hold_audio_url` (the MOH file), instead of a separate `conference_hold`: two provider commands instead of three. Telnyx documents `hold_audio_url` together with `start_conference_on_create: false`; our conference starts on create, so the music on join is not established by the documentation.

**How.** Only after this spike passes, set `hold_join_with_hold` in the TEST `latency_flags` and start a **new** call (the switch is frozen at creation). Hold from the web console, then unhold, then hold again. Repeat once with `start_conference_on_create` as the code sends it today; record the result here.

**Pass criteria.** On the first hold the customer hears the MOH and not the operator, the operator stays connected (`ended_at is null` on both legs), `conference_unhold` restores two-way audio, and the later hold uses the ordinary `conference_hold`.

**If it fails.** Leave the switch off (default). The fallback in the plan — `conference_join` and `conference_hold` prepared as one sequential journal batch with `predecessor_failed` for an unsent member — is not implemented.

**Limits until it passes.** Only a deployment whose application environment is exactly `test` freezes the switch (`JOIN_WITH_HOLD_PROVEN` in `latency-flags.ts`); production, a local run (`development`) and an unreadable environment need a reviewed change recording the pass. The value is frozen per call: switching it off protects only new calls, so a failing spike call is ended rather than waited out. Do not roll TEST back to a build without S7 while such a call has an unsent held join: an older build would send that join without the hold.

**Result.** _Not yet run._

### S5.0 — Telnyx EU API (call-speed S5)

**Why.** With `api_region: "eu"` in `latency_flags`, every outbound, colleague and callback session created afterwards on TEST is frozen to `start_mode.apiRegion = "eu"`: its calls, conferences, the TEST guard's conference reads, reconcile reads and recording GET/DELETE go to `api.telnyx.eu`. Telnyx processes a call in the region whose API created it, and conferences cannot span regions, so the region never changes during a call. Inbound sessions stay `us` (no evidence yet which region processes our inbound calls). Credentials, tokens, connections, profiles, numbers and SMS stay on `api.telnyx.com`. The `telnyx-http` log line carries `region`.

**One host per region.** `us` is `https://api.telnyx.com/v2` and `eu` is `https://api.telnyx.eu/v2`. `TELNYX_API_BASE_URL` and `TELNYX_EU_API_BASE_URL` override them only outside production (tests, local runs); production ignores them and logs `api_base_url_override_ignored` once. A session's frozen region, and the logged `region`, therefore always name the host its calls really use.

**Hard rule while any `eu` session has a conference or a recording still stored at Telnyx:** never redeploy or roll back to a build without S5, and never change either base URL. Conferences cannot span regions, and conference and recording requests through the other region are untested: an answer from there (for example 404/422) would say nothing about the customer, who may still be connected, and a recording clean-up would take a 404 for "already removed".

**Plain calls (no conference) look less exposed, on thin evidence.** On TEST a `GET /calls/:id` and a hangup sent through `.com` for one internal call created through `.eu` both worked (result below). Bridge, transfer, playback and recording commands across regions were not tested, so this does not establish that an older build or a changed host keeps control of such a call; avoid both while EU calls are live. An outbound EU call gets a conference at its first hold, and from then on falls under the conference rule above.

For `eu` sessions every "already gone" decision (hangup, recording stop, termination clean-up, offer cancellation, a failed command) counts only Telnyx's own call-gone codes (90018/90003), never a bare 404/422 or its text. A hangup or recording stop refused with 404/422 but without such a code is confirmed with `GET /calls/:id` in the session's region (at most 1.5 s): `is_alive: false` retires the obligation; alive, unknown (404/422), a failed or slow read keeps it. Other refusals (for example Cloudflare's 1010 or the TEST boundary's 423, which Telnyx never saw) are not confirmed and keep it.

**How.** On stable TEST only, with its own provider resources:
- read back `anchorsite_override` of the call control application and the credential connection (expected Amsterdam/Frankfurt); on production read only, with `sip_uri_calling_preference` and the outbound profile;
- set `api_region: "eu"` and start **new** calls: a loop call with hold, unhold, consult and hangup; a colleague call; a recorded call if TEST recording is on (`recording.saved`, then the import's GET and the cleanup DELETE);
- negative check: a `.com` session must not be able to join a `.eu` conference (confirms the pinning is needed);
- wrong-region answers: for a live EU test call, send `GET /v2/calls/:id` and a `hangup` for it through `api.telnyx.com`, and record each HTTP status, error `code` and `detail` here, and whether the call stays up (done for a plain call, see the result; still open for a conference);
- compare `headersMs` per command between `region: "us"` and `region: "eu"` lines, and the target's dial → SDK invite time;
- check `download_urls` of an EU recording: if its host is not `recordings.telnyx.com`, add it to `TELNYX_RECORDING_DOWNLOAD_HOSTS` (otherwise the import fails `source_host_not_allowed`); never construct EU media URLs;
- a `telnyx-http` line with `errorCode: "cloudflare_1010"` (or a `recording` line with `code: "cloudflare_1010"`) means Cloudflare refused our User-Agent before Telnyx: set the switch back to `us`. The refused command is not retried. A refused dial (`POST /calls`) is journalled as refused (403, tagged `cloudflare_1010`): no call exists, so termination does not wait for it. Any other refused command's journal entry stays open (outcome unknown, as after a transport failure), so a live EU call affected by it is settled by provider webhooks and the reconcile job, not by a re-send. Only the EU host is checked; a 403 from `.com` keeps its ordinary meaning;
- a connection-less conference webhook (TEST guard) is read in the region of the session found by conference id, client state or leg; with none of them (a conference whose id is not saved yet) it reads `.com`, fails for an EU conference and is answered 500, so Telnyx redelivers it.

**Pass criteria.** Every command of an EU session succeeds against `.eu`, and the saving is at least 100 ms per command or 300 ms on invite delivery (plan S5 gate). Otherwise keep the switch `us` and record the evidence here.

**Release check (before every `dev` → `main` release that contains S5).** In the production Vercel project, `TELNYX_API_BASE_URL` and `TELNYX_EU_API_BASE_URL` must be unset or exactly `https://api.telnyx.com/v2` and `https://api.telnyx.eu/v2`. Production ignores any other value (and logs `api_base_url_override_ignored`), but a differing value means someone expects a host production will not use. Read the variable names and values only; change nothing without the owner's production authorization.

**Limits until it passes.** Only a deployment whose application environment is exactly `test` freezes `eu` (`EU_API_PROVEN` in `latency-flags.ts`); production and local runs keep `us` whatever `api_region` says until a reviewed change records the pass. Every non-production deployment (a local run may use the TEST database) reads a recording's session to find its region; production recordings keep `.com` without an extra read until then.

**Rollback.** `api_region: "us"` affects only new sessions; sessions already frozen to `eu` finish on `.eu`. Do not roll back to a build without S5 while an EU session has a conference or a recording still stored at Telnyx: an older build would control the conference, and read or delete the recording, through `.com`, where a 404 reads as "already removed" and would leave the EU recording in place. For a plain EU call a GET and a hangup through `.com` worked on TEST (result below); other commands were not tried that way, so avoid it while the call is live.

**Result (partial, 2026-11-02, stable TEST, `dev` `9280f863`, `api_region: "eu"`, synthetic A→B session `d5fc6092`).**
- Wrong-region answers, measured on one internal call (no conference) with exactly two requests through `.com`: the live leg created through `api.telnyx.eu` answered `GET /v2/calls/:id` with 200 and `is_alive: true` through both `.eu` and `.com`; a hangup through `.com` answered 200 and really ended the call (a later `.eu` GET showed `is_alive: false`; the app closed the session cleanly: state `ended`, no open legs, no pending termination). For that GET and that hangup the "wrong region reads as gone" outcome did not occur.
- Not covered across regions: bridge, transfer, playback, recording and every conference command (an internal call has no conference; an outbound call gets one at its first hold), and the negative conference check; the hard rule above stays for conferences and recordings.
- Harness: 5 runs with `api_region: "eu"`, all passed.
- `headersMs` on `.eu` in these runs, next to the earlier TEST baseline on `.com` (not a paired measurement: different runs and times): `POST /calls` 206–385 ms (baseline 390–500); bridge 78–174 ms (263–384); hangup 38–86 ms (213–271); `GET /calls` 23–130 ms (230–330).
- Still open: the gate decision; hold, consult and transfer (conferences); a recorded call (`recording.saved`, GET/DELETE, `download_urls` host); an inbound call controlled through `.eu`; a token mint through `.eu`; the `anchorsite_override` readbacks; dial → SDK invite.

#### S5.0 SIP-domain spike — dialling credentials on `sip.telnyx.eu` (`sip_domain`, TEST experiment)

**Why.** In an EU session (`apiRegion: "eu"`) Telnyx takes about 1.17 s from "far dial dispatched" to the target browser's SDK invite when the server dials a SIP credential (`to: sip:<username>@sip.telnyx.com`: a colleague, or the operator's own leg). About 0.3 s of that is the `POST /calls` response; the rest is Telnyx delivering the INVITE. The browsers register on the EU RTC edge (`eu.rtc.telnyx.com`). `sip.telnyx.com` is anycast (192.76.120.10, SRV `sip-anycast{1,2}.telnyx.com`); `sip.telnyx.eu` exists too (185.246.41.140, SRV `sip-anycast{1,2}.telnyx.eu`). Hypothesis, plausible but not documented by Telnyx: dialling `@sip.telnyx.eu` keeps the INVITE inside Telnyx's EU SIP infrastructure and delivers it sooner.

**What it changes.** `"sip_domain": "eu"` in `latency_flags` freezes `start_mode.sipDomain = "eu"` into a new session only when that session is also frozen to `apiRegion: "eu"` (so `api_region: "eu"` must be set as well, and an inbound call never gets it), and only where the application environment is exactly `test` (`EU_SIP_DOMAIN_PROVEN` in `latency-flags.ts`). Every SIP-credential dial of such a session then goes to `sip:<username>@sip.telnyx.eu`: the operator's own leg, the colleague's web and mobile endpoints, ring fan-out, pickup, a transfer, consult or added party to a colleague, and supervision. The leg rows, the colleague call's `called_number`, `internal.target_sip` and `internal.endpoints`, the start's `initial_operation` and the provider journal record that address. A session without the field (every session created before this build, and every production session) dials `sip.telnyx.com` for good; the default `"com"` changes nothing.

**Reading addresses back.** What Telnyx reports in a webhook's `to` (or a `sip_to`) for a dial to `@sip.telnyx.eu` has not been observed. Every check that recognises a credential by its address accepts the exact address on either domain, and the bare username where Telnyx has used it so far: the TEST guard (`testSipUsername`), the credential-mirror proof (which then requires the address the session itself dialled, in both the leg and the journal), the iPhone's offer and delivered-offer checks, the native session and native hold checks, the browser's offer status and a native callee's own hangup. Any other host, a port or URI parameters are refused as before. For every webhook of an `eu` session, and every proven mirror of one, a `sip-domain-spike` log line records `to`, `sipTo` and the payload's key names (operator addresses only; a phone number is never logged).

**Enable on TEST.** Supabase `nzpnqdstvkfncflgqlny` only, as an explicitly requested operation. It applies to new calls within the flags' 5 s cache:

```sql
-- api_region must already be "eu" (S5.0); otherwise sip_domain has no effect.
select organization_id, latency_flags from public.motorist_telephony_settings;

update public.motorist_telephony_settings
set latency_flags = latency_flags || '{"sip_domain":"eu"}'
where organization_id = '<TEST organization id>';
```

**How.** With `api_region: "eu"` and `sip_domain: "eu"`, run the voice harness 5 times with the same colleague-call scenario as the S5.0 runs and read "far dial dispatched → target invite (SDK)". In the logs, read the `to` (and any `sipTo`) that the `sip-domain-spike` lines report for the dialled legs and for the credential mirrors, and check that every mirror was acknowledged ("verified credential browser mirror"), not left awaiting correlation. Record those values here.

**Pass criterion.** The median of "far dial dispatched → target invite (SDK)" over the 5 harness runs is at least 0.2 s lower than the 1.17 s baseline (at most 0.97 s), with all correctness checks passing.

**If it fails, and rollback.**

```sql
update public.motorist_telephony_settings
set latency_flags = latency_flags - 'sip_domain'
where organization_id = '<TEST organization id>';
```

This affects only new sessions: a session already frozen to `eu` keeps dialling `sip.telnyx.eu` until it ends. Do not roll TEST back to a build without this change while such a session is live: an older build would dial its transfers, consults and supervisors on `sip.telnyx.com`, and would not recognise its legs' `.eu` addresses (iPhone offers, native hold, credential mirrors).

**Limits until it passes.** Production, a local run (`development`) and an unreadable environment never freeze it, whatever the flags say. Production needs S5 itself first, then a reviewed change of `EU_SIP_DOMAIN_PROVEN` recording this pass.

**Result.** _Not yet run._

### S6.0 — Concurrent far-end dial and internal auto-bridge (call-speed S6)

**Why.** A session frozen with `concurrent_dial.<outbound|internal>.<web|mobile>` dials the far end (customer or colleague) in the start request, right after the operator's own leg, with `link_to` the own leg; outbound and auto-bridged colleague dials carry `bridge_on_answer`, `prevent_double_bridge` and `park_after_unbridge: "self"`. What Telnyx does when the far end answers while the own leg still rings is not documented. The code is built to be safe in all three outcomes and decides only on provider evidence (a leg's `call.bridged`, the bridge journal, and the provider's `occurred_at` of the two answers), never on the order the webhooks are processed in. The colleague auto-bridge applies only to a colleague with a single endpoint; with web and mobile endpoints the server picks the winner and bridges it explicitly, as before:

| Outcome | What the server does |
|---|---|
| (A) Telnyx bridges once the own leg answers (observed on TEST, about 0.5 s after the own answer) | Nothing: when the far leg carries `bridge_on_answer` (outbound, auto-bridged colleague) the server waits for Telnyx's `call.bridged` (`far_end.awaitBridgeUntil`, 1.5 s after the own answer) and sends no bridge of its own. An explicit bridge sent meanwhile was also accepted (HTTP 200) and bridged the same pair twice on TEST, so it is only the fallback, sent by the overdue sweep (or the answering request's timer) when nothing reported in time. A 422 for it (any wording) is neither success nor failure: the call connects on the legs' `call.bridged`. |
| (B) Nothing is bridged, both legs stay up | The explicit bridge `bridge(own → far, park_after_unbridge self)`: after the 1.5 s wait above, or at the second answer when the far leg has no `bridge_on_answer` (a colleague without the auto-bridge, two endpoints). Its 2xx is the connection: the runner applies `concurrent_bridge_accepted` right after the effect and the call is `talking` without waiting for `call.bridged` (`far_end.bridge.acceptedAt`). The bridge's `deadlineAt` then only verifies it: if no leg reported `call.bridged` by then (and none waits in the ledger), the sweep logs `concurrent_bridge_connected_without_evidence` and notes the call history, and never tears the call down; a non-call-gone 422 (`refusedAt`) is retried once about 2 s later. At the 8 s deadline the overdue sweep connects an accepted bridge whose evidence is late (logged as `concurrent_bridge_connected_without_evidence`), gives an outcome still unknown in the journal (lost response, 5xx) one 4 s extension, yields while a `call.bridged` for either leg waits in the webhook ledger, and otherwise hangs up both legs as `bridge_failed`, without `answered_at`, presence released once. The webhook request that sent the bridge enforces these times itself after its response (`after()`), so a call with no console open does not wait for the cron; the webhook route, `calls/active` and the cron sweep them too, newest ringing sessions included. When the own leg answered first at the provider, Telnyx bridges at the far end's answer (`bridge_on_answer`) and no bridge is sent. Equal or missing provider times count as far end first. |
| (C) Telnyx hangs up the far leg | The session ends, the own leg is hung up, presence is released once and the history entry is `ended`, never `answered`: `bridge_failed` when the provider (or we) cleared the leg, `customer_left_before_connect` / `colleague_left_before_connect` when `hangup_source` is `callee`. "Answered" means the leg's row says so or its `call.answered` still waits in the ledger; a declined invite (also `normal_clearing`) stays an unanswered ring. A colleague whose answer was refused because they had become busy ends the call as `colleague_busy`. |

The customer hears silence until the own leg answers (owner default), at most the frozen own-leg timeout (12 s).

**How.** Synthetic accounts A and B and TEST-owned numbers only, never a real customer. Enable one switch at a time in the TEST `latency_flags` (frozen per call, so start a new call after each change), and run each spike 3 times with the voice harness (`.context/voice-harness/`):

1. Far end answers first. Colleague: `call A <B email> --answer-on B --ring-seconds 0 --caller-answer-delay 4000`. Outbound: `dial A <TEST line> --expect-listener B --answer-after 0 --caller-answer-delay 4000`. The report's `s6` note says which of A/B/C happened and how long after the far end the own leg answered.
2. Own leg never answers: `--drop-caller-after-post` (both directions). Pass: the far leg ends within about 14 s, both presences are free.
3. Colleague on web and mobile with concurrent dialing (`internal_auto_bridge` does not apply to two endpoints), both answering within 200 ms: the server picks one, bridges it once, and hangs up the other.
4. An explicit bridge sent to an already auto-bridged pair (spike 1 with outcome A and the own answer processed before `call.bridged`): record the code and wording of the 422, whether audio is disturbed, and whether `prevent_double_bridge` hangs up the far leg when our bridge lands first. The harness `s6` note gives `firstBridge` (`telnyx` or `explicit`), `farLegSurvived` and `connectedWithoutEvidence` (calls connected on a 2xx alone; also the `concurrent_bridge_connected_without_evidence` warning in the logs). Any non-zero `connectedWithoutEvidence` is a finding: Telnyx accepted a bridge but never reported it. No code depends on the wording: a 422 only waits for `call.bridged` (`isUnprovenBridgeRefusal`, `state/effects.ts`).
5. What the operator hears while the far end rings, sequential versus concurrent: `--media-probe` on the caller side, plus one manual listen. Compare `answerClick_to_farTone` (the other account's own tone, 440 Hz from A, 880 Hz from B, by a Goertzel filter on the remote stream) with `answerClick_to_remoteAudio` (any level, ringback at 425 Hz included): only the first is the other person.

The fallback bridge is never sent by an answer itself, not even one processed after the 1.5 s wait: such an answer makes it due at once, and the overdue sweep (with its ledger check) or the timer sends it. The timer runs in whichever request applied the answer — the webhook, its deferred drain or a held claim's drain — and only after its response (`after()`); without `after()` the sweeps alone enforce it.

`targetLocalFirst` (S6.4) is not usable yet: the browser's `remoteAudioPlaying` turns true on the answered leg's own media before any bridge, so the colleague's bar could show "Prebieha" for a call that is not connected. The code passes it to the console only on TEST (`TARGET_LOCAL_FIRST_PROVEN` in `latency-flags.ts`); keep it off until a far-party audio signal exists.

`--answer-on none` keeps the synthetic target signed in and registered (it rings) without answering, for the own-leg and timeout spikes.

**Pass criteria.** Every run passes the harness checks, including `exactlyOneBridge`, `presenceReleasedOnce`, `historyAnsweredOnlyIfTalking` and `legsAndSessionEnded`, with no open `telephony.telnyx.commands` incident.

**If it fails.** Turn the switch off (frozen calls finish in their mode). Outcome C on a customer dial means concurrent outbound must not use `bridge_on_answer`: that is a reviewed code change, not a configuration change.

**First TEST runs (dev `b4fba58`, synthetic A → B colleague calls, web, EU API).** T1 p50 3.33 s sequential, 1.96 s concurrent with the auto-bridge, 1.92 s without; 5/5 passes each. Far end first with the auto-bridge (`--caller-answer-delay 1500`): outcome A, Telnyx bridged about 0.5 s after the own answer, and our explicit bridge sent 40 ms later was also accepted (200), bridging the pair twice in 2/3 runs (`exactlyOneBridge` failed); the far leg survived. That build sent the bridge at once; the server now waits for Telnyx's bridge first (row A). Far end first without the auto-bridge: 3/3 passes with one explicit bridge. Own leg dropped: 2/2 clean. In the runs without the auto-bridge the UI waited for `call.bridged` after the bridge (about 0.5 s); the bridge's 2xx now connects the call. Rerun spikes 1, 3 and 5 on the new build.

**Round 2 (3 Nov, dev `393e97c`, synthetic A → B colleague calls, web, EU API; tone probe: A plays 440 Hz, B 880 Hz, ringback 425 Hz excluded).** Full data in `.context/voice-harness/runs/PROGRESS.md` and `runs/r2-*`.

| Mode | T1 p50 | B hears A (tone) | A hears B (tone) | Result |
|---|---|---|---|---|
| sequential baseline | 3.78 s | 1.35 s | 1.65 s | 3/3 |
| concurrent + auto-bridge | 1.89 s | 1.23 s | **2.76 s** (1.45–3.19) | 5/5 pass |
| concurrent, our explicit bridge | 1.85 s | 1.59 s | **no 880 Hz tone within 2.9 s in 4/5** (max share 0.002) | 5/5 pass |
| far end first + auto-bridge | 1.83 s | — | 2.09 s | 3/3; outcome A: Telnyx bridged, we sent nothing (no double bridge) |
| own leg dropped / no answer | ~1.9 s | — | — | 2/2 + 2/2 clean |

**Finding: one-way initial audio.** The concurrent dial is correct and T1 drops by about 1.9 s, but at first the audio is one-way: the colleague hears the caller at once, the caller hears the colleague 1–3 s late (with our explicit bridge, not within the 2.9 s window in 4/5 runs). Round 1 already showed it: Telnyx's `bridge_on_answer` bridged about 320 ms after B answered, B's audio started 0.27 s later, A's 1.85 s later. Leading hypothesis: the far dial's `link_to` points at the own leg while that leg is not yet answered (the sequential path links to an answered leg and hears both ways at once). Our code does not gate the caller's received audio: the web phone never disables a remote track or deafens the call, the SDK attaches the remote stream itself, and the probe reads the remote track (not the audio element). The one in-browser explanation left was SDP renegotiation (Telnyx re-INVITEing the caller's leg when the linked far call bridges). `--signal-trace` ruled it out on TEST: the caller's and the colleague's signalling is identical in the sequential, concurrent + auto-bridge and concurrent + explicit-bridge modes (invite → answer → candidates → bye), with no `telnyx_rtc.modify` or re-INVITE. **S6 stays off** until this is resolved.

**Experiment B′ (`concurrent_far_link_to: false`, TEST only, colleague calls only).** The concurrent colleague dial goes without `link_to`, and so without `bridge_on_answer` (which needs it); the server bridges every pair explicitly, and its 2xx connects. Frozen per call as `start_mode.farLinkTo: false` (that start also gets no auto-bridge); only a deployment whose application environment is exactly `test` freezes it, and only for a colleague call; the default `true` is today's behaviour. An outgoing call keeps its linked customer dial until an outgoing B′ spike passes: its unlinked path exists and is tested, but nothing freezes it. That path cannot put `park_after_unbridge: "self"` on the customer dial — Telnyx accepts it only with `link_to` (code 10000) and the TEST boundary refuses it too — so the server's bridge for an unlinked customer is issued **from the customer leg** with that flag, as inbound and announced outgoing calls are: an unbridge (conference promotion, a lost operator, hold, park, transfer) parks the customer instead of hanging up. Unverified on TEST until that spike. What `link_to` gives today, and what B′ does instead:
- a shared provider call session: Telnyx reports the colleague's call under its own `call_session_id`. Our correlation never relied on it: every dial carries the session's client state, every leg row is written from its own dial result, and the callback contact proof keeps the own dial in `ownDialCommandId`. The places that used the shared session now also read the far dial's own `call_session_id` from our journal of that dial: recognising the colleague browser's credential-side mirror events (through that operator leg and the same exact journal proof), the session drain that replays mirrors which arrived before that proof, the iPhone's delivered-offer check (`deliveredLeg`, which matches the leg's own accepted dial) and the alert e-mail's attribution of failed ledger events. Call-interruption diagnostics need nothing: our call events carry the session's provider ID and the leg checks use control IDs. The mirror fallback reads only the 8 newest operator legs to that SIP address in 15 minutes within the lookup's 1.5 s budget; a miss attributes nothing, the drain and the cron retry, and after 60 s it is the ordinary correlation incident;
- `bridge_on_answer` / the auto-bridge: replaced by the explicit bridge at the second answer, with no 1.5 s wait for a provider bridge that cannot come;
- teardown: the server already hangs up the far leg when the own leg ends or times out (spike 2 passed for that reason, not because of `link_to`), and does the same unlinked;
- reporting: the two calls are separate call sessions in Telnyx's own records.

To run it on TEST, add `"concurrent_far_link_to": false` to the TEST `latency_flags` with `concurrent_dial.internal.web` on, then rerun round 2's concurrent modes with `--media-probe --signal-trace`. Pass: A hears B's tone about as soon as in the sequential baseline (≈ 1.65 s), with the usual harness checks.

**Operating rules before production.** Alerting on `concurrent_bridge_connected_without_evidence` warnings and on the `bridge_failed` and `operator_leg_unavailable` end reasons has to exist and be watched before any S6 switch is enabled in production. Enable only directions and origins that have their own passing spikes: `concurrent_dial.internal.web` only on the internal web results, while `outbound.*`, `*.mobile` and `internal_auto_bridge` each need their own (outbound with a real PSTN destination, mobile on an iPhone).

**Limits until it passes.** Only a deployment whose application environment is exactly `test` freezes a concurrent start or the colleague auto-bridge (`CONCURRENT_START_PROVEN` in `latency-flags.ts`, like S5 and S7b): production, a local run (`development`, which may point at production data) and an unreadable environment keep the sequential start whatever the switches say, until a reviewed change records the pass of spikes 1–4.

**Result.** _Not yet run._

### S4 — Keep-alive sockets to the Telnyx API (call-speed S4)

**Why.** Node's fetch drops an idle socket after 4 s (Telnyx's Cloudflare edge sends no `Keep-Alive` hint), while one call's webhooks arrive 0.3–10 s apart. S4.0 on TEST: 65 of 79 requests with Telnyx calls (82 %) opened new Telnyx connections (`telnyxConnects` in `request-performance`); a start opened 2–3, a webhook 1–2, a hangup 2. On 2026-11-03 both `api.telnyx.com` and `api.telnyx.eu` kept an idle socket for 16, 31 and 61 s (unauthenticated GET, from the sandbox).

**What it changes.** `http_keepalive_ms` > 0 in `latency_flags` gives the Telnyx client built by `createTelephonyDeps` (call control, webhooks, cron) a shared undici `Agent` (`src/server/http/keepalive.ts`): idle sockets kept that long but never more than 60 s (a larger value is capped), 32 connections per host, a 3 s connect timeout. It applies to new requests within the flags' 5 s cache and is not frozen per call. An instance keeps one Agent per value, also after the switch goes back to `0`, and its socket diagnostics stay subscribed (they only mark requests, never change them). `0` (the default) keeps the global fetch and never loads undici. The database (`telephonyDatabaseFetch`), the SMS client, access management and the AI demo keep the global fetch.

**Stale sockets.** Before it reuses an idle socket, undici lets the event loop read a FIN or RST that is already waiting (an instance thawed after a freeze), so a socket the server closed meanwhile is replaced and the request goes out once, on a new socket (tested). A request that still fails on a kept-alive socket is never resent, by undici or by us. A POST therefore keeps today's outcome: the journal entry stays `unknown`, and `observe_dial_v2` and the reconcile job settle it. The `telnyx-http` attempt marks a reset before any response with `reusedSocketReset: true`, and a timeout before any response on a reused socket (a possible silent drop) with `reusedSocketTimeout: true`. A GET fails as before with a retryable `network` or `timeout` error.

**How.** On stable TEST only: set `"http_keepalive_ms": 15000`, then make ordinary calls (start, hold, hangup, an inbound call). Compare `telnyxConnects` per request and Telnyx `headersMs` of the first attempt with the S4.0 baseline, and count `reusedSocketReset` and `reusedSocketTimeout` attempts and `unknown` journal outcomes.

**Pass criteria (S4.2).** Fewer `telnyxConnects`, no more `unknown` journal outcomes than the baseline, T1/T3 no worse.

**Stop criterion.** Any rise in `unknown` journal outcomes against the baseline: set the switch back to `0`.

**Rollback.** `"http_keepalive_ms": 0`. New requests use the global fetch within 5 s; requests in flight finish on the Agent.

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

**Live TEST configuration.** Use only the dedicated `pomoc-motoristom-test` project's Production target, `MOTORIST_APP_ENV=test`, and system `VERCEL_PROJECT_ID=prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk`, with TEST-only resources/secrets. Follow the [TEST runbook](full-test-environment.md) and preserve the owner's authorized operating flags. Ordinary Preview is not a live test environment. If a specific test requires temporary flag changes, record the baseline and restore that baseline afterwards; do not turn off the stable TEST application merely because one test ended. Environment changes need a fresh build from current `dev` in the TEST project, never a redeploy of historical source. Production configuration requires its own authorization.

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

- Admin role, same-origin, session cookie. It refuses in the production application (`isProductionDeployment()` → `403`) and while telephony is not configured (`503`). The dedicated TEST project's Vercel Production target is still the TEST application.
- When this simulation is explicitly needed, run it on canonical stable TEST while logged in as an admin, using the actual TEST DID and a chosen tester's number. It writes real sessions and can issue provider commands; it is not a read-only health check or evidence of live audio:

  ```js
  await fetch("/api/telephony/dev/simulate-inbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: "<TEST DID in E.164>", from: "<tester number in E.164>" }),
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
- The ring sweep also repairs bookkeeping the reducer could not: `orphanLegsClosed` (legs left open by a lost `call.hangup`; a leg whose exact `call.hangup` is still waiting in the webhook ledger is left alone and counted as `orphanLegsAwaitingHangup`, so the real event — not the closer — sets `ended_at`) and `staleAttemptsClosed` (leaked `offered` ring attempts, which would otherwise keep their operator out of *every* future ring plan through the global partial unique index).
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

## Deployment firewall and the cron (updated 17 Sep 2026)

### What changed and why

The `MG02 incompatible deployment` firewall rules used to be an **allowlist** of
approved hosts and deployment ids. Vercel points the cron at the *immutable*
host of the current deployment, so every production release silently moved the
cron to a host the allowlist did not contain: `/api/telephony/cron` answered
`403` and nothing ran `runTelephonyCronJobs` — pending-effect recovery,
termination retries, stalled ledger replay, stale session finalisation,
reminders, pause warnings and recording processing all stopped. Two releases on
16 Sep did this without anyone noticing.

Both rules are now **denylists** of the finite set of deployments built before
the skew boundary `2026-09-11T20:39:53Z` (291 of them). A new deployment matches
nothing and is served; **no manual edit is needed after a release**.

Skew protection (boundary plus `maxAge` 43200) is unchanged and remains the
second layer.

### Verified behaviour

| request | expected |
|---|---|
| current immutable host `/api/telephony/cron` | `401` (the endpoint's own `CRON_SECRET` check) |
| current immutable host `/api/health/live` | `200` |
| a pre-boundary host, any path | `403`, `x-vercel-mitigated: deny` |
| `__vdpl` cookie pinning a pre-boundary deployment | `403` |
| `__vdpl` cookie pinning the current deployment | `200` |

The `dpl` query parameter and the `x-deployment-id` header are **not** evaluated
by the firewall — Vercel consumes them upstream. That was equally true of the
allowlist; only the cookie form is enforceable here.

### Post-deploy gate — run this after every production release

1. `GET https://<immutable host>/api/telephony/cron` → **401**, never `403`.
2. `GET https://<immutable host>/api/health/live` → **200**.
3. `crons.definitions[0].host` in the project config equals that immutable host.
4. The next scheduled run appears in the deployment log within 10 minutes. The
   route logs nothing on success, so look for a `{"scope":"cron"}` line from a
   job that had work, or confirm through the dashboard.

A `403` at step 1 means something re-introduced an allowlist, or the deployment
predates the skew boundary. Do not roll back to a build from before the
boundary: it is denied by design.

### Rollback

Rebuild either rule as an allowlist with `op: "ninc"` over the hosts and ids you
want served, through
`PATCH /v1/security/firewall/config?projectId=…&teamId=…` with
`{"action":"rules.update","id":"<rule id>","value":{…}}`. A firewall condition
holds at most **75** values, so long lists must be split across several
`conditionGroup` entries (they are OR'd).
