-- Additive task stages/review. Existing deadlines, legacy status values and
-- rows are retained; there is no data backfill or telephony configuration.
begin;

alter table public.motorist_case_tasks
  add column workflow_state text check (workflow_state in ('todo','in_progress','in_review','done')),
  add column reviewer_profile_id uuid,
  add column review_requested_by uuid,
  add column review_requested_at timestamptz,
  add column review_submission text check (length(review_submission) <= 10000),
  add column review_return_reason text check (length(review_return_reason) <= 10000),
  add column review_generation integer not null default 0 check (review_generation >= 0),
  add column reviewed_by uuid,
  add column reviewed_at timestamptz,
  add constraint motorist_task_reviewer_org_fk foreign key (reviewer_profile_id,organization_id) references public.motorist_profiles(id,organization_id),
  add constraint motorist_task_review_requestor_org_fk foreign key (review_requested_by,organization_id) references public.motorist_profiles(id,organization_id),
  add constraint motorist_task_reviewed_by_org_fk foreign key (reviewed_by,organization_id) references public.motorist_profiles(id,organization_id),
  add constraint motorist_task_review_request_check check (workflow_state is distinct from 'in_review' or
    (reviewer_profile_id is not null and review_requested_by is not null and review_requested_at is not null
      and coalesce(length(trim(review_submission)),0)>0 and status<>'done'));
create index motorist_task_review_queue_idx on public.motorist_case_tasks(organization_id,reviewer_profile_id,review_requested_at)
  where workflow_state='in_review';

-- Retry receipts are task-scoped and actor-scoped. A deletion removes the
-- receipt; it cannot resurrect a deleted task or leak its old snapshot.
create table public.motorist_task_workflow_commands (
  organization_id uuid not null,
  task_id uuid not null,
  actor_profile_id uuid not null,
  command_id uuid not null,
  request jsonb not null,
  committed_revision integer not null check (committed_revision>0),
  created_at timestamptz not null default clock_timestamp(),
  primary key(task_id,actor_profile_id,command_id),
  foreign key(task_id,organization_id) references public.motorist_case_tasks(id,organization_id) on delete cascade,
  foreign key(actor_profile_id,organization_id) references public.motorist_profiles(id,organization_id)
);
alter table public.motorist_task_workflow_commands enable row level security;
revoke all on public.motorist_task_workflow_commands from public,anon,authenticated,service_role;

-- Preserve the exact existing implementation, including its CAS, source/link
-- protections, reminders and audit. The public function keeps its identity.
do $copy$
declare definition text;
begin
  select pg_get_functiondef('public.motorist_task_workspace(uuid,uuid,text,uuid,jsonb)'::regprocedure) into definition;
  if to_regprocedure('app_private.motorist_task_workspace_before_review(uuid,uuid,text,uuid,jsonb)') is not null
    or position('FUNCTION public.motorist_task_workspace(' in definition)=0 then
    raise exception 'Task workflow migration refused: unexpected existing task function';
  end if;
  execute replace(definition,'FUNCTION public.motorist_task_workspace(','FUNCTION app_private.motorist_task_workspace_before_review(');
end $copy$;
revoke all on function app_private.motorist_task_workspace_before_review(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;

alter function app_private.motorist_task_dto(public.motorist_case_tasks) rename to motorist_task_dto_before_review;
create function app_private.motorist_task_dto(p_task public.motorist_case_tasks) returns jsonb language sql stable security definer set search_path='' as $$
  select app_private.motorist_task_dto_before_review(p_task) || jsonb_build_object(
    'workflowVersion',1,
    'workflowState',case when p_task.status='done' then 'done' else coalesce(p_task.workflow_state,'todo') end,
    'reviewerProfileId',p_task.reviewer_profile_id,'reviewRequestedBy',p_task.review_requested_by,
    'reviewRequestedAt',p_task.review_requested_at,'reviewSubmission',p_task.review_submission,
    'reviewReturnReason',p_task.review_return_reason,'reviewGeneration',p_task.review_generation,
    'reviewedBy',p_task.reviewed_by,'reviewedAt',p_task.reviewed_at);
$$;
revoke all on function app_private.motorist_task_dto(public.motorist_case_tasks),app_private.motorist_task_dto_before_review(public.motorist_case_tasks) from public,anon,authenticated,service_role;

create function public.motorist_task_workflow_enabled(p_organization_id uuid,p_actor_profile_id uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
    where p.id=p_actor_profile_id and p.organization_id=p_organization_id and p.user_id=auth.uid() and p.active and p.access_status='active'
      and p.role in ('dispatcher','senior_dispatcher','manager','admin')) then raise exception 'Task access denied' using errcode='42501'; end if;
  return exists(select 1 from public.motorist_task_workspace_settings s where s.organization_id=p_organization_id
    and s.enabled and s.writer_inventory_verified_at is not null and coalesce(length(trim(s.writer_inventory_note)),0)>0);
end $$;
revoke all on function public.motorist_task_workflow_enabled(uuid,uuid) from public,anon,service_role;
grant execute on function public.motorist_task_workflow_enabled(uuid,uuid) to authenticated;

create or replace function public.motorist_task_workspace(p_organization_id uuid,p_actor_profile_id uuid,p_action text,p_task_id uuid default null,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task public.motorist_case_tasks;
begin
  -- Validate actor before inspecting any task. Older API endpoints cannot
  -- bypass a requested review by submitting their ordinary status=done patch.
  perform public.motorist_task_workflow_enabled(p_organization_id,p_actor_profile_id);
  if p_action='update' and p_input->>'status'='done' then
    select * into task from public.motorist_case_tasks where id=p_task_id and organization_id=p_organization_id for update;
    if found and task.status<>'done' and task.reviewer_profile_id is not null then
      raise exception 'Task review required' using errcode='22023';
    end if;
  end if;
  return app_private.motorist_task_workspace_before_review(p_organization_id,p_actor_profile_id,p_action,p_task_id,p_input);
end $$;
revoke all on function public.motorist_task_workspace(uuid,uuid,text,uuid,jsonb) from public,anon,service_role;
grant execute on function public.motorist_task_workspace(uuid,uuid,text,uuid,jsonb) to authenticated;

-- Runs before assignment/reminder lifecycle triggers, so an automated source
-- completion cannot cancel review work. Source records can still finish normally.
-- The existing session RPC rejects such manual completion clearly above.
create function app_private.motorist_task_workflow_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare internal boolean := coalesce(current_setting('app.task_workflow_write',true),'')='v1';
begin
  if tg_op='INSERT' then
    if not internal and (new.workflow_state is not null or new.reviewer_profile_id is not null or new.review_requested_by is not null
      or new.review_requested_at is not null or new.review_submission is not null or new.review_return_reason is not null
      or new.review_generation<>0 or new.reviewed_by is not null or new.reviewed_at is not null) then
      raise exception 'Task review is server managed' using errcode='42501';
    end if;
    return new;
  end if;
  if not internal and row(new.workflow_state,new.reviewer_profile_id,new.review_requested_by,new.review_requested_at,new.review_submission,
    new.review_return_reason,new.review_generation,new.reviewed_by,new.reviewed_at) is distinct from
    row(old.workflow_state,old.reviewer_profile_id,old.review_requested_by,old.review_requested_at,old.review_submission,
      old.review_return_reason,old.review_generation,old.reviewed_by,old.reviewed_at) then
    raise exception 'Task review is server managed' using errcode='42501';
  end if;
  if not internal and new.status='done' and old.status<>'done' and old.reviewer_profile_id is not null then
    new.status:=old.status; new.completed_at:=old.completed_at; new.completed_by:=old.completed_by;
  elsif not internal and new.status is distinct from old.status then
    if new.status='done' then new.workflow_state:='done';
    elsif old.status='done' then new.workflow_state:='todo'; new.reviewed_at:=null; new.reviewed_by:=null;
    end if;
  end if;
  if new.status<>'done' and new.reviewer_profile_id is not null and new.reviewer_profile_id=new.assigned_to then
    raise exception 'Invalid task reviewer' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function app_private.motorist_task_workflow_guard() from public,anon,authenticated,service_role;
create trigger motorist_task_00_workflow_guard before insert or update on public.motorist_case_tasks
  for each row execute function app_private.motorist_task_workflow_guard();

create function public.motorist_task_workflow(p_organization_id uuid,p_actor_profile_id uuid,p_task_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  task public.motorist_case_tasks; prior public.motorist_task_workflow_commands;
  action text; stage text; next_stage text; actor_role text; comment text; reviewer uuid; command uuid; expected integer;
  previous_write text; previous_workflow text; previous_notification text;
  recipient uuid; notice_title text; notice_body text; event_text text; result jsonb;
begin
  if not public.motorist_task_workflow_enabled(p_organization_id,p_actor_profile_id) then raise exception 'Task workflow activation required' using errcode='55000'; end if;
  if p_input is null or jsonb_typeof(p_input)<>'object' then raise exception 'Invalid task command' using errcode='22023'; end if;
  action:=p_input->>'action'; comment:=regexp_replace(p_input->>'comment','^[[:space:]]+|[[:space:]]+$','','g');
  if action is null or action not in ('start','submit_review','approve','return','complete','reopen','to_todo')
    or jsonb_typeof(p_input->'commandId') is distinct from 'string'
    or jsonb_typeof(p_input->'expectedRevision') is distinct from 'number'
    or coalesce(p_input->>'expectedRevision','') !~ '^[1-9][0-9]{0,9}$'
    or (p_input->>'expectedRevision')::numeric>2147483647 then raise exception 'Invalid task command' using errcode='22023'; end if;
  command:=(p_input->>'commandId')::uuid; expected:=(p_input->>'expectedRevision')::integer;
  if p_input ? 'comment' and (jsonb_typeof(p_input->'comment') is distinct from 'string' or length(p_input->>'comment')>10000) then raise exception 'Invalid task comment' using errcode='22023'; end if;
  if action in ('submit_review','return') and coalesce(length(comment),0)=0 then raise exception 'Task review comment required' using errcode='22023'; end if;
  select * into task from public.motorist_case_tasks where id=p_task_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Task unavailable' using errcode='P0002'; end if;
  select * into prior from public.motorist_task_workflow_commands where task_id=task.id and actor_profile_id=p_actor_profile_id and command_id=command;
  if found then
    if prior.request<>p_input then raise exception 'Task command ID reused' using errcode='PT409'; end if;
    return jsonb_build_object('task',app_private.motorist_task_dto(task),'commandId',command,'committedRevision',prior.committed_revision);
  end if;
  if task.revision<>expected then raise exception 'Task revision conflict' using errcode='PT409'; end if;
  stage:=case when task.status='done' then 'done' else coalesce(task.workflow_state,'todo') end;
  select role into actor_role from public.motorist_profiles where id=p_actor_profile_id;
  next_stage:=case action when 'start' then 'in_progress' when 'submit_review' then 'in_review'
    when 'approve' then 'done' when 'return' then 'in_progress' when 'complete' then 'done' else 'todo' end;
  if (action='start' and stage<>'todo') or (action='to_todo' and stage<>'in_progress')
    or (action='reopen' and stage<>'done') or (action='complete' and stage not in ('todo','in_progress'))
    or (action='submit_review' and stage not in ('todo','in_progress','in_review'))
    or (action in ('approve','return') and stage<>'in_review') then raise exception 'Invalid task stage transition' using errcode='22023'; end if;
  if action='complete' and task.reviewer_profile_id is not null then raise exception 'Task review required' using errcode='22023'; end if;
  if action in ('approve','return') and task.reviewer_profile_id is distinct from p_actor_profile_id then raise exception 'Only designated reviewer can decide' using errcode='42501'; end if;
  if action='submit_review' then
    reviewer:=(p_input->>'reviewerProfileId')::uuid;
    if reviewer is null or reviewer=p_actor_profile_id or reviewer=task.assigned_to
      or not exists(select 1 from public.motorist_profiles p where p.id=reviewer and p.organization_id=p_organization_id
        and p.active and p.access_status='active' and p.user_id is not null and p.role in ('dispatcher','senior_dispatcher','manager','admin')) then
      raise exception 'Invalid task reviewer' using errcode='22023';
    end if;
    if stage='in_review' then
      if p_actor_profile_id is distinct from task.review_requested_by and p_actor_profile_id is distinct from task.assigned_to and actor_role not in ('manager','admin') then
        raise exception 'Cannot reassign task review' using errcode='42501';
      end if;
      if reviewer=task.reviewer_profile_id then raise exception 'Review already assigned to this colleague' using errcode='22023'; end if;
    end if;
  end if;

  previous_write:=current_setting('app.task_workspace_write',true); previous_workflow:=current_setting('app.task_workflow_write',true);
  previous_notification:=current_setting('app.notification_actor_write',true);
  perform set_config('app.task_workspace_write','v1',true);
  perform set_config('app.task_workflow_write','v1',true);
  update public.motorist_case_tasks set
    workflow_state=next_stage,
    status=case when next_stage='done' then 'done' when status='done' then 'open' else status end,
    completed_at=case when next_stage='done' then clock_timestamp() else null end,
    completed_by=case when next_stage='done' then p_actor_profile_id else null end,
    reviewer_profile_id=case when action='submit_review' then reviewer else reviewer_profile_id end,
    review_requested_by=case when action='submit_review' then p_actor_profile_id else review_requested_by end,
    review_requested_at=case when action='submit_review' then clock_timestamp() else review_requested_at end,
    review_submission=case when action='submit_review' then comment else review_submission end,
    review_return_reason=case when action='return' then comment when action='submit_review' then null else review_return_reason end,
    review_generation=case when action='submit_review' then review_generation+1 else review_generation end,
    reviewed_by=case when action='approve' then p_actor_profile_id when action in ('submit_review','reopen') then null else reviewed_by end,
    reviewed_at=case when action='approve' then clock_timestamp() when action in ('submit_review','reopen') then null else reviewed_at end
    where id=task.id returning * into task;

  -- A superseded/decided review should no longer invite a stale action.
  -- Recipient read state stays private; the lifecycle change is transactional.
  if action in ('submit_review','approve','return','reopen') then
    perform set_config('app.notification_actor_write','v1',true);
    update public.motorist_notifications set status='archived',archived_at=clock_timestamp()
      where organization_id=p_organization_id and task_id=task.id and payload->>'source'='task_review_requested' and status='unread';
  end if;
  if action='submit_review' then
    recipient:=reviewer; notice_title:='Úloha na kontrolu'; notice_body:=task.title;
    event_text:='Odovzdané na kontrolu: '||comment;
  elsif action in ('return','approve') then
    recipient:=coalesce(task.assigned_to,task.review_requested_by,task.created_by);
    notice_title:=case when action='return' then 'Úloha vrátená na dopracovanie' else 'Úloha schválená' end;
    notice_body:=task.title||case when action='return' then E'\n'||comment else '' end;
    event_text:=case when action='return' then 'Vrátené na dopracovanie: '||comment else 'Kontrola schválená'||case when coalesce(comment,'')<>'' then ': '||comment else '.' end end;
  end if;
  if recipient is not null and recipient<>p_actor_profile_id and exists(select 1 from public.motorist_profiles p where p.id=recipient and p.organization_id=p_organization_id and p.active and p.access_status='active' and p.role in ('dispatcher','senior_dispatcher','manager','admin')) then
    insert into public.motorist_notifications(organization_id,case_id,task_id,recipient_profile_id,visibility,kind,severity,title,body,status,delivery_status,dedupe_key,payload)
      values(p_organization_id,task.case_id,task.id,recipient,'private','handover','info',notice_title,notice_body,'unread','in_app',
        'task-review:'||task.id||':generation:'||task.review_generation||':'||action||':recipient:'||recipient,
        jsonb_build_object('source',case when action='submit_review' then 'task_review_requested' else 'task_review_'||action end,'review_generation',task.review_generation))
      on conflict(organization_id,dedupe_key) do nothing;
  end if;
  if event_text is not null then
    insert into public.motorist_task_messages(organization_id,task_id,author_profile_id,body,client_message_id)
      values(p_organization_id,task.id,p_actor_profile_id,left(event_text,10000),gen_random_uuid());
  end if;
  insert into public.motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,before_payload,after_payload)
    values(p_organization_id,p_actor_profile_id,'task.workflow.'||action,'motorist_case_tasks',task.id,'dispatch_console',jsonb_build_object('workflowState',stage),
      jsonb_build_object('workflowState',next_stage,'reviewerProfileId',task.reviewer_profile_id,'reviewGeneration',task.review_generation,'revision',task.revision,'comment',comment,'commandId',command));
  insert into public.motorist_task_workflow_commands(organization_id,task_id,actor_profile_id,command_id,request,committed_revision)
    values(p_organization_id,task.id,p_actor_profile_id,command,p_input,task.revision);
  result:=jsonb_build_object('task',app_private.motorist_task_dto(task),'commandId',command,'committedRevision',task.revision);
  perform set_config('app.task_workspace_write',coalesce(previous_write,''),true);
  perform set_config('app.task_workflow_write',coalesce(previous_workflow,''),true);
  perform set_config('app.notification_actor_write',coalesce(previous_notification,''),true);
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then perform realtime.send('{}'::jsonb,'invalidate','tasks:'||p_organization_id::text,true); end if;
  return result;
end $$;
revoke all on function public.motorist_task_workflow(uuid,uuid,uuid,jsonb) from public,anon,service_role;
grant execute on function public.motorist_task_workflow(uuid,uuid,uuid,jsonb) to authenticated;

-- Preserve source validation and all its existing authorization. Its source
-- receipt remains successful, but completing a source does not approve a review.
do $source$
declare definition text; old_line text := 'if v_task.status=''done'' then return jsonb_build_object(''completed'',true,''taskId'',v_task.id); end if;';
begin
  select pg_get_functiondef('public.motorist_complete_task_source_v1(uuid,text,uuid,uuid)'::regprocedure) into definition;
  if position(old_line in definition)=0 then raise exception 'Task workflow migration refused: source completion definition drift'; end if;
  execute replace(definition,old_line,old_line||E'\n if v_task.reviewer_profile_id is not null then return jsonb_build_object(''completed'',false,''reviewPending'',true,''taskId'',v_task.id); end if;');
end $source$;

commit;
