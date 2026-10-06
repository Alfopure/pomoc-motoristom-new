# Monitoring completion — TEST acceptance record

Scope: sanitised server errors and private server source maps, external check-ins
for the existing five-minute cron, observed operator-leg interruption alerts, and
correlated Telnyx voice-quality warnings. Production release requires separate
owner acceptance of the tested release.

The original application changes below are deployed and verified on stable TEST. Both real
compiled canaries reached the correct Sentry project with mapped source frames;
natural cron check-ins and the TEST-only SQL application are verified. The
controlled follow-up proved delivery of a repeated warning while its incident
remained open, followed by two natural successful runs and a delivered recovery
email. Missing-run detection was delayed again and remains unresolved.
Production deployment, configuration and SQL were not changed by this release.
The later readiness extension described below is a separate change requiring
its own fresh deployment and natural-run verification.

## Verified stable TEST deployment

| Item | Verified value |
| --- | --- |
| Canonical application | <https://test.dispecing.linkapomoci.sk> |
| Tested `dev` commit | `8de6f567e2aa2e105e7047c6e17fcc4cd6e4cce0` |
| Vercel deployment | `dpl_Hd3n6i4NiWGHNz16UxSJurCVS4qY` |
| Sentry release | `8de6f567e2aa2e105e7047c6e17fcc4cd6e4cce0` |
| Delivery PRs | [409](https://github.com/Alfopure/pomoc-motoristom-new/pull/409), [410](https://github.com/Alfopure/pomoc-motoristom-new/pull/410) |

Canonical live/ready checks passed. A final independent live check after the
canaries confirmed the same TEST commit and deployment. `/api/health/live`'s
`version` identifies the Vercel deployment; Sentry uses
`DEPLOYMENT_VERSION || VERCEL_GIT_COMMIT_SHA`. These identifiers must be checked
separately.

Processed Sentry readback at 12:18:25 UTC confirmed environment `test`, project
`4512181071446096`, the exact release above and zero processing errors:

| Runtime | Event ID | Mapped source |
| --- | --- | --- |
| Server | `659d405109fc4a258eca6b8b90777788` | `src/app/api/diagnostics/canary/route.ts:49:61` |
| Browser | `6e2e329d0837448c8b57938838fc1a7a` | `src/app/diagnostics/canary/CanaryButton.tsx:15:19` |

Hosted acceptance found and fixed the Next 16.3 `immutable/chunks` path in the
browser privacy filter. Both legacy and immutable hashed chunk paths are now
supported. Hosted private-map upload paths already match the immutable paths.
An unauthenticated request for the exact browser map returned HTTP 403,
`text/plain`, and a one-byte whitespace body with no map. This proves public
access was refused for that request. The separate build cleanup check found zero
maps in deployment output; a 403 alone does not prove physical file absence.

## Account readback (6 October 2026)

- Sentry organisation `alfopure`, EU ingest host
  `o4512180762640384.ingest.de.sentry.io`.
- TEST project `dispecing-test` / `4512181071446096`; production project
  `sentry-beige-horizon` / `4512180793638992`.
- Actual subscription: Developer (`am3_f`), free, 5,000 errors per billing period,
  one cron monitor and one uptime monitor. The TEST cron now uses the one cron
  slot; production uses the uptime slot. Readback after the first rehearsal
  confirmed one monitor/environment, one reserved/used cron seat and zero
  on-demand quantity or spend.
  Pay-as-you-go budget is zero. No subscription or billing change is part of this
  release.
- Production uptime detector `2335291` is enabled: canonical production
  `/api/health/ready`, GET every 60 seconds, ten-second timeout, two failures to
  open an incident and one success to recover. Workflow `1321342` covers first
  occurrence, recurrence and recovery for the existing owner recipient.
- TEST uptime detector `2335292` and workflow `1321343` are disabled. The free
  uptime slot is already used by production. The TEST cron monitor does not
  constitute a separate HTTP uptime check.
- TEST issue stream `2335227` uses workflow `1321295`, now enabled for first-seen,
  regression and high-priority events, with `frequency=5`, the existing recipient
  user `5033331`, and TEST-only scope. Production error workflow `1320958` remains
  enabled and unchanged.
- TEST project privacy readback: data scrubbing, default scrubbers and IP
  scrubbing are enabled; JavaScript source scraping is disabled. A TEST-only
  advanced rule removes `$user.geo.**`, including geographic enrichment added
  by Sentry after ingestion. Both final processed canaries above have no
  populated user identifiers or geographic values and retain their mapped
  frames. The rule does not retrospectively remove values from older events.

## Configured TEST cron monitor and runtime flags

- Monitor UUID `25d79ace-6af6-4c08-8016-1c6b4c4fde69`, slug
  `dispatch-test-telephony-cron`, detector `2368907`.
- Workflow `1339376` is enabled for failure, regression and resolution, with
  `frequency=0`, environment `test`, and the existing recipient user `5033331`.
- The original slug was restored at 13:17:52.544817 UTC after the follow-up.
  Final configuration readback at 13:18:22.800996 confirmed `*/5 * * * *`, UTC,
  two-minute check-in margin, three-minute maximum runtime, failure threshold 1
  and **recovery threshold 2**. Application Vercel cron scheduling remains
  unchanged. Two fresh natural successes and the recovery email are verified below.
- Synthetic baseline acknowledgment and check-in readback are verified. Monitor
  and `/checkins/` readbacks require explicit `?environment=test`: an unfiltered
  endpoint returned an empty result despite the confirmed TEST check-in.
- Explicit error, timeout, a genuine missed check-in and natural recovery were
  recorded. Detection latency and email delivery are detailed below; those
  results do not establish prompt detection or delivery of every warning.
- The verified dedicated TEST deployment has
  `DIAGNOSTICS_SERVER_ERRORS_ENABLED=true`, its TEST-only server DSN,
  `DIAGNOSTICS_SENTRY_CRON_MONITOR_SLUG=dispatch-test-telephony-cron`,
  `DIAGNOSTICS_CLASSIFIER_ENABLED=true` and
  `DIAGNOSTICS_CALL_ALERTS_SINCE=2026-10-06T11:39:19.452Z` active. Earlier copied
  calls are outside the new interruption-email activation window.

## Cron and notification evidence

Natural application run `d4ec7afc-3ba6-487f-a896-cee1f007da07` began at 12:30:18
UTC on the verified deployment and was recorded as `ok`. Application runtime
was 1,709 ms; Sentry duration was 1,710 ms. Runtime evidence showed
`executionStatus=ok`, `diagnosticsStatus=ok`, no failed jobs and 72 ms of
diagnostic maintenance. Thirteen historical telephony alerts were suppressed;
no business alert email was resent. This is a measured run, not a load test.

The first extended missing-run rehearsal produced check-in
`fd8f2bd4-3918-453a-b25c-34f46bf43462`: expected at 12:18 UTC, permitted latest
12:19, logical provider clock 12:19, database creation 12:28:44.571594. Detection
therefore occurred **9 minutes 44.6 seconds after the permitted deadline**.
Failure workflow fired at 12:29:35.990397; natural recovery was persisted at
12:30:50.396404 and its workflow fired at 12:30:53.479494. The monitor and issue
were healthy/resolved after that recovery. The precise provider-side cause of
the detection delay is unverified.

Read-only inbox inspection directly verified these messages on 6 October (UTC):

| Received | Evidence |
| --- | --- |
| 11:49:11 | `DISPECING-TEST-7` cron failure; also explicitly confirmed by the owner |
| 11:54:03 | `DISPECING-TEST-7` recovery from the initial failure/timeout rehearsal |
| 11:58:59 | `DISPECING-TEST-8` server-canary warning from the earlier TEST build |
| 12:17:57 | `DISPECING-TEST-9` browser-canary warning |
| 12:31:03 | `DISPECING-TEST-7` recovery after the missed-run rehearsal |
| 13:16:08 | `DISPECING-TEST-7` repeated missed-run warning; incident deliberately kept open |
| 13:27:36 | `DISPECING-TEST-7` recovery after two natural successes with recovery threshold 2 |

The earlier second failure warning for the first missed run was **not found**
in that inbox inspection. Workflow history records failure and recovery execution for the
same issue, but it exposes no per-email delivery receipt. The incident recovered
about 77 seconds after the failure workflow fired. The previous TEST project
email digest delay was 300–1,800 seconds; inspected upstream digest selection
can drop a warning for an already-resolved issue. This is a supported failure
mechanism supported by inspected upstream source, not proof of this particular
hosted delivery decision. The later warning receipt does not establish why the
earlier email was absent.

## Follow-up completed — notification delivery verified, detection delay unresolved

At 12:57:50 UTC, readback confirmed the **TEST project only** changed
`digestsMinDelay` / `digestsMaxDelay` from `300 / 1800` to `60 / 60` seconds.
Workflow triggers, the approved recipient and production settings were not
changed by this adjustment. A 60-second digest still does not guarantee delivery
of an issue already resolved before the digest is processed.

The controlled repeat began at 12:55:56.757922 UTC using the same monitor UUID and a
temporary rehearsal slug, with no new monitor, environment or synthetic
heartbeat. Its baseline was the natural 12:55:18 run; the expected next start
was 13:00 and permitted latest was 13:02. The five-minute schedule, two-minute
margin and three-minute runtime limit were unchanged throughout the repeat.
The application cron was not stopped and TEST calling configuration was
unchanged; only external observation of the TEST cron was temporarily interrupted.

Sentry created genuine MISSED check-in
`aebbdc5a-ff1f-4673-a75c-8d702a6cf11c` at **13:13:07.254714 UTC**, with logical
deadline `dateClock=13:02:00`: **11 minutes 7.255 seconds after the permitted
deadline**. The warning workflow fired at 13:13:37.181321. This reproduces the
late detection without changing the five-minute configuration or sending a
synthetic baseline. The provider's internal clock/queue telemetry is unavailable;
the exact backend cause remains unverified and the delay is **not repaired**.

The incident was kept unresolved until direct inbox inspection confirmed the
warning at **13:16:08 UTC**, linked to event
`b79f6143b5ca4c2ba8c67dd030c0b204` and incident `9150139`. The measured delay was
150.819 seconds from workflow execution and 14 minutes 8 seconds from the
permitted check-in deadline. The email channel is therefore verified for an
open recurring incident; the 60-second digest is not a 60-second end-to-end
delivery guarantee. Private acceptance evidence is
`.context/sentry-repeat-warning-outlook-evidence.json`.

The original slug was restored at 13:17:52.544817 UTC. Final configuration
readback at 13:18:22.800996 confirmed recovery threshold 2, with failure threshold
1 and all schedule/margin/runtime settings unchanged. Evidence is
`.context/sentry-delay-final-recovery2-applied.json`. Requiring two successes is
intended to leave time for the 60-second digest; it also deliberately delays
declaring recovery.

The first natural success after restoration is confirmed: check-in
`7c624af3-363d-4c0b-8f7e-de0688b2bbf4` began at 13:20:18, was persisted at
13:22:26.809815 and lasted 1,793 ms, matching application runtime. The monitor
remained in error and the incident remained unresolved, as required by the new
two-success recovery policy.

The second natural success, `5eec45b5-eba9-4f4f-8de7-6397c2a9678a`, began at
13:25:18 and was persisted at 13:27:09.184284. Sentry recorded 2,305 ms versus
2,304 ms in application runtime. The two newest check-ins are both `ok`; only
after this second success did the environment become healthy, the active
incident clear and issue `151688237` resolve. Recovery workflow execution is
recorded at 13:27:13.682282, and the recovery email was received at **13:27:36 UTC**
and directly verified in Outlook. Both check-ins occurred after restoration;
neither is an older queued or synthetic success.

This completes the repeated-warning and two-success recovery acceptance.
It does not repair the separately reproduced missing-run detection delay or
establish an end-to-end notification SLA. The owner subsequently authorized the
support report and, after the shared mailbox rejected sending, authorized the
connected Michal Michalek account. Outlook accepted the unchanged report from
`michal.michalek@alfopure.tech` to `support@sentry.io` at **13:56:26 UTC**;
its saved sent copy was verified. Narrow account searches at 20:13 UTC found the
sent report but no reply from support. This proves submission and the saved copy,
not receipt or investigation by Sentry. Private evidence is
`.context/sentry-support-send-status.json`.

No already-authorized independent heartbeat for dispatch TEST outside Sentry
is available in the audited configuration and records. The existing Healthchecks
resource belongs to BI; Better Stack/UptimeRobot dashboard allowlists and dormant
worker hooks do not establish a usable account or TEST monitor. The production
HTTP monitor remains unchanged. A new independent TEST check would require a verified account, isolated TEST
resource and measured failure/recovery delivery; no account, worker or paid
upgrade was added.

## Subsequent natural call-test incident (6 October, UTC)

The 19:50 and 19:55 runs reported `error` check-ins after ledger replay could not
correlate browser counterpart events. This was a real failed subtask, separate
from the delayed MISSED detector; it does not prove an audio outage. The owner
clarified that the perceived delay was button reaction/call connection.
The 19:50 check-in `15b201d8-925d-4894-a4db-c1d12f1ee924` recorded 17,679 ms,
matching application runtime; event `b36e8a248c3346b0aa5d35e371fcc996` belongs to
incident `9153438` in `DISPECING-TEST-7`. Direct Outlook inspection verified its
warning at **19:52:20** and recovery at **20:06:40**.

Natural successes at 20:00:18 and 20:05:18 satisfied the existing two-success
recovery threshold. Readback at 20:14 UTC showed another success at 20:10:18,
environment `ok`, no active incident, unchanged */5/margin 2/runtime 3/failure 1/
recovery 2 settings and TEST digest 60/60. Recovery proves subsequent cron
execution, not repair of the webhook correlation defect or reprocessing of all
dead-letter events. No incident was manually resolved for this check. Evidence:
`.context/monitoring-completion-current-readback-20261006.json` and
`.context/monitoring-completion-outlook-20261006.json`.

Sentry separately published a dashboard outage from 18:57 to 19:40 UTC. It did
not overlap the earlier midday MISSED rehearsals; the status report does not
establish a cause for their delay. [Provider incident](https://status.sentry.io/incidents/925b57x0v6xk).

## Prepared readiness fallback for the existing cron

This extension is default-off until deployed and verified on the identified
target. It does not repair Sentry's internal MISSED detection. It allows the
existing HTTP readiness probe to detect missing or failed cron completion,
without a second Sentry monitor, paid slot, worker, schedule or SQL migration.
The production HTTP monitor remains unchanged until the identified release is
approved. TEST has no active external HTTP monitor, so a TEST endpoint check
alone does not establish external failure/recovery email delivery.

- `DIAGNOSTICS_CRON_HEARTBEAT_ENABLED=true` enables a completion marker after
  the existing cron's telephony, reminder, recording and diagnostic jobs finish.
  It writes the final `executionStatus`, including `degraded`/`failed`, not the
  legacy business-alert health that can remain red for historical incidents.
- Storage is the existing service-only `motorist_worker_status` runtime table,
  under the dedicated primary key `dispatch-cron:{environment}:{projectId}`.
  The older one-shot runtime uses its own worker identifiers; no current app
  reader scans all rows. This adds one overwritten marker per environment,
  not a new worker process or a growing per-run ledger. Browser roles have no
  table access; existing service-role privileges already permit the write.
  The normal 300-second schedule exceeds the route's 120-second Vercel runtime
  limit. This marker is not a cross-request mutex; do not create overlapping
  manual cron requests for acceptance or use them as proof of scheduled health.
- The marker contains the build SHA, start/completion timestamps and execution
  status, with no call, user, phone or provider data. A failure after dependency
  setup records `failed`; a process killed before completion leaves the old
  marker to expire. An unconfirmed marker write does not change business work.
- `DIAGNOSTICS_CRON_READINESS_ENABLED=true` additionally requires a fresh `ok`
  marker in `/api/health/ready`. Missing, failed, degraded, invalid, future-dated
  or older-than-ten-minute completion returns the existing generic HTTP 503
  body. A successful run must have start <= completion and duration <= 120 s.
  A recent earlier build in the exact same project/database is accepted during
  normal rollout; requiring the latest build immediately would create a false
  alarm until its first scheduled run. `/api/health/live` is unchanged.
- Both paths require the exact app environment, Vercel project, Production
  target, `dev`/`main` branch, canonical origin and isolated database. Local and
  ordinary Preview cannot write a stable heartbeat. An explicitly enabled
  readiness check with an invalid configuration or disabled writer fails closed.
  The flags are independent of Sentry DSNs, credentials and cron capacity.
- Each write/read has a one-second abort and caller deadline, with no retry
  loop added. The read is one indexed primary-key lookup, parallel with the
  existing readiness database query. Cost is one small upsert per five minutes
  (288/day) and one extra read per readiness request (1,440/day for a single
  60-second probe, plus dashboard/manual requests). No Telnyx operation is added.

Activation sequence: deploy the writer with readiness still disabled; verify
the exact fresh deployment and a **natural** completed cron row, correct marker,
SHA, timestamps and execution status. Then enable readiness in a fresh build
and confirm canonical 200 with the real marker. Do not seed a synthetic healthy
row or treat missing storage as a startup success. Unit tests cover stale,
failed, missing and timed-out reads; hosted failure acceptance must not stop the
real telephony cron or change production without its approval. Disable the
readiness flag before disabling its writer during a planned rollback and make
a fresh deployment of the applicable current branch.

With the existing production HTTP probe, a stopped cron becomes unready after
the last completion ages past ten minutes; two failing 60-second checks then
open the uptime incident, subject to provider processing and email latency.
That is a separate detection path from Sentry Crons, but it still shares Sentry's
uptime/notification service. It is **not** an independent-vendor backup or a
guaranteed end-to-end alarm SLA. TEST endpoint acceptance and future production
external-notification acceptance must remain separate evidence.

## Remaining acceptance boundaries

The temporary canary capability is limited to the dedicated TEST deployment,
expires explicitly, and grants no application session or database/provider
access. Its browser permit is HttpOnly, short-lived and scoped to the canary
page. Anonymous and wrong-token calls were denied. The capability was disabled
in project configuration for future builds; the tested immutable deployment
had explicit expiry `2026-10-06T13:28:20.873Z`. A token-free POST at 13:29:35 UTC
returned HTTP 404 `not_found`, confirming that the expired capability is denied.
Configuration changes do not instantly modify an existing deployment; expiry
provided the cutoff for that immutable build. No further canary is needed to
repeat the cron/email test.

The cron acceptance must distinguish SDK/API acceptance, recorded check-in,
incident creation, workflow triggering, and actual receipt of email. Inbox
readback or the recipient's confirmation establishes delivery. Controlled
monitor rehearsals must not stop the real telephony cron or alter production
monitors.

Live two-way audio, HOLD, transfer and recording still require a real call test.
Quality warnings represent SDK observations; they are not proof of lost audio.

## Local validation

- 6,253 Vitest tests passed; two existing tests skipped.
- 67 Node contract tests passed; one optional test skipped.
- 29 browser regressions and one new voice-quality browser regression passed.
- The subsequent immutable-chunk fix passed 26 focused privacy/SDK/queue tests
  and seven Chrome diagnostic regressions, including native throws on both
  supported chunk paths.
- TypeScript, changed-file ESLint and whitespace checks passed.
- Full Next private-map build passed: 36 browser maps, 1,119 server maps; zero
  maps left in either deployment directory. Both compiled canary frames mapped
  locally to their original TypeScript source lines. Independent hosted
  processing and exact-release mapping are recorded above.
- Light server SDK `@sentry/node-core/light` is pinned to 10.53.1. Production
  dependency audit adds no advisories; the pre-existing Telnyx `uuid` moderate
  advisory remains (no high/critical findings).
- Classifier PostgreSQL contracts: 16 passed, one optional PostgREST HTTP test
  skipped. New SQL changes only two existing diagnostic functions, preserving
  signatures, service-only permissions, retention and 250+250 work limits.
- Auxiliary `apps/testovanie` isolation: the original Next 16.3.8 build failure
  was reproduced because the shared Turbopack root discovered dispatch's server
  instrumentation and resolved its aliases against the tracker. The tracker now
  declares its own no-op `src/instrumentation.ts`. Its build, TypeScript check and
  all 17 tests passed. The actual compiled instrumentation trace contains only
  the tracker hook and Turbopack runtime, with no dispatch/Sentry modules; its
  only export is `register`, and initialization sends no network requests even
  when the dispatch diagnostics flag is enabled. Dispatch imports and tracker
  deployment configuration are unchanged.

## TEST SQL application

The owner-approved SQL was applied only to Supabase TEST
`nzpnqdstvkfncflgqlny`; production was not changed.

- File: `supabase/migrations/20261011120000_diagnostics_call_environment_guard.sql`.
- SHA256: `ec90cfcd188bf0dc2c700b4409334c493d07aa6f97031f1dec7f210adaf65a3b`.
- Hosted migration: `diagnostics_call_environment_guard`, version
  `20261006113306` (6 October 2026, 11:33:06 UTC).
- Read-only postflight confirmed the deployed `pg_proc` function definitions
  match the approved SQL and the checked table row counts were unchanged.

The application acceptance above includes this TEST schema and activated
classifier. It does not authorize the same SQL on production.

The configured activation cutoff above excludes earlier historical calls.
At most 20 recent incidents and 80 evidence
rows per source are checked; truncation is explicit. Expect one extra database
read per health check without candidates, at most eight bounded reads with
candidates, and no extra reads when disabled. Existing TEST cron baseline at
11:00–11:15 UTC was 1.76–2.53 seconds per run, with diagnostic maintenance
64–111 ms; 13 historical alerts were suppressed and no new email was sent.
