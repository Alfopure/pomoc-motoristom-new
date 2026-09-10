\set ON_ERROR_STOP on
\ir task-workspace-fixture.sql
-- Replace the task-only fixture's deliberately minimal reminder table with
-- exactly the historical production DDL before applying both new migrations.
drop table public.motorist_task_reminders;
create function app_private.motorist_is_org_member(org uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
select exists(select 1 from motorist_profiles p where p.organization_id=org and p.user_id=auth.uid() and p.active) $$;
create function public.motorist_set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
\ir ../../supabase/migrations/20260609110000_task_reminders_notifications.sql
grant all on public.motorist_task_reminders,public.motorist_notifications to service_role;
\ir ../../supabase/migrations/20260929120000_task_workspace.sql
\ir ../../supabase/migrations/20260929130000_task_notification_privacy.sql
create function pg_temp.assert_true(value boolean, description text) returns void language plpgsql as $$ begin if value is distinct from true then raise exception 'FAILED: %', description; end if; end $$;
create function pg_temp.expect_error(statement text, expected_code text) returns void language plpgsql as $$ begin
  begin execute statement; exception when others then if sqlstate=expected_code then return; end if; raise; end;
  raise exception 'Expected rejection %', expected_code;
end $$;
-- Isolated local inventory only. No deployment flag is changed by this test.
update public.motorist_task_workspace_settings set enabled=true,writer_inventory_verified_at=now(),writer_inventory_note='Local combined contract: only current RPC writers' where organization_id='10000000-0000-0000-0000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','create',p_input=>' {"title":"Task with reminders","caseIds":["40000000-0000-0000-0000-000000000001"],"dueAt":"2026-09-01T12:00:00Z","reminderChannels":["in_app","email"]}') ->> 'id' as task_id \gset
reset role;
select pg_temp.assert_true((select count(*)=3 and bool_and(visibility='private' and channels @> array['email']::text[]) from motorist_task_reminders where task_id=:'task_id' and generation=0),'create transaction schedules 3 personal reminders with chosen channels');
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'task_id','{"status":"done","expectedRevision":1}');
reset role;
select pg_temp.assert_true((select count(*)=3 and bool_and(status='cancelled') from motorist_task_reminders where task_id=:'task_id'),'completion cancels old generation under active guards');
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'task_id','{"status":"open","expectedRevision":2}');
reset role;
select pg_temp.assert_true((select count(*)=3 and bool_and(channels @> array['email']::text[]) from motorist_task_reminders where task_id=:'task_id' and generation=2 and status='pending'),'same-deadline reopen creates new generation and keeps email');
set role service_role;
select motorist_ensure_task_reminders('10000000-0000-0000-0000-000000000001',:'task_id','20000000-0000-0000-0000-000000000001');
select motorist_cancel_stale_task_reminders('10000000-0000-0000-0000-000000000001',:'task_id');
select pg_temp.assert_true((select count(*)=3 from motorist_task_reminders where task_id=:'task_id' and generation=2 and status='pending'),'legacy bridge does not cancel/double new generation');
select pg_temp.expect_error(format('update motorist_task_reminders set status=%L where task_id=%L','cancelled',:'task_id'),'55000');
select pg_temp.assert_true((select count(*)=3 from motorist_task_reminders where task_id=:'task_id' and generation=2 and status='pending'),'old delete fails before first cancellation side effect');
reset role;
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'task_id','{"assignedTo":"20000000-0000-0000-0000-000000000002","expectedRevision":3}');
reset role;
select pg_temp.assert_true((select count(*)=1 and bool_and(recipient_profile_id='20000000-0000-0000-0000-000000000002') from motorist_task_reminders where task_id=:'task_id' and generation=3 and status='pending'),'reassignment atomically replaces recipients');
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'task_id','{"dueAt":"2026-09-02T12:00:00Z","expectedRevision":4}');
reset role;
select pg_temp.assert_true((select count(*)=1 from motorist_task_reminders where task_id=:'task_id' and generation=4 and status='pending'),'deadline creates exactly one latest reminder');
update motorist_task_reminders set status='processing' where task_id=:'task_id' and generation=4;
insert into motorist_notifications(organization_id,case_id,task_id,reminder_id,recipient_profile_id,visibility,title,dedupe_key,payload)
select organization_id,case_id,task_id,id,recipient_profile_id,'private','Current','combined:'||id,jsonb_build_object('source','task_reminder_runner') from motorist_task_reminders where task_id=:'task_id' and generation=4 returning id as notification_id \gset
set role service_role;
select pg_temp.expect_error(format('update motorist_notifications set status=%L where task_id=%L','archived',:'task_id'),'55000');
select pg_temp.expect_error(format('delete from motorist_case_tasks where id=%L',:'task_id'),'55000');
select pg_temp.assert_true((select status='unread' from motorist_notifications where id=:'notification_id'),'old delete leaves prior notification state unchanged');
select pg_temp.expect_error(format('select motorist_notification_action(%L,%L,%L,%L)','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003','read',:'notification_id'),'P0002');
select motorist_notification_action('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','read',:'notification_id');
reset role;
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','link',:'task_id','{"caseId":"40000000-0000-0000-0000-000000000002","expectedRevision":5}');
reset role;
delete from motorist_cases where id='40000000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select case_id is null and reminder_generation=4 from motorist_case_tasks where id=:'task_id'),'origin deletion preserves task and generation');
select pg_temp.assert_true((select count(*)=1 from motorist_task_case_links where task_id=:'task_id'),'second case link survives');
select pg_temp.assert_true((select count(*)=1 and bool_and(case_id is null) from motorist_task_reminders where task_id=:'task_id' and generation=4),'reminder survives case deletion');
select pg_temp.assert_true((select case_id is null and status='read' from motorist_notifications where id=:'notification_id'),'notification survives case deletion with personal read state');
-- Independent reminder time travels through the real session task API, not
-- an invented due date or a second schedule maintained by the widget.
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','create',p_input=>' {"title":"Reminder without deadline","caseIds":[],"assignedTo":"20000000-0000-0000-0000-000000000001","reminderAt":"2026-09-03T10:00:00Z"}') ->> 'id' as independent_task_id \gset
reset role;
select pg_temp.assert_true((select due_at is null and reminder_at='2026-09-03T10:00:00Z' from motorist_case_tasks where id=:'independent_task_id'),'independent reminder DTO does not invent due date');
select pg_temp.assert_true((select scheduled_for='2026-09-03T10:00:00Z' and generation=0 from motorist_task_reminders where task_id=:'independent_task_id'),'independent reminder materializes one schedule');
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'independent_task_id','{"reminderAt":"2026-09-03T11:00:00Z","expectedRevision":1}');
reset role;
select pg_temp.assert_true((select count(*)=1 from motorist_task_reminders where task_id=:'independent_task_id' and scheduled_for='2026-09-03T11:00:00Z' and generation=1 and status='pending'),'reminder-only RPC edit creates fresh generation');
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'independent_task_id','{"reminderAt":null,"expectedRevision":2}');
reset role;
select pg_temp.assert_true((select count(*)=0 from motorist_task_reminders where task_id=:'independent_task_id' and status='pending'),'cleared reminder with absent deadline cancels pending schedule');
select 'combined task/reminder contract passed' as result;

-- Updating only delivery channels preserves event identity and assignment alerts.
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','create',p_input=>'{"title":"Channels only","assignedTo":"20000000-0000-0000-0000-000000000001","dueAt":"2099-01-01T12:00:00Z","reminderChannels":["in_app"]}') ->> 'id' as channels_task_id \gset
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'channels_task_id','{"expectedRevision":1,"reminderChannels":["in_app","email"]}');
reset role;
select pg_temp.assert_true((select count(*)=1 and bool_and(generation=0 and channels @> array['email']::text[]) from motorist_task_reminders where task_id=:'channels_task_id' and status='pending'),'channels-only edit updates pending delivery without a new generation');
select pg_temp.assert_true((select count(*)=1 from motorist_notifications where task_id=:'channels_task_id' and payload->>'source'='task_assignment'),'channels-only edit does not repeat assignment');
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'channels_task_id','{"expectedRevision":2,"reminderChannels":["in_app"]}');
reset role;
select pg_temp.assert_true((select count(*)=1 and bool_and(generation=0 and channels=array['in_app']::text[]) from motorist_task_reminders where task_id=:'channels_task_id' and status='pending'),'pending email can be removed without duplicating the reminder');
