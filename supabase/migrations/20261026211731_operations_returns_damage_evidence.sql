begin;

-- Preserve the original damage report. Only its responsible person and resolution
-- state may change; the operation command/event supplies revision and audit.
alter table public.motorist_operation_evidence
 add column damage_resolver text check(length(damage_resolver)<=300),
 add column damage_status text check(damage_status in ('open','resolved'));
alter table public.motorist_operation_evidence alter column created_at set default clock_timestamp();
update public.motorist_operation_evidence set damage_status='open' where stage='damage';
alter table public.motorist_operation_evidence add constraint motorist_damage_stage
 check((stage='damage' and damage_status is not null) or (stage<>'damage' and damage_status is null and damage_resolver is null));
create index motorist_operation_open_damage on public.motorist_operation_evidence(operation_id) where stage='damage' and damage_status='open';
create index motorist_cycles_pending_return on public.motorist_vehicle_use_cycles(organization_id,return_at,id) where status in ('open','returned');

create function app_private.operation_evidence_complete(operation uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.motorist_operations o where o.id=operation
  and not exists(
   select 1 from unnest(case when o.kind='delivery' then array['handover'] else array['pickup','handover'] end) required(stage)
   where not exists(select 1 from public.motorist_operation_evidence ev where ev.operation_id=o.id and ev.stage=required.stage
    and (nullif(btrim(ev.person),'') is not null or nullif(btrim(ev.missing_reason),'') is not null)
    and (ev.photo_reference is not null or nullif(btrim(ev.missing_reason),'') is not null)
    and ((ev.odometer is not null and nullif(btrim(ev.fuel),'') is not null) or nullif(btrim(ev.missing_reason),'') is not null)
    and (ev.source<>'exception' or nullif(btrim(ev.missing_reason),'') is not null))))
$$;
create function app_private.cycle_evidence_complete(cycle uuid) returns boolean language sql stable set search_path='' as $$
 select not exists(select 1 from public.motorist_operations o
  left join public.motorist_logistics_executions e on e.operation_id=o.id
  left join public.motorist_towing_orders t on t.id=o.towing_order_id
  where o.cycle_id=cycle and coalesce(e.status,t.work_status)<>'cancelled' and not app_private.operation_evidence_complete(o.id))
$$;
create function app_private.operation_asset_has_open_damage(org uuid, asset uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.motorist_operation_evidence ev
  join public.motorist_operations o on o.id=ev.operation_id
  left join public.motorist_logistics_executions e on e.operation_id=o.id
  left join public.motorist_vehicle_use_cycles cy on cy.id=o.cycle_id
  where o.organization_id=org and coalesce(cy.fleet_asset_id,e.fleet_asset_id)=asset and ev.stage='damage' and ev.damage_status='open')
$$;
create function app_private.cycle_inspection_evidence_current(cycle uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.motorist_vehicle_use_cycles cy
  join public.motorist_operations inspected on inspected.cycle_id=cy.id
  join public.motorist_operation_evidence ev on ev.operation_id=inspected.id and ev.stage='inspection' and ev.source in ('observed','exception')
  where cy.id=cycle and ev.created_at>=coalesce((
   select max(damage.created_at) from public.motorist_operation_evidence damage
   join public.motorist_operations damaged on damaged.id=damage.operation_id
   left join public.motorist_logistics_executions execution on execution.operation_id=damaged.id
   left join public.motorist_vehicle_use_cycles damaged_cycle on damaged_cycle.id=damaged.cycle_id
   where damaged.organization_id=cy.organization_id and coalesce(damaged_cycle.fleet_asset_id,execution.fleet_asset_id)=cy.fleet_asset_id and damage.stage='damage'
  ),'-infinity'::timestamptz))
$$;
revoke all on function app_private.operation_evidence_complete(uuid),app_private.cycle_evidence_complete(uuid),app_private.operation_asset_has_open_damage(uuid,uuid),app_private.cycle_inspection_evidence_current(uuid) from public,anon,authenticated,service_role;

-- A current source reading cannot override an unresolved local damage report.
do $patch$ declare definition text; anchor text; begin
 definition:=pg_get_functiondef('app_private.operations_asset_free(uuid,uuid)'::regprocedure);
 anchor:=$anchor$and r.latest_payload_snapshot->'occupancy'->>'state'='free'$anchor$;
 if position(anchor in definition)=0 then raise exception 'Unexpected source availability definition' using errcode='55000'; end if;
 execute replace(definition,anchor,'and not app_private.operation_asset_has_open_damage(org,asset) '||anchor);
 definition:=pg_get_functiondef('app_private.operation_json(public.motorist_operations)'::regprocedure);
 anchor:=$anchor$case when exists(select 1 from public.motorist_operation_evidence where operation_id=op.id and stage='handover')
 and (op.kind='delivery' or exists(select 1 from public.motorist_operation_evidence where operation_id=op.id and stage='pickup')) then 'complete' else 'pending' end$anchor$;
 if position(anchor in definition)=0 then raise exception 'Unexpected evidence projection' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$replacement$case when app_private.operation_evidence_complete(op.id) then 'complete' else 'pending' end$replacement$);
 anchor:=$anchor$when cy.status='inspected' and app_private.operations_asset_free$anchor$;
 if position(anchor in definition)=0 then raise exception 'Unexpected readiness projection' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$replacement$when cy.status='inspected' and app_private.cycle_evidence_complete(cy.id) and app_private.cycle_inspection_evidence_current(cy.id) and app_private.operations_asset_free$replacement$);
 anchor:=$anchor$'missingReason',ev.missing_reason$anchor$;
 if position(anchor in definition)=0 then raise exception 'Unexpected evidence metadata' using errcode='55000'; end if;
 execute replace(definition,anchor,anchor||$replacement$,'damageResolver',ev.damage_resolver,'damageStatus',ev.damage_status$replacement$);
end $patch$;

-- Keep all existing commands/receipts and both specialized execution owners.
alter function public.motorist_operations_command(uuid,uuid,jsonb) rename to motorist_operations_command_before_p5;
alter function public.motorist_operations_command_before_p5(uuid,uuid,jsonb) set schema app_private;
revoke all on function app_private.motorist_operations_command_before_p5(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.motorist_operations_command(p_user_id uuid,p_organization_id uuid,p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; op public.motorist_operations; ex public.motorist_logistics_executions; tow public.motorist_towing_orders; cy public.motorist_vehicle_use_cycles;
 action text:=p_command->>'action'; payload jsonb:=p_command->'payload'; cid uuid:=(p_command->>'commandId')::uuid;
 receipt jsonb; current_revision bigint; assigned uuid; office boolean; reference text; missing text; report_asset uuid;
begin
 if action not in ('evidence','damage_update','inspect') then return app_private.motorist_operations_command_before_p5(p_user_id,p_organization_id,p_command); end if;
 actor:=app_private.operations_actor(p_user_id,p_organization_id); office:=(actor->>'canDispatch')::boolean;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));
 if cid is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'Invalid command' using errcode='22023'; end if;
 select * into op from public.motorist_operations where id=(p_command->>'operationId')::uuid and organization_id=p_organization_id for update;
 if not found then raise exception 'Operation unavailable' using errcode='P0002'; end if;
 if op.towing_order_id is null then
  select * into ex from public.motorist_logistics_executions where operation_id=op.id for update;
  current_revision:=ex.revision; assigned:=ex.assignee_id;
 else
  if not office or op.cycle_id is null then raise exception 'Office linked-return permission required' using errcode='42501'; end if;
  select * into tow from public.motorist_towing_orders where id=op.towing_order_id and organization_id=p_organization_id for update;
  current_revision:=tow.revision; assigned:=tow.driver_id;
 end if;
 if not office and assigned is distinct from (actor->>'memberId')::uuid then raise exception 'Assignment revoked' using errcode='42501'; end if;
 report_asset:=coalesce((select fleet_asset_id from public.motorist_vehicle_use_cycles where id=op.cycle_id),ex.fleet_asset_id);
 select c.receipt into receipt from public.motorist_operation_commands c where c.organization_id=p_organization_id and c.actor_user_id=p_user_id and c.command_id=cid;
 if found then
  if not exists(select 1 from public.motorist_operation_commands c where c.organization_id=p_organization_id and c.actor_user_id=p_user_id and c.command_id=cid and c.payload=p_command) then raise exception 'Command conflict' using errcode='PT409'; end if;
  return receipt;
 end if;
 if current_revision is distinct from (p_command->>'expectedRevision')::bigint then raise exception 'Revision conflict' using errcode='PT409'; end if;
 if not office and (action<>'evidence' or ex.status in ('completed','cancelled')) then raise exception 'Office evidence permission required' using errcode='42501'; end if;
 if action='inspect' then
  select * into cy from public.motorist_vehicle_use_cycles where id=op.cycle_id and organization_id=p_organization_id for update;
  if not found or cy.status<>'returned' or not app_private.cycle_evidence_complete(cy.id) then raise exception 'Complete handover evidence or documented exceptions required' using errcode='PT409'; end if;
  if app_private.operation_asset_has_open_damage(p_organization_id,cy.fleet_asset_id) then raise exception 'Resolve open vehicle damage first' using errcode='PT409'; end if;
  if not app_private.cycle_inspection_evidence_current(cy.id) then raise exception 'Inspection evidence after the latest damage required' using errcode='PT409'; end if;
  return app_private.motorist_operations_command_before_p5(p_user_id,p_organization_id,p_command);
 elsif action='damage_update' then
  if payload->>'damageStatus' not in ('open','resolved') or nullif(btrim(payload->>'damageStatus'),'') is null or nullif(btrim(payload->>'damageResolver'),'') is null or length(payload->>'damageResolver')>300 then raise exception 'Damage resolver and status required' using errcode='22023'; end if;
  update public.motorist_operation_evidence set damage_resolver=btrim(payload->>'damageResolver'),damage_status=payload->>'damageStatus'
   where id=(payload->>'evidenceId')::uuid and operation_id=op.id and stage='damage';
  if not found then raise exception 'Damage report unavailable' using errcode='P0002'; end if;
 else
  missing:=nullif(btrim(payload->>'missingReason'),''); reference:=nullif(payload->>'photoReference','');
  if payload->>'source'='observed' and payload->>'stage' not in ('inspection','damage') and office and assigned is distinct from (actor->>'memberId')::uuid then raise exception 'Do not impersonate field observation' using errcode='42501'; end if;
  if (payload->>'source'='exception' and missing is null) or (payload->>'stage' in ('pickup','handover') and nullif(btrim(payload->>'person'),'') is null and missing is null) or ((payload->>'odometer' is null or nullif(btrim(payload->>'fuel'),'') is null) and missing is null) then raise exception 'Evidence or explicit missing reason required' using errcode='22023'; end if;
  if payload->>'stage'='damage' and (nullif(btrim(payload->>'note'),'') is null or nullif(btrim(payload->>'damageResolver'),'') is null or length(payload->>'damageResolver')>300) then raise exception 'Damage description and resolver required' using errcode='22023'; end if;
  if payload->>'stage'='damage' and report_asset is null then raise exception 'Confirmed fleet asset required for damage' using errcode='22023'; end if;
  if (payload->>'observedAt')::timestamptz>now()+interval '1 minute' then raise exception 'Future observation' using errcode='22023'; end if;
  if reference is not null and (reference !~ ('^'||p_organization_id::text||'/'||op.id::text||'/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$') or not exists(select 1 from storage.objects obj where obj.bucket_id='motorist-operation-evidence' and obj.name=reference)) then raise exception 'Private operation file required' using errcode='22023'; end if;
  insert into public.motorist_operation_evidence(operation_id,stage,author_user_id,observed_at,source,person,note,photo_reference,odometer,fuel,missing_reason,damage_resolver,damage_status)
   values(op.id,payload->>'stage',p_user_id,(payload->>'observedAt')::timestamptz,payload->>'source',left(payload->>'person',300),left(coalesce(payload->>'note',''),2000),reference,(payload->>'odometer')::numeric,left(payload->>'fuel',100),left(missing,1000),case when payload->>'stage'='damage' then btrim(payload->>'damageResolver') end,case when payload->>'stage'='damage' then 'open' end);
 end if;
 if (action='evidence' and payload->>'stage'='damage') or (action='damage_update' and payload->>'damageStatus'='open') then
  -- A transfer can reveal damage after the last cycle was already inspected.
  -- Reopen the latest returned car's inspection, without inventing a return for
  -- a car that is still being used in an open cycle.
  update public.motorist_vehicle_use_cycles set status='returned',inspected_at=null,inspected_by=null,inspection_note=null,revision=revision+1
   where id=(select pending.id from public.motorist_vehicle_use_cycles pending
    where pending.organization_id=p_organization_id and pending.fleet_asset_id=report_asset and pending.status='inspected'
     and not exists(select 1 from public.motorist_vehicle_use_cycles current_use where current_use.organization_id=p_organization_id and current_use.fleet_asset_id=report_asset and current_use.status='open')
    order by pending.inspected_at desc,pending.created_at desc,pending.id limit 1);
 end if;
 if op.towing_order_id is null then
  update public.motorist_logistics_executions set revision=revision+1,updated_at=now() where operation_id=op.id returning revision into current_revision;
 else
  update public.motorist_towing_orders set revision=revision+1,updated_at=now() where id=tow.id returning revision into current_revision;
 end if;
 insert into public.motorist_operation_events(operation_id,actor_user_id,command_id,action,revision,payload) values(op.id,p_user_id,cid,action,current_revision,payload);
 receipt:=jsonb_build_object('commandId',cid,'committedRevision',current_revision,'operation',app_private.operation_json(op));
 insert into public.motorist_operation_commands(organization_id,actor_user_id,command_id,payload,receipt) values(p_organization_id,p_user_id,cid,p_command,receipt);
 return receipt;
end $$;
revoke all on function public.motorist_operations_command(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_operations_command(uuid,uuid,jsonb) to service_role;

-- Apply lifecycle views before pagination. Returns select one operation per cycle,
-- independently of case closure or the completed status of its original delivery.
do $patch$ declare definition text; anchor text; replacement text; begin
 definition:=pg_get_functiondef('public.motorist_operations_workspace(uuid,uuid,jsonb)'::regprocedure);
 anchor:=$anchor$and (p_filters->>'status' is null or coalesce(e.status,t.work_status)=p_filters->>'status')$anchor$;
 replacement:=anchor||$filter$
 and (p_filters->>'fleetAssetId' is null or coalesce((select cy.fleet_asset_id from public.motorist_vehicle_use_cycles cy where cy.id=o.cycle_id),e.fleet_asset_id)=(p_filters->>'fleetAssetId')::uuid)
 and (coalesce(p_filters->>'view','all')<>'open' or coalesce(e.status,t.work_status) not in ('completed','cancelled','paid'))
 and (coalesce(p_filters->>'view','all')<>'done' or coalesce(e.status,t.work_status) in ('completed','cancelled','paid'))
 and (coalesce(p_filters->>'view','all')<>'damage' or exists(select 1 from public.motorist_operation_evidence ev where ev.operation_id=o.id and ev.stage='damage'))
 and (coalesce(p_filters->>'view','all')<>'returns' or exists(select 1 from public.motorist_vehicle_use_cycles cy where cy.id=o.cycle_id and cy.status in ('open','returned')))
 and (coalesce(p_filters->>'view','all')<>'returns' or o.id=(
  select candidate.id from public.motorist_operations candidate
  left join public.motorist_logistics_executions candidate_execution on candidate_execution.operation_id=candidate.id
  left join public.motorist_towing_orders candidate_tow on candidate_tow.id=candidate.towing_order_id
  left join public.motorist_cycle_return_owners active_return on active_return.operation_id=candidate.id
  where candidate.cycle_id=o.cycle_id and candidate.organization_id=p_organization_id
   and ((actor->>'canDispatch')::boolean or candidate_execution.assignee_id=(actor->>'memberId')::uuid)
   and (not coalesce((p_filters->>'mine')::boolean,false) or candidate_execution.assignee_id=(actor->>'memberId')::uuid)
   and (p_filters->>'caseId' is null or candidate.case_id=(p_filters->>'caseId')::uuid)
   and (p_filters->>'id' is null or candidate.id=(p_filters->>'id')::uuid)
   and (p_filters->>'ownerId' is null or candidate.towing_order_id=(p_filters->>'ownerId')::uuid)
  order by (active_return.operation_id is not null) desc,coalesce(candidate_execution.updated_at,candidate_tow.updated_at) desc,candidate.id limit 1))$filter$;
 if position(anchor in definition)=0 then raise exception 'Unexpected workspace filter definition' using errcode='55000'; end if;
 execute replace(definition,anchor,replacement);
end $patch$;
notify pgrst, 'reload schema';
commit;
