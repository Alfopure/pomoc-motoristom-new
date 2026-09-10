-- Empty, disposable local database ONLY. No remote connection or existing data.
create schema auth;
create schema realtime;
create schema app_private;
do $$ begin
  if not exists(select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
create table public.motorist_organizations(id uuid primary key, active boolean not null default true);
create table public.motorist_profiles(id uuid primary key, organization_id uuid not null references motorist_organizations, user_id uuid, active boolean not null default true, role text default 'dispatcher', display_name text);
grant select on public.motorist_profiles, public.motorist_organizations to authenticated;
create table realtime.messages(extension text);
alter table realtime.messages enable row level security;
insert into realtime.messages values ('broadcast');
create function realtime.topic() returns text language sql stable as $$ select current_setting('test.realtime_topic', true) $$;
grant usage on schema realtime to authenticated;
grant select on realtime.messages to authenticated;
grant execute on function realtime.topic() to authenticated;
create table realtime.test_invalidations(payload jsonb, event text, topic text, private boolean);
create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void language sql as $$ insert into realtime.test_invalidations values(payload, event, topic, private) $$;
insert into public.motorist_organizations(id) values ('10000000-0000-0000-0000-000000000001'), ('10000000-0000-0000-0000-000000000002');
insert into public.motorist_profiles(id, organization_id, user_id, role, display_name) values
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','dispatcher','A'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','dispatcher','B'),
 ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003','admin','C'),
 ('20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000004','admin','Other organization');
