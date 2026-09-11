# Case save and refresh rollout

The current browser sends `x-case-response: detail-v2` on card GET and PATCH requests. These return only `caseDetail`, containing the editable card and timeline; task workspace data remains independently owned. Case GETs are scoped to the authenticated actor's organization and requested case. Fleet refresh returns `fleetData`, and all fleet panels in one tab share a pending request. Attendance and access users load when their modules open; the first page skips their data and detailed case/call history.

Already-open older browsers omit the case header. Their temporary compatibility response still uses the full dispatch DTO, with the authenticated actor passed through the request. This avoids forcing a reload that could discard a draft. Remove this branch only after old browser clients have drained. The performance guarantee of avoiding a whole-dispatch read applies to the explicitly negotiated new path. Both response paths preserve `committedRevision` plus `refreshRequired` when the read after commit fails.

Apply `20260929180000_case_mutation_reconciliation.sql` to this copy only, through the separately authorized migration workflow, before enabling the new browser save flow. It adds an overload; the existing seven-argument RPC remains available. It must follow the P0 domain-conflict migration. No migration is applied by unit, browser, or local PostgreSQL test commands.

A save carries a UUID and SHA-256 fingerprint of the original JSON payload, including its expected revision. The server checks a stored receipt before reading current case dependencies or validating previously accepted vehicle proof. The database serializes identical keys, rechecks active membership, performs the original atomic save, and stores the exact result in that transaction. Different payload/case reuse returns `PT422` / HTTP 422 `CASE_MUTATION_MISMATCH`. Foreign revisions retain HTTP 409 `CASE_REVISION_CONFLICT`. Unknown outcomes retain the same key and request body; newer typing waits for reconciliation before another save begins.

Receipts are private and retained. Do not truncate them as a routine cleanup: deleting a receipt permits key reuse. A future retention policy needs an explicit replay-expiry contract. Rollback must preserve the receipt table, overload, and P0 nonretryable domain SQLSTATEs; prefer a compatible forward fix while new browser clients remain open.

Reproducible isolated checks:

- `python3 tests/postgres/case-mutation-reconciliation.py` creates a unique disposable database on local `127.0.0.1:55432`, tests concurrency, replay, revocation and rollback, then drops that database. It never uses application credentials.
- Vitest suites in `case-detail*.test.ts`, `case-mutation-replay.test.ts`, case/fleet API tests, `dispatch-module-reads.test.ts`, and `fleet-refresh-client.test.ts` use fake clients.
- `e2e/case-cockpit-v3.spec.ts` bundles a local fixture and intercepts every request. Lost-response tests assert identical retry IDs/bodies, draft retention and the next committed revision; no shared database writes occur.

No latency claim is inferred from these tests. Production p95, payload bytes, background request reduction and cold starts still require the plan's separately coordinated measurements. `Server-Timing` and `x-request-id` are available on the case and fleet routes.
