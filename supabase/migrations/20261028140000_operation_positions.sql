begin;
-- Moja práca (M1): where the executor is during their own accepted logistics
-- operation (jazda, odvoz, presun), for dispatch. Positions of legacy handoffs
-- stay in motorist_handoff_positions; this is the same rule at operation level:
-- only the assigned member, only while accepted/en_route/arrived/collected,
-- throttled, and kept 30 days. Service-role RPC only; no client grants.

create table public.motorist_operation_positions (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  operation_id uuid not null references public.motorist_operations(id) on delete cascade,
  member_id uuid not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy_m real check (accuracy_m is null or (accuracy_m >= 0 and accuracy_m <= 100000)),
  recorded_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, member_id) references public.motorist_towing_memberships(organization_id, id) on delete cascade
);
create index motorist_operation_positions_operation_idx on public.motorist_operation_positions (operation_id, recorded_at desc);
create index motorist_operation_positions_received_idx on public.motorist_operation_positions (received_at);
create index motorist_operation_positions_member_idx on public.motorist_operation_positions (organization_id, member_id);
alter table public.motorist_operation_positions enable row level security;
revoke all on public.motorist_operation_positions from public, anon, authenticated, service_role;
revoke all on sequence public.motorist_operation_positions_id_seq from public, anon, authenticated, service_role;

-- `active` false tells the phone to stop: not (or no longer) this member's open, accepted work.
create function public.motorist_operation_position(p_user_id uuid, p_organization_id uuid, p_operation_id uuid, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; member uuid; ex public.motorist_logistics_executions; m public.motorist_towing_memberships;
 v_lat double precision; v_lng double precision; v_accuracy real; v_recorded timestamptz; v_since timestamptz; last_at timestamptz;
begin
 -- Re-authorizes the current membership (version, organization) on every reading.
 actor:=app_private.operations_actor(p_user_id,p_organization_id);
 member:=(actor->>'memberId')::uuid;
 if member is null then raise exception 'Forbidden' using errcode='42501'; end if;
 if jsonb_typeof(p_input) is distinct from 'object' or (p_input-array['lat','lng','accuracy','recordedAt'])<>'{}'::jsonb
  or jsonb_typeof(p_input->'lat') is distinct from 'number' or jsonb_typeof(p_input->'lng') is distinct from 'number'
  or coalesce(jsonb_typeof(p_input->'accuracy'),'null') not in ('number','null') or jsonb_typeof(p_input->'recordedAt') is distinct from 'string' then
  raise exception 'Invalid position' using errcode='22023';
 end if;
 v_lat:=(p_input->>'lat')::double precision; v_lng:=(p_input->>'lng')::double precision;
 v_accuracy:=(p_input->>'accuracy')::real; v_recorded:=(p_input->>'recordedAt')::timestamptz;
 if v_lat not between -90 and 90 or v_lng not between -180 and 180 or (v_accuracy is not null and (v_accuracy<0 or v_accuracy>100000)) then
  raise exception 'Invalid position' using errcode='22023';
 end if;
 select e.* into ex from public.motorist_logistics_executions e join public.motorist_operations o on o.id=e.operation_id
  where e.operation_id=p_operation_id and e.organization_id=p_organization_id and o.organization_id=p_organization_id and o.towing_order_id is null;
 if not found then raise exception 'Operation unavailable' using errcode='P0002'; end if;
 select * into m from public.motorist_towing_memberships where id=member and organization_id=p_organization_id;
 -- Work that came through a legacy app delivery keeps its own handoff positions (Pristavenia).
 if ex.assignee_id is distinct from member or ex.status not in ('accepted','en_route','arrived','collected')
  or not coalesce(app_private.motorist_delivery_member_ready(m),false)
  or exists(select 1 from public.motorist_case_handoffs h where h.operation_id=p_operation_id) then
  return jsonb_build_object('stored',false,'active',false);
 end if;
 -- Nothing from before this member's own first step in the current assignment.
 select min(ev.created_at) into v_since from public.motorist_operation_events ev
  where ev.operation_id=p_operation_id and ev.actor_user_id=p_user_id and ev.action in ('accept','start','arrive','collect')
   and ev.created_at>=coalesce((select max(a.created_at) from public.motorist_operation_events a where a.operation_id=p_operation_id and a.action='assign'),'-infinity'::timestamptz);
 if v_recorded<greatest(clock_timestamp()-interval '15 minutes',coalesce(v_since,'-infinity'::timestamptz)-interval '1 minute') or v_recorded>clock_timestamp()+interval '2 minutes' then
  return jsonb_build_object('stored',false,'active',true);
 end if;
 select max(recorded_at) into last_at from public.motorist_operation_positions where operation_id=p_operation_id;
 if last_at is not null and v_recorded<last_at+interval '10 seconds' then return jsonb_build_object('stored',false,'active',true); end if;
 insert into public.motorist_operation_positions(organization_id,operation_id,member_id,lat,lng,accuracy_m,recorded_at)
  values(p_organization_id,p_operation_id,member,v_lat,v_lng,v_accuracy,v_recorded);
 return jsonb_build_object('stored',true,'active',true);
end $$;
revoke all on function public.motorist_operation_position(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_operation_position(uuid,uuid,uuid,jsonb) to service_role;

-- What Moja práca adds to the member's own operations: whether the work belongs to a
-- legacy app delivery (then it stays in Pristavenia only, never in two flows) and the
-- branch request's note for the executor. Only operations assigned to this member.
create function public.motorist_field_operations_context(p_user_id uuid, p_organization_id uuid, p_operation_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; member uuid;
begin
 actor:=app_private.operations_actor(p_user_id,p_organization_id);
 member:=(actor->>'memberId')::uuid;
 if member is null then raise exception 'Forbidden' using errcode='42501'; end if;
 if p_operation_ids is null or cardinality(p_operation_ids)>100 then raise exception 'Invalid operations' using errcode='22023'; end if;
 return coalesce((select jsonb_object_agg(e.operation_id::text, jsonb_build_object(
   'legacy', exists(select 1 from public.motorist_case_handoffs h where h.operation_id=e.operation_id),
   'instructions', (select left(nullif(btrim(r.note),''),4000) from public.motorist_work_requests r where r.operation_id=e.operation_id and r.organization_id=p_organization_id)))
  from public.motorist_logistics_executions e
  where e.organization_id=p_organization_id and e.assignee_id=member and e.operation_id=any(p_operation_ids)),'{}'::jsonb);
end $$;
revoke all on function public.motorist_field_operations_context(uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.motorist_field_operations_context(uuid,uuid,uuid[]) to service_role;

-- Dispatch reads where the executor last was: office operations actor only, the
-- latest reading of this operation with the member's name, or null.
create function public.motorist_operation_last_position(p_user_id uuid, p_organization_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; result jsonb;
begin
 actor:=app_private.operations_actor(p_user_id,p_organization_id);
 if not coalesce((actor->>'canDispatch')::boolean,false) or coalesce((actor->>'branchScoped')::boolean,false) then raise exception 'Forbidden' using errcode='42501'; end if;
 if not exists(select 1 from public.motorist_operations o where o.id=p_operation_id and o.organization_id=p_organization_id) then raise exception 'Operation unavailable' using errcode='P0002'; end if;
 select jsonb_build_object('lat',q.lat,'lng',q.lng,'accuracy',q.accuracy_m,'recordedAt',q.recorded_at,'member',m.display_name) into result
  from public.motorist_operation_positions q join public.motorist_towing_memberships m on m.id=q.member_id
  where q.operation_id=p_operation_id and q.organization_id=p_organization_id order by q.recorded_at desc limit 1;
 return jsonb_build_object('position',result);
end $$;
revoke all on function public.motorist_operation_last_position(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.motorist_operation_last_position(uuid,uuid,uuid) to service_role;

-- Retention: the existing hourly upkeep step (cron -> motorist_handoff_positions_prune)
-- removes operation positions after 30 days as well. Same body as 20261022180000 plus
-- the new table; the returned count covers both position tables.
create or replace function public.motorist_handoff_positions_prune() returns integer language plpgsql security definer set search_path='' as $$
declare deleted integer; operations integer; begin
 delete from public.motorist_handoff_positions where received_at<clock_timestamp()-interval '30 days';
 get diagnostics deleted = row_count;
 delete from public.motorist_operation_positions where received_at<clock_timestamp()-interval '30 days';
 get diagnostics operations = row_count;
 delete from public.motorist_handoff_trackers where coalesce(revoked_at,expires_at)<clock_timestamp()-interval '30 days';
 return deleted+operations;
end $$;
revoke all on function public.motorist_handoff_positions_prune() from public,anon,authenticated;
grant execute on function public.motorist_handoff_positions_prune() to service_role;

notify pgrst, 'reload schema';
commit;
