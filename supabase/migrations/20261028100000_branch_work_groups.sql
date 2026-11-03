begin;
-- Pobočky: central dispatch routes a work request to a receiving group; one
-- local lead claims it and materializes the concrete execution for a member.
-- Physical branch (motorist_branches) and receiving group are deliberately
-- separate; a group without a branch reports as "neurčená".

alter table public.motorist_towing_memberships drop constraint motorist_towing_memberships_roles_check;
alter table public.motorist_towing_memberships add constraint motorist_towing_memberships_roles_check
 check (roles <@ array['driver','dispatch','billing','manager','delivery','branch'] and cardinality(roles)>0);

create table public.motorist_work_groups (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 name text not null check(length(btrim(name)) between 1 and 120), branch_id uuid references public.motorist_branches(id),
 service_kinds text[] not null default array['delivery','collection','transfer','tow']
  check(service_kinds <@ array['delivery','collection','transfer','tow'] and cardinality(service_kinds)>0),
 active boolean not null default true, revision bigint not null default 1,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(organization_id,id)
);
create unique index motorist_work_groups_name on public.motorist_work_groups(organization_id,lower(btrim(name)));
create table public.motorist_work_group_members (
 organization_id uuid not null, group_id uuid not null, member_id uuid not null,
 role text not null check(role in ('lead','member')), receives_new boolean not null default false,
 created_at timestamptz not null default now(), primary key(group_id,member_id),
 foreign key(organization_id,group_id) references public.motorist_work_groups(organization_id,id),
 foreign key(organization_id,member_id) references public.motorist_towing_memberships(organization_id,id)
);
create index motorist_work_group_members_member on public.motorist_work_group_members(organization_id,member_id);
create table public.motorist_work_requests (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 case_id uuid references public.motorist_cases(id) on delete set null, kind text not null check(kind in ('delivery','collection','transfer','tow')),
 group_id uuid not null, status text not null default 'queued' check(status in ('queued','claimed','assigned','cancelled')),
 pickup text not null default '' check(length(pickup)<=1000), destination text not null default '' check(length(destination)<=1000),
 due_at timestamptz, note text not null default '' check(length(note)<=4000),
 fleet_asset_id uuid references public.motorist_fleet_assets(id), cycle_id uuid references public.motorist_vehicle_use_cycles(id),
 routed_at timestamptz not null default clock_timestamp(), claimed_by uuid, claimed_by_name text, claimed_at timestamptz,
 operation_id uuid unique references public.motorist_operations(id), cancel_reason text,
 revision bigint not null default 1, created_by uuid not null, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,group_id) references public.motorist_work_groups(organization_id,id),
 check((status in ('claimed','assigned'))=(claimed_by is not null) or status='cancelled'), check((status='assigned')=(operation_id is not null))
);
create index motorist_work_requests_queue on public.motorist_work_requests(organization_id,group_id,status,routed_at);
create index motorist_work_requests_case on public.motorist_work_requests(organization_id,case_id);
-- Event rows carry the group at the time of the event: historical attribution
-- survives later moves between branches.
create table public.motorist_work_request_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, request_id uuid not null references public.motorist_work_requests(id),
 group_id uuid not null, action text not null, actor_user_id uuid not null, actor_member_id uuid, command_id uuid not null, revision bigint not null,
 payload jsonb not null default '{}', created_at timestamptz not null default clock_timestamp()
);
create index motorist_work_request_events_report on public.motorist_work_request_events(organization_id,group_id,created_at);
create index motorist_work_request_events_request on public.motorist_work_request_events(request_id,created_at);
create table public.motorist_work_request_commands (
 organization_id uuid not null, actor_user_id uuid not null, command_id uuid not null, payload jsonb not null, receipt jsonb not null,
 created_at timestamptz not null default now(), primary key(organization_id,actor_user_id,command_id)
);
alter table public.motorist_work_groups enable row level security;
alter table public.motorist_work_group_members enable row level security;
alter table public.motorist_work_requests enable row level security;
alter table public.motorist_work_request_events enable row level security;
alter table public.motorist_work_request_commands enable row level security;
revoke all on public.motorist_work_groups,public.motorist_work_group_members,public.motorist_work_requests,public.motorist_work_request_events,public.motorist_work_request_commands from public,anon,authenticated;

-- Central = active dispatch profile. Lead = active membership with a lead seat
-- in an active group. Executors without a lead seat use Moje jazdy, not this module.
create function app_private.branch_actor(u uuid, org uuid) returns jsonb language plpgsql volatile set search_path='' as $$
declare p public.motorist_profiles; m public.motorist_towing_memberships; groups jsonb;
begin
 if not exists(select 1 from public.motorist_organizations where id=org and active) then raise exception 'Forbidden' using errcode='42501'; end if;
 select * into p from public.motorist_profiles where organization_id=org and user_id=u and active and access_status='active' and role in ('dispatcher','senior_dispatcher','manager','admin');
 select * into m from public.motorist_towing_memberships where organization_id=org and auth_user_id=u and active;
 if m.id is not null then m:=app_private.towing_authorize(u,org,m.membership_version); end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'role',gm.role,'receivesNew',gm.receives_new) order by g.name),'[]') into groups
  from public.motorist_work_group_members gm join public.motorist_work_groups g on g.id=gm.group_id and g.organization_id=org and g.active
  where gm.organization_id=org and gm.member_id=m.id and gm.role='lead';
 if p.id is null and jsonb_array_length(groups)=0 then raise exception 'Forbidden' using errcode='42501'; end if;
 return jsonb_build_object('userId',u,'organizationId',org,'displayName',coalesce(p.display_name,m.display_name),'memberId',m.id,'version',m.membership_version,
  'central',p.id is not null,'manage',coalesce(p.role in ('manager','admin'),false),'leadGroups',groups,
  'canDeliver',coalesce('deliver'=any(m.capabilities),false),'canOperateTowing',coalesce('operate'=any(m.capabilities),false));
end $$;
create function app_private.branch_lead(org uuid, member uuid, grp uuid) returns boolean language sql stable set search_path='' as $$
 select member is not null and exists(select 1 from public.motorist_work_group_members gm join public.motorist_work_groups g on g.id=gm.group_id and g.active
  where gm.organization_id=org and gm.group_id=grp and gm.member_id=member and gm.role='lead')
$$;
create function app_private.branch_can_see(actor jsonb, grp uuid) returns boolean language sql stable set search_path='' as $$
 select (actor->>'central')::boolean or app_private.branch_lead((actor->>'organizationId')::uuid,(actor->>'memberId')::uuid,grp)
$$;

-- A lead receives operations office rights only for the one claimed request or
-- its materialized operation named by this transaction-local scope. Only the
-- branch command below sets it; it is cleared before that command returns.
create function app_private.branch_scope_allows(org uuid, member uuid) returns boolean language plpgsql stable set search_path='' as $$
declare scope text:=coalesce(current_setting('motorist.operation_scope',true),''); target uuid;
begin
 if member is null or scope !~ '^(request|operation):[0-9a-f-]{36}$' then return false; end if;
 target:=split_part(scope,':',2)::uuid;
 if split_part(scope,':',1)='request' then
  return exists(select 1 from public.motorist_work_requests r join public.motorist_towing_memberships m on m.id=member
   where r.id=target and r.organization_id=org and r.status='claimed' and r.claimed_by=m.auth_user_id and app_private.branch_lead(org,member,r.group_id));
 end if;
 return exists(select 1 from public.motorist_work_requests r where r.operation_id=target and r.organization_id=org and r.status='assigned' and app_private.branch_lead(org,member,r.group_id));
end $$;
create or replace function app_private.operations_actor(u uuid, org uuid) returns jsonb language plpgsql volatile set search_path='' as $$
declare p public.motorist_profiles; m public.motorist_towing_memberships; office boolean:=false; scoped boolean:=false;
begin
 if not exists(select 1 from public.motorist_organizations where id=org and active) then raise exception 'Forbidden' using errcode='42501'; end if;
 select * into p from public.motorist_profiles where organization_id=org and user_id=u and active and access_status='active' and role in ('dispatcher','senior_dispatcher','manager','admin');
 office:=p.id is not null;
 select * into m from public.motorist_towing_memberships where organization_id=org and auth_user_id=u and active;
 if m.id is not null then m:=app_private.towing_authorize(u,org,m.membership_version); end if;
 office:=office or (m.id is not null and 'operate'=any(m.capabilities));
 if not office then scoped:=app_private.branch_scope_allows(org,m.id); office:=scoped; end if;
 if not office and (m.id is null or not ('deliver'=any(m.capabilities))) then raise exception 'Forbidden' using errcode='42501'; end if;
 return jsonb_build_object('userId',u,'organizationId',org,'displayName',coalesce(p.display_name,m.display_name),'profileId',p.id,'memberId',m.id,'version',m.membership_version,'canDispatch',office,'branchScoped',scoped);
end $$;

create function app_private.branch_execution(op uuid) returns jsonb language sql stable set search_path='' as $$
 select case when o.id is null then null else jsonb_build_object('operationId',o.id,'owner',case when t.id is null then 'logistics' else 'towing_order' end,'ownerId',coalesce(t.id,o.id),
  'status',coalesce(t.work_status,e.status),'revision',coalesce(t.revision,e.revision),'assigneeId',coalesce(t.driver_id,e.assignee_id),'assignee',m.display_name,
  'scheduledAt',coalesce(nullif(t.fields->>'plannedAt','')::timestamptz,e.scheduled_at),'plannedEndAt',e.planned_end_at,'confirmedAt',e.confirmed_at,
  'startedAt',coalesce(nullif(t.fields->>'startedAt','')::timestamptz,e.started_at),
  'finishedAt',case when t.id is not null then case when t.work_status='submitted' then nullif(t.fields->>'finishedAt','')::timestamptz end else e.finished_at end,
  'done',coalesce(t.work_status='submitted',e.status='completed'),'cancelled',coalesce(t.work_status,e.status)='cancelled') end
 from (select 1) seed left join public.motorist_operations o on o.id=op
 left join public.motorist_logistics_executions e on e.operation_id=o.id left join public.motorist_towing_orders t on t.id=o.towing_order_id
 left join public.motorist_towing_memberships m on m.id=coalesce(t.driver_id,e.assignee_id)
$$;
-- Allowlisted case projection: what a local lead needs to execute the request,
-- never the full case file, notes, attachments or finance.
create function app_private.branch_request_json(r public.motorist_work_requests) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',r.id,'kind',r.kind,'status',r.status,'revision',r.revision,'groupId',r.group_id,'groupName',g.name,
  'branchName',b.name,'caseId',r.case_id,'caseNumber',c.case_number,'caseType',c.case_type,
  'customer',case when c.id is null then null else jsonb_build_object('name',coalesce(nullif(ct.name,''),nullif(btrim(concat_ws(' ',c.customer_details->>'firstName',c.customer_details->>'lastName')),''),c.customer_details->>'companyName',''),'phone',coalesce(ct.phone,'')) end,
  'vehicle',coalesce(a.label,nullif(btrim(concat_ws(' ',v.license_plate,v.make,v.model)),''),c.vehicle_details->>'licensePlate'),
  'pickup',r.pickup,'destination',r.destination,'dueAt',r.due_at,'note',r.note,'fleetAssetId',r.fleet_asset_id,'cycleId',r.cycle_id,
  'routedAt',r.routed_at,'claimedBy',r.claimed_by,'claimedByName',r.claimed_by_name,'claimedAt',r.claimed_at,'cancelReason',r.cancel_reason,
  'createdAt',r.created_at,'updatedAt',r.updated_at,'execution',app_private.branch_execution(r.operation_id),
  'related',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'status',x.status,'groupName',xg.name,'executionStatus',app_private.branch_execution(x.operation_id)->>'status') order by x.created_at)
   from public.motorist_work_requests x join public.motorist_work_groups xg on xg.id=x.group_id where x.organization_id=r.organization_id and x.case_id=r.case_id and x.id<>r.id),'[]'))
 from public.motorist_work_groups g left join public.motorist_branches b on b.id=g.branch_id
 left join public.motorist_cases c on c.id=r.case_id and c.organization_id=r.organization_id
 left join public.motorist_contacts ct on ct.id=c.contact_id and ct.organization_id=c.organization_id
 left join public.motorist_vehicles v on v.id=c.vehicle_id and v.organization_id=c.organization_id
 left join public.motorist_fleet_assets a on a.id=r.fleet_asset_id
 where g.id=r.group_id
$$;

create function public.motorist_branch_workspace(p_user_id uuid,p_organization_id uuid,p_filters jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; view text:=coalesce(p_filters->>'view','open'); grp uuid; rows jsonb; total bigint;
begin
 actor:=app_private.branch_actor(p_user_id,p_organization_id);
 if jsonb_typeof(p_filters)<>'object' or (p_filters-array['view','groupId','caseId','id','limit','offset'])<>'{}'::jsonb or view not in ('open','queue','active','done','all') then raise exception 'Invalid filters' using errcode='22023'; end if;
 grp:=nullif(p_filters->>'groupId','')::uuid;
 if grp is not null and not app_private.branch_can_see(actor,grp) then raise exception 'Forbidden' using errcode='42501'; end if;
 with scoped as (
  select r from public.motorist_work_requests r where r.organization_id=p_organization_id and app_private.branch_can_see(actor,r.group_id)
   and (grp is null or r.group_id=grp) and (p_filters->>'caseId' is null or r.case_id=(p_filters->>'caseId')::uuid) and (p_filters->>'id' is null or r.id=(p_filters->>'id')::uuid)
 ), filtered as (
  select s.r,coalesce((app_private.branch_execution((s.r).operation_id)->>'done')::boolean,false) done,coalesce((app_private.branch_execution((s.r).operation_id)->>'cancelled')::boolean,false) cancelled from scoped s
 ), visible as (
  select f.r from filtered f where view='all' or (view='queue' and (f.r).status in ('queued','claimed')) or (view='active' and (f.r).status='assigned' and not f.done and not f.cancelled)
   or (view='done' and ((f.r).status='cancelled' or f.done or f.cancelled)) or (view='open' and (f.r).status<>'cancelled' and not f.done and not f.cancelled)
 ) select (select count(*) from visible),coalesce((select jsonb_agg(app_private.branch_request_json(p.r) order by (p.r).routed_at desc,(p.r).id) from (select v.r from visible v order by (v.r).routed_at desc,(v.r).id
   limit least(200,greatest(1,coalesce((p_filters->>'limit')::integer,100))) offset greatest(0,coalesce((p_filters->>'offset')::integer,0))) p),'[]') into total,rows;
 return jsonb_build_object('actor',actor,'requests',rows,'totalCount',total,
  'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'active',g.active,'revision',g.revision,'branchId',g.branch_id,'branchName',b.name,'serviceKinds',to_jsonb(g.service_kinds),
    'counts',jsonb_build_object('queued',(select count(*) from public.motorist_work_requests r where r.group_id=g.id and r.status='queued'),'claimed',(select count(*) from public.motorist_work_requests r where r.group_id=g.id and r.status='claimed'),
     'active',(select count(*) from public.motorist_work_requests r where r.group_id=g.id and r.status='assigned' and not coalesce((app_private.branch_execution(r.operation_id)->>'done')::boolean,false) and not coalesce((app_private.branch_execution(r.operation_id)->>'cancelled')::boolean,false)),
     'overdue',(select count(*) from public.motorist_work_requests r where r.group_id=g.id and r.status in ('queued','claimed','assigned') and r.due_at<now() and app_private.branch_execution(r.operation_id)->>'startedAt' is null and not coalesce((app_private.branch_execution(r.operation_id)->>'cancelled')::boolean,false))),
    'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'name',m.display_name,'role',gm.role,'receivesNew',gm.receives_new,'active',m.active,'canDeliver','deliver'=any(m.capabilities),'canDrive','drive'=any(m.capabilities)) order by gm.role,m.display_name)
     from public.motorist_work_group_members gm join public.motorist_towing_memberships m on m.id=gm.member_id where gm.group_id=g.id),'[]')) order by g.name)
   from public.motorist_work_groups g left join public.motorist_branches b on b.id=g.branch_id where g.organization_id=p_organization_id and ((actor->>'central')::boolean or app_private.branch_lead(p_organization_id,(actor->>'memberId')::uuid,g.id)) and (g.active or (actor->>'manage')::boolean)),'[]'),
  'branches',case when (actor->>'manage')::boolean then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name) from public.motorist_branches where organization_id=p_organization_id and active),'[]') else '[]' end,
  'people',case when (actor->>'manage')::boolean then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',display_name,'email',email,'roles',to_jsonb(roles)) order by display_name) from public.motorist_towing_memberships where organization_id=p_organization_id and active),'[]') else '[]' end,
  'cycles',case when (actor->>'central')::boolean then coalesce((select jsonb_agg(jsonb_build_object('id',cy.id,'vehicle',a.label,'caseId',cy.case_id) order by cy.created_at) from public.motorist_vehicle_use_cycles cy join public.motorist_fleet_assets a on a.id=cy.fleet_asset_id where cy.organization_id=p_organization_id and cy.status='open'),'[]') else '[]' end,
  'fleet',case when (actor->>'central')::boolean then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',label) order by label) from public.motorist_fleet_assets where organization_id=p_organization_id and kind='replacement_car'),'[]') else '[]' end);
end $$;

create function public.motorist_branch_command(p_user_id uuid,p_organization_id uuid,p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; r public.motorist_work_requests; g public.motorist_work_groups; receipt jsonb; cid uuid; action text:=p_command->>'action'; payload jsonb:=p_command->'payload';
 central boolean; manage boolean; member uuid; target_member public.motorist_towing_memberships; op_receipt jsonb; op_id uuid; op_rev bigint; inner_command jsonb; event_payload jsonb:='{}'; tow_id uuid; result_group uuid;
begin
 actor:=app_private.branch_actor(p_user_id,p_organization_id); central:=(actor->>'central')::boolean; manage:=(actor->>'manage')::boolean; member:=(actor->>'memberId')::uuid;
 if jsonb_typeof(p_command)<>'object' or (p_command->>'commandId') !~ '^[0-9a-fA-F-]{36}$' or jsonb_typeof(payload) is distinct from 'object' then raise exception 'Invalid command' using errcode='22023'; end if;
 cid:=(p_command->>'commandId')::uuid;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_user_id::text||cid::text,28102026));
 select c.receipt into receipt from public.motorist_work_request_commands c where c.organization_id=p_organization_id and c.actor_user_id=p_user_id and c.command_id=cid;
 if found then
  if not exists(select 1 from public.motorist_work_request_commands c where c.organization_id=p_organization_id and c.actor_user_id=p_user_id and c.command_id=cid and c.payload=p_command) then raise exception 'Command conflict' using errcode='PT409'; end if;
  if receipt->'request'->>'groupId' is not null and not app_private.branch_can_see(actor,(receipt->'request'->>'groupId')::uuid) then raise exception 'Forbidden' using errcode='42501'; end if;
  return receipt;
 end if;

 if action in ('group_save','group_member') then
  if not manage then raise exception 'Forbidden' using errcode='42501'; end if;
  if action='group_save' then
   if nullif(btrim(payload->>'name'),'') is null or length(payload->>'name')>120 then raise exception 'Invalid group' using errcode='22023'; end if;
   if nullif(payload->>'branchId','') is not null and not exists(select 1 from public.motorist_branches where id=(payload->>'branchId')::uuid and organization_id=p_organization_id) then raise exception 'Invalid branch' using errcode='22023'; end if;
   if jsonb_typeof(payload->'serviceKinds') is distinct from 'array' then raise exception 'Invalid group' using errcode='22023'; end if;
   if nullif(payload->>'groupId','') is null then
    insert into public.motorist_work_groups(organization_id,name,branch_id,service_kinds) values(p_organization_id,btrim(payload->>'name'),nullif(payload->>'branchId','')::uuid,array(select distinct jsonb_array_elements_text(payload->'serviceKinds'))) returning * into g;
   else
    update public.motorist_work_groups set name=btrim(payload->>'name'),branch_id=nullif(payload->>'branchId','')::uuid,service_kinds=array(select distinct jsonb_array_elements_text(payload->'serviceKinds')),
     active=coalesce((payload->>'active')::boolean,active),revision=revision+1,updated_at=now()
     where id=(payload->>'groupId')::uuid and organization_id=p_organization_id and revision=(p_command->>'expectedRevision')::bigint returning * into g;
    if not found then raise exception 'Revision conflict' using errcode='PT409'; end if;
   end if;
  else
   select * into g from public.motorist_work_groups where id=(payload->>'groupId')::uuid and organization_id=p_organization_id for update;
   if not found then raise exception 'Group unavailable' using errcode='P0002'; end if;
   if not exists(select 1 from public.motorist_towing_memberships where id=(payload->>'memberId')::uuid and organization_id=p_organization_id) then raise exception 'Member unavailable' using errcode='22023'; end if;
   if coalesce(payload->>'role','') not in ('lead','member','none') then raise exception 'Invalid role' using errcode='22023'; end if;
   if payload->>'role'='none' then delete from public.motorist_work_group_members where group_id=g.id and member_id=(payload->>'memberId')::uuid;
   else insert into public.motorist_work_group_members(organization_id,group_id,member_id,role,receives_new) values(p_organization_id,g.id,(payload->>'memberId')::uuid,payload->>'role',coalesce((payload->>'receivesNew')::boolean,false))
    on conflict(group_id,member_id) do update set role=excluded.role,receives_new=excluded.receives_new; end if;
   update public.motorist_work_groups set revision=revision+1,updated_at=now() where id=g.id returning * into g;
  end if;
  receipt:=jsonb_build_object('commandId',cid,'group',jsonb_build_object('id',g.id,'revision',g.revision,'name',g.name));
  insert into public.motorist_work_request_commands(organization_id,actor_user_id,command_id,payload,receipt) values(p_organization_id,p_user_id,cid,p_command,receipt);
  return receipt;
 end if;

 if action='create' then
  if not central then raise exception 'Forbidden' using errcode='42501'; end if;
  if coalesce((p_command->>'expectedRevision')::bigint,0)<>0 then raise exception 'New revision required' using errcode='PT409'; end if;
  select * into g from public.motorist_work_groups where id=(payload->>'groupId')::uuid and organization_id=p_organization_id and active;
  if not found then raise exception 'Group unavailable' using errcode='22023'; end if;
  if not (payload->>'kind' = any(g.service_kinds)) then raise exception 'Group does not handle this service' using errcode='22023'; end if;
  if payload->>'caseId' is not null and not exists(select 1 from public.motorist_cases where id=(payload->>'caseId')::uuid and organization_id=p_organization_id) then raise exception 'Case unavailable' using errcode='P0002'; end if;
  if payload->>'fleetAssetId' is not null and not exists(select 1 from public.motorist_fleet_assets where id=(payload->>'fleetAssetId')::uuid and organization_id=p_organization_id and kind='replacement_car') then raise exception 'Asset unavailable' using errcode='22023'; end if;
  if payload->>'cycleId' is not null and not exists(select 1 from public.motorist_vehicle_use_cycles where id=(payload->>'cycleId')::uuid and organization_id=p_organization_id and status='open') then raise exception 'Cycle unavailable' using errcode='22023'; end if;
  if payload->>'kind'='collection' and payload->>'cycleId' is null then raise exception 'Confirmed cycle required' using errcode='22023'; end if;
  insert into public.motorist_work_requests(organization_id,case_id,kind,group_id,pickup,destination,due_at,note,fleet_asset_id,cycle_id,created_by)
   values(p_organization_id,(payload->>'caseId')::uuid,payload->>'kind',g.id,left(coalesce(payload->>'pickup',''),1000),left(coalesce(payload->>'destination',''),1000),
    nullif(payload->>'dueAt','')::timestamptz,left(coalesce(payload->>'note',''),4000),(payload->>'fleetAssetId')::uuid,(payload->>'cycleId')::uuid,p_user_id) returning * into r;
  action:='route';
 else
  select * into r from public.motorist_work_requests where id=(p_command->>'requestId')::uuid and organization_id=p_organization_id for update;
  if not found or not app_private.branch_can_see(actor,r.group_id) then raise exception 'Request unavailable' using errcode='P0002'; end if;
  if r.revision is distinct from (p_command->>'expectedRevision')::bigint then raise exception 'Revision conflict' using errcode='PT409'; end if;
  if r.status='cancelled' then raise exception 'Request cancelled' using errcode='PT409'; end if;
  select * into g from public.motorist_work_groups where id=r.group_id;
  if action='route' then
   if not central or r.status not in ('queued','claimed') then raise exception 'Only central routes unassigned work' using errcode='42501'; end if;
   select * into g from public.motorist_work_groups where id=(payload->>'groupId')::uuid and organization_id=p_organization_id and active;
   if not found or not (r.kind=any(g.service_kinds)) then raise exception 'Group unavailable' using errcode='22023'; end if;
   if g.id=r.group_id then raise exception 'Already in this group' using errcode='22023'; end if;
   event_payload:=jsonb_build_object('fromGroupId',r.group_id,'reason',left(coalesce(payload->>'reason',''),1000));
   update public.motorist_work_requests set group_id=g.id,status='queued',claimed_by=null,claimed_by_name=null,claimed_at=null,routed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() where id=r.id returning * into r;
  elsif action='claim' then
   if r.status<>'queued' then raise exception 'Already claimed' using errcode='PT409'; end if;
   update public.motorist_work_requests set status='claimed',claimed_by=p_user_id,claimed_by_name=actor->>'displayName',claimed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() where id=r.id returning * into r;
  elsif action='release' then
   if r.status<>'claimed' or (r.claimed_by<>p_user_id and not central) then raise exception 'Not your claim' using errcode='42501'; end if;
   event_payload:=jsonb_build_object('reason',left(coalesce(payload->>'reason',''),1000));
   update public.motorist_work_requests set status='queued',claimed_by=null,claimed_by_name=null,claimed_at=null,revision=revision+1,updated_at=clock_timestamp() where id=r.id returning * into r;
  elsif action='cancel' then
   if r.status='assigned' then raise exception 'Cancel the execution instead' using errcode='PT409'; end if;
   if nullif(btrim(payload->>'reason'),'') is null then raise exception 'Reason required' using errcode='22023'; end if;
   event_payload:=jsonb_build_object('reason',left(payload->>'reason',1000));
   update public.motorist_work_requests set status='cancelled',cancel_reason=left(payload->>'reason',1000),revision=revision+1,updated_at=clock_timestamp() where id=r.id returning * into r;
  elsif action='materialize' then
   if r.status<>'claimed' or r.claimed_by<>p_user_id then raise exception 'Claim the request first' using errcode='PT409'; end if;
   if r.kind='tow' then
    -- Towing keeps its own capability, work and finance owner; the driver is assigned in the towing office.
    if not (actor->>'canOperateTowing')::boolean then raise exception 'Towing office permission required' using errcode='42501'; end if;
    tow_id:=md5('branch-tow:'||r.id::text)::uuid;
    perform public.motorist_towing_command(p_user_id,p_organization_id,(actor->>'version')::bigint,jsonb_build_object('commandId',md5('branch-tow-cmd:'||cid::text)::uuid,'targetId',tow_id,'type','create_order',
     'payload',jsonb_strip_nulls(jsonb_build_object('sourceCaseId',r.case_id,'fields',jsonb_strip_nulls(jsonb_build_object('serviceType','tow','executionOrigin','local','pickup',nullif(r.pickup,''),'destination',nullif(r.destination,''),'branchId',g.branch_id))))));
    select id into op_id from public.motorist_operations where towing_order_id=tow_id and organization_id=p_organization_id;
   else
    select * into target_member from public.motorist_towing_memberships m where m.id=(payload->>'assigneeId')::uuid and m.organization_id=p_organization_id;
    if not found or not exists(select 1 from public.motorist_work_group_members gm where gm.group_id=r.group_id and gm.member_id=target_member.id) then raise exception 'Assignee must belong to this group' using errcode='22023'; end if;
    perform set_config('motorist.operation_scope','request:'||r.id::text,true);
    op_receipt:=public.motorist_operations_command(p_user_id,p_organization_id,jsonb_build_object('commandId',md5('branch-create:'||cid::text)::uuid,'action','create','expectedRevision',0,
     'payload',jsonb_strip_nulls(jsonb_build_object('kind',r.kind,'caseId',r.case_id,'from',r.pickup,'to',r.destination,'scheduledAt',r.due_at,'fleetAssetId',r.fleet_asset_id,'cycleId',r.cycle_id))));
    op_id:=(op_receipt->'operation'->>'id')::uuid; op_rev:=(op_receipt->>'committedRevision')::bigint;
    op_receipt:=public.motorist_operations_command(p_user_id,p_organization_id,jsonb_build_object('commandId',md5('branch-assign:'||cid::text)::uuid,'action','assign','operationId',op_id,'expectedRevision',op_rev,'payload',jsonb_build_object('assigneeId',target_member.id)));
    perform set_config('motorist.operation_scope','',true);
    event_payload:=jsonb_build_object('assigneeId',target_member.id,'assignee',target_member.display_name);
   end if;
   if op_id is null then raise exception 'Execution was not created' using errcode='P0002'; end if;
   update public.motorist_work_requests set status='assigned',operation_id=op_id,revision=revision+1,updated_at=clock_timestamp() where id=r.id returning * into r;
  elsif action='operate' then
   -- Local follow-up on the materialized logistics execution only.
   if r.status<>'assigned' then raise exception 'Execution required' using errcode='22023'; end if;
   inner_command:=payload->'command';
   if jsonb_typeof(inner_command) is distinct from 'object' or inner_command->>'action' not in ('assign','reschedule','confirm','cancel') then raise exception 'Unsupported execution action' using errcode='22023'; end if;
   if exists(select 1 from public.motorist_operations where id=r.operation_id and towing_order_id is not null) then raise exception 'Use towing execution owner' using errcode='22023'; end if;
   if inner_command->>'action'='assign' and not exists(select 1 from public.motorist_work_group_members gm where gm.group_id=r.group_id and gm.member_id=(inner_command->'payload'->>'assigneeId')::uuid) then raise exception 'Assignee must belong to this group' using errcode='22023'; end if;
   perform set_config('motorist.operation_scope','operation:'||r.operation_id::text,true);
   op_receipt:=public.motorist_operations_command(p_user_id,p_organization_id,jsonb_build_object('commandId',md5('branch-op:'||cid::text)::uuid,'action',inner_command->>'action','operationId',r.operation_id,
    'expectedRevision',(inner_command->>'expectedRevision')::bigint,'payload',coalesce(inner_command->'payload','{}'::jsonb)));
   perform set_config('motorist.operation_scope','',true);
   event_payload:=jsonb_build_object('operationAction',inner_command->>'action','payload',coalesce(inner_command->'payload','{}'::jsonb));
   update public.motorist_work_requests set revision=revision+1,updated_at=clock_timestamp() where id=r.id returning * into r;
  else raise exception 'Unknown action' using errcode='22023';
  end if;
 end if;
 insert into public.motorist_work_request_events(organization_id,request_id,group_id,action,actor_user_id,actor_member_id,command_id,revision,payload)
  values(p_organization_id,r.id,r.group_id,case when action='operate' then 'operate' else action end,p_user_id,member,cid,r.revision,event_payload);
 receipt:=jsonb_build_object('commandId',cid,'committedRevision',r.revision,'request',app_private.branch_request_json(r));
 insert into public.motorist_work_request_commands(organization_id,actor_user_id,command_id,payload,receipt) values(p_organization_id,p_user_id,cid,p_command,receipt);
 return receipt;
end $$;

-- Reports count routing episodes, unique requests and unique cases separately;
-- times come only from recorded events and unknown values stay unknown.
create function public.motorist_branch_report(p_user_id uuid,p_organization_id uuid,p_from timestamptz,p_to timestamptz,p_filters jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; grp uuid; want_kind text; rows jsonb; people jsonb;
begin
 actor:=app_private.branch_actor(p_user_id,p_organization_id);
 if p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '366 days' or jsonb_typeof(p_filters)<>'object' or (p_filters-array['groupId','kind'])<>'{}'::jsonb then raise exception 'Invalid report period or filters' using errcode='22023'; end if;
 grp:=nullif(p_filters->>'groupId','')::uuid; want_kind:=nullif(p_filters->>'kind','');
 if grp is not null and not app_private.branch_can_see(actor,grp) then raise exception 'Forbidden' using errcode='42501'; end if;
 if want_kind is not null and want_kind not in ('delivery','collection','transfer','tow') then raise exception 'Invalid kind' using errcode='22023'; end if;
 with groups as (
  select g.id,g.name,b.name branch from public.motorist_work_groups g left join public.motorist_branches b on b.id=g.branch_id
  where g.organization_id=p_organization_id and app_private.branch_can_see(actor,g.id) and (grp is null or g.id=grp)
 ), routes as (
  select e.*,r.case_id,r.kind,lead(e.created_at) over (partition by e.request_id order by e.created_at,e.id) next_route
  from public.motorist_work_request_events e join public.motorist_work_requests r on r.id=e.request_id
  where e.organization_id=p_organization_id and e.action='route' and (want_kind is null or r.kind=want_kind)
 ), episodes as (
  select ro.group_id,ro.request_id,ro.case_id,ro.created_at routed,
   (select min(c.created_at) from public.motorist_work_request_events c where c.request_id=ro.request_id and c.action='claim' and c.group_id=ro.group_id and c.created_at>=ro.created_at and (ro.next_route is null or c.created_at<ro.next_route)) claimed,
   (select min(c.created_at) from public.motorist_work_request_events c where c.request_id=ro.request_id and c.action='materialize' and c.group_id=ro.group_id and c.created_at>=ro.created_at and (ro.next_route is null or c.created_at<ro.next_route)) assigned
  from routes ro where ro.created_at>=p_from and ro.created_at<p_to
 ), executions as (
  select m.group_id,r.id request_id,app_private.branch_execution(r.operation_id) x from public.motorist_work_request_events m join public.motorist_work_requests r on r.id=m.request_id
  where m.organization_id=p_organization_id and m.action='materialize' and (want_kind is null or r.kind=want_kind)
 )
 select coalesce(jsonb_agg(jsonb_build_object('groupId',g.id,'groupName',g.name,'branchName',g.branch,
  'received',(select count(*) from episodes e where e.group_id=g.id),
  'uniqueRequests',(select count(distinct e.request_id) from episodes e where e.group_id=g.id),
  'uniqueCases',(select count(distinct e.case_id) from episodes e where e.group_id=g.id),
  'withoutCase',(select count(distinct e.request_id) from episodes e where e.group_id=g.id and e.case_id is null),
  'waitingNow',(select count(*) from public.motorist_work_requests r where r.group_id=g.id and r.status='queued' and (want_kind is null or r.kind=want_kind)),
  'unassignedNow',(select count(*) from public.motorist_work_requests r where r.group_id=g.id and r.status='claimed' and (want_kind is null or r.kind=want_kind)),
  'inProgressNow',(select count(*) from executions x join public.motorist_work_requests r on r.id=x.request_id where x.group_id=g.id and r.group_id=g.id and not (x.x->>'done')::boolean and not (x.x->>'cancelled')::boolean),
  'completed',(select count(*) from executions x where x.group_id=g.id and (x.x->>'done')::boolean and (x.x->>'finishedAt')::timestamptz>=p_from and (x.x->>'finishedAt')::timestamptz<p_to),
  'completedUnknownTime',(select count(*) from executions x where x.group_id=g.id and (x.x->>'done')::boolean and x.x->>'finishedAt' is null),
  'reaction',jsonb_build_object('samples',(select count(*) from episodes e where e.group_id=g.id and e.claimed is not null),'unclaimed',(select count(*) from episodes e where e.group_id=g.id and e.claimed is null),
   'avgSeconds',(select round(avg(extract(epoch from e.claimed-e.routed))) from episodes e where e.group_id=g.id and e.claimed is not null),
   'medianSeconds',(select round(percentile_cont(0.5) within group (order by extract(epoch from e.claimed-e.routed))::numeric) from episodes e where e.group_id=g.id and e.claimed is not null)),
  'assignment',jsonb_build_object('samples',(select count(*) from episodes e where e.group_id=g.id and e.assigned is not null),
   'medianSeconds',(select round(percentile_cont(0.5) within group (order by extract(epoch from e.assigned-e.routed))::numeric) from episodes e where e.group_id=g.id and e.assigned is not null))
  ) order by g.name),'[]') into rows from groups g;
 select coalesce(jsonb_agg(jsonb_build_object('memberId',w.member,'name',w.name,'open',w.open,'inProgress',w.started) order by w.open desc,w.name),'[]') into people from (
  select (x->>'assigneeId')::uuid member,x->>'assignee' name,count(*) open,count(*) filter (where x->>'startedAt' is not null) started
  from (select app_private.branch_execution(r.operation_id) x from public.motorist_work_requests r where r.organization_id=p_organization_id and r.status='assigned'
   and app_private.branch_can_see(actor,r.group_id) and (grp is null or r.group_id=grp) and (want_kind is null or r.kind=want_kind)) s
  where x->>'assigneeId' is not null and not (x->>'done')::boolean and not (x->>'cancelled')::boolean group by 1,2) w;
 return jsonb_build_object('from',p_from,'to',p_to,'groups',rows,'workload',people);
end $$;

revoke all on function app_private.branch_actor(uuid,uuid),app_private.branch_lead(uuid,uuid,uuid),app_private.branch_can_see(jsonb,uuid),app_private.branch_scope_allows(uuid,uuid),
 app_private.branch_execution(uuid),app_private.branch_request_json(public.motorist_work_requests) from public,anon,authenticated,service_role;
revoke all on function public.motorist_branch_workspace(uuid,uuid,jsonb),public.motorist_branch_command(uuid,uuid,jsonb),public.motorist_branch_report(uuid,uuid,timestamptz,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_branch_workspace(uuid,uuid,jsonb),public.motorist_branch_command(uuid,uuid,jsonb),public.motorist_branch_report(uuid,uuid,timestamptz,timestamptz,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
