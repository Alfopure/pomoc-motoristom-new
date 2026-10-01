-- Run with psql ON_ERROR_STOP=1 in AUTOCOMMIT mode against the explicitly approved
-- project before 20261008130000_operations_diagnostics.sql. Never wrap in BEGIN.
-- The schema migration validates the existing definition and records the rollout.
-- A cancelled concurrent build can leave an INVALID index: inspect pg_index before
-- retrying; remove only this failed diagnostic index CONCURRENTLY, then retry.
set lock_timeout = '500ms';
set statement_timeout = '30s';
create index concurrently if not exists motorist_call_legs_diagnostic_candidates
 on public.motorist_call_legs(organization_id,updated_at,id)
 where role='operator' and bridged_at is not null and ended_at is not null;
reset statement_timeout;
reset lock_timeout;
