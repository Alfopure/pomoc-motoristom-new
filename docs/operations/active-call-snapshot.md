# Read-only active-call snapshot

`TELEPHONY_ACTIVE_SNAPSHOT_V1_ENABLED=true` switches the active-call overview
from five/eight PostgREST table requests to one `motorist_active_call_snapshot_v1`
RPC. The existing projection still filters each operator's private leg identity
and assignments. The RPC reads one consistent database snapshot, performs no
sweep or call/recording mutation, and is executable only by `service_role`.

The switch defaults to off. Activate only after explicit project-specific SQL
authorization and verification of
`supabase/migrations/20261011120000_active_call_snapshot.sql`. Apply this one
migration; do not apply other pending migrations. The proposed first target is
the dedicated TEST database `nzpnqdstvkfncflgqlny`, with environment
`development`, and the dedicated TEST Vercel project's Production scope.

Verify the RPC's eight arrays, organization/device-environment isolation and
service-only permissions before enabling the switch. Deploy current `dev`
afresh after the environment change, confirm the canonical TEST health SHA,
then check authenticated overview responses and actual call initiation,
acceptance and controls. A healthy endpoint or fewer requests does not prove
acceptable live latency. An RPC failure intentionally does not start eight
fallback requests against an already slow database.

Rollback disables only this switch and deploys the current approved branch
afresh. The read-only function can remain installed; no call rows, provider
resources, recording notices or privacy barriers change.

Local SQL verification uses a fresh disposable PostgreSQL database with no
application credentials. Run `tests/postgres/active-call-snapshot.sql` through
`psql -X -v ON_ERROR_STOP=1`; its relative include applies the exact migration.
It verifies read-only execution, organization/environment isolation, open
legs/offers, call links, metadata/order, empty scope and browser/anonymous
permission rejection. Application tests compare the two projections and verify
that one RPC issues no table reads or provider calls.
