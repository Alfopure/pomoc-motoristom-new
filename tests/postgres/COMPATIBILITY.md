# Local compatibility and rollback exercise

Run from the repository root with dependencies installed and the existing local PostgreSQL 15 cluster listening on `127.0.0.1:55432`:

```sh
node tests/postgres/compatibility-build.mjs
node tests/postgres/compatibility-run.mjs
# Verify inherited network-address overrides cannot redirect either connection:
PGHOSTADDR=203.0.113.1 node tests/postgres/compatibility-run.mjs
```

Python requires `psycopg[binary]`. The bridge recreates only the dedicated `stability_compatibility` database. It ignores application database environment variables, pins both `host` and `hostaddr` to loopback with a five-second connection timeout, and has no remote connection setting. An inherited `PGHOSTADDR` cannot redirect the fixture. Setup reports and checks `inet_server_addr()` for both bootstrap and fixture connections before destructive work. Bundles and source provenance are written under `.context/compat-*`; they are generated artifacts.

The oldest compatible source is `6c314610327d383f95e381c9fa30422d89fe57ad`, the first stability contract commit. Its parent has no compatible return-context/effect-journal contract and is not a permitted rollback target. The build extracts that exact Git archive and separately bundles the candidate working tree. The first passing candidate was `3766803898da4c515a9d25a872488a8f67d5bbad`: its application source is unchanged from the baseline; its additional owner-index migration is installed in the fixture. This verifies an additive-schema rollback boundary, not compatibility with the pre-contract application.

Nine assertion groups exercise actual application services and event processors:

1. Candidate `setCallOutcome` creates a scheduled callback; `pickupWaitingCall` creates a paused pickup and durable return context.
2. A fresh baseline runtime reads the same PostgreSQL rows and handles answer plus the exact bridge observations. A real PostgreSQL audit trigger rejects fulfillment and leaves the callback open with a saved proof/continuation.
3. Turning creation off and reloading baseline callers preserves the physical fake connection and return context. Callback scheduling is disabled and another callback API request adds no new contract or schedule action.
4. Baseline hangup processing retains terminal pending audit and the owner return. Under this persistent audit fault, presence release may also remain pending; this exercise does not claim immediate wrap-up during the fault.
5. After removing the fault, one baseline cron at application time +5 minutes completes the historical proof, callback resolution, exactly one fulfillment audit, and deferred presence release. It issues no new dial/bridge/recording/playback/gather commands. Any remaining hangup commands are terminal cleanup.
6. A baseline wrap-up sweep restores the original pause/reason exactly once; history contains no available interval. PostgreSQL uses its real clock, so this step places the stored wrap-up deadline one second in the past rather than pretending the application test clock controls SQL `now()`.
7. Baseline creation-off pickup rejects a new call. The actual console sweep function processes its overdue ring step and does not dial the configured legacy pause mobile number.
8. Repeated baseline cron recovery leaves one fulfillment audit and does not reopen the callback.
9. A fresh candidate-created pickup/callback reaches `wrap_up` with a saved proof, failed audit and owner return after the customer hangs up; the operator hangup webhook is withheld. At +121 seconds, a fresh baseline console sweep discovers that exact stale session, completes callback/audit and owner release, and ends its remaining leg rows without restarting audio. The baseline console end-wrap-up service restores the original pause. Repeating the sweep does not revisit the ended session or duplicate the audit. This is a separate scenario, so it does not replace the independent five-minute cron recovery evidence above.

## Evidence limits

- Presence, staged transition, scheduling, obligation, linking and fulfillment RPCs use the exact SQL from the presence, durable-effects and callback migrations against real relational tables. Writes commit to PostgreSQL; fresh runtime instances reload those rows. The additional owner-index migration runs against a minimal member table. The complete mobile configuration migration is covered separately by `mobile-contract.py`.
- The fixture reuses the existing FakeSupabase query builder for filtering/projection and legacy foundation RPC semantics. Mutations are persisted to PostgreSQL; new contract RPCs execute real SQL and refresh the adapter. This does not test PostgREST, RLS, all production constraints, or concurrent runtime writers. Existing PostgreSQL contract tests supply separate locking/permissions evidence.
- The two application bundles use independently created harness/dependency instances. They share the synthetic provider object to model a provider connection surviving runtime replacement. This is a local runtime handoff, not an operating-system process restart or a deployed Vercel rollback.
- `setCallOutcome` uses a local admin-client factory and a stubbed final dispatch-data response. HTTP authentication, cookies, route hosting and provider signature verification are outside this exercise. The business logic, webhook event processor, cron and console sweep implementations are actual source from the selected versions.
- Provider behavior, numbers and bridge observations are synthetic. Global HTTP fetch is blocked. No shared database, provider API, real phone or deployment is touched. Passing this exercise supports local MG-01/MG-03 evidence only; it does not satisfy platform exclusion MG-02 or real-device QA.
