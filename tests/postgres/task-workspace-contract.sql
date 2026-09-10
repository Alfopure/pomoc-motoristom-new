\set ON_ERROR_STOP on
\ir task-workspace-fixture.sql
\ir ../../supabase/migrations/20260929120000_task_workspace.sql
create function pg_temp.assert_true(value boolean, description text) returns void language plpgsql as $$ begin if value is distinct from true then raise exception 'FAILED: %', description; end if; end $$;
create function pg_temp.expect_error(statement text, expected_code text) returns void language plpgsql as $$ begin
 begin execute statement; exception when others then if sqlstate = expected_code then return; end if; raise; end;
 raise exception 'Expected rejection %', expected_code;
end $$;
select pg_temp.assert_true((select count(*)=5 from public.motorist_task_case_links),'exact one-link backfill');
select pg_temp.assert_true((select count(*)=2 from public.motorist_task_origins),'only proven relational origins backfilled');
select pg_temp.assert_true((select provenance='ambiguous' and origin_locked from public.motorist_case_tasks where id='50000000-0000-0000-0000-000000000005'),'mismatched source mapping locks origin even with editable ordinary kind');
-- Legacy bridge remains compatible before activation.
set role service_role;
insert into public.motorist_case_tasks(organization_id,case_id,title) values('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002','Legacy insert') returning id as legacy_id \gset
select pg_temp.assert_true((select count(*)=1 from public.motorist_task_case_links where task_id=:'legacy_id'),'legacy insertion bridge');
update public.motorist_case_tasks set title='Legacy update' where id=:'legacy_id';
select pg_temp.assert_true((select count(*)=1 from public.motorist_task_case_links where task_id=:'legacy_id'),'ordinary update preserves links');
select pg_temp.expect_error(format('update public.motorist_case_tasks set case_id=%L where id=%L','40000000-0000-0000-0000-000000000003',:'legacy_id'),'42501');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select pg_temp.expect_error($q$select public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','create',p_input=>'{}')$q$,'55000');
reset role;
select pg_temp.expect_error($q$update public.motorist_task_workspace_settings set enabled=true$q$,'23514');
-- Only this isolated test inventory is approved; no deployment flag is changed.
update public.motorist_task_workspace_settings set enabled=true,writer_inventory_verified_at=now(),writer_inventory_note='Isolated test: only session RPC writer allowed' where organization_id='10000000-0000-0000-0000-000000000001';
set role service_role;
select pg_temp.expect_error(format('update public.motorist_case_tasks set title=%L where id=%L','Blocked',:'legacy_id'),'55000');
select pg_temp.expect_error(format('delete from public.motorist_case_tasks where id=%L',:'legacy_id'),'55000');
select pg_temp.expect_error($q$insert into public.motorist_case_tasks(organization_id,case_id,title) values('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002','Blocked')$q$,'55000');
reset role;
set role authenticated;
select public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','create',p_input=>'{"title":"Team task","caseIds":[]}')->>'id' as task_id \gset
select pg_temp.assert_true((select case_id is null from public.motorist_case_tasks where id=:'task_id'),'zero-case task');
select pg_temp.assert_true((public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','link',:'task_id','{"caseId":"40000000-0000-0000-0000-000000000001","expectedRevision":1}')->>'revision')::integer=2,'first link CAS');
select pg_temp.assert_true((public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','link',:'task_id','{"caseId":"40000000-0000-0000-0000-000000000002","expectedRevision":2}')->'caseIds') @> '["40000000-0000-0000-0000-000000000002"]','closed case can be linked');
select pg_temp.expect_error(format('select public.motorist_task_workspace(%L,%L,%L,%L,%L)', '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','update',:'task_id','{"title":"Stale","expectedRevision":1}'),'40001');
select pg_temp.expect_error(format('select public.motorist_task_workspace(%L,%L,%L,%L,%L)', '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','link',:'task_id','{"caseId":"40000000-0000-0000-0000-000000000004","expectedRevision":3}'),'22023');
select pg_temp.assert_true((select title='Team task' and revision=3 from public.motorist_case_tasks where id=:'task_id'),'CAS and cross-org failure rollback');
-- Normal origin unlink keeps remaining context links and clears legacy origin.
select public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','link','50000000-0000-0000-0000-000000000001','{"caseId":"40000000-0000-0000-0000-000000000002","expectedRevision":1}') ->> 'revision' as ordinary_revision \gset
select public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','unlink','50000000-0000-0000-0000-000000000001',jsonb_build_object('caseId','40000000-0000-0000-0000-000000000001','expectedRevision',:'ordinary_revision'::integer));
select pg_temp.assert_true((select case_id is null from public.motorist_case_tasks where id='50000000-0000-0000-0000-000000000001'),'ordinary origin cleared');
select pg_temp.assert_true((select count(*)=1 from public.motorist_task_case_links where task_id='50000000-0000-0000-0000-000000000001'),'unlink preserves other links');
-- Proven and ambiguous origins cannot be unlinked even after changing kind.
select pg_temp.expect_error($q$select public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','unlink','50000000-0000-0000-0000-000000000002','{"caseId":"40000000-0000-0000-0000-000000000001","expectedRevision":1}')$q$,'22023');
select pg_temp.expect_error($q$select public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','unlink','50000000-0000-0000-0000-000000000003','{"caseId":"40000000-0000-0000-0000-000000000001","expectedRevision":1}')$q$,'22023');
-- One idempotent message and no duplicate on retry.
select public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','send_message',:'task_id','{"body":"CHAT_BODY","clientMessageId":"80000000-0000-0000-0000-000000000001"}')->>'id' as message_id \gset
select pg_temp.assert_true(public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','send_message',:'task_id','{"body":"CHAT_BODY","clientMessageId":"80000000-0000-0000-0000-000000000001"}')->>'id'=:'message_id','chat retry is idempotent');
select pg_temp.expect_error(format('select public.motorist_task_workspace(%L,%L,%L,%L,%L)','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','send_message',:'task_id','{"body":"Different","clientMessageId":"80000000-0000-0000-0000-000000000001"}'),'40001');
select pg_temp.expect_error(format('select public.motorist_task_workspace(%L,%L,%L,%L,%L)','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','send_message',:'task_id',jsonb_build_object('body',repeat('x',10001),'clientMessageId','80000000-0000-0000-0000-000000000002')::text),'22023');
select pg_temp.assert_true(jsonb_array_length(public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','messages',:'task_id')->'messages')=1,'chat read');
-- Pagination is chronological, bounded at 50, with no duplicates across cursors.
create function pg_temp.test_chat_pages(p_task uuid) returns void language plpgsql as $$
declare i integer; latest jsonb; older jsonb; begin
 for i in 2..52 loop
  perform public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','send_message',p_task,jsonb_build_object('body','Message '||i,'clientMessageId','80000000-0000-0000-0000-'||lpad(i::text,12,'0')));
 end loop;
 latest:=public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','messages',p_task);
 perform pg_temp.assert_true(jsonb_array_length(latest->'messages')=50,'chat page is bounded to 50');
 older:=public.motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','messages',p_task,jsonb_build_object('beforeCreatedAt',latest->'nextCursor'->>'createdAt','beforeId',latest->'nextCursor'->>'id'));
 perform pg_temp.assert_true(jsonb_array_length(older->'messages')=2 and older->'nextCursor'='null'::jsonb,'older page consumes remainder');
 perform pg_temp.assert_true(not exists(select 1 from jsonb_array_elements(latest->'messages') a join jsonb_array_elements(older->'messages') b on a->>'id'=b->>'id'),'no cursor duplicates');
 perform pg_temp.assert_true((select array_agg(value->>'id' order by ordinal)=array_agg(value->>'id' order by value->>'createdAt',value->>'id') from jsonb_array_elements(latest->'messages') with ordinality rows(value,ordinal)),'page chronological order');
end $$;
select pg_temp.test_chat_pages(:'task_id');
-- A different org/admin cannot access task IDs or inject author identity.
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000004',false);
select pg_temp.assert_true((select count(*)=0 from public.motorist_case_tasks),'cross org RLS tasks');
select pg_temp.assert_true((select count(*)=0 from public.motorist_task_messages),'cross org RLS chat');
select pg_temp.expect_error(format('select public.motorist_task_workspace(%L,%L,%L,%L)','10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004','get',:'task_id'),'P0002');
select pg_temp.expect_error(format('select public.motorist_task_workspace(%L,%L,%L,%L)','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','get',:'task_id'),'42501');
reset role;
-- Case deletion preserves shared task, chat, reminders and cancels proven origin obligations.
insert into public.motorist_task_reminders(organization_id,case_id,task_id) values('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',:'task_id');
delete from public.motorist_cases where id='40000000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select count(*)=1 from public.motorist_case_tasks where id=:'task_id'),'case delete preserves shared task');
select pg_temp.assert_true((select count(*)=52 from public.motorist_task_messages where task_id=:'task_id'),'case delete preserves chat');
select pg_temp.assert_true((select count(*)=1 from public.motorist_task_reminders where task_id=:'task_id' and case_id is null),'case delete preserves reminders');
select pg_temp.assert_true((select status='cancelled' from public.motorist_callback_requests where id='60000000-0000-0000-0000-000000000001'),'origin callback cancelled');
select pg_temp.assert_true((select status='failed' and next_attempt_at is null from public.motorist_sms_messages where id='70000000-0000-0000-0000-000000000001'),'queued origin SMS cancelled');
select pg_temp.assert_true((select count(*)=2 from public.motorist_task_origins where origin_case_id='40000000-0000-0000-0000-000000000001' and cancelled_at is not null),'immutable origin IDs retained');
select pg_temp.assert_true(not exists(select 1 from realtime.test_invalidations where payload<>'{}'::jsonb),'no chat content in realtime');
select 'Task workspace SQL matrix passed' as result;
