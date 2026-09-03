-- Durable production scheduler runtime.
-- The worker uses service_role only. Browser roles receive no table or RPC access.

create table if not exists public.motorist_job_controls (
  job_name text primary key,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.motorist_job_runs (
  run_id uuid primary key,
  job_name text not null references public.motorist_job_controls(job_name) on update cascade on delete restrict,
  scheduled_for timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  payload_hash text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempt integer not null default 0 check (attempt >= 0),
  next_attempt_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  lease_heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  result_safe jsonb,
  error_safe text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists motorist_job_runs_claim_idx
  on public.motorist_job_runs (status, next_attempt_at, scheduled_for);

create index if not exists motorist_job_runs_job_time_idx
  on public.motorist_job_runs (job_name, scheduled_for desc);

create table if not exists public.motorist_worker_status (
  instance_id text primary key,
  deployment_version text not null,
  heartbeat_at timestamptz not null,
  scheduler_tick_at timestamptz,
  scheduler_status text not null default 'starting',
  last_webhook_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.motorist_job_incidents (
  incident_id uuid primary key default gen_random_uuid(),
  job_name text not null references public.motorist_job_controls(job_name) on update cascade on delete cascade,
  status text not null default 'open' check (status in ('open', 'recovered')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  opened_at timestamptz not null default now(),
  last_alert_at timestamptz,
  recovered_at timestamptz,
  last_error_safe text,
  updated_at timestamptz not null default now()
);

create unique index if not exists motorist_job_incidents_one_open_idx
  on public.motorist_job_incidents (job_name)
  where status = 'open';

insert into public.motorist_job_controls (job_name, enabled)
values
  ('fleet.webdispecink.positions', false),
  ('fleet.webdispecink.catalog', false),
  ('fleet.commander.positions', false),
  ('fleet.commander.catalog', false),
  ('fleet.swhouse.occupancy', false),
  ('fleet.swhouse.roster', false),
  ('notifications.materialize', false),
  ('telephony.transcripts.process', false),
  ('telephony.telnyx.reconcile', false)
on conflict (job_name) do nothing;

alter table public.motorist_job_controls enable row level security;
alter table public.motorist_job_runs enable row level security;
alter table public.motorist_worker_status enable row level security;
alter table public.motorist_job_incidents enable row level security;

revoke all on table public.motorist_job_controls from public, anon, authenticated;
revoke all on table public.motorist_job_runs from public, anon, authenticated;
revoke all on table public.motorist_worker_status from public, anon, authenticated;
revoke all on table public.motorist_job_incidents from public, anon, authenticated;

grant select, insert, update, delete on table public.motorist_job_controls to service_role;
grant select, insert, update, delete on table public.motorist_job_runs to service_role;
grant select, insert, update, delete on table public.motorist_worker_status to service_role;
grant select, insert, update, delete on table public.motorist_job_incidents to service_role;

create or replace function public.motorist_enqueue_job_run(
  p_run_id uuid,
  p_job_name text,
  p_scheduled_for timestamptz,
  p_payload jsonb,
  p_payload_hash text
)
returns public.motorist_job_runs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.motorist_job_runs%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_run_id::text));

  select *
  into v_existing
  from public.motorist_job_runs
  where run_id = p_run_id;

  if found then
    if v_existing.job_name <> p_job_name
      or v_existing.payload_hash <> p_payload_hash
      or v_existing.scheduled_for <> p_scheduled_for then
      raise exception 'JOB_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;

    return v_existing;
  end if;

  insert into public.motorist_job_runs (
    run_id,
    job_name,
    scheduled_for,
    payload,
    payload_hash
  )
  values (
    p_run_id,
    p_job_name,
    p_scheduled_for,
    coalesce(p_payload, '{}'::jsonb),
    p_payload_hash
  )
  returning * into v_existing;

  return v_existing;
end;
$$;

create or replace function public.motorist_claim_job_run(
  p_worker_id text,
  p_lease_seconds integer
)
returns setof public.motorist_job_runs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run public.motorist_job_runs%rowtype;
  v_lease_seconds integer := greatest(30, least(p_lease_seconds, 3600));
begin
  select runs.*
  into v_run
  from public.motorist_job_runs as runs
  join public.motorist_job_controls as controls
    on controls.job_name = runs.job_name
   and controls.enabled = true
  where (
    runs.status = 'queued'
    or (runs.status = 'failed' and coalesce(runs.next_attempt_at, runs.scheduled_for) <= pg_catalog.now())
    or (runs.status = 'running' and runs.lease_expires_at < pg_catalog.now())
  )
  order by coalesce(runs.next_attempt_at, runs.scheduled_for), runs.created_at
  for update of runs skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.motorist_job_runs
  set
    status = 'running',
    attempt = attempt + 1,
    lease_owner = p_worker_id,
    lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => v_lease_seconds),
    lease_heartbeat_at = pg_catalog.now(),
    started_at = coalesce(started_at, pg_catalog.now()),
    finished_at = null,
    error_safe = null,
    updated_at = pg_catalog.now()
  where run_id = v_run.run_id
  returning * into v_run;

  return next v_run;
end;
$$;

create or replace function public.motorist_renew_job_run_lease(
  p_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with renewed as (
    update public.motorist_job_runs
    set
      lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(
        secs => greatest(30, least(p_lease_seconds, 3600))
      ),
      lease_heartbeat_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
    where run_id = p_run_id
      and status = 'running'
      and lease_owner = p_worker_id
      and lease_expires_at > pg_catalog.now()
    returning 1
  )
  select exists(select 1 from renewed);
$$;

create or replace function public.motorist_complete_job_run(
  p_run_id uuid,
  p_worker_id text,
  p_result_safe jsonb
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with completed as (
    update public.motorist_job_runs
    set
      status = 'succeeded',
      result_safe = coalesce(p_result_safe, '{}'::jsonb),
      error_safe = null,
      lease_owner = null,
      lease_expires_at = null,
      lease_heartbeat_at = null,
      next_attempt_at = null,
      finished_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
    where run_id = p_run_id
      and status = 'running'
      and lease_owner = p_worker_id
    returning 1
  )
  select exists(select 1 from completed);
$$;

create or replace function public.motorist_fail_job_run(
  p_run_id uuid,
  p_worker_id text,
  p_error_safe text,
  p_next_attempt_at timestamptz,
  p_terminal boolean
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with failed as (
    update public.motorist_job_runs
    set
      status = case when p_terminal then 'dead' else 'failed' end,
      error_safe = pg_catalog.left(coalesce(p_error_safe, 'Job failed.'), 1000),
      lease_owner = null,
      lease_expires_at = null,
      lease_heartbeat_at = null,
      next_attempt_at = case when p_terminal then null else p_next_attempt_at end,
      finished_at = case when p_terminal then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
    where run_id = p_run_id
      and status = 'running'
      and lease_owner = p_worker_id
    returning 1
  )
  select exists(select 1 from failed);
$$;

revoke all on function public.motorist_enqueue_job_run(uuid, text, timestamptz, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.motorist_claim_job_run(text, integer)
  from public, anon, authenticated;
revoke all on function public.motorist_renew_job_run_lease(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.motorist_complete_job_run(uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.motorist_fail_job_run(uuid, text, text, timestamptz, boolean)
  from public, anon, authenticated;

grant execute on function public.motorist_enqueue_job_run(uuid, text, timestamptz, jsonb, text)
  to service_role;
grant execute on function public.motorist_claim_job_run(text, integer)
  to service_role;
grant execute on function public.motorist_renew_job_run_lease(uuid, text, integer)
  to service_role;
grant execute on function public.motorist_complete_job_run(uuid, text, jsonb)
  to service_role;
grant execute on function public.motorist_fail_job_run(uuid, text, text, timestamptz, boolean)
  to service_role;
