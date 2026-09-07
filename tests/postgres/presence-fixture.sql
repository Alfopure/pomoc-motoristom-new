-- Minimal isolated fixture, not a full Supabase schema reset.
create schema if not exists app_private;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table motorist_profiles(id uuid primary key,organization_id uuid not null);
create table motorist_pause_reasons(id uuid primary key,organization_id uuid not null,label text,active boolean default true);
create table motorist_call_sessions(
  id uuid primary key,organization_id uuid not null,state text default 'ringing',updated_at timestamptz default now(),
  version integer not null default 0,line_id uuid,ring_plan_id uuid,current_step integer default 0,conference_id text,
  conference_name text,customer_leg_id uuid,answered_by_profile_id uuid,case_id uuid,caller_number text,called_number text,
  answered_at timestamptz,ended_at timestamptz,hold_started_at timestamptz,parked_at timestamptz,metadata jsonb default '{}'::jsonb
);
create table motorist_operator_presence(
  id uuid primary key default gen_random_uuid(),organization_id uuid not null,profile_id uuid unique references motorist_profiles,
  status text default 'offline',current_session_id uuid references motorist_call_sessions,pause_reason_id uuid references motorist_pause_reasons,
  wrap_up_until timestamptz,status_since timestamptz default now(),created_at timestamptz default now(),updated_at timestamptz default now()
);
create table motorist_ring_attempts(id uuid primary key default gen_random_uuid(),session_id uuid,profile_id uuid,result text,ended_at timestamptz);
create table motorist_operator_statuses(id uuid primary key default gen_random_uuid(),organization_id uuid,profile_id uuid,status text,reason text,source text,started_at timestamptz,ended_at timestamptz);
