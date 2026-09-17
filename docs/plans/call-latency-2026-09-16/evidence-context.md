# Context snapshot — call latency repair review (2026-09-16)

Read-only review. Nothing in the repo, database, Vercel or Telnyx was changed. Code references point to `origin/main` = `f8cb0717c592b8e60492b809c021de82ce77d0b6`, extracted read-only at `/tmp/pm-main`. The workspace checkout (`/home/vercel-sandbox/pomoc-motoristom-new`, HEAD `a22d4d9`) is 39 commits behind main; do not analyse it, analyse `/tmp/pm-main`.

## Task statement (zadanie)

Original assignment (11 Sep, user): calls at the client meeting had 15–20 s delays between pickup, response, click, adding a participant. The core call operations — accept/pickup, connect (bridge), add party, transfer/consult, hangup — must be fast, correct and efficient. Recording and announcements are explicitly NOT the priority. Be extremely thorough and precise, find the faults, propose the fix.

Today's assignment (16 Sep, user): go through what OpenAI found (5 remaining problems below), independently analyse the assignment, find anything better, propose a repair plan with the ralplan consensus workflow. Change nothing.

Desired outcome: a precise, evidence-backed repair plan that (a) verifies or corrects each OpenAI finding, (b) adds defects/mechanisms OpenAI missed, (c) is executable under the repo constraints (AGENTS.md: dev-first workflow, only this copy's Supabase `ifpaeegaesdmljfkdvcn` / Vercel `prj_DN3smSO1EbGowAmw3nHLQUYoSVJG`, no workers/listeners/schedulers, one cron `*/5 * * * *` → `/api/telephony/cron`, migrations only on explicit request, never touch the original production project).

## History (what OpenAI did, all merged to main)

- 11 Sep: audit of 31 calls (docs/operations/telephony-latency-audit-2026-09-11.md, call-day-review): inbound operator answer → bridge 10.04–21.68 s; outbound customer answer → bridge 0–0.42 s (Telnyx auto-bridge via `bridge_on_answer`+`link_to` is fast); transfer started 15.88 s after request, hold 24–29 s, hangup effect 23 s late; 10 `call.answered` failed on recording lock and were acked 200; webhook runner median 8.6 s p95 25 s; lease wait median 2.8 s.
- 11 Sep: Supabase incident: ~1,400 rollbacks/s from custom SQLSTATE 40001 in `motorist_save_case_atomic` (PostgREST infinite retry) → fixed by PR #161/#162 (PT409 mapping, 10 functions), verified 0 rollback growth. Not a current issue per OpenAI 16 Sep observation.
- 11–12 Sep: PR #160/#165 (a22d4d9): webhook retry contract v2 (ledger counters, deferrals, awaiting-correlation), contract-2 ownership (generation leases, DB fence triggers, provider command journal, durable initial dial, termination intent), recording-disabled priority (critical writes before auxiliary projections), bounded Telnyx HTTP. Contract 2 activated for new sessions 12 Sep 07:07 UTC.
- 13 Sep: PR #169 (e423cd2) latency: hangup priority, fewer renewals/reads, checkpoint CAS reuse, after() maintenance; benchmark DB request counts startup 53→43, operator answer 42→34, recipient answer 27→22, bridge 25→18, transfer 48→37, cancel transfer 60→39. Observed before fix: outbound start 7.4 s/54 DB ops; pickup 9.6 s/57 ops (provider HTTP 0.44 s); hangup 12.3 s/72 ops; answer→bridge 16.2 s; bridge confirmation 13.5 s/44 ops. After: one outbound start 3.24 s.
- 13 Sep: PR #171 (a41e0e6) contention: callbacks/sweeps make one lease attempt; interactive controls bounded wait with jittered backoff; deferred terminal facts replayed after release; `session_busy` 503 + one client retry; 137 s stale connected display fixed.
- 13 Sep: PR #173 (fdfd999, 1f1804a): inbound lines without explicit announcements route immediately; SDK reconnect keeps call; mobile PWA keeps phone 2 min standby; JWT refresh applied to live SDK.
- Fanout remained serial by explicit decision (docs/operations/call-performance-release-2026-09-11.md:21). Critical DB work is not one atomic RPC (completion audit).

## OpenAI's 5 findings of 16 Sep and my verification

1. **Cron blocked by firewall (403) since today's deployment.** CONFIRMED LIVE (read-only probes from the user's Mac, 16 Sep ~14:41 UTC):
   - `https://pomoc-motoristom-7ua6n9kj1-alfopures-projects.vercel.app/api/telephony/cron` → HTTP 403, `x-vercel-mitigated: deny` (also `/api/health/live` 403). Same for the previous production host `pomoc-motoristom-patko0u0g…` (dpl_DvWXsG95L6k3iemmwmB6eBqDZucp, created 08:43 UTC).
   - Canonical `https://dispecing-test.vercel.app/api/telephony/cron` → 401 (app auth reached), `/api/health/live` → 200. Dev alias cron → 401.
   - Project config: `crons.definitions[0].host = pomoc-motoristom-7ua6n9kj1-alfopures-projects.vercel.app` (immutable host of dpl_AaeS5AtrznEY5YLz7cpftZXo1SnV, created 2026-09-16 09:13:43 UTC), `crons.enabledAt` set, `updatedAt` 1789550156026.
   - Active firewall config version 44, updatedAt 2026-09-15T11:08:26Z (BEFORE both of today's deployments): rule "MG02 incompatible deployment host deny" = `host ninc [allowlist of 12+ hosts]` → deny; rule "MG02 incompatible deployment pin deny" = query/header/cookie `dpl`/`x-deployment-id`/`__vdpl` not in allowlist → deny. Today's hosts are not in the allowlist.
   - Skew protection: boundary 1789156793438 (2026-09-11T20:39:53Z), maxAge 43200.
   - Root cause: the WAF is an ALLOWLIST of compatible hosts/deployment IDs; Vercel cron by design targets the immutable deployment host; every production deployment therefore silently breaks the cron unless the allowlist is edited by hand. Two non-telephony production deployments today (PR #184 08:43 UTC, PR #186 09:13 UTC) were made without updating it. This is a process/architecture defect, not a one-off.
   - Impact: while the cron is blocked, nothing runs `runTelephonyCronJobs` (pending-effect recovery incl. `initial:` dial materialisation retries, termination retries, stalled ledger replay, Telnyx reconcile of dead legs, stale session finalisation, wrap-up sweeps), reminders, pause warnings, recording processing. In-request `after()` replays still cover the fast path (src/server/telephony/telnyx/event-processor.ts:341–354, src/server/telephony/call-action-route.ts:74–80, src/app/api/telephony/calls/active/route.ts:81). Not a cause of live call latency, but the last-resort recovery is off.
2. **Ring "all" dials operators sequentially; many DB writes before voice commands.** CONFIRMED in code (see anatomy below).
3. **playback_stop and gather_stop before bridge, ~5 s each on slow responses.** CONFIRMED in code: `onOfferAnswered` emits `stopMoh` → `playback_stop` (bestEffort) when `mohIsPlaying` (state ringing + ring.mode plan + mediaAvailable), then `gather_stop` when waiting/queued, then `bridge` (src/server/telephony/state/transitions.ts:1212–1218, 967–980). Commands execute strictly sequentially (src/server/telephony/state/effects.ts:1358–1394). Each Telnyx attempt is bounded by `TELNYX_COMMAND_TIMEOUT_MS = 5_000` and the operation by 12 s (src/server/telephony/telnyx/client.ts:42–43). A slow/failed playback_stop therefore delays the bridge by up to 5 s (+ its 5 DB round trips), gather_stop likewise. Telnyx docs (fetched today) do not say whether bridging stops an active playback; this is unknown and must be tested on own numbers.
4. **Mobile and transfer limitations.** CONFIRMED in code:
   - 4a: `MOBILE_VISIBLE_STANDBY_MS = 120_000`; `visibilitychange` hidden → `stopLocal()` (SIP registration dropped); `prepareForCall` must re-register with a 20 s timeout (src/lib/telephony/coordinated-webphone.ts:9, 293–311, 272–290). A mobile operator idle >2 min or backgrounded must re-register before answering.
   - 4b: colleague transfer/consult/add-party always resolves the colleague's WEB device: `requireLiveDevice({ ...deps, deviceKind: "web" }, …)` (src/server/telephony/call-actions.ts:266); `listTransferTargets` also reads only `motorist_operator_devices` (web) (call-actions.ts:902–916). Personal mobile numbers are only reachable through the manual "Externé číslo" path with owner detection (call-actions.ts:273–285). Owned-PSTN ring members are skipped with `feature_disabled` unless `TELEPHONY_STABILITY_V1_ENABLED` or the session has a stability contract (src/server/telephony/routing/ring-plan.ts:264–266); the flag is false in production.
   - 4c: the picker calls `onCallAction` and closes itself immediately (src/components/dispatch/PhoneBar.tsx:446–449); progress is only the bar's `busyAction` and a slow-notice after a delay (src/components/dispatch/useTelephonyConsole.ts:562–664).
5. **No representative measurements; 12 ended calls since activation, no consult/transfer.** NOT VERIFIABLE by me (no DB access from this sandbox; Vercel runtime-logs API refused the CLI token). Server-side timing exists: `motorist_call_events.normalized_payload.timing` (lease_wait_ms, processing_ms, effects_started_at) and per-command `effect_ms` (src/server/telephony/state/effects.ts:578–605, 140–143); HTTP `server-timing` headers with db/lease/provider/checkpoint counts+ms (src/server/request-metrics.ts). A read-only SQL report over these columns can produce the 30-sample distributions without new live calls.

## Anatomy of the inbound critical path on origin/main (contract 2, recording disabled, ring plan strategy "all")

Sequential PostgREST round trips are the dominant cost. Observed by OpenAI on 13 Sep: 44–72 DB operations per call action taking 7–13 s, i.e. ~150–250 ms per round trip (much slower than the ~1–2 ms SQL time of lease RPCs in pg_stat_statements; the gap is HTTP/gateway/PostgREST/pool overhead and lease waits). Reducing the COUNT of sequential round trips is the lever; per-round-trip latency should be measured separately (server-timing `db` count/ms).

`POST /api/telephony/telnyx/webhook` for `call.answered` of a ringing operator leg (route: src/app/api/telephony/telnyx/webhook/route.ts):
1. `createTelephonyDeps` → org lookup + telephony settings read (src/server/telephony/runtime.ts:60–77) = 2 round trips.
2. `claimWebhookEvent` RPC (event-processor.ts:236–248) = 1.
3. `findSession` (by sid) = 1 (event-processor.ts:81–108).
4. `ownedSessionWork` → session probe SELECT + `motorist_session_lease_acquire_v2` RPC, jittered retries up to 3 s for controls, 0 wait for webhooks/sweeps (session-runner.ts:433–474; webhooks use `leaseWaitMs: 0` at event-processor.ts:288 → immediate `SessionLeaseBusyError` → HTTP 500 → Telnyx retry) = 2.
5. `runOwnedSessionEvent`: `loadSessionSnapshot` (3 parallel) = 1 round; contract 2: `reconcileProviderEvent` ≥1; `motorist_provider_observe_dial_v2` RPC = 1 (session-runner.ts:538–543).
6. `loadRoutingContext` for state `ringing`: line + settings + recording policy (parallel) = 1 round; personal settings read = 1; presence/devices/open offers/leg count (parallel) = 1; incident recover throttled ≤1 (session-runner.ts:238–344). The answered transition itself needs only session/legs/attempts + settings (compensation fork uses `settings.parkMaxMinutes`); presence/devices/offers are only needed to plan further steps. There is no lean context for `call.answered` (lean contexts exist only for app hangup, known bridge observation and passive media events, session-runner.ts:209–237).
7. Pending-effect resume check / `cancelRevokedOffers` (session-runner.ts:574–595): ≥1 SELECT when entries exist.
8. Reducer (pure).
9. `applyReduceResult` → `stageEffects` RPC = 1 (continuation.ts:91–104) → `resumePendingEffects(priorityEntryId)`: fresh SELECT = 1 → `executeReduceResult`:
   - guard `reserveAnsweredOperator` RPC = 1 (effects.ts:1266–1321).
   - `persistTransition` critical phase with a fenced checkpoint UPDATE after EVERY effect (effects.ts:186–259, 210–222; continuation.ts:106–136): leg patch = SELECT+UPDATE+checkpoint (3); each attempt update = 2; each presence change = SELECT + `motorist_presence_transition_v1` RPC + checkpoint (3) (effects.ts:308–345). Ring of 3 operators: winner leg 3 + 3 attempts 6 + 2 loser presence 6 ≈ 15.
   - Commands sequential (effects.ts:1358–1480), per provider command: fresh session SELECT (1365) + `prepareProviderRequest` (= `motorist_session_lease_renew_v2` + `motorist_provider_command_prepare_v2`, 2) + Telnyx HTTP + `motorist_provider_command_result_v2` (1) + checkpoint (1) = 5 DB + 1 HTTP. `playback_stop`, `bridge`, N loser `hangup`s → 4 commands ≈ 20 DB + 4 HTTP, all sequential. `observeParticipants` after bridge (effects.ts:1473–1478) adds 3–4 reads/writes.
   - Projection phase (recording disabled): member touches, `upsertCallRow` (2 reads + write), `recordCallEvent` (read + insert), final checkpoint ≈ 8 (effects.ts:1628–1668).
10. `markWebhookEventProcessed` RPC = 1; response 200. Maintenance (correlated replay, incident recover, inline sweep of ≤2 overdue sessions) runs in `after()`.
Estimated total ≈ 55–60 sequential round trips + 4 provider HTTP calls for one answered event of a 3-member ring, consistent with OpenAI's measured 44–57 ops.

`ring_fanout` (effects.ts:1133–1228): `advanceRingStep` RPC + `current_step` UPDATE; `insertAttempt` per member (sequential INSERTs, 1147–1156); presence UPDATE; then `for (const dial of dials)` sequential: `renewLease` + `executeDial` (assertOwnership RPC, optional journal lookup, optional `authorizeOperatorDispatch` RPC, Telnyx `POST /calls` with prepare+result RPCs, `upsertDialedLeg` = prior SELECT + upsert + usage + attempt UPDATE + maybe session UPDATE (1064–1102), `cancelRevokedOffers`) ≈ 8–10 DB + 1 HTTP per member, sequential. The third operator's phone starts ringing only after ~25 round trips + 3 HTTP calls. `MAX_RING_FANOUT` caps members.

Outbound (call-actions.ts:306–342, 377–448): preflight parallelised (5 reads), `createSession` insert, then `ownedSessionWork` → `stageEffects` → `completeDurableInitialDial` → `resumePendingEffects` → dial with journal → `upsertDialedLeg` → projections. Customer leg dialled from `onOwnLegAnswered` with `bridgeOnAnswer`, `preventDoubleBridge`, `parkAfterUnbridge: self` (transitions.ts:1106–1166) → Telnyx bridges without an app round trip (measured 0–0.42 s).

Hold/consult/add-party (transitions.ts:2143–2159, 2318–2346, 2385–2417): lazy conference promotion = `conference_create` (operator leg) + `conference_join` (customer) + `conference_hold` (+ `dial` for consult/party) — 3–4 sequential provider commands each with 5 DB round trips. The inbound bridge is issued on the customer leg with `park_after_unbridge: self`, which is what protects the customer when the bridge ends during promotion (transitions.ts:2081–2094).

Transfer (transitions.ts:2255–2309): `transfer` command (or `dial` with link_to when controlled), `stopMoh`, unhold/leave when in conference, operator hangup.

Hangup (transitions.ts:2668–2699): hangup command per open leg (customer first), sequential; contract 2 commits `motorist_session_terminate_v2` before lease wait (session-runner.ts:477–481) and `reconcileTermination` (termination.ts) issues per-leg hangups.

Auth on every call-control POST and every poll: `supabase.auth.getUser()` (network call to Supabase Auth) + profile SELECT + org lookup (src/server/api-auth.ts:152–210, src/server/default-organization.ts) = 3 round trips before any telephony work; `createTelephonyDeps` adds the settings read.

Polling load: `/api/telephony/calls/active` every 750 ms per engaged visible tab (3 s when Realtime connected) (src/lib/telephony/poll-schedule.ts:29–56); each poll = auth (3) + settings (1) + `recoverOwnEndedSessionPresence` (1–2) + `loadActiveCalls` (5 parallel + 3 parallel) ≈ 8–9 round trips; the comment "server-side snapshot cache is 3 s wide" (poll-schedule.ts:33) has no counterpart in active-calls.ts (only stats.ts has a 5 s cache). 11 Sep counts: 13,509 `/calls/active`, 7,473 `/calls/history`, 4,614 monitor-invitations, 4,472 heartbeats per day. All of this shares the PostgREST pool with the call path.

Webhook amplification: Telnyx app `webhook_timeout_secs` = 10 (docs/operations/telnyx-setup.md:26); handlers observed at 17–31 s → Telnyx times out, sends to the failover URL (same deployment), whose claim returns `busy` → HTTP 500 → further retries. OpenAI measured 148 deliveries for 59 events (2.5×) on 13 Sep. Route `maxDuration = 60`.

## Telnyx documentation facts fetched today (developers.telnyx.com)

- Webhooks: retried on 408, 429 and 5xx; not retried on other 4xx; failover URL used when the primary fails/does not respond; `webhook_timeout_secs` 0–30; "Return 2xx immediately — acknowledge receipt within a few seconds, then process asynchronously"; delivery unordered, duplicates possible, simultaneous webhooks possible; "Commands with duplicate command_ids within 60 seconds will be ignored".
- Command retries page: "If your application receives a 500 error, immediately retry the command"; "If your application fails to receive a HTTP response from Telnyx within 500ms, send an identical command" with a unique `command_id` (UUIDv4 suggested).
- Dial: `link_to` shares the call session id; `bridge_on_answer` "automatically bridge answered call to the call specified in link_to" (link_to required); `prevent_double_bridge` "Prevents bridging and hangs up the call if the target is already bridged"; `park_after_unbridge: self` parks the current (dialled) leg after unbridge, link_to required; `timeout_secs` min 5 max 600; `command_id` dedupes Dial commands.
- Bridge: `play_ringtone`, `park_after_unbridge`, `hold_after_unbridge`, `prevent_double_bridge` ("prevents bridging if the target call is already bridged to another call"); webhooks `call.bridged` for both legs; NO statement about what happens to an active playback/gather on a leg that gets bridged.

## Unknowns

- Per-round-trip Supabase latency from Vercel fra1 (needs `server-timing` / `request-performance` logs; not accessible to me).
- Today's 12 calls: actual answer→bridge, transfer, hangup timings (DB not accessible to me).
- Whether Telnyx stops an active `playback_start` (MOH) when the leg is bridged (must be tested on own numbers).
- Supabase IO/pool charts (OpenAI: unavailable), Vercel concurrency.
- Whether the WAF allowlist has been updated since 14:41 UTC today.

## Constraints for any plan

AGENTS.md: dev-first workflow (dev → work branch → Preview → PR to dev → verify dev alias → PR dev → main); only this copy's Supabase/Vercel projects; never reference the original production project; no workers/listeners/schedulers; the single cron; migrations only when the user explicitly requests; Preview/dev share the live DB. Recording/announcements are not the priority but existing recording protections must remain. The user asked for a plan only — no code, config, DB or provider changes in this round.
