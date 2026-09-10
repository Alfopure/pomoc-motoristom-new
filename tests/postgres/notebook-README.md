Notebook verification uses an empty disposable PostgreSQL 15 database on loopback. It never reads an application database URL. The fixture includes only auth.uid(), active organization/profile rows and a content-free Realtime recording stub. It applies the exact `20260929100000_personal_notes.sql` migration.

With the local cluster listening on `127.0.0.1:55432` as `postgres`:

```sh
createdb -h 127.0.0.1 -p 55432 -U postgres notebook_contract
psql -X -h 127.0.0.1 -p 55432 -U postgres -d notebook_contract -f tests/postgres/notebook-contract.sql
python3 tests/postgres/notebook-concurrency.py
```

The SQL matrix verifies owner/read-only recipient/unshared admin/other organization/inactive actor/inactive organization/anonymous access, actor impersonation rejection, owner-only recipient directory, direct-write denial, default privacy, same-organization and active-recipient validation, revision conflicts with rollback, immediate revocation, delete cascade and private empty invalidation payloads. The concurrency script recreates only `notebook_race` and uses two real connections: a stale save waits on the note row then conflicts; a reader waiting behind an uncommitted revocation is rejected after the revocation commits. It observes `pg_stat_activity.wait_event_type = 'Lock'` before releasing the first transaction.

Verified on PostgreSQL 15.18 on 2026-09-10. This does not verify a remote Supabase project, actual websocket delivery, deployed PostgREST, or the full application's migration chain. The isolated fixture exercises the private topic policy with a minimal messages table and topic function, plus payload generation; production websocket authorization lifecycle still requires deployment evidence. API/polling checks remain authoritative. No remote migration was applied.
