# Dispatch browser incidents

## Incident of 2026-10-02

Mário Salášek's three errors at 10:08:26, 10:09:12 and 10:09:37 CEST map to the same path: the case editor's dirty-state effect calls `setHasUnsavedChanges` in the dispatch console. The exact production React implementation throws depth error 185 on this path. The original message/code and first Safari stack frame were removed by the old sanitizer, so the exact historical Safari trigger was not recorded.

Production editor-presence rows subsequently identified case `11dd7fc1-d660-452b-9186-b31569c943b4` (PM-2026-0016), a replacement-vehicle case, across all three crashes. Its database `updated_at` remained 2026-10-01 07:41:26 UTC; this does not establish whether a local unsaved draft existed. Seven problem reports were durably accepted, sometimes after delayed uploads. The old fallback did not observe those later acknowledgements. Source maps worked; they were not the missing piece.

The code change removes callback identity and serialized draft changes as triggers for repeatedly publishing unchanged dirty/saving/header state. The editor publishes actual state transitions with the latest callback. A case-local boundary catches editor render/effect failures below the phone owner; retry remounts only the editor. An editor crash can still lose unsaved editor-local text. Exceptions outside this boundary still use the application fallback.

## Evidence captured after the change

- Sentry: first Safari frame, canonical numeric React code, safe compiler coordinates, release, application environment, browser family/version and opaque page/error IDs.
- Last committed UI state: screen, case UUID, workspace kind/mode, editor revision, dirty flag, save phase, conflict/replacement-only flags and collaboration availability/visibility/connection/staleness. Cleanup retains this snapshot for five seconds for a boundary; actor changes clear it. The state is explicitly labelled `last_committed`, not a recording of the failing render or typed input.
- Up to twelve in-memory operation starts/finishes with allowlisted operation/outcome, timestamp, duration and case UUID, including unsampled successes. These are sent only with a bounded Sentry exception and are cleared on account changes; they do not create extra internal operation uploads.
- Internal errors/reports: existing page/error/case/call UUID fields. A boundary report references the same error ID as its crash. Ingest still checks actor and resource ownership.
- Reporting UI: an immediate sending state, pending queue state, and a later explicit durable-ACK confirmation with ID. Pending clicks cannot create another report. Retries respect existing offline checks, Retry-After, backoff and the shared traffic budget. Rejection, expiration and logout cannot become an accepted report.

The client still uses bounded queues (200 events, 24-hour TTL), sampling for successful internal operations and transport limits. Browser process termination, offline expiry, rate limits or a disabled/unavailable DSN can reduce coverage. These bounds are not proof of complete capture of every possible failure.

## Production alerts to activate with the approved release

Read-only Sentry inspection on 2026-10-02 found workflow `1320958` disabled before the incident, connected to Issue Stream detector `2334678`. Error Monitor `2334677` had no workflows. Uptime workflow `1321342` was enabled and all 45 readiness checks around the incident succeeded. `/api/health/ready` proves server/database reachability; it does not execute the operator's JavaScript.

Keep the existing uptime rule and prepare a browser-error rule in `alfopure/sentry-beige-horizon` (project `4512180793638992`):

1. Edit disabled workflow `1320958`, connect only Issue Stream detector `2334678`, and name it **Dispatch production browser errors**.
2. Restrict it to environment **production** after verifying the new release actually supplies this environment. The dedicated TEST project's Production target supplies **test** from `MOTORIST_APP_ENV`; ordinary Preview also supplies **test**.
3. Trigger on a first-seen error, a regression, or an existing high-priority issue. Filter to error issue category (value `1`).
4. Send email to the same existing owner recipient as uptime: Sentry user `5033331`. Avoid issue-owner fallback, which depends on assignment/team membership. Set a five-minute per-issue action interval.
5. Activate only after the owner's production approval required by AGENTS.md. Re-read the saved workflow and detector connection. Check an actual new production event's environment and workflow evaluation. Email receipt remains unverified until it is observed; enabling a rule alone does not establish delivery.

The [workflow update API](https://docs.sentry.io/api/monitors/update-an-alert-by-id/) supports this configuration. This document prepares the change and does not mutate Sentry or send a test email. A canary that sends email needs an explicitly approved recipient/test. TEST must use separate Sentry resources; never copy the production DSN/token into Preview to complete a canary.

## Acceptance

Run the repository Vitest/typecheck/build gate, the real editor feedback test, collaboration/autosave tests, delayed-ACK/429/logout reporting tests, and the actual SDK outbound-envelope privacy test. The phone isolation test injects an editor failure while the real phone hook uses a synthetic SDK/media fixture and checks that registration, active-call identity, media tracks and SDK ownership survive failure/retry; this does not verify real provider audio.

Verify the merged `dev` commit and health version on `https://test.dispecing.linkapomoci.sk`. Exercise replacement-only case editing, saving, unrelated panel refresh and reporting there. Prefer the same Safari build as the operator. If Safari automation is disabled, record that limit and perform the remaining checks without claiming a Safari reproduction or acceptance. Release only the tested/owner-approved scope via `dev -> main`, including review of other pending `dev` changes.
