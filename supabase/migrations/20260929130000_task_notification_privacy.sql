-- Actor-private delivery state and transactional reminder generations.
-- Prepare locally; apply only with explicit authorization to this copy's project.
begin;

alter table public.motorist_case_tasks add column if not exists reminder_at timestamptz;
alter table public.motorist_case_tasks add column if not exists reminder_generation bigint not null default 0;
alter table public.motorist_task_reminders add column if not exists generation bigint not null default 0;
alter table public.motorist_task_reminders alter column case_id drop not null;
alter table public.motorist_task_reminders drop constraint if exists motorist_task_reminders_case_id_fkey;
alter table public.motorist_task_reminders add constraint motorist_task_reminders_case_id_fkey foreign key(case_id) references public.motorist_cases(id) on delete set null;
alter table public.motorist_notifications drop constraint if exists motorist_notifications_case_id_fkey;
alter table public.motorist_notifications add constraint motorist_notifications_case_id_fkey foreign key(case_id) references public.motorist_cases(id) on delete set null;

-- Private reads never gain an administrator exception. Historical team rows
-- retain their explicitly shared meaning; they are not relabelled as personal.
-- The historical membership helper checks the profile, but not organization
-- activation. Keep this boundary explicit for both reads and actor updates.
create or replace function app_private.motorist_notification_active_member(p_organization_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.motorist_profiles p
    join public.motorist_organizations o on o.id = p.organization_id and o.active
    where p.organization_id = p_organization_id and p.user_id = auth.uid() and p.active)
$$;
revoke all on function app_private.motorist_notification_active_member(uuid) from public, anon;
grant execute on function app_private.motorist_notification_active_member(uuid) to authenticated;
drop policy if exists motorist_task_reminders_member_access on public.motorist_task_reminders;
create policy motorist_task_reminders_recipient_select on public.motorist_task_reminders for select to authenticated
using (app_private.motorist_notification_active_member(organization_id) and (visibility = 'team' or exists (
  select 1 from public.motorist_profiles p where p.id = recipient_profile_id
  and p.organization_id = motorist_task_reminders.organization_id and p.user_id = auth.uid() and p.active
)));
revoke all on public.motorist_task_reminders from anon, authenticated;
grant select on public.motorist_task_reminders to authenticated;
drop policy if exists motorist_notifications_member_insert on public.motorist_notifications;
revoke all on public.motorist_notifications from anon, authenticated;
grant select on public.motorist_notifications to authenticated;
grant update(status, read_at, archived_at) on public.motorist_notifications to authenticated;
create policy motorist_notifications_active_organization on public.motorist_notifications
as restrictive for all to authenticated
using (app_private.motorist_notification_active_member(organization_id))
with check (app_private.motorist_notification_active_member(organization_id));
-- Existing SELECT/UPDATE RLS already require team visibility or actual recipient.
-- Column grants prevent changing recipient/visibility/title/payload through them.

create or replace function app_private.motorist_task_reminder_channels(p_task_id uuid) returns text[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare channels text[]; requested text;
begin
  requested := nullif(current_setting('app.task_reminder_channels', true), '');
  if requested is not null then
    select array_agg(distinct value) into channels from jsonb_array_elements_text(requested::jsonb);
    if exists(select 1 from unnest(channels) c where c not in ('in_app','email')) then
      raise exception 'Invalid reminder channels' using errcode = '22023';
    end if;
  else
    select r.channels into channels from public.motorist_task_reminders r where r.task_id = p_task_id order by r.created_at desc limit 1;
  end if;
  return case when coalesce(cardinality(channels),0) = 0 then array['in_app']::text[] else channels end;
end $$;

create or replace function app_private.motorist_schedule_task_generation(p_task_id uuid, p_channels text[], p_actor_id uuid default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare task public.motorist_case_tasks%rowtype;
begin
  select * into task from public.motorist_case_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if task.status = 'done' or coalesce(task.reminder_at,task.due_at) is null then return; end if;
  -- New team events create one personal reminder for each current authorized
  -- recipient. Recipient lists are never inferred from a client filter.
  insert into public.motorist_task_reminders(organization_id, case_id, task_id, recipient_profile_id, visibility, channels, scheduled_for, status, dedupe_key, created_by, generation, payload)
  select task.organization_id, task.case_id, task.id, p.id, 'private', p_channels, coalesce(task.reminder_at,task.due_at), 'pending',
    'task:' || task.id || ':generation:' || task.reminder_generation || ':recipient:' || p.id,
    p_actor_id, task.reminder_generation, jsonb_build_object('source',case when task.reminder_at is null then 'task_default_reminder' else 'task_custom_reminder' end,'audience',case when task.assigned_to is null then 'team' else 'assignee' end)
  from public.motorist_profiles p join public.motorist_organizations o on o.id = p.organization_id and o.active
  where p.organization_id = task.organization_id and p.active and p.role in ('dispatcher','senior_dispatcher','manager','admin')
    and (task.assigned_to is null or p.id = task.assigned_to)
  on conflict(organization_id, dedupe_key) do update set channels = excluded.channels
    where motorist_task_reminders.status = 'pending';
end $$;

create or replace function app_private.motorist_task_reminder_generation_before() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then new.reminder_generation := 0;
  elsif new.due_at is distinct from old.due_at or new.reminder_at is distinct from old.reminder_at or new.assigned_to is distinct from old.assigned_to
    or (new.status = 'done') is distinct from (old.status = 'done') then
    new.reminder_generation := old.reminder_generation + 1;
  else new.reminder_generation := old.reminder_generation;
  end if;
  return new;
end $$;

create or replace function app_private.motorist_task_reminder_generation_after() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare selected_channels text[]; previous_context text;
begin
  if tg_op = 'UPDATE' and new.reminder_generation = old.reminder_generation then
    -- A channels-only edit changes pending delivery preferences, not the
    -- reminder event or its generation. Already handed-off deliveries remain history.
    if nullif(current_setting('app.task_reminder_channels',true),'') is not null then
      selected_channels := app_private.motorist_task_reminder_channels(new.id);
      previous_context := current_setting('app.task_reminder_lifecycle',true);
      perform set_config('app.task_reminder_lifecycle','v1',true);
      update public.motorist_task_reminders set channels = selected_channels
        where organization_id = new.organization_id and task_id = new.id
          and generation = new.reminder_generation and status = 'pending';
      perform set_config('app.task_reminder_lifecycle',coalesce(previous_context,''),true);
    end if;
    return new;
  end if;
  selected_channels := app_private.motorist_task_reminder_channels(new.id);
  previous_context := current_setting('app.task_reminder_lifecycle',true);
  perform set_config('app.task_reminder_lifecycle','v1',true);
  update public.motorist_task_reminders set status = 'cancelled', last_error = null
    where organization_id = new.organization_id and task_id = new.id and status in ('pending','processing','failed');
  perform app_private.motorist_schedule_task_generation(new.id, selected_channels, new.created_by);
  perform set_config('app.task_reminder_lifecycle',coalesce(previous_context,''),true);
  return new;
end $$;

create trigger motorist_task_reminder_generation_before before insert or update on public.motorist_case_tasks
for each row execute function app_private.motorist_task_reminder_generation_before();
create trigger motorist_task_reminder_generation_after after insert or update on public.motorist_case_tasks
for each row execute function app_private.motorist_task_reminder_generation_after();

-- Legacy server adapters use this idempotent bridge after their task write.
-- The generation itself belongs to the task transaction, never a random retry ID.
create or replace function public.motorist_ensure_task_reminders(p_organization_id uuid, p_task_id uuid, p_actor_id uuid default null, p_channels text[] default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare task public.motorist_case_tasks%rowtype; channels text[];
begin
  select * into task from public.motorist_case_tasks where id = p_task_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if p_actor_id is not null and not exists(select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id = p.organization_id and o.active
    where p.id = p_actor_id and p.organization_id = p_organization_id and p.active and p.role in ('dispatcher','senior_dispatcher','manager','admin')) then
    raise exception 'Invalid reminder actor' using errcode = '42501';
  end if;
  channels := coalesce(p_channels, app_private.motorist_task_reminder_channels(p_task_id));
  if coalesce(cardinality(channels),0) = 0 or exists(select 1 from unnest(channels) c where c not in ('in_app','email')) then raise exception 'Invalid reminder channels' using errcode = '22023'; end if;
  perform app_private.motorist_schedule_task_generation(task.id, channels, p_actor_id);
  return coalesce((select jsonb_agg(to_jsonb(r)) from public.motorist_task_reminders r where r.organization_id = p_organization_id and r.task_id = p_task_id and r.generation = task.reminder_generation), '[]'::jsonb);
end $$;
revoke all on function public.motorist_ensure_task_reminders(uuid,uuid,uuid,text[]) from public, anon, authenticated;
grant execute on function public.motorist_ensure_task_reminders(uuid,uuid,uuid,text[]) to service_role;

create or replace function public.motorist_cancel_stale_task_reminders(p_organization_id uuid, p_task_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare task public.motorist_case_tasks%rowtype; previous_context text;
begin
  select * into task from public.motorist_case_tasks where id = p_task_id and organization_id = p_organization_id for update;
  if not found then return; end if;
  previous_context := current_setting('app.task_reminder_lifecycle',true);
  perform set_config('app.task_reminder_lifecycle','v1',true);
  update public.motorist_task_reminders set status = 'cancelled', last_error = null
    where organization_id = p_organization_id and task_id = p_task_id and status in ('pending','processing','failed')
      and (task.status = 'done' or generation <> task.reminder_generation);
  perform set_config('app.task_reminder_lifecycle',coalesce(previous_context,''),true);
end $$;
revoke all on function public.motorist_cancel_stale_task_reminders(uuid,uuid) from public, anon, authenticated;
grant execute on function public.motorist_cancel_stale_task_reminders(uuid,uuid) to service_role;

create or replace function public.motorist_cancel_unavailable_reminder(p_organization_id uuid, p_reminder_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare task public.motorist_case_tasks%rowtype; reminder public.motorist_task_reminders%rowtype; previous_context text;
begin
  select t.* into task from public.motorist_case_tasks t join public.motorist_task_reminders r on r.task_id=t.id and r.organization_id=t.organization_id
    where r.id=p_reminder_id and r.organization_id=p_organization_id for share of t;
  if not found then return; end if;
  select * into reminder from public.motorist_task_reminders where id=p_reminder_id and organization_id=p_organization_id for update;
  if reminder.status not in ('pending','processing','failed') then return; end if;
  if task.status<>'done' and task.reminder_generation=reminder.generation
    and not(coalesce(reminder.payload->>'source' in ('task_default_reminder','task_custom_reminder'),false) and reminder.scheduled_for is distinct from coalesce(task.reminder_at,task.due_at))
    and (reminder.visibility='team' or (
      (task.assigned_to is null or task.assigned_to=reminder.recipient_profile_id)
      and exists(select 1 from motorist_profiles p join motorist_organizations o on o.id=p.organization_id and o.active
        where p.id=reminder.recipient_profile_id and p.organization_id=p_organization_id and p.active and p.role in ('dispatcher','senior_dispatcher','manager','admin'))
    )) then return; end if;
  previous_context := current_setting('app.task_reminder_lifecycle',true);
  perform set_config('app.task_reminder_lifecycle','v1',true);
  update public.motorist_task_reminders set status='cancelled',last_error=null where id=p_reminder_id;
  perform set_config('app.task_reminder_lifecycle',coalesce(previous_context,''),true);
end $$;
revoke all on function public.motorist_cancel_unavailable_reminder(uuid,uuid) from public,anon,authenticated;
grant execute on function public.motorist_cancel_unavailable_reminder(uuid,uuid) to service_role;

-- All product actor writes, including snooze, share one locked ACL boundary.
create or replace function public.motorist_notification_action(p_organization_id uuid, p_actor_id uuid, p_action text, p_notification_id uuid default null, p_task_id uuid default null, p_snoozed_until timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare notice public.motorist_notifications%rowtype; ids jsonb; previous_context text;
begin
  if not exists(select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
    where p.id=p_actor_id and p.organization_id=p_organization_id and p.active and p.role in ('dispatcher','senior_dispatcher','manager','admin')) then
    raise exception 'Invalid notification actor' using errcode='42501';
  end if;
  if p_action not in ('read','unread','archived','snooze') or (p_notification_id is null) = (p_task_id is null) then raise exception 'Invalid notification action' using errcode='22023'; end if;
  if p_action='snooze' and (p_task_id is not null or p_snoozed_until is null or p_snoozed_until<now()+interval '30 seconds' or p_snoozed_until>now()+interval '366 days') then raise exception 'Invalid snooze time' using errcode='22023'; end if;
  if p_notification_id is not null then
    select * into notice from public.motorist_notifications n where n.id=p_notification_id and n.organization_id=p_organization_id
      and (n.visibility='team' or (n.visibility='private' and n.recipient_profile_id=p_actor_id)) for update;
    if not found then raise exception 'Notification not found' using errcode='P0002'; end if;
    if p_action='snooze' and (notice.visibility<>'private' or notice.recipient_profile_id is distinct from p_actor_id) then raise exception 'Notification cannot be snoozed' using errcode='42501'; end if;
  end if;
  previous_context := current_setting('app.notification_actor_write',true);
  perform set_config('app.notification_actor_write','v1',true);
  with changed as (
    update public.motorist_notifications n set
      status=case when p_action='snooze' then 'unread' else p_action end,
      read_at=case when p_action='read' then now() else null end,
      archived_at=case when p_action='archived' then now() else null end,
      payload=case when p_action='snooze' then n.payload || jsonb_build_object('snoozed_at',now(),'snoozed_until',p_snoozed_until)
                   when p_action='unread' then n.payload - 'snoozed_at' - 'snoozed_until' else n.payload end
    where n.organization_id=p_organization_id and (n.visibility='team' or (n.visibility='private' and n.recipient_profile_id=p_actor_id))
      and ((p_notification_id is not null and n.id=p_notification_id) or (p_task_id is not null and n.task_id=p_task_id))
    returning n.id
  ) select coalesce(jsonb_agg(id),'[]'::jsonb) into ids from changed;
  perform set_config('app.notification_actor_write',coalesce(previous_context,''),true);
  return jsonb_build_object('id',p_notification_id,'ids',ids);
end $$;
revoke all on function public.motorist_notification_action(uuid,uuid,text,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.motorist_notification_action(uuid,uuid,text,uuid,uuid,timestamptz) to service_role;

-- A task can change after the runner's SELECT/claim. Lock it before accepting
-- its notification so stale completion/reassignment never revives an old
-- generation; this check happens before any email or push side effect.
create or replace function app_private.motorist_validate_reminder_delivery() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare task public.motorist_case_tasks%rowtype; reminder public.motorist_task_reminders%rowtype;
begin
  if new.reminder_id is null or new.payload->>'source' is distinct from 'task_reminder_runner' then return new; end if;
  select * into task from public.motorist_case_tasks where id = new.task_id and organization_id = new.organization_id for share;
  if not found then raise exception 'Stale reminder task' using errcode = '40001'; end if;
  select * into reminder from public.motorist_task_reminders where id = new.reminder_id and task_id = task.id and organization_id = task.organization_id for update;
  if not found or task.status = 'done' or reminder.status <> 'processing' or reminder.generation <> task.reminder_generation
    or (reminder.payload->>'source' in ('task_default_reminder','task_custom_reminder') and reminder.scheduled_for is distinct from coalesce(task.reminder_at,task.due_at))
    or new.visibility <> 'private' or new.recipient_profile_id is null
    or (reminder.visibility = 'private' and reminder.recipient_profile_id is distinct from new.recipient_profile_id)
    or (task.assigned_to is not null and task.assigned_to is distinct from new.recipient_profile_id)
    or not exists(select 1 from public.motorist_profiles p where p.id = new.recipient_profile_id and p.organization_id = new.organization_id and p.active and p.role in ('dispatcher','senior_dispatcher','manager','admin')) then
    raise exception 'Stale reminder generation or recipient' using errcode = '40001';
  end if;
  return new;
end $$;
create trigger motorist_validate_reminder_delivery before insert on public.motorist_notifications
for each row execute function app_private.motorist_validate_reminder_delivery();

-- Activation also blocks preliminary side effects from old delete workflows,
-- not merely their final task DELETE. The compatible RPC/trigger paths mark
-- their narrow transaction-local context; rollout still requires writer inventory.
create or replace function app_private.motorist_guard_legacy_notification_write() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if to_regclass('public.motorist_task_workspace_settings') is null then return new; end if;
  if not exists(select 1 from public.motorist_task_workspace_settings s where s.organization_id=new.organization_id and s.enabled) then return new; end if;
  if tg_table_name='motorist_task_reminders' then
    if new.status='cancelled' and old.status is distinct from new.status
      and current_setting('app.task_reminder_lifecycle',true) is distinct from 'v1'
      and current_setting('app.task_workspace_write',true) is distinct from 'v1' then
      raise exception 'Legacy reminder lifecycle write blocked' using errcode='55000';
    end if;
  elsif new.task_id is not null and new.status in ('read','archived') and old.status is distinct from new.status
    and current_setting('app.notification_actor_write',true) is distinct from 'v1' then
    raise exception 'Legacy notification lifecycle write blocked' using errcode='55000';
  end if;
  return new;
end $$;
create trigger motorist_guard_legacy_reminder_write before update on public.motorist_task_reminders
for each row execute function app_private.motorist_guard_legacy_notification_write();
create trigger motorist_guard_legacy_notification_write before update on public.motorist_notifications
for each row execute function app_private.motorist_guard_legacy_notification_write();
revoke all on function app_private.motorist_guard_legacy_notification_write() from public,anon,authenticated;

revoke all on function app_private.motorist_task_reminder_channels(uuid) from public, anon, authenticated;
revoke all on function app_private.motorist_schedule_task_generation(uuid,text[],uuid) from public, anon, authenticated;
revoke all on function app_private.motorist_task_reminder_generation_before() from public, anon, authenticated;
revoke all on function app_private.motorist_task_reminder_generation_after() from public, anon, authenticated;
revoke all on function app_private.motorist_validate_reminder_delivery() from public, anon, authenticated;

-- Assignment is an immediate event, independent from a deadline/reminder.
-- Its durable bell and push job commit in the same transaction as the task.
alter table public.motorist_case_tasks add column assignment_generation bigint not null default 0;
create table public.motorist_task_assignment_deliveries (
  notification_id uuid primary key references public.motorist_notifications(id) on delete cascade,
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  task_id uuid not null references public.motorist_case_tasks(id) on delete cascade,
  recipient_profile_id uuid not null references public.motorist_profiles(id) on delete cascade,
  generation bigint not null,
  status text not null default 'pending' check(status in ('pending','processing','sent','cancelled','failed')),
  attempts integer not null default 0,
  lease_id uuid,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(task_id,generation,recipient_profile_id)
);
alter table public.motorist_task_assignment_deliveries enable row level security;
revoke all on public.motorist_task_assignment_deliveries from public,anon,authenticated,service_role;
create index motorist_task_assignment_pending_idx on public.motorist_task_assignment_deliveries(organization_id,status,available_at);

create function app_private.motorist_ensure_assignment_event(p_task_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare task public.motorist_case_tasks; notice public.motorist_notifications; case_number text;
begin
  select * into task from public.motorist_case_tasks where id=p_task_id for update;
  if not found or task.status='done' or task.assigned_to is null then return null; end if;
  if not exists(select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
    where p.id=task.assigned_to and p.organization_id=task.organization_id and p.active and p.role in ('dispatcher','senior_dispatcher','manager','admin')) then return null; end if;
  select c.case_number into case_number from public.motorist_cases c where c.id=task.case_id and c.organization_id=task.organization_id;
  insert into public.motorist_notifications(organization_id,case_id,task_id,recipient_profile_id,visibility,kind,severity,title,body,status,delivery_status,dedupe_key,payload)
    values(task.organization_id,task.case_id,task.id,task.assigned_to,'private','task_due',
      case when to_jsonb(task)->>'priority' in ('urgent','high') then 'warning' else 'info' end,
      case when case_number is null then 'Nová pridelená úloha' else case_number||': nová pridelená úloha' end,
      task.title,'unread','in_app','task-assigned:'||task.id||':generation:'||task.assignment_generation||':recipient:'||task.assigned_to,
      jsonb_build_object('source','task_assignment','assignment_generation',task.assignment_generation))
    on conflict(organization_id,dedupe_key) do nothing;
  select * into notice from public.motorist_notifications where organization_id=task.organization_id
    and dedupe_key='task-assigned:'||task.id||':generation:'||task.assignment_generation||':recipient:'||task.assigned_to;
  insert into public.motorist_task_assignment_deliveries(notification_id,organization_id,task_id,recipient_profile_id,generation)
    values(notice.id,task.organization_id,task.id,task.assigned_to,task.assignment_generation) on conflict do nothing;
  return to_jsonb(notice);
end $$;
create function app_private.motorist_task_assignment_before() returns trigger language plpgsql security definer set search_path='' as $$ begin
  if tg_op='INSERT' then new.assignment_generation:=0;
  elsif new.assigned_to is distinct from old.assigned_to then new.assignment_generation:=old.assignment_generation+1;
  else new.assignment_generation:=old.assignment_generation; end if;
  return new;
end $$;
create function app_private.motorist_task_assignment_after() returns trigger language plpgsql security definer set search_path='' as $$ begin
  if tg_op='UPDATE' and new.assignment_generation=old.assignment_generation and (new.status='done') is not distinct from (old.status='done') then return new; end if;
  update public.motorist_task_assignment_deliveries set status='cancelled',lease_id=null
    where task_id=new.id and status in ('pending','processing','failed') and (new.status='done' or generation<>new.assignment_generation);
  if tg_op='INSERT' or new.assignment_generation<>old.assignment_generation then perform app_private.motorist_ensure_assignment_event(new.id); end if;
  return new;
end $$;
create trigger motorist_task_assignment_before before insert or update on public.motorist_case_tasks for each row execute function app_private.motorist_task_assignment_before();
create trigger motorist_task_assignment_after after insert or update on public.motorist_case_tasks for each row execute function app_private.motorist_task_assignment_after();

create function public.motorist_ensure_task_assignment(p_organization_id uuid,p_task_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$ begin
  if not exists(select 1 from public.motorist_case_tasks t join public.motorist_organizations o on o.id=t.organization_id and o.active where t.id=p_task_id and t.organization_id=p_organization_id) then raise exception 'Task unavailable' using errcode='P0002'; end if;
  return app_private.motorist_ensure_assignment_event(p_task_id);
end $$;
create function public.motorist_claim_task_assignments(p_organization_id uuid,p_task_id uuid default null,p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  -- Stale audience work never becomes a push, including disabled organizations.
  update public.motorist_task_assignment_deliveries d set status='cancelled',lease_id=null
    where d.organization_id=p_organization_id and d.status in ('pending','processing')
      and not exists(select 1 from public.motorist_case_tasks t join public.motorist_profiles p on p.id=d.recipient_profile_id and p.organization_id=t.organization_id
        join public.motorist_organizations o on o.id=t.organization_id and o.active
        join public.motorist_notifications n on n.id=d.notification_id and n.status='unread'
        where t.id=d.task_id and t.organization_id=d.organization_id and t.status<>'done' and t.assignment_generation=d.generation
          and t.assigned_to=d.recipient_profile_id and p.active and p.role in ('dispatcher','senior_dispatcher','manager','admin'));
  update public.motorist_task_assignment_deliveries set status='failed',lease_id=null
    where organization_id=p_organization_id and status='processing' and attempts>=5 and claimed_at<clock_timestamp()-interval '10 minutes';
  with candidates as (
    select d.notification_id from public.motorist_task_assignment_deliveries d
    where d.organization_id=p_organization_id and (p_task_id is null or d.task_id=p_task_id)
      and ((d.status='pending' and d.available_at<=clock_timestamp()) or (d.status='processing' and d.claimed_at<clock_timestamp()-interval '10 minutes'))
      and d.attempts<5 order by d.available_at,d.notification_id for update skip locked limit greatest(0,least(p_limit,50))
  ), claimed as (
    update public.motorist_task_assignment_deliveries d set status='processing',attempts=d.attempts+1,lease_id=gen_random_uuid(),claimed_at=clock_timestamp()
      from candidates c where d.notification_id=c.notification_id returning d.*
  ) select coalesce(jsonb_agg(jsonb_build_object('notificationId',c.notification_id,'taskId',c.task_id,'recipientProfileId',c.recipient_profile_id,'leaseId',c.lease_id,'title',n.title,'body',n.body)),'[]'::jsonb)
    into result from claimed c join public.motorist_notifications n on n.id=c.notification_id;
  return result;
end $$;
create function public.motorist_finish_task_assignment(p_organization_id uuid,p_notification_id uuid,p_lease_id uuid,p_success boolean) returns boolean
language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
  update public.motorist_task_assignment_deliveries set status=case when p_success then 'sent' when attempts>=5 then 'failed' else 'pending' end,
    available_at=clock_timestamp()+make_interval(mins=>least(60,power(2,attempts)::integer)),lease_id=null
    where organization_id=p_organization_id and notification_id=p_notification_id and lease_id=p_lease_id and status='processing';
  get diagnostics affected=row_count; return affected=1;
end $$;
revoke all on function app_private.motorist_ensure_assignment_event(uuid),app_private.motorist_task_assignment_before(),app_private.motorist_task_assignment_after() from public,anon,authenticated,service_role;
revoke all on function public.motorist_ensure_task_assignment(uuid,uuid),public.motorist_claim_task_assignments(uuid,uuid,integer),public.motorist_finish_task_assignment(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.motorist_ensure_task_assignment(uuid,uuid),public.motorist_claim_task_assignments(uuid,uuid,integer),public.motorist_finish_task_assignment(uuid,uuid,uuid,boolean) to service_role;

commit;
