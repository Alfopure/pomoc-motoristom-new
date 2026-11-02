-- Read-only confirmation that a start request's identity stays server-side.
--
-- Call-speed S3 (`own_leg_request_header`) puts the client's start `requestId`
-- on the operator's own leg, and the session row holds that id. The server
-- honours the switch only while this returns true
-- (src/server/telephony/latency-flags.ts). Anything else — false, an error, a
-- database without this function — keeps the switch off. It reports the live
-- catalog state, not the migration history:
--
--   * members (`anon`, `authenticated`) hold no table- or column-level SELECT on
--     `motorist_call_sessions` (20261031100100);
--   * the telephony broadcast trigger function is the content-free doorbell
--     (20261031100000), not the former full-row `broadcast_changes`.
--
-- No arguments, no row data, no writes; callable by the service role only.

create or replace function public.motorist_telephony_start_privacy_v1()
returns boolean
language sql
stable
set search_path = ''
as $$
  select not pg_catalog.has_any_column_privilege('authenticated', 'public.motorist_call_sessions', 'select')
    and not pg_catalog.has_any_column_privilege('anon', 'public.motorist_call_sessions', 'select')
    and coalesce((
      select pg_catalog.strpos(p.prosrc, 'broadcast_changes') = 0
        and pg_catalog.strpos(p.prosrc, 'realtime.send(''{}''::jsonb') > 0
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname = 'motorist_broadcast_telephony_change'
    ), false)
$$;

revoke all on function public.motorist_telephony_start_privacy_v1()
  from public, anon, authenticated;
grant execute on function public.motorist_telephony_start_privacy_v1()
  to service_role;
