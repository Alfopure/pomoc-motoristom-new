-- Additive contract. Application admission is gated until all writers are compatible.
alter table public.motorist_operator_presence
  add column if not exists presence_revision bigint not null default 0,
  add column if not exists offer_token text,
  add column if not exists pause_return jsonb;
alter table public.motorist_call_sessions
  add column if not exists presence_cancellations jsonb not null default '{}'::jsonb,
  add column if not exists presence_pickup jsonb,
  add column if not exists cancellations_next_attempt_at timestamptz;
create index if not exists call_sessions_presence_cancellations_idx
  on public.motorist_call_sessions (updated_at, id)
  where presence_cancellations <> '{}'::jsonb;

create index if not exists call_sessions_presence_pickup_idx
  on public.motorist_call_sessions (updated_at,id) where presence_pickup is not null;

create index if not exists operator_presence_due_wrap_up_idx
  on public.motorist_operator_presence (organization_id,wrap_up_until,id) where status='after_call_work';

-- Covers legacy writers too, including reason/ownership ABA changes. This does
-- not authorize old deployments: those must be disconnected before activation.
create or replace function app_private.motorist_presence_revision_bump()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.status, new.current_session_id, new.pause_reason_id, new.wrap_up_until,
      new.status_since, new.offer_token, new.pause_return)
    is distinct from
     (old.status, old.current_session_id, old.pause_reason_id, old.wrap_up_until,
      old.status_since, old.offer_token, old.pause_return) then
    new.presence_revision := old.presence_revision + 1;
  else
    new.presence_revision := old.presence_revision;
  end if;
  return new;
end;
$$;
drop trigger if exists motorist_presence_revision_bump on public.motorist_operator_presence;
create trigger motorist_presence_revision_bump before update on public.motorist_operator_presence
  for each row execute function app_private.motorist_presence_revision_bump();

-- All operations lock SESSION -> PRESENCE. Manual actions first discover the
-- current session without a lock, then reject a changed pointer after locking.
-- No database transaction is held over a provider call.
create or replace function public.motorist_presence_transition_v1(
  p_organization_id uuid, p_profile_id uuid, p_action text,
  p_session_id uuid default null, p_expected_revision bigint default null,
  p_expected_token text default null, p_status text default null,
  p_pause_reason_id uuid default null, p_wrap_up_until timestamptz default null,
  p_reason text default null, p_source text default 'telephony'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.motorist_operator_presence%rowtype;
  s public.motorist_call_sessions%rowtype;
  v_session uuid := p_session_id;
  v_discovered uuid;
  v_cancel_session uuid;
  v_status text;
  v_token text;
  v_return jsonb;
  v_reason uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_same boolean;
  v_acquired jsonb;
begin
  if p_action='acquire' then
    v_acquired := public.motorist_presence_transition_v1(p_organization_id,p_profile_id,'dispatch',p_session_id,p_expected_revision,p_expected_token);
    if not coalesce((v_acquired->>'applied')::boolean,false) then return v_acquired; end if;
    return public.motorist_presence_transition_v1(p_organization_id,p_profile_id,'answer',p_session_id,
      (v_acquired->>'revision')::bigint,v_acquired->>'offerToken') || pg_catalog.jsonb_build_object('reused',coalesce((v_acquired->>'reused')::boolean,false));
  end if;
  if p_action is null or p_action not in ('manual','dispatch','answer','pickup','release','end_wrap_up') then
    raise exception 'invalid presence action' using errcode = '22023';
  end if;
  if not exists (select 1 from public.motorist_profiles where id=p_profile_id and organization_id=p_organization_id) then
    raise exception 'profile organization mismatch' using errcode = '42501';
  end if;
  if p_action in ('manual','end_wrap_up') then
    select current_session_id into v_discovered from public.motorist_operator_presence
      where organization_id=p_organization_id and profile_id=p_profile_id;
    v_session := v_discovered;
  end if;
  if v_session is not null then
    select * into s from public.motorist_call_sessions where id=v_session and organization_id=p_organization_id for update;
    if not found then raise exception 'session organization mismatch' using errcode = '42501'; end if;
  elsif p_action in ('dispatch','answer','pickup','release') then
    raise exception 'session required' using errcode = '22023';
  end if;
  select * into v from public.motorist_operator_presence
    where organization_id=p_organization_id and profile_id=p_profile_id for update;
  if not found then return pg_catalog.jsonb_build_object('applied',false,'reason','no_presence'); end if;
  if p_action in ('manual','end_wrap_up') and v.current_session_id is distinct from v_discovered then
    return pg_catalog.jsonb_build_object('applied',false,'reason','conflict','revision',v.presence_revision,'presence',pg_catalog.to_jsonb(v));
  end if;
  if (p_expected_revision is not null and v.presence_revision <> p_expected_revision)
    or (p_expected_token is not null and v.offer_token is distinct from p_expected_token) then
    return pg_catalog.jsonb_build_object('applied',false,'reason','stale_owner','revision',v.presence_revision,'presence',pg_catalog.to_jsonb(v));
  end if;
  v_status := v.status;
  v_token := v.offer_token;
  v_return := v.pause_return;
  v_reason := v.pause_reason_id;
  v_same := v.current_session_id = v_session and v_session is not null;

  if p_action = 'manual' then
    if p_status is null or p_status not in ('available','paused','offline') then raise exception 'invalid manual status' using errcode='22023'; end if;
    if v.status='on_call' and v.current_session_id is not null then
      return pg_catalog.jsonb_build_object('applied',false,'reason','on_call','revision',v.presence_revision,'presence',pg_catalog.to_jsonb(v));
    end if;
    if p_status='paused' and p_pause_reason_id is not null and not exists
      (select 1 from public.motorist_pause_reasons where id=p_pause_reason_id and organization_id=p_organization_id and active) then
      raise exception 'invalid pause reason' using errcode='22023';
    end if;
    v_status := p_status; v_reason := case when p_status='paused' then p_pause_reason_id else null end;
    v_token := null; v_return := null;
  elsif p_action in ('dispatch','pickup') then
    if s.state in ('ended','failed') then return pg_catalog.jsonb_build_object('applied',false,'reason','session_ended'); end if;
    if p_action='pickup' and s.presence_pickup is not null and s.presence_pickup->>'profileId' <> p_profile_id::text then
      return pg_catalog.jsonb_build_object('applied',false,'reason','pickup_owned');
    end if;
    if v_same and v.status in ('ringing','on_call') and v.offer_token is not null then
      if p_action='pickup' and s.presence_pickup is null then
        update public.motorist_call_sessions set presence_pickup=pg_catalog.jsonb_build_object('v',1,'profileId',p_profile_id,
          'offerToken',v.offer_token,'requestedAt',v_now,'expiresAt',v_now+interval '60 seconds') where id=v_session;
        return pg_catalog.jsonb_build_object('applied',true,'reused',false,'revision',v.presence_revision,'offerToken',v.offer_token,'presence',pg_catalog.to_jsonb(v));
      end if;
      return pg_catalog.jsonb_build_object('applied',true,'reused',true,'revision',v.presence_revision,'offerToken',v.offer_token,'presence',pg_catalog.to_jsonb(v));
    end if;
    if v.current_session_id is not null or not (
      v.status='available' or
      (v.status='after_call_work' and (v.wrap_up_until is null or v.wrap_up_until<=v_now) and v.pause_return is null) or
      (p_action='pickup' and (v.status='paused' or (v.status='after_call_work' and (v.wrap_up_until is null or v.wrap_up_until<=v_now) and v.pause_return->>'v'='1')))
    ) then return pg_catalog.jsonb_build_object('applied',false,'reason','unavailable','revision',v.presence_revision,'presence',pg_catalog.to_jsonb(v)); end if;
    v_token := pg_catalog.substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-',''),1,12);
    if p_action='pickup' and (v.status='paused' or v.pause_return->>'v'='1') then
      v_return := pg_catalog.jsonb_build_object('v',1,'sessionId',v_session,'profileId',p_profile_id,
        'pauseReasonId',coalesce(v.pause_reason_id,(v.pause_return->>'pauseReasonId')::uuid),
        'pausedSince',v.status_since,'ownerToken',v_token);
    end if;
    if p_action='pickup' then
      update public.motorist_call_sessions set presence_pickup=pg_catalog.jsonb_build_object('v',1,'profileId',p_profile_id,'offerToken',v_token,'requestedAt',v_now,'expiresAt',v_now+interval '60 seconds') where id=v_session;
    end if;
    v_status := 'ringing'; v_reason := null;
  elsif p_action='answer' then
    if not coalesce(v_same,false) or v.status not in ('ringing','on_call') or s.state in ('ended','failed')
      or (v.offer_token is not null and p_expected_token is null)
      or (v.offer_token is not null and s.presence_cancellations ? v.offer_token) then
      return pg_catalog.jsonb_build_object('applied',false,'reason','not_owner','revision',v.presence_revision,'presence',pg_catalog.to_jsonb(v));
    end if;
    if v.status='on_call' then return pg_catalog.jsonb_build_object('applied',true,'revision',v.presence_revision,'offerToken',v.offer_token,'presence',pg_catalog.to_jsonb(v)); end if;
    v_status := 'on_call'; v_reason := null;
  elsif p_action='release' then
    -- NULL ownership is never a match, including after another manual action.
    if not coalesce(v_same,false) then return pg_catalog.jsonb_build_object('applied',false,'reason','not_owner','revision',v.presence_revision,'presence',pg_catalog.to_jsonb(v)); end if;
    if p_status is null or p_status not in ('available','paused','offline','after_call_work') then raise exception 'invalid release status' using errcode='22023'; end if;
    v_status := p_status;
    if v_return->>'v'='1' and v_return->>'sessionId'=v_session::text and v_return->>'ownerToken'=v.offer_token then
      if p_status='after_call_work' and p_wrap_up_until > v_now then v_status := 'after_call_work';
      else v_status := 'paused'; v_reason := (v_return->>'pauseReasonId')::uuid; v_return := null; end if;
    elsif p_status='after_call_work' and (p_wrap_up_until is null or p_wrap_up_until <= v_now) then v_status := 'available';
    end if;
    if v_return is null then v_token := null; end if;
  elsif p_action='end_wrap_up' then
    if v.status <> 'after_call_work' then return pg_catalog.jsonb_build_object('applied',false,'reason','not_wrap_up','presence',pg_catalog.to_jsonb(v)); end if;
    if p_source='cron' then
      if v.wrap_up_until > v_now then return pg_catalog.jsonb_build_object('applied',false,'reason','not_due','presence',pg_catalog.to_jsonb(v)); end if;
      v_now := least(v_now,coalesce(v.wrap_up_until,v.status_since));
    end if;
    v_status := case when v_return->>'v'='1' and v_return->>'ownerToken'=v.offer_token then 'paused' else 'available' end;
    v_reason := case when v_status='paused' then (v_return->>'pauseReasonId')::uuid else null end;
    v_return := null; v_token := null;
  end if;

  if p_action in ('manual','release') and v.status='ringing' and v.current_session_id is not null then
      v_cancel_session := v_session;
      -- A token is retained even when no provider leg is known yet.
      update public.motorist_call_sessions set cancellations_next_attempt_at=v_now, presence_cancellations = presence_cancellations ||
        pg_catalog.jsonb_build_object(coalesce(v.offer_token,'legacy:'||p_profile_id::text),
          pg_catalog.jsonb_build_object('profileId',p_profile_id,'requestedAt',v_now,'reason',case when p_action='manual' then 'manual_presence' else 'offer_released' end))
        where id=v_session;
      update public.motorist_ring_attempts set result='cancelled', ended_at=v_now
        where session_id=v_session and profile_id=p_profile_id and result in ('pending','offered');
    end if;

  if p_action in ('manual','release') and s.presence_pickup->>'profileId'=p_profile_id::text
    and s.presence_pickup->>'offerToken'=v.offer_token then
    update public.motorist_call_sessions set presence_pickup=null where id=v_session;
  end if;
  update public.motorist_operator_presence set status=v_status,
    current_session_id=case when p_action in ('dispatch','pickup','answer') then v_session else null end,
    pause_reason_id=case when v_status='paused' then v_reason when v_return->>'v'='1' then (v_return->>'pauseReasonId')::uuid else null end,
    wrap_up_until=case when v_status='after_call_work' then p_wrap_up_until else null end,
    offer_token=v_token, pause_return=v_return, status_since=v_now, updated_at=pg_catalog.clock_timestamp()
    where id=v.id returning * into v;
  -- State and its history are one transaction; retries do not append twice.
  update public.motorist_operator_statuses set ended_at=v_now
    where organization_id=p_organization_id and profile_id=p_profile_id and ended_at is null;
  insert into public.motorist_operator_statuses(organization_id,profile_id,status,reason,source,started_at,ended_at)
    values(p_organization_id,p_profile_id,v.status,case when v.status='paused' and p_action<>'manual'
      then coalesce((select label from public.motorist_pause_reasons where id=v.pause_reason_id),p_reason)
      else coalesce(p_reason,(select label from public.motorist_pause_reasons where id=v.pause_reason_id)) end,p_source,v_now,null);
  return pg_catalog.jsonb_build_object('applied',true,'revision',v.presence_revision,'offerToken',v.offer_token,'cancellationSessionId',v_cancel_session,'presence',pg_catalog.to_jsonb(v));
end;
$$;
revoke all on function public.motorist_presence_transition_v1(uuid,uuid,text,uuid,bigint,text,text,uuid,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.motorist_presence_transition_v1(uuid,uuid,text,uuid,bigint,text,text,uuid,timestamptz,text,text) to service_role;

-- Original signature retained. Legacy reservations cannot bypass paused return
-- or steal ringing ownership, and still support available outbound initiators.
create or replace function public.motorist_reserve_operator(p_profile_id uuid,p_session_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_org uuid; v public.motorist_operator_presence%rowtype; v_result jsonb;
begin
  select organization_id into v_org from public.motorist_call_sessions where id=p_session_id;
  if v_org is null then return false; end if;
  select * into v from public.motorist_operator_presence where profile_id=p_profile_id and organization_id=v_org;
  if not found then return false; end if;
  if v.current_session_id is null then
    v_result := public.motorist_presence_transition_v1(v_org,p_profile_id,'dispatch',p_session_id,v.presence_revision);
    if not (v_result->>'applied')::boolean then return false; end if;
  end if;
  v_result := public.motorist_presence_transition_v1(v_org,p_profile_id,'answer',p_session_id,
    coalesce((v_result->>'revision')::bigint,v.presence_revision),coalesce(v_result->>'offerToken',v.offer_token));
  return coalesce((v_result->>'applied')::boolean,false);
end;
$$;
revoke all on function public.motorist_reserve_operator(uuid,uuid) from public,anon,authenticated;
grant execute on function public.motorist_reserve_operator(uuid,uuid) to service_role;
