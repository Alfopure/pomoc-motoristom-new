begin;

-- Expand only. Enabling admission is a separate reviewed rollout after every
-- active deployment understands v2; existing sessions stay on their contract.
create table public.motorist_telephony_writer_rollout (
  singleton boolean primary key default true check (singleton),
  new_session_contract integer not null default 1 check (new_session_contract in (1,2))
);
insert into public.motorist_telephony_writer_rollout values (true,1);
alter table public.motorist_telephony_writer_rollout enable row level security;
revoke all on public.motorist_telephony_writer_rollout from public, anon, authenticated;
grant select, update on public.motorist_telephony_writer_rollout to service_role;

alter table public.motorist_call_sessions
  add column writer_contract integer not null default 1 check (writer_contract in (1,2)),
  add column ownership_generation bigint not null default 0,
  add column termination_requested_at timestamptz,
  add column termination_next_attempt_at timestamptz;
create unique index motorist_initial_call_operation_identity on public.motorist_call_sessions
  (organization_id, (metadata->'initial_operation'->>'actorId'), (metadata->'initial_operation'->>'id'))
  where metadata->'initial_operation' is not null;

create function public.motorist_telephony_fence(p_session_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.motorist_call_sessions%rowtype; h jsonb;
begin
  select * into s from public.motorist_call_sessions where id=p_session_id for update;
  if not found or s.writer_contract=1 then return; end if;
  h := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if h->>'x-telephony-writer' is distinct from '2'
    or h->>'x-telephony-session' is distinct from s.id::text
    or h->>'x-telephony-token' is distinct from s.lease_token
    or h->>'x-telephony-generation' is distinct from s.ownership_generation::text
    or s.lease_token is null or s.lease_until <= clock_timestamp() then
    raise sqlstate 'PT409' using message='telephony ownership lease or writer contract rejected';
  end if;
end $$;

create function public.motorist_telephony_session_write_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare h jsonb; contract integer;
begin
  if current_setting('motorist.telephony_internal',true)='1' then
    if TG_OP='DELETE' then return old; end if; return new;
  end if;
  if TG_OP='INSERT' then
    select new_session_contract into contract from public.motorist_telephony_writer_rollout where singleton;
    new.writer_contract := contract;
    new.ownership_generation := 0;
    new.termination_requested_at := null;
    new.termination_next_attempt_at := null;
    h := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
    if contract=2 and new.direction in ('outbound','internal') and new.metadata->'initial_operation' is null then
      raise sqlstate 'PT409' using message='telephony request identity required; reload application';
    end if;
    if contract=2 and h->>'x-telephony-writer' is distinct from '2' then
      raise sqlstate 'PT409' using message='telephony writer contract rejected';
    end if;
  else
    perform public.motorist_telephony_fence(old.id);
    if TG_OP='UPDATE' and old.metadata->'initial_operation' is not null
      and new.metadata->'initial_operation' is distinct from old.metadata->'initial_operation' then
      raise sqlstate 'PT409' using message='initial call operation identity is immutable';
    end if;
    if TG_OP='UPDATE' and (new.writer_contract<>old.writer_contract
      or new.ownership_generation<>old.ownership_generation
      or new.lease_token is distinct from old.lease_token or new.lease_until is distinct from old.lease_until
      or new.termination_requested_at is distinct from old.termination_requested_at
      or new.termination_next_attempt_at is distinct from old.termination_next_attempt_at) then
      raise sqlstate 'PT409' using message='telephony lease fields require ownership RPC';
    end if;
  end if;
  if TG_OP='DELETE' then return old; end if;
  return new;
end $$;
create trigger motorist_session_writer_guard before insert or update or delete on public.motorist_call_sessions
for each row execute function public.motorist_telephony_session_write_guard();

create function public.motorist_telephony_child_write_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare old_id uuid; new_id uuid;
begin
  -- Recording processing has its own job lease. Its trigger only invalidates
  -- the recording-source revision; it is not a call topology writer.
  if TG_TABLE_NAME='motorist_calls' and TG_OP='UPDATE'
    and (to_jsonb(new)-'recording_source_revision'-'updated_at')=(to_jsonb(old)-'recording_source_revision'-'updated_at')
    and (to_jsonb(new)->>'recording_source_revision')::bigint >= (to_jsonb(old)->>'recording_source_revision')::bigint then
    return new;
  end if;
  if TG_OP<>'INSERT' then old_id := (to_jsonb(old)->>TG_ARGV[0])::uuid; end if;
  if TG_OP<>'DELETE' then new_id := (to_jsonb(new)->>TG_ARGV[0])::uuid; end if;
  if old_id is not null then perform public.motorist_telephony_fence(old_id); end if;
  if new_id is not null and new_id is distinct from old_id then perform public.motorist_telephony_fence(new_id); end if;
  if TG_OP='DELETE' then return old; end if; return new;
end $$;
create trigger motorist_leg_writer_guard before insert or update or delete on public.motorist_call_legs
for each row execute function public.motorist_telephony_child_write_guard('session_id');
create trigger motorist_attempt_writer_guard before insert or update or delete on public.motorist_ring_attempts
for each row execute function public.motorist_telephony_child_write_guard('session_id');

-- Auxiliary transition projections may not be rewritten by a stale process.
create trigger motorist_presence_writer_guard before insert or update or delete on public.motorist_operator_presence
for each row execute function public.motorist_telephony_child_write_guard('current_session_id');
create trigger motorist_call_writer_guard before insert or update or delete on public.motorist_calls
for each row execute function public.motorist_telephony_child_write_guard('session_id');
create trigger motorist_participant_writer_guard before insert or update or delete on public.motorist_call_participant_intervals
for each row execute function public.motorist_telephony_child_write_guard('session_id');

create function public.motorist_session_lease_acquire_v2(p_session_id uuid,p_token text,p_ttl_ms integer default 15000)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.motorist_call_sessions%rowtype; h jsonb;
begin
  select * into s from public.motorist_call_sessions where id=p_session_id for update;
  if not found then return null; end if;
  h := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if s.writer_contract=2 and h->>'x-telephony-writer' is distinct from '2' then
    raise sqlstate 'PT409' using message='telephony writer contract rejected';
  end if;
  if s.lease_until>clock_timestamp() and s.lease_token is distinct from p_token then return null; end if;
  -- An old process cannot regain its generation after expiry: acquire always
  -- issues a new generation; renewal below never reacquires expired ownership.
  perform set_config('motorist.telephony_internal','1',true);
  update public.motorist_call_sessions set lease_token=p_token,
    lease_until=clock_timestamp()+make_interval(secs=>greatest(15000,least(p_ttl_ms,30000))/1000.0),
    ownership_generation=ownership_generation+1 where id=p_session_id returning * into s;
  perform set_config('motorist.telephony_internal','',true);
  return jsonb_build_object('generation',s.ownership_generation,'contract',s.writer_contract);
end $$;

create function public.motorist_session_lease_renew_v2(p_session_id uuid,p_token text,p_generation bigint,p_ttl_ms integer default 15000)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare changed integer;
begin
  perform set_config('motorist.telephony_internal','1',true);
  update public.motorist_call_sessions set lease_until=clock_timestamp()+make_interval(secs=>greatest(15000,least(p_ttl_ms,30000))/1000.0)
    where id=p_session_id and lease_token=p_token and ownership_generation=p_generation and lease_until>clock_timestamp();
  get diagnostics changed=row_count;
  perform set_config('motorist.telephony_internal','',true);
  return changed=1;
end $$;

create function public.motorist_session_lease_release_v2(p_session_id uuid,p_token text,p_generation bigint)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare changed integer;
begin
  perform set_config('motorist.telephony_internal','1',true);
  update public.motorist_call_sessions set lease_token=null,lease_until=null
    where id=p_session_id and lease_token=p_token and ownership_generation=p_generation;
  get diagnostics changed=row_count;
  perform set_config('motorist.telephony_internal','',true);
  return changed=1;
end $$;

-- Legacy lease RPCs remain usable for v1 sessions, but cannot touch v2.
create or replace function public.motorist_session_lease_acquire(p_session_id uuid,p_token text,p_ttl_ms integer default 4000)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare changed integer;
begin
  perform set_config('motorist.telephony_internal','1',true);
  update public.motorist_call_sessions set lease_token=p_token,
    lease_until=clock_timestamp()+make_interval(secs=>greatest(250,least(p_ttl_ms,30000))/1000.0)
    where id=p_session_id and writer_contract=1 and (lease_until is null or lease_until<clock_timestamp() or lease_token=p_token);
  get diagnostics changed=row_count;
  perform set_config('motorist.telephony_internal','',true);
  return changed=1;
end $$;
create or replace function public.motorist_session_lease_release(p_session_id uuid,p_token text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare changed integer;
begin
  perform set_config('motorist.telephony_internal','1',true);
  update public.motorist_call_sessions set lease_token=null,lease_until=null where id=p_session_id and writer_contract=1 and lease_token=p_token;
  get diagnostics changed=row_count;
  perform set_config('motorist.telephony_internal','',true);
  return changed=1;
end $$;

create function public.motorist_session_terminate_v2(p_organization_id uuid,p_session_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  -- Auth/organization authorization is performed by the existing call action.
  -- This intent may preempt the owner, but cannot rewrite topology or leases.
  perform set_config('motorist.telephony_internal','1',true);
  update public.motorist_call_sessions set termination_requested_at=coalesce(termination_requested_at,clock_timestamp()),termination_next_attempt_at=clock_timestamp()
    where id=p_session_id and organization_id=p_organization_id and writer_contract=2;
  perform set_config('motorist.telephony_internal','',true);
end $$;

create table public.motorist_provider_commands (
  session_id uuid not null references public.motorist_call_sessions(id) on delete cascade,
  command_id text not null,
  fingerprint text not null,
  method text not null,
  path text not null,
  correlation_state text,
  request_payload jsonb not null default '{}'::jsonb,
  dispatch_generation bigint not null,
  dispatch_token text not null,
  first_dispatched_at timestamptz not null default clock_timestamp(),
  outcome text not null default 'unknown' check (outcome in ('unknown','accepted','rejected','rate_limited')),
  result jsonb,
  http_status integer,
  termination_cleanup_at timestamptz,
  next_attempt_at timestamptz,
  primary key(session_id,command_id)
);
alter table public.motorist_provider_commands enable row level security;
revoke all on public.motorist_provider_commands from public, anon, authenticated;
grant select on public.motorist_provider_commands to service_role;

create function public.motorist_provider_command_prepare_v2(p_session_id uuid,p_command_id text,p_fingerprint text,p_method text,p_path text,p_correlation_state text default null,p_payload jsonb default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.motorist_call_sessions%rowtype; c public.motorist_provider_commands%rowtype;
begin
  perform public.motorist_telephony_fence(p_session_id);
  select * into s from public.motorist_call_sessions where id=p_session_id for update;
  if s.writer_contract<>2 then raise sqlstate 'PT409' using message='provider journal requires writer contract 2'; end if;
  select * into c from public.motorist_provider_commands where session_id=p_session_id and command_id=p_command_id;
  if found then
    if c.fingerprint<>p_fingerprint or c.method<>p_method or c.path<>p_path or c.correlation_state is distinct from p_correlation_state or c.request_payload is distinct from coalesce(p_payload,'{}'::jsonb) then
      raise sqlstate 'PT409' using message='provider command payload identity conflict';
    end if;
    if c.outcome<>'rate_limited' or c.next_attempt_at>clock_timestamp() then
      return to_jsonb(c)||jsonb_build_object('dispatch',false);
    end if;
  end if;
  if (s.termination_requested_at is not null or s.ended_at is not null or s.state::text in ('ended','failed'))
    and p_path !~ '/actions/(hangup|record_stop|leave|stop)$' then
    raise sqlstate 'PT409' using message='telephony termination blocks new provider command';
  end if;
  insert into public.motorist_provider_commands(session_id,command_id,fingerprint,method,path,correlation_state,request_payload,dispatch_generation,dispatch_token)
    values(p_session_id,p_command_id,p_fingerprint,p_method,p_path,p_correlation_state,coalesce(p_payload,'{}'::jsonb),s.ownership_generation,s.lease_token)
    on conflict(session_id,command_id) do update set outcome='unknown',dispatch_generation=s.ownership_generation,
      dispatch_token=s.lease_token,next_attempt_at=null;
  return jsonb_build_object('dispatch',true);
end $$;

create function public.motorist_provider_command_result_v2(p_session_id uuid,p_command_id text,p_fingerprint text,p_generation bigint,p_token text,p_status integer,p_result jsonb,p_retry_after_ms integer default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare changed integer;
begin
  -- Match preparation/checkpoint lock order while accepting old-owner evidence.
  perform 1 from public.motorist_call_sessions where id=p_session_id for update;
  -- A response already received remains evidence after lease loss. It cannot
  -- mutate call topology or authorize another command; exact dispatch identity
  -- and immutable payload are required. Unknown evidence is never overwritten.
  update public.motorist_provider_commands set http_status=p_status,result=p_result,
    outcome=case when p_status between 200 and 299 then 'accepted' when p_status=429 then 'rate_limited'
      when p_status between 400 and 499 and p_status<>408 then 'rejected' else 'unknown' end,
    next_attempt_at=case when p_status=429 then clock_timestamp()+make_interval(secs=>greatest(0,coalesce(p_retry_after_ms,500))/1000.0) else null end
    where session_id=p_session_id and command_id=p_command_id and fingerprint=p_fingerprint
      and dispatch_generation=p_generation and dispatch_token=p_token and outcome='unknown';
  get diagnostics changed=row_count;
  -- Provider evidence may arrive after the owner/deadline or a completed
  -- cleanup pass. Re-arm this existing obligation; never authorize new dial.
  if changed=1 and p_status between 200 and 299 and exists(
    select 1 from public.motorist_provider_commands where session_id=p_session_id
      and command_id=p_command_id and path='/calls' and termination_cleanup_at is null) then
    perform set_config('motorist.telephony_internal','1',true);
    update public.motorist_call_sessions set termination_next_attempt_at=clock_timestamp()
      where id=p_session_id and termination_requested_at is not null;
    perform set_config('motorist.telephony_internal','',true);
  end if;
  return changed=1;
end $$;

-- Only exact client_state echoed by a verified, correlated provider event can
-- resolve an unknown dial. Ambiguous state shared by two commands is refused;
-- the existing compact client-state wire contract is unchanged.
create function public.motorist_provider_observe_dial_v2(p_session_id uuid,p_client_state text,p_call_control_id text,p_call_leg_id text,p_call_session_id text,p_alive boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare matches integer; changed integer;
begin
  perform public.motorist_telephony_fence(p_session_id);
  select count(*) into matches from public.motorist_provider_commands
    where session_id=p_session_id and path='/calls' and correlation_state=p_client_state;
  if matches<>1 or p_client_state is null or p_call_control_id is null then return false; end if;
  update public.motorist_provider_commands set outcome='accepted',http_status=200,
    result=jsonb_build_object('data',jsonb_build_object('call_control_id',p_call_control_id,'call_leg_id',p_call_leg_id,'call_session_id',p_call_session_id,'is_alive',p_alive))
    where session_id=p_session_id and path='/calls' and correlation_state=p_client_state and outcome='unknown';
  get diagnostics changed=row_count;
  if changed=1 then
    perform set_config('motorist.telephony_internal','1',true);
    update public.motorist_call_sessions set termination_next_attempt_at=clock_timestamp()
      where id=p_session_id and termination_requested_at is not null;
    perform set_config('motorist.telephony_internal','',true);
  end if;
  return changed=1;
end $$;

create function public.motorist_provider_pending_commands_v2(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.motorist_telephony_fence(p_session_id);
  return coalesce((select jsonb_agg(jsonb_build_object('commandId',command_id,'fingerprint',fingerprint,'path',path,
    'payload',request_payload,'dispatchGeneration',dispatch_generation,'dispatchToken',dispatch_token,
    'firstDispatchedAt',first_dispatched_at,'correlationState',correlation_state))
    from public.motorist_provider_commands where session_id=p_session_id and outcome='unknown'),'[]'::jsonb);
end $$;

create function public.motorist_provider_command_lookup_v2(p_session_id uuid,p_command_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.motorist_telephony_fence(p_session_id);
  return (select jsonb_build_object('outcome',outcome,'result',result) from public.motorist_provider_commands
    where session_id=p_session_id and command_id=p_command_id);
end $$;

create function public.motorist_provider_termination_legs_v2(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.motorist_telephony_fence(p_session_id);
  if not exists(select 1 from public.motorist_call_sessions where id=p_session_id and termination_requested_at is not null) then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('commandId',command_id,'callControlId',result->'data'->>'call_control_id'))
    from public.motorist_provider_commands where session_id=p_session_id and path='/calls' and outcome='accepted'
      and result->'data'->>'call_control_id' is not null and termination_cleanup_at is null),'[]'::jsonb);
end $$;

create function public.motorist_provider_termination_checkpoint_v2(p_session_id uuid,p_completed_commands text[])
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare pending boolean;
begin
  perform public.motorist_telephony_fence(p_session_id);
  update public.motorist_provider_commands set termination_cleanup_at=coalesce(termination_cleanup_at,clock_timestamp())
    where session_id=p_session_id and command_id=any(p_completed_commands) and path='/calls' and outcome='accepted';
  select exists(select 1 from public.motorist_provider_commands where session_id=p_session_id and path='/calls'
    and (outcome='unknown' or outcome='accepted' and termination_cleanup_at is null)) into pending;
  perform set_config('motorist.telephony_internal','1',true);
  update public.motorist_call_sessions set termination_next_attempt_at=case when pending then clock_timestamp()+interval '30 seconds' else null end
    where id=p_session_id and termination_requested_at is not null;
  perform set_config('motorist.telephony_internal','',true);
  return jsonb_build_object('pending',pending);
end $$;

-- Functions are reachable only by the trusted application role. The guard's
-- internal bypass is transaction-local and never accepted from HTTP headers.
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'motorist%v2' and p.proname in (
      'motorist_session_lease_acquire_v2','motorist_session_lease_renew_v2','motorist_session_lease_release_v2',
      'motorist_session_terminate_v2','motorist_provider_command_prepare_v2','motorist_provider_command_result_v2','motorist_provider_termination_legs_v2','motorist_provider_observe_dial_v2','motorist_provider_command_lookup_v2','motorist_provider_pending_commands_v2','motorist_provider_termination_checkpoint_v2')
      or p.proname in ('motorist_telephony_fence','motorist_telephony_session_write_guard','motorist_telephony_child_write_guard'))
  loop execute format('revoke all on function %s from public, anon, authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature); end loop;
end $$;
commit;
