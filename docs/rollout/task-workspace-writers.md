# Task workspace writer inventory and activation gate

This inventory concerns only this repository's separate dispatch copy. No remote inventory, migration, flag change, worker deployment or production activation has been performed. SQL fixture approval notes apply only to disposable local databases.

`motorist_task_workspace_settings.enabled` defaults to false. Enabling requires a nonempty `writer_inventory_note` and `writer_inventory_verified_at`, writable only by the migration/database owner. These fields record an explicit deployment audit; they do not discover or retire deployments automatically. Every permitted dev, Preview and production writer must be a compatible version before activation. Revoke/disable older permitted writers first. If any writer remains unknown, leave activation off.

| Writer | Compatible behavior | Boundary checked |
| --- | --- | --- |
| `motorist-mutations.ts` explicit create/update/complete/delete/callback-delay case actions | Adapter calls the same actor/session task RPC, with case-link authorization and revision, before the old workflow writes. | New task transaction controls task, links, audit, reminder triggers and delete cascade. |
| `motorist-mutations.ts` descriptor/assignment task creation | Creator/session and capabilities preflight precedes parent writes; shared insertion uses the result. | Capability errors and creator mismatch stop before parent side effects; the parent workflow remains multiple transactions. |
| `motorist_create_callback_obligation_v1` | Existing function is preserved behind an inaccessible private copy; only its public service-only wrapper receives the task write context. | Existing session lock and stable callback request/task mapping remain; trigger records proven origin. |
| `motorist_resolve_callback_v1` | Wrapper preserves existing claim/proof checks and transaction. Completion checks immutable callback origin, independent of editable kind. | Only the exact linked task may complete; other open obligations continue to block completion. |
| `motorist_schedule_callback_v1` | Existing action UUID dedupe remains. When workspace enabled, it ensures one task from the persisted callback request in the same transaction. | Retry cannot produce another task or reuse a title-matched task. |
| `telephony/state/effects.ts` callback creation | Server-owned setting selects the existing obligation RPC even if the older telephony stability flag is off. | Selection occurs before legacy callback/task writes; orchestration retains failures for existing recovery. |
| `telephony/callbacks.ts` request resolution | Server-owned setting selects the existing exact resolver before legacy callback status/audit/broad task closure. | No by-case/kind closure on the active path. |
| `telephony-workflow.ts` callback outcome | Server-owned setting selects the existing scheduling RPC before historical outcome/event writes. | Requires real actor/action UUID; skips legacy title-matched task creation. |
| `sms-workflow.ts` accepted ETA completion and accepted-row retry | Source helper calls `motorist_complete_task_source_v1` with the persisted SMS ID. | Exact original task/case/source match, ETA template, accepted provider state and provider ID; no client-supplied task override. |
| `location-share-links.ts` accepted public location | Source helper calls source completion with the accepted submission ID after the link is used. | Accepted submission, same org/case/link, expiry and immutable location-link origin; supported but unproven result never falls back to title matching. |
| Reminder lifecycle/materializer/actor notification actions | Notification migration provides transaction-local lifecycle and explicit actor-action RPC contexts. | Direct old cancellation/read/archive preliminary writes are rejected once enabled; private recipients are not globally marked read. |
| Ad hoc SQL, old deployments, obsolete scripts | Direct legacy task INSERT/UPDATE/DELETE is rejected when enabled, except trusted internal triggers. | This is defense in depth, not proof that external side effects of an unknown old writer are safe. |

`motorist_complete_task_source_v1` accepts only `sms` or `location` plus a source record ID. It grants execution only to `service_role`, validates any supplied actor, and derives the exact task from immutable provenance and durable source evidence. An absent proof returns `completed:false`; it cannot authorize a broad fallback. Callback source wrappers are not general-purpose task write RPCs. Their private base implementations have no application-role EXECUTE grants. The normal task API remains session authenticated.

A location link created by the SMS location workflow has its own stable origin type `location`; its task/case identity is captured from the explicit link metadata and same-org relational match. Callback, SMS and location identities survive case/task deletion as cancelled origin history. Only queued SMS obligations are cancelled; delivered messages remain historical facts.

## Local evidence

- `tests/postgres/task-workspace-contract.sql`: exact link backfill, proven/ambiguous origin matrix, default-off and verified-inventory check, active legacy DML rejection, 0..N links, CAS rollback, explicit unlink, chat idempotency/50-message pagination, case-deletion preservation and source cancellation.
- `tests/postgres/task-workspace-concurrency.py`: real row-lock ordering for stale edit conflict, simultaneous same-message retry and edit waiting behind full deletion.
- `tests/postgres/task-system-writers.py`: installs the exact earlier callback migration, then tests the compatibility wrappers, edited-kind completion, callback scheduling retries, nonleaking write context, accepted ETA proof and accepted location proof.
- `src/server/task-system-gate.test.ts`, `task-system-writers.test.ts`, `telephony-workflow.callback.test.ts`: server flag routing, no fallback on configuration errors, selection before legacy effects.

The combined notification migration tests must also pass before activation. Local fixtures do not establish the actual deployment inventory, provider delivery, websocket lifecycle, or physical-device/audio behavior. Review the inventory against every writable deployment of this copy, record the specific versions and their exclusion/authorization evidence, and only then consider an explicitly authorized activation.

## Prepared code and database deployment order

The prepared build is **not fully functional against the previous schema**. The case save path requires `motorist_save_case_atomic`, and notification actions require the new actor-scoped notification RPC. Their absence must not route a write through an older non-atomic or broader notification mutation. Notes/tasks/PDF capability flags hide unavailable surfaces; those flags do not make all older database schemas compatible with every server mutation in this build.

No deployment or database operation is authorized by this document. When separately authorized for this copy, use a coordinated deployment window:

1. Finish the local build/test gate and review every pending SQL file. Migration version prefixes must be unique. Run the combined migration fixtures, including the earlier callback contracts and reminder tables. Keep task activation disabled.
2. Inventory all writers against this copy's shared database, including dev, accessible Previews and production. Suspend their writes during the schema/application transition. A migration running successfully does not establish that an older deployed writer is safe against its new triggers.
3. Apply the complete reviewed, ordered SQL set only to this copy's verified Supabase project. Check required function signatures/ACLs and settings; `enabled` must still be false. Do not independently activate a task flag halfway through the migration sequence.
4. Deploy the compatible branch Preview through the repository's dev-first workflow, then the PR to `dev` and verify its alias. A pre-migration Preview may render or pass isolated fixtures, but its normal case saves/notification actions must not be advertised as working. Development and Preview share a real database, so any live mutation verification needs separately authorized test records.
5. Upgrade or retire every remaining writable deployment before considering 0..N tasks/chat activation. Release this copy's production only through the required `dev` to `main` PR. Record specific compatible versions and exclusion evidence in the writer inventory; this has not been verified remotely.
6. Only after the complete inventory, migrations and compatible runtime checks pass, separately authorize recording inventory fields and enabling tasks. If any writer is unknown, leave tasks disabled. Setting `enabled=false` later is not a data rollback: independent/shared tasks and chat may already exist, and an old application cannot safely represent those records.

No worker, listener or scheduler deployment belongs to this change. Existing permitted cron behavior is unchanged.

## Retry and preliminary-write checks

Accepted ETA retries consult the original provider-accepted row and rerun only the exact source completion RPC. They do not send another SMS or create another attempt/timeline record. A reused request with a different fingerprint fails before reconciliation. A failed or uncertain send without a provider message ID cannot complete a task. Only an absent RPC enables the pre-migration exact-ID fallback; transient failures and installed `completed:false` never do.

A used location link can retry only its already accepted normalized coordinates/accuracy. Recovery uses the existing submission/location ID, completes only its proven task and repairs its timeline/notification effects with stable IDs/dedupe. Different coordinates, revoked links or a used link without matching accepted evidence remain rejected. No second location/submission or incident-location replacement is made.

Explicit task completion/deletion is routed before old reminder cancellation, personal notification state, timeline or task writes. Descriptor/assignment creation preflights server capabilities and the actual authenticated creator before parent case/fleet writes, then passes that result into shared insertion. The assignee is never used as an inferred author. The parent assignment and task creation are still separate transactions; a database outage after successful preflight can leave assignment committed before task creation. Full atomic assignment is outside this task workspace migration and must not be claimed here.

The narrow tests are `legacy-task-adapter.test.ts`, `motorist-task-gate.test.ts`, `task-source-completion.test.ts`, `sms-workflow.test.ts` and `location-share-links.test.ts` under `src/server/`.

## Immediate assignment notifications

The notification migration now persists an immediate private assignment bell
and push outbox row in the task transaction. Their key contains task ID,
assignment generation and recipient. The assignment generation changes only
when the assignee changes; title/deadline edits do not repeat the event. A task
without a deadline still generates this event. Future due/custom reminders
remain separate, and senior dispatchers are eligible for both direct assignment
and team reminder delivery.

The legacy assignment helper delegates to the same database event rather than
creating a second timestamp-keyed notice. Successful task API mutations attempt
immediate push delivery; the existing reminder materializer and permitted cron
also drain the outbox, even when there are no due reminders. Service-only leases
bound delivery batches to 50 and retries to five with backoff; crashed leases
recover after ten minutes. Reassignment/completion cancels stale pending work,
and the claim rechecks active organization, profile role, current recipient and
unread notification state. No new scheduler is introduced.

Bell insertion is transactionally deduplicated. External push is at least once
across an ambiguous crash or partial provider acceptance; retries reuse the
notification ID/browser tag, and no exactly-once external delivery is claimed.
A task/bell already committed stays successful if the immediate push handoff
fails: the durable outbox retains retry state. Physical push delivery remains
unverified without an explicitly authorized live/device check.

## Explicit SMS task association

SMS preparation no longer chooses an ETA/location task by its editable title.
The composer offers an optional explicit task choice and defaults to no task.
The server checks its organization, original case, open/overdue state and any
existing immutable workflow origin, both at preparation and before the first
provider effect. A callback or conflicting SMS obligation cannot be repurposed
by changing its title. Explicit original-case associations remain usable on the
older schema; missing origin tables are the only compatibility exception.

New signed previews record `taskAssociation: explicit`, and persisted SMS/link
metadata records `task_association: explicit` when a task was chosen. A new
unattempted send using an older task-bearing preview requires a fresh preview.
Already accepted retries retain their durable original request and never resend.
New location links also preserve an explicit no-task choice, including before
the source-completion RPC is installed.

The historical title heuristic is not justified by plan 4.4, which requires
proven source identity independently of mutable title/kind. Old unmarked
`raw_payload.task_id` and location metadata do not reveal whether selection was
explicit or heuristic. The task migration now leaves those source records out
of proven origins and conservatively locks their otherwise unproven tasks as
ambiguous. Raw historical payloads and task completion state remain unchanged.
The source-completion RPC also requires the explicit marker, so accepted but
unmarked historical SMS/location evidence cannot automatically complete a task
once the migration is installed, including before workspace activation.

Source capture applies the same rule to a legacy writer after migration. An
existing source cannot acquire/change its explicit association marker or task
ID afterward. A new explicit operator choice may create a new proven source for
the exact original task; it never retroactively promotes the old record. The
rollout inventory can review ambiguous obligations deliberately. No remote
inventory or historical data repair was performed.

`tests/postgres/task-sms-provenance-contract.sql` verifies marked versus unmarked
backfill, raw-history preservation, flag-off/active completion rejection,
metadata-laundering denial and valid explicit-source completion. The ordinary
task and exact callback/SMS/location system contract suites also pass with these
stricter proofs.

The source guard validates task ID, explicit marker, workflow category,
direction, organization and original case before any non-workflow early return.
Existing non-workflow rows cannot enter a trusted category later. The legitimate
case-deletion nulling path remains explicit. Browser INSERT/UPDATE/DELETE grants
are revoked on SMS, location links/submissions and callback sources; an invoker
trigger additionally rejects inherited column privileges and client-set GUCs.
Only service-role writes and validated security-definer workflows running as the
migration owner may mutate source evidence. The provenance contract reconstructs
historical org-member FOR ALL policies, broad grants and an inherited column-grant
role; it verifies category/direction escapes and browser provider/acceptance
forgery are rejected while the exact existing callback/SMS service suites pass.
