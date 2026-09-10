# Dispatch workspace v3 — implementation evidence

User-authorized implementation of plan v3, R01–R16 / AC01–AC25. Work branch `feat/dispatch-workspace-v3` starts from `origin/dev` at `fb0e1381fb3c89c850451104fa3afe52d63ac6df`. Remote schema changes, physical device/audio validation and release activation remain separate prerequisites.

| Area | Delivered implementation and isolated evidence |
| --- | --- |
| Case editor | Unified status/priority and autosave, atomic case RPC with revision conflict checks, single SMS history, collapsed location map. 20 case browser scenarios and actual PostgreSQL rollback/concurrency/closure contracts passed. Root console completion/newer-typing regression also passed. |
| Workspace/mobile | Shared task, notebook and route state; optional ordered widgets; collapse/restore; tools accessible at all breakpoints. 17 full-console and 44 additional case/task/route/provider browser scenarios passed; coverage includes 360–1440 px, drafts, notification navigation, capability changes and archived-case return. Physical soft keyboards and installed PWA remain pending. |
| Private data | Owner-only notebook writes, explicit read shares and bounded revalidation; profile identity boundary; actor-scoped notifications with recipient and active-organization SQL protections. Actual local historical policies/grants and negative role matrices passed. |
| Tasks/chat | Canonical stable task IDs with 0..N cases, immutable source records, ambiguous historical source locking, CAS and guarded legacy adapters; idempotent chat and gap-safe pagination. Isolated concurrency, API and browser tests passed; deployment writer inventory is required before activation. |
| Reminders | Transactional generation lifecycle, independent reminder time, channels-only changes, private assignment bell and durable push outbox. Combined actual-schema SQL contracts cover rollback, duplicates, reassignment, leases and unauthorized access. External delivery is untested. |
| PDF | Authorized private snapshot RPC, real bundled Chromium A4 renderer with local fonts. Six renderer/API tests and five actual PostgreSQL snapshot tests passed. Local long document: 50 pages, 131802 bytes, warm 640 ms, zero remote requests. Preview/runtime and device download validation remain pending. |
| Telephony | Verified alternative callback targets and exact request proofs; internal return-line configuration; explicit receive-only monitor invitations with durable disconnect prerequisite. 80 focused provider/reducer tests and 8 invitation browser checks passed. Configuration and real three-party audio remain activation gates. |
| PWA | ACK-before-guard handling, exact task intents, no timeout navigation or duplicate window, retry affinity to original live document, private API/PDF cache exclusion. Worker/navigation 45 tests passed after final retry correction. |

## Verification checkpoints

- Initial baseline: 2902 Vitest tests passed.
- Final complete integrated run: 3232 Vitest passed, 2 skipped; 40 Node tests passed, 1 skipped. Production build, typecheck and ESLint across 169 changed JS/TS files passed. The final SQL-only provenance amendment passed fresh actual PostgreSQL checks after this build.
- All 13 original disposable loopback PostgreSQL programs/contracts passed: profile identity, atomic case save, PDF snapshot, monitor invitation lease, callback target proof, task source/system writers, notebook concurrency, task concurrency, notebook ACL, task workspace, notification privacy, combined reminders, assignment delivery.
- Notification, combined reminder and assignment contracts rerun after final channels/disabled-org fixes: passed.
- Final source-evidence boundary: fresh SMS provenance (including inherited broad/column grants), task workspace, assignment/combined reminder contracts and system-writer/concurrency programs passed. Historical metadata cannot enter a trusted source category by an intermediate edit. Direct browser source writes are blocked; existing service/definer workflows remain supported.
- Independent reviews found and prompted fixes to case-editor lifetime, task selection/canonical state, private recipients, assignment delivery, PDF identity, archived mobile return, chat pagination, SMS provenance and monitor teardown. UI/PWA, notification/task-store and invited-monitor teardown re-reviews approved. Final SMS provenance/source-write amendment reviewed without remaining concrete blockers and retested on fresh PostgreSQL.

Logs and local artifacts live only in ignored `.context/`. Tests use fake provider/network APIs and disposable PostgreSQL at `127.0.0.1:55432`; no shared database or live calls/SMS/email/push were used.

## Delivery and activation

Draft PR into dev and this copy’s Vercel Preview inspection are pending final checks. The [rollout document](../docs/rollout/dispatch-workspace-v3.md) and [writer inventory](../docs/rollout/task-workspace-writers.md) describe coordinated application/schema rollout. A pre-migration Preview cannot establish working new case saves, private notifications or PDF against the old schema.

Outstanding acceptance evidence: authorized migration/activation and real actor-session checks, actual long PDF rendering on Preview, supported iOS/Android browser and installed PWA checks, push/email delivery, configured return-line calls, three-party monitor audio and client pilot feedback. These are not claimed passed by viewport tests or provider mocks. No dev merge or production release has been performed.
