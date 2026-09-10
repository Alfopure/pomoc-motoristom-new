\set ON_ERROR_STOP on
\ir task-reminder-combined-contract.sql
-- Senior dispatchers remain valid assignees and team reminder recipients.
update motorist_profiles set role='senior_dispatcher' where id='20000000-0000-0000-0000-000000000002';
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','create',p_input=>'{"title":"Assigned without deadline","assignedTo":"20000000-0000-0000-0000-000000000002"}') ->> 'id' as assignment_task \gset
reset role;
select pg_temp.assert_true((select count(*)=1 and bool_and(visibility='private' and recipient_profile_id='20000000-0000-0000-0000-000000000002') from motorist_notifications where task_id=:'assignment_task'),'no-deadline create persists one senior private bell inside transaction');
select pg_temp.assert_true((select count(*)=0 from motorist_task_reminders where task_id=:'assignment_task'),'assignment does not invent due reminder');
select pg_temp.assert_true((select count(*)=1 and bool_and(status='pending') from motorist_task_assignment_deliveries where task_id=:'assignment_task'),'no-deadline assignment has durable push outbox');
set role service_role;
select motorist_ensure_task_assignment('10000000-0000-0000-0000-000000000001',:'assignment_task');
select motorist_ensure_task_assignment('10000000-0000-0000-0000-000000000001',:'assignment_task');
select motorist_claim_task_assignments('10000000-0000-0000-0000-000000000001',:'assignment_task') as claimed \gset
select pg_temp.assert_true(jsonb_array_length(:'claimed')=1,'senior assignment is claimable');
select pg_temp.assert_true(jsonb_array_length(motorist_claim_task_assignments('10000000-0000-0000-0000-000000000001',:'assignment_task'))=0,'active lease excludes simultaneous duplicate delivery');
select motorist_finish_task_assignment('10000000-0000-0000-0000-000000000001',(:'claimed'::jsonb->0->>'notificationId')::uuid,(:'claimed'::jsonb->0->>'leaseId')::uuid,false);
reset role;
select pg_temp.assert_true((select count(*)=1 from motorist_notifications where task_id=:'assignment_task'),'legacy bridge and retry never duplicate bell');
select pg_temp.assert_true((select status='pending' and attempts=1 from motorist_task_assignment_deliveries where task_id=:'assignment_task'),'push failure persists retry state');
set role authenticated;
select pg_temp.expect_error(format('select motorist_claim_task_assignments(%L)','10000000-0000-0000-0000-000000000001'),'42501');
select pg_temp.expect_error('select * from motorist_task_assignment_deliveries','42501');
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'assignment_task','{"title":"Edited title","dueAt":"2099-01-01T12:00:00Z","expectedRevision":1}');
reset role;
select pg_temp.assert_true((select count(*)=1 from motorist_notifications where task_id=:'assignment_task'),'title/deadline edit does not repeat assignment event');
select pg_temp.assert_true((select count(*)=1 and bool_and(recipient_profile_id='20000000-0000-0000-0000-000000000002') from motorist_task_reminders where task_id=:'assignment_task' and status='pending'),'future deadline is a distinct senior reminder');
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'assignment_task','{"assignedTo":"20000000-0000-0000-0000-000000000001","expectedRevision":2}');
reset role;
select pg_temp.assert_true((select count(*)=2 from motorist_notifications where task_id=:'assignment_task'),'reassignment creates one event for the new recipient');
select pg_temp.assert_true((select status='cancelled' from motorist_task_assignment_deliveries where task_id=:'assignment_task' and generation=0),'reassignment cancels stale pending push');
set role authenticated;
select pg_temp.expect_error(format('select motorist_task_workspace(%L,%L,%L,%L,%L::jsonb)','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'assignment_task','{"assignedTo":"20000000-0000-0000-0000-000000000002","expectedRevision":2}'),'40001');
reset role;
select pg_temp.assert_true((select count(*)=2 from motorist_notifications where task_id=:'assignment_task'),'CAS rejection adds no assignment side effect');
set role authenticated;
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','create',p_input=>'{"title":"Team reminder includes senior","dueAt":"2099-01-01T12:00:00Z"}') ->> 'id' as team_task \gset
reset role;
select pg_temp.assert_true((select count(*)=1 from motorist_task_reminders where task_id=:'team_task' and recipient_profile_id='20000000-0000-0000-0000-000000000002'),'team generation includes senior dispatcher');
select 'task assignment contract passed' as result;
-- A crashed delivery lease can be reclaimed, but its old worker cannot ack it.
set role service_role;
select motorist_claim_task_assignments('10000000-0000-0000-0000-000000000001',:'assignment_task') as first_lease \gset
reset role;
update motorist_task_assignment_deliveries set claimed_at=clock_timestamp()-interval '11 minutes' where task_id=:'assignment_task' and generation=1;
set role service_role;
select motorist_claim_task_assignments('10000000-0000-0000-0000-000000000001',:'assignment_task') as second_lease \gset
select pg_temp.assert_true(:'first_lease'::jsonb->0->>'notificationId'=:'second_lease'::jsonb->0->>'notificationId' and :'first_lease'::jsonb->0->>'leaseId'<>:'second_lease'::jsonb->0->>'leaseId','recovered lease reuses notification identity');
select pg_temp.assert_true(not motorist_finish_task_assignment('10000000-0000-0000-0000-000000000001',(:'first_lease'::jsonb->0->>'notificationId')::uuid,(:'first_lease'::jsonb->0->>'leaseId')::uuid,true),'stale worker cannot acknowledge current lease');
select pg_temp.assert_true(motorist_finish_task_assignment('10000000-0000-0000-0000-000000000001',(:'second_lease'::jsonb->0->>'notificationId')::uuid,(:'second_lease'::jsonb->0->>'leaseId')::uuid,true),'current worker acknowledges delivery');
select pg_temp.assert_true(jsonb_array_length(motorist_claim_task_assignments('10000000-0000-0000-0000-000000000001',:'assignment_task'))=0,'delivered assignment never claims again');
reset role;
-- A failure after task triggers proves bell/outbox/task share one transaction.
create function pg_temp.reject_assignment_audit() returns trigger language plpgsql as $$ begin raise exception 'test audit failure'; end $$;
create trigger reject_assignment_audit before insert on motorist_audit_log for each row execute function pg_temp.reject_assignment_audit();
set role authenticated;
select pg_temp.expect_error($q$select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','create',p_input=>'{"title":"ROLLBACK ASSIGNMENT","assignedTo":"20000000-0000-0000-0000-000000000002"}')$q$,'P0001');
reset role;
drop trigger reject_assignment_audit on motorist_audit_log;
select pg_temp.assert_true((select count(*)=0 from motorist_case_tasks where title='ROLLBACK ASSIGNMENT'),'late failure rolls back task');
select pg_temp.assert_true((select count(*)=0 from motorist_notifications where body='ROLLBACK ASSIGNMENT'),'late failure rolls back assignment bell and cascading outbox');
select 'task assignment lease and rollback contract passed' as result;
