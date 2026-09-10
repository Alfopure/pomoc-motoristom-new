-- Expand/bridge only by default. Activation requires an explicitly verified
-- inventory of every allowed dev/Preview/production writer of this copy.
-- The insert bridge alone is NOT an authorization to activate 0..N/chat.
create schema if not exists app_private;
create table public.motorist_task_workspace_settings (
  organization_id uuid primary key references public.motorist_organizations(id) on delete cascade,
  enabled boolean not null default false,
  writer_inventory_verified_at timestamptz,
  writer_inventory_note text,
  check (not enabled or (writer_inventory_verified_at is not null and coalesce(length(trim(writer_inventory_note)),0) > 0))
);
insert into public.motorist_task_workspace_settings(organization_id) select id from public.motorist_organizations;
revoke all on public.motorist_task_workspace_settings from public, anon, authenticated, service_role;
grant select on public.motorist_task_workspace_settings to service_role;
alter table public.motorist_task_workspace_settings enable row level security;

alter table public.motorist_case_tasks alter column case_id drop not null;
alter table public.motorist_case_tasks add column reminder_at timestamptz;
alter table public.motorist_case_tasks add column revision integer not null default 1 check(revision > 0);
alter table public.motorist_case_tasks add column origin_locked boolean not null default false;
alter table public.motorist_case_tasks add column provenance text not null default 'manual' check(provenance in ('manual','proven','ambiguous'));
-- Discover the actual legacy constraint name instead of assuming one.
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid='public.motorist_case_tasks'::regclass and confrelid='public.motorist_cases'::regclass and contype='f' loop
    execute format('alter table public.motorist_case_tasks drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.motorist_case_tasks add constraint motorist_case_tasks_case_id_fkey foreign key(case_id) references public.motorist_cases(id) on delete set null;
create unique index if not exists motorist_case_tasks_id_org_unique on public.motorist_case_tasks(id, organization_id);
create unique index if not exists motorist_cases_id_org_unique on public.motorist_cases(id, organization_id);

create table public.motorist_task_case_links (
  organization_id uuid not null,
  task_id uuid not null,
  case_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(task_id,case_id),
  foreign key(task_id,organization_id) references public.motorist_case_tasks(id,organization_id) on delete cascade,
  foreign key(case_id,organization_id) references public.motorist_cases(id,organization_id) on delete cascade
);
create index motorist_task_case_links_case_idx on public.motorist_task_case_links(organization_id,case_id,task_id);
insert into public.motorist_task_case_links(organization_id,task_id,case_id)
  select t.organization_id,t.id,t.case_id from public.motorist_case_tasks t where t.case_id is not null;

-- No FK to the origin case or task: source identity survives deletion. Live task
-- links and messages have their own FKs; origins are retained cancellation history.
create table public.motorist_task_origins (
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  task_id uuid not null,
  source_type text not null check(source_type in ('callback','sms','location')),
  source_id uuid not null,
  origin_case_id uuid not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancellation_reason text,
  primary key(source_type,source_id)
);
create index motorist_task_origins_task_idx on public.motorist_task_origins(organization_id,task_id);
create index motorist_task_origins_case_idx on public.motorist_task_origins(organization_id,origin_case_id);
-- Only explicit relational proof is accepted. Old SMS task IDs could be
-- title-inferred; without an explicit marker they remain conservatively ambiguous.
-- Raw historical records are retained and never retroactively marked explicit.
insert into public.motorist_task_origins(organization_id,task_id,source_type,source_id,origin_case_id)
  select r.organization_id,t.id,'callback',r.id,r.case_id from public.motorist_callback_requests r
  join public.motorist_case_tasks t on r.metadata->>'task_id'=t.id::text and t.organization_id=r.organization_id and t.case_id=r.case_id;
insert into public.motorist_task_origins(organization_id,task_id,source_type,source_id,origin_case_id)
  select s.organization_id,t.id,'sms',s.id,s.case_id from public.motorist_sms_messages s
  join public.motorist_case_tasks t on s.raw_payload->>'task_id'=t.id::text and t.organization_id=s.organization_id and t.case_id=s.case_id
  where s.direction='outbound' and s.raw_payload->>'source'='sms_composer' and s.raw_payload->>'task_association'='explicit';
insert into public.motorist_task_origins(organization_id,task_id,source_type,source_id,origin_case_id)
  select l.organization_id,t.id,'location',l.id,l.case_id from public.motorist_location_share_links l
  join public.motorist_case_tasks t on l.metadata->>'task_id'=t.id::text and t.organization_id=l.organization_id and t.case_id=l.case_id
  where l.metadata->>'source'='sms_location_request' and l.metadata->>'task_association'='explicit';
update public.motorist_case_tasks t set origin_locked=true, provenance='proven'
  where exists(select 1 from public.motorist_task_origins o where o.task_id=t.id and o.organization_id=t.organization_id);
-- Suspected legacy system tasks without a provable mapping cannot silently be
-- retargeted. An operator may still edit ordinary fields and attach context.
update public.motorist_case_tasks set origin_locked=true,provenance='ambiguous'
  where provenance='manual' and (kind in ('callback','sms')
    or exists(select 1 from public.motorist_callback_requests r where r.metadata->>'task_id'=motorist_case_tasks.id::text)
    or exists(select 1 from public.motorist_sms_messages s where s.direction='outbound' and s.raw_payload->>'source'='sms_composer' and s.raw_payload->>'task_id'=motorist_case_tasks.id::text)
    or exists(select 1 from public.motorist_location_share_links l where l.metadata->>'source'='sms_location_request' and l.metadata->>'task_id'=motorist_case_tasks.id::text));

create unique index if not exists motorist_profiles_id_organization_unique on public.motorist_profiles(id,organization_id);
create table public.motorist_task_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  author_profile_id uuid not null,
  body text not null check(length(trim(body)) between 1 and 10000),
  client_message_id uuid not null,
  created_at timestamptz not null default now(),
  unique(task_id,author_profile_id,client_message_id),
  foreign key(author_profile_id,organization_id) references public.motorist_profiles(id,organization_id),
  foreign key(task_id,organization_id) references public.motorist_case_tasks(id,organization_id) on delete cascade
);
create index motorist_task_messages_page_idx on public.motorist_task_messages(organization_id,task_id,created_at desc,id desc);

create function app_private.motorist_task_org_member(p_org uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
    where p.organization_id=p_org and p.user_id=auth.uid() and p.active);
$$;
revoke all on function app_private.motorist_task_org_member(uuid) from public,anon;
grant execute on function app_private.motorist_task_org_member(uuid) to authenticated,service_role;
grant usage on schema app_private to authenticated;
-- Existing task SELECT policy may be broader; replace it with the actual actor
-- check. Legacy server writers retain DML during expand/bridge.
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='motorist_case_tasks' loop
    execute format('drop policy %I on public.motorist_case_tasks', p.policyname);
  end loop;
end $$;
alter table public.motorist_case_tasks enable row level security;
create policy motorist_case_tasks_team_read on public.motorist_case_tasks for select to authenticated using(app_private.motorist_task_org_member(organization_id));
revoke insert,update,delete on public.motorist_case_tasks from authenticated,anon;
grant select on public.motorist_case_tasks to authenticated;
alter table public.motorist_task_case_links enable row level security;
alter table public.motorist_task_origins enable row level security;
alter table public.motorist_task_messages enable row level security;
create policy motorist_task_links_team_read on public.motorist_task_case_links for select to authenticated using(app_private.motorist_task_org_member(organization_id));
create policy motorist_task_origins_team_read on public.motorist_task_origins for select to authenticated using(app_private.motorist_task_org_member(organization_id) and exists(select 1 from public.motorist_case_tasks t where t.id=task_id and t.organization_id=motorist_task_origins.organization_id));
create policy motorist_task_messages_team_read on public.motorist_task_messages for select to authenticated using(app_private.motorist_task_org_member(organization_id));
revoke all on public.motorist_task_case_links,public.motorist_task_origins,public.motorist_task_messages from public,anon,authenticated,service_role;
grant select on public.motorist_task_case_links,public.motorist_task_origins,public.motorist_task_messages to authenticated,service_role;

create function app_private.motorist_task_origin_immutable() returns trigger language plpgsql set search_path='' as $$ begin
  if row(new.organization_id,new.task_id,new.source_type,new.source_id,new.origin_case_id,new.created_at)
    is distinct from row(old.organization_id,old.task_id,old.source_type,old.source_id,old.origin_case_id,old.created_at) then
    raise exception 'Task origin identity is immutable' using errcode='42501';
  end if;
  return new;
end $$;
create trigger motorist_task_origin_immutable before update on public.motorist_task_origins for each row execute function app_private.motorist_task_origin_immutable();

create function app_private.motorist_task_bridge() returns trigger language plpgsql security definer set search_path='' as $$
declare v_internal boolean := coalesce(current_setting('app.task_workspace_write',true),'')='v1';
begin
  if not v_internal and exists(select 1 from public.motorist_task_workspace_settings where organization_id=new.organization_id and enabled) then
    raise exception 'Legacy task writer is disabled; use the task workspace transaction' using errcode='55000';
  end if;
  if new.case_id is not null and not exists(select 1 from public.motorist_cases c where c.id=new.case_id and c.organization_id=new.organization_id) then raise exception 'Task case organization mismatch' using errcode='22023'; end if;
  if new.assigned_to is not null and not exists(select 1 from public.motorist_profiles p where p.id=new.assigned_to and p.organization_id=new.organization_id and (p.active or (tg_op='UPDATE' and new.assigned_to=old.assigned_to))) then raise exception 'Invalid task assignee' using errcode='22023'; end if;
  if tg_op='INSERT' then
    if not v_internal and new.kind in ('callback','sms') then new.origin_locked:=true; new.provenance:='ambiguous'; end if;
    new.revision:=1;
  else
    if new.organization_id<>old.organization_id then raise exception 'Task organization is immutable' using errcode='42501'; end if;
    if (new.origin_locked is distinct from old.origin_locked or new.provenance is distinct from old.provenance) and not v_internal then raise exception 'Task provenance is immutable' using errcode='42501'; end if;
    if new.case_id is distinct from old.case_id and not v_internal and (coalesce(current_setting('app.task_case_delete',true),'') is distinct from old.case_id::text) then raise exception 'Use task link transaction to change the origin' using errcode='42501'; end if;
    new.revision:=old.revision+1;
    new.updated_at:=clock_timestamp();
  end if;
  return new;
end $$;
create trigger motorist_task_bridge_before before insert or update on public.motorist_case_tasks for each row execute function app_private.motorist_task_bridge();
create function app_private.motorist_task_bridge_insert() returns trigger language plpgsql security definer set search_path='' as $$ begin
  if new.case_id is not null then insert into public.motorist_task_case_links(organization_id,task_id,case_id) values(new.organization_id,new.id,new.case_id) on conflict do nothing; end if;
  return null;
end $$;
create trigger motorist_task_bridge_insert after insert on public.motorist_case_tasks for each row execute function app_private.motorist_task_bridge_insert();
create function app_private.motorist_task_link_removed() returns trigger language plpgsql security definer set search_path='' as $$ declare v_previous text; begin
  v_previous:=current_setting('app.task_workspace_write',true);
  perform set_config('app.task_workspace_write','v1',true);
  update public.motorist_case_tasks set updated_at=clock_timestamp() where id=old.task_id and organization_id=old.organization_id;
  perform set_config('app.task_workspace_write',coalesce(v_previous,''),true);
  return null;
end $$;
create trigger motorist_task_link_removed after delete on public.motorist_task_case_links for each row execute function app_private.motorist_task_link_removed();

-- Proven source evidence is written only by server/service or validated definer
-- workflows. Historical organization-wide RLS policies are not write authority.
revoke insert,update,delete on public.motorist_sms_messages,public.motorist_location_share_links,
  public.motorist_location_submissions,public.motorist_callback_requests from anon,authenticated;
-- An invoker trigger also covers inherited column grants or a later accidental
-- table grant. Security-definer callback RPCs and service-role providers retain
-- their existing validated paths; client-set transaction flags confer no trust.
create function app_private.motorist_guard_task_source_write() returns trigger language plpgsql set search_path='' as $$ begin
  if current_user<>'service_role' and current_user is distinct from (select pg_catalog.pg_get_userbyid(p.proowner) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname='motorist_guard_task_source_write' and p.pronargs=0) then
    raise exception 'Task source evidence is server managed' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function app_private.motorist_guard_task_source_write() from public,anon,authenticated,service_role;
create trigger motorist_guard_task_source_write before insert or update or delete on public.motorist_sms_messages for each row execute function app_private.motorist_guard_task_source_write();
create trigger motorist_guard_task_source_write before insert or update or delete on public.motorist_location_share_links for each row execute function app_private.motorist_guard_task_source_write();
create trigger motorist_guard_task_source_write before insert or update or delete on public.motorist_location_submissions for each row execute function app_private.motorist_guard_task_source_write();
create trigger motorist_guard_task_source_write before insert or update or delete on public.motorist_callback_requests for each row execute function app_private.motorist_guard_task_source_write();

-- Capture stable mappings that appear after legacy task insertion. For callbacks
-- the request metadata is written after task insertion in the same transaction.
create function app_private.motorist_task_capture_origin() returns trigger language plpgsql security definer set search_path='' as $$
declare v_task_id text; v_old_task_id text; v_source text; v_task public.motorist_case_tasks; v_previous_context text;
 v_association text; v_old_association text; v_category text; v_old_category text; v_direction text; v_old_direction text;
begin
  -- Read identity and validate it BEFORE any source-category/direction return.
  if tg_table_name in ('motorist_callback_requests','motorist_location_share_links') then
    v_task_id:=new.metadata->>'task_id'; v_source:=case when tg_table_name='motorist_callback_requests' then 'callback' else 'location' end;
    v_association:=new.metadata->>'task_association'; v_category:=new.metadata->>'source';
    if tg_op='UPDATE' then v_old_task_id:=old.metadata->>'task_id'; v_old_association:=old.metadata->>'task_association'; v_old_category:=old.metadata->>'source'; end if;
  else
    v_source:='sms'; v_task_id:=new.raw_payload->>'task_id'; v_association:=new.raw_payload->>'task_association';
    v_category:=new.raw_payload->>'source'; v_direction:=new.direction;
    if tg_op='UPDATE' then v_old_task_id:=old.raw_payload->>'task_id'; v_old_association:=old.raw_payload->>'task_association'; v_old_category:=old.raw_payload->>'source'; v_old_direction:=old.direction; end if;
  end if;
  -- Neither historical unmarked rows nor existing non-workflow rows may enter
  -- the trusted category later. A new explicit choice creates a new source.
  if tg_op='UPDATE' and v_source in ('sms','location') and (v_task_id is not null or v_old_task_id is not null)
    and (v_association is distinct from v_old_association or v_task_id is distinct from v_old_task_id
      or v_category is distinct from v_old_category or v_direction is distinct from v_old_direction
      or new.organization_id is distinct from old.organization_id
      or (new.case_id is distinct from old.case_id and not (new.case_id is null and not exists(select 1 from public.motorist_cases where id=old.case_id))
        and coalesce(current_setting('app.task_case_delete',true),'') is distinct from old.case_id::text)) then
    raise exception 'SMS task association identity is immutable' using errcode='42501';
  end if;
  if (v_source='location' and v_category is distinct from 'sms_location_request')
    or (v_source='sms' and (v_direction is distinct from 'outbound' or v_category is distinct from 'sms_composer')) then
    if exists(select 1 from public.motorist_task_origins where source_type=v_source and source_id=new.id) then raise exception 'Workflow task origin is immutable' using errcode='42501'; end if;
    return null;
  end if;
  if tg_op='UPDATE' and exists(select 1 from public.motorist_task_origins where source_type=v_source and source_id=new.id) then
    if v_task_id is distinct from v_old_task_id or new.organization_id is distinct from old.organization_id
      or (new.case_id is distinct from old.case_id and not (new.case_id is null and not exists(select 1 from public.motorist_cases where id=old.case_id)) and (coalesce(current_setting('app.task_case_delete',true),'') is distinct from old.case_id::text)) then
      raise exception 'Workflow task origin is immutable' using errcode='42501';
    end if;
    return null;
  end if;
  if v_task_id is null then return null; end if;
  if v_source in ('sms','location') and v_association is distinct from 'explicit' then
    select * into v_task from public.motorist_case_tasks t where t.id::text=v_task_id and t.organization_id=new.organization_id for update;
    if found and not v_task.origin_locked then
      v_previous_context:=current_setting('app.task_workspace_write',true);
      perform set_config('app.task_workspace_write','v1',true);
      update public.motorist_case_tasks set origin_locked=true,provenance='ambiguous' where id=v_task.id;
      perform set_config('app.task_workspace_write',coalesce(v_previous_context,''),true);
    end if;
    return null;
  end if;
  select * into v_task from public.motorist_case_tasks t where t.id::text=v_task_id and t.organization_id=new.organization_id and t.case_id=new.case_id for update;
  if not found then
    -- A source claims this task without matching its origin: retain the raw
    -- historical source but prevent silently retargeting the ambiguous task.
    select * into v_task from public.motorist_case_tasks t where t.id::text=v_task_id and t.organization_id=new.organization_id for update;
    if found and not v_task.origin_locked then
      v_previous_context:=current_setting('app.task_workspace_write',true);
      perform set_config('app.task_workspace_write','v1',true);
      update public.motorist_case_tasks set origin_locked=true,provenance='ambiguous' where id=v_task.id;
      perform set_config('app.task_workspace_write',coalesce(v_previous_context,''),true);
    end if;
    return null;
  end if;
  insert into public.motorist_task_origins(organization_id,task_id,source_type,source_id,origin_case_id)
    values(new.organization_id,v_task.id,v_source,new.id,new.case_id) on conflict do nothing;
  v_previous_context:=current_setting('app.task_workspace_write',true);
  perform set_config('app.task_workspace_write','v1',true);
  update public.motorist_case_tasks set origin_locked=true,provenance='proven' where id=v_task.id;
  perform set_config('app.task_workspace_write',coalesce(v_previous_context,''),true);
  return null;
end $$;
create trigger motorist_callback_task_origin after insert or update on public.motorist_callback_requests for each row execute function app_private.motorist_task_capture_origin();
create trigger motorist_location_task_origin after insert or update on public.motorist_location_share_links for each row execute function app_private.motorist_task_capture_origin();
create trigger motorist_sms_task_origin after insert or update on public.motorist_sms_messages for each row execute function app_private.motorist_task_capture_origin();

create function app_private.motorist_cancel_task_origins(p_org uuid,p_task uuid,p_case uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$ begin
  update public.motorist_callback_requests r set status='cancelled',resolved_at=clock_timestamp(),metadata=r.metadata||jsonb_build_object('task_origin_cancelled',p_reason)
    where r.organization_id=p_org and r.status in ('open','scheduled') and exists(select 1 from public.motorist_task_origins o where o.organization_id=p_org and o.source_type='callback' and o.source_id=r.id and (p_task is null or o.task_id=p_task) and (p_case is null or o.origin_case_id=p_case));
  -- A delivered SMS is historical fact; only pending outbox obligations are cancelled.
  update public.motorist_sms_messages s set status='failed',status_detail='cancelled_task_origin',next_attempt_at=null,error='Source task or case removed'
    where s.organization_id=p_org and s.status='queued' and exists(select 1 from public.motorist_task_origins o where o.organization_id=p_org and o.source_type='sms' and o.source_id=s.id and (p_task is null or o.task_id=p_task) and (p_case is null or o.origin_case_id=p_case));
  update public.motorist_location_share_links l set status='revoked',revoked_at=clock_timestamp() where l.organization_id=p_org and l.status='active' and exists(select 1 from public.motorist_task_origins o where o.organization_id=p_org and o.source_type='location' and o.source_id=l.id and (p_task is null or o.task_id=p_task) and (p_case is null or o.origin_case_id=p_case));
  update public.motorist_task_origins set cancelled_at=coalesce(cancelled_at,clock_timestamp()),cancellation_reason=coalesce(cancellation_reason,p_reason)
    where organization_id=p_org and (p_task is null or task_id=p_task) and (p_case is null or origin_case_id=p_case);
end $$;
create function app_private.motorist_task_case_deleting() returns trigger language plpgsql security definer set search_path='' as $$ declare v_previous text; begin
  v_previous:=current_setting('app.task_workspace_write',true);
  perform set_config('app.task_workspace_write','v1',true);
  perform set_config('app.task_case_delete',old.id::text,true);
  perform app_private.motorist_cancel_task_origins(old.organization_id,null,old.id,'origin_case_deleted');
  update public.motorist_case_tasks set case_id=null where organization_id=old.organization_id and case_id=old.id;
  perform set_config('app.task_workspace_write',coalesce(v_previous,''),true);
  return old;
end $$;
create trigger motorist_task_case_deleting before delete on public.motorist_cases for each row execute function app_private.motorist_task_case_deleting();
create function app_private.motorist_task_deleting() returns trigger language plpgsql security definer set search_path='' as $$ begin
  -- Once activated, legacy DELETE itself is rejected. The deployment gate must
  -- also retire old workflows BEFORE preliminary reminder/notification writes.
  if exists(select 1 from public.motorist_task_workspace_settings where organization_id=old.organization_id and enabled)
    and coalesce(current_setting('app.task_workspace_write',true),'')<>'v1' then raise exception 'Use task deletion transaction' using errcode='55000'; end if;
  perform app_private.motorist_cancel_task_origins(old.organization_id,old.id,null,'task_deleted');
  return old;
end $$;
create trigger motorist_task_deleting before delete on public.motorist_case_tasks for each row execute function app_private.motorist_task_deleting();

create function app_private.motorist_task_dto(p_task public.motorist_case_tasks) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'id',p_task.id,'caseId',coalesce(p_task.case_id::text,''),'title',p_task.title,'assignedTo',coalesce(p_task.assigned_to::text,'unassigned'),
  'dueAt',coalesce(p_task.due_at::text,''),'status',p_task.status,'priority',p_task.priority,'kind',p_task.kind,
  'createdBy',p_task.created_by,'completedBy',p_task.completed_by,'completedAt',p_task.completed_at,
  'reminderAt',p_task.reminder_at,
  'reminderChannels',coalesce((select to_jsonb(r)->'channels' from public.motorist_task_reminders r where r.task_id=p_task.id and r.organization_id=p_task.organization_id order by to_jsonb(r)->>'updated_at' desc nulls last,r.id desc limit 1),'["in_app"]'::jsonb),
  'revision',p_task.revision,'originLocked',p_task.origin_locked,'provenance',p_task.provenance,'createdAt',p_task.created_at,'updatedAt',p_task.updated_at,
  'caseIds',coalesce((select jsonb_agg(l.case_id order by l.created_at,l.case_id) from public.motorist_task_case_links l where l.task_id=p_task.id and l.organization_id=p_task.organization_id),'[]'::jsonb),
  'caseLinks',coalesce((select jsonb_agg(jsonb_build_object('caseId',c.id,'caseNumber',c.case_number,'status',c.status) order by l.created_at,c.id) from public.motorist_task_case_links l join public.motorist_cases c on c.id=l.case_id and c.organization_id=l.organization_id where l.task_id=p_task.id and l.organization_id=p_task.organization_id),'[]'::jsonb),
  'origins',coalesce((select jsonb_agg(jsonb_build_object('sourceType',o.source_type,'sourceId',o.source_id,'originCaseId',o.origin_case_id,'cancelledAt',o.cancelled_at) order by o.created_at,o.source_id) from public.motorist_task_origins o where o.task_id=p_task.id and o.organization_id=p_task.organization_id),'[]'::jsonb)
 );
$$;
create function app_private.motorist_task_message_dto(p_message public.motorist_task_messages) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p_message.id,'taskId',p_message.task_id,'authorProfileId',p_message.author_profile_id,
   'authorName',coalesce((select display_name from public.motorist_profiles where id=p_message.author_profile_id),'Kolega'),
   'body',p_message.body,'createdAt',p_message.created_at,'clientMessageId',p_message.client_message_id);
$$;

create function public.motorist_task_workspace(
  p_organization_id uuid,p_actor_profile_id uuid,p_action text,p_task_id uuid default null,p_input jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_task public.motorist_case_tasks; v_message public.motorist_task_messages;
 v_cases uuid[]; v_case uuid; v_expected integer; v_message_id uuid; v_body text;
 v_result jsonb; v_next jsonb; v_count integer; v_before_at timestamptz; v_before_id uuid;
 v_previous_context text; v_previous_channels text;
begin
 if auth.uid() is null or not exists(select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
   where p.id=p_actor_profile_id and p.organization_id=p_organization_id and p.user_id=auth.uid() and p.active) then raise exception 'Task access denied' using errcode='42501'; end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' then raise exception 'Invalid task input' using errcode='22023'; end if;
 if p_action not in ('list','get','create','update','link','unlink','delete','messages','send_message') then raise exception 'Invalid task operation' using errcode='22023'; end if;
 -- Reads support compatible rollout; 0..N writes and chat stay off until the
 -- deployment inventory proves every allowed writer uses compatible workflows.
 if p_action not in ('list','get') and not exists(select 1 from public.motorist_task_workspace_settings s where s.organization_id=p_organization_id and s.enabled and s.writer_inventory_verified_at is not null and coalesce(length(trim(s.writer_inventory_note)),0)>0) then
   raise exception 'Task workspace activation required' using errcode='55000';
 end if;
 if p_action='list' then
   select coalesce(jsonb_agg(app_private.motorist_task_dto(t) order by t.created_at desc,t.id),'[]'::jsonb) into v_result from public.motorist_case_tasks t where t.organization_id=p_organization_id;
   return v_result;
 end if;
 if p_action='delete' then
   -- Callback resolution locks its source request before the task. Full task
   -- deletion takes the same order so cancellation cannot deadlock fulfillment.
   perform 1 from public.motorist_callback_requests r join public.motorist_task_origins o on o.source_type='callback' and o.source_id=r.id and o.organization_id=r.organization_id
     where o.organization_id=p_organization_id and o.task_id=p_task_id order by r.id for update of r;
 end if;
 if p_action<>'create' then
   select * into v_task from public.motorist_case_tasks where id=p_task_id and organization_id=p_organization_id for update;
   if not found then raise exception 'Task unavailable' using errcode='P0002'; end if;
   if p_action='get' then return app_private.motorist_task_dto(v_task); end if;
 end if;
 if p_action='messages' then
   if p_input ? 'beforeCreatedAt' or p_input ? 'beforeId' then
     v_before_at:=(p_input->>'beforeCreatedAt')::timestamptz; v_before_id:=(p_input->>'beforeId')::uuid;
     if v_before_at is null or v_before_id is null then raise exception 'Invalid message cursor' using errcode='22023'; end if;
   end if;
   select count(*) into v_count from (select 1 from public.motorist_task_messages m where m.task_id=v_task.id and m.organization_id=p_organization_id and (v_before_at is null or (m.created_at,m.id)<(v_before_at,v_before_id)) order by m.created_at desc,m.id desc limit 51) page;
   select coalesce(jsonb_agg(app_private.motorist_task_message_dto(page) order by page.created_at,page.id),'[]'::jsonb) into v_result from (select m.* from public.motorist_task_messages m where m.task_id=v_task.id and m.organization_id=p_organization_id and (v_before_at is null or (m.created_at,m.id)<(v_before_at,v_before_id)) order by m.created_at desc,m.id desc limit 50) page;
   if v_count>50 then v_next:=jsonb_build_object('createdAt',v_result->0->>'createdAt','id',v_result->0->>'id'); end if;
   return jsonb_build_object('messages',v_result,'nextCursor',v_next);
 elsif p_action='send_message' then
   v_body:=trim(p_input->>'body'); v_message_id:=(p_input->>'clientMessageId')::uuid;
   if jsonb_typeof(p_input->'body') is distinct from 'string' or v_body is null or length(v_body) not between 1 and 10000 or v_message_id is null then raise exception 'Invalid message' using errcode='22023'; end if;
   select * into v_message from public.motorist_task_messages where task_id=v_task.id and author_profile_id=p_actor_profile_id and client_message_id=v_message_id;
   if found then
     if v_message.body<>v_body then raise exception 'Message ID reused with different text' using errcode='40001'; end if;
     return app_private.motorist_task_message_dto(v_message);
   end if;
   insert into public.motorist_task_messages(organization_id,task_id,author_profile_id,body,client_message_id) values(p_organization_id,v_task.id,p_actor_profile_id,v_body,v_message_id) returning * into v_message;
   if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then perform realtime.send('{}'::jsonb,'invalidate','tasks:'||p_organization_id::text,true); end if;
   return app_private.motorist_task_message_dto(v_message);
 end if;
 if p_action<>'create' then
   v_expected:=(p_input->>'expectedRevision')::integer;
   if v_expected is null or v_expected<>v_task.revision then raise exception 'Task revision conflict' using errcode='40001'; end if;
 end if;
 -- All mutable fields are validated before the first write, including channels
 -- consumed by the notification migration's transactional lifecycle trigger.
 if p_action in ('create','update') then
   if p_action='create' or p_input ? 'title' then
     if jsonb_typeof(p_input->'title') is distinct from 'string' or length(trim(p_input->>'title')) not between 1 and 500 then raise exception 'Invalid task title' using errcode='22023'; end if;
   end if;
   if p_input ? 'priority' and coalesce(p_input->>'priority','') not in ('urgent','high','normal','low') then raise exception 'Invalid priority' using errcode='22023'; end if;
   if p_input ? 'kind' and coalesce(p_input->>'kind','') not in ('callback','sms','dispatch','documents','billing','handover','other') then raise exception 'Invalid kind' using errcode='22023'; end if;
   if p_input ? 'status' and coalesce(p_input->>'status','') not in ('open','done','overdue') then raise exception 'Invalid status' using errcode='22023'; end if;
   if p_input ? 'assignedTo' and p_input->>'assignedTo' is not null and not exists(select 1 from public.motorist_profiles p where p.id=(p_input->>'assignedTo')::uuid and p.organization_id=p_organization_id and p.active) then raise exception 'Invalid assignee' using errcode='22023'; end if;
   if p_action='create' or p_input ? 'caseIds' then
     if p_input ? 'caseIds' and jsonb_typeof(p_input->'caseIds')<>'array' then raise exception 'Invalid links' using errcode='22023'; end if;
     select coalesce(array_agg(value::uuid),'{}'::uuid[]) into v_cases from jsonb_array_elements_text(coalesce(p_input->'caseIds','[]'::jsonb));
     if cardinality(v_cases)>100 or cardinality(v_cases)<>(select count(distinct c) from unnest(v_cases) c) or exists(select 1 from unnest(v_cases) c where not exists(select 1 from public.motorist_cases where id=c and organization_id=p_organization_id)) then raise exception 'Invalid task links' using errcode='22023'; end if;
     if p_action='update' and v_task.origin_locked and v_task.case_id is not null and not v_task.case_id=any(v_cases) then raise exception 'System origin cannot be unlinked' using errcode='22023'; end if;
   end if;
 end if;
 if p_action in ('link','unlink') then
   v_case:=(p_input->>'caseId')::uuid;
   if v_case is null or not exists(select 1 from public.motorist_cases where id=v_case and organization_id=p_organization_id) then raise exception 'Invalid task case' using errcode='22023'; end if;
   if p_action='unlink' and v_task.origin_locked and v_task.case_id=v_case then raise exception 'System origin cannot be unlinked' using errcode='22023'; end if;
   if p_action='link' and (select count(*) from public.motorist_task_case_links where task_id=v_task.id)>=100 and not exists(select 1 from public.motorist_task_case_links where task_id=v_task.id and case_id=v_case) then raise exception 'Too many task links' using errcode='22023'; end if;
 end if;
 if p_input ? 'note' and (jsonb_typeof(p_input->'note') is distinct from 'string' or length(p_input->>'note')>10000) then raise exception 'Invalid task change note' using errcode='22023'; end if;
 if p_input ? 'reminderChannels' then
   if jsonb_typeof(p_input->'reminderChannels')<>'array' or jsonb_array_length(p_input->'reminderChannels') not between 1 and 2 or exists(select 1 from jsonb_array_elements_text(p_input->'reminderChannels') channel where channel is null or channel not in ('in_app','email')) then raise exception 'Invalid reminder channels' using errcode='22023'; end if;
 end if;
 v_previous_context:=current_setting('app.task_workspace_write',true); v_previous_channels:=current_setting('app.task_reminder_channels',true);
 perform set_config('app.task_workspace_write','v1',true);
 if p_input ? 'reminderChannels' then perform set_config('app.task_reminder_channels',(p_input->'reminderChannels')::text,true); end if;
 if p_action='create' then
   insert into public.motorist_case_tasks(organization_id,case_id,title,assigned_to,due_at,reminder_at,status,priority,kind,created_by,completed_by,completed_at)
     values(p_organization_id,v_cases[1],trim(p_input->>'title'),(p_input->>'assignedTo')::uuid,(p_input->>'dueAt')::timestamptz,(p_input->>'reminderAt')::timestamptz,coalesce(p_input->>'status','open'),coalesce(p_input->>'priority','normal'),coalesce(p_input->>'kind','other'),p_actor_profile_id,
       case when p_input->>'status'='done' then p_actor_profile_id else null end,case when p_input->>'status'='done' then clock_timestamp() else null end) returning * into v_task;
   insert into public.motorist_task_case_links(organization_id,task_id,case_id) select p_organization_id,v_task.id,c from unnest(v_cases) c on conflict do nothing;
 elsif p_action='update' then
   update public.motorist_case_tasks set
     title=case when p_input ? 'title' then trim(p_input->>'title') else title end,
     assigned_to=case when p_input ? 'assignedTo' then (p_input->>'assignedTo')::uuid else assigned_to end,
     due_at=case when p_input ? 'dueAt' then (p_input->>'dueAt')::timestamptz else due_at end,
     reminder_at=case when p_input ? 'reminderAt' then (p_input->>'reminderAt')::timestamptz else reminder_at end,
     status=coalesce(p_input->>'status',status),priority=coalesce(p_input->>'priority',priority),kind=coalesce(p_input->>'kind',kind),
     completed_at=case when p_input ? 'status' and p_input->>'status'='done' then coalesce(completed_at,clock_timestamp()) when p_input ? 'status' then null else completed_at end,
     completed_by=case when p_input ? 'status' and p_input->>'status'='done' then coalesce(completed_by,p_actor_profile_id) when p_input ? 'status' then null else completed_by end,
     case_id=case when v_cases is not null and case_id is not null and not case_id=any(v_cases) then null else case_id end
     where id=v_task.id;
   if v_cases is not null then
     delete from public.motorist_task_case_links where task_id=v_task.id and not case_id=any(v_cases);
     insert into public.motorist_task_case_links(organization_id,task_id,case_id) select p_organization_id,v_task.id,c from unnest(v_cases) c on conflict do nothing;
   end if;
 elsif p_action='link' then
   insert into public.motorist_task_case_links(organization_id,task_id,case_id) values(p_organization_id,v_task.id,v_case) on conflict do nothing;
   update public.motorist_case_tasks set updated_at=clock_timestamp() where id=v_task.id;
 elsif p_action='unlink' then
   if v_task.case_id=v_case then update public.motorist_case_tasks set case_id=null where id=v_task.id; end if;
   delete from public.motorist_task_case_links where task_id=v_task.id and case_id=v_case;
 elsif p_action='delete' then
   delete from public.motorist_case_tasks where id=v_task.id;
 end if;
 if p_action<>'delete' then select * into v_task from public.motorist_case_tasks where id=v_task.id; end if;
 insert into public.motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
   values(p_organization_id,p_actor_profile_id,'task.'||p_action,'motorist_case_tasks',v_task.id,'dispatch_console',jsonb_build_object('revision',v_task.revision,'note',nullif(trim(p_input->>'note'),'')));
 if p_action='delete' then v_result:=jsonb_build_object('deleted',true);
 else select * into v_task from public.motorist_case_tasks where id=v_task.id; v_result:=app_private.motorist_task_dto(v_task); end if;
 perform set_config('app.task_workspace_write',coalesce(v_previous_context,''),true);
 perform set_config('app.task_reminder_channels',coalesce(v_previous_channels,''),true);
 if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then perform realtime.send('{}'::jsonb,'invalidate','tasks:'||p_organization_id::text,true); end if;
 return v_result;
end $$;
revoke all on function public.motorist_task_workspace(uuid,uuid,text,uuid,jsonb) from public,anon,service_role;
grant execute on function public.motorist_task_workspace(uuid,uuid,text,uuid,jsonb) to authenticated;

-- Keep every definer helper inaccessible as a direct RPC/SQL entrypoint.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and (p.proname like 'motorist_task_%' or p.proname='motorist_cancel_task_origins') and p.proname<>'motorist_task_org_member' loop
   execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
 if to_regclass('realtime.messages') is not null then execute $policy$
   create policy motorist_tasks_broadcast_read on realtime.messages for select to authenticated using(extension='broadcast' and exists(
     select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
     where p.user_id=auth.uid() and p.active and realtime.topic()='tasks:'||p.organization_id::text))
 $policy$; end if;
end $$;

-- Trusted system completion accepts only durable source evidence. It never
-- accepts an arbitrary task ID, editable title/kind, or context case to complete.
create function public.motorist_complete_task_source_v1(p_organization_id uuid,p_source_type text,p_source_id uuid,p_actor_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_task public.motorist_case_tasks; v_origin public.motorist_task_origins; v_previous text;
begin
 if not exists(select 1 from public.motorist_organizations where id=p_organization_id and active) then raise exception 'Task source organization unavailable' using errcode='42501'; end if;
 if p_actor_id is not null and not exists(select 1 from public.motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active) then raise exception 'Invalid source actor' using errcode='42501'; end if;
 if p_source_type='sms' then
   select o.* into v_origin from public.motorist_task_origins o join public.motorist_sms_messages s on s.id=o.source_id and s.organization_id=o.organization_id
     where o.organization_id=p_organization_id and o.source_type='sms' and s.id=p_source_id and o.cancelled_at is null
       and s.template_key='eta_update' and s.direction='outbound' and s.status in ('queued','sent','delivered') and s.provider_message_id is not null
       and s.raw_payload->>'source'='sms_composer' and s.raw_payload->>'task_association'='explicit' and s.raw_payload->>'task_id'=o.task_id::text and s.case_id=o.origin_case_id;
 elsif p_source_type='location' then
   select o.* into v_origin from public.motorist_task_origins o join public.motorist_location_share_links l on l.id=o.source_id and l.organization_id=o.organization_id
     join public.motorist_location_submissions s on s.link_id=l.id and s.organization_id=l.organization_id and s.case_id=l.case_id
     where o.organization_id=p_organization_id and o.source_type='location' and s.id=p_source_id and o.cancelled_at is null
       and s.accepted and l.status='used' and l.metadata->>'task_association'='explicit' and s.submitted_at<=l.expires_at and l.case_id=o.origin_case_id and l.metadata->>'task_id'=o.task_id::text;
 else raise exception 'Unknown task source' using errcode='22023'; end if;
 if not found then return jsonb_build_object('completed',false); end if;
 select * into v_task from public.motorist_case_tasks where id=v_origin.task_id and organization_id=p_organization_id and case_id=v_origin.origin_case_id for update;
 if not found then return jsonb_build_object('completed',false); end if;
 if v_task.status='done' then return jsonb_build_object('completed',true,'taskId',v_task.id); end if;
 v_previous:=current_setting('app.task_workspace_write',true); perform set_config('app.task_workspace_write','v1',true);
 update public.motorist_case_tasks set status='done',completed_at=clock_timestamp(),completed_by=p_actor_id where id=v_task.id;
 perform set_config('app.task_workspace_write',coalesce(v_previous,''),true);
 insert into public.motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
 values(p_organization_id,p_actor_id,'task.source_completed','motorist_case_tasks',v_task.id,'system',jsonb_build_object('sourceType',p_source_type,'sourceId',p_source_id));
 if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then perform realtime.send('{}'::jsonb,'invalidate','tasks:'||p_organization_id::text,true); end if;
 return jsonb_build_object('completed',true,'taskId',v_task.id);
end $$;
revoke all on function public.motorist_complete_task_source_v1(uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.motorist_complete_task_source_v1(uuid,text,uuid,uuid) to service_role;

-- Scheduling wrappers use the persisted callback request as the only task
-- identity. Existing request metadata prevents recreation after task deletion.
create function app_private.motorist_ensure_callback_workspace_task(p_org uuid,p_request uuid,p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.motorist_callback_requests; v_task_id uuid; v_previous text;
begin
 select * into r from public.motorist_callback_requests where id=p_request and organization_id=p_org for update;
 if not found then raise exception 'Callback unavailable' using errcode='P0002'; end if;
 if r.case_id is null or r.status not in ('open','scheduled') or r.metadata->>'task_id' is not null then return to_jsonb(r); end if;
 if p_actor is not null and not exists(select 1 from public.motorist_profiles where id=p_actor and organization_id=p_org and active) then raise exception 'Invalid callback actor' using errcode='42501'; end if;
 v_previous:=current_setting('app.task_workspace_write',true); perform set_config('app.task_workspace_write','v1',true);
 insert into public.motorist_case_tasks(organization_id,case_id,title,assigned_to,due_at,status,priority,kind,created_by)
 values(p_org,r.case_id,'Zavolať späť: '||r.caller_number,p_actor,r.due_at,'open','high','callback',p_actor) returning id into v_task_id;
 update public.motorist_callback_requests set metadata=metadata||jsonb_build_object('task_id',v_task_id) where id=r.id returning * into r;
 perform set_config('app.task_workspace_write',coalesce(v_previous,''),true);
 return to_jsonb(r);
end $$;
revoke all on function app_private.motorist_ensure_callback_workspace_task(uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- Preserve the exact installed callback implementations (including durable
-- contact/claim checks), behind inaccessible private copies. Only these fixed
-- workflows receive the task write context; arbitrary service-role DML does not.
do $$ declare v_name text; v_signature text; v_definition text; begin
 for v_name,v_signature in select * from (values
   ('motorist_resolve_callback_v1','public.motorist_resolve_callback_v1(uuid,uuid,uuid,text,jsonb,text)'),
   ('motorist_create_callback_obligation_v1','public.motorist_create_callback_obligation_v1(uuid,uuid,jsonb,timestamptz)'),
   ('motorist_schedule_callback_v1','public.motorist_schedule_callback_v1(uuid,uuid,uuid,uuid,timestamptz)')
 ) definitions(name,signature) loop
   if to_regprocedure(v_signature) is null then continue; end if;
   v_definition:=pg_get_functiondef(to_regprocedure(v_signature));
   v_definition:=replace(v_definition,'FUNCTION public.'||v_name||'(','FUNCTION app_private.'||v_name||'_task_base(');
   if v_name='motorist_resolve_callback_v1' then
     -- Completion follows immutable proven callback origin, independent of kind.
     if position($old$and kind='callback' and status='open'$old$ in v_definition)=0 then raise exception 'Unexpected callback resolver version; review task compatibility before applying'; end if;
     v_definition:=replace(v_definition,$old$and kind='callback' and status='open'$old$, $new$and status='open' and exists(select 1 from public.motorist_task_origins o where o.task_id=motorist_case_tasks.id and o.organization_id=p_organization_id and o.source_type='callback' and o.source_id=r.id and o.cancelled_at is null)$new$);
   end if;
   execute v_definition;
   execute format('revoke all on function %s from public,anon,authenticated,service_role',replace(v_signature,'public.'||v_name,'app_private.'||v_name||'_task_base'));
 end loop;
 if to_regprocedure('app_private.motorist_resolve_callback_v1_task_base(uuid,uuid,uuid,text,jsonb,text)') is not null then
   execute $wrapper$ create or replace function public.motorist_resolve_callback_v1(p_organization_id uuid,p_request_id uuid,p_actor_id uuid,p_status text,p_proof jsonb default null,p_notes text default null)
   returns jsonb language plpgsql security definer set search_path='' as $body$
   declare previous_context text; result jsonb; begin
     previous_context:=current_setting('app.task_workspace_write',true); perform set_config('app.task_workspace_write','v1',true);
     result:=app_private.motorist_resolve_callback_v1_task_base(p_organization_id,p_request_id,p_actor_id,p_status,p_proof,p_notes);
     perform set_config('app.task_workspace_write',coalesce(previous_context,''),true); return result;
   end $body$ $wrapper$;
 end if;
 if to_regprocedure('app_private.motorist_create_callback_obligation_v1_task_base(uuid,uuid,jsonb,timestamptz)') is not null then
   execute $wrapper$ create or replace function public.motorist_create_callback_obligation_v1(p_organization_id uuid,p_session_id uuid,p_plan jsonb,p_now timestamptz)
   returns jsonb language plpgsql security definer set search_path='' as $body$
   declare previous_context text; result jsonb; begin
     previous_context:=current_setting('app.task_workspace_write',true); perform set_config('app.task_workspace_write','v1',true);
     result:=app_private.motorist_create_callback_obligation_v1_task_base(p_organization_id,p_session_id,p_plan,p_now);
     perform set_config('app.task_workspace_write',coalesce(previous_context,''),true); return result;
   end $body$ $wrapper$;
 end if;
 if to_regprocedure('app_private.motorist_schedule_callback_v1_task_base(uuid,uuid,uuid,uuid,timestamptz)') is not null then
   execute $wrapper$ create or replace function public.motorist_schedule_callback_v1(p_organization_id uuid,p_call_id uuid,p_actor_id uuid,p_action_id uuid,p_due_at timestamptz)
   returns jsonb language plpgsql security definer set search_path='' as $body$
   declare result jsonb; begin
     result:=app_private.motorist_schedule_callback_v1_task_base(p_organization_id,p_call_id,p_actor_id,p_action_id,p_due_at);
     if exists(select 1 from public.motorist_task_workspace_settings where organization_id=p_organization_id and enabled) then
       result:=app_private.motorist_ensure_callback_workspace_task(p_organization_id,(result->>'id')::uuid,p_actor_id);
     end if;
     return result;
   end $body$ $wrapper$;
 end if;
end $$;
