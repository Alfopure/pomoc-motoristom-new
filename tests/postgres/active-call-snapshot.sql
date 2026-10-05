\set ON_ERROR_STOP on
-- Disposable local PostgreSQL only. The runner supplies a fresh database;
-- this fixture never reads application credentials or contacts Supabase.
create role anon;
create role authenticated;
create role service_role;
create table public.motorist_call_sessions(id uuid primary key,organization_id uuid,state text,started_at timestamptz,metadata jsonb);
create table public.motorist_call_legs(id uuid primary key,organization_id uuid,session_id uuid,ended_at timestamptz);
create table public.motorist_ring_attempts(id uuid primary key,organization_id uuid,session_id uuid,result text);
create table public.motorist_operator_presence(id uuid primary key,organization_id uuid,status text);
create table public.motorist_operator_devices(id uuid primary key,organization_id uuid,environment text);
create table public.motorist_telephony_lines(id uuid primary key,organization_id uuid);
create table public.motorist_operator_telephony_settings(id uuid primary key,organization_id uuid,delivery_mode text);
create table public.motorist_calls(id uuid primary key,organization_id uuid,session_id uuid,raw_latest_payload jsonb);
grant usage on schema public to service_role;
grant select on all tables in schema public to service_role;

\ir ../../supabase/migrations/20261011120000_active_call_snapshot.sql

insert into motorist_call_sessions values
 ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','talking','2026-10-05 12:01Z','{"recording":{"epoch":2}}'),
 ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001','ringing','2026-10-05 12:00Z','{}'),
 ('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000001','ended','2026-10-05 11:00Z','{}'),
 ('00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000002','talking','2026-10-05 10:00Z','{}');
insert into motorist_call_legs values
 ('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101',null),
 ('00000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101',now()),
 ('00000000-0000-4000-8000-000000000203','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000103',null),
 ('00000000-0000-4000-8000-000000000204','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000101',null);
insert into motorist_ring_attempts values
 ('00000000-0000-4000-8000-000000000301','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000102','offered'),
 ('00000000-0000-4000-8000-000000000302','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000102','answered'),
 ('00000000-0000-4000-8000-000000000303','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000102','offered');
insert into motorist_operator_presence values
 ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000001','available'),
 ('00000000-0000-4000-8000-000000000402','00000000-0000-4000-8000-000000000002','available');
insert into motorist_operator_devices values
 ('00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000001','development'),
 ('00000000-0000-4000-8000-000000000502','00000000-0000-4000-8000-000000000001','production'),
 ('00000000-0000-4000-8000-000000000503','00000000-0000-4000-8000-000000000002','development');
insert into motorist_telephony_lines values
 ('00000000-0000-4000-8000-000000000601','00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000602','00000000-0000-4000-8000-000000000002');
insert into motorist_operator_telephony_settings values
 ('00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000001','application'),
 ('00000000-0000-4000-8000-000000000702','00000000-0000-4000-8000-000000000002','application');
insert into motorist_calls values
 ('00000000-0000-4000-8000-000000000801','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','{"private":"omit"}'),
 ('00000000-0000-4000-8000-000000000802','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000101','{"private":"omit"}');

set role service_role;
begin read only;
do $$
declare result jsonb; empty_result jsonb; key text;
begin
 result := public.motorist_active_call_snapshot_v1('00000000-0000-4000-8000-000000000001','development');
 if jsonb_array_length(result->'sessions') <> 2 or result#>>'{sessions,0,id}' <> '00000000-0000-4000-8000-000000000102'
   or result#>>'{sessions,1,metadata,recording,epoch}' <> '2' then raise exception 'session order or metadata lost'; end if;
 foreach key in array array['legs','attempts','presence','devices','lines','operatorSettings','callRows'] loop
   if jsonb_array_length(result->key) <> 1 then raise exception 'invalid scoped rows: %',key; end if;
 end loop;
 if result#>>'{devices,0,id}' <> '00000000-0000-4000-8000-000000000501' then raise exception 'device environment leaked'; end if;
 if result#>'{callRows,0,raw_latest_payload}' is not null then raise exception 'unnecessary call payload included'; end if;
 empty_result := public.motorist_active_call_snapshot_v1('00000000-0000-4000-8000-000000000003','development');
 foreach key in array array['sessions','legs','attempts','presence','devices','lines','operatorSettings','callRows'] loop
   if empty_result->key <> '[]'::jsonb then raise exception 'empty scope leaked %',key; end if;
 end loop;
 begin
   perform public.motorist_active_call_snapshot_v1(null,'development'); raise exception 'null organization accepted';
 exception when invalid_parameter_value then null; end;
 begin
   perform public.motorist_active_call_snapshot_v1('00000000-0000-4000-8000-000000000001','preview'); raise exception 'invalid environment accepted';
 exception when invalid_parameter_value then null; end;
end;
$$;
commit;
reset role;

set role anon;
do $$ begin
  perform public.motorist_active_call_snapshot_v1('00000000-0000-4000-8000-000000000001','development');
  raise exception 'anonymous RPC execution allowed';
exception when insufficient_privilege then null; end $$;
reset role;
set role authenticated;
do $$ begin
  perform public.motorist_active_call_snapshot_v1('00000000-0000-4000-8000-000000000001','development');
  raise exception 'browser RPC execution allowed';
exception when insufficient_privilege then null; end $$;
reset role;
select 'PASS read-only snapshot: organization/environment isolation, open legs/offers, call links, ordering, metadata, empty scope, server-only execution' as result;
