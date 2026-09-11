# Deterministic SQL conflict retry incident — 11 September 2026

This change is limited to the Telnyx copy. The application accepts both `PT409` and legacy `40001` as domain conflicts, preserving HTTP 409 and unsaved case drafts. A separate explicit migration replaces 15 deterministic `RAISE 40001` literals in ten functions with `PT409`. Genuine PostgreSQL serialization failures remain unchanged.

Supabase documents that custom `40001` can cause infinite transaction retries in PostgREST 14; changing a function does not terminate already-running retry loops. See the [official incident guidance](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b).

## Verification before release

- All ten fresh live function definitions matched their repository definitions. The migration rejects missing or drifted definitions before replacing anything and accepts an exact already-patched definition.
- Disposable PostgreSQL 17.10 / PostgREST 14.18: 17 migrated checks passed; all 11 historical atomic-case checks passed. Live PostgreSQL is 17.6; the live PostgREST version is unverified.
- Two simultaneous writes: one HTTP 200 and one HTTP 409, exactly two database transaction attempts. Ten repeated stale writes: ten HTTP 409 responses and exactly ten transaction attempts. A conflict in a later related row rolled back all earlier related, case, event and audit changes.
- Catalog comparison verifies the 15 literal changes and unchanged signatures, defaults, owner, ACL, security mode and search path. The other nine functions have catalog preservation checks; their full business workflows were not recreated in the disposable database.
- Application gate: 3,439 Vitest tests passed (2 skipped); 43 Node tests passed (1 skipped), TypeScript and Next.js production build passed. The focused browser conflict test verifies retained draft, explicit reload and a single PATCH.

## Release and remediation order

1. Work branch Preview, PR into `dev`, verify the dev alias, then PR `dev` into `main`. Deploy compatibility to active writers before applying the migration to this copy (`ifpaeegaesdmljfkdvcn`).
2. Apply `20260929170000_domain_conflict_sqlstate.sql`; verify all ten current definitions and absence of deterministic `RAISE 40001`.
3. Correlate fresh Postgres error `process_id`, SQLSTATE 40001 and revision-conflict message with active RPC backends. Terminate only confirmed retry-loop backends. Historical PIDs, broad role termination and a database restart are not substitutes for that evidence.
4. Measure three 60-second intervals of rollback rate, connections and lock queues. Record release, migration and live verification outcomes separately; isolated tests are not a claim that the live incident is resolved.

At preparation time the connector could read database activity but could not retrieve Postgres error logs; direct logfile access was denied. Exact-PID remediation therefore still required fresh error-log correlation.
