-- Additive, opt-in by capability detection. No scheduler and no customer draft content.
create index if not exists motorist_case_events_live_snapshot_idx
  on public.motorist_case_events(organization_id,case_id,created_at desc,id desc);
create table public.motorist_case_live_versions (
  case_id uuid primary key references public.motorist_cases(id) on delete cascade,
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0)
);
create index on public.motorist_case_live_versions(organization_id, case_id);
insert into public.motorist_case_live_versions(case_id,organization_id) select id,organization_id from public.motorist_cases;
create table public.motorist_case_editor_sessions (
  id uuid primary key,
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null references public.motorist_profiles(id) on delete cascade,
  case_id uuid references public.motorist_cases(id) on delete cascade,
  expires_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create index on public.motorist_case_editor_sessions(organization_id, expires_at);
alter table public.motorist_case_live_versions enable row level security;
alter table public.motorist_case_editor_sessions enable row level security;
-- HTTP reads and every heartbeat resolve the signed-in actor before calling the RPC.
-- Current card access is organization + dispatcher/senior/manager/admin, the same
-- predicate as loadCaseDetail. Future private cards must change this predicate too.
revoke all on public.motorist_case_live_versions, public.motorist_case_editor_sessions from public,anon,authenticated;

create function public.motorist_case_collaboration(p_organization_id uuid,p_actor_profile_id uuid,p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_session uuid; v_case uuid; v_now timestamptz:=clock_timestamp(); v_result jsonb; v_count integer;
begin
  if not exists(select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
    where p.id=p_actor_profile_id and p.organization_id=p_organization_id and p.active and p.access_status='active' and p.role in ('dispatcher','senior_dispatcher','manager','admin'))
    then raise exception 'Case access denied' using errcode='42501'; end if;
  if p_action='authorize' then return '{}'::jsonb; end if;
  if p_action='snapshot' then
    -- Every resource and its revision comes from one SQL statement/MVCC snapshot.
    -- The changed batch is bounded; shared resources are deduplicated across cards.
    with current_versions as materialized (
      select v.case_id,v.revision from public.motorist_case_live_versions v
      join public.motorist_cases c on c.id=v.case_id and c.organization_id=p_organization_id
      where v.organization_id=p_organization_id
    ), changed_ids as materialized (
      select v.case_id from current_versions v
      where (p_input->'versions'->>v.case_id::text) is distinct from v.revision::text
      order by v.case_id limit 41
    ), changed_cases as materialized (
      select c.* from public.motorist_cases c
      join (select case_id from changed_ids order by case_id limit 40) v on v.case_id=c.id
      where c.organization_id=p_organization_id
    ), recent_events as materialized (
      select e.* from changed_cases c cross join lateral (
        select e.* from public.motorist_case_events e
        where e.organization_id=p_organization_id and e.case_id=c.id
        order by e.created_at desc,e.id desc limit 200
      ) e
    ), latest_submissions as materialized (
      select s.* from changed_cases c cross join lateral (
        select s.* from public.motorist_location_submissions s
        where s.organization_id=p_organization_id and s.case_id=c.id and s.accepted
        order by s.submitted_at desc,s.id desc limit 1
      ) s
    ), contact_ids as (select contact_id id from changed_cases where contact_id is not null),
    vehicle_ids as (select vehicle_id id from changed_cases where vehicle_id is not null),
    location_ids as (
      select pickup_location_id id from changed_cases union select destination_location_id from changed_cases
      union select location_id from latest_submissions
    ), profile_ids as (
      select owner_id id from changed_cases union select actor_profile_id from recent_events
    )
    select jsonb_build_object(
      'versions',coalesce((select jsonb_object_agg(v.case_id,v.revision) from current_versions v),'{}'::jsonb),
      'more',(select count(*)>40 from changed_ids),
      'details',jsonb_build_object(
        'cases',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from changed_cases c),'[]'::jsonb),
        'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc,e.id desc) from recent_events e),'[]'::jsonb),
        'submissions',coalesce((select jsonb_agg(to_jsonb(s)) from latest_submissions s),'[]'::jsonb),
        'contacts',coalesce((select jsonb_agg(to_jsonb(c)) from public.motorist_contacts c where c.organization_id=p_organization_id and c.id in (select id from contact_ids)),'[]'::jsonb),
        'vehicles',coalesce((select jsonb_agg(to_jsonb(v)) from public.motorist_vehicles v where v.organization_id=p_organization_id and v.id in (select id from vehicle_ids)),'[]'::jsonb),
        'locations',coalesce((select jsonb_agg(to_jsonb(l)) from public.motorist_locations l where l.organization_id=p_organization_id and l.id in (select id from location_ids)),'[]'::jsonb),
        'profiles',coalesce((select jsonb_agg(to_jsonb(p)) from public.motorist_profiles p where p.organization_id=p_organization_id and p.id in (select id from profile_ids)),'[]'::jsonb)
      ),
      'editors',coalesce((select jsonb_agg(jsonb_build_object('sessionId',s.id,'profileId',p.id,'displayName',p.display_name,
        'caseId',s.case_id,'draftId',case when s.case_id is null then s.id else null end,'expiresAt',s.expires_at) order by s.created_at,s.id)
      from public.motorist_case_editor_sessions s join public.motorist_profiles p on p.id=s.profile_id and p.organization_id=s.organization_id and p.active and p.access_status='active' and p.role in ('dispatcher','senior_dispatcher','manager','admin')
      where s.organization_id=p_organization_id and s.ended_at is null and s.expires_at>v_now
        and (s.case_id is null or exists(select 1 from public.motorist_cases c where c.id=s.case_id and c.organization_id=p_organization_id))),'[]'::jsonb)) into v_result;
    return v_result;
  end if;
  if p_action not in ('heartbeat','leave','commit') then raise exception 'Invalid editor action' using errcode='22023'; end if;
  v_session:=(p_input->>'sessionId')::uuid; v_case:=(p_input->>'caseId')::uuid;
  if v_session is null then raise exception 'Editor session required' using errcode='22023'; end if;
  if exists(select 1 from public.motorist_case_editor_sessions where id=v_session and (organization_id<>p_organization_id or profile_id<>p_actor_profile_id))
    then raise exception 'Editor session access denied' using errcode='42501'; end if;
  if v_case is not null and not exists(select 1 from public.motorist_cases where id=v_case and organization_id=p_organization_id)
    then raise exception 'Case access denied' using errcode='42501'; end if;
  -- Keep ended sessions as tombstones so late heartbeats cannot resurrect a draft.
  if p_action in ('leave','commit') then
    insert into public.motorist_case_editor_sessions(id,organization_id,profile_id,case_id,expires_at,ended_at)
      values(v_session,p_organization_id,p_actor_profile_id,v_case,v_now,v_now)
      on conflict(id) do update set ended_at=v_now,expires_at=v_now,case_id=coalesce(v_case,motorist_case_editor_sessions.case_id)
      where motorist_case_editor_sessions.organization_id=p_organization_id and motorist_case_editor_sessions.profile_id=p_actor_profile_id;
  else
    if exists(select 1 from public.motorist_case_editor_sessions where id=v_session and ended_at is not null)
      then return jsonb_build_object('ended',true); end if;
    if not exists(select 1 from public.motorist_case_editor_sessions where id=v_session) then
      select count(*) into v_count from public.motorist_case_editor_sessions where organization_id=p_organization_id and profile_id=p_actor_profile_id and expires_at>v_now and ended_at is null;
      if v_count>=12 then raise exception 'Too many editor sessions' using errcode='22023'; end if;
    end if;
    insert into public.motorist_case_editor_sessions(id,organization_id,profile_id,case_id,expires_at)
      values(v_session,p_organization_id,p_actor_profile_id,v_case,v_now+interval '60 seconds')
      on conflict(id) do update set expires_at=excluded.expires_at,case_id=excluded.case_id
      where motorist_case_editor_sessions.organization_id=p_organization_id and motorist_case_editor_sessions.profile_id=p_actor_profile_id and motorist_case_editor_sessions.ended_at is null;
  end if;
  -- Bounded opportunistic cleanup; tombstones outlive any client request timeout.
  delete from public.motorist_case_editor_sessions where id in (select id from public.motorist_case_editor_sessions
    where organization_id=p_organization_id and expires_at<v_now-interval '1 day' order by expires_at limit 100);
  return jsonb_build_object('expiresAt',v_now+interval '60 seconds');
end $$;
revoke all on function public.motorist_case_collaboration(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_case_collaboration(uuid,uuid,text,jsonb) to service_role;

create function app_private.motorist_case_live_change() returns trigger language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_case uuid; v_old jsonb:=to_jsonb(old); v_new jsonb:=to_jsonb(new); v_ids uuid[];
begin
  v_org:=coalesce((v_new->>'organization_id')::uuid,(v_old->>'organization_id')::uuid);
  if tg_table_name='motorist_cases' then v_ids:=array[coalesce((v_new->>'id')::uuid,(v_old->>'id')::uuid)];
  elsif tg_table_name in ('motorist_case_events','motorist_location_submissions') then v_ids:=array[(v_new->>'case_id')::uuid,(v_old->>'case_id')::uuid];
  else
    select array_agg(c.id) into v_ids from public.motorist_cases c where c.organization_id=v_org and (
      (tg_table_name='motorist_contacts' and c.contact_id in ((v_new->>'id')::uuid,(v_old->>'id')::uuid)) or
      (tg_table_name='motorist_vehicles' and c.vehicle_id in ((v_new->>'id')::uuid,(v_old->>'id')::uuid)) or
      (tg_table_name='motorist_locations' and (c.pickup_location_id in ((v_new->>'id')::uuid,(v_old->>'id')::uuid) or c.destination_location_id in ((v_new->>'id')::uuid,(v_old->>'id')::uuid))) or
      (tg_table_name='motorist_profiles' and c.owner_id in ((v_new->>'id')::uuid,(v_old->>'id')::uuid)));
  end if;
  foreach v_case in array coalesce(v_ids,'{}'::uuid[]) loop
    insert into public.motorist_case_live_versions(case_id,organization_id,revision)
      select id,organization_id,1 from public.motorist_cases where id=v_case and organization_id=v_org
      on conflict(case_id) do update set revision=motorist_case_live_versions.revision+1;
  end loop;
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send('{}'::jsonb,'invalidate','cases:'||v_org::text,true);
  end if;
  return coalesce(new,old);
end $$;
do $$ declare t text; begin
  foreach t in array array['motorist_cases','motorist_case_events','motorist_location_submissions','motorist_contacts','motorist_vehicles','motorist_locations','motorist_profiles'] loop
    execute format('create trigger motorist_case_live_change after insert or update or delete on public.%I for each row execute function app_private.motorist_case_live_change()',t);
  end loop;
end $$;

create function app_private.motorist_collaboration_invalidate() returns trigger language plpgsql security definer set search_path='' as $$
declare v_old jsonb:=to_jsonb(old); v_new jsonb:=to_jsonb(new); v_org uuid; v_profile uuid; v_note uuid;
begin
  v_org:=coalesce((v_new->>'organization_id')::uuid,(v_old->>'organization_id')::uuid);
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then return coalesce(new,old); end if;
  if tg_table_name='motorist_case_editor_sessions' then
    if tg_op='UPDATE' and v_new->'case_id' is not distinct from v_old->'case_id' and v_new->'ended_at' is not distinct from v_old->'ended_at' then return new; end if;
    perform realtime.send('{}'::jsonb,'invalidate','cases:'||v_org::text,true);
  elsif tg_table_name in ('motorist_case_tasks','motorist_task_messages','motorist_task_case_links') then
    perform realtime.send('{}'::jsonb,'invalidate','tasks:'||v_org::text,true);
  elsif tg_table_name='motorist_notifications' then
    for v_profile in select p.id from public.motorist_profiles p where p.organization_id=v_org and p.active and p.access_status='active' and
      (p.id in ((v_new->>'recipient_profile_id')::uuid,(v_old->>'recipient_profile_id')::uuid) or
      v_new->>'visibility'='team' or v_old->>'visibility'='team') loop
      perform realtime.send('{}'::jsonb,'invalidate','notifications:'||v_org::text||':'||v_profile::text,true);
    end loop;
  elsif tg_table_name='motorist_profiles' then
    v_profile:=coalesce((v_new->>'id')::uuid,(v_old->>'id')::uuid);
    perform realtime.send('{}'::jsonb,case when tg_op='DELETE' or not coalesce((v_new->>'active')::boolean,false)
      or v_new->>'access_status' is distinct from 'active' or v_new->>'role' not in ('dispatcher','senior_dispatcher','manager','admin') or v_new->>'organization_id' is distinct from v_old->>'organization_id'
      then 'revoke' else 'authorize' end,'notifications:'||v_org::text||':'||v_profile::text,true);
    perform realtime.send('{}'::jsonb,'invalidate','notebook:'||v_org::text||':'||v_profile::text,true);
    perform realtime.send('{}'::jsonb,'invalidate','tasks:'||v_org::text,true);
  elsif tg_table_name in ('motorist_notes','motorist_note_shares') then
    v_note:=case when tg_table_name='motorist_notes' then coalesce((v_new->>'id')::uuid,(v_old->>'id')::uuid) else coalesce((v_new->>'note_id')::uuid,(v_old->>'note_id')::uuid) end;
    for v_profile in
      select (v_new->>'owner_profile_id')::uuid union select (v_old->>'owner_profile_id')::uuid
      union select (v_new->>'recipient_profile_id')::uuid union select (v_old->>'recipient_profile_id')::uuid
      union select n.owner_profile_id from public.motorist_notes n where n.id=v_note
      union select s.recipient_profile_id from public.motorist_note_shares s where s.note_id=v_note
    loop
      if v_profile is not null then perform realtime.send('{}'::jsonb,'invalidate','notebook:'||v_org::text||':'||v_profile::text,true); end if;
    end loop;
  end if;
  return coalesce(new,old);
end $$;
do $$ declare t text; begin
  foreach t in array array['motorist_case_editor_sessions','motorist_case_tasks','motorist_task_messages','motorist_task_case_links','motorist_notifications','motorist_profiles','motorist_notes','motorist_note_shares'] loop
    execute format('create trigger motorist_collaboration_invalidate after insert or update or delete on public.%I for each row execute function app_private.motorist_collaboration_invalidate()',t);
  end loop;
  if to_regclass('realtime.messages') is not null then
    execute $p$create policy motorist_cases_broadcast_read on realtime.messages for select to authenticated using(extension='broadcast' and exists(
      select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
      where p.user_id=auth.uid() and p.active and p.access_status='active' and p.role in ('dispatcher','senior_dispatcher','manager','admin')
      and realtime.topic() in ('cases:'||p.organization_id::text,'notifications:'||p.organization_id::text||':'||p.id::text)))$p$;
  end if;
end $$;
revoke all on function app_private.motorist_case_live_change(), app_private.motorist_collaboration_invalidate() from public,anon,authenticated;
