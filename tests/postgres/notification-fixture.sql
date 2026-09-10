-- Disposable local database only. The production reminder table migration is
-- applied below; this fixture supplies its pre-existing organization/task edges.
\ir notebook-fixture.sql
create function app_private.motorist_is_org_member(org uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
select exists(select 1 from motorist_profiles p where p.organization_id=org and p.user_id=auth.uid() and p.active) $$;
grant usage on schema app_private to authenticated;
grant execute on function app_private.motorist_is_org_member(uuid) to authenticated;
create function public.motorist_set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
create table public.motorist_cases(id uuid primary key, organization_id uuid not null references motorist_organizations, case_number text);
create table public.motorist_case_tasks(id uuid primary key default gen_random_uuid(), organization_id uuid not null references motorist_organizations,
case_id uuid references motorist_cases on delete set null, assigned_to uuid references motorist_profiles, created_by uuid references motorist_profiles,
title text not null default 'Task', due_at timestamptz, status text not null default 'open', updated_at timestamptz not null default now(), created_at timestamptz not null default now());
\ir ../../supabase/migrations/20260609110000_task_reminders_notifications.sql
grant all on public.motorist_notifications, public.motorist_task_reminders to authenticated;
insert into motorist_cases values ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','PM-1');
insert into motorist_case_tasks(id,organization_id,case_id,assigned_to,created_by,due_at) values
('50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','2026-09-01T12:00:00Z');
insert into motorist_task_reminders(id,organization_id,case_id,task_id,recipient_profile_id,visibility,scheduled_for,dedupe_key) values
('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','private','2026-09-01T12:00:00Z','legacy-private'),
('60000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',null,'team','2026-09-01T12:00:00Z','legacy-team');
insert into motorist_notifications(id,organization_id,task_id,recipient_profile_id,visibility,title,dedupe_key) values
('70000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','private','PRIVATE_A','private-a'),
('70000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','private','PRIVATE_B','private-b'),
('70000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',null,'team','HISTORICAL_TEAM','historical-team');
