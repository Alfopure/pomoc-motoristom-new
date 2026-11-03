-- Moja práca: the executor's position during their own accepted operation (jazda,
-- odvoz, presun) also in the background, as Pristavenia does since
-- 20261022180000_mobile_delivery_background.sql. Applies after
-- 20261028140000_operation_positions.sql; on TEST nzpnqdstvkfncflgqlny only after
-- the owner's explicit approval, production needs its own.
--
-- The same design as the delivery trackers: a secret for one operation and one
-- member, only its hash kept, lets the phone send positions without the sign-in
-- session. The same rules as the open app's readings: only the assigned member,
-- only while accepted/en_route/arrived/collected, never for work that came
-- through a legacy app delivery (Pristavenia track it), nothing from before the
-- current assignment, at most one per 10 seconds, kept 30 days. Readings the
-- phone kept without signal may be up to half a day old, as for deliveries.
-- Service-role RPCs only; no client grants.
begin;

do $$ begin
  if to_regprocedure('public.motorist_operation_position(uuid,uuid,uuid,jsonb)') is null then
    raise exception 'Run 20261028140000_operation_positions.sql first' using errcode = '55000';
  end if;
end $$;

-- 1. The secrets. A new one replaces the previous for the same operation and
-- member; it ends with the operation, a reassignment, the member's logout or lost
-- access, and in any case after 8 days.
create table public.motorist_operation_trackers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  operation_id uuid not null references public.motorist_operations(id) on delete cascade,
  member_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key (organization_id, member_id) references public.motorist_towing_memberships(organization_id, id) on delete cascade
);
create index motorist_operation_trackers_live_idx on public.motorist_operation_trackers (operation_id, member_id) where revoked_at is null;
alter table public.motorist_operation_trackers enable row level security;
revoke all on public.motorist_operation_trackers from public, anon, authenticated, service_role;

-- 2. A batch of readings for one operation, by the rules of the open app's
-- motorist_operation_position. The caller has locked the execution row.
-- `active` false: the work no longer takes this member's position.
create function app_private.motorist_operation_record_positions(p_organization_id uuid, p_operation_id uuid, p_member_id uuid, p_positions jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ex public.motorist_logistics_executions; m public.motorist_towing_memberships; item jsonb; stored integer:=0;
 v_lat double precision; v_lng double precision; v_accuracy real; v_recorded timestamptz; v_from timestamptz; last_at timestamptz;
begin
 if jsonb_typeof(p_positions) is distinct from 'array' or jsonb_array_length(p_positions) not between 1 and 100 then raise exception 'Invalid positions' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(p_positions) loop
  if jsonb_typeof(item) is distinct from 'object' or (item-array['lat','lng','accuracy','recordedAt'])<>'{}'::jsonb
   or jsonb_typeof(item->'lat') is distinct from 'number' or jsonb_typeof(item->'lng') is distinct from 'number'
   or coalesce(jsonb_typeof(item->'accuracy'),'null') not in ('number','null') or jsonb_typeof(item->'recordedAt') is distinct from 'string' then
   raise exception 'Invalid position' using errcode='22023';
  end if;
 end loop;
 select e.* into ex from public.motorist_logistics_executions e join public.motorist_operations o on o.id=e.operation_id
  where e.operation_id=p_operation_id and e.organization_id=p_organization_id and o.organization_id=p_organization_id and o.towing_order_id is null;
 select * into m from public.motorist_towing_memberships where id=p_member_id and organization_id=p_organization_id;
 if ex.operation_id is null or ex.assignee_id is distinct from p_member_id or ex.status not in ('accepted','en_route','arrived','collected')
  or not coalesce(app_private.motorist_delivery_member_ready(m),false)
  or exists(select 1 from public.motorist_case_handoffs h where h.operation_id=p_operation_id) then
  return jsonb_build_object('stored',0,'active',false);
 end if;
 -- Nothing from before the current assignment or this member's own first step in it.
 select coalesce(
   (select min(ev.created_at) from public.motorist_operation_events ev
     where ev.operation_id=p_operation_id and ev.actor_user_id=m.auth_user_id and ev.action in ('accept','start','arrive','collect')
      and ev.created_at>=coalesce((select max(a.created_at) from public.motorist_operation_events a where a.operation_id=p_operation_id and a.action='assign'),'-infinity'::timestamptz)),
   (select max(a.created_at) from public.motorist_operation_events a where a.operation_id=p_operation_id and a.action='assign'),
   '-infinity'::timestamptz) into v_from;
 v_from:=greatest(clock_timestamp()-interval '12 hours',v_from-interval '1 minute');
 select max(recorded_at) into last_at from public.motorist_operation_positions where operation_id=p_operation_id;
 for item in select value from jsonb_array_elements(p_positions) order by (value->>'recordedAt')::timestamptz loop
  v_lat:=(item->>'lat')::double precision; v_lng:=(item->>'lng')::double precision;
  v_accuracy:=(item->>'accuracy')::real; v_recorded:=(item->>'recordedAt')::timestamptz;
  if v_lat not between -90 and 90 or v_lng not between -180 and 180 or (v_accuracy is not null and (v_accuracy<0 or v_accuracy>100000)) then
   raise exception 'Invalid position' using errcode='22023';
  end if;
  continue when v_recorded<v_from or v_recorded>clock_timestamp()+interval '2 minutes'
   or (last_at is not null and v_recorded<last_at+interval '10 seconds');
  insert into public.motorist_operation_positions(organization_id,operation_id,member_id,lat,lng,accuracy_m,recorded_at)
   values(p_organization_id,p_operation_id,p_member_id,v_lat,v_lng,v_accuracy,v_recorded);
  stored:=stored+1; last_at:=v_recorded;
 end loop;
 return jsonb_build_object('stored',stored,'active',true);
end $$;
revoke all on function app_private.motorist_operation_record_positions(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;

-- 3. Issue or revoke the secret of the member's own operation. Issuing needs the
-- work as it is tracked (assigned to this member, accepted and open, not a legacy
-- delivery); revoking (logout, the phone stops) works on any state. Locks follow the
-- operation commands: the operation row, then its execution, then the secrets (the
-- inserts' foreign keys lock the operation row again, which is already held).
create function public.motorist_operation_tracker(p_user_id uuid, p_organization_id uuid, p_operation_id uuid, p_action text, p_token_hash text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; member uuid; ex public.motorist_logistics_executions; m public.motorist_towing_memberships; v_expires timestamptz;
begin
 -- Re-authorizes the current membership (version, organization) on every call.
 actor:=app_private.operations_actor(p_user_id,p_organization_id);
 member:=(actor->>'memberId')::uuid;
 if member is null then raise exception 'Forbidden' using errcode='42501'; end if;
 select * into m from public.motorist_towing_memberships where id=member and organization_id=p_organization_id;
 if not coalesce(app_private.motorist_delivery_member_ready(m),false) then raise exception 'Forbidden' using errcode='42501'; end if;
 if p_action is null or p_action not in ('issue','revoke') then raise exception 'Invalid action' using errcode='22023'; end if;
 perform 1 from public.motorist_operations where id=p_operation_id and organization_id=p_organization_id for key share;
 select e.* into ex from public.motorist_logistics_executions e join public.motorist_operations o on o.id=e.operation_id
  where e.operation_id=p_operation_id and e.organization_id=p_organization_id and o.organization_id=p_organization_id and o.towing_order_id is null
  for update of e;
 if not found then raise exception 'Operation unavailable' using errcode='P0002'; end if;
 if p_action='revoke' then
  update public.motorist_operation_trackers set revoked_at=clock_timestamp() where operation_id=p_operation_id and member_id=member and revoked_at is null;
  return jsonb_build_object('revoked',true);
 end if;
 if p_token_hash is null or p_token_hash!~'^[a-f0-9]{64}$' then raise exception 'Invalid tracker' using errcode='22023'; end if;
 if ex.assignee_id is distinct from member or ex.status not in ('accepted','en_route','arrived','collected')
  or exists(select 1 from public.motorist_case_handoffs h where h.operation_id=p_operation_id) then
  raise exception 'Not tracking' using errcode='PT409';
 end if;
 update public.motorist_operation_trackers set revoked_at=clock_timestamp() where operation_id=p_operation_id and member_id=member and revoked_at is null;
 insert into public.motorist_operation_trackers(organization_id,operation_id,member_id,token_hash,expires_at)
  values(p_organization_id,p_operation_id,member,p_token_hash,clock_timestamp()+interval '8 days') returning expires_at into v_expires;
 return jsonb_build_object('expiresAt',v_expires);
end $$;
revoke all on function public.motorist_operation_tracker(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.motorist_operation_tracker(uuid,uuid,uuid,text,text) to service_role;

-- 4. What the phone sends in the background, identified only by the secret's hash.
-- An unknown, ended or revoked secret, or work that no longer takes this member's
-- position, answers `active` false (and the secret ends), so the phone stops.
-- Locks in the order of the operation commands: operation, execution, secret.
create function public.motorist_operation_track(p_token_hash text, p_positions jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.motorist_operation_trackers; result jsonb;
begin
 if p_token_hash is null or p_token_hash!~'^[a-f0-9]{64}$' then return jsonb_build_object('stored',0,'active',false); end if;
 select * into t from public.motorist_operation_trackers where token_hash=p_token_hash;
 if not found then return jsonb_build_object('stored',0,'active',false); end if;
 perform 1 from public.motorist_operations where id=t.operation_id for key share;
 perform 1 from public.motorist_logistics_executions where operation_id=t.operation_id for update;
 select * into t from public.motorist_operation_trackers where id=t.id for update;
 if t.revoked_at is not null or t.expires_at<=clock_timestamp() then return jsonb_build_object('stored',0,'active',false); end if;
 result:=app_private.motorist_operation_record_positions(t.organization_id,t.operation_id,t.member_id,p_positions);
 if not (result->>'active')::boolean then update public.motorist_operation_trackers set revoked_at=clock_timestamp() where id=t.id; end if;
 return result;
end $$;
revoke all on function public.motorist_operation_track(text,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_operation_track(text,jsonb) to service_role;

-- 5. Retention: the existing hourly upkeep step also removes spent operation
-- secrets after 30 days. Same body as 20261028140000 plus that one delete; the
-- returned count still covers both position tables only.
create or replace function public.motorist_handoff_positions_prune() returns integer language plpgsql security definer set search_path='' as $$
declare deleted integer; operations integer; begin
 delete from public.motorist_handoff_positions where received_at<clock_timestamp()-interval '30 days';
 get diagnostics deleted = row_count;
 delete from public.motorist_operation_positions where received_at<clock_timestamp()-interval '30 days';
 get diagnostics operations = row_count;
 delete from public.motorist_handoff_trackers where coalesce(revoked_at,expires_at)<clock_timestamp()-interval '30 days';
 delete from public.motorist_operation_trackers where coalesce(revoked_at,expires_at)<clock_timestamp()-interval '30 days';
 return deleted+operations;
end $$;
revoke all on function public.motorist_handoff_positions_prune() from public,anon,authenticated;
grant execute on function public.motorist_handoff_positions_prune() to service_role;

notify pgrst, 'reload schema';
commit;
