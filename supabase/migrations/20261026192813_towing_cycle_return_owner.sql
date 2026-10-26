begin;
lock table public.motorist_logistics_executions,public.motorist_towing_orders in share row exclusive mode;
-- One active return intent, regardless of the specialized execution owner.
create table public.motorist_cycle_return_owners (
 cycle_id uuid primary key references public.motorist_vehicle_use_cycles(id),
 operation_id uuid not null unique references public.motorist_operations(id)
);
insert into public.motorist_cycle_return_owners(cycle_id,operation_id)
 select cycle_return_id,operation_id from public.motorist_logistics_executions where cycle_return_id is not null and status not in ('completed','cancelled');
alter table public.motorist_cycle_return_owners enable row level security;
revoke all on public.motorist_cycle_return_owners from public,anon,authenticated,service_role;
create function app_private.operation_return_owner_sync() returns trigger language plpgsql set search_path='' as $$begin
 if new.cycle_return_id is null then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text,13102026));
 if new.status in ('completed','cancelled') then delete from public.motorist_cycle_return_owners where cycle_id=new.cycle_return_id and operation_id=new.operation_id;
 else
  if exists(select 1 from public.motorist_cycle_return_owners where cycle_id=new.cycle_return_id and operation_id<>new.operation_id) then raise exception 'Active return owner exists' using errcode='PT409'; end if;
  insert into public.motorist_cycle_return_owners(cycle_id,operation_id) values(new.cycle_return_id,new.operation_id) on conflict(cycle_id) do nothing;
 end if; return new;
end $$;
create trigger motorist_return_owner_logistics after insert or update of status on public.motorist_logistics_executions for each row execute function app_private.operation_return_owner_sync();
create function app_private.towing_cycle_return_sync() returns trigger language plpgsql set search_path='' as $$
declare op_id uuid; cycle uuid;
begin
 if new.work_status is not distinct from old.work_status or new.work_status not in ('submitted','cancelled') then return new; end if;
 select o.id,r.cycle_id into op_id,cycle from public.motorist_operations o join public.motorist_cycle_return_owners r on r.operation_id=o.id where o.towing_order_id=new.id and o.organization_id=new.organization_id;
 if not found then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text,13102026));
 if new.work_status='submitted' then
  update public.motorist_vehicle_use_cycles set status='returned',revision=revision+1 where id=cycle and organization_id=new.organization_id and status='open';
 end if;
 delete from public.motorist_cycle_return_owners where cycle_id=cycle and operation_id=op_id;
 return new;
end $$;
create trigger motorist_return_owner_towing after update of work_status on public.motorist_towing_orders for each row execute function app_private.towing_cycle_return_sync();

-- Keep the proven logistics implementation and wrap only shared cycle context.
alter function public.motorist_operations_command(uuid,uuid,jsonb) rename to motorist_operations_command_base;
alter function public.motorist_operations_command_base(uuid,uuid,jsonb) set schema app_private;
revoke all on function app_private.motorist_operations_command_base(uuid,uuid,jsonb),app_private.operation_return_owner_sync(),app_private.towing_cycle_return_sync() from public,anon,authenticated,service_role;
create function public.motorist_operations_command(p_user_id uuid,p_organization_id uuid,p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; op public.motorist_operations; tow public.motorist_towing_orders; cy public.motorist_vehicle_use_cycles;
 action text:=p_command->>'action'; payload jsonb:=p_command->'payload'; cid uuid:=(p_command->>'commandId')::uuid; result jsonb; active_owner uuid;
begin
 actor:=app_private.operations_actor(p_user_id,p_organization_id);
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));
 select * into op from public.motorist_operations where id=(p_command->>'operationId')::uuid and organization_id=p_organization_id for update;
 if action='return' and not exists(select 1 from public.motorist_operation_commands previous where previous.organization_id=p_organization_id and previous.actor_user_id=p_user_id and previous.command_id=cid) and op.cycle_id is not null and payload->>'returnMode' in ('collect','customer_returns') and exists(
  select 1 from public.motorist_cycle_return_owners r join public.motorist_operations current_op on current_op.id=r.operation_id where r.cycle_id=op.cycle_id and current_op.towing_order_id is not null
 ) then raise exception 'Return belongs to towing order' using errcode='PT409'; end if;
 if op.towing_order_id is null or action not in ('link_towing_return','evidence','inspect') then
  if action='link_towing_return' then raise exception 'Towing owner required' using errcode='22023'; end if;
  return app_private.motorist_operations_command_base(p_user_id,p_organization_id,p_command);
 end if;
 if not (actor->>'canDispatch')::boolean then raise exception 'Office context permission required' using errcode='42501'; end if;
 if cid is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'Invalid command' using errcode='22023'; end if;
 select c.receipt into result from public.motorist_operation_commands c where c.organization_id=p_organization_id and c.actor_user_id=p_user_id and c.command_id=cid;
 if found then
  if not exists(select 1 from public.motorist_operation_commands c where c.organization_id=p_organization_id and c.actor_user_id=p_user_id and c.command_id=cid and c.payload=p_command) then raise exception 'Command conflict' using errcode='PT409'; end if;
  return result;
 end if;
 select * into tow from public.motorist_towing_orders where id=op.towing_order_id and organization_id=p_organization_id for update;
 if tow.revision is distinct from (p_command->>'expectedRevision')::bigint then raise exception 'Revision conflict' using errcode='PT409'; end if;
 if action='link_towing_return' then
  if tow.work_status in ('submitted','cancelled') then raise exception 'Open towing work required' using errcode='22023'; end if;
  select * into cy from public.motorist_vehicle_use_cycles where id=(payload->>'cycleId')::uuid and organization_id=p_organization_id for update;
  if not found or cy.status<>'open' or (op.cycle_id is not null and op.cycle_id<>cy.id) then raise exception 'Open explicit cycle required' using errcode='22023'; end if;
  select operation_id into active_owner from public.motorist_cycle_return_owners where cycle_id=cy.id;
  if active_owner is not null and active_owner<>op.id then raise exception 'Active return owner exists' using errcode='PT409'; end if;
  update public.motorist_operations set cycle_id=cy.id where id=op.id; op.cycle_id:=cy.id;
  insert into public.motorist_cycle_return_owners(cycle_id,operation_id) values(cy.id,op.id) on conflict(cycle_id) do nothing;
  update public.motorist_vehicle_use_cycles set return_mode='collect',revision=revision+1 where id=cy.id;
 elsif action='evidence' then
  if op.cycle_id is null then raise exception 'Linked towing return required' using errcode='22023'; end if;
  if payload->>'source'='observed' and payload->>'stage' not in ('inspection','damage') and tow.driver_id is distinct from (actor->>'memberId')::uuid then raise exception 'Do not impersonate field observation' using errcode='42501'; end if;
  if (payload->>'source'='exception' and nullif(btrim(payload->>'missingReason'),'') is null) or (payload->>'stage' in ('pickup','handover') and nullif(btrim(payload->>'person'),'') is null and nullif(btrim(payload->>'missingReason'),'') is null) or ((payload->>'odometer' is null or payload->>'fuel' is null) and nullif(btrim(payload->>'missingReason'),'') is null) then raise exception 'Evidence or explicit missing reason required' using errcode='22023'; end if;
  if (payload->>'observedAt')::timestamptz>now()+interval '1 minute' then raise exception 'Future observation' using errcode='22023'; end if;
  if nullif(payload->>'photoReference','') is not null and (payload->>'photoReference' !~ ('^'||p_organization_id::text||'/'||op.id::text||'/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$') or not exists(select 1 from storage.objects obj where obj.bucket_id='motorist-operation-evidence' and obj.name=payload->>'photoReference')) then raise exception 'Private operation file required' using errcode='22023'; end if;
  insert into public.motorist_operation_evidence(operation_id,stage,author_user_id,observed_at,source,person,note,photo_reference,odometer,fuel,missing_reason)
   values(op.id,payload->>'stage',p_user_id,(payload->>'observedAt')::timestamptz,payload->>'source',left(payload->>'person',300),left(coalesce(payload->>'note',''),2000),nullif(left(payload->>'photoReference',500),''),(payload->>'odometer')::numeric,left(payload->>'fuel',100),nullif(left(payload->>'missingReason',1000),''));
 elsif action='inspect' then
  select * into cy from public.motorist_vehicle_use_cycles where id=op.cycle_id and organization_id=p_organization_id for update;
  if not found or cy.status<>'returned' or not exists(select 1 from public.motorist_operation_evidence ev join public.motorist_operations eo on eo.id=ev.operation_id where eo.cycle_id=cy.id and ev.stage='inspection' and ev.source in ('observed','exception')) then raise exception 'Return and inspection evidence required' using errcode='22023'; end if;
  update public.motorist_vehicle_use_cycles set status='inspected',inspected_at=now(),inspected_by=p_user_id,inspection_note=left(payload->>'note',2000),revision=revision+1 where id=cy.id;
 end if;
 -- Only the owner revision changes for context edits; no copied work/financial state.
 update public.motorist_towing_orders set revision=revision+1,updated_at=now() where id=tow.id returning revision into tow.revision;
 insert into public.motorist_operation_events(operation_id,actor_user_id,command_id,action,revision,payload) values(op.id,p_user_id,cid,action,tow.revision,payload);
 result:=jsonb_build_object('commandId',cid,'committedRevision',tow.revision,'operation',app_private.operation_json(op));
 insert into public.motorist_operation_commands(organization_id,actor_user_id,command_id,payload,receipt) values(p_organization_id,p_user_id,cid,p_command,result);
 return result;
end $$;
revoke all on function public.motorist_operations_command(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_operations_command(uuid,uuid,jsonb) to service_role;

-- Read the single active return owner across the two specialized domains.
do $patch$ declare definition text; anchor text; replacement text; begin
 definition:=pg_get_functiondef('app_private.operation_json(public.motorist_operations)'::regprocedure);
 anchor:=$anchor$(select ro.id from public.motorist_operations ro join public.motorist_logistics_executions re on re.operation_id=ro.id where ro.cycle_id=cy.id and ro.kind='collection' and re.status not in ('completed','cancelled') limit 1)$anchor$;
 replacement:=$replacement$(select r.operation_id from public.motorist_cycle_return_owners r where r.cycle_id=cy.id),'returnOperationOwner',(select case when owner_op.towing_order_id is null then 'logistics' else 'towing_order' end from public.motorist_cycle_return_owners r join public.motorist_operations owner_op on owner_op.id=r.operation_id where r.cycle_id=cy.id)$replacement$;
 if position(anchor in definition)=0 then raise exception 'Unexpected operation projection' using errcode='55000'; end if;
 execute replace(definition,anchor,replacement);
 definition:=pg_get_functiondef('public.motorist_operations_workspace(uuid,uuid,jsonb)'::regprocedure);
 anchor:=$anchor$and (p_filters->>'id' is null or o.id=(p_filters->>'id')::uuid)$anchor$;
 if position(anchor in definition)=0 then raise exception 'Unexpected workspace projection' using errcode='55000'; end if;
 execute replace(definition,anchor,anchor||$filter$ and (p_filters->>'ownerId' is null or o.towing_order_id=(p_filters->>'ownerId')::uuid)$filter$);
end $patch$;
commit;
