-- Call sessions become readable by the service role only.
--
-- The foundation migration (20260903100000) let every organisation member
-- SELECT `motorist_call_sessions` through the Data API
-- (`motorist_call_sessions_member_select`), and the default table grants were
-- never narrowed. A session row carries data meant for the server alone:
-- `metadata.initial_operation` (the client's start `requestId`, the operator's
-- SIP address, the frozen request), customer numbers and `pending_effects`
-- (staged provider commands, including the own-leg request header of
-- call-speed S3). Any colleague could read another operator's in-flight start
-- request this way, independently of Realtime.
--
-- Nothing reads this table with a user's token: the console, the mobile app
-- and every server route go through API routes that use the service role
-- (`createSupabaseAdminClient`), and Realtime is a content-free doorbell
-- (20261031100000), not `postgres_changes`. The service role bypasses RLS and
-- keeps its grants; triggers and service-only RPCs are unaffected.
--
-- Legs, presence and devices keep their member policies; they are out of this
-- change's scope.

drop policy if exists motorist_call_sessions_member_select on public.motorist_call_sessions;

alter table public.motorist_call_sessions enable row level security;

revoke all on table public.motorist_call_sessions from anon, authenticated;
grant select, insert, update, delete on table public.motorist_call_sessions to service_role;
