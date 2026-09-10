\set ON_ERROR_STOP on
\ir task-workspace-fixture.sql
-- Historical IDs came from either user selection or an editable-title heuristic;
-- absence of the explicit marker is not evidence of which one happened.
insert into motorist_sms_messages(id,organization_id,case_id,template_key,status,provider_message_id,raw_payload) values
 ('70000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','eta_update','sent','historical-provider','{"source":"sms_composer","task_id":"50000000-0000-0000-0000-000000000001"}');
insert into motorist_location_share_links(id,organization_id,case_id,status,expires_at,metadata) values
 ('80000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','used','2026-09-11','{"source":"sms_location_request","task_id":"50000000-0000-0000-0000-000000000003"}');
insert into motorist_location_submissions(id,organization_id,case_id,link_id,accepted,submitted_at) values
 ('81000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001',true,'2026-09-10');
-- Reproduce historical org-member FOR ALL source policies and inherited broad
-- grants (foundation SMS + location_share_links migrations), not a service-only stub.
create function app_private.motorist_is_org_member(org uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.motorist_profiles p where p.organization_id=org and p.user_id=auth.uid() and p.active) $$;
grant usage on schema app_private to authenticated;
grant execute on function app_private.motorist_is_org_member(uuid) to authenticated;
alter table motorist_sms_messages enable row level security;
create policy motorist_sms_messages_organization_access on motorist_sms_messages for all using(app_private.motorist_is_org_member(organization_id)) with check(app_private.motorist_is_org_member(organization_id));
alter table motorist_location_share_links enable row level security;
create policy location_share_links_organization_access on motorist_location_share_links for all using(app_private.motorist_is_org_member(organization_id)) with check(app_private.motorist_is_org_member(organization_id));
alter table motorist_location_submissions enable row level security;
create policy location_submissions_organization_access on motorist_location_submissions for all using(app_private.motorist_is_org_member(organization_id)) with check(app_private.motorist_is_org_member(organization_id));
grant select,insert,update,delete on motorist_sms_messages,motorist_location_share_links,motorist_location_submissions,motorist_callback_requests to authenticated;
grant select,insert,update,delete on motorist_location_share_links,motorist_location_submissions to service_role;
-- Simulate a legacy inherited role carrying column privileges. Revoking direct
-- table grants from authenticated cannot remove its role inheritance.
do $$ begin create role task_source_legacy_columns_test nologin; exception when duplicate_object then null; end $$;
grant task_source_legacy_columns_test to authenticated;
grant update(raw_payload,provider_message_id,status,direction),insert(organization_id,case_id,raw_payload,provider_message_id,status,direction,template_key) on motorist_sms_messages to task_source_legacy_columns_test;
grant update(metadata,status) on motorist_location_share_links to task_source_legacy_columns_test;
grant update(accepted) on motorist_location_submissions to task_source_legacy_columns_test;
\ir ../../supabase/migrations/20260929120000_task_workspace.sql
create function pg_temp.assert_true(value boolean, description text) returns void language plpgsql as $$ begin if value is distinct from true then raise exception 'FAILED: %',description; end if; end $$;
create function pg_temp.expect_error(statement text, expected_code text) returns void language plpgsql as $$ begin begin execute statement; exception when others then if sqlstate=expected_code then return; end if; raise; end; raise exception 'Expected %',expected_code; end $$;
select pg_temp.assert_true((select count(*)=2 from motorist_task_origins),'only explicit SMS and proven callback backfilled');
select pg_temp.assert_true((select provenance='ambiguous' and origin_locked and status='open' from motorist_case_tasks where id='50000000-0000-0000-0000-000000000001'),'unmarked historical SMS locks ordinary task without promoting source');
select pg_temp.assert_true((select raw_payload->>'task_association' is null from motorist_sms_messages where id='70000000-0000-0000-0000-000000000002'),'historical payload remains unchanged');
set role service_role;
select pg_temp.assert_true(motorist_complete_task_source_v1('10000000-0000-0000-0000-000000000001','sms','70000000-0000-0000-0000-000000000002')->>'completed'='false','unmarked accepted SMS cannot complete after migration even while flag off');
select pg_temp.assert_true(motorist_complete_task_source_v1('10000000-0000-0000-0000-000000000001','location','81000000-0000-0000-0000-000000000001')->>'completed'='false','accepted historical unmarked location cannot complete');
select pg_temp.expect_error($q$update motorist_sms_messages set raw_payload=raw_payload||'{"task_association":"explicit"}' where id='70000000-0000-0000-0000-000000000002'$q$,'42501');
reset role;
update motorist_task_workspace_settings set enabled=true,writer_inventory_verified_at=now(),writer_inventory_note='Local provenance test only' where organization_id='10000000-0000-0000-0000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select motorist_task_workspace('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','create',p_input=>'{"title":"Overiť ETA zmluvy","caseIds":["40000000-0000-0000-0000-000000000001"]}') ->> 'id' as new_task \gset
set role service_role;
insert into motorist_sms_messages(organization_id,case_id,template_key,status,provider_message_id,raw_payload) values
 ('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','eta_update','sent','accepted-legacy',jsonb_build_object('source','sms_composer','task_id',:'new_task')) returning id as unmarked_sms \gset
select pg_temp.assert_true((select provenance='ambiguous' and origin_locked from motorist_case_tasks where id=:'new_task'),'new unmarked legacy writer stays ambiguous under active workspace');
select pg_temp.assert_true(motorist_complete_task_source_v1('10000000-0000-0000-0000-000000000001','sms',:'unmarked_sms')->>'completed'='false','active workspace rejects unmarked completion');
insert into motorist_sms_messages(organization_id,case_id,template_key,status,provider_message_id,raw_payload) values
 ('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','eta_update','sent','accepted-explicit',jsonb_build_object('source','sms_composer','task_id',:'new_task','task_association','explicit')) returning id as explicit_sms \gset
select pg_temp.assert_true(motorist_complete_task_source_v1('10000000-0000-0000-0000-000000000001','sms',:'explicit_sms')->>'completed'='true','new explicit source completes exact original task');
select pg_temp.assert_true((select count(*)=1 from motorist_task_origins where task_id=:'new_task' and source_id=:'explicit_sms'),'explicit new source is retained without promoting old unmarked source');
select pg_temp.expect_error(format('update motorist_sms_messages set raw_payload=raw_payload-%L where id=%L','task_association',:'explicit_sms'),'42501');
select 'SMS explicit provenance contract passed' as result;

-- Category/direction escape routes cannot launder an unmarked historical source.
set role service_role;
select pg_temp.expect_error($q$update motorist_sms_messages set raw_payload=raw_payload||'{"source":"other","task_association":"explicit"}' where id='70000000-0000-0000-0000-000000000002'$q$,'42501');
select pg_temp.expect_error($q$update motorist_sms_messages set raw_payload=raw_payload||'{"source":"other"}' where id='70000000-0000-0000-0000-000000000002'$q$,'42501');
select pg_temp.expect_error($q$update motorist_sms_messages set direction='inbound',raw_payload=raw_payload||'{"task_association":"explicit"}' where id='70000000-0000-0000-0000-000000000002'$q$,'42501');
select pg_temp.expect_error($q$update motorist_location_share_links set metadata=metadata||'{"source":"other","task_association":"explicit"}' where id='80000000-0000-0000-0000-000000000001'$q$,'42501');
select pg_temp.expect_error($q$update motorist_location_share_links set metadata=metadata||'{"source":"other"}' where id='80000000-0000-0000-0000-000000000001'$q$,'42501');
insert into motorist_sms_messages(organization_id,case_id,raw_payload) values('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','{"source":"other","task_association":"explicit","task_id":"50000000-0000-0000-0000-000000000001"}') returning id as outside_sms \gset
select pg_temp.expect_error(format('update motorist_sms_messages set raw_payload=raw_payload||%L::jsonb where id=%L','{"source":"sms_composer"}',:'outside_sms'),'42501');
insert into motorist_location_share_links(organization_id,case_id,metadata) values('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','{"source":"other","task_association":"explicit","task_id":"50000000-0000-0000-0000-000000000001"}') returning id as outside_link \gset
select pg_temp.expect_error(format('update motorist_location_share_links set metadata=metadata||%L::jsonb where id=%L','{"source":"sms_location_request"}',:'outside_link'),'42501');
reset role;
select pg_temp.assert_true(not has_table_privilege('authenticated','motorist_sms_messages','INSERT') and not has_table_privilege('authenticated','motorist_location_submissions','UPDATE'),'broad browser source DML is revoked');
select pg_temp.assert_true(has_column_privilege('authenticated','motorist_sms_messages','provider_message_id','UPDATE'),'fixture retains inherited column grant to exercise invoker guard');
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select pg_temp.assert_true(app_private.motorist_is_org_member('10000000-0000-0000-0000-000000000001'),'browser meets original broad RLS policy');
select set_config('app.task_workspace_write','v1',true);
select pg_temp.expect_error($q$update motorist_sms_messages set provider_message_id='forged-provider',status='sent' where id='70000000-0000-0000-0000-000000000002'$q$,'42501');
select pg_temp.expect_error($q$insert into motorist_sms_messages(organization_id,case_id,status,provider_message_id,direction,template_key,raw_payload) values('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','sent','forged','outbound','eta_update','{"source":"sms_composer","task_association":"explicit","task_id":"50000000-0000-0000-0000-000000000001"}')$q$,'42501');
select pg_temp.expect_error($q$update motorist_location_share_links set metadata=metadata||'{"task_association":"explicit"}' where id='80000000-0000-0000-0000-000000000001'$q$,'42501');
select pg_temp.expect_error($q$update motorist_location_submissions set accepted=true where id='81000000-0000-0000-0000-000000000001'$q$,'42501');
select pg_temp.expect_error($q$delete from motorist_callback_requests where id='60000000-0000-0000-0000-000000000001'$q$,'42501');
reset role;
-- The inherited privilege role itself also cannot become a trusted writer.
grant usage on schema public,app_private to task_source_legacy_columns_test;
grant select on motorist_sms_messages to task_source_legacy_columns_test;
set role task_source_legacy_columns_test;
select pg_temp.expect_error($q$update motorist_sms_messages set provider_message_id='forged-role' where id='70000000-0000-0000-0000-000000000002'$q$,'42501');
reset role;
select 'SMS category and trusted-writer boundary passed' as result;

revoke task_source_legacy_columns_test from authenticated;
