# Call latency repair — 13 September 2026

Target: the isolated Telnyx dispatch copy, https://dispecing-test.vercel.app/.

## Observed production failure

Read-only audit of the 08:22–08:26 UTC test calls on the previous production version:

- Outbound start response: 7.442 seconds, 54 database operations.
- Manual incoming pickup response: 9.605 seconds, 57 database operations; the provider HTTP attempt took 0.440 seconds.
- An outgoing hangup response took 12.267 seconds, 72 database operations.
- An incoming operator answer preceded the bridge command by 16.230 seconds. Even a bridge confirmation with no outgoing command took 13.469 seconds and 44 database operations.
- The last incoming call committed its termination intent at 08:24:35.416. Only its operator leg was terminated. The customer leg remained connected until the caller hung up at 08:25:54.073, 78.657 seconds later.
- Recording, transcription and analysis were disabled. The affected calls had no recorders, recording barrier or pending recording audio. Intro announcements were also disabled. Disabling these features again would not repair the observed fault.

The primary bottleneck is application processing and session contention. Database aggregate durations may overlap; they must not be subtracted from total request duration. Provider request logger duration includes journal preparation; the separate request-performance provider step measures HTTP.

## Repair

- Explicit end sends BYE to the exact actor-owned browser leg immediately, alongside the authenticated server termination. A pending hold, transfer or pickup cannot disable end. Late results from superseded commands cannot clear the termination progress or replace its error.
- Incoming answer lets the SDK acquire the microphone directly in the click gesture. The extra open/close microphone preflight is removed for an existing incoming invitation; outbound permission and device-readiness gates remain.
- A persisted stop intent is resumed by the next session owner even if the original HTTP request timed out. The normal durable hangup transition covers the inbound customer as well as journalled outbound legs; the triggering provider event is still processed.
- Hangup no longer reads unrelated IVR, line, capacity or recording settings. Existing frozen recording evidence and required recorder stop behavior are retained.
- Successful outbound startup reuses its completed provider outcome and projection checkpoint while still checking that the exact browser leg exists and has not ended. Ambiguous or incomplete outcomes retain the original journal recovery.
- Effect checkpoints first try the current owned session version with compare-and-set, then read fresh state on a conflict. Other queued work and concurrent termination flags remain preserved.
- Ordinary provider commands avoid repeated wrapper-level lease renewals. The real provider boundary still renews ownership, atomically prepares the exact fenced command, and checkpoints its response. No authorization, destination, idempotency or live-send guard is removed.
- Already-answered silent bridge confirmations avoid unrelated routing reads; first/out-of-order bridge signals retain normal routing. Redundant continuation leg reads and final session reloads are removed only where a fenced checkpoint already returned the current row.
- The webhook acknowledges only after its provider work, durable effects and event ledger are complete. Bounded correlation recovery, incident recovery and sweeps use Next.js after() once the response can be sent and the session lease has been released. Direct cron/recovery callers still await maintenance inline.
- Call-route authentication imports its error class directly, keeping the unrelated dispatch mutation graph off cold call startup.

## Incoming routing configuration

The audited test line automatically offers calls only to Matej Kurinec. His production browser registration was stale and its token had expired. The current test actor, Michal Michálek, had a registered production phone but was not a group member. Therefore the line fell back to its waiting room without an automatic ring offer. This is distinct from processing latency. The desired recipient change is pending the user's answer; availability and routing permissions must not be bypassed.

## Verification and operating limits

The final local gate passed **3,721 Vitest tests** (2 existing skips), **43 Node tests** (1 existing skip), TypeScript, changed-file ESLint and diff checks. **60 Chrome scenarios** and a strengthened replacement-call regression passed. Independent review approved all final source changes, including stale CAS, preserved queue entries, uncertain provider outcomes, teardown races and recording/privacy boundaries. Complete deployed build results and deployment identity are recorded in the release PR.

A repeatable in-memory benchmark using the real provider client with mocked transport and a fixed 20 ms database delay measured the following request counts. This excludes HTTP authentication and webhook maintenance and is **not live carrier timing**:

| Scenario | Before | After |
| --- | ---: | ---: |
| Outbound startup | 53 | 43 |
| Operator answer → recipient dial | 42 | 34 |
| Recipient answer | 27 | 22 |
| Known bridge confirmation | 25 | 18 |
| External blind transfer | 48 | 37 |
| Cancel transfer | 60 | 39 |

Provider request counts are unchanged. The termination regression fails on the previous source and passes with this repair.

No database, migration, worker, listener, scheduler, Telnyx account setting or recording policy is created/changed by this patch. Real customer calls or SMS are not generated by automated verification. Physical audio and final carrier timing require a new live test on the released version; operation-count improvements are not a promise of a particular carrier ring time.

Release through work branch Preview → dev PR and alias verification → dev/main PR and requested-domain verification. Rollback uses the same branch workflow and requires no schema rollback.
