# Monitoring completion — TEST acceptance record

Scope: sanitised server errors and private server source maps, external check-ins
for the existing five-minute cron, observed operator-leg interruption alerts, and
correlated Telnyx voice-quality warnings. Production release requires separate
owner acceptance of the tested release.

Implementation status: local checks passed; hosted acceptance is pending. The
TEST server DSN and errors flag are configured for the next source deployment.
The owner approved the exact classifier SQL for TEST, and it has been applied
only to TEST as recorded below. Classifier activation and hosted acceptance are
separate steps. The initial Sentry OAuth permitted account reads but monitor
creation returned 403; the additional `org:write` authorization is now confirmed.
The rejected request created no monitor. TEST monitor/workflow configuration and
delivery still require verification; production configuration was not changed.

## Account readback (6 October 2026)

- Sentry organisation `alfopure`, EU ingest host
  `o4512180762640384.ingest.de.sentry.io`.
- TEST project `dispecing-test` / `4512181071446096`; production project
  `sentry-beige-horizon` / `4512180793638992`.
- Actual subscription: Developer (`am3_f`), free, 5,000 errors per billing period
  (42 used at initial readback), one cron monitor (unused at that readback), one
  uptime monitor (used).
  Pay-as-you-go budget is zero. No subscription or billing change is part of this
  release.
- Production uptime detector `2335291` is enabled: canonical production
  `/api/health/ready`, GET every 60 seconds, ten-second timeout, two failures to
  open an incident and one success to recover. Workflow `1321342` covers first
  occurrence, recurrence and recovery for the existing owner recipient.
- TEST uptime detector `2335292` and workflow `1321343` are disabled. The free
  uptime slot is already used by production. The TEST cron monitor does not
  constitute a separate HTTP uptime check.
- TEST issue stream `2335227` exists; its previous high-priority-only notification
  workflow `1321295` was disabled. Production error workflow `1320958` is enabled.

## Acceptance requirements

Record the exact `dev` SHA, canonical TEST deployment/version and Sentry event
IDs after deployment. A successful source-map upload is insufficient: both a
compiled browser canary and a compiled server canary must have mapped source
frames from that release. Capture only fixed synthetic data.

The temporary canary capability is limited to the dedicated TEST deployment,
expires explicitly, and grants no application session or database/provider
access. Its browser permit is HttpOnly, short-lived and scoped to the canary
page. Ordinary users, production and Preview cannot invoke the server canary.

The cron acceptance must distinguish SDK/API acceptance, recorded check-in,
incident creation, workflow triggering, and actual receipt of email. Only the
recipient can finally confirm inbox delivery. Controlled monitor rehearsals must
not stop the real telephony cron or alter production monitors.

Live two-way audio, HOLD, transfer and recording still require a real call test.
Quality warnings represent SDK observations; they are not proof of lost audio.

## Local validation

- 6,253 Vitest tests passed; two existing tests skipped.
- 67 Node contract tests passed; one optional test skipped.
- 29 browser regressions and one new voice-quality browser regression passed.
- TypeScript, changed-file ESLint and whitespace checks passed.
- Full Next private-map build passed: 36 browser maps, 1,119 server maps; zero
  maps left in either deployment directory. Both compiled canary frames mapped
  locally to their original TypeScript source lines. Hosted Sentry processing
  still needs independent verification.
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

This records schema application, not completed hosted monitoring acceptance.

Before activation, set `DIAGNOSTICS_CALL_ALERTS_SINCE` to the actual activation
time to exclude historical calls. At most 20 recent incidents and 80 evidence
rows per source are checked; truncation is explicit. Expect one extra database
read per health check without candidates, at most eight bounded reads with
candidates, and no extra reads when disabled. Existing TEST cron baseline at
11:00–11:15 UTC was 1.76–2.53 seconds per run, with diagnostic maintenance
64–111 ms; 13 historical alerts were suppressed and no new email was sent.
