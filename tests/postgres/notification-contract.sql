\set ON_ERROR_STOP on
\ir notification-fixture.sql
\ir ../../supabase/migrations/20260929130000_task_notification_privacy.sql
create function pg_temp.assert_true(value boolean, description text) returns void language plpgsql as $$ begin if value is distinct from true then raise exception 'FAILED: %', description; end if; end $$;
create function pg_temp.expect_error(statement text, expected_code text) returns void language plpgsql as $$ begin
  begin execute statement; exception when others then if sqlstate=expected_code then return; end if; raise; end;
  raise exception 'Expected rejection %', expected_code;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select pg_temp.assert_true((select count(*)=2 from motorist_notifications),'A sees only own + historical team');
select pg_temp.assert_true((select count(*)=2 from motorist_task_reminders),'A sees own + historical team reminders');
select pg_temp.expect_error($q$update motorist_task_reminders set status='sent'$q$,'42501');
select pg_temp.expect_error($q$update motorist_task_reminders set recipient_profile_id='20000000-0000-0000-0000-000000000002'$q$,'42501');
select pg_temp.expect_error($q$update motorist_notifications set visibility='team'$q$,'42501');
select pg_temp.expect_error($q$update motorist_notifications set recipient_profile_id='20000000-0000-0000-0000-000000000001'$q$,'42501');
select pg_temp.expect_error($q$update motorist_notifications set payload='{"snoozed_until":"2099-01-01"}'$q$,'42501');
select pg_temp.expect_error($q$insert into motorist_notifications(organization_id,title,dedupe_key) values('10000000-0000-0000-0000-000000000001','INJECT','injected')$q$,'42501');
select pg_temp.expect_error($q$select motorist_ensure_task_reminders('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001')$q$,'42501');
update motorist_notifications set status='read' where id='70000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000002',false);
select pg_temp.assert_true((select status='unread' from motorist_notifications where id='70000000-0000-0000-0000-000000000002'),'A read did not change B');
with changed as(update motorist_notifications set status='archived' where id='70000000-0000-0000-0000-000000000001' returning *) select pg_temp.assert_true((select count(*)=0 from changed),'B cannot archive A');
select pg_temp.assert_true((select count(*)=1 from motorist_task_reminders),'B cannot read A reminder');
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000003',false);
select pg_temp.assert_true((select count(*)=1 from motorist_notifications),'product admin sees historical team only');
select pg_temp.assert_true((select count(*)=1 from motorist_task_reminders),'product admin cannot read A reminder');
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000004',false);
select pg_temp.assert_true((select count(*)=0 from motorist_notifications),'cross-organization notifications denied');
select pg_temp.assert_true((select count(*)=0 from motorist_task_reminders),'cross-organization reminders denied');
reset role;
update motorist_profiles set active=false where id='20000000-0000-0000-0000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select pg_temp.assert_true((select count(*)=0 from motorist_notifications),'inactive user cannot read old personal delivery');
reset role;
update motorist_profiles set active=true where id='20000000-0000-0000-0000-000000000001';
update motorist_organizations set active=false where id='10000000-0000-0000-0000-000000000001';
set role authenticated;
select pg_temp.assert_true(app_private.motorist_is_org_member('10000000-0000-0000-0000-000000000001'),'historical membership helper still allows an active profile in disabled org');
select pg_temp.assert_true((select count(*)=0 from motorist_notifications),'disabled organization cannot read private or historical team notifications');
select pg_temp.assert_true((select count(*)=0 from motorist_task_reminders),'disabled organization cannot read private or historical team reminders');
with changed as(update motorist_notifications set status='archived' returning *)
select pg_temp.assert_true((select count(*)=0 from changed),'disabled organization cannot update notification state');
reset role;
update motorist_organizations set active=true where id='10000000-0000-0000-0000-000000000001';

-- Generation lifecycle is wholly transactional; same due date after reopening
-- creates a fresh generation, while repeat ensure calls allocate no duplicates.
update motorist_case_tasks set status='done' where id='50000000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select count(*)=0 from motorist_task_reminders where status='pending'),'completion cancels pending');
select set_config('app.task_reminder_channels','["in_app","email"]',false);
update motorist_case_tasks set status='open' where id='50000000-0000-0000-0000-000000000001';
select set_config('app.task_reminder_channels','',false);
select pg_temp.assert_true((select reminder_generation=2 from motorist_case_tasks where id='50000000-0000-0000-0000-000000000001'),'same deadline reopen advances generation');
select motorist_ensure_task_reminders('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001');
select motorist_ensure_task_reminders('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001');
select motorist_cancel_stale_task_reminders('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001');
select pg_temp.assert_true((select count(*)=1 from motorist_task_reminders where task_id='50000000-0000-0000-0000-000000000001' and generation=2 and status='pending'),'same generation retries + legacy cancel preserve exactly one live reminder');
select pg_temp.assert_true((select channels @> array['email']::text[] from motorist_task_reminders where task_id='50000000-0000-0000-0000-000000000001' and generation=2),'channels preserved');
-- Forging the generation never changes the server-owned lifecycle counter.
update motorist_case_tasks set reminder_generation=999 where id='50000000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select reminder_generation=2 from motorist_case_tasks where id='50000000-0000-0000-0000-000000000001'),'generation cannot be forged');
select pg_temp.expect_error($q$select motorist_ensure_task_reminders('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004')$q$,'42501');
-- Invalid channel input rolls back the task update and reminder cancellation.
select set_config('app.task_reminder_channels','["unsafe"]',false);
select pg_temp.expect_error($q$update motorist_case_tasks set due_at='2026-09-02T12:00:00Z' where id='50000000-0000-0000-0000-000000000001'$q$,'22023');
select set_config('app.task_reminder_channels','',false);
select pg_temp.assert_true((select reminder_generation=2 from motorist_case_tasks where id='50000000-0000-0000-0000-000000000001'),'failed lifecycle rolls task back');
select pg_temp.assert_true((select count(*)=1 from motorist_task_reminders where generation=2 and status='pending'),'failed lifecycle retains current pending');

-- A claimed reminder is cancelled on reassignment; late runner insert fails
-- before its external email/push path can see a newly inserted row.
update motorist_task_reminders set status='processing' where generation=2;
select id as stale_reminder_id from motorist_task_reminders where generation=2 \gset
update motorist_case_tasks set assigned_to='20000000-0000-0000-0000-000000000002' where id='50000000-0000-0000-0000-000000000001';
select pg_temp.expect_error(format($q$insert into motorist_notifications(organization_id,task_id,reminder_id,recipient_profile_id,visibility,title,dedupe_key,payload) values('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',%L,'20000000-0000-0000-0000-000000000001','private','STALE','stale-delivery','{"source":"task_reminder_runner"}')$q$, :'stale_reminder_id'),'40001');
select pg_temp.assert_true((select count(*)=0 from motorist_notifications where dedupe_key='stale-delivery'),'no stale delivery');

-- A task without a case gets one private reminder per current team recipient.
insert into motorist_case_tasks(id,organization_id,created_by,due_at) values('50000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','2026-09-01T13:00:00Z');
select pg_temp.assert_true((select count(*)=3 and bool_and(visibility='private' and case_id is null) from motorist_task_reminders where task_id='50000000-0000-0000-0000-000000000002'),'team task has personal task-first reminders');
update motorist_task_reminders set status='processing' where task_id='50000000-0000-0000-0000-000000000002';
insert into motorist_notifications(organization_id,task_id,reminder_id,recipient_profile_id,visibility,title,dedupe_key,payload)
select organization_id,task_id,id,recipient_profile_id,'private','TEAM EVENT','personal:'||id,jsonb_build_object('source','task_reminder_runner') from motorist_task_reminders where task_id='50000000-0000-0000-0000-000000000002';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
update motorist_notifications set status='read' where title='TEAM EVENT';
reset role;
select pg_temp.assert_true((select count(*)=2 from motorist_notifications where title='TEAM EVENT' and status='unread'),'personal team delivery read is independent');
-- Removing the old case preserves tasks/reminders/notifications with null context.
select count(*) as notice_count_before_delete from motorist_notifications where task_id='50000000-0000-0000-0000-000000000001' \gset
delete from motorist_cases where id='40000000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select case_id is null from motorist_case_tasks where id='50000000-0000-0000-0000-000000000001'),'case delete preserves task');
select pg_temp.assert_true((select count(*)>0 and bool_and(case_id is null) from motorist_task_reminders where task_id='50000000-0000-0000-0000-000000000001'),'case delete preserves reminder');
select pg_temp.assert_true((select count(*)=:'notice_count_before_delete'::integer and bool_and(case_id is null) from motorist_notifications where task_id='50000000-0000-0000-0000-000000000001'),'case delete preserves notifications');
-- Service-role actor actions cannot use an administrator role to impersonate
-- another recipient, and the old shared rows retain shared read semantics.
set role service_role;
select pg_temp.expect_error($q$select motorist_notification_action('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003','archived','70000000-0000-0000-0000-000000000001')$q$,'P0002');
select pg_temp.expect_error($q$select motorist_notification_action('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','snooze','70000000-0000-0000-0000-000000000001',p_snoozed_until=>now()+interval '1 hour')$q$,'P0002');
select pg_temp.expect_error($q$select motorist_notification_action('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','snooze','70000000-0000-0000-0000-000000000003',p_snoozed_until=>now()+interval '1 hour')$q$,'42501');
select motorist_notification_action('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','snooze','70000000-0000-0000-0000-000000000001',p_snoozed_until=>now()+interval '1 hour');
reset role;
select pg_temp.assert_true((select status='unread' and payload ? 'snoozed_until' from motorist_notifications where id='70000000-0000-0000-0000-000000000001'),'own snooze preserves personal payload');
-- The same deployment-activation flag as the task migration protects legacy
-- workflows before their preliminary cancellation/archive writes can commit.
create table public.motorist_task_workspace_settings(organization_id uuid primary key, enabled boolean default false);
insert into motorist_task_workspace_settings values('10000000-0000-0000-0000-000000000001',true);
select pg_temp.expect_error($q$update motorist_task_reminders set status='cancelled' where task_id='50000000-0000-0000-0000-000000000002'$q$,'55000');
select pg_temp.expect_error($q$update motorist_notifications set status='archived' where id='70000000-0000-0000-0000-000000000002'$q$,'55000');
set role service_role;
select motorist_notification_action('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','archived','70000000-0000-0000-0000-000000000002');
reset role;
select pg_temp.assert_true((select status='archived' from motorist_notifications where id='70000000-0000-0000-0000-000000000002'),'authorized actor path survives activation guard');
update motorist_profiles set active=false where id='20000000-0000-0000-0000-000000000003';
select id as inactive_reminder_id from motorist_task_reminders where task_id='50000000-0000-0000-0000-000000000002' and recipient_profile_id='20000000-0000-0000-0000-000000000003' \gset
set role service_role;
select motorist_cancel_unavailable_reminder('10000000-0000-0000-0000-000000000001',:'inactive_reminder_id');
reset role;
select pg_temp.assert_true((select status='cancelled' from motorist_task_reminders where id=:'inactive_reminder_id'),'materializer can cancel inactive recipient through guard');
-- An optional independent reminder time overrides the deadline. Clearing it
-- restores the default deadline schedule; neither value means no reminder.
update motorist_case_tasks set reminder_at='2026-08-31T09:00:00Z' where id='50000000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select due_at='2026-09-01T12:00:00Z' and reminder_generation=4 from motorist_case_tasks where id='50000000-0000-0000-0000-000000000001'),'reminder-only edit leaves deadline unchanged and advances generation');
select pg_temp.assert_true((select scheduled_for='2026-08-31T09:00:00Z' and payload->>'source'='task_custom_reminder' from motorist_task_reminders where task_id='50000000-0000-0000-0000-000000000001' and generation=4),'custom reminder schedule is independent');
update motorist_case_tasks set reminder_at=null where id='50000000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select scheduled_for='2026-09-01T12:00:00Z' and status='pending' from motorist_task_reminders where task_id='50000000-0000-0000-0000-000000000001' and generation=5),'clearing override restores deadline schedule');
insert into motorist_case_tasks(id,organization_id,assigned_to,created_by,reminder_at) values('50000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','2026-09-02T09:00:00Z');
select pg_temp.assert_true((select count(*)=1 and bool_and(scheduled_for='2026-09-02T09:00:00Z') from motorist_task_reminders where task_id='50000000-0000-0000-0000-000000000003'),'reminder without task deadline is valid');
update motorist_case_tasks set reminder_at=null where id='50000000-0000-0000-0000-000000000003';
select pg_temp.assert_true((select count(*)=0 from motorist_task_reminders where task_id='50000000-0000-0000-0000-000000000003' and status='pending'),'clearing both reminder and deadline cancels schedule');
select 'notification contract passed' as result;
