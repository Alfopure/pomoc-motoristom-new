\ir notebook-fixture.sql
alter role service_role bypassrls;
create table public.motorist_cases(id uuid primary key,organization_id uuid not null references public.motorist_organizations,case_number text,status text default 'new');
create table public.motorist_case_tasks(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.motorist_organizations,
 case_id uuid not null references public.motorist_cases on delete cascade,title text not null,assigned_to uuid references public.motorist_profiles,
 due_at timestamptz,status text not null default 'open',priority text not null default 'normal',kind text not null default 'other',
 created_by uuid,completed_by uuid,completed_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.motorist_audit_log(id uuid primary key default gen_random_uuid(),organization_id uuid,actor_profile_id uuid,action text,entity_type text,entity_id uuid,source text,before_payload jsonb,after_payload jsonb);
create table public.motorist_location_share_links(id uuid primary key default gen_random_uuid(),organization_id uuid,case_id uuid references motorist_cases on delete cascade,status text default 'active',metadata jsonb default '{}',expires_at timestamptz,used_at timestamptz,revoked_at timestamptz);
create table public.motorist_location_submissions(id uuid primary key default gen_random_uuid(),organization_id uuid,case_id uuid,link_id uuid,accepted boolean,submitted_at timestamptz);
create table public.motorist_callback_requests(id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.motorist_organizations,case_id uuid references public.motorist_cases on delete set null,status text default 'open',metadata jsonb default '{}',resolved_at timestamptz);
create table public.motorist_sms_messages(id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.motorist_organizations,case_id uuid references public.motorist_cases on delete set null,status text default 'queued',template_key text,provider_message_id text,status_detail text,next_attempt_at timestamptz,error text,direction text default 'outbound',raw_payload jsonb default '{}');
-- Reminder migration owns these real FKs. This minimal fixture represents the
-- required SET NULL result; combined migration verification is separate.
create table public.motorist_task_reminders(id uuid primary key default gen_random_uuid(),organization_id uuid,case_id uuid references public.motorist_cases on delete set null,task_id uuid references public.motorist_case_tasks on delete cascade,status text default 'pending');
grant select,insert,update,delete on public.motorist_cases,public.motorist_case_tasks,public.motorist_callback_requests,public.motorist_sms_messages,public.motorist_task_reminders to service_role;
insert into public.motorist_cases values
 ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','CASE-1','new'),
 ('40000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','CASE-2','closed'),
 ('40000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','CASE-3','new'),
 ('40000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000002','OTHER','new');
insert into public.motorist_case_tasks(id,organization_id,case_id,title,kind) values
 ('50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','Ordinary','other'),
 ('50000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','Proven callback','callback'),
 ('50000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','Ambiguous callback','callback'),
 ('50000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','Proven SMS','sms'),
 ('50000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','Mismatched mapping','other');
insert into public.motorist_callback_requests(id,organization_id,case_id,metadata) values
 ('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','{"task_id":"50000000-0000-0000-0000-000000000002"}'),
 ('60000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002','{"task_id":"50000000-0000-0000-0000-000000000005"}');
insert into public.motorist_sms_messages(id,organization_id,case_id,raw_payload) values
 ('70000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','{"source":"sms_composer","task_association":"explicit","task_id":"50000000-0000-0000-0000-000000000004"}');
