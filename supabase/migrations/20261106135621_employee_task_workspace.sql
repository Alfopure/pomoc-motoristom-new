-- One task store for office and field employees. No profile provisioning, data
-- backfill, rollout activation, scheduler or external delivery is performed.
begin;

alter table public.motorist_case_tasks
 add column assigned_user_id uuid,
 add column assigned_group_id uuid,
 add column created_by_user_id uuid,
 add column completed_by_user_id uuid,
 add column review_requested_by_user_id uuid,
 add column description text not null default '' check(length(description)<=10000),
 add constraint motorist_task_employee_group_fk foreign key(organization_id,assigned_group_id)
   references public.motorist_work_groups(organization_id,id);
-- Historical user IDs are audit identities, not authentication grants. Keeping
-- them independent of auth.users deletion preserves task/message history.
create index motorist_task_employee_assigned_idx on public.motorist_case_tasks(organization_id,assigned_user_id,updated_at desc,id desc) where assigned_user_id is not null;
create index motorist_task_employee_creator_idx on public.motorist_case_tasks(organization_id,created_by_user_id,updated_at desc,id desc) where created_by_user_id is not null;
create index motorist_task_employee_group_idx on public.motorist_case_tasks(organization_id,assigned_group_id,updated_at desc,id desc) where assigned_group_id is not null;

alter table public.motorist_case_tasks drop constraint motorist_task_review_request_check;
alter table public.motorist_case_tasks add constraint motorist_task_review_request_check check(
 workflow_state is distinct from 'in_review' or (reviewer_profile_id is not null
 and (review_requested_by is not null or review_requested_by_user_id is not null)
 and review_requested_at is not null and coalesce(length(trim(review_submission)),0)>0 and status<>'done'));

alter table public.motorist_task_messages alter column author_profile_id drop not null;
alter table public.motorist_task_messages add column author_user_id uuid;
alter table public.motorist_task_messages add constraint motorist_task_message_author_check check(author_profile_id is not null or author_user_id is not null);
create unique index motorist_task_message_user_command_idx on public.motorist_task_messages(task_id,author_user_id,client_message_id) where author_user_id is not null;

create table public.motorist_task_employee_commands(
 organization_id uuid not null references public.motorist_organizations(id),
 actor_user_id uuid not null,command_id uuid not null,task_id uuid not null,
 request jsonb not null,committed_revision integer not null check(committed_revision>0),
 created_at timestamptz not null default clock_timestamp(),
 -- Keep this tombstone after task deletion: an uncertain create retry must not
 -- turn the same command into a new task. Replay explicitly checks existence.
 primary key(organization_id,actor_user_id,command_id)
);
create table public.motorist_task_employee_events(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,task_id uuid not null,
 actor_user_id uuid not null,kind text not null check(kind in ('created','assigned','state')),
 body text not null check(length(body) between 1 and 10000),created_at timestamptz not null default clock_timestamp(),
 foreign key(task_id,organization_id) references public.motorist_case_tasks(id,organization_id) on delete cascade
);
create index motorist_task_employee_events_page_idx on public.motorist_task_employee_events(organization_id,task_id,created_at desc,id desc);
alter table public.motorist_task_employee_commands enable row level security;
alter table public.motorist_task_employee_events enable row level security;
revoke all on public.motorist_task_employee_commands,public.motorist_task_employee_events from public,anon,authenticated,service_role;

create function app_private.employee_task_people(org uuid,only_user uuid default null)
returns table(user_id uuid,profile_id uuid,member_id uuid,display_name text,office boolean,administrator boolean)
language sql stable security definer set search_path='' as $$
 select u.id,p.id,m.id,coalesce(p.display_name,m.display_name),p.id is not null,coalesce(p.role in ('manager','admin'),false)
 from auth.users u
 join public.motorist_organizations o on o.id=org and o.active
 left join lateral(select x.id,x.display_name,x.role from public.motorist_profiles x
   where x.organization_id=org and x.user_id=u.id and x.active and x.access_status='active'
   and coalesce(to_jsonb(x)->>'kind','human')='human' and x.role in ('dispatcher','senior_dispatcher','manager','admin') order by x.id limit 1) p on true
 left join lateral(select x.id,x.display_name from public.motorist_towing_memberships x
   where x.organization_id=org and x.auth_user_id=u.id and x.active
   and (x.office_profile_id is null or exists(select 1 from public.motorist_profiles op where op.id=x.office_profile_id
     and op.organization_id=org and op.user_id=u.id and op.active and op.access_status='active' and coalesce(to_jsonb(op)->>'kind','human')='human'))
   and not exists(select 1 from public.motorist_profiles ai where ai.organization_id=org and ai.user_id=u.id and to_jsonb(ai)->>'kind'='ai')
   order by x.id limit 1) m on true
 where (only_user is null or u.id=only_user) and u.deleted_at is null and (u.banned_until is null or u.banned_until<clock_timestamp()) and (p.id is not null or m.id is not null)
$$;

create function app_private.employee_task_person(org uuid,usr uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select case when usr is null then null else jsonb_build_object('userId',usr,'displayName',coalesce(
  (select p.display_name from public.motorist_profiles p where p.organization_id=org and p.user_id=usr order by p.active desc,p.id limit 1),
  (select m.display_name from public.motorist_towing_memberships m where m.organization_id=org and m.auth_user_id=usr order by m.active desc,m.id limit 1),'Bývalý kolega')) end
$$;
create function app_private.employee_task_lead(org uuid,usr uuid,grp uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select grp is not null and exists(select 1 from app_private.employee_task_people(org,usr) p
  join public.motorist_work_group_members gm on gm.organization_id=org and gm.member_id=p.member_id and gm.group_id=grp and gm.role='lead'
  join public.motorist_work_groups g on g.organization_id=org and g.id=gm.group_id and g.active where p.user_id=usr)
$$;
create function app_private.employee_task_group_available(org uuid,grp uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.motorist_work_groups g
  join public.motorist_work_group_members gm on gm.organization_id=g.organization_id and gm.group_id=g.id and gm.role='lead'
  join app_private.employee_task_people(org) p on p.member_id=gm.member_id
  where g.organization_id=org and g.id=grp and g.active)
$$;
create function app_private.employee_task_user(org uuid,profile uuid) returns uuid
language sql stable security definer set search_path='' as $$select user_id from public.motorist_profiles where id=profile and organization_id=org$$;
create function app_private.employee_task_assignee(t public.motorist_case_tasks) returns uuid
language sql stable security definer set search_path='' as $$select coalesce(t.assigned_user_id,app_private.employee_task_user(t.organization_id,t.assigned_to))$$;
create function app_private.employee_task_creator(t public.motorist_case_tasks) returns uuid
language sql stable security definer set search_path='' as $$select coalesce(t.created_by_user_id,app_private.employee_task_user(t.organization_id,t.created_by))$$;
create function app_private.employee_task_can_read(t public.motorist_case_tasks,usr uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from app_private.employee_task_people(t.organization_id,usr) p where p.user_id=usr and
  (p.office or app_private.employee_task_assignee(t)=usr or app_private.employee_task_creator(t)=usr
  or app_private.employee_task_user(t.organization_id,t.reviewer_profile_id)=usr
  or app_private.employee_task_lead(t.organization_id,usr,t.assigned_group_id)))
$$;
create function app_private.employee_task_permissions(t public.motorist_case_tasks,usr uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 with actor as(select *,app_private.employee_task_lead(t.organization_id,usr,t.assigned_group_id) as lead from app_private.employee_task_people(t.organization_id,usr) where user_id=usr),
 rights as(select *,case when t.status='done' then 'done' else coalesce(t.workflow_state,'todo') end stage,
  (app_private.employee_task_assignee(t)=usr or administrator) as works,
  -- An unclaimed branch queue belongs to its leads. Merely creating its task
  -- does not let an ordinary employee bypass that ownership by assigning self.
  -- Existing manager/admin oversight remains an explicit delegation override.
  (case when t.assigned_group_id is not null and app_private.employee_task_assignee(t) is null
   then lead or administrator
   else app_private.employee_task_assignee(t)=usr or app_private.employee_task_creator(t)=usr or lead or administrator end) as assigns from actor)
 select jsonb_build_object(
 'start',coalesce(works and stage='todo',false),
 'complete',coalesce(works and stage in ('todo','in_progress') and t.reviewer_profile_id is null,false),
 'reopen',coalesce(assigns and stage='done',false),
 'claim',coalesce(lead and app_private.employee_task_assignee(t) is null and stage in ('todo','in_progress'),false),
 'assign',coalesce(assigns and stage in ('todo','in_progress'),false),
 'comment',app_private.employee_task_can_read(t,usr),
 'submitReview',coalesce(works and stage in ('todo','in_progress'),false),
 'approve',coalesce(app_private.employee_task_user(t.organization_id,t.reviewer_profile_id)=usr and stage='in_review',false),
 'return',coalesce(app_private.employee_task_user(t.organization_id,t.reviewer_profile_id)=usr and stage='in_review',false)) from rights
$$;
create function app_private.employee_task_dto(t public.motorist_case_tasks,usr uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',t.id,'title',t.title,'description',t.description,
 'state',case when t.status='done' then 'done' else coalesce(t.workflow_state,'todo') end,'priority',t.priority,'dueAt',t.due_at,
 'revision',t.revision,'createdAt',t.created_at,'updatedAt',t.updated_at,
 'createdBy',app_private.employee_task_person(t.organization_id,app_private.employee_task_creator(t)),
 'assignee',app_private.employee_task_person(t.organization_id,app_private.employee_task_assignee(t)),
 'group',(select jsonb_build_object('id',g.id,'name',g.name) from public.motorist_work_groups g where g.organization_id=t.organization_id and g.id=t.assigned_group_id),
 'reviewer',app_private.employee_task_person(t.organization_id,app_private.employee_task_user(t.organization_id,t.reviewer_profile_id)),
 'reviewSubmission',t.review_submission,'reviewReturnReason',t.review_return_reason,
 'caseLinks',case when exists(select 1 from app_private.employee_task_people(t.organization_id,usr) p where p.user_id=usr and p.office) then
  coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'number',c.case_number) order by l.created_at,c.id)
   from public.motorist_task_case_links l join public.motorist_cases c on c.id=l.case_id and c.organization_id=l.organization_id
   where l.task_id=t.id and l.organization_id=t.organization_id),'[]') else '[]'::jsonb end,
 'permissions',app_private.employee_task_permissions(t,usr))
$$;

-- Additive compatibility fields let updated web readers label field/group
-- assignments correctly without inventing a dispatch profile ID in assignedTo.
alter function app_private.motorist_task_dto(public.motorist_case_tasks) rename to motorist_task_dto_before_employees;
create function app_private.motorist_task_dto(p_task public.motorist_case_tasks) returns jsonb
language sql stable security definer set search_path='' as $$
 select app_private.motorist_task_dto_before_employees(p_task)||jsonb_build_object(
  'assignedUserId',app_private.employee_task_assignee(p_task),
  'assignedUserName',app_private.employee_task_person(p_task.organization_id,app_private.employee_task_assignee(p_task))->>'displayName',
  'assignedGroupId',p_task.assigned_group_id,
  'assignedGroupName',(select g.name from public.motorist_work_groups g where g.organization_id=p_task.organization_id and g.id=p_task.assigned_group_id),
  'createdByUserId',app_private.employee_task_creator(p_task),'completedByUserId',p_task.completed_by_user_id)
$$;

-- Canonical identity bridge precedes review, assignment and reminder triggers.
create function app_private.employee_task_identity_bridge() returns trigger
language plpgsql security definer set search_path='' as $$
declare employee_write boolean:=coalesce(current_setting('app.employee_task_write',true),'')='v1';
begin
 if tg_op='INSERT' then
  if not employee_write then
   new.assigned_user_id:=app_private.employee_task_user(new.organization_id,new.assigned_to);
   new.created_by_user_id:=app_private.employee_task_user(new.organization_id,new.created_by);
   new.completed_by_user_id:=app_private.employee_task_user(new.organization_id,new.completed_by);
   new.review_requested_by_user_id:=app_private.employee_task_user(new.organization_id,new.review_requested_by);
   new.assigned_group_id:=null;
  end if;
 else
  if not employee_write then
   if new.assigned_to is distinct from old.assigned_to or current_setting('app.employee_task_legacy_unassign',true)=new.id::text then
    new.assigned_user_id:=app_private.employee_task_user(new.organization_id,new.assigned_to);new.assigned_group_id:=null;
   else new.assigned_user_id:=old.assigned_user_id;new.assigned_group_id:=old.assigned_group_id;end if;
   new.created_by_user_id:=coalesce(old.created_by_user_id,app_private.employee_task_user(new.organization_id,new.created_by));
   if new.completed_by is distinct from old.completed_by or new.status is distinct from old.status then new.completed_by_user_id:=app_private.employee_task_user(new.organization_id,new.completed_by);else new.completed_by_user_id:=old.completed_by_user_id;end if;
   if new.review_requested_by is distinct from old.review_requested_by then new.review_requested_by_user_id:=app_private.employee_task_user(new.organization_id,new.review_requested_by);else new.review_requested_by_user_id:=old.review_requested_by_user_id;end if;
   if new.description is distinct from old.description then raise exception 'Employee task details are server managed' using errcode='42501';end if;
  end if;
 end if;
 return new;
end $$;
create trigger motorist_task_000_employee_identity before insert or update on public.motorist_case_tasks for each row execute function app_private.employee_task_identity_bridge();

create function app_private.employee_task_message_identity() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.author_profile_id is not null then
  if not exists(select 1 from public.motorist_profiles p where p.id=new.author_profile_id and p.organization_id=new.organization_id) then raise exception 'Invalid message author' using errcode='22023';end if;
  new.author_user_id:=app_private.employee_task_user(new.organization_id,new.author_profile_id);
 elsif current_setting('app.employee_task_write',true) is distinct from 'v1' then raise exception 'Employee message author is server managed' using errcode='42501';end if;
 return new;
end $$;
create trigger motorist_task_message_employee_identity before insert on public.motorist_task_messages for each row execute function app_private.employee_task_message_identity();
create or replace function app_private.motorist_task_message_dto(p_message public.motorist_task_messages) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p_message.id,'taskId',p_message.task_id,
  'authorProfileId',coalesce(p_message.author_profile_id,p_message.author_user_id),
  'authorName',coalesce((select display_name from public.motorist_profiles where id=p_message.author_profile_id),app_private.employee_task_person(p_message.organization_id,p_message.author_user_id)->>'displayName','Kolega'),
  'body',p_message.body,'createdAt',p_message.created_at,'clientMessageId',p_message.client_message_id)
$$;

-- Retain exact office scheduling behavior, but a field/group target must never
-- be interpreted as an unassigned team-wide office reminder.
alter function app_private.motorist_schedule_task_generation(uuid,text[],uuid) rename to motorist_schedule_task_generation_before_employees;
create function app_private.motorist_schedule_task_generation(p_task_id uuid,p_channels text[],p_actor_id uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare t public.motorist_case_tasks;
begin
 select * into t from public.motorist_case_tasks where id=p_task_id for update;
 if found and t.assigned_to is null and (t.assigned_user_id is not null or t.assigned_group_id is not null) then return;end if;
 perform app_private.motorist_schedule_task_generation_before_employees(p_task_id,p_channels,p_actor_id);
end $$;
create or replace function app_private.motorist_task_reminder_generation_before() returns trigger language plpgsql security definer set search_path='' as $$begin
 if tg_op='INSERT' then new.reminder_generation:=0;
 elsif row(new.due_at,new.reminder_at,new.assigned_to,new.assigned_user_id,new.assigned_group_id,new.status='done') is distinct from row(old.due_at,old.reminder_at,old.assigned_to,old.assigned_user_id,old.assigned_group_id,old.status='done') then new.reminder_generation:=old.reminder_generation+1;
 else new.reminder_generation:=old.reminder_generation;end if;return new;
end $$;
create or replace function app_private.motorist_task_assignment_before() returns trigger language plpgsql security definer set search_path='' as $$begin
 if tg_op='INSERT' then new.assignment_generation:=0;
 elsif row(new.assigned_to,new.assigned_user_id,new.assigned_group_id) is distinct from row(old.assigned_to,old.assigned_user_id,old.assigned_group_id) then new.assignment_generation:=old.assignment_generation+1;
 else new.assignment_generation:=old.assignment_generation;end if;return new;
end $$;

-- The explicit legacy unassign request is meaningful even when the old profile
-- mirror is already NULL (a field employee or a pobočka owns the task).
do $copy$declare definition text;begin
 select pg_get_functiondef('public.motorist_task_workspace(uuid,uuid,text,uuid,jsonb)'::regprocedure) into definition;
 if to_regprocedure('app_private.motorist_task_workspace_before_employees(uuid,uuid,text,uuid,jsonb)') is not null then raise exception 'Employee task migration already wrapped';end if;
 execute replace(definition,'FUNCTION public.motorist_task_workspace(','FUNCTION app_private.motorist_task_workspace_before_employees(');
end $copy$;
create or replace function public.motorist_task_workspace(p_organization_id uuid,p_actor_profile_id uuid,p_action text,p_task_id uuid default null,p_input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare previous text;result jsonb;
begin
 previous:=current_setting('app.employee_task_legacy_unassign',true);
 if p_action='update' and p_input?'assignedTo' then perform set_config('app.employee_task_legacy_unassign',p_task_id::text,true);end if;
 result:=app_private.motorist_task_workspace_before_employees(p_organization_id,p_actor_profile_id,p_action,p_task_id,p_input);
 perform set_config('app.employee_task_legacy_unassign',coalesce(previous,''),true);return result;
end $$;

create function public.motorist_employee_tasks(p_user_id uuid,p_organization_id uuid,p_action text,p_task_id uuid default null,p_input jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor record; t public.motorist_case_tasks; prior public.motorist_task_employee_commands;
 command uuid;request jsonb;permission jsonb;result jsonb;rows jsonb;activity jsonb;next_cursor text;cursor_data jsonb;
 view_name text:=coalesce(p_input->>'view','mine');category text:=coalesce(p_input->>'category','open');q text:=coalesce(p_input->>'q','');
 page_limit integer:=25;before_at timestamptz;before_id uuid;row_count integer;target_user uuid;target_group uuid;target_profile uuid;
 reviewer_profile uuid;reviewer_user uuid;state text;action text;next_state text;body text;case_id uuid;
 recipient_user uuid;recipient_profile uuid;notice_title text;notice_body text;notice_source text;
 previous_write text;previous_employee text;previous_workflow text;previous_notice text;lead_groups uuid[];
begin
 if p_input is null or jsonb_typeof(p_input)<>'object' or length(p_input::text)>70000 then raise exception 'Invalid employee task input' using errcode='22023';end if;
 select * into actor from app_private.employee_task_people(p_organization_id,p_user_id) where user_id=p_user_id;
 if not found then raise exception 'Employee task access denied' using errcode='42501';end if;
 if not exists(select 1 from public.motorist_task_workspace_settings s where s.organization_id=p_organization_id and s.enabled and s.writer_inventory_verified_at is not null and coalesce(length(trim(s.writer_inventory_note)),0)>0) then raise exception 'Task workspace activation required' using errcode='55000';end if;
 if p_action not in ('directory','list','get','create','command') then raise exception 'Invalid employee task action' using errcode='22023';end if;
 select coalesce(array_agg(g.id),'{}'::uuid[]) into lead_groups from public.motorist_work_groups g
  join public.motorist_work_group_members gm on gm.organization_id=g.organization_id and gm.group_id=g.id
  where g.organization_id=p_organization_id and g.active and gm.member_id=actor.member_id and gm.role='lead';
 if length(q)>200 then raise exception 'Task search too long' using errcode='22023';end if;
 if p_action='directory' then
  select count(*) into row_count from(select 1 from app_private.employee_task_people(p_organization_id) p where strpos(lower(p.display_name),lower(q))>0 limit 101) x;
  select coalesce(jsonb_agg(jsonb_build_object('userId',x.user_id,'displayName',x.display_name) order by x.display_name,x.user_id),'[]') into rows
   from(select * from app_private.employee_task_people(p_organization_id) p where strpos(lower(p.display_name),lower(q))>0 order by p.display_name,p.user_id limit 100) x;
  return jsonb_build_object('people',rows,'hasMorePeople',row_count>100,'canLinkCases',actor.office,
   'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'canManage',app_private.employee_task_lead(p_organization_id,p_user_id,g.id)) order by g.name,g.id)
    from public.motorist_work_groups g where g.organization_id=p_organization_id and app_private.employee_task_group_available(p_organization_id,g.id)),'[]'));
 end if;
 if p_action='list' then
  if view_name not in ('mine','branch','created','review') or category not in ('open','done','all') or (p_input?'limit' and (jsonb_typeof(p_input->'limit')<>'number' or (p_input->>'limit')!~'^[0-9]{1,2}$')) then raise exception 'Invalid task filters' using errcode='22023';end if;
  page_limit:=coalesce((p_input->>'limit')::integer,25);if page_limit not between 1 and 50 then raise exception 'Invalid page size' using errcode='22023';end if;
  if nullif(p_input->>'cursor','') is not null then
   if length(p_input->>'cursor')>4096 then raise exception 'Invalid task cursor' using errcode='22023';end if;
   begin cursor_data:=(p_input->>'cursor')::jsonb;before_at:=(cursor_data->>'at')::timestamptz;before_id:=(cursor_data->>'id')::uuid;
   exception when others then raise exception 'Invalid task cursor' using errcode='22023';end;
   if cursor_data->>'org' is distinct from p_organization_id::text or cursor_data->>'user' is distinct from p_user_id::text or cursor_data->>'view' is distinct from view_name or cursor_data->>'category' is distinct from category or cursor_data->>'q' is distinct from q or before_at is null or before_id is null then raise exception 'Task cursor scope mismatch' using errcode='22023';end if;
  end if;
  with page as(select x as task,x.updated_at,x.id from public.motorist_case_tasks x where x.organization_id=p_organization_id
    and (actor.office or app_private.employee_task_assignee(x)=p_user_id or app_private.employee_task_creator(x)=p_user_id
     or app_private.employee_task_user(p_organization_id,x.reviewer_profile_id)=p_user_id or x.assigned_group_id=any(lead_groups))
    and ((view_name='mine' and app_private.employee_task_assignee(x)=p_user_id) or (view_name='created' and app_private.employee_task_creator(x)=p_user_id)
     or (view_name='review' and app_private.employee_task_user(p_organization_id,x.reviewer_profile_id)=p_user_id)
     or (view_name='branch' and x.assigned_group_id=any(lead_groups)))
    and (category='all' or (category='done')=(x.status='done')) and strpos(lower(x.title),lower(q))>0
    and (before_at is null or (x.updated_at,x.id)<(before_at,before_id)) order by x.updated_at desc,x.id desc limit page_limit+1)
   select count(*),coalesce(jsonb_agg(app_private.employee_task_dto(p.task,p_user_id) order by p.updated_at desc,p.id desc) filter(where n<=page_limit),'[]') into row_count,rows
   from(select page.*,row_number()over(order by updated_at desc,id desc)n from page) p;
  if row_count>page_limit then next_cursor:=jsonb_build_object('org',p_organization_id,'user',p_user_id,'view',view_name,'category',category,'q',q,'at',rows->-1->>'updatedAt','id',rows->-1->>'id')::text;end if;
  return jsonb_build_object('view',view_name,'tasks',rows,'nextCursor',next_cursor);
 end if;
 if p_action in ('create','command') then
  if jsonb_typeof(p_input->'commandId') is distinct from 'string' then raise exception 'Task command ID required' using errcode='22023';end if;
  begin command:=(p_input->>'commandId')::uuid;exception when others then raise exception 'Invalid task command ID' using errcode='22023';end;
  request:=jsonb_build_object('action',p_action,'taskId',p_task_id,'input',p_input);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text||':'||p_user_id::text||':'||command::text,0));
  select * into prior from public.motorist_task_employee_commands c where c.organization_id=p_organization_id and c.actor_user_id=p_user_id and c.command_id=command;
  if found then
   if prior.request<>request then raise exception 'Task command ID reused' using errcode='PT409';end if;
   select * into t from public.motorist_case_tasks where id=prior.task_id and organization_id=p_organization_id;
   if not found or not app_private.employee_task_can_read(t,p_user_id) then raise exception 'Task unavailable' using errcode='P0002';end if;
   return jsonb_build_object('commandId',command,'committedRevision',prior.committed_revision,'task',app_private.employee_task_dto(t,p_user_id));
  end if;
 end if;
 if p_action<>'create' then
  select * into t from public.motorist_case_tasks where id=p_task_id and organization_id=p_organization_id for update;
  if not found or not app_private.employee_task_can_read(t,p_user_id) then raise exception 'Task unavailable' using errcode='P0002';end if;
 end if;
 if p_action='get' then
  if nullif(p_input->>'cursor','') is not null then
   begin cursor_data:=(p_input->>'cursor')::jsonb;before_at:=(cursor_data->>'at')::timestamptz;before_id:=(cursor_data->>'id')::uuid;
   exception when others then raise exception 'Invalid activity cursor' using errcode='22023';end;
   if length(p_input->>'cursor')>4096 or cursor_data->>'task' is distinct from t.id::text or cursor_data->>'user' is distinct from p_user_id::text or before_at is null or before_id is null then raise exception 'Activity cursor scope mismatch' using errcode='22023';end if;
  end if;
  with all_activity as(
   select e.id,e.created_at,e.actor_user_id as usr,e.body,e.kind from public.motorist_task_employee_events e where e.organization_id=p_organization_id and e.task_id=t.id
   union all select m.id,m.created_at,coalesce(m.author_user_id,app_private.employee_task_user(p_organization_id,m.author_profile_id)),m.body,'comment' from public.motorist_task_messages m where m.organization_id=p_organization_id and m.task_id=t.id
  ), page as(select * from all_activity where before_at is null or (created_at,id)<(before_at,before_id) order by created_at desc,id desc limit 51)
  select count(*),coalesce(jsonb_agg(jsonb_build_object('id',p.id,'author',app_private.employee_task_person(p_organization_id,p.usr),'body',p.body,'createdAt',p.created_at,'kind',p.kind) order by p.created_at desc,p.id desc)filter(where n<=50),'[]') into row_count,activity from(select page.*,row_number()over(order by created_at desc,id desc)n from page) p;
  if row_count>50 then next_cursor:=jsonb_build_object('task',t.id,'user',p_user_id,'at',activity->-1->>'createdAt','id',activity->-1->>'id')::text;end if;
  return jsonb_build_object('task',app_private.employee_task_dto(t,p_user_id),'activity',activity,'nextActivityCursor',next_cursor);
 end if;
 if p_action='command' then
  if jsonb_typeof(p_input->'expectedRevision') is distinct from 'number' or coalesce(p_input->>'expectedRevision','')!~'^[1-9][0-9]{0,9}$' or (p_input->>'expectedRevision')::numeric>2147483647 then raise exception 'Invalid task revision' using errcode='22023';end if;
  if (p_input->>'expectedRevision')::integer<>t.revision then raise exception 'Task revision conflict' using errcode='PT409';end if;
  action:=p_input->>'action';permission:=app_private.employee_task_permissions(t,p_user_id);
  if action not in ('assign','comment','submit_review','return','claim','start','complete','reopen','approve') or action is null then raise exception 'Invalid task command' using errcode='22023';end if;
  if not coalesce((permission->>case action when 'submit_review' then 'submitReview' else action end)::boolean,false) then raise exception 'Task action denied' using errcode='42501';end if;
 end if;
 if p_action='create' or action='assign' then
  if jsonb_typeof(p_input->'target') is distinct from 'object' or p_input->'target'->>'kind' not in ('person','group') then raise exception 'Invalid task target' using errcode='22023';end if;
  if p_input->'target'->>'kind'='person' then
   begin target_user:=(p_input->'target'->>'userId')::uuid;exception when others then raise exception 'Invalid task recipient' using errcode='22023';end;
   select p.profile_id into target_profile from app_private.employee_task_people(p_organization_id,target_user) p where p.user_id=target_user;
   if not found then raise exception 'Task recipient unavailable' using errcode='22023';end if;
   if action='assign' then target_group:=t.assigned_group_id;end if;
  else
   begin target_group:=(p_input->'target'->>'groupId')::uuid;exception when others then raise exception 'Invalid task group' using errcode='22023';end;
   if target_group is null or not app_private.employee_task_group_available(p_organization_id,target_group) then raise exception 'Task group unavailable' using errcode='22023';end if;
  end if;
 end if;
 if p_action='create' then
  if jsonb_typeof(p_input->'title') is distinct from 'string' or length(btrim(p_input->>'title')) not between 1 and 500
   or (p_input?'description' and (jsonb_typeof(p_input->'description')<>'string' or length(p_input->>'description')>10000))
   or coalesce(p_input->>'priority','normal') not in ('urgent','high','normal','low') then raise exception 'Invalid task details' using errcode='22023';end if;
  begin if p_input->>'dueAt' is not null then before_at:=(p_input->>'dueAt')::timestamptz;if not isfinite(before_at) then raise exception 'Invalid date';end if;end if;
   case_id:=(p_input->>'caseId')::uuid;exception when others then raise exception 'Invalid task date or case' using errcode='22023';end;
  if case_id is not null and (not actor.office or not exists(select 1 from public.motorist_cases c where c.id=case_id and c.organization_id=p_organization_id)) then raise exception 'Task case unavailable' using errcode='42501';end if;
 elsif action in ('comment','return','submit_review') then
  body:=btrim(p_input->>case when action='comment' then 'body' else 'comment' end);
  if body is null or length(body) not between 1 and 10000 then raise exception 'Task comment required' using errcode='22023';end if;
 end if;
 if action='submit_review' then
  begin reviewer_user:=(p_input->>'reviewerUserId')::uuid;exception when others then raise exception 'Invalid reviewer' using errcode='22023';end;
  select p.profile_id into reviewer_profile from app_private.employee_task_people(p_organization_id,reviewer_user) p where p.user_id=reviewer_user and p.office;
  if not found or reviewer_user=p_user_id or reviewer_user=app_private.employee_task_assignee(t) then raise exception 'Invalid task reviewer' using errcode='22023';end if;
 end if;
 previous_write:=current_setting('app.task_workspace_write',true);previous_employee:=current_setting('app.employee_task_write',true);previous_workflow:=current_setting('app.task_workflow_write',true);previous_notice:=current_setting('app.notification_actor_write',true);
 perform set_config('app.task_workspace_write','v1',true);perform set_config('app.employee_task_write','v1',true);perform set_config('app.task_workflow_write','v1',true);perform set_config('app.notification_actor_write','v1',true);
 if p_action='create' then
  insert into public.motorist_case_tasks(organization_id,case_id,title,description,assigned_to,assigned_user_id,assigned_group_id,created_by,created_by_user_id,due_at,status,priority,kind,workflow_state)
   values(p_organization_id,case_id,btrim(p_input->>'title'),coalesce(p_input->>'description',''),target_profile,target_user,target_group,actor.profile_id,p_user_id,before_at,'open',coalesce(p_input->>'priority','normal'),'other','todo') returning * into t;
  insert into public.motorist_task_employee_events(organization_id,task_id,actor_user_id,kind,body)values(p_organization_id,t.id,p_user_id,'created','Úloha vytvorená.');
 elsif action='comment' then
  insert into public.motorist_task_messages(organization_id,task_id,author_profile_id,author_user_id,body,client_message_id)values(p_organization_id,t.id,actor.profile_id,p_user_id,body,command);
  update public.motorist_case_tasks set updated_at=clock_timestamp() where id=t.id returning * into t;
 elsif action in ('assign','claim') then
  if action='claim' then target_user:=p_user_id;target_profile:=actor.profile_id;target_group:=t.assigned_group_id;end if;
  if target_profile is not null and target_profile=t.reviewer_profile_id then raise exception 'Assignee cannot be reviewer' using errcode='22023';end if;
  update public.motorist_case_tasks set assigned_user_id=target_user,assigned_to=target_profile,assigned_group_id=target_group where id=t.id returning * into t;
  insert into public.motorist_task_employee_events(organization_id,task_id,actor_user_id,kind,body)values(p_organization_id,t.id,p_user_id,'assigned',case when target_user is not null then 'Pridelené: '||(app_private.employee_task_person(p_organization_id,target_user)->>'displayName') else 'Pridelené pobočke: '||(select name from public.motorist_work_groups where id=target_group) end);
 else
  next_state:=case action when 'start' then 'in_progress' when 'submit_review' then 'in_review' when 'return' then 'in_progress' when 'reopen' then 'todo' else 'done' end;
  update public.motorist_case_tasks set workflow_state=next_state,status=case when next_state='done' then 'done' when status='done' then 'open' else status end,
   completed_at=case when next_state='done' then clock_timestamp() else null end,completed_by=case when next_state='done' then actor.profile_id else null end,completed_by_user_id=case when next_state='done' then p_user_id else null end,
   reviewer_profile_id=case when action='submit_review' then reviewer_profile else reviewer_profile_id end,
   review_requested_by=case when action='submit_review' then actor.profile_id else review_requested_by end,
   review_requested_by_user_id=case when action='submit_review' then p_user_id else review_requested_by_user_id end,
   review_requested_at=case when action='submit_review' then clock_timestamp() else review_requested_at end,
   review_submission=case when action='submit_review' then body else review_submission end,
   review_return_reason=case when action='return' then body when action='submit_review' then null else review_return_reason end,
   review_generation=case when action='submit_review' then review_generation+1 else review_generation end,
   reviewed_by=case when action='approve' then actor.profile_id when action in ('submit_review','reopen') then null else reviewed_by end,
   reviewed_at=case when action='approve' then clock_timestamp() when action in ('submit_review','reopen') then null else reviewed_at end where id=t.id returning * into t;
  insert into public.motorist_task_employee_events(organization_id,task_id,actor_user_id,kind,body)values(p_organization_id,t.id,p_user_id,'state',case action when 'start' then 'Práca začatá.' when 'complete' then 'Úloha dokončená.' when 'approve' then 'Kontrola schválená.' when 'reopen' then 'Úloha znovu otvorená.' when 'return' then 'Vrátené na dopracovanie: '||body else 'Odovzdané na kontrolu: '||body end);
  if action in ('submit_review','return','approve','reopen') then update public.motorist_notifications set status='archived',archived_at=clock_timestamp() where organization_id=p_organization_id and task_id=t.id and payload->>'source'='task_review_requested' and status='unread';end if;
  if action='submit_review' then
   recipient_user:=reviewer_user;notice_title:='Úloha na kontrolu';notice_body:=t.title;notice_source:='task_review_requested';
  elsif action in ('return','approve') then
   -- Resolve the canonical recipient first. A field assignee with no office
   -- profile must not fall through to an unrelated office creator's inbox.
   recipient_user:=coalesce(app_private.employee_task_assignee(t),t.review_requested_by_user_id,
    app_private.employee_task_user(p_organization_id,t.review_requested_by),app_private.employee_task_creator(t));
   notice_title:=case when action='return' then 'Úloha vrátená na dopracovanie' else 'Úloha schválená' end;
   notice_body:=t.title||case when action='return' then E'\n'||body else '' end;
   notice_source:='task_review_'||action;
  end if;
  if recipient_user is not null and recipient_user<>p_user_id then
   select p.profile_id into recipient_profile from app_private.employee_task_people(p_organization_id,recipient_user) p where p.user_id=recipient_user and p.office;
  end if;
  if recipient_profile is not null then
   insert into public.motorist_notifications(organization_id,case_id,task_id,recipient_profile_id,visibility,kind,severity,title,body,status,delivery_status,dedupe_key,payload)
    values(p_organization_id,t.case_id,t.id,recipient_profile,'private','handover','info',notice_title,notice_body,'unread','in_app',
     'task-review:'||t.id||':generation:'||t.review_generation||':'||action||':recipient:'||recipient_profile,
     jsonb_build_object('source',notice_source,'review_generation',t.review_generation)) on conflict(organization_id,dedupe_key)do nothing;
  end if;
 end if;
 insert into public.motorist_task_employee_commands(organization_id,actor_user_id,command_id,task_id,request,committed_revision)values(p_organization_id,p_user_id,command,t.id,request,t.revision);
 insert into public.motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
  values(p_organization_id,actor.profile_id,'task.employee.'||coalesce(action,'create'),'motorist_case_tasks',t.id,'mobile',jsonb_build_object('actorUserId',p_user_id,'revision',t.revision,'commandId',command));
 perform set_config('app.task_workspace_write',coalesce(previous_write,''),true);perform set_config('app.employee_task_write',coalesce(previous_employee,''),true);perform set_config('app.task_workflow_write',coalesce(previous_workflow,''),true);perform set_config('app.notification_actor_write',coalesce(previous_notice,''),true);
 if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then perform realtime.send('{}'::jsonb,'invalidate','tasks:'||p_organization_id::text,true);end if;
 return jsonb_build_object('commandId',command,'committedRevision',t.revision,'task',app_private.employee_task_dto(t,p_user_id));
end $$;

revoke all on function public.motorist_employee_tasks(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_employee_tasks(uuid,uuid,text,uuid,jsonb) to service_role;
revoke all on function public.motorist_task_workspace(uuid,uuid,text,uuid,jsonb) from public,anon,service_role;
grant execute on function public.motorist_task_workspace(uuid,uuid,text,uuid,jsonb) to authenticated;
do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and
  (p.proname like 'employee_task_%' or p.proname in ('motorist_task_workspace_before_employees','motorist_schedule_task_generation_before_employees','motorist_schedule_task_generation','motorist_task_dto','motorist_task_dto_before_employees','motorist_task_message_dto','motorist_task_reminder_generation_before','motorist_task_assignment_before'))
 loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);end loop;
end $$;
commit;
