begin;
-- Work notices to the right person. Each notice is written in the same
-- transaction as the change that causes it (outbox), sent right after the
-- command and drained by the existing five-minute cron. Before sending, the
-- recipient's current access is re-checked; stale notices are dropped.

alter table public.motorist_work_groups
 add column escalate_after_minutes integer not null default 10 check (escalate_after_minutes between 5 and 1440),
 add column escalate_to_central boolean not null default false;

create table public.motorist_push_outbox (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 member_id uuid references public.motorist_towing_memberships(id), profile_id uuid references public.motorist_profiles(id),
 type text not null check (type in ('work','branch')), event text not null,
 subject_type text not null check (subject_type in ('operation','towing','branch_request')), subject_id uuid not null,
 dedupe_key text not null, title text not null check (length(title) <= 120), body text not null check (length(body) <= 240),
 status text not null default 'pending' check (status in ('pending','sending','sent','dropped','failed')),
 attempts integer not null default 0, lease_until timestamptz, outcome text,
 created_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 check ((member_id is null) <> (profile_id is null)), unique (organization_id, dedupe_key)
);
create index motorist_push_outbox_due on public.motorist_push_outbox(organization_id, created_at) where status in ('pending','sending');
alter table public.motorist_push_outbox enable row level security;
revoke all on public.motorist_push_outbox from public, anon, authenticated, service_role;

create function app_private.push_enqueue(org uuid, member uuid, profile uuid, kind text, event text, subject_type text, subject uuid, dedupe text, title text, body text)
returns void language sql security definer set search_path='' as $$
 insert into public.motorist_push_outbox(organization_id,member_id,profile_id,type,event,subject_type,subject_id,dedupe_key,title,body)
 values(org,member,profile,kind,event,subject_type,subject,dedupe,left(title,120),left(body,240)) on conflict (organization_id,dedupe_key) do nothing
$$;
-- Notice texts never carry customer data.
create function app_private.push_term(at timestamptz) returns text language sql immutable set search_path='' as $$
 select case when at is null then 'Bez dohodnutého termínu' else 'Termín ' || to_char(at at time zone 'Europe/Bratislava','DD.MM. HH24:MI') end
$$;
create function app_private.push_kind(kind text) returns text language sql immutable set search_path='' as $$
 select case kind when 'delivery' then 'pristavenie' when 'collection' then 'odvoz vozidla' when 'transfer' then 'presun vozidla' when 'tow' then 'odťah' else 'práca' end
$$;

-- Logistics executions: assignment, reassignment, new term, cancellation.
create function app_private.push_logistics_change() returns trigger language plpgsql security definer set search_path='' as $$
declare op public.motorist_operations; label text;
begin
 select * into op from public.motorist_operations where id=new.operation_id;
 -- Legacy app deliveries keep their own notice (case-handoff push); never twice.
 if exists(select 1 from public.motorist_case_handoffs h where h.operation_id=new.operation_id) then return new; end if;
 label:=app_private.push_kind(op.kind);
 begin
  if new.assignee_id is distinct from old.assignee_id then
   if new.assignee_id is not null and new.status not in ('completed','cancelled') then
    perform app_private.push_enqueue(new.organization_id,new.assignee_id,null,'work','work_assigned','operation',new.operation_id,
     'work_assigned:'||new.operation_id||':'||new.assignment_generation||':'||new.assignee_id,'Nové ' || label,app_private.push_term(new.scheduled_at));
   end if;
   if old.assignee_id is not null then
    perform app_private.push_enqueue(new.organization_id,old.assignee_id,null,'work','work_unassigned','operation',new.operation_id,
     'work_unassigned:'||new.operation_id||':'||new.assignment_generation||':'||old.assignee_id,'Práca vám bola odobratá',initcap(label) || ' prevzal iný kolega.');
   end if;
  elsif new.assignee_id is not null and new.status='cancelled' and old.status<>'cancelled' then
   perform app_private.push_enqueue(new.organization_id,new.assignee_id,null,'work','work_cancelled','operation',new.operation_id,
    'work_cancelled:'||new.operation_id||':'||new.assignee_id,'Zrušené ' || label,'Jazdu netreba vykonať.');
  elsif new.assignee_id is not null and new.status not in ('completed','cancelled') and (new.scheduled_at is distinct from old.scheduled_at or new.planned_end_at is distinct from old.planned_end_at) then
   perform app_private.push_enqueue(new.organization_id,new.assignee_id,null,'work','work_changed','operation',new.operation_id,
    'work_changed:'||new.operation_id||':'||new.revision||':'||new.assignee_id,'Zmena termínu: ' || label,app_private.push_term(new.scheduled_at));
  end if;
 exception when others then raise warning 'push outbox (logistics) skipped: %', sqlerrm;
 end;
 return new;
end $$;
create trigger motorist_push_logistics after update of assignee_id,status,scheduled_at,planned_end_at on public.motorist_logistics_executions
 for each row execute function app_private.push_logistics_change();

-- Towing orders: driver assignment and work returned for changes or cancelled.
create function app_private.push_towing_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
 begin
  if new.driver_id is distinct from old.driver_id and new.driver_id is not null and new.work_status not in ('submitted','cancelled') then
   perform app_private.push_enqueue(new.organization_id,new.driver_id,null,'work','tow_assigned','towing',new.id,
    'tow_assigned:'||new.id||':'||new.assignment_generation||':'||new.driver_id,'Nový odťah',app_private.push_term(nullif(new.fields->>'plannedAt','')::timestamptz));
  end if;
  if new.driver_id is distinct from old.driver_id and old.driver_id is not null then
   perform app_private.push_enqueue(new.organization_id,old.driver_id,null,'work','tow_unassigned','towing',new.id,
    'tow_unassigned:'||new.id||':'||new.assignment_generation||':'||old.driver_id,'Odťah vám bol odobratý','Zákazku prevzal iný vodič.');
  end if;
  if new.driver_id is not null and new.driver_id is not distinct from old.driver_id and new.work_status is distinct from old.work_status and new.work_status in ('needs_changes','cancelled') then
   perform app_private.push_enqueue(new.organization_id,new.driver_id,null,'work','tow_'||new.work_status,'towing',new.id,
    'tow_'||new.work_status||':'||new.id||':'||new.revision||':'||new.driver_id,
    case new.work_status when 'needs_changes' then 'Odťah vrátený na doplnenie' else 'Odťah zrušený' end,
    case new.work_status when 'needs_changes' then 'Kancelária žiada doplniť údaje.' else 'Zákazku netreba vykonať.' end);
  end if;
 exception when others then raise warning 'push outbox (towing) skipped: %', sqlerrm;
 end;
 return new;
end $$;
create trigger motorist_push_towing after update of driver_id,work_status on public.motorist_towing_orders
 for each row execute function app_private.push_towing_change();

-- Branch queue: a request arriving in a group notifies its receiving leads.
create function app_private.push_branch_arrival() returns trigger language plpgsql security definer set search_path='' as $$
declare g public.motorist_work_groups; m record;
begin
 if new.status<>'queued' or (tg_op='UPDATE' and new.routed_at is not distinct from old.routed_at) then return new; end if;
 begin
  select * into g from public.motorist_work_groups where id=new.group_id;
  for m in select gm.member_id from public.motorist_work_group_members gm join public.motorist_towing_memberships tm on tm.id=gm.member_id and tm.active
   where gm.group_id=new.group_id and gm.role='lead' and gm.receives_new loop
   perform app_private.push_enqueue(new.organization_id,m.member_id,null,'branch','branch_new','branch_request',new.id,
    'branch_new:'||new.id||':'||extract(epoch from new.routed_at)::bigint||':'||m.member_id,'Nová práca: ' || g.name,initcap(app_private.push_kind(new.kind)) || ' čaká na prevzatie.');
  end loop;
 exception when others then raise warning 'push outbox (branch) skipped: %', sqlerrm;
 end;
 return new;
end $$;
create trigger motorist_push_branch after insert or update of group_id,status,routed_at on public.motorist_work_requests
 for each row execute function app_private.push_branch_arrival();

-- A reported damage reaches the lead who assigned the work, else the dispatcher who created it.
create function app_private.push_damage_report() returns trigger language plpgsql security definer set search_path='' as $$
declare lead uuid; creator uuid; op public.motorist_operations; label text;
begin
 if new.stage<>'damage' then return new; end if;
 begin
  select * into op from public.motorist_operations where id=new.operation_id;
  label:=initcap(app_private.push_kind(op.kind));
  select e.actor_member_id into lead from public.motorist_work_requests r join public.motorist_work_request_events e on e.request_id=r.id and e.action='materialize'
   where r.operation_id=new.operation_id and e.actor_member_id is not null order by e.created_at desc limit 1;
  if lead is not null then
   perform app_private.push_enqueue(op.organization_id,lead,null,'work','work_problem','operation',op.id,'work_problem:'||new.id||':m:'||lead,'Nahlásené poškodenie',label || ': vykonávateľ nahlásil poškodenie.');
  else
   select p.id into creator from public.motorist_profiles p where p.organization_id=op.organization_id and p.user_id=op.created_by and p.active;
   if creator is not null then
    perform app_private.push_enqueue(op.organization_id,null,creator,'work','work_problem','operation',op.id,'work_problem:'||new.id||':p:'||creator,'Nahlásené poškodenie',label || ': vykonávateľ nahlásil poškodenie.');
   end if;
  end if;
 exception when others then raise warning 'push outbox (damage) skipped: %', sqlerrm;
 end;
 return new;
end $$;
create trigger motorist_push_damage after insert on public.motorist_operation_evidence
 for each row execute function app_private.push_damage_report();

-- Waiting too long in a branch queue (evaluated by the cron, so at least 5 minutes).
create function public.motorist_branch_escalate(p_organization_id uuid) returns integer language plpgsql security definer set search_path='' as $$
declare r record; m record; n integer:=0; before bigint;
begin
 for r in select wr.*,g.name group_name,g.escalate_to_central,round(extract(epoch from now()-wr.routed_at)/60)::int waited from public.motorist_work_requests wr join public.motorist_work_groups g on g.id=wr.group_id and g.active
  where wr.organization_id=p_organization_id and wr.status='queued' and wr.routed_at<now()-make_interval(mins=>g.escalate_after_minutes) and wr.routed_at>now()-interval '2 days' limit 200 loop
  select count(*) into before from public.motorist_push_outbox where organization_id=p_organization_id and subject_id=r.id and event='branch_waiting';
  for m in select gm.member_id from public.motorist_work_group_members gm join public.motorist_towing_memberships tm on tm.id=gm.member_id and tm.active
   where gm.group_id=r.group_id and gm.role='lead' loop
   perform app_private.push_enqueue(p_organization_id,m.member_id,null,'branch','branch_waiting','branch_request',r.id,'branch_waiting:'||r.id||':'||extract(epoch from r.routed_at)::bigint||':m:'||m.member_id,
    'Práca čaká na prevzatie',r.group_name || ': ' || app_private.push_kind(r.kind) || ' čaká ' || r.waited || ' min.');
  end loop;
  if r.escalate_to_central then
   for m in select p.id from public.motorist_profiles p where p.organization_id=p_organization_id and p.active and p.access_status='active' and p.role in ('senior_dispatcher','manager','admin') loop
    perform app_private.push_enqueue(p_organization_id,null,m.id,'branch','branch_waiting','branch_request',r.id,'branch_waiting:'||r.id||':'||extract(epoch from r.routed_at)::bigint||':p:'||m.id,
     'Pobočka neprevzala prácu',r.group_name || ': ' || app_private.push_kind(r.kind) || ' čaká ' || r.waited || ' min.');
   end loop;
  end if;
  n:=n+(select count(*) from public.motorist_push_outbox where organization_id=p_organization_id and subject_id=r.id and event='branch_waiting')-before;
 end loop;
 return n;
end $$;

-- Claim due notices with a lease (immediate send and cron never send the same
-- row twice) and drop the ones whose recipient no longer has the work.
create function app_private.push_still_valid(o public.motorist_push_outbox) returns boolean language sql stable set search_path='' as $$
 select case
  when o.member_id is not null and not exists(select 1 from public.motorist_towing_memberships m where m.id=o.member_id and m.active) then false
  when o.profile_id is not null and not exists(select 1 from public.motorist_profiles p where p.id=o.profile_id and p.active and p.access_status='active') then false
  when o.event in ('work_assigned','work_changed') then exists(select 1 from public.motorist_logistics_executions e where e.operation_id=o.subject_id and e.assignee_id=o.member_id and e.status not in ('completed','cancelled'))
  when o.event='tow_assigned' then exists(select 1 from public.motorist_towing_orders t where t.id=o.subject_id and t.driver_id=o.member_id and t.work_status not in ('submitted','cancelled'))
  when o.event in ('branch_new','branch_waiting') then exists(select 1 from public.motorist_work_requests r where r.id=o.subject_id and r.status='queued'
   and (o.profile_id is not null or app_private.branch_lead(r.organization_id,o.member_id,r.group_id)))
  else true end
$$;
create function public.motorist_push_outbox_claim(p_organization_id uuid, p_limit integer default 50) returns jsonb language plpgsql security definer set search_path='' as $$
declare claimed jsonb;
begin
 update public.motorist_push_outbox set status='dropped',outcome='no_longer_valid',finished_at=clock_timestamp(),lease_until=null
  where id in (select id from public.motorist_push_outbox o where o.organization_id=p_organization_id and (o.status='pending' or (o.status='sending' and o.lease_until<clock_timestamp()))
   and not app_private.push_still_valid(o) order by o.created_at limit 500 for update skip locked);
 update public.motorist_push_outbox set status='failed',outcome='expired',finished_at=clock_timestamp(),lease_until=null
  where organization_id=p_organization_id and status in ('pending','sending') and created_at<now()-interval '1 day';
 with due as (select id from public.motorist_push_outbox where organization_id=p_organization_id and (status='pending' or (status='sending' and lease_until<clock_timestamp()))
   order by created_at limit least(200,greatest(1,p_limit)) for update skip locked),
  marked as (update public.motorist_push_outbox o set status='sending',attempts=o.attempts+1,lease_until=clock_timestamp()+interval '2 minutes' from due where o.id=due.id returning o.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'memberId',member_id,'profileId',profile_id,'type',type,'event',event,'title',title,'body',body,
  'target',jsonb_build_object('kind',case subject_type when 'branch_request' then 'branch-request' else subject_type end,'id',subject_id)) order by created_at),'[]') into claimed from marked;
 return claimed;
end $$;
create function public.motorist_push_outbox_finish(p_organization_id uuid, p_results jsonb) returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if jsonb_typeof(p_results)<>'array' then raise exception 'Invalid results' using errcode='22023'; end if;
 update public.motorist_push_outbox o set
  status=case x.outcome when 'sent' then 'sent' when 'no_device' then 'dropped' else case when o.attempts>=5 then 'failed' else 'pending' end end,
  outcome=x.outcome,lease_until=null,finished_at=case when x.outcome in ('sent','no_device') or o.attempts>=5 then clock_timestamp() else null end
 from jsonb_to_recordset(p_results) x(id uuid, outcome text)
 where o.id=x.id and o.organization_id=p_organization_id and o.status='sending' and x.outcome in ('sent','no_device','failed');
 get diagnostics n=row_count;
 delete from public.motorist_push_outbox where organization_id=p_organization_id and status in ('sent','dropped','failed') and created_at<now()-interval '30 days';
 return n;
end $$;

create or replace function public.motorist_branch_workspace(p_user_id uuid,p_organization_id uuid,p_filters jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
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
  select s.r,coalesce((x.x->>'done')::boolean,false) done,coalesce((x.x->>'cancelled')::boolean,false) cancelled from scoped s cross join lateral (select case when (s.r).operation_id is null then null else app_private.branch_execution((s.r).operation_id) end x) x
 ), visible as (
  select f.r from filtered f where view='all' or (view='queue' and (f.r).status in ('queued','claimed')) or (view='active' and (f.r).status='assigned' and not f.done and not f.cancelled)
   or (view='done' and ((f.r).status='cancelled' or f.done or f.cancelled)) or (view='open' and (f.r).status<>'cancelled' and not f.done and not f.cancelled)
 ) select (select count(*) from visible),coalesce((select jsonb_agg(app_private.branch_request_json(p.r) order by (p.r).routed_at desc,(p.r).id) from (select v.r from visible v order by (v.r).routed_at desc,(v.r).id
   limit least(200,greatest(1,coalesce((p_filters->>'limit')::integer,100))) offset greatest(0,coalesce((p_filters->>'offset')::integer,0))) p),'[]') into total,rows;
 return jsonb_build_object('actor',actor,'requests',rows,'totalCount',total,
  'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'active',g.active,'revision',g.revision,'branchId',g.branch_id,'branchName',b.name,'serviceKinds',to_jsonb(g.service_kinds),'escalateAfterMinutes',g.escalate_after_minutes,'escalateToCentral',g.escalate_to_central,
    'counts',jsonb_build_object('queued',(select count(*) from public.motorist_work_requests r where r.group_id=g.id and r.status='queued'),'claimed',(select count(*) from public.motorist_work_requests r where r.group_id=g.id and r.status='claimed'),
     'active',(select count(*) from public.motorist_work_requests r join public.motorist_operations o on o.id=r.operation_id left join public.motorist_logistics_executions e on e.operation_id=o.id left join public.motorist_towing_orders t on t.id=o.towing_order_id
       where r.group_id=g.id and r.status='assigned' and coalesce(t.work_status,e.status) not in ('completed','cancelled','submitted')),
     'overdue',(select count(*) from public.motorist_work_requests r left join public.motorist_operations o on o.id=r.operation_id left join public.motorist_logistics_executions e on e.operation_id=o.id left join public.motorist_towing_orders t on t.id=o.towing_order_id
       where r.group_id=g.id and r.status in ('queued','claimed','assigned') and r.due_at<now() and coalesce(e.started_at,nullif(t.fields->>'startedAt','')::timestamptz) is null and coalesce(t.work_status,e.status,'') not in ('cancelled','completed','submitted'))),
    'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'name',m.display_name,'role',gm.role,'receivesNew',gm.receives_new,'active',m.active,'canDeliver','deliver'=any(m.capabilities),'canDrive','drive'=any(m.capabilities)) order by gm.role,m.display_name)
     from public.motorist_work_group_members gm join public.motorist_towing_memberships m on m.id=gm.member_id where gm.group_id=g.id),'[]')) order by g.name)
   from public.motorist_work_groups g left join public.motorist_branches b on b.id=g.branch_id where g.organization_id=p_organization_id and ((actor->>'central')::boolean or app_private.branch_lead(p_organization_id,(actor->>'memberId')::uuid,g.id)) and (g.active or (actor->>'manage')::boolean)),'[]'),
  'branches',case when (actor->>'manage')::boolean then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name) from public.motorist_branches where organization_id=p_organization_id and active),'[]') else '[]' end,
  'people',case when (actor->>'manage')::boolean then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',display_name,'email',email,'roles',to_jsonb(roles)) order by display_name) from public.motorist_towing_memberships where organization_id=p_organization_id and active),'[]') else '[]' end,
  'cycles',case when (actor->>'central')::boolean then coalesce((select jsonb_agg(jsonb_build_object('id',cy.id,'vehicle',a.label,'caseId',cy.case_id) order by cy.created_at) from public.motorist_vehicle_use_cycles cy join public.motorist_fleet_assets a on a.id=cy.fleet_asset_id where cy.organization_id=p_organization_id and cy.status='open'),'[]') else '[]' end,
  'fleet',case when (actor->>'central')::boolean then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',label) order by label) from public.motorist_fleet_assets where organization_id=p_organization_id and kind='replacement_car'),'[]') else '[]' end);
end $$;

-- Escalation settings of a branch (manager/admin). Kept apart from group_save so
-- existing group receipts and their replay semantics stay unchanged.
create function public.motorist_branch_group_settings(p_user_id uuid,p_organization_id uuid,p_group_id uuid,p_expected_revision bigint,p_escalate_after integer,p_escalate_to_central boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; g public.motorist_work_groups;
begin
 actor:=app_private.branch_actor(p_user_id,p_organization_id);
 if not (actor->>'manage')::boolean then raise exception 'Forbidden' using errcode='42501'; end if;
 if p_escalate_after is null or p_escalate_after not between 5 and 1440 or p_escalate_to_central is null then raise exception 'Invalid escalation' using errcode='22023'; end if;
 update public.motorist_work_groups set escalate_after_minutes=p_escalate_after,escalate_to_central=p_escalate_to_central,revision=revision+1,updated_at=now()
  where id=p_group_id and organization_id=p_organization_id and revision=p_expected_revision returning * into g;
 if not found then raise exception 'Revision conflict' using errcode='PT409'; end if;
 return jsonb_build_object('group',jsonb_build_object('id',g.id,'revision',g.revision,'name',g.name,'escalateAfterMinutes',g.escalate_after_minutes,'escalateToCentral',g.escalate_to_central));
end $$;
revoke all on function app_private.push_enqueue(uuid,uuid,uuid,text,text,text,uuid,text,text,text),app_private.push_term(timestamptz),app_private.push_kind(text),
 app_private.push_logistics_change(),app_private.push_towing_change(),app_private.push_branch_arrival(),app_private.push_damage_report(),
 app_private.push_still_valid(public.motorist_push_outbox) from public,anon,authenticated,service_role;
revoke all on function public.motorist_branch_escalate(uuid),public.motorist_push_outbox_claim(uuid,integer),public.motorist_push_outbox_finish(uuid,jsonb),public.motorist_branch_group_settings(uuid,uuid,uuid,bigint,integer,boolean) from public,anon,authenticated;
grant execute on function public.motorist_branch_escalate(uuid),public.motorist_push_outbox_claim(uuid,integer),public.motorist_push_outbox_finish(uuid,jsonb),public.motorist_branch_group_settings(uuid,uuid,uuid,bigint,integer,boolean) to service_role;
notify pgrst, 'reload schema';
commit;
