# Dispatch workspace v3 — review and activation

Implementation of `.omx/plans/dispatch-client-plan.md` v3, authorized after planning. This document records release prerequisites; it does not authorize a deployment or database write.

## Current delivery boundary

Code, migrations and isolated test fixtures are prepared in the dedicated dev-based work branch. No shared database migration, seed, telephony routing change or live provider call has been performed. Tests use fake provider APIs, disposable loopback PostgreSQL and an isolated browser fixture. Browser viewport coverage is not physical iOS/Android or standalone audio evidence.

## Schema and writer order

Read [the writer inventory](task-workspace-writers.md) before applying SQL. The migration filenames define their dependency order: profile identity boundary → personal notes → atomic case save → task workspace → notification privacy → PDF snapshot → workspace capabilities → the separate telephony policy/invitation migrations.

1. Inventory every permitted writer of **this copy**, including dev, Preview, production aliases and old browser sessions. Record deployed versions and exclude obsolete writers before enabling any migration that generates private notifications. Unknown writers block activation.
2. Arrange a coordinated schema/application rollout. The new case save and notification actions require their new RPCs. A Preview running before SQL is suitable for build and code review, but cannot establish working case saves or notifications against the old schema. The notification migration adds private per-recipient generations immediately; merely leaving the 0..N task flag off is insufficient to protect against old readers/writers. Do not claim a zero-downtime mixed-version rollout.
3. Only after explicit authorization, apply the reviewed migrations to this copy's Supabase project and refresh its schema cache. Keep task workspace activation and trainee monitoring disabled initially. Do not apply seeds or deploy workers/listeners.
4. Deploy/verify the compatible work branch Preview, then PR into dev. Validate the dev alias after merge. Record the actual writer inventory note and timestamp before separately enabling `motorist_task_workspace_settings.enabled`. Keep unknown deployments excluded. A production release needs a dev → main PR.
5. Validate real actor sessions: private notes and revocation, private bell rows, exact task links, task/chat retry, case CAS conflict and PDF download. Check existing callback/SMS obligations against the updated provenance rules.

## Private identity boundary

The profile-to-auth-user binding is part of notebook and notification authorization. The new first migration closes inherited direct browser profile writes while preserving profile reads and authorized service-side account management. Its trigger also rejects inherited column-level write grants. `tests/postgres/profile-identity.py` restores the actual older profile policies and broad grants before checking administrator denial, column-grant denial and service management. No client code in this repository writes profiles directly; existing account APIs remain the supported entry point.

## Telephony

Callback target configuration reuses canonical contacts. Both source and target phone changes invalidate directory verification. A dispatcher must explicitly confirm an alternate number; the server rechecks the policy and binds authorization to the precise callback request. An already observed, valid contact proof stays historical evidence even when the directory changes later. No history/caller identity rewrite is permitted.

The Numbers settings have an optional internal return-line target in existing line metadata. Leave it unset until the business DID, main line/front and greeting are verified. It uses the target line's greeting, IVR, business hours and ring plan without dialing the main public number. Invalid, foreign, inactive, chained and empty destinations fail before a new call can be misrouted. Existing operator-based statistics remain unchanged. A configuration failure is visible as a webhook incident and requires correction; it is not silently converted into a successful callback route.

Trainee monitoring is separately disabled by default. Activation also requires `TELEPHONY_STABILITY_V1_ENABLED=true`, so invited-monitor disconnects use the existing durable call effects. Disabling either gate blocks new invitations and acceptance; existing monitor sessions retain their durable teardown. A requested disconnect stays visible, with retry controls, until the exact monitor leg ends. Validate invitation acceptance, expiry, revocation and actual two-way listening on two operator devices plus the customer leg before activation. Confirm the trainee cannot transmit audio or control the customer call. Provider mocks do not establish physical audio behavior.

## Mobile/PWA pilot

Required devices: supported iOS Safari and installed PWA, Android browser and installed PWA. Check soft keyboard/orientation, 44px actions, 200% zoom, safe area and call controls. Exercise foreground/background push with case/task/chat/notebook drafts, delayed/missing ACK, expired session, offline save/reconnect, exact standalone/multiple-case task targets and PDF return to the same case. Do not infer these results from desktop viewport tests.

The worker never navigates an existing client after a missing ACK and never opens a duplicate call window on that timeout. A generic retry notification retains only safe navigation identifiers and remains bound to its original live document, including after a worker restart or a change in foreground tab. API responses, private note/chat text and PDF files must not enter the offline cache.

Closing a case keeps the selected editor mounted until explicit navigation, including when the dispatcher types another change during its status save. Reopening the same task from a new notification is a new selection intent. A chat refresh after a long pause retains a cursor through any gap in older messages. Changes to reminder channels update pending deliveries without creating a duplicate reminder event. Direct notification/reminder access also checks that the organization is still active.

## Recovery

Keep the latest compatible server and readers when disabling a new UI/feature flag. Do not drop task links, notebook/chat data, provenance or privacy protections to roll back the interface. Once new task identities and private notifications exist, reverting to an old server build is unsafe. Resolve a case revision conflict by reloading and reviewing the retained draft; never replace the stored revision with a guessed token.

## Evidence

The checked-in unit/API suites, `tests/postgres/` contracts and isolated `e2e/*-v3.spec.ts` / task-workspace / route-planner suites cover the implementation. `.omx/implementation-progress.md` records current runs and remaining checks. Local evidence files in `.context/` are intentionally ignored. Final review, Preview URL/build status and device/provider pilot results must be recorded before release approval.
