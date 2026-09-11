Webhook retry contract 2 is installed by `20260929190000_webhook_retry_contract.sql`.
It keeps the existing `queued`, `processed`, and `failed` status values and adds
an independent retry state. `attempts` remains a count of successful claims;
it is no longer an effect-failure budget.

| Counter/state | Meaning |
| --- | --- |
| `delivery_count` | Incoming provider deliveries observed by v2, including busy/duplicate deliveries; internal cron/correlation replay does not increment it. Historical deliveries are unknown. |
| `deferral_count` | Proven pre-effect deferrals and unresolved correlation waits. |
| `effect_failure_count` | Processing failures after the safe pre-effect boundary; ambiguous outcomes are included conservatively. Five such failures produce an explicit dead letter. |
| `next_attempt_at` | Deferrals back off 500 ms, 1 s, 2 s, 4 s, then at most 5 s; processing failures use 30 s, 60 s, then at most 120 s. |
| `dead_letter` / `terminal_reason` | Explicit effect-failure limit, unresolved correlation after 60 s, or deferral age beyond 24 h. A terminal row cannot be reopened by a stale or legacy writer. |

These deadlines govern admission when another existing invocation occurs. They
do not add a timer, worker, scheduler, or listener. The existing five-minute cron
is the final recovery mechanism, so elapsed time alone does not guarantee an
immediate retry. New cron queries include historically exhausted `attempts >= 5`
rows and exclude only explicit terminal rows or attempts not yet due.

Allowed-connection events received before their session/leg exists remain in
`awaiting_correlation`, with age measured from their immutable first receipt.
A later event may replay at most two waiting events after its own processing and
ownership scope complete. It requires the exact call-control ID or our client
state's session ID. A shared provider session ID alone is insufficient to adopt
an unregistered leg. Credential-connection events never create customer sessions.
Replay recursion is disabled. Unknown rows expire with an explicit terminal
reason and incident; local tests do not establish provider redelivery timing.

Shared database deployment requires the following order:

1. Apply the additive migration to the authorized copy. Existing rows and original
   clients remain contract 1; a fresh legacy claim may complete normally.
2. Deploy the v2-capable webhook and cron entrypoints. A new client adopts a legacy
   row only after its claim is free/stale, and creates new rows as contract 2.
   An active legacy claim is returned as busy. All completion paths require the
   precise claim timestamp and use the atomic v2 finish RPC.
3. Route active traffic to compatible deployments before relying on the new
   behavior. A trigger rejects legacy status/ownership changes on contract-2
   rows, including unscoped late completion and attempts to reacquire them.
   Old clients may still recognize an already-processed duplicate. Rolling an
   endpoint back to legacy code cannot resume processing contract-2 rows.

The P2 ownership switch is separate. The processor scopes inbound child writes,
recording bookkeeping, runner work, and participant observations through
`ownedSessionWork`; it releases that scope before replaying or sweeping another
session. Neither migration automatically enables P2 new-session admission.

Validation commands, using disposable local PostgreSQL 17 at `127.0.0.1:55432`:

```sh
python3 tests/postgres/webhook-retry-contract.py
pnpm exec vitest run src/server/telephony/telnyx/webhook-ledger.test.ts src/server/telephony/telnyx/event-processor.test.ts src/server/telephony/cron-jobs.test.ts
```

The SQL suite verifies real concurrent claims, claim-CAS completion, terminal
monotonicity, eight deferrals without consuming effect failures, five processing
failures reaching a dead letter, correlation age/backoff, legacy drain/adoption,
legacy write rejection, and RPC permissions. Workflow tests cover exact early
answer replay, wrong-leg rejection, explicit unresolved incidents, and cron
classification. Provider commands are synthetic in those workflow tests.
