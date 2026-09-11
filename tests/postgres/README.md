Presence contract verification uses a temporary PostgreSQL 15 database on `127.0.0.1:55432`. It has no remote connection setting. The fixture contains only the tables and roles needed by the exact presence migration; this is not a full Supabase reset.

`POSTGREST_BIN=/path/to/postgrest python3 tests/postgres/domain-conflict-sqlstate.py`
verifies the domain-conflict migration against a disposable PostgreSQL 17 database
on that loopback port and a temporary PostgREST server bound to `127.0.0.1`.
It requires `psycopg[binary]`; it never loads application credentials. Use a
PostgREST 14 binary to cover the affected major version. This is an isolated
surrogate, not evidence of the hosted project's PostgREST version.

The test compares all ten historical function definitions with the migration's
result and requires exactly fifteen SQLSTATE literal changes, with signatures,
defaults, owners, ACLs, security and search paths preserved. It checks drift
rejection and idempotency. Only case-save has a full executable business fixture;
the other nine functions are installed with deferred body checking for exact
catalog comparison. The inherited case-save tests exercise authorization,
revision checks, row locks, atomic related writes, audit rollback and concurrency.
Real HTTP checks cover competing writes, repeated stale writes and a conflict
after an earlier related update. A nontransactional pre-request sequence counts
transaction attempts, so a fast HTTP response alone is not mistaken for proof
that no retry occurred. A separate real serializable transaction conflict must
still raise PostgreSQL `40001`.

Run `python3 tests/postgres/presence-contract.py` after installing `psycopg[binary]` and starting the local cluster. The script recreates only `presence_contract`. It also applies the exact durable-transition migration and verifies atomic answer/session/journal commit, rollback, rejection, idempotency, pending retention, and version CAS (including null rejection). It verifies service-role-only RPC execution, organization isolation, two-client pause/answer in both orders, competing dispatches/pickups, revision ABA and legacy writers, transaction rollback, durable cancellation, original pause restoration, expired/zero wrap-up admission, and the original reservation signature. Race tests wait for `pg_stat_activity.wait_event_type = 'Lock'` before releasing the first transaction; they do not infer concurrency from random sleeps.

`python3 tests/postgres/mobile-contract.py` separately recreates `mobile_contract` and applies the exact mobile migration. Its legacy replace function is a declared fixture stub. This covers the new wrapper, preserved owner on old-client omission, explicit null clearing, cross-organization rollback, permissions and owned PSTN attempt shape; it does not verify the full original configuration RPC.

The TypeScript workflow fake in `src/test/fake-presence.ts` supports application tests. It does not prove PostgreSQL locks, RLS, triggers, or transactional rollback.

`node tests/postgres/presence-compatibility.mjs` builds the working application and
runs pickup → answer → hangup → manual availability through the exact installed
presence/durable SQL RPCs for admission off/off, on/on and on/off. It also checks
compatibility internal answer ownership and idempotent ended-session recovery.
It recreates only the loopback `stability_compatibility` fixture; do not run it
concurrently with `compatibility-run.mjs`, which uses the same database. The
existing bridge persists workflow mutations to PostgreSQL and applies real
contract RPCs; filtering still uses the test query builder. Provider and media
are synthetic, outbound HTTP is blocked, and this does not verify PostgREST,
production RLS or audible calls. It requires the same local PostgreSQL and
Python dependencies as the other fixture scripts.

Presence writer inventory for the stability implementation:

| Writer | Contract |
| --- | --- |
| `presence-service.ts` ensure row | Inserts an offline row; new revision defaults to zero. |
| `presence-service.ts` manual change | v1 RPC for enabled/new-contract rows; compatibility path compares current status/session and revision when present. |
| `presence-service.ts` end wrap-up | v1 owner/revision RPC for return context; compatibility path checks after-call status. |
| `routing/reservation.ts` reserve | Original signature retained; migration routes it through dispatch then answer under one transaction. |
| `routing/reservation.ts` release | Exact current session; v1 also checks owner token/revision and retains the pause return during wrap-up. |
| `state/effects.ts` state, compensation, fan-out | Central owner-scoped effect application; the stability path uses dispatch authorization before dial. |
| `motorist_presence_transition_v1` | Session then presence lock order; state, ownership, cancellation, and presence history commit together. |
| Older direct SQL writers | The revision trigger bumps on status, reason, current session, wrap-up, status time, offer token, or return changes. This alone cannot prevent an old unguarded writer. |
| `access-management.ts` revoke access | Deletes presence during offboarding; it does not mark an operator available. |
| `operator-devices.ts` heartbeat/registration | Reads presence but writes device rows only. It cannot clear pause. |
| Existing cron/console sweeps | Route wrap-up and session effects through the shared owner checks; existing contracts must be recovered even with new admission disabled. |

Activation remains disabled until migration application is explicitly authorized and incompatible deployments/provider entry points are proven unable to write. Local fixture results do not establish that deployment boundary, browser audio, or actual Telnyx audio quality.
