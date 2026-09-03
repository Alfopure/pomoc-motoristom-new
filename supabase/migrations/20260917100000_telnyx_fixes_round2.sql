-- Phase 2 review fixes, round 2.
--
-- Session-lease writes must not look like activity.
--
-- `motorist_session_lease_acquire` / `_release` UPDATE `motorist_call_sessions`
-- once per processed event (and again per fan-out dial through `renewLease`).
-- Two triggers reacted to those writes:
--
--   1. `motorist_call_sessions_updated_at` refreshed `updated_at`, so every
--      snapshot loaded *after* the lease was taken looked freshly touched. The
--      stale-session safety net (`onStaleFinalise`) and the stuck-session cron
--      detection both derive from `updated_at` and were therefore blind: a
--      `wrap_up` / `missed` session whose last `call.hangup` webhook was lost
--      could never be finalised.
--   2. `motorist_call_sessions_broadcast` rang the Realtime doorbell, so every
--      open console tab refetched `/api/telephony/calls/active` up to three
--      times per webhook (acquire, persist, release) instead of once.
--
-- Both triggers are recreated with a WHEN clause that compares the row without
-- the lease bookkeeping columns, so a lease-only write is a no-op for them.
--
-- Re-runnable. (If `20260915100000_telephony_realtime.sql` is ever re-applied
-- *after* this file, re-apply this one too: that migration recreates the
-- combined broadcast trigger.)

-- ---------------------------------------------------------------------------
-- 1. updated_at ignores lease-only writes
-- ---------------------------------------------------------------------------

drop trigger if exists motorist_call_sessions_updated_at on public.motorist_call_sessions;

create trigger motorist_call_sessions_updated_at
  before update on public.motorist_call_sessions
  for each row
  when (
    (to_jsonb(old) - 'lease_token' - 'lease_until' - 'updated_at')
    is distinct from
    (to_jsonb(new) - 'lease_token' - 'lease_until' - 'updated_at')
  )
  execute function public.motorist_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. The Realtime doorbell ignores lease-only writes
-- ---------------------------------------------------------------------------
--
-- INSERT and DELETE keep a WHEN-less trigger (WHEN may not reference OLD on an
-- insert nor NEW on a delete); only UPDATE is filtered.

drop trigger if exists motorist_call_sessions_broadcast on public.motorist_call_sessions;
drop trigger if exists motorist_call_sessions_broadcast_update on public.motorist_call_sessions;

create trigger motorist_call_sessions_broadcast
  after insert or delete on public.motorist_call_sessions
  for each row
  execute function app_private.motorist_broadcast_telephony_change();

create trigger motorist_call_sessions_broadcast_update
  after update on public.motorist_call_sessions
  for each row
  when (
    (to_jsonb(old) - 'lease_token' - 'lease_until' - 'updated_at' - 'version')
    is distinct from
    (to_jsonb(new) - 'lease_token' - 'lease_until' - 'updated_at' - 'version')
  )
  execute function app_private.motorist_broadcast_telephony_change();
