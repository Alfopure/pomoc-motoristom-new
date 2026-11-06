-- Optional employee task tools. All business writes and outbox entries are one
-- transaction; direct table access stays private and the single existing cron
-- calls the bounded tick/cleanup functions below. No data backfill or seed.
begin;

alter table public.motorist_case_tasks
 add column employee_extensions boolean not null default false,
 add column checklist jsonb not null default '[]'::jsonb check(jsonb_typeof(checklist)='array' and jsonb_array_length(checklist)<=50),
 add column recurrence_id uuid,
 add column recurrence_local_date date;

create table public.motorist_task_recurrences(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.motorist_organizations(id),
 created_by_user_id uuid not null,source_task_id uuid not null,
 frequency text not null check(frequency in ('daily','weekly')),local_time time not null,
 weekday integer check(weekday between 1 and 7),time_zone text not null,
 state text not null default 'active' check(state in ('active','paused','needs_attention')),
 revision integer not null default 1 check(revision>0),
 issue text check(issue in('creator_inactive','recipient_unavailable')),
 next_at timestamptz,last_error text,template jsonb not null,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id),check((frequency='weekly')=(weekday is not null))
);
alter table public.motorist_case_tasks add constraint motorist_task_recurrence_fk
 foreign key(organization_id,recurrence_id)references public.motorist_task_recurrences(organization_id,id);
create unique index motorist_task_recurrence_occurrence_idx on public.motorist_case_tasks(organization_id,recurrence_id,recurrence_local_date)where recurrence_id is not null;
create index motorist_task_recurrences_due_idx on public.motorist_task_recurrences(organization_id,next_at)where state='active';
create index motorist_task_employee_due_idx on public.motorist_case_tasks(organization_id,due_at,id)where status<>'done' and due_at is not null;

create table public.motorist_task_attachments(
 id uuid primary key,organization_id uuid not null references public.motorist_organizations(id),task_id uuid not null,
 created_by_user_id uuid not null,file_name text not null check(length(file_name)between 1 and 200 and octet_length(file_name)<=240),
 mime_type text not null check(mime_type in ('image/jpeg','image/png')),
 size_bytes integer not null check(size_bytes between 1 and 8388608),
 bucket text not null default 'motorist-task-photos' check(bucket='motorist-task-photos'),
 path text not null unique,status text not null default 'pending' check(status in ('pending','ready','removed')),
 created_at timestamptz not null default clock_timestamp(),ready_at timestamptz,storage_deleted_at timestamptz,upload_valid_until timestamptz
);
create index motorist_task_attachments_task_idx on public.motorist_task_attachments(organization_id,task_id,created_at);
create index motorist_task_attachments_cleanup_idx on public.motorist_task_attachments(organization_id,created_at)where storage_deleted_at is null;
create table public.motorist_task_employee_reminder_runs(
 organization_id uuid not null,task_id uuid not null,reminder_generation integer not null,
 materialized_at timestamptz not null default clock_timestamp(),primary key(organization_id,task_id,reminder_generation),
 foreign key(task_id,organization_id)references public.motorist_case_tasks(id,organization_id)on delete cascade
);
alter table public.motorist_task_recurrences enable row level security;
alter table public.motorist_task_attachments enable row level security;
alter table public.motorist_task_employee_reminder_runs enable row level security;
revoke all on public.motorist_task_recurrences,public.motorist_task_attachments,public.motorist_task_employee_reminder_runs from public,anon,authenticated,service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('motorist-task-photos','motorist-task-photos',false,8388608,array['image/jpeg','image/png'])
 on conflict(id)do nothing;
do $$begin
 if not exists(select 1 from storage.buckets where id='motorist-task-photos' and not public
  and file_size_limit=8388608 and allowed_mime_types=array['image/jpeg','image/png'])then
  raise exception 'Existing task photo bucket configuration differs';
 end if;
end $$;
-- Existing permissive Storage policies must not grant direct access to this
-- bucket. Upload tokens and server-authorized reads use the trusted API path.
create policy motorist_task_photos_proxy_only on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id<>'motorist-task-photos')with check(bucket_id<>'motorist-task-photos');



-- Keep an upload tombstone after task deletion so Storage cleanup can still
-- remove its private object; a cascading metadata delete would lose the path.
create function app_private.employee_task_deleted()returns trigger language plpgsql security definer set search_path='' as $$begin
 update public.motorist_task_attachments set status='removed'where organization_id=old.organization_id and task_id=old.id and status<>'removed';
 update public.motorist_task_recurrences set state='paused',next_at=null,issue=null,revision=revision+1,updated_at=clock_timestamp()
  where organization_id=old.organization_id and source_task_id=old.id and state<>'paused';
 return old;
end $$;
create trigger motorist_task_employee_extensions_deleted before delete on public.motorist_case_tasks for each row execute function app_private.employee_task_deleted();

create function app_private.employee_task_timezone(org uuid)returns text language plpgsql stable security definer set search_path='' as $$
declare zone text;
begin
 select p.timezone into zone from public.motorist_organization_profiles p where p.organization_id=org;
 if zone is null then zone:='Europe/Bratislava';end if;
 if not exists(select 1 from pg_catalog.pg_timezone_names where name=zone)then raise exception 'Organization timezone unavailable'using errcode='55000';end if;
 return zone;
end $$;

create function app_private.employee_task_checklist(items jsonb)returns jsonb language plpgsql immutable set search_path='' as $$
declare item jsonb;result jsonb:='[]';ids uuid[]:='{}';item_id uuid;title text;
begin
 if jsonb_typeof(items)is distinct from 'array' or jsonb_array_length(items)>50 then raise exception 'Invalid task checklist'using errcode='22023';end if;
 for item in select value from jsonb_array_elements(items)loop
  if jsonb_typeof(item)is distinct from 'object' or jsonb_typeof(item->'title')is distinct from 'string'
   or jsonb_typeof(item->'done')is distinct from 'boolean' or exists(select 1 from jsonb_object_keys(item)k where k not in ('id','title','done'))then raise exception 'Invalid checklist item'using errcode='22023';end if;
  begin item_id:=(item->>'id')::uuid;exception when others then raise exception 'Invalid checklist item ID'using errcode='22023';end;
  title:=btrim(item->>'title');
  if item_id is null or item_id=any(ids) or length(title)not between 1 and 300 then raise exception 'Invalid checklist item'using errcode='22023';end if;
  ids:=array_append(ids,item_id);result:=result||jsonb_build_array(jsonb_build_object('id',item_id,'title',title,'done',(item->>'done')::boolean));
 end loop;
 return result;
end $$;

-- An occurrence is keyed by its local calendar day. PostgreSQL's timezone
-- conversion resolves DST gaps/overlaps deterministically; a unique index is the
-- final protection against a repeated local hour or concurrent cron invocation.
create function app_private.employee_task_recurrence_at(frequency text,local_time time,weekday integer,zone text,anchor timestamptz,next boolean)
returns timestamptz language plpgsql stable set search_path='' as $$
declare local_day date:=(anchor at time zone zone)::date;candidate timestamptz;day date;i integer;
begin
 for i in 0..7 loop
  day:=local_day+case when next then i else -i end;
  if frequency='daily' or extract(isodow from day)::integer=weekday then
   candidate:=(day+local_time)at time zone zone;
   if (next and candidate>anchor)or(not next and candidate<=anchor)then return candidate;end if;
  end if;
 end loop;
 raise exception 'Recurrence schedule unavailable'using errcode='22023';
end $$;
create function app_private.employee_task_recurrence_next(org uuid,series uuid,frequency text,local_time time,weekday integer,zone text,anchor timestamptz)
returns timestamptz language plpgsql stable security definer set search_path='' as $$declare candidate timestamptz:=anchor;i integer;begin
 for i in 0..366 loop
  candidate:=app_private.employee_task_recurrence_at(frequency,local_time,weekday,zone,candidate,true);
  if not exists(select 1 from public.motorist_case_tasks where organization_id=org and recurrence_id=series and recurrence_local_date=(candidate at time zone zone)::date)then return candidate;end if;
 end loop;
 raise exception 'Recurrence calendar exhausted'using errcode='22023';
end $$;

create function app_private.employee_task_series_editor(t public.motorist_case_tasks,usr uuid)returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from app_private.employee_task_people(t.organization_id,usr)p where p.user_id=usr and
  (p.administrator or app_private.employee_task_lead(t.organization_id,usr,t.assigned_group_id)
   or usr=coalesce((select r.created_by_user_id from public.motorist_task_recurrences r where r.id=t.recurrence_id and r.organization_id=t.organization_id),app_private.employee_task_creator(t))))
$$;
alter function app_private.employee_task_permissions(public.motorist_case_tasks,uuid)rename to employee_task_permissions_before_extensions;
create function app_private.employee_task_permissions(t public.motorist_case_tasks,usr uuid)returns jsonb
language sql stable security definer set search_path='' as $$
 select app_private.employee_task_permissions_before_extensions(t,usr)||jsonb_build_object(
  'editChecklist',t.status<>'done' and coalesce((app_private.employee_task_permissions_before_extensions(t,usr)->>'assign')::boolean,false),
  'manageRecurrence',app_private.employee_task_can_read(t,usr) and app_private.employee_task_series_editor(t,usr),
  'attach',app_private.employee_task_can_read(t,usr))
$$;
alter function app_private.employee_task_dto(public.motorist_case_tasks,uuid)rename to employee_task_dto_before_extensions;
create function app_private.employee_task_dto(t public.motorist_case_tasks,usr uuid)returns jsonb
language sql stable security definer set search_path='' as $$
 select app_private.employee_task_dto_before_extensions(t,usr)||jsonb_build_object(
 'checklist',t.checklist,
 'recurrence',(select jsonb_build_object('id',r.id,'frequency',r.frequency,'time',to_char(r.local_time,'HH24:MI'),
  'weekday',r.weekday,'timeZone',r.time_zone,'state',r.state,'nextAt',r.next_at,'revision',r.revision,'issue',r.issue)
  from public.motorist_task_recurrences r where r.organization_id=t.organization_id and r.id=t.recurrence_id),
 'attachments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'fileName',a.file_name,'mimeType',a.mime_type,'sizeBytes',a.size_bytes,'createdAt',a.created_at,
  'canRemove',a.created_by_user_id=usr or app_private.employee_task_creator(t)=usr or exists(select 1 from app_private.employee_task_people(t.organization_id,usr)p where p.administrator))order by a.created_at,a.id)
  from public.motorist_task_attachments a where a.organization_id=t.organization_id and a.task_id=t.id and a.status='ready'),'[]'))
$$;

-- New employee tasks use one reminder/assignment pipeline. Existing tasks keep
-- their saved legacy office scheduling without a migration-time backfill.
create function app_private.employee_task_extensions_before()returns trigger language plpgsql set search_path='' as $$begin
 if current_setting('app.employee_task_extensions',true)='v1'then new.employee_extensions:=true;end if;
 return new;
end $$;
create trigger motorist_task_001_employee_extensions before insert on public.motorist_case_tasks for each row execute function app_private.employee_task_extensions_before();
create function app_private.employee_task_checklist_complete()returns trigger language plpgsql set search_path='' as $$begin
 if new.status='done'and old.status<>'done'and exists(select 1 from jsonb_array_elements(new.checklist)item where not(item->>'done')::boolean)
  and current_setting('app.employee_task_checklist_override',true)is distinct from 'v1'then raise exception 'Checklist has unfinished items'using errcode='PT409';end if;
 return new;
end $$;
create trigger motorist_task_002_checklist_complete before update on public.motorist_case_tasks for each row execute function app_private.employee_task_checklist_complete();
alter function app_private.motorist_schedule_task_generation(uuid,text[],uuid)rename to motorist_schedule_task_generation_before_extensions;
create function app_private.motorist_schedule_task_generation(p_task_id uuid,p_channels text[],p_actor_id uuid default null)returns void
language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from public.motorist_case_tasks where id=p_task_id and employee_extensions)then return;end if;
 perform app_private.motorist_schedule_task_generation_before_extensions(p_task_id,p_channels,p_actor_id);
end $$;
alter function app_private.motorist_ensure_assignment_event(uuid)rename to motorist_ensure_assignment_event_before_extensions;
create function app_private.motorist_ensure_assignment_event(p_task_id uuid)returns jsonb language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from public.motorist_case_tasks where id=p_task_id and employee_extensions)then return null;end if;
 return app_private.motorist_ensure_assignment_event_before_extensions(p_task_id);
end $$;

alter table public.motorist_push_outbox drop constraint motorist_push_outbox_type_check;
alter table public.motorist_push_outbox add constraint motorist_push_outbox_type_check check(type in ('work','branch','tasks','task_due'));
alter table public.motorist_push_outbox drop constraint motorist_push_outbox_subject_type_check;
alter table public.motorist_push_outbox add constraint motorist_push_outbox_subject_type_check check(subject_type in ('operation','towing','branch_request','employee_task'));
alter table public.motorist_push_outbox add column recipient_user_id uuid;

create function app_private.employee_task_recipients(t public.motorist_case_tasks)returns table(user_id uuid,profile_id uuid,member_id uuid)
language sql stable security definer set search_path='' as $$
 select p.user_id,p.profile_id,p.member_id from app_private.employee_task_people(t.organization_id)p where
  p.user_id=app_private.employee_task_assignee(t)or(app_private.employee_task_assignee(t)is null and app_private.employee_task_lead(t.organization_id,p.user_id,t.assigned_group_id))
$$;
create function app_private.employee_task_target_available(org uuid,target jsonb)returns boolean language sql stable security definer set search_path='' as $$
 select case target->>'kind'when 'person'then exists(select 1 from app_private.employee_task_people(org,(target->>'userId')::uuid))
  when 'group'then app_private.employee_task_group_available(org,(target->>'groupId')::uuid)else false end
$$;
create function app_private.employee_task_notify(t public.motorist_case_tasks,actor uuid,event text,generation bigint,include_creator boolean default false,event_key text default null)
returns void language plpgsql security definer set search_path='' as $$
declare recipient record;kind text:=case when event='employee_task_due'then 'task_due'else 'tasks'end;title text;
begin
 title:=case event when 'employee_task_due'then 'Pripomienka úlohy'when 'employee_task_comment'then 'Nový komentár k úlohe'else 'Nová úloha'end;
 for recipient in select distinct p.user_id,p.profile_id,p.member_id from app_private.employee_task_people(t.organization_id)p
  where p.user_id is distinct from actor and(p.user_id in(select r.user_id from app_private.employee_task_recipients(t)r)
   or(include_creator and p.user_id=app_private.employee_task_creator(t)))loop
  perform app_private.push_enqueue(t.organization_id,case when recipient.profile_id is null then recipient.member_id end,recipient.profile_id,kind,event,'employee_task',t.id,
   event||':'||t.id||':'||coalesce(event_key,generation::text)||':'||recipient.user_id,title,case when event='employee_task_comment'then 'V úlohe pribudol komentár.'when event='employee_task_due'then 'Úloha s termínom čaká na vybavenie.'else 'Máte úlohu na vybavenie.'end,generation);
  update public.motorist_push_outbox set recipient_user_id=recipient.user_id where organization_id=t.organization_id
   and dedupe_key=employee_task_notify.event||':'||t.id||':'||coalesce(event_key,generation::text)||':'||recipient.user_id and recipient_user_id is null;
 end loop;
end $$;
create function app_private.employee_task_assignment_notice()returns trigger language plpgsql security definer set search_path='' as $$declare actor uuid;begin
 if not new.employee_extensions then return new;end if;
 if tg_op='UPDATE'and new.assignment_generation=old.assignment_generation then return new;end if;
 begin actor:=nullif(current_setting('app.employee_task_actor',true),'')::uuid;exception when others then actor:=null;end;
 actor:=coalesce(actor,auth.uid(),case when tg_op='INSERT'then app_private.employee_task_creator(new)end);
 perform app_private.employee_task_notify(new,actor,'employee_task_assigned',new.assignment_generation);
 return new;
end $$;
create trigger motorist_task_employee_assignment_notice after insert or update on public.motorist_case_tasks for each row execute function app_private.employee_task_assignment_notice();
create function app_private.employee_task_comment_notice()returns trigger language plpgsql security definer set search_path='' as $$declare t public.motorist_case_tasks;begin
 -- Review-generated messages already have their explicit workflow notice.
 if current_setting('app.task_workflow_write',true)='v1'and coalesce(current_setting('app.employee_task_action',true),'')<>'comment'then return new;end if;
 select * into t from public.motorist_case_tasks where id=new.task_id and organization_id=new.organization_id;
 if found then perform app_private.employee_task_notify(t,coalesce(new.author_user_id,app_private.employee_task_user(new.organization_id,new.author_profile_id)),
  'employee_task_comment',t.revision,true,new.id::text);end if;
 return new;
end $$;
create trigger motorist_task_employee_comment_notice after insert on public.motorist_task_messages for each row execute function app_private.employee_task_comment_notice();
create function app_private.employee_task_review_notice()returns trigger language plpgsql security definer set search_path='' as $$
<<notice_values>>
declare recipient record;recipient_user uuid;actor uuid;event text;title text;body text;
begin
 if new.workflow_state='in_review'and(old.workflow_state is distinct from 'in_review'or new.review_generation<>old.review_generation)then
  event:='employee_task_review_requested';title:='Úloha na kontrolu';body:='Kolega vám poslal úlohu na kontrolu.';
  recipient_user:=app_private.employee_task_user(new.organization_id,new.reviewer_profile_id);
 elsif old.workflow_state='in_review'and new.workflow_state='in_progress'then
  event:='employee_task_review_returned';title:='Úloha vrátená na dopracovanie';body:='Kontrolór vám vrátil úlohu na dopracovanie.';
 elsif old.workflow_state='in_review'and new.status='done'then
  event:='employee_task_review_approved';title:='Úloha schválená';body:='Kontrola vašej úlohy bola schválená.';
 else return new;end if;
 if recipient_user is null then recipient_user:=coalesce(app_private.employee_task_assignee(new),new.review_requested_by_user_id,
  app_private.employee_task_user(new.organization_id,new.review_requested_by),app_private.employee_task_creator(new));end if;
 select * into recipient from app_private.employee_task_people(new.organization_id,recipient_user)where user_id=recipient_user;
 if not found then return new;end if;
 -- Existing office tasks keep their legacy web push path. The canonical route
 -- also covers older tasks whose current recipient has no office identity or
 -- no legacy assignee mirror; otherwise old web outcomes would miss field users.
 if not new.employee_extensions and nullif(current_setting('app.employee_task_actor',true),'')is null and recipient.profile_id is not null
  and(event='employee_task_review_requested'or new.assigned_user_id is null or new.assigned_to is not null)then return new;end if;
 begin actor:=nullif(current_setting('app.employee_task_actor',true),'')::uuid;exception when others then actor:=null;end;
 actor:=coalesce(actor,auth.uid(),case when event='employee_task_review_requested'then coalesce(new.review_requested_by_user_id,app_private.employee_task_user(new.organization_id,new.review_requested_by))
  else app_private.employee_task_user(new.organization_id,new.reviewer_profile_id)end);
 if recipient_user is not null and recipient_user is distinct from actor then
   perform app_private.push_enqueue(new.organization_id,case when recipient.profile_id is null then recipient.member_id end,recipient.profile_id,'tasks',event,'employee_task',new.id,
    event||':'||new.id||':'||new.review_generation||':'||recipient_user,title,body,new.review_generation);
   update public.motorist_push_outbox set recipient_user_id=recipient_user where organization_id=new.organization_id
    and dedupe_key=notice_values.event||':'||new.id||':'||new.review_generation||':'||recipient_user and recipient_user_id is null;
 end if;
 return new;
end $$;
create trigger motorist_task_employee_review_notice after update on public.motorist_case_tasks for each row execute function app_private.employee_task_review_notice();
create function app_private.employee_task_review_profile_notice_guard()returns trigger language plpgsql security definer set search_path='' as $$
declare t public.motorist_case_tasks;recipient uuid;profile uuid;
begin
 if coalesce(new.payload->>'source','')not in('task_review_return','task_review_approve')or new.task_id is null then return new;end if;
 select * into t from public.motorist_case_tasks where id=new.task_id and organization_id=new.organization_id;
 if not found then return new;end if;
 recipient:=app_private.employee_task_assignee(t);
 if recipient is not null then
  select p.profile_id into profile from app_private.employee_task_people(t.organization_id,recipient)p where p.user_id=recipient;
  -- The old profile workflow falls back to an office requestor/creator when a
  -- field assignee has no profile. Do not create that unrelated private notice.
  if profile is null or new.recipient_profile_id is distinct from profile then return null;end if;
 end if;
 return new;
end $$;
create trigger motorist_task_employee_review_profile_notice_guard before insert on public.motorist_notifications for each row execute function app_private.employee_task_review_profile_notice_guard();

alter function app_private.push_still_valid(public.motorist_push_outbox)rename to push_still_valid_before_employee_tasks;
create function app_private.push_still_valid(o public.motorist_push_outbox)returns boolean language sql stable security definer set search_path='' as $$
 select case when o.subject_type='employee_task'then exists(select 1 from public.motorist_case_tasks t
  join app_private.employee_task_people(o.organization_id,o.recipient_user_id)p on p.user_id=o.recipient_user_id
  where t.id=o.subject_id and t.organization_id=o.organization_id and app_private.employee_task_can_read(t,o.recipient_user_id)
   and((o.profile_id is not null and p.profile_id=o.profile_id)or(o.member_id is not null and p.member_id=o.member_id))
   and case when o.event='employee_task_comment'then o.recipient_user_id=app_private.employee_task_creator(t)
     or exists(select 1 from app_private.employee_task_recipients(t)r where r.user_id=o.recipient_user_id)
    when o.event='employee_task_review_requested'then t.status<>'done'and t.workflow_state='in_review'and t.review_generation=o.ref_generation
     and o.recipient_user_id=app_private.employee_task_user(t.organization_id,t.reviewer_profile_id)
    when o.event='employee_task_review_returned'then t.status<>'done'and t.workflow_state='in_progress'and t.review_generation=o.ref_generation
     and o.recipient_user_id=coalesce(app_private.employee_task_assignee(t),t.review_requested_by_user_id,app_private.employee_task_user(t.organization_id,t.review_requested_by),app_private.employee_task_creator(t))
    when o.event='employee_task_review_approved'then t.status='done'and t.workflow_state='done'and t.review_generation=o.ref_generation
     and o.recipient_user_id=coalesce(app_private.employee_task_assignee(t),t.review_requested_by_user_id,app_private.employee_task_user(t.organization_id,t.review_requested_by),app_private.employee_task_creator(t))
    when o.event='employee_task_due'then t.status<>'done'and t.reminder_generation=o.ref_generation
     and exists(select 1 from app_private.employee_task_recipients(t)r where r.user_id=o.recipient_user_id)
    else t.status<>'done'and t.assignment_generation=o.ref_generation
     and exists(select 1 from app_private.employee_task_recipients(t)r where r.user_id=o.recipient_user_id)end)
  else app_private.push_still_valid_before_employee_tasks(o)end
$$;

-- Preserve the existing lease and delivery policy; only enrich employee-task
-- claim rows with their canonical account and target kind.
create or replace function public.motorist_push_outbox_claim(p_organization_id uuid,p_limit integer default 50)returns jsonb language plpgsql security definer set search_path='' as $$
declare claimed jsonb;lease uuid:=gen_random_uuid();
begin
 update public.motorist_push_outbox set status='failed',outcome='lease_expired',finished_at=clock_timestamp(),lease_id=null,lease_until=null
  where organization_id=p_organization_id and status='sending'and lease_until<clock_timestamp();
 update public.motorist_push_outbox set status='failed',outcome='expired',finished_at=clock_timestamp()
  where organization_id=p_organization_id and status='pending'and created_at<now()-interval '1 day';
 update public.motorist_push_outbox set status='dropped',outcome='no_longer_valid',finished_at=clock_timestamp()
  where id in(select id from public.motorist_push_outbox o where o.organization_id=p_organization_id and o.status='pending'and not app_private.push_still_valid(o)
   order by o.created_at limit 500 for update skip locked);
 with due as(select id from public.motorist_push_outbox o where o.organization_id=p_organization_id and o.status='pending'and o.next_attempt_at<=clock_timestamp()
   -- The bounded stale-row sweep above may leave a larger backlog. Employee
   -- task access is checked again on each selected row, never only that sweep.
   and(o.subject_type<>'employee_task'or app_private.push_still_valid(o))
   order by o.created_at limit least(200,greatest(1,p_limit))for update skip locked),
 marked as(update public.motorist_push_outbox o set status='sending',attempts=o.attempts+1,lease_id=lease,lease_until=clock_timestamp()+interval '2 minutes'from due where o.id=due.id returning o.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'leaseId',lease_id,'memberId',member_id,'profileId',profile_id,'type',type,'event',event,'title',title,'body',body,
  'target',jsonb_build_object('kind',case subject_type when 'branch_request'then 'branch-request'when 'employee_task'then 'employee-task'else subject_type end,'id',subject_id))
  ||case when subject_type='employee_task'then jsonb_build_object('userId',recipient_user_id)else '{}'::jsonb end order by created_at),'[]')into claimed from marked;
 return claimed;
end;
$$;

create function app_private.employee_task_set_series(t public.motorist_case_tasks,usr uuid,schedule jsonb,expected_series_revision integer default null)returns public.motorist_case_tasks
language plpgsql security definer set search_path='' as $$
<<schedule_values>>
declare frequency text;local_time time;weekday integer;zone text;series uuid;template jsonb;updated public.motorist_case_tasks;existing public.motorist_task_recurrences;
begin
 if t.recurrence_id is not null then
  select * into existing from public.motorist_task_recurrences where id=t.recurrence_id and organization_id=t.organization_id for update;
  if not found then raise exception 'Task recurrence unavailable'using errcode='P0002';end if;
  if expected_series_revision is null or expected_series_revision<1 then raise exception 'Task recurrence revision required'using errcode='22023';end if;
  if expected_series_revision<>existing.revision then raise exception 'Task recurrence revision conflict'using errcode='PT409';end if;
 end if;
 if schedule='null'::jsonb or schedule is null then
  if t.recurrence_id is not null then update public.motorist_task_recurrences set state='paused',next_at=null,last_error=null,issue=null,revision=revision+1,updated_at=clock_timestamp()
   where id=t.recurrence_id and organization_id=t.organization_id;end if;
  return t;
 end if;
 if t.recurrence_id is not null and not exists(select 1 from app_private.employee_task_people(t.organization_id,existing.created_by_user_id))then
  raise exception 'Task recurrence owner inactive'using errcode='22023';
 end if;
 if t.recurrence_id is not null and not app_private.employee_task_target_available(t.organization_id,existing.template->'target')then
  raise exception 'Task recurrence recipient inactive'using errcode='22023';
 end if;
 if jsonb_typeof(schedule)is distinct from 'object' or exists(select 1 from jsonb_object_keys(schedule)k where k not in ('frequency','time','weekday'))
  or coalesce(schedule->>'frequency','')not in ('daily','weekly')or coalesce(schedule->>'time','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'then raise exception 'Invalid recurrence schedule'using errcode='22023';end if;
 frequency:=schedule->>'frequency';local_time:=(schedule->>'time')::time;
 if frequency='weekly'then
  if jsonb_typeof(schedule->'weekday')is distinct from 'number'or coalesce(schedule->>'weekday','')!~'^[1-7]$'then raise exception 'Invalid recurrence weekday'using errcode='22023';end if;
  weekday:=(schedule->>'weekday')::integer;
 elsif schedule->>'weekday'is not null then raise exception 'Daily recurrence has no weekday'using errcode='22023';end if;
 zone:=app_private.employee_task_timezone(t.organization_id);
 template:=jsonb_build_object('title',t.title,'description',t.description,'priority',t.priority,'caseId',t.case_id,
  'target',case when app_private.employee_task_assignee(t)is not null then jsonb_build_object('kind','person','userId',app_private.employee_task_assignee(t))
   else jsonb_build_object('kind','group','groupId',t.assigned_group_id)end,
  'checklist',coalesce((select jsonb_agg(item||jsonb_build_object('done',false))from jsonb_array_elements(t.checklist)item),'[]'));
 if t.recurrence_id is null and not app_private.employee_task_target_available(t.organization_id,template->'target')then
  raise exception 'Task recurrence recipient inactive'using errcode='22023';
 end if;
 if t.recurrence_id is null then
  insert into public.motorist_task_recurrences(organization_id,created_by_user_id,source_task_id,frequency,local_time,weekday,time_zone,next_at,template)
   values(t.organization_id,usr,t.id,frequency,local_time,weekday,zone,
    app_private.employee_task_recurrence_at(frequency,local_time,weekday,zone,greatest(clock_timestamp(),
     (((coalesce(t.due_at,t.created_at)at time zone zone)::date+1)::timestamp at time zone zone)-interval '1 microsecond'),true),template)returning id into series;
  update public.motorist_case_tasks set recurrence_id=series,recurrence_local_date=(coalesce(due_at,created_at)at time zone zone)::date where id=t.id returning * into updated;
 else
  update public.motorist_task_recurrences set frequency=schedule_values.frequency,local_time=schedule_values.local_time,
   weekday=schedule_values.weekday,time_zone=zone,state='active',last_error=null,issue=null,
   next_at=app_private.employee_task_recurrence_next(t.organization_id,t.recurrence_id,schedule_values.frequency,schedule_values.local_time,schedule_values.weekday,zone,clock_timestamp()),
   revision=revision+1,updated_at=clock_timestamp()where id=t.recurrence_id and organization_id=t.organization_id;
  updated:=t;
 end if;
 return updated;
end $$;

alter function public.motorist_employee_tasks(uuid,uuid,text,uuid,jsonb)rename to motorist_employee_tasks_before_extensions;
alter function public.motorist_employee_tasks_before_extensions(uuid,uuid,text,uuid,jsonb)set schema app_private;
create function public.motorist_employee_tasks(p_user_id uuid,p_organization_id uuid,p_action text,p_task_id uuid default null,p_input jsonb default '{}')returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor record;t public.motorist_case_tasks;prior public.motorist_task_employee_commands;photo public.motorist_task_attachments;
 result jsonb;request jsonb;command uuid;action text;is_replay boolean;items jsonb;upload jsonb;
 previous_write text;previous_employee text;previous_extensions text;previous_checklist text;previous_actor text;previous_action text;
 view_name text:=coalesce(p_input->>'view','mine');category text:=coalesce(p_input->>'category','open');q text:=coalesce(p_input->>'q','');
 due_filter text:=coalesce(p_input->>'dueFilter','all');zone text;anchor timestamptz:=clock_timestamp();today date;day_start timestamptz;day_end timestamptz;
 cursor_data jsonb;before_at timestamptz;before_id uuid;page_limit integer;row_count integer;rows jsonb;next_cursor text;lead_groups uuid[];
 attachment_id uuid;file_name text;mime text;size integer;expected_series_revision integer;
begin
 if p_input is null or jsonb_typeof(p_input)<>'object'or length(p_input::text)>70000 then raise exception 'Invalid employee task input'using errcode='22023';end if;
 select * into actor from app_private.employee_task_people(p_organization_id,p_user_id)where user_id=p_user_id;
 if not found then raise exception 'Employee task access denied'using errcode='42501';end if;
 if not exists(select 1 from public.motorist_task_workspace_settings s where s.organization_id=p_organization_id and s.enabled
  and s.writer_inventory_verified_at is not null and coalesce(length(trim(s.writer_inventory_note)),0)>0)then raise exception 'Task workspace activation required'using errcode='55000';end if;
 zone:=app_private.employee_task_timezone(p_organization_id);
 if p_action='directory'then return app_private.motorist_employee_tasks_before_extensions(p_user_id,p_organization_id,p_action,p_task_id,p_input)||jsonb_build_object('timeZone',zone);end if;
 if p_action='list'then
  if view_name not in ('mine','branch','created','review')or category not in ('open','done','all')or due_filter not in ('all','today','overdue')or length(q)>200
   or(p_input?'limit'and(jsonb_typeof(p_input->'limit')<>'number'or(p_input->>'limit')!~'^[0-9]{1,2}$'))then raise exception 'Invalid task filters'using errcode='22023';end if;
  page_limit:=coalesce((p_input->>'limit')::integer,25);if page_limit not between 1 and 50 then raise exception 'Invalid page size'using errcode='22023';end if;
  today:=(anchor at time zone zone)::date;
  if nullif(p_input->>'cursor','')is not null then
   if length(p_input->>'cursor')>4096 then raise exception 'Invalid task cursor'using errcode='22023';end if;
   begin cursor_data:=(p_input->>'cursor')::jsonb;before_at:=(cursor_data->>'at')::timestamptz;before_id:=(cursor_data->>'id')::uuid;
    if cursor_data?'filterAt'then anchor:=(cursor_data->>'filterAt')::timestamptz;end if;
   exception when others then raise exception 'Invalid task cursor'using errcode='22023';end;
   if cursor_data->>'org'is distinct from p_organization_id::text or cursor_data->>'user'is distinct from p_user_id::text
    or cursor_data->>'view'is distinct from view_name or cursor_data->>'category'is distinct from category or cursor_data->>'q'is distinct from q
    or coalesce(cursor_data->>'dueFilter','all')<>due_filter or(due_filter<>'all'and(cursor_data->>'zone'is distinct from zone
     or cursor_data->>'day'is distinct from today::text or not isfinite(anchor)))or before_at is null or before_id is null then raise exception 'Task cursor scope mismatch'using errcode='22023';end if;
  end if;
  day_start:=today::timestamp at time zone zone;day_end:=(today+1)::timestamp at time zone zone;
  select coalesce(array_agg(g.id),'{}'::uuid[])into lead_groups from public.motorist_work_groups g
   join public.motorist_work_group_members gm on gm.organization_id=g.organization_id and gm.group_id=g.id
   where g.organization_id=p_organization_id and g.active and gm.member_id=actor.member_id and gm.role='lead';
  with page as(select x as task,x.updated_at,x.id from public.motorist_case_tasks x where x.organization_id=p_organization_id
   and(actor.office or app_private.employee_task_assignee(x)=p_user_id or app_private.employee_task_creator(x)=p_user_id
    or app_private.employee_task_user(p_organization_id,x.reviewer_profile_id)=p_user_id or x.assigned_group_id=any(lead_groups))
   and((view_name='mine'and app_private.employee_task_assignee(x)=p_user_id)or(view_name='created'and app_private.employee_task_creator(x)=p_user_id)
    or(view_name='review'and app_private.employee_task_user(p_organization_id,x.reviewer_profile_id)=p_user_id)or(view_name='branch'and x.assigned_group_id=any(lead_groups)))
   and(category='all'or(category='done')=(x.status='done'))and strpos(lower(x.title),lower(q))>0
   and(due_filter='all'or(x.status<>'done'and((due_filter='today'and x.due_at>=day_start and x.due_at<day_end)or(due_filter='overdue'and x.due_at<anchor))))
   and(before_at is null or(x.updated_at,x.id)<(before_at,before_id))order by x.updated_at desc,x.id desc limit page_limit+1)
  select count(*),coalesce(jsonb_agg(app_private.employee_task_dto(p.task,p_user_id)order by p.updated_at desc,p.id desc)filter(where n<=page_limit),'[]')into row_count,rows
   from(select page.*,row_number()over(order by updated_at desc,id desc)n from page)p;
  if row_count>page_limit then next_cursor:=jsonb_build_object('org',p_organization_id,'user',p_user_id,'view',view_name,'category',category,'q',q,
   'dueFilter',due_filter,'zone',zone,'day',today,'filterAt',anchor,'at',rows->-1->>'updatedAt','id',rows->-1->>'id')::text;end if;
  return jsonb_build_object('view',view_name,'tasks',rows,'nextCursor',next_cursor,'timeZone',zone,'dueFilter',due_filter);
 end if;
 if p_action='get'then return app_private.motorist_employee_tasks_before_extensions(p_user_id,p_organization_id,p_action,p_task_id,p_input);end if;
 if p_action in('attachment','attachment_upload')then
  select * into t from public.motorist_case_tasks where id=p_task_id and organization_id=p_organization_id for update;
  if not found or not app_private.employee_task_can_read(t,p_user_id)then raise exception 'Task unavailable'using errcode='P0002';end if;
  begin attachment_id:=(p_input->>'attachmentId')::uuid;exception when others then raise exception 'Invalid attachment'using errcode='22023';end;
  select * into photo from public.motorist_task_attachments where id=attachment_id and task_id=t.id and organization_id=p_organization_id
   and status<>'removed'and(status='ready'or(created_by_user_id=p_user_id and created_at>clock_timestamp()-interval '24 hours'))for update;
  if not found then raise exception 'Attachment unavailable'using errcode='P0002';end if;
  if p_action='attachment_upload'then
   if photo.status<>'pending'or photo.created_by_user_id<>p_user_id or photo.created_at<=clock_timestamp()-interval '24 hours'then raise exception 'Attachment upload unavailable'using errcode='P0002';end if;
   -- Supabase signed upload tokens live for two hours. Reserve three hours
   -- under this row lock before the server issues one, covering signing races.
   update public.motorist_task_attachments set upload_valid_until=greatest(coalesce(upload_valid_until,clock_timestamp()),clock_timestamp()+interval '3 hours')where id=photo.id returning * into photo;
   return jsonb_build_object('attachmentUpload',jsonb_build_object('id',photo.id,'bucket',photo.bucket,'path',photo.path,'fileName',photo.file_name,'mimeType',photo.mime_type,'sizeBytes',photo.size_bytes,'createdAt',photo.created_at,'status','pending'));
  end if;
  return jsonb_build_object('attachment',jsonb_build_object('id',photo.id,'bucket',photo.bucket,'path',photo.path,'fileName',photo.file_name,
   'mimeType',photo.mime_type,'sizeBytes',photo.size_bytes,'status',photo.status,'createdByUserId',photo.created_by_user_id,'createdAt',photo.created_at));
 end if;
 if p_action not in ('create','command')then raise exception 'Invalid employee task action'using errcode='22023';end if;
 begin command:=(p_input->>'commandId')::uuid;exception when others then raise exception 'Invalid task command ID'using errcode='22023';end;
 if command is null then raise exception 'Task command ID required'using errcode='22023';end if;
 action:=p_input->>'action';
 request:=jsonb_build_object('action',p_action,'taskId',p_task_id,'input',p_input);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text||':'||p_user_id::text||':'||command::text,0));
 select * into prior from public.motorist_task_employee_commands c where c.organization_id=p_organization_id and c.actor_user_id=p_user_id and c.command_id=command;
 is_replay:=found;
 if is_replay then
  if prior.request<>request then raise exception 'Task command ID reused'using errcode='PT409';end if;
  select * into t from public.motorist_case_tasks where id=prior.task_id and organization_id=p_organization_id;
  if not found or not app_private.employee_task_can_read(t,p_user_id)then raise exception 'Task unavailable'using errcode='P0002';end if;
  result:=jsonb_build_object('commandId',command,'committedRevision',prior.committed_revision,'task',app_private.employee_task_dto(t,p_user_id));
  if action in ('attachment_prepare','attachment_remove')then
   select * into photo from public.motorist_task_attachments where id=(p_input->>'attachmentId')::uuid and organization_id=p_organization_id and task_id=t.id;
   if action='attachment_prepare'and(photo.status<>'pending'or photo.created_at<=clock_timestamp()-interval '24 hours')then raise exception 'Attachment upload unavailable'using errcode='P0002';end if;
   if found then result:=result||jsonb_build_object('attachmentUpload',jsonb_build_object('id',photo.id,'bucket',photo.bucket,'path',photo.path,'fileName',photo.file_name,'mimeType',photo.mime_type,'sizeBytes',photo.size_bytes,'createdAt',photo.created_at));end if;
  end if;
  return result;
 end if;
 if p_action='create'then items:=app_private.employee_task_checklist(coalesce(p_input->'checklist','[]'));end if;
 if p_action='command'then
  select * into t from public.motorist_case_tasks where id=p_task_id and organization_id=p_organization_id for update;
  if not found or not app_private.employee_task_can_read(t,p_user_id)then raise exception 'Task unavailable'using errcode='P0002';end if;
  if jsonb_typeof(p_input->'expectedRevision')is distinct from 'number'or coalesce(p_input->>'expectedRevision','')!~'^[1-9][0-9]{0,9}$'
   or(p_input->>'expectedRevision')::numeric>2147483647 then raise exception 'Invalid task revision'using errcode='22023';end if;
  if(p_input->>'expectedRevision')::integer<>t.revision then raise exception 'Task revision conflict'using errcode='PT409';end if;
  if action in ('complete','approve')and exists(select 1 from jsonb_array_elements(t.checklist)item where not(item->>'done')::boolean)
   and p_input->'allowIncompleteChecklist'is distinct from 'true'::jsonb then raise exception 'Checklist has unfinished items'using errcode='PT409';end if;
 end if;
 previous_write:=current_setting('app.task_workspace_write',true);previous_employee:=current_setting('app.employee_task_write',true);previous_extensions:=current_setting('app.employee_task_extensions',true);previous_checklist:=current_setting('app.employee_task_checklist_override',true);previous_actor:=current_setting('app.employee_task_actor',true);previous_action:=current_setting('app.employee_task_action',true);
 perform set_config('app.task_workspace_write','v1',true);perform set_config('app.employee_task_write','v1',true);
 perform set_config('app.employee_task_actor',p_user_id::text,true);perform set_config('app.employee_task_action',coalesce(action,'create'),true);
 if action in('complete','approve')and p_input->'allowIncompleteChecklist'='true'::jsonb then perform set_config('app.employee_task_checklist_override','v1',true);end if;
 if p_action='create'then
  perform set_config('app.employee_task_extensions','v1',true);
  result:=app_private.motorist_employee_tasks_before_extensions(p_user_id,p_organization_id,p_action,p_task_id,p_input);
  select * into t from public.motorist_case_tasks where id=(result->'task'->>'id')::uuid;
  if jsonb_array_length(items)>0 then update public.motorist_case_tasks set checklist=items where id=t.id returning * into t;end if;
  if p_input->'recurrence'is not null and p_input->'recurrence'<>'null'::jsonb then t:=app_private.employee_task_set_series(t,p_user_id,p_input->'recurrence');end if;
  perform app_private.employee_task_notify(t,p_user_id,'employee_task_assigned',t.assignment_generation);
 elsif action in ('checklist','recurrence','attachment_prepare','attachment_finish','attachment_remove')then
  if action='checklist'then
   if not coalesce((app_private.employee_task_permissions(t,p_user_id)->>'editChecklist')::boolean,false)then raise exception 'Task action denied'using errcode='42501';end if;
   items:=app_private.employee_task_checklist(p_input->'items');update public.motorist_case_tasks set checklist=items where id=t.id returning * into t;
  elsif action='recurrence'then
   if not app_private.employee_task_series_editor(t,p_user_id)then raise exception 'Task action denied'using errcode='42501';end if;
   if not p_input?'schedule'then raise exception 'Recurrence schedule required'using errcode='22023';end if;
   if p_input?'expectedSeriesRevision'then
    if jsonb_typeof(p_input->'expectedSeriesRevision')is distinct from 'number'or coalesce(p_input->>'expectedSeriesRevision','')!~'^[1-9][0-9]{0,9}$'
     or(p_input->>'expectedSeriesRevision')::numeric>2147483647 then raise exception 'Invalid task recurrence revision'using errcode='22023';end if;
    expected_series_revision:=(p_input->>'expectedSeriesRevision')::integer;
   end if;
   t:=app_private.employee_task_set_series(t,p_user_id,p_input->'schedule',expected_series_revision);update public.motorist_case_tasks set updated_at=clock_timestamp()where id=t.id returning * into t;
  else
   begin attachment_id:=(p_input->>'attachmentId')::uuid;exception when others then raise exception 'Invalid attachment ID'using errcode='22023';end;
   if attachment_id is null then raise exception 'Attachment ID required'using errcode='22023';end if;
   if action='attachment_prepare'then
    file_name:=btrim(p_input->>'fileName');mime:=p_input->>'mimeType';
    if jsonb_typeof(p_input->'fileName')is distinct from 'string'or length(file_name)not between 1 and 200 or octet_length(file_name)>240 or file_name~'[[:cntrl:]/\\]'or coalesce(mime,'')not in ('image/jpeg','image/png')
     or jsonb_typeof(p_input->'sizeBytes')is distinct from 'number'or coalesce(p_input->>'sizeBytes','')!~'^[1-9][0-9]{0,7}$'then raise exception 'Invalid photo upload'using errcode='22023';end if;
    size:=(p_input->>'sizeBytes')::integer;if size>8388608 then raise exception 'Photo too large'using errcode='22023';end if;
    if exists(select 1 from public.motorist_task_attachments where id=attachment_id)then raise exception 'Attachment ID reused'using errcode='PT409';end if;
    if(select count(*)from public.motorist_task_attachments where task_id=t.id and(status='ready'or(status='pending'and created_at>clock_timestamp()-interval '24 hours')))>=10 then raise exception 'Task photo limit reached'using errcode='22023';end if;
    insert into public.motorist_task_attachments(id,organization_id,task_id,created_by_user_id,file_name,mime_type,size_bytes,path)
     values(attachment_id,p_organization_id,t.id,p_user_id,file_name,mime,size,p_organization_id||'/'||t.id||'/'||attachment_id||case when mime='image/png'then '.png'else '.jpg'end)returning * into photo;
   else
    select * into photo from public.motorist_task_attachments where id=attachment_id and organization_id=p_organization_id and task_id=t.id for update;
    if not found or photo.status='removed'then raise exception 'Attachment unavailable'using errcode='P0002';end if;
    if action='attachment_finish'then
     if photo.created_by_user_id<>p_user_id or(photo.status='pending'and photo.created_at<=clock_timestamp()-interval '24 hours')then raise exception 'Attachment unavailable'using errcode='42501';end if;
     -- Only the trusted server invokes this after verifying actual object bytes,
     -- magic, MIME and size. No client can execute this RPC or update metadata.
     update public.motorist_task_attachments set status='ready',ready_at=coalesce(ready_at,clock_timestamp())where id=photo.id returning * into photo;
    else
     if photo.created_by_user_id<>p_user_id and app_private.employee_task_creator(t)<>p_user_id and not actor.administrator then raise exception 'Photo removal denied'using errcode='42501';end if;
     update public.motorist_task_attachments set status='removed'where id=photo.id returning * into photo;
    end if;
   end if;
   upload:=jsonb_build_object('id',photo.id,'bucket',photo.bucket,'path',photo.path,'fileName',photo.file_name,'mimeType',photo.mime_type,'sizeBytes',photo.size_bytes,'createdAt',photo.created_at);
   update public.motorist_case_tasks set updated_at=clock_timestamp()where id=t.id returning * into t;
  end if;
  insert into public.motorist_task_employee_commands(organization_id,actor_user_id,command_id,task_id,request,committed_revision)
   values(p_organization_id,p_user_id,command,t.id,request,t.revision);
  insert into public.motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
   values(p_organization_id,actor.profile_id,'task.employee.'||action,'motorist_case_tasks',t.id,'mobile',jsonb_build_object('actorUserId',p_user_id,'commandId',command,'revision',t.revision));
 else
  result:=app_private.motorist_employee_tasks_before_extensions(p_user_id,p_organization_id,p_action,p_task_id,p_input);
  select * into t from public.motorist_case_tasks where id=p_task_id and organization_id=p_organization_id;
  if action in ('assign','claim')and not t.employee_extensions and t.assigned_to is null then perform app_private.employee_task_notify(t,p_user_id,'employee_task_assigned',t.assignment_generation);end if;
 end if;
 update public.motorist_task_employee_commands set committed_revision=t.revision where organization_id=p_organization_id and actor_user_id=p_user_id and command_id=command;
 perform set_config('app.task_workspace_write',coalesce(previous_write,''),true);perform set_config('app.employee_task_write',coalesce(previous_employee,''),true);perform set_config('app.employee_task_extensions',coalesce(previous_extensions,''),true);perform set_config('app.employee_task_checklist_override',coalesce(previous_checklist,''),true);perform set_config('app.employee_task_actor',coalesce(previous_actor,''),true);perform set_config('app.employee_task_action',coalesce(previous_action,''),true);
 result:=jsonb_build_object('commandId',command,'committedRevision',t.revision,'task',app_private.employee_task_dto(t,p_user_id));
 if upload is not null then result:=result||jsonb_build_object('attachmentUpload',upload);end if;
 return result;
end $$;

create function public.motorist_employee_tasks_tick(p_organization_id uuid,p_limit integer default 50)returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.motorist_task_recurrences;t public.motorist_case_tasks;result jsonb;occurrence timestamptz;day date;command uuid;
 generated integer:=0;reminders integer:=0;failed integer:=0;limit_rows integer:=least(100,greatest(1,coalesce(p_limit,50)));inserted integer;
 previous_write text;previous_employee text;failure_issue text;
begin
 if not exists(select 1 from public.motorist_organizations o join public.motorist_task_workspace_settings s on s.organization_id=o.id
  where o.id=p_organization_id and o.active and s.enabled and s.writer_inventory_verified_at is not null and coalesce(length(trim(s.writer_inventory_note)),0)>0)then
  return jsonb_build_object('recurrences',0,'reminders',0,'failed',0);
 end if;
 for r in select * from public.motorist_task_recurrences where organization_id=p_organization_id and state='active'and next_at<=clock_timestamp()
  order by next_at,id limit limit_rows for update skip locked loop
  begin
   failure_issue:=null;
   if not exists(select 1 from app_private.employee_task_people(p_organization_id,r.created_by_user_id))then
    failure_issue:='creator_inactive';raise exception 'Task recurrence owner inactive'using errcode='22023';
   end if;
   if not app_private.employee_task_target_available(p_organization_id,r.template->'target')then
    failure_issue:='recipient_unavailable';raise exception 'Task recurrence recipient inactive'using errcode='22023';
   end if;
   occurrence:=app_private.employee_task_recurrence_at(r.frequency,r.local_time,r.weekday,r.time_zone,clock_timestamp(),false);
   day:=(occurrence at time zone r.time_zone)::date;
   if exists(select 1 from public.motorist_case_tasks where organization_id=p_organization_id and recurrence_id=r.id and recurrence_local_date=day)then
    update public.motorist_task_recurrences set next_at=app_private.employee_task_recurrence_next(p_organization_id,r.id,r.frequency,r.local_time,r.weekday,r.time_zone,clock_timestamp()),
     last_error=null,issue=null,updated_at=clock_timestamp()where id=r.id;
    continue;
   end if;
   command:=md5('employee-task-series:'||r.id||':'||day)::uuid;
   result:=public.motorist_employee_tasks(r.created_by_user_id,p_organization_id,'create',null,
    r.template||jsonb_build_object('commandId',command,'dueAt',occurrence));
   previous_write:=current_setting('app.task_workspace_write',true);previous_employee:=current_setting('app.employee_task_write',true);
   perform set_config('app.task_workspace_write','v1',true);perform set_config('app.employee_task_write','v1',true);
   update public.motorist_case_tasks set recurrence_id=r.id,recurrence_local_date=day where id=(result->'task'->>'id')::uuid
    and organization_id=p_organization_id and recurrence_id is null;
   perform set_config('app.task_workspace_write',coalesce(previous_write,''),true);perform set_config('app.employee_task_write',coalesce(previous_employee,''),true);
   update public.motorist_task_recurrences set next_at=app_private.employee_task_recurrence_next(p_organization_id,r.id,r.frequency,r.local_time,r.weekday,r.time_zone,clock_timestamp()),
    last_error=null,issue=null,updated_at=clock_timestamp()where id=r.id;
   generated:=generated+1;
  exception when others then
   -- The subtransaction rolls back any partial occurrence/outbox before the
   -- series is paused. Do not copy exception strings containing task data.
   update public.motorist_task_recurrences set state='needs_attention',last_error='Príjemca alebo nastavenie série nie je dostupné.',issue=failure_issue,next_at=null,updated_at=clock_timestamp()where id=r.id;
   failed:=failed+1;
  end;
 end loop;
 for t in select * from public.motorist_case_tasks x where x.organization_id=p_organization_id and x.employee_extensions and x.status<>'done'and x.due_at is not null
  and(case when x.created_at<x.due_at-interval '30 minutes'then x.due_at-interval '30 minutes'else x.due_at end)<=clock_timestamp()
  and not exists(select 1 from public.motorist_task_employee_reminder_runs m where m.organization_id=x.organization_id and m.task_id=x.id and m.reminder_generation=x.reminder_generation)
  order by x.due_at,x.id limit limit_rows for update skip locked loop
  insert into public.motorist_task_employee_reminder_runs(organization_id,task_id,reminder_generation)values(p_organization_id,t.id,t.reminder_generation)on conflict do nothing;
  get diagnostics inserted=row_count;
  if inserted>0 then perform app_private.employee_task_notify(t,null,'employee_task_due',t.reminder_generation);reminders:=reminders+1;end if;
 end loop;
 return jsonb_build_object('recurrences',generated,'reminders',reminders,'failed',failed);
end $$;

create function public.motorist_employee_tasks_cleanup(p_organization_id uuid,p_limit integer default 50)returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 with candidates as(select id from public.motorist_task_attachments where organization_id=p_organization_id and storage_deleted_at is null
  and coalesce(upload_valid_until,'-infinity'::timestamptz)<=clock_timestamp()
  and(status='removed'or(status='pending'and created_at<=clock_timestamp()-interval '24 hours'))
  order by created_at,id limit least(100,greatest(1,coalesce(p_limit,50)))for update skip locked),
 marked as(update public.motorist_task_attachments a set status='removed'from candidates c where a.id=c.id returning a.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'bucket',bucket,'path',path)order by created_at,id),'[]')into result from marked;
 return result;
end $$;
create function public.motorist_employee_tasks_cleanup_finish(p_organization_id uuid,p_ids uuid[])returns integer
language plpgsql security definer set search_path='' as $$declare n integer;begin
 if p_ids is null or array_length(p_ids,1)>100 then raise exception 'Invalid cleanup receipt'using errcode='22023';end if;
 update public.motorist_task_attachments set storage_deleted_at=clock_timestamp()where organization_id=p_organization_id and id=any(p_ids)and status='removed'and storage_deleted_at is null
  and coalesce(upload_valid_until,'-infinity'::timestamptz)<=clock_timestamp();
 get diagnostics n=row_count;return n;
end $$;

revoke all on function public.motorist_employee_tasks(uuid,uuid,text,uuid,jsonb),public.motorist_employee_tasks_tick(uuid,integer),
 public.motorist_employee_tasks_cleanup(uuid,integer),public.motorist_employee_tasks_cleanup_finish(uuid,uuid[]),public.motorist_push_outbox_claim(uuid,integer)from public,anon,authenticated;
grant execute on function public.motorist_employee_tasks(uuid,uuid,text,uuid,jsonb),public.motorist_employee_tasks_tick(uuid,integer),
 public.motorist_employee_tasks_cleanup(uuid,integer),public.motorist_employee_tasks_cleanup_finish(uuid,uuid[]),public.motorist_push_outbox_claim(uuid,integer)to service_role;
do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private'and
  (p.proname like 'employee_task_%'or p.proname in('motorist_employee_tasks_before_extensions','motorist_push_outbox_claim_before_employee_tasks',
   'motorist_schedule_task_generation','motorist_schedule_task_generation_before_extensions','motorist_ensure_assignment_event','motorist_ensure_assignment_event_before_extensions','push_still_valid_before_employee_tasks','push_still_valid'))
 loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);end loop;
end $$;
notify pgrst,'reload schema';
commit;
