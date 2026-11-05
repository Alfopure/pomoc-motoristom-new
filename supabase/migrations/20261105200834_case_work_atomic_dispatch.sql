begin;
-- Each selected item is a transaction. Existing command receipts own replay and
-- exact-payload conflicts; create + assignment either both commit or both roll back.
-- No legacy case handoff is created, and its one-slot constraint is preserved.
create function public.motorist_case_work_item(p_user_id uuid,p_organization_id uuid,p_case_id uuid,p_item jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; cid uuid; kind text; target_kind text; target uuid; c jsonb; created jsonb; assigned jsonb;
 op_id uuid; tow_id uuid; member public.motorist_towing_memberships; result jsonb; revision bigint;
begin
 actor:=app_private.branch_actor(p_user_id,p_organization_id);
 if not coalesce((actor->>'central')::boolean,false) then raise exception 'Forbidden' using errcode='42501'; end if;
 if not exists(select 1 from public.motorist_cases where id=p_case_id and organization_id=p_organization_id) then raise exception 'Case unavailable' using errcode='P0002'; end if;
 if jsonb_typeof(p_item) is distinct from 'object' or (p_item-array['commandId','kind','target','pickup','destination','instructions','scheduledAt','plannedEndAt','fleetAssetId','cycleId','branchId'])<>'{}'::jsonb
  or jsonb_typeof(p_item->'target') is distinct from 'object' or ((p_item->'target')-array['type','id'])<>'{}'::jsonb
  or jsonb_typeof(p_item->'pickup') is distinct from 'string' or length(btrim(p_item->>'pickup'))=0 or length(p_item->>'pickup')>1000
  or jsonb_typeof(p_item->'destination') is distinct from 'string' or length(p_item->>'destination')>1000
  or jsonb_typeof(p_item->'instructions') is distinct from 'string' or length(p_item->>'instructions')>4000 then raise exception 'Invalid work item' using errcode='22023'; end if;
 cid:=(p_item->>'commandId')::uuid; kind:=p_item->>'kind'; target_kind:=p_item->'target'->>'type'; target:=(p_item->'target'->>'id')::uuid;
 if cid is null or target is null or coalesce(kind,'') not in ('delivery','collection','transfer','tow') or coalesce(target_kind,'') not in ('branch','person') then raise exception 'Invalid work item' using errcode='22023'; end if;
 if p_item->>'plannedEndAt' is not null and (p_item->>'scheduledAt' is null or (p_item->>'plannedEndAt')::timestamptz<=(p_item->>'scheduledAt')::timestamptz) then raise exception 'Interval required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));
 if target_kind='branch' then
  result:=public.motorist_branch_command(p_user_id,p_organization_id,jsonb_build_object('commandId',cid,'action','create','expectedRevision',0,'payload',jsonb_strip_nulls(jsonb_build_object(
   'caseWorkItem',p_item,'kind',kind,'caseId',p_case_id,'groupId',target,'pickup',p_item->>'pickup','destination',p_item->>'destination','note',p_item->>'instructions','dueAt',p_item->>'scheduledAt','fleetAssetId',p_item->>'fleetAssetId','cycleId',p_item->>'cycleId'))));
  return jsonb_build_object('commandId',cid,'kind',kind,'owner','branch','id',result->'request'->>'id','status',result->'request'->>'status');
 elsif kind='tow' then
  if not coalesce((actor->>'canOperateTowing')::boolean,false) then raise exception 'Towing office permission required' using errcode='42501'; end if;
  select * into member from public.motorist_towing_memberships where organization_id=p_organization_id and auth_user_id=p_user_id and active;
  tow_id:=cid;
  created:=public.motorist_towing_command(p_user_id,p_organization_id,member.membership_version,jsonb_build_object('commandId',md5('case-work-create:'||cid::text)::uuid,'targetId',tow_id,'type','create_order','payload',jsonb_build_object('caseWorkItem',p_item,'sourceCaseId',p_case_id,'fields',jsonb_strip_nulls(jsonb_build_object('serviceType','tow','executionOrigin','local','pickup',p_item->>'pickup','destination',p_item->>'destination','branchId',p_item->>'branchId','plannedAt',p_item->>'scheduledAt','dispatchInstructions',p_item->>'instructions')))));
  -- Create's saved revision is deliberately reused on retry. The assignment RPC
  -- replays its own receipt before revision validation, so no duplicate assignment.
  assigned:=public.motorist_towing_command(p_user_id,p_organization_id,member.membership_version,jsonb_build_object('commandId',md5('case-work-assign:'||cid::text)::uuid,'targetId',tow_id,'type','assign','expectedRevision',(created->>'revision')::bigint,'payload',jsonb_build_object('driverId',target)));
  return jsonb_build_object('commandId',cid,'kind',kind,'owner','towing_order','id',tow_id,'status','assigned');
 else
  created:=public.motorist_operations_command(p_user_id,p_organization_id,jsonb_build_object('commandId',md5('case-work-create:'||cid::text)::uuid,'action','create','expectedRevision',0,'payload',jsonb_strip_nulls(jsonb_build_object('caseWorkItem',p_item,'kind',kind,'caseId',p_case_id,'from',p_item->>'pickup','to',p_item->>'destination','instructions',p_item->>'instructions','scheduledAt',p_item->>'scheduledAt','plannedEndAt',p_item->>'plannedEndAt','fleetAssetId',p_item->>'fleetAssetId','cycleId',p_item->>'cycleId'))));
  op_id:=(created->'operation'->>'id')::uuid;
  assigned:=public.motorist_operations_command(p_user_id,p_organization_id,jsonb_build_object('commandId',md5('case-work-assign:'||cid::text)::uuid,'action','assign','operationId',op_id,'expectedRevision',(created->>'committedRevision')::bigint,'payload',jsonb_build_object('assigneeId',target)));
  return jsonb_build_object('commandId',cid,'kind',kind,'owner','logistics','id',op_id,'status','assigned');
 end if;
end $$;
revoke all on function public.motorist_case_work_item(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_case_work_item(uuid,uuid,uuid,jsonb) to service_role;

-- Office publishes instructions separately from the executor's own notes.
do $$
declare definition text; patched text;
begin
 select pg_get_functiondef('public.motorist_towing_command(uuid,uuid,bigint,jsonb)'::regprocedure) into definition;
 if position('''dispatchInstructions''' in definition)=0 then raise exception 'Towing instruction field guard missing'; end if;
 select pg_get_functiondef('public.motorist_branch_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 patched:=replace(definition,'''executionOrigin'',''local'',''pickup'',nullif(r.pickup,'''')','''executionOrigin'',''local'',''dispatchInstructions'',r.note,''pickup'',nullif(r.pickup,'''')');
 if patched=definition then raise exception 'Branch towing materialization changed'; end if;
 execute patched;
end $$;
create or replace function public.motorist_field_operations_context(p_user_id uuid,p_organization_id uuid,p_operation_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; member uuid;
begin
 actor:=app_private.operations_actor(p_user_id,p_organization_id); member:=(actor->>'memberId')::uuid;
 if member is null then raise exception 'Forbidden' using errcode='42501'; end if;
 if p_operation_ids is null or cardinality(p_operation_ids)>100 then raise exception 'Invalid operations' using errcode='22023'; end if;
 return coalesce((select jsonb_object_agg(e.operation_id::text,jsonb_build_object(
  'legacy',exists(select 1 from public.motorist_case_handoffs h where h.operation_id=e.operation_id),
  'instructions',coalesce((select left(nullif(btrim(r.note),''),4000) from public.motorist_work_requests r where r.operation_id=e.operation_id and r.organization_id=p_organization_id),
   (select left(nullif(btrim(ev.payload->>'instructions'),''),4000) from public.motorist_operation_events ev where ev.operation_id=e.operation_id and ev.action='create' order by ev.created_at,ev.id limit 1))))
  from public.motorist_logistics_executions e where e.organization_id=p_organization_id and e.assignee_id=member and e.operation_id=any(p_operation_ids)),'{}'::jsonb);
end $$;
revoke all on function public.motorist_field_operations_context(uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.motorist_field_operations_context(uuid,uuid,uuid[]) to service_role;
commit;
