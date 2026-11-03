begin;
-- Identity survives case deletion; state remains with exactly one execution owner.
create table public.motorist_vehicle_use_cycles (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 fleet_asset_id uuid not null references public.motorist_fleet_assets(id), case_id uuid references public.motorist_cases(id) on delete set null,
 revision bigint not null default 1, return_mode text not null default 'undecided' check(return_mode in ('collect','customer_returns','undecided','continues')),
 return_at timestamptz, next_owner text, status text not null default 'open' check(status in ('open','returned','inspected')),
 inspected_at timestamptz, inspected_by uuid, inspection_note text, created_at timestamptz not null default now(), unique(organization_id,id)
);
create unique index motorist_cycle_open_asset on public.motorist_vehicle_use_cycles(organization_id,fleet_asset_id) where status='open';
create table public.motorist_operations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 case_id uuid references public.motorist_cases(id) on delete set null, kind text not null check(kind in ('tow','delivery','collection','transfer')),
 towing_order_id uuid unique references public.motorist_towing_orders(id), cycle_id uuid references public.motorist_vehicle_use_cycles(id),
 created_by uuid, created_at timestamptz not null default now(), unique(organization_id,id)
);
create index motorist_operations_case on public.motorist_operations(organization_id,case_id);
create index motorist_operations_cycle on public.motorist_operations(cycle_id);
create table public.motorist_logistics_executions (
 operation_id uuid primary key references public.motorist_operations(id), organization_id uuid not null references public.motorist_organizations(id),
 revision bigint not null default 1, assignment_generation bigint not null default 0,
 status text not null default 'draft' check(status in ('draft','assigned','accepted','en_route','arrived','collected','completed','cancelled')),
 assignee_id uuid references public.motorist_towing_memberships(id), cycle_return_id uuid references public.motorist_vehicle_use_cycles(id), fleet_asset_id uuid references public.motorist_fleet_assets(id),
 pickup text not null default '', destination text not null default '', scheduled_at timestamptz, planned_end_at timestamptz,
 confirmed_at timestamptz, started_at timestamptz, finished_at timestamptz, updated_at timestamptz not null default now(),
 check(planned_end_at is null or (scheduled_at is not null and planned_end_at>scheduled_at))
);
create unique index motorist_logistics_one_return on public.motorist_logistics_executions(cycle_return_id) where cycle_return_id is not null and status not in ('completed','cancelled');
create function app_private.operation_return_identity() returns trigger language plpgsql set search_path='' as $$begin
 select o.cycle_id into new.cycle_return_id from public.motorist_operations o where o.id=new.operation_id and o.kind='collection'; return new; end $$;
create trigger motorist_operation_return_identity before insert on public.motorist_logistics_executions for each row execute function app_private.operation_return_identity();
create index motorist_logistics_assignee on public.motorist_logistics_executions(organization_id,assignee_id,status);
create table public.motorist_operation_evidence (
 id uuid primary key default gen_random_uuid(), operation_id uuid not null references public.motorist_operations(id),
 stage text not null check(stage in ('pickup','handover','inspection','damage')), author_user_id uuid not null,
 observed_at timestamptz not null, source text not null check(source in ('observed','reported','exception')),
 person text, note text not null default '', photo_reference text, odometer numeric check(odometer>=0), fuel text, missing_reason text,
 created_at timestamptz not null default now(), check(photo_reference is not null or coalesce(length(btrim(missing_reason)),0)>0)
);
create index motorist_evidence_operation on public.motorist_operation_evidence(operation_id,stage);
create table public.motorist_operation_commands (
 organization_id uuid not null, actor_user_id uuid not null, command_id uuid not null, payload jsonb not null, receipt jsonb not null,
 created_at timestamptz not null default now(), primary key(organization_id,actor_user_id,command_id)
);
create table public.motorist_operation_events (
 id uuid primary key default gen_random_uuid(), operation_id uuid not null references public.motorist_operations(id), actor_user_id uuid not null,
 command_id uuid not null, action text not null, revision bigint not null, payload jsonb not null, created_at timestamptz not null default now()
);
create index motorist_operation_events_operation on public.motorist_operation_events(operation_id,created_at);

create function app_private.operations_actor(u uuid, org uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare p public.motorist_profiles; m public.motorist_towing_memberships; office boolean:=false;
begin
 if not exists(select 1 from public.motorist_organizations where id=org and active) then raise exception 'Forbidden' using errcode='42501'; end if;
 select * into p from public.motorist_profiles where organization_id=org and user_id=u and active and access_status='active' and role in ('dispatcher','senior_dispatcher','manager','admin');
 office:=p.id is not null;
 select * into m from public.motorist_towing_memberships where organization_id=org and auth_user_id=u and active;
 if m.id is not null then m:=app_private.towing_authorize(u,org,m.membership_version); end if;
 office:=office or (m.id is not null and 'operate'=any(m.capabilities));
 if not office and (m.id is null or not ('deliver'=any(m.capabilities))) then raise exception 'Forbidden' using errcode='42501'; end if;
 return jsonb_build_object('userId',u,'organizationId',org,'displayName',coalesce(p.display_name,m.display_name),'profileId',p.id,'memberId',m.id,'version',m.membership_version,'canDispatch',office);
end $$;
create function public.motorist_operations_actor(p_user_id uuid,p_organization_id uuid) returns jsonb language sql stable security definer set search_path='' as $$select app_private.operations_actor(p_user_id,p_organization_id)$$;

-- Source identity is the confirmed asset link, never a plate or last rental timestamp.
create function app_private.operations_asset_free(org uuid, asset uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.motorist_fleet_assets a
 join public.motorist_fleet_asset_links l on l.fleet_asset_id=a.id and l.organization_id=a.organization_id and l.link_status='confirmed' and l.source_provider='client_vehicle_db'
 join public.motorist_external_vehicle_records r on r.id=l.external_vehicle_record_id and r.organization_id=a.organization_id and r.source_active
 where a.organization_id=org and a.id=asset and a.kind='replacement_car' and a.status not in ('service','offline') and not exists(select 1 from public.motorist_vehicle_use_cycles cy where cy.organization_id=org and cy.fleet_asset_id=asset and cy.status='returned')
 and r.latest_payload_snapshot->'occupancy'->>'state'='free'
 and (r.latest_payload_snapshot->'occupancy'->>'checkedAt')::timestamptz between now()-interval '10 minutes' and now()+interval '1 minute')
$$;

create function app_private.operation_json(op public.motorist_operations) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',op.id,'kind',op.kind,'owner',case when t.id is null then 'logistics' else 'towing_order' end,'ownerId',coalesce(t.id,op.id),
 'status',coalesce(t.work_status,e.status),'revision',coalesce(t.revision,e.revision),'assignmentGeneration',coalesce(t.assignment_generation,e.assignment_generation),
 'caseId',op.case_id,'caseNumber',c.case_number,'cycleId',op.cycle_id,'fleetAssetId',coalesce(cy.fleet_asset_id,e.fleet_asset_id),
 'vehicle',coalesce(a.label,t.fields->>'subjectDescription'),'from',coalesce(t.fields->>'pickup',e.pickup,''),'to',coalesce(t.fields->>'destination',e.destination,''),
 'scheduledAt',coalesce(nullif(t.fields->>'plannedAt','')::timestamptz,e.scheduled_at),'plannedEndAt',e.planned_end_at,'confirmedAt',e.confirmed_at,'startedAt',e.started_at,
 'assigneeId',coalesce(t.driver_id,e.assignee_id),'assignee',m.display_name,'updatedAt',coalesce(t.updated_at,e.updated_at),
 'evidenceState',case when exists(select 1 from public.motorist_operation_evidence where operation_id=op.id and stage='handover')
 and (op.kind='delivery' or exists(select 1 from public.motorist_operation_evidence where operation_id=op.id and stage='pickup')) then 'complete' else 'pending' end,
 'cycle',case when cy.id is null then null else jsonb_build_object('id',cy.id,'revision',cy.revision,'fleetAssetId',cy.fleet_asset_id,'returnMode',cy.return_mode,'returnAt',cy.return_at,'nextOwner',cy.next_owner,'status',cy.status,
 'returnOperationId',(select ro.id from public.motorist_operations ro join public.motorist_logistics_executions re on re.operation_id=ro.id where ro.cycle_id=cy.id and ro.kind='collection' and re.status not in ('completed','cancelled') limit 1),
 'readiness',case when cy.inspected_at is null then 'unverified' when cy.status='inspected' and app_private.operations_asset_free(op.organization_id,cy.fleet_asset_id) and not exists(select 1 from public.motorist_vehicle_use_cycles oc where oc.organization_id=op.organization_id and oc.fleet_asset_id=cy.fleet_asset_id and oc.status='open') and not exists(select 1 from public.motorist_logistics_executions active_work where active_work.fleet_asset_id=cy.fleet_asset_id and active_work.status not in ('completed','cancelled') and (active_work.started_at is not null or active_work.confirmed_at is not null)) then 'ready' else 'blocked' end) end,
 'evidence',coalesce((select jsonb_agg(jsonb_build_object('id',ev.id,'stage',ev.stage,'authorUserId',ev.author_user_id,'observedAt',ev.observed_at,'source',ev.source,'person',ev.person,'note',ev.note,'photoReference',ev.photo_reference,'odometer',ev.odometer,'fuel',ev.fuel,'missingReason',ev.missing_reason) order by ev.created_at) from public.motorist_operation_evidence ev where ev.operation_id=op.id),'[]'::jsonb))
 from (select 1) seed left join public.motorist_logistics_executions e on e.operation_id=op.id
 left join public.motorist_towing_orders t on t.id=op.towing_order_id left join public.motorist_cases c on c.id=op.case_id
 left join public.motorist_vehicle_use_cycles cy on cy.id=op.cycle_id left join public.motorist_fleet_assets a on a.id=coalesce(cy.fleet_asset_id,e.fleet_asset_id)
 left join public.motorist_towing_memberships m on m.id=coalesce(t.driver_id,e.assignee_id)
$$;

create function public.motorist_operations_workspace(p_user_id uuid,p_organization_id uuid,p_filters jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; rows jsonb; total bigint; begin
 actor:=app_private.operations_actor(p_user_id,p_organization_id);
 with filtered as (
 select o,coalesce(e.updated_at,t.updated_at) updated from public.motorist_operations o
 left join public.motorist_logistics_executions e on e.operation_id=o.id left join public.motorist_towing_orders t on t.id=o.towing_order_id
 where o.organization_id=p_organization_id
 and ((actor->>'canDispatch')::boolean or e.assignee_id=(actor->>'memberId')::uuid)
 and (not coalesce((p_filters->>'mine')::boolean,false) or e.assignee_id=(actor->>'memberId')::uuid)
 and (p_filters->>'id' is null or o.id=(p_filters->>'id')::uuid)
 and (p_filters->>'caseId' is null or o.case_id=(p_filters->>'caseId')::uuid)
 and (p_filters->>'status' is null or coalesce(e.status,t.work_status)=p_filters->>'status')), page as (select app_private.operation_json(f.o) dto,f.updated from filtered f order by f.updated desc,(f.o).id limit least(100,greatest(1,coalesce((p_filters->>'limit')::integer,50))) offset greatest(0,coalesce((p_filters->>'offset')::integer,0))) select (select count(*) from filtered),coalesce(jsonb_agg(page.dto order by page.updated desc),'[]'::jsonb) into total,rows from page;
 return jsonb_build_object('actor',actor,'operations',rows,'totalCount',total,
 'cycles',case when (actor->>'canDispatch')::boolean then coalesce((select jsonb_agg(jsonb_build_object('id',cy.id,'fleetAssetId',cy.fleet_asset_id,'vehicle',a.label,'caseId',cy.case_id,'caseNumber',c.case_number) order by cy.created_at) from (select * from public.motorist_vehicle_use_cycles where organization_id=p_organization_id and status='open' order by created_at,id limit 1000) cy join public.motorist_fleet_assets a on a.id=cy.fleet_asset_id left join public.motorist_cases c on c.id=cy.case_id),'[]'::jsonb) else '[]'::jsonb end,
 'members',case when (actor->>'canDispatch')::boolean then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',display_name)) from public.motorist_towing_memberships where organization_id=p_organization_id and active and 'deliver'=any(capabilities)),'[]'::jsonb) else '[]'::jsonb end,
 'fleet',case when (actor->>'canDispatch')::boolean then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',label)) from public.motorist_fleet_assets where organization_id=p_organization_id and kind='replacement_car'),'[]'::jsonb) else '[]'::jsonb end);
end $$;
create function public.motorist_operations_command(p_user_id uuid,p_organization_id uuid,p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; op public.motorist_operations; ex public.motorist_logistics_executions; cy public.motorist_vehicle_use_cycles;
 cid uuid:=(p_command->>'commandId')::uuid; action text:=p_command->>'action'; payload jsonb:=p_command->'payload'; receipt jsonb;
 assigned uuid; asset uuid; cycle uuid; at_time timestamptz; end_time timestamptz; return_op uuid; resource text;
begin
 actor:=app_private.operations_actor(p_user_id,p_organization_id);
 if cid is null or jsonb_typeof(payload) is distinct from 'object' then raise exception 'Invalid command' using errcode='22023'; end if;
 -- Stable retry serializes before lookup, including create/return intents.
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_user_id::text||cid::text,0));
 select c.receipt into receipt from public.motorist_operation_commands c where c.organization_id=p_organization_id and c.actor_user_id=p_user_id and c.command_id=cid;
 if found then
  if not exists(select 1 from public.motorist_operation_commands c where c.organization_id=p_organization_id and c.actor_user_id=p_user_id and c.command_id=cid and c.payload=p_command) then raise exception 'Command conflict' using errcode='PT409'; end if;
  if not (actor->>'canDispatch')::boolean and not exists(select 1 from public.motorist_logistics_executions e where e.operation_id=(receipt->'operation'->>'id')::uuid and e.assignee_id=(actor->>'memberId')::uuid) then raise exception 'Assignment revoked' using errcode='42501'; end if;
  return receipt;
 end if;
 if action='create' then
  if not (actor->>'canDispatch')::boolean or payload->>'kind' not in ('delivery','collection','transfer') then raise exception 'Forbidden' using errcode='42501'; end if;
  if coalesce((p_command->>'expectedRevision')::bigint,0)<>0 then raise exception 'New revision required' using errcode='PT409'; end if;
  if payload->>'caseId' is not null and not exists(select 1 from public.motorist_cases where id=(payload->>'caseId')::uuid and organization_id=p_organization_id) then raise exception 'Case unavailable' using errcode='P0002'; end if;
  asset:=(payload->>'fleetAssetId')::uuid; cycle:=(payload->>'cycleId')::uuid;
  if asset is not null and not exists(select 1 from public.motorist_fleet_assets where id=asset and organization_id=p_organization_id and kind='replacement_car') then raise exception 'Asset unavailable' using errcode='22023'; end if;
  if cycle is not null then
   select * into cy from public.motorist_vehicle_use_cycles where id=cycle and organization_id=p_organization_id for update;
   if not found or cy.status<>'open' or (asset is not null and asset<>cy.fleet_asset_id) then raise exception 'Cycle unavailable' using errcode='22023'; end if;
   asset:=cy.fleet_asset_id;
  elsif payload->>'kind'='collection' then raise exception 'Confirmed cycle required' using errcode='22023';
  elsif payload->>'kind'='delivery' and asset is not null then
   insert into public.motorist_vehicle_use_cycles(organization_id,fleet_asset_id,case_id,return_mode) values(p_organization_id,asset,(payload->>'caseId')::uuid,coalesce(payload->>'returnMode','undecided')) returning id into cycle;
  end if;
  if payload->>'kind'='collection' and exists(select 1 from public.motorist_operations o join public.motorist_logistics_executions e on e.operation_id=o.id where o.cycle_id=cycle and o.kind='collection' and e.status not in ('completed','cancelled')) then raise exception 'Active return exists' using errcode='PT409'; end if;
  insert into public.motorist_operations(organization_id,case_id,kind,cycle_id,created_by) values(p_organization_id,(payload->>'caseId')::uuid,payload->>'kind',cycle,p_user_id) returning * into op;
  insert into public.motorist_logistics_executions(operation_id,organization_id,fleet_asset_id,pickup,destination,scheduled_at,planned_end_at)
   values(op.id,p_organization_id,asset,left(coalesce(payload->>'from',''),1000),left(coalesce(payload->>'to',''),1000),(payload->>'scheduledAt')::timestamptz,(payload->>'plannedEndAt')::timestamptz) returning * into ex;
 else
  select * into op from public.motorist_operations where id=(p_command->>'operationId')::uuid and organization_id=p_organization_id for update;
  if not found then raise exception 'Operation unavailable' using errcode='P0002'; end if;
  if op.towing_order_id is not null then raise exception 'Use towing execution owner' using errcode='22023'; end if;
  select * into ex from public.motorist_logistics_executions where operation_id=op.id for update;
  if not (actor->>'canDispatch')::boolean and (ex.assignee_id is distinct from (actor->>'memberId')::uuid or ex.status in ('completed','cancelled')) then raise exception 'Forbidden' using errcode='42501'; end if;
  if ex.revision is distinct from (p_command->>'expectedRevision')::bigint then raise exception 'Revision conflict' using errcode='PT409'; end if;
  if not (actor->>'canDispatch')::boolean and action not in ('accept','start','arrive','collect','complete','evidence') then raise exception 'Forbidden' using errcode='42501'; end if;
  if ex.status in ('completed','cancelled') and action not in ('evidence','return','inspect') then raise exception 'Terminal operation' using errcode='PT409'; end if;
  if action='assign' then
   if ex.started_at is not null then raise exception 'Work already started' using errcode='PT409'; end if;
   assigned:=(payload->>'assigneeId')::uuid;
   if not exists(select 1 from public.motorist_towing_memberships m where m.id=assigned and m.organization_id=p_organization_id and m.active and 'deliver'=any(m.capabilities) and app_private.motorist_delivery_member_ready(m)) then raise exception 'Member unavailable' using errcode='22023'; end if;
   ex.assignee_id:=assigned; ex.assignment_generation:=ex.assignment_generation+1; ex.status:='assigned'; ex.confirmed_at:=null;
  elsif action='reschedule' then
   if ex.started_at is not null then raise exception 'Work started' using errcode='PT409'; end if;
   ex.scheduled_at:=(payload->>'scheduledAt')::timestamptz; ex.planned_end_at:=(payload->>'plannedEndAt')::timestamptz; ex.confirmed_at:=null;
  elsif action in ('confirm','start') then
   if ex.assignee_id is null or ex.status not in ('assigned','accepted','en_route') then raise exception 'Assignment required' using errcode='22023'; end if;
   -- Lock shared driver and cycle asset identities in stable order; queues hold no capacity.
   for resource in select value from unnest(array['driver:'||ex.assignee_id::text,'asset:'||coalesce(ex.fleet_asset_id::text,'none')]) value order by value loop
    perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||resource,0));
   end loop;
   if not exists(select 1 from public.motorist_towing_memberships m where m.id=ex.assignee_id and m.organization_id=p_organization_id and m.active and 'deliver'=any(m.capabilities) and app_private.motorist_delivery_member_ready(m)) then raise exception 'Assignment revoked' using errcode='42501'; end if;
   at_time:=case when action='start' then clock_timestamp() else ex.scheduled_at end; end_time:=ex.planned_end_at;
   if at_time is null or (action='confirm' and end_time is null) or (end_time is not null and end_time<=at_time) then raise exception 'Interval required' using errcode='22023'; end if;
   if exists(select 1 from public.motorist_logistics_executions other where other.organization_id=p_organization_id and other.operation_id<>op.id and other.status not in ('completed','cancelled') and (other.confirmed_at is not null or other.started_at is not null)
    and (other.assignee_id=ex.assignee_id or (ex.fleet_asset_id is not null and other.fleet_asset_id=ex.fleet_asset_id))
    and tstzrange(coalesce(other.started_at,other.scheduled_at),case when other.started_at is not null and other.planned_end_at<=now() then null else other.planned_end_at end,'[)') && tstzrange(at_time,end_time,'[)')) then raise exception 'Capacity conflict' using errcode='PT409'; end if;
   if exists(select 1 from public.motorist_towing_orders t where t.organization_id=p_organization_id and t.driver_id=ex.assignee_id and t.work_status='in_progress') then raise exception 'Driver physically busy' using errcode='PT409'; end if;
   if op.kind='delivery' and ex.fleet_asset_id is not null and not app_private.operations_asset_free(p_organization_id,ex.fleet_asset_id) then raise exception 'Fresh free source required' using errcode='PT409'; end if;
   ex.confirmed_at:=clock_timestamp();
   if action='start' then ex.started_at:=coalesce(ex.started_at,clock_timestamp()); ex.status:='en_route'; end if;
  elsif action='accept' and ex.status='assigned' then ex.status:='accepted';
  elsif action='arrive' and ex.status='en_route' then ex.status:='arrived';
  elsif action='collect' and op.kind='collection' and ex.status='arrived' then ex.status:='collected';
  elsif action='complete' and ((op.kind='collection' and ex.status='collected') or (op.kind<>'collection' and ex.status='arrived')) then
   ex.status:='completed'; ex.finished_at:=clock_timestamp();
   if op.kind='collection' then update public.motorist_vehicle_use_cycles set status='returned',revision=revision+1 where id=op.cycle_id; end if;
  elsif action='cancel' then
   if length(btrim(coalesce(payload->>'reason','')))=0 then raise exception 'Reason required' using errcode='22023'; end if; ex.status:='cancelled';
  elsif action='return' then
   select * into cy from public.motorist_vehicle_use_cycles where id=op.cycle_id and organization_id=p_organization_id for update;
   if not found or cy.status<>'open' then raise exception 'Open cycle required' using errcode='22023'; end if;
   update public.motorist_vehicle_use_cycles set return_mode=payload->>'returnMode',return_at=(payload->>'returnAt')::timestamptz,next_owner=left(payload->>'nextOwner',300),revision=revision+1 where id=cy.id;
   if payload->>'returnMode'='customer_returns' and payload->>'returned'='true' then
    if exists(select 1 from public.motorist_operations o join public.motorist_logistics_executions e on e.operation_id=o.id where o.cycle_id=cy.id and o.kind='collection' and e.status not in ('completed','cancelled')) then raise exception 'Resolve existing collection' using errcode='PT409'; end if;
    update public.motorist_vehicle_use_cycles set status='returned' where id=cy.id;
   elsif payload->>'returnMode'='collect' then
    select o.id into return_op from public.motorist_operations o join public.motorist_logistics_executions e on e.operation_id=o.id where o.cycle_id=cy.id and o.kind='collection' and e.status not in ('completed','cancelled');
    if return_op is null then
     insert into public.motorist_operations(organization_id,case_id,kind,cycle_id,created_by) values(p_organization_id,op.case_id,'collection',cy.id,p_user_id) returning id into return_op;
     insert into public.motorist_logistics_executions(operation_id,organization_id,fleet_asset_id,pickup,destination,scheduled_at) values(return_op,p_organization_id,cy.fleet_asset_id,ex.destination,ex.pickup,(payload->>'returnAt')::timestamptz);
    else
     update public.motorist_logistics_executions set scheduled_at=(payload->>'returnAt')::timestamptz,planned_end_at=null,confirmed_at=null,revision=revision+1,updated_at=now() where operation_id=return_op and started_at is null;
     if not found then raise exception 'Return already started' using errcode='PT409'; end if;
    end if;
   end if;
  elsif action='evidence' then
   if payload->>'source'='observed' and payload->>'stage' not in ('inspection','damage') and (actor->>'canDispatch')::boolean and ex.assignee_id is distinct from (actor->>'memberId')::uuid then raise exception 'Do not impersonate field observation' using errcode='42501'; end if;
   if (payload->>'source'='exception' and nullif(btrim(payload->>'missingReason'),'') is null) or (payload->>'stage' in ('pickup','handover') and nullif(btrim(payload->>'person'),'') is null and nullif(btrim(payload->>'missingReason'),'') is null) or ((payload->>'odometer' is null or payload->>'fuel' is null) and nullif(btrim(payload->>'missingReason'),'') is null) then raise exception 'Evidence or explicit missing reason required' using errcode='22023'; end if;
   if (payload->>'observedAt')::timestamptz>now()+interval '1 minute' then raise exception 'Future observation' using errcode='22023'; end if;
   if nullif(payload->>'photoReference','') is not null and (
    payload->>'photoReference' !~ ('^'||p_organization_id::text||'/'||op.id::text||'/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$')
    or not exists(select 1 from storage.objects obj where obj.bucket_id='motorist-operation-evidence' and obj.name=payload->>'photoReference')) then raise exception 'Private operation file required' using errcode='22023'; end if;
   insert into public.motorist_operation_evidence(operation_id,stage,author_user_id,observed_at,source,person,note,photo_reference,odometer,fuel,missing_reason)
   values(op.id,payload->>'stage',p_user_id,(payload->>'observedAt')::timestamptz,payload->>'source',left(payload->>'person',300),left(coalesce(payload->>'note',''),2000),nullif(left(payload->>'photoReference',500),''),(payload->>'odometer')::numeric,left(payload->>'fuel',100),nullif(left(payload->>'missingReason',1000),''));
  elsif action='inspect' then
   select * into cy from public.motorist_vehicle_use_cycles where id=op.cycle_id for update;
   if cy.status<>'returned' or not exists(select 1 from public.motorist_operation_evidence ev join public.motorist_operations eo on eo.id=ev.operation_id where eo.cycle_id=cy.id and ev.stage='inspection' and ev.source in ('observed','exception')) then raise exception 'Return and inspection evidence required' using errcode='22023'; end if;
   update public.motorist_vehicle_use_cycles set status='inspected',inspected_at=now(),inspected_by=p_user_id,inspection_note=left(payload->>'note',2000),revision=revision+1 where id=cy.id;
  else raise exception 'Invalid transition' using errcode='22023'; end if;
  ex.revision:=ex.revision+1; ex.updated_at:=clock_timestamp();
  update public.motorist_logistics_executions set revision=ex.revision,assignment_generation=ex.assignment_generation,status=ex.status,assignee_id=ex.assignee_id,scheduled_at=ex.scheduled_at,planned_end_at=ex.planned_end_at,confirmed_at=ex.confirmed_at,started_at=ex.started_at,finished_at=ex.finished_at,updated_at=ex.updated_at where operation_id=op.id;
 end if;
 insert into public.motorist_operation_events(operation_id,actor_user_id,command_id,action,revision,payload) values(op.id,p_user_id,cid,action,ex.revision,payload);
 receipt:=jsonb_build_object('commandId',cid,'committedRevision',ex.revision,'operation',app_private.operation_json(op));
 insert into public.motorist_operation_commands(organization_id,actor_user_id,command_id,payload,receipt) values(p_organization_id,p_user_id,cid,p_command,receipt);
 return receipt;
end $$;
-- Existing towing orders are represented by identity only; towing remains the sole writer.
insert into public.motorist_operations(organization_id,case_id,kind,towing_order_id) select organization_id,source_case_id,'tow',id from public.motorist_towing_orders;
create function app_private.operation_towing_identity() returns trigger language plpgsql set search_path='' as $$begin
 insert into public.motorist_operations(organization_id,case_id,kind,towing_order_id) values(new.organization_id,new.source_case_id,'tow',new.id) on conflict(towing_order_id) do nothing; return new; end $$;
create trigger motorist_operation_towing_identity after insert on public.motorist_towing_orders for each row execute function app_private.operation_towing_identity();

-- Historical handoffs retain their tokens, events and receipts. They gain a durable owner,
-- without guessing a rental/cycle from a plate or rental timestamp.
alter table public.motorist_case_handoffs add column operation_id uuid references public.motorist_operations(id), add column legacy_slot boolean not null default true;
insert into public.motorist_operations(id,organization_id,case_id,kind) select id,organization_id,case_id,'delivery' from public.motorist_case_handoffs;
insert into public.motorist_logistics_executions(operation_id,organization_id,status,assignee_id,pickup,destination,scheduled_at,started_at,finished_at,updated_at)
 select id,organization_id,case status when 'offered' then case when recipient_member_id is null then 'draft' else 'assigned' end when 'rejected' then 'cancelled' when 'cancelled' then 'draft' when 'expired' then 'draft' else status end,
 recipient_member_id,coalesce(published->'pickup'->>'address',''),coalesce(published->'destination'->>'address',''),nullif(published->>'scheduledAt','')::timestamptz,
 case when status in ('en_route','arrived','completed') then updated_at end,case when status='completed' then updated_at end,updated_at from public.motorist_case_handoffs;
update public.motorist_case_handoffs set operation_id=id;
drop index public.motorist_case_handoff_active;
create unique index motorist_case_handoff_operation_active on public.motorist_case_handoffs(organization_id,operation_id) where operation_id is not null and status in ('offered','accepted','en_route','arrived');
create unique index motorist_case_handoff_legacy_active on public.motorist_case_handoffs(organization_id,case_id) where legacy_slot and status in ('offered','accepted','en_route','arrived');

create function app_private.operation_handoff_sync() returns trigger language plpgsql set search_path='' as $$
declare op public.motorist_operations; ex public.motorist_logistics_executions; next_status text;
begin
 if pg_trigger_depth()>1 then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text,13102026));
 if new.operation_id is null then
  insert into public.motorist_operations(organization_id,case_id,kind) values(new.organization_id,new.case_id,'delivery') returning * into op;
  insert into public.motorist_logistics_executions(operation_id,organization_id,pickup,destination,scheduled_at) values(op.id,new.organization_id,coalesce(new.published->'pickup'->>'address',''),coalesce(new.published->'destination'->>'address',''),nullif(new.published->>'scheduledAt','')::timestamptz);
  new.operation_id:=op.id;
 else select * into op from public.motorist_operations where id=new.operation_id and organization_id=new.organization_id and kind='delivery' and towing_order_id is null;
  if not found then raise exception 'Compatible delivery required' using errcode='22023'; end if;
 end if;
 select * into ex from public.motorist_logistics_executions where operation_id=new.operation_id for update;
 if tg_op='UPDATE' and ex.status in ('completed','cancelled') and new.status not in ('completed','cancelled','expired') then raise exception 'Work already closed' using errcode='PT409'; end if;
 next_status:=case when tg_op='UPDATE' and new.recipient_member_id is distinct from old.recipient_member_id and new.recipient_member_id is not null and ex.status='draft' then 'assigned' when tg_op='UPDATE' and new.status=old.status then ex.status else case new.status when 'offered' then case when new.recipient_member_id is null then ex.status else 'assigned' end when 'accepted' then 'accepted' when 'en_route' then 'en_route' when 'arrived' then 'arrived' when 'completed' then 'completed' when 'rejected' then 'cancelled' else ex.status end end;
 if next_status='en_route' and ex.status<>'en_route' and ex.assignee_id is not null then
  if exists(select 1 from public.motorist_logistics_executions other where other.organization_id=new.organization_id and other.operation_id<>new.operation_id and other.assignee_id=ex.assignee_id and other.status not in ('completed','cancelled') and (other.started_at is not null or (other.confirmed_at is not null and tstzrange(other.scheduled_at,other.planned_end_at,'[)') && tstzrange(now(),null,'[)'))))
   or exists(select 1 from public.motorist_towing_orders t where t.organization_id=new.organization_id and t.driver_id=ex.assignee_id and t.work_status='in_progress') then raise exception 'Driver capacity conflict' using errcode='PT409'; end if;
 end if;
 -- Expiration and revocation only revoke the grant, never the durable work.
 update public.motorist_logistics_executions set status=next_status,assignee_id=coalesce(new.recipient_member_id,assignee_id),
 assignment_generation=assignment_generation+case when assignee_id is distinct from new.recipient_member_id and new.recipient_member_id is not null then 1 else 0 end,
 revision=revision+1,updated_at=now(),started_at=case when next_status='en_route' then coalesce(started_at,now()) else started_at end,
 finished_at=case when next_status='completed' then coalesce(finished_at,now()) else finished_at end,
 pickup=coalesce(new.published->'pickup'->>'address',pickup),destination=coalesce(new.published->'destination'->>'address',destination) where operation_id=new.operation_id;
 return new;
end $$;
create trigger motorist_operation_handoff_sync before insert or update of status,recipient_member_id,published on public.motorist_case_handoffs for each row execute function app_private.operation_handoff_sync();
create function app_private.operation_legacy_projection() returns trigger language plpgsql set search_path='' as $$begin
 if pg_trigger_depth()>1 then return new; end if;
 if new.assignee_id is distinct from old.assignee_id then
  update public.motorist_case_handoffs set status='cancelled',token_generation=token_generation+1,revision=revision+1,updated_at=now() where operation_id=new.operation_id and status in ('offered','accepted','en_route','arrived');
 elsif new.status is distinct from old.status then
  update public.motorist_case_handoffs set status=case new.status when 'draft' then 'offered' when 'assigned' then 'offered' else new.status end,revision=revision+1,updated_at=now()
  where operation_id=new.operation_id and status in ('offered','accepted','en_route','arrived') and new.status in ('draft','assigned','accepted','en_route','arrived','completed','cancelled');
 end if; return new;
end $$;
create trigger motorist_operation_legacy_projection after update on public.motorist_logistics_executions for each row execute function app_private.operation_legacy_projection();

-- Keep legacy RPC issue's guard aligned with its legacy slot. The BEFORE INSERT adapter
-- allocates a fresh operation after the guard; existing operation grants are independent.
do $patch$ declare definition text; begin
 definition:=pg_get_functiondef('public.motorist_case_handoff(uuid,uuid,uuid,text,jsonb)'::regprocedure);
 definition:=replace(definition,'case_id=p_case_id and status in (''offered'',''accepted'',''en_route'',''arrived'')','case_id=p_case_id and legacy_slot and status in (''offered'',''accepted'',''en_route'',''arrived'')');
 execute definition;
end $patch$;

-- Server-only APIs: anonymous/authenticated users cannot invoke privileged SQL or read
-- base rows. Every RPC resolves the current profile/member again, even after old JWT reuse.
do $security$ declare item text; begin
 foreach item in array array['motorist_vehicle_use_cycles','motorist_operations','motorist_logistics_executions','motorist_operation_evidence','motorist_operation_commands','motorist_operation_events'] loop
  execute format('alter table public.%I enable row level security',item);
  execute format('revoke all on table public.%I from public,anon,authenticated,service_role',item);
 end loop;
end $security$;
revoke all on function app_private.operations_actor(uuid,uuid),app_private.operations_asset_free(uuid,uuid),app_private.operation_json(public.motorist_operations),app_private.operation_towing_identity(),app_private.operation_handoff_sync(),app_private.operation_legacy_projection(),app_private.operation_return_identity() from public,anon,authenticated,service_role;
revoke all on function public.motorist_operations_actor(uuid,uuid),public.motorist_operations_workspace(uuid,uuid,jsonb),public.motorist_operations_command(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_operations_actor(uuid,uuid),public.motorist_operations_workspace(uuid,uuid,jsonb),public.motorist_operations_command(uuid,uuid,jsonb) to service_role;
create or replace function public.motorist_towing_command(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$

 #variable_conflict use_variable
 declare m public.motorist_towing_memberships; o public.motorist_towing_orders; old public.motorist_towing_commands; p jsonb:=p_command->'payload';
 action text:=p_command->>'type'; target uuid:=(p_command->>'targetId')::uuid; cid uuid:=(p_command->>'commandId')::uuid;
 fp text:=encode(sha256(convert_to(p_command::text,'UTF8')),'hex'); cap text; driver_op boolean:=false; result jsonb:='{}'; n bigint; total bigint; net bigint; tax bigint; l jsonb; lines jsonb:='[]'; f jsonb; required_revision boolean;
 driver uuid; a public.motorist_towing_cash_accounts; office public.motorist_towing_cash_accounts; h public.motorist_towing_cash_handovers;
 pay public.motorist_towing_payments; existing public.motorist_towing_payments; payment_uuid uuid; dr bigint; off bigint; delta bigint;
 member public.motorist_towing_memberships; doc public.motorist_towing_document_versions; taxconfig public.motorist_towing_tax_config; inv public.motorist_towing_invoice_records;
 begin
 -- One organization lock orders all financial/assignment/command mutations. This is
 -- deliberately simple at current dispatch volume; reads do not expose dirty writes.
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));
 m:=app_private.towing_authorize(p_user_id,p_organization_id,p_membership_version);
 if cid is null or target is null or jsonb_typeof(p)<>'object' then raise exception 'Invalid command' using errcode='22023';end if;
 if exists(select 1 from jsonb_each_text(p) x where x.key in ('amountCents','authorizedCollectionCents','driverReductionCents','officeReductionCents') and (x.value !~ '^[0-9]{1,16}$' or x.value::numeric>9007199254740991)) then raise exception 'Invalid exact cents' using errcode='22023';end if;
 cap:=case action when 'convert_record_only' then 'operate' when 'create_order' then 'operate' when 'refresh_source' then 'operate' when 'assign' then 'operate' when 'return' then 'operate' when 'cancel' then 'operate'
 when 'set_lines' then 'price' when 'approve_price' then 'price' when 'set_invoice' then 'bill' when 'not_required' then 'bill'
 when 'accept_handover' then 'cash' when 'reject_handover' then 'cash' when 'cancel_handover' then 'correct'
 when 'correct_payment' then 'correct' when 'refund_payment' then 'correct' when 'reconcile_receipt' then 'correct'
 when 'set_member' then 'members' when 'set_tax_config' then 'members' when 'set_parking' then 'members'
 when 'issue_document' then 'documents' when 'document_result' then 'documents' when 'email_intent' then 'documents' when 'email_result' then 'documents'
 when 'propose_handover' then 'drive'
 when 'receive_payment' then case when p_command?'assignmentGeneration' then 'drive' when 'bill'=any(m.capabilities) then 'bill' else 'drive' end
 when 'update_order' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end
 when 'start' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end
 when 'submit' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end
 when 'attachment_intent' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end
 when 'abandon_attachment' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end
 when 'attachment_finalize' then case when p_command?'assignmentGeneration' then 'drive' when 'operate'=any(m.capabilities) then 'operate' else 'drive' end else null end;
 if cap is null or not cap=any(m.capabilities) then raise exception 'Towing access denied' using errcode='42501';end if;
 driver_op:=cap='drive' and action<>'propose_handover';
 select * into o from public.motorist_towing_orders where id=target and organization_id=p_organization_id for update;
 if o.id is not null and not driver_op and not 'operate'=any(m.capabilities) and o.work_status not in ('submitted','cancelled') then raise exception 'Towing access denied' using errcode='42501';end if;
 if driver_op and (o.id is null or o.driver_id is distinct from m.id or o.assignment_generation is distinct from (p_command->>'assignmentGeneration')::bigint) then raise exception 'Towing access denied' using errcode='42501';end if;
 -- Reauthorization precedes replay, including original assignment generation. An
 -- acknowledged submit may replay after leaving driver list, but never after reassignment.
 select * into old from public.motorist_towing_commands where organization_id=p_organization_id and command_id=cid;
 if found then
 if not old.required_capability=any(m.capabilities) or (old.assignment_generation is not null and (o.driver_id is distinct from m.id or o.assignment_generation is distinct from old.assignment_generation)) then raise exception 'Towing access denied' using errcode='42501';end if;
 if old.actor_id<>m.id or old.action<>action or old.target_id<>target or old.fingerprint<>fp then raise exception 'Command identity conflict' using errcode='PT409';end if;
 if action='email_intent' then
 select jsonb_build_object('delivery',jsonb_build_object('id',e.id,'documentId',e.document_id,'recipient',e.recipient,'status',e.status,'providerMessageId',e.provider_message_id,'attemptStartedAt',e.created_at),'shouldSend',false) into result from public.motorist_towing_email_deliveries e where e.id=(p->>'id')::uuid and e.organization_id=p_organization_id;
 return jsonb_set(old.result,'{result}',result);end if;
 return old.result;end if;
 if driver_op and o.work_status not in ('assigned','in_progress','needs_changes') then raise exception 'Towing access denied' using errcode='42501';end if;
 required_revision:=action in ('convert_record_only','update_order','refresh_source','assign','start','submit','return','cancel','set_lines','approve_price','set_invoice','not_required','issue_document');
 if required_revision and (o.id is null or o.revision is distinct from (p_command->>'expectedRevision')::bigint) then raise exception 'Order revision conflict' using errcode='PT409';end if;
 if action not in ('create_order','set_member','set_tax_config','set_parking','propose_handover','accept_handover','reject_handover','cancel_handover') and o.id is null then raise exception 'Not found' using errcode='P0002';end if;
 if action='refresh_source' then
 if o.source_case_id is null then raise exception 'No linked source' using errcode='22023';end if;
 f:=public.motorist_towing_sources(p_user_id,p_organization_id,p_membership_version,'',o.source_case_id)->'sources'->0->'fields';
 if f is null then raise exception 'Source unavailable' using errcode='P0002';end if;
 update public.motorist_towing_orders set fields=fields||f,source_snapshot=f,source_copied_at=now(),approved_cents=null,billing_status=case when billing_status='invoiced' then billing_status else 'not_ready' end,reconciliation_required=reconciliation_required or billing_status='invoiced',revision=revision+1,updated_at=now() where id=target;
 elsif action in ('create_order','update_order') then
 f:=coalesce(p->'fields','{}'::jsonb);
 if jsonb_typeof(f)<>'object' then raise exception 'Invalid fields' using errcode='22023';end if;
 if exists(select 1 from jsonb_each(f) x where x.key not in ('requester','owner','customer','recipient') and ((jsonb_typeof(x.value) not in ('string','null')) or (jsonb_typeof(x.value)='null' and x.key in ('serviceType','subjectType','subjectDescription','pickup')) or length(x.value#>>'{}')>10000)) then raise exception 'Fields must be bounded text' using errcode='22023';end if;
 for l in select x.value from jsonb_each(f) x where x.key in ('requester','owner','customer','recipient') and jsonb_typeof(x.value)<>'null' loop
 if jsonb_typeof(l)<>'object' or (l-array['name','phone','email','address','companyId','taxId'])<>'{}'::jsonb or coalesce(jsonb_typeof(l->'name'),'null')<>'string' or exists(select 1 from jsonb_each(l) x where jsonb_typeof(x.value) not in ('string','null') or length(x.value#>>'{}')>2000) then raise exception 'Invalid party fields' using errcode='22023';end if;
 end loop;

 if driver_op and (f-array['startedAt','finishedAt','driverNotes','performedQuantity','photoException','destination'])<>'{}'::jsonb then raise exception 'Driver fields denied' using errcode='42501';end if;
 if driver_op and (p-array['fields'])<>'{}'::jsonb then raise exception 'Driver fields denied' using errcode='42501';end if;
 if not driver_op and (f-array['serviceType','subjectType','subjectDescription','plate','vin','pickup','destination','contact','noContactReason','branchId','fleetAssetId','plannedAt','startedAt','finishedAt','startSource','driverNotes','performedQuantity','photoException','requester','owner','customer','recipient','assistanceReference','assistancePartnerId','assistancePartnerName','parkingId','parkingName','parkingAddress','executionOrigin','externalReference'])<>'{}'::jsonb then raise exception 'Unknown fields' using errcode='22023';end if;
 f:=case when action='create_order' then jsonb_build_object('serviceType','tow','subjectType','vehicle','subjectDescription','','pickup','','executionOrigin','local')||f else o.fields||f end;
 f:=jsonb_strip_nulls(f);
 if coalesce(f->>'executionOrigin','local') not in ('local','awp_record_only') or length(coalesce(f->>'externalReference',''))>300 then raise exception 'Invalid execution origin/reference' using errcode='22023';end if;
 if action='update_order' and coalesce(f->>'executionOrigin','local')<>coalesce(o.fields->>'executionOrigin','local') then raise exception 'Use explicit conversion' using errcode='22023';end if;
 if (f?'startedAt' and nullif(f->>'startedAt','') is not null) then perform (f->>'startedAt')::timestamptz;end if;
 if (f?'finishedAt' and nullif(f->>'finishedAt','') is not null) then perform (f->>'finishedAt')::timestamptz;end if;
 if nullif(f->>'startedAt','') is not null and nullif(f->>'finishedAt','') is not null and (f->>'finishedAt')::timestamptz<(f->>'startedAt')::timestamptz then raise exception 'End precedes start' using errcode='22023';end if;
 if p->'fields'?'startedAt' then f:=f||jsonb_build_object('startSource','manual');end if;

 if coalesce(f->>'serviceType','') not in ('tow','repair','transport','storage','relocation') or coalesce(f->>'subjectType','') not in ('vehicle','machine','material') then raise exception 'Invalid service' using errcode='22023';end if;
 if nullif(f->>'branchId','') is not null and not exists(select 1 from public.motorist_branches where id=(f->>'branchId')::uuid and organization_id=p_organization_id and active) then raise exception 'Invalid branch' using errcode='22023';end if;
 if nullif(f->>'fleetAssetId','') is not null and not exists(select 1 from public.motorist_fleet_assets where id=(f->>'fleetAssetId')::uuid and organization_id=p_organization_id) then raise exception 'Invalid fleet' using errcode='22023';end if;
 if nullif(f->>'parkingId','') is not null then
 if not exists(select 1 from public.motorist_towing_parking_sites where id=(f->>'parkingId')::uuid and organization_id=p_organization_id and (active or o.fields->>'parkingId'=f->>'parkingId')) then raise exception 'Invalid parking site' using errcode='22023';end if;
 if (p->'fields'?'parkingId') or action='create_order' then select f||jsonb_build_object('parkingName',name,'parkingAddress',address) into f from public.motorist_towing_parking_sites where id=(f->>'parkingId')::uuid and organization_id=p_organization_id;end if;
 else f:=f-array['parkingName','parkingAddress'];end if;
 if nullif(f->>'assistancePartnerId','') is not null then
 if not exists(select 1 from public.motorist_contacts where id=(f->>'assistancePartnerId')::uuid and organization_id=p_organization_id and role in ('assistance','partner')) then raise exception 'Invalid assistance partner' using errcode='22023';end if;
 select f||jsonb_build_object('assistancePartnerName',name) into f from public.motorist_contacts where id=(f->>'assistancePartnerId')::uuid and organization_id=p_organization_id;
 else f:=f-'assistancePartnerName';end if;
 if action='create_order' then
 if p->>'sourceCaseId' is not null and not exists(select 1 from public.motorist_cases where id=(p->>'sourceCaseId')::uuid and organization_id=p_organization_id) then raise exception 'Invalid source' using errcode='22023';end if;
 if p->>'sourceCaseId' is not null then
 result:=public.motorist_towing_sources(p_user_id,p_organization_id,p_membership_version,'',(p->>'sourceCaseId')::uuid)->'sources'->0->'fields';
 if result is null then raise exception 'Source unavailable' using errcode='P0002';end if;
 f:=f||result||coalesce(p->'fields','{}'::jsonb);
 end if;
 insert into public.motorist_towing_orders(id,organization_id,source_case_id,source_snapshot,source_copied_at,fields,office_notes,authorized_collection_cents) values(target,p_organization_id,(p->>'sourceCaseId')::uuid,case when p->>'sourceCaseId' is not null then result else null end,case when p->>'sourceCaseId' is not null then now() else null end,f,coalesce(p->>'officeNotes',''),(p->>'authorizedCollectionCents')::bigint);
 else
 if o.work_status='cancelled' then raise exception 'Cancelled order' using errcode='22023';end if;
 update public.motorist_towing_orders set fields=f,office_notes=case when p?'officeNotes' then p->>'officeNotes' else office_notes end,authorized_collection_cents=case when p?'authorizedCollectionCents' then (p->>'authorizedCollectionCents')::bigint else authorized_collection_cents end,
 approved_cents=null,billing_status=case when billing_status='invoiced' then billing_status else 'not_ready' end,reconciliation_required=reconciliation_required or billing_status='invoiced',revision=revision+1,updated_at=now() where id=target;end if;
 elsif action='convert_record_only' then
 if o.work_status<>'draft' or o.driver_id is not null or coalesce(o.fields->>'executionOrigin','local')<>'awp_record_only' or length(btrim(coalesce(p->>'reason',''))) not between 1 and 1000 then raise exception 'Explicit draft conversion required' using errcode='22023';end if;
 update public.motorist_towing_orders set fields=jsonb_set(fields,'{executionOrigin}','"local"'::jsonb),revision=revision+1,updated_at=now() where id=target;
 elsif action='assign' then
 if o.fields->>'executionOrigin'='awp_record_only' then raise exception 'Record only work cannot dispatch' using errcode='22023';end if;
 if o.work_status='cancelled' or nullif(o.fields->>'pickup','') is null or nullif(o.fields->>'branchId','') is null or (nullif(o.fields->>'contact','') is null and nullif(o.fields->>'noContactReason','') is null) then raise exception 'Assignment incomplete' using errcode='22023';end if;
 select * into member from public.motorist_towing_memberships where id=(p->>'driverId')::uuid and organization_id=p_organization_id for share;
 if not found or not member.active or not 'drive'=any(member.capabilities) then raise exception 'Invalid driver' using errcode='22023';end if;
 perform app_private.towing_authorize(member.auth_user_id,p_organization_id,member.membership_version);
 update public.motorist_towing_assignments set ended_at=now() where order_id=target and ended_at is null;
 insert into public.motorist_towing_assignments(organization_id,order_id,driver_id,generation) values(p_organization_id,target,member.id,o.assignment_generation+1);
 update public.motorist_towing_orders set driver_id=member.id,assignment_generation=assignment_generation+1,work_status='assigned',revision=revision+1,updated_at=now(),approved_cents=null,billing_status=case when billing_status='invoiced' then billing_status else 'not_ready' end,reconciliation_required=reconciliation_required or billing_status='invoiced' where id=target;
 elsif action='start' then
 if o.fields->>'executionOrigin'='awp_record_only' then raise exception 'Record only work cannot start' using errcode='22023';end if;
 if exists(select 1 from public.motorist_towing_orders other where other.organization_id=p_organization_id and other.id<>target and other.driver_id=o.driver_id and other.work_status='in_progress') then raise exception 'Driver physically busy' using errcode='PT409';end if;
 if exists(select 1 from public.motorist_logistics_executions e where e.organization_id=p_organization_id and e.assignee_id=o.driver_id and e.status not in ('completed','cancelled') and (e.started_at is not null or (e.confirmed_at is not null and tstzrange(e.scheduled_at,e.planned_end_at,'[)') && tstzrange(now(),null,'[)')))) then raise exception 'Driver capacity conflict' using errcode='PT409';end if;
 if o.work_status not in ('assigned','needs_changes') then raise exception 'Invalid transition' using errcode='22023';end if;
 update public.motorist_towing_orders set work_status='in_progress',revision=revision+1,updated_at=now(),fields=fields||jsonb_build_object('startedAt',case when fields->>'startSource'='assignment' or nullif(fields->>'startedAt','') is null then now()::text else fields->>'startedAt' end,'startSource','manual') where id=target;
 elsif action='submit' then
 if o.work_status not in ('assigned','in_progress','needs_changes') and not (o.work_status='draft' and o.fields->>'executionOrigin'='awp_record_only' and 'operate'=any(m.capabilities) and nullif(btrim(o.fields->>'externalReference'),'') is not null) then raise exception 'Invalid transition' using errcode='22023';end if;
 if o.fields->>'startSource'='assignment' then raise exception 'Confirm actual work time' using errcode='22023';end if;
 perform app_private.towing_assert_complete(o);
 if exists(select 1 from jsonb_array_elements_text(coalesce(p->'receiptIds','[]')) r where not exists(select 1 from public.motorist_towing_payments x where x.organization_id=p_organization_id and x.order_id=target and x.receipt_id=r::uuid)) then raise exception 'Receipt confirmation required' using errcode='22023';end if;
 update public.motorist_towing_orders set work_status='submitted',revision=revision+1,updated_at=now() where id=target;
 elsif action in ('return','cancel','not_required') then
 if nullif(btrim(p->>'reason'),'') is null then raise exception 'Reason required' using errcode='22023';end if;
 if action='return' and (o.work_status<>'submitted' or o.driver_id is null) then raise exception 'Invalid return' using errcode='22023';end if;
 if action='cancel' then update public.motorist_towing_assignments set ended_at=now() where order_id=target and ended_at is null;end if;
 update public.motorist_towing_orders set work_status=case action when 'return' then 'needs_changes' when 'cancel' then 'cancelled' else work_status end,
 billing_status=case when billing_status='invoiced' then billing_status when action='not_required' then 'not_required' else 'not_ready' end,
 approved_cents=case when action='not_required' then approved_cents else null end,
 reconciliation_required=reconciliation_required or billing_status='invoiced' or (action='cancel' and exists(select 1 from public.motorist_towing_payments where order_id=target)),revision=revision+1,updated_at=now() where id=target;
 elsif action='set_lines' then
 if coalesce(jsonb_typeof(p->'lines'),'null')<>'array' or jsonb_array_length(p->'lines')>200 then raise exception 'Invalid lines' using errcode='22023';end if;
 for l in select * from jsonb_array_elements(p->'lines') loop
 if (l->>'id') is null or nullif(l->>'unit','') is null or nullif(btrim(l->>'description'),'') is null or l->>'quantity' is null or l->>'unitPrice' is null or l->>'taxRate' is null or (l->>'quantity') !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$' or (l->>'unitPrice') !~ '^[0-9]{1,9}(\.[0-9]{1,4})?$' or (l->>'taxRate') !~ '^[0-9]{1,3}(\.[0-9]{1,4})?$' or (l->>'quantity')::numeric<=0 or (l->>'taxRate')::numeric>100 then raise exception 'Invalid line' using errcode='22023';end if;
 net:=round((l->>'quantity')::numeric*(l->>'unitPrice')::numeric*100);tax:=round(net*(l->>'taxRate')::numeric/100);
 if net+tax>9007199254740991 then raise exception 'Amount limit' using errcode='22023';end if;
 lines:=lines||jsonb_build_array((l-array['netCents','taxCents','totalCents'])||jsonb_build_object('netCents',net,'taxCents',tax,'totalCents',net+tax));end loop;
 update public.motorist_towing_orders set lines=lines,tax_date=(p->>'taxDate')::date,approved_cents=null,billing_status=case when billing_status='invoiced' then billing_status else 'not_ready' end,reconciliation_required=reconciliation_required or billing_status='invoiced',revision=revision+1,updated_at=now() where id=target;
 elsif action='approve_price' then
 perform app_private.towing_assert_complete(o);
 select * into taxconfig from public.motorist_towing_tax_config where organization_id=p_organization_id;
 if o.work_status<>'submitted' or jsonb_array_length(o.lines)=0 or taxconfig.organization_id is null or o.tax_date is null or o.tax_date<taxconfig.valid_from or (taxconfig.valid_until is not null and o.tax_date>taxconfig.valid_until) or exists(select 1 from jsonb_array_elements(o.lines) x where not exists(select 1 from jsonb_array_elements_text(taxconfig.rates) r where r::numeric=(x->>'taxRate')::numeric)) then raise exception 'Price configuration or review incomplete' using errcode='22023';end if;
 select sum((x->>'totalCents')::bigint) into total from jsonb_array_elements(o.lines) x;
 if total>9007199254740991 then raise exception 'Price total limit' using errcode='22023';end if;
 update public.motorist_towing_orders set approved_cents=total,billing_status=case when billing_status='invoiced' then billing_status else 'ready' end,revision=revision+1,updated_at=now() where id=target;
 elsif action='set_invoice' then
 if o.work_status<>'submitted' or o.approved_cents is null or nullif(p->>'number','') is null or (p->>'amountCents')::bigint<>o.approved_cents then raise exception 'Invoice needs approved matching price' using errcode='22023';end if;
 select * into inv from public.motorist_towing_invoice_records i where i.order_id=target and not exists(select 1 from public.motorist_towing_invoice_records x where x.supersedes_id=i.id);
 if inv.id is not null and ((p->>'supersedesId')::uuid is distinct from inv.id or nullif(p->>'reason','') is null) then raise exception 'Explicit replacement invoice required' using errcode='22023';end if;
 if inv.id is null and p->>'supersedesId' is not null then raise exception 'Invalid predecessor' using errcode='22023';end if;
 insert into public.motorist_towing_invoice_records(id,organization_id,order_id,number,invoice_date,amount_cents,supersedes_id,reason) values((p->>'id')::uuid,p_organization_id,target,p->>'number',(p->>'date')::date,(p->>'amountCents')::bigint,inv.id,p->>'reason');
 update public.motorist_towing_orders set billing_status='invoiced',reconciliation_required=exists(select 1 from public.motorist_towing_reconciliations r where r.order_id=target and r.status='open' and not exists(select 1 from public.motorist_towing_reconciliations resolved where resolved.resolves_id=r.id)),revision=revision+1,updated_at=now() where id=target;
 elsif action in ('receive_payment','reconcile_receipt') then
 n:=(p->>'amountCents')::bigint;driver:=case when driver_op then m.id else (p->>'driverId')::uuid end;
 if action='reconcile_receipt' and (nullif(p->>'receiptId','') is null or nullif(p->>'evidence','') is null) then
 insert into public.motorist_towing_reconciliations(organization_id,order_id,actor_id,status,reason,evidence) values(p_organization_id,target,m.id,'open',coalesce(nullif(p->>'reason',''),'Unresolved receipt identity'),p->>'evidence');
 update public.motorist_towing_orders set reconciliation_required=true where id=target;result:=jsonb_build_object('reconciliationStatus','open');
 else
 if n is null or n<=0 or n>9007199254740991 or (action='receive_payment' and coalesce(p->>'method','') not in ('cash','card','bank','other')) or (driver_op and p->>'method'<>'cash') then raise exception 'Invalid payment' using errcode='22023';end if;
 if action='reconcile_receipt' and (driver is null or nullif(p->>'reason','') is null or not exists(select 1 from public.motorist_towing_assignments where organization_id=p_organization_id and order_id=target and driver_id=driver and generation=(p->>'assignmentGeneration')::bigint)) then raise exception 'Receipt provenance required' using errcode='22023';end if;
 select * into existing from public.motorist_towing_payments where organization_id=p_organization_id and receipt_id=(p->>'receiptId')::uuid;
 if existing.id is not null then
 if existing.order_id<>target or existing.amount_cents<>n or existing.driver_id is distinct from driver or existing.method<>(case when action='reconcile_receipt' then 'cash' else p->>'method' end) then raise exception 'Receipt identity conflict' using errcode='PT409';end if;
 payment_uuid:=existing.id;
 else
 if (p->>'method'='cash' or action='reconcile_receipt') and driver is null then raise exception 'Cash custodian required' using errcode='22023';end if;
 if driver is not null and not exists(select 1 from public.motorist_towing_memberships where id=driver and organization_id=p_organization_id) then raise exception 'Invalid custodian' using errcode='22023';end if;
 if p->>'method'='cash' or action='reconcile_receipt' then
 a:=app_private.towing_account(p_organization_id,driver);
 if action='receive_payment' and a.revision is distinct from (p->>'accountRevision')::bigint then raise exception 'Cash revision conflict' using errcode='PT409';end if;end if;
 insert into public.motorist_towing_payments(organization_id,order_id,receipt_id,amount_cents,method,driver_id,actor_id,captured_at,reason,evidence) values(p_organization_id,target,(p->>'receiptId')::uuid,n,case when action='reconcile_receipt' then 'cash' else p->>'method' end,driver,m.id,coalesce((p->>'capturedAt')::timestamptz,now()),p->>'reason',p->>'evidence') returning id into payment_uuid;
 if p->>'method'='cash' or action='reconcile_receipt' then
 if app_private.towing_balance(a.id)+n>9007199254740991 then raise exception 'Cash account limit' using errcode='22023';end if;
 insert into public.motorist_towing_cash_movements(organization_id,account_id,delta_cents,payment_id,command_id) values(p_organization_id,a.id,n,payment_uuid,cid);
 update public.motorist_towing_cash_accounts set revision=revision+1 where id=a.id;end if;end if;
 if action='reconcile_receipt' then
 if p->>'reconciliationId' is not null and not exists(select 1 from public.motorist_towing_reconciliations where id=(p->>'reconciliationId')::uuid and organization_id=p_organization_id and order_id=target and status='open') then raise exception 'Invalid reconciliation' using errcode='22023';end if;
 insert into public.motorist_towing_reconciliations(organization_id,order_id,receipt_id,actor_id,status,reason,evidence,payment_id,resolves_id) values(p_organization_id,target,(p->>'receiptId')::uuid,m.id,'resolved',p->>'reason',p->>'evidence',payment_uuid,(p->>'reconciliationId')::uuid);
 update public.motorist_towing_orders set reconciliation_required=(work_status='cancelled') or (billing_status='invoiced' and approved_cents is distinct from app_private.towing_due(target)) or exists(select 1 from public.motorist_towing_reconciliations r where r.order_id=target and r.status='open' and not exists(select 1 from public.motorist_towing_reconciliations done where done.resolves_id=r.id)) where id=target;
 end if;
 if o.work_status='cancelled' then update public.motorist_towing_orders set reconciliation_required=true where id=target;end if;
 result:=jsonb_build_object('paymentId',payment_uuid,'receiptId',p->>'receiptId','reconciliationStatus',case when action='reconcile_receipt' then 'resolved' else null end);
 end if;
 elsif action='propose_handover' then
 a:=app_private.towing_account(p_organization_id,m.id);n:=(p->>'amountCents')::bigint;
 if a.revision is distinct from (p->>'accountRevision')::bigint then raise exception 'Cash revision conflict' using errcode='PT409';end if;
 if n is null or n<=0 or n>app_private.towing_balance(a.id)-app_private.towing_reserved(a.id) then raise exception 'Insufficient available cash' using errcode='22023';end if;
 insert into public.motorist_towing_cash_handovers(id,organization_id,driver_id,account_id,amount_cents) values(target,p_organization_id,m.id,a.id,n);
 update public.motorist_towing_cash_accounts set revision=revision+1 where id=a.id;result:=jsonb_build_object('handoverId',target);
 elsif action in ('accept_handover','reject_handover','cancel_handover') then
 select * into h from public.motorist_towing_cash_handovers where id=target and organization_id=p_organization_id for update;
 if not found then raise exception 'Not found' using errcode='P0002';end if;
 if h.status<>'pending' or h.revision is distinct from (p_command->>'expectedRevision')::bigint then raise exception 'Handover revision conflict' using errcode='PT409';end if;
 a:=app_private.towing_account(p_organization_id,h.driver_id);
 if action='accept_handover' then
 office:=app_private.towing_account(p_organization_id,null);
 if a.revision is distinct from (p->>'accountRevision')::bigint or office.revision is distinct from (p->>'officeRevision')::bigint then raise exception 'Cash revision conflict' using errcode='PT409';end if;
 if app_private.towing_balance(office.id)+h.amount_cents>9007199254740991 then raise exception 'Cash account limit' using errcode='22023';end if;
 if h.amount_cents>app_private.towing_balance(a.id)-app_private.towing_reserved(a.id,h.id) then raise exception 'Insufficient available cash' using errcode='22023';end if;
 insert into public.motorist_towing_cash_movements(organization_id,account_id,delta_cents,handover_id,command_id) values(p_organization_id,a.id,-h.amount_cents,h.id,cid),(p_organization_id,office.id,h.amount_cents,h.id,cid);
 update public.motorist_towing_cash_accounts set revision=revision+1 where id=office.id;
 elsif nullif(btrim(p->>'reason'),'') is null then raise exception 'Reason required' using errcode='22023';end if;
 update public.motorist_towing_cash_accounts set revision=revision+1 where id=a.id;
 update public.motorist_towing_cash_handovers set status=case action when 'accept_handover' then 'accepted' when 'reject_handover' then 'rejected' else 'cancelled' end,revision=revision+1,reason=p->>'reason' where id=target;
 result:=jsonb_build_object('handoverId',target);
 elsif action in ('correct_payment','refund_payment') then
 select * into pay from public.motorist_towing_payments where id=(p->>'paymentId')::uuid and organization_id=p_organization_id and order_id=target;
 n:=(p->>'amountCents')::bigint;
 if pay.id is null or pay.amount_cents<=0 or pay.reversal_of is not null or n is null or n<0 or (action='refund_payment' and n=0) or nullif(btrim(p->>'reason'),'') is null then raise exception 'Invalid financial correction' using errcode='22023';end if;
 if exists(select 1 from public.motorist_towing_payments where reversal_of=pay.id) or (action='correct_payment' and exists(select 1 from public.motorist_towing_payments where refund_of=pay.id)) then raise exception 'Already corrected' using errcode='PT409';end if;
 delta:=case when action='correct_payment' then pay.amount_cents-n else n end;
 dr:=coalesce((p->>'driverReductionCents')::bigint,0);off:=coalesce((p->>'officeReductionCents')::bigint,0);
 if nullif(btrim(p->>'evidence'),'') is null or (pay.method='cash' and (delta<0 or dr<0 or off<0 or dr+off<>delta)) then
 insert into public.motorist_towing_reconciliations(organization_id,order_id,actor_id,status,reason,evidence,payment_id) values(p_organization_id,target,m.id,'open',p->>'reason',p->>'evidence',pay.id);
 update public.motorist_towing_orders set reconciliation_required=true where id=target;
 result:=jsonb_build_object('reconciliationStatus','open','reason','Verified custody allocation required');
 else
 if action='refund_payment' and n>pay.amount_cents+(select coalesce(sum(amount_cents),0) from public.motorist_towing_payments where refund_of=pay.id) then raise exception 'Refund exceeds receipt' using errcode='22023';end if;
 if pay.method='cash' then
 a:=app_private.towing_account(p_organization_id,pay.driver_id);office:=app_private.towing_account(p_organization_id,null);
 if a.revision is distinct from (p->>'driverRevision')::bigint or office.revision is distinct from (p->>'officeRevision')::bigint then raise exception 'Cash revision conflict' using errcode='PT409';end if;
 if dr>app_private.towing_balance(a.id)-app_private.towing_reserved(a.id) or off>app_private.towing_balance(office.id)-app_private.towing_reserved(office.id) then raise exception 'Custody allocation unavailable' using errcode='PT409';end if;end if;
 -- Full reverse+replacement preserves the original receipt. Custody entries record
 -- only the evidenced net correction; they never invent transfers between holders.
 insert into public.motorist_towing_payments(organization_id,order_id,receipt_id,amount_cents,method,driver_id,actor_id,reversal_of,refund_of,reason,evidence) values(p_organization_id,target,case when action='refund_payment' then (p->>'receiptId')::uuid else gen_random_uuid() end,case when action='correct_payment' then -pay.amount_cents else -n end,pay.method,pay.driver_id,m.id,case when action='correct_payment' then pay.id else null end,case when action='refund_payment' then pay.id else null end,p->>'reason',p->>'evidence') returning id into payment_uuid;
 if action='correct_payment' and n>0 then
 insert into public.motorist_towing_payments(organization_id,order_id,receipt_id,amount_cents,method,driver_id,actor_id,reason,evidence) values(p_organization_id,target,(p->>'replacementReceiptId')::uuid,n,pay.method,pay.driver_id,m.id,p->>'reason',p->>'evidence');end if;
 if pay.method='cash' then
 if dr>0 then insert into public.motorist_towing_cash_movements(organization_id,account_id,delta_cents,payment_id,command_id) values(p_organization_id,a.id,-dr,payment_uuid,cid);end if;
 if off>0 then insert into public.motorist_towing_cash_movements(organization_id,account_id,delta_cents,payment_id,command_id) values(p_organization_id,office.id,-off,payment_uuid,cid);end if;
 update public.motorist_towing_cash_accounts set revision=revision+1 where id in (a.id,office.id);end if;
 insert into public.motorist_towing_reconciliations(organization_id,order_id,actor_id,status,reason,evidence,payment_id,resolves_id)
 select p_organization_id,target,m.id,'resolved',p->>'reason',p->>'evidence',payment_uuid,r.id from public.motorist_towing_reconciliations r where r.order_id=target and r.status='open' and r.payment_id=pay.id and not exists(select 1 from public.motorist_towing_reconciliations done where done.resolves_id=r.id);
 update public.motorist_towing_orders set reconciliation_required=(work_status='cancelled' and exists(select 1 from public.motorist_towing_payments where order_id=target having sum(amount_cents)<>0)) or (billing_status='invoiced' and approved_cents is distinct from app_private.towing_due(target)) or exists(select 1 from public.motorist_towing_reconciliations r where r.order_id=target and r.status='open' and not exists(select 1 from public.motorist_towing_reconciliations done where done.resolves_id=r.id)) where id=target;
 result:=jsonb_build_object('paymentId',payment_uuid,'reconciliationStatus','resolved');end if;
 elsif action='attachment_intent' then
 if (select count(*) from public.motorist_towing_attachments where order_id=target and status<>'abandoned')>=50 then raise exception 'Attachment limit' using errcode='22023';end if;

 insert into public.motorist_towing_attachments(id,organization_id,order_id,actor_id,assignment_generation,kind,name,mime_type,size,path) values((p->>'id')::uuid,p_organization_id,target,m.id,o.assignment_generation,p->>'kind',p->>'name',p->>'mimeType',(p->>'size')::bigint,p_organization_id::text||'/'||target::text||'/'||(p->>'id'));
 select jsonb_build_object('attachment',jsonb_build_object('id',id,'orderId',order_id,'kind',kind,'name',name,'mimeType',mime_type,'size',size,'status',status,'path',path,'createdAt',created_at)) into result from public.motorist_towing_attachments where id=(p->>'id')::uuid;
 elsif action='abandon_attachment' then
 if nullif(btrim(p->>'reason'),'') is null then raise exception 'Reason required' using errcode='22023';end if;
 update public.motorist_towing_attachments set status='abandoned' where id=(p->>'id')::uuid and organization_id=p_organization_id and order_id=target and status='pending' and (not driver_op or (actor_id=m.id and assignment_generation=o.assignment_generation));
 if not found then raise exception 'Attachment unavailable' using errcode='P0002';end if;
 result:=jsonb_build_object('attachmentId',p->>'id','status','abandoned');
 elsif action='attachment_finalize' then
 if coalesce(p->>'sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid attachment hash' using errcode='22023';end if;
 update public.motorist_towing_attachments set status='ready',sha256=p->>'sha256' where id=(p->>'id')::uuid and order_id=target and organization_id=p_organization_id and status='pending' and (not driver_op or (actor_id=m.id and assignment_generation=o.assignment_generation));
 if not found then raise exception 'Attachment unavailable' using errcode='P0002';end if;
 result:=jsonb_build_object('attachmentId',p->>'id');
 elsif action='issue_document' then
 if coalesce(p->>'kind','') not in ('work','priced') or (p->>'kind'='priced' and (o.approved_cents is null or o.billing_status not in ('ready','invoiced') or o.reconciliation_required)) then raise exception 'Document not ready' using errcode='22023';end if;
 f:=jsonb_build_object('number',o.number,'fields',o.fields,'kind',p->>'kind','createdAt',now(),'orderRevision',o.revision,'taxDate',o.tax_date,'rounding','line-half-up','lines',case when p->>'kind'='priced' then o.lines else '[]'::jsonb end,'totalCents',case when p->>'kind'='priced' then o.approved_cents else null end);
 select coalesce(max(version),0)+1 into n from public.motorist_towing_document_versions where order_id=target;
 insert into public.motorist_towing_document_versions(id,organization_id,order_id,version,kind,snapshot,snapshot_hash,path) values((p->>'id')::uuid,p_organization_id,target,n,p->>'kind',f,encode(sha256(convert_to(f::text,'UTF8')),'hex'),p_organization_id::text||'/'||target::text||'/'||(p->>'id')||'.pdf') returning * into doc;
 result:=jsonb_build_object('document',jsonb_build_object('id',doc.id,'orderId',doc.order_id,'version',doc.version,'kind',doc.kind,'snapshot',doc.snapshot,'snapshotHash',doc.snapshot_hash,'status',doc.status,'path',doc.path,'createdAt',doc.created_at));
 elsif action='document_result' then
 if coalesce(p->>'status','') not in ('ready','failed') or (p->>'status'='ready' and coalesce(p->>'sha256','') !~ '^[a-f0-9]{64}$') then raise exception 'Invalid render result' using errcode='22023';end if;
 update public.motorist_towing_document_versions set status=p->>'status',sha256=p->>'sha256',error=left(p->>'error',250) where id=(p->>'id')::uuid and order_id=target and organization_id=p_organization_id and status<>'ready';
 if not found then raise exception 'Document unavailable' using errcode='P0002';end if;
 result:=jsonb_build_object('documentId',p->>'id');
 elsif action='email_intent' then
 select * into doc from public.motorist_towing_document_versions where id=(p->>'documentId')::uuid and order_id=target and organization_id=p_organization_id and status='ready';
 if doc.id is null or coalesce((p->>'confirmed')::boolean,false)=false or coalesce(p->>'recipient','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Confirmed recipient and document required' using errcode='22023';end if;
 insert into public.motorist_towing_email_deliveries(id,organization_id,document_id,recipient) values((p->>'id')::uuid,p_organization_id,doc.id,p->>'recipient');
 result:=jsonb_build_object('delivery',jsonb_build_object('id',p->>'id','documentId',doc.id,'recipient',p->>'recipient','status','pending','attemptStartedAt',now()),'shouldSend',true);
 elsif action='email_result' then
 update public.motorist_towing_email_deliveries e set status=p->>'status',provider_message_id=p->>'providerMessageId' where e.id=(p->>'id')::uuid and e.organization_id=p_organization_id and e.status='pending' and exists(select 1 from public.motorist_towing_document_versions d where d.id=e.document_id and d.order_id=target);
 if not found then raise exception 'Delivery unavailable' using errcode='P0002';end if;result:=jsonb_build_object('deliveryId',p->>'id','status',p->>'status','providerMessageId',p->>'providerMessageId');
 elsif action='set_member' then
 if exists(select 1 from public.motorist_towing_memberships where id=target and organization_id<>p_organization_id) then raise exception 'Towing access denied' using errcode='42501';end if;
 if nullif(btrim(p->>'email'),'') is null or not exists(select 1 from auth.users where id=(p->>'userId')::uuid and lower(email)=lower(btrim(p->>'email'))) then raise exception 'Membership email must match verified auth identity' using errcode='22023';end if;
 select * into member from public.motorist_towing_memberships where id=target and organization_id=p_organization_id for update;
 if member.id is not null and member.membership_version is distinct from (p->>'expectedVersion')::bigint then raise exception 'Member revision conflict' using errcode='PT409';end if;
 if member.id is not null and member.auth_user_id<>(p->>'userId')::uuid then raise exception 'Identity immutable' using errcode='22023';end if;
 if coalesce(jsonb_typeof(p->'roles'),'null')<>'array' or jsonb_array_length(p->'roles')=0 or nullif(btrim(p->>'displayName'),'') is null then raise exception 'Invalid member' using errcode='22023';end if;
 insert into public.motorist_towing_memberships(id,organization_id,auth_user_id,display_name,email,roles,capabilities,active,office_profile_id) values(target,p_organization_id,(p->>'userId')::uuid,p->>'displayName',lower(btrim(p->>'email')),array(select jsonb_array_elements_text(p->'roles')),app_private.towing_capabilities(array(select jsonb_array_elements_text(p->'roles'))),coalesce((p->>'active')::boolean,true),(select id from public.motorist_profiles where user_id=(p->>'userId')::uuid and organization_id=p_organization_id limit 1))
 on conflict(id) do update set display_name=excluded.display_name,email=excluded.email,roles=excluded.roles,capabilities=excluded.capabilities,active=excluded.active,office_profile_id=coalesce(public.motorist_towing_memberships.office_profile_id,excluded.office_profile_id),membership_version=public.motorist_towing_memberships.membership_version+1 where public.motorist_towing_memberships.organization_id=p_organization_id;
 if not found then raise exception 'Towing access denied' using errcode='42501';end if;
 result:=jsonb_build_object('membershipId',target);
 elsif action='set_parking' then
 if exists(select 1 from public.motorist_towing_parking_sites where id=target and organization_id<>p_organization_id) then raise exception 'Towing access denied' using errcode='42501';end if;
 if jsonb_typeof(p->'name') is distinct from 'string' or jsonb_typeof(p->'address') is distinct from 'string' or nullif(btrim(p->>'name'),'') is null or nullif(btrim(p->>'address'),'') is null or length(p->>'name')>300 or length(p->>'address')>2000 then raise exception 'Invalid parking site' using errcode='22023';end if;
 if exists(select 1 from public.motorist_towing_parking_sites where id=target and revision is distinct from (p->>'expectedRevision')::bigint) then raise exception 'Parking revision conflict' using errcode='PT409';end if;
 if not exists(select 1 from public.motorist_towing_parking_sites where id=target) and (select count(*) from public.motorist_towing_parking_sites where organization_id=p_organization_id)>=200 then raise exception 'Parking site limit' using errcode='22023';end if;
 insert into public.motorist_towing_parking_sites(id,organization_id,name,address,active) values(target,p_organization_id,btrim(p->>'name'),btrim(p->>'address'),coalesce((p->>'active')::boolean,true)) on conflict(id) do update set name=excluded.name,address=excluded.address,active=excluded.active,revision=public.motorist_towing_parking_sites.revision+1 where public.motorist_towing_parking_sites.organization_id=p_organization_id;
 if not found then raise exception 'Towing access denied' using errcode='42501';end if;
 result:=jsonb_build_object('parkingId',target);
 elsif action='set_tax_config' then
 if coalesce(jsonb_typeof(p->'rates'),'null')<>'array' or jsonb_array_length(p->'rates')=0 or exists(select 1 from jsonb_array_elements_text(p->'rates') r where r !~ '^[0-9]{1,3}(\.[0-9]{1,4})?$' or r::numeric>100) or nullif(p->>'label','') is null then raise exception 'Invalid tax configuration' using errcode='22023';end if;
 insert into public.motorist_towing_tax_config(organization_id,rates,valid_from,valid_until,label) values(p_organization_id,p->'rates',(p->>'validFrom')::date,(p->>'validUntil')::date,p->>'label') on conflict(organization_id) do update set rates=excluded.rates,valid_from=excluded.valid_from,valid_until=excluded.valid_until,label=excluded.label,revision=public.motorist_towing_tax_config.revision+1;
 else raise exception 'Unsupported command' using errcode='22023';end if;
 select revision into n from public.motorist_towing_orders where id=target;
 if n is null then select revision into n from public.motorist_towing_cash_handovers where id=target;end if;
 result:=jsonb_build_object('commandId',cid,'targetId',target,'revision',coalesce(n,1),'result',result);
 insert into public.motorist_towing_events(organization_id,target_id,actor_id,action,command_id,payload) values(p_organization_id,target,m.id,action,cid,p);
 insert into public.motorist_towing_commands(organization_id,command_id,actor_id,action,target_id,fingerprint,required_capability,result,assignment_generation) values(p_organization_id,cid,m.id,action,target,fp,cap,result,case when driver_op then o.assignment_generation else null end);
 return result;
 end $$;


do $patch$ declare definition text; begin
 definition:=pg_get_functiondef('app_private.towing_driver_fields(jsonb)'::regprocedure);
 definition:=replace(definition,'''parkingId'',''parkingName'',''parkingAddress''','''parkingId'',''parkingName'',''parkingAddress'',''assistanceReference'',''assistancePartnerName'',''executionOrigin'',''externalReference''');
 definition:=replace(definition,'''owner'',case when', '''customer'',case when jsonb_typeof(f->''customer'')=''object'' then jsonb_build_object(''name'',f->''customer''->>''name'',''phone'',f->''customer''->>''phone'') end,''owner'',case when');
 execute definition;
 definition:=pg_get_functiondef('app_private.towing_order_json(public.motorist_towing_orders,boolean,uuid)'::regprocedure);
 definition:=replace(definition,' and (not driver_view or a.kind<>''scan'')',''); execute definition;
 definition:=pg_get_functiondef('public.motorist_towing_file(uuid,uuid,bigint,uuid,text)'::regprocedure);
 definition:=replace(definition,' and a.kind<>''scan''',''); execute definition;
end $patch$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('motorist-operation-evidence','motorist-operation-evidence',false,4194304,array['image/jpeg','image/png','image/webp','application/pdf']) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy motorist_operation_evidence_proxy_only on storage.objects as restrictive for all to anon,authenticated using(bucket_id<>'motorist-operation-evidence') with check(bucket_id<>'motorist-operation-evidence');
commit;
