\set ON_ERROR_STOP on
\ir notebook-fixture.sql
\ir ../../supabase/migrations/20260929100000_personal_notes.sql
create function pg_temp.assert_true(value boolean, description text) returns void language plpgsql as $$ begin if value is distinct from true then raise exception 'FAILED: %', description; end if; end $$;
create function pg_temp.expect_error(statement text, expected_code text) returns void language plpgsql as $$ begin
  begin execute statement; exception when others then if sqlstate = expected_code then return; end if; raise; end;
  raise exception 'Expected rejection %', expected_code;
end $$;
-- Private topic ACL permits only the current profile's exact topic.
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select set_config('test.realtime_topic','notebook:10000000-0000-0000-0000-000000000001:20000000-0000-0000-0000-000000000001',false);
select pg_temp.assert_true((select count(*) = 1 from realtime.messages), 'own private invalidation topic');
select set_config('test.realtime_topic','notebook:10000000-0000-0000-0000-000000000001:20000000-0000-0000-0000-000000000002',false);
select pg_temp.assert_true((select count(*) = 0 from realtime.messages), 'another profile topic is denied');
reset role;
-- Owner creates a private note through exactly the production RPC.
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select public.motorist_notebook('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','create',p_title=>'Only A',p_body=>'PRIVATE_BODY') ->> 'id' as note_id \gset
select pg_temp.assert_true((select count(*) = 1 from public.motorist_notes), 'owner RLS read');
select pg_temp.assert_true((select count(*) = 0 from public.motorist_note_shares), 'default private');
-- Direct writes cannot bypass the revision RPC.
select pg_temp.expect_error('update public.motorist_notes set body = ''BYPASS''', '42501');
-- Unshared administrator has no product-wide notebook privilege.
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000003',false);
select pg_temp.assert_true((select count(*) = 0 from public.motorist_notes), 'admin cannot read another notebook');
select pg_temp.expect_error(format('select public.motorist_notebook(%L,%L,%L,p_note_id=>%L)', '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003','get', :'note_id'), 'P0002');
-- Supplying another actor ID does not impersonate them.
select pg_temp.expect_error($q$select public.motorist_notebook('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','list')$q$, '42501');
-- Share to B, then prove B read-only through both RLS and RPC.
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select public.motorist_notebook('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','save', :'note_id',1,'Only A','PRIVATE_BODY',array['20000000-0000-0000-0000-000000000002']::uuid[]) ->> 'revision';
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000002',false);
select pg_temp.assert_true((select count(*) = 1 from public.motorist_notes), 'recipient reads shared note');
select pg_temp.assert_true((select count(*) = 0 from public.motorist_note_shares), 'recipient cannot read recipient directory');
select pg_temp.assert_true((public.motorist_notebook('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','get', :'note_id')->>'canEdit')::boolean = false, 'read only DTO');
select pg_temp.expect_error(format('select public.motorist_notebook(%L,%L,%L,%L,2)', '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','save', :'note_id'), 'P0002');
select pg_temp.expect_error(format('select public.motorist_notebook(%L,%L,%L,%L,2)', '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','delete', :'note_id'), 'P0002');
-- Cross-org sharing fails atomically. Stale revisions fail without changing text.
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select pg_temp.expect_error(format('select public.motorist_notebook(%L,%L,%L,%L,2,%L,%L,array[%L]::uuid[])', '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','save', :'note_id','NO','NO','20000000-0000-0000-0000-000000000004'), '22023');
select pg_temp.expect_error(format('select public.motorist_notebook(%L,%L,%L,%L,1,%L,%L)', '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','save', :'note_id','NO','NO'), '40001');
select pg_temp.assert_true((select body = 'PRIVATE_BODY' and revision = 2 from public.motorist_notes), 'failed writes rollback');
-- Revoke: next read immediately loses access, owner keeps the note.
select public.motorist_notebook('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','save', :'note_id',2,'Only A','PRIVATE_BODY');
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000002',false);
select pg_temp.assert_true((select count(*) = 0 from public.motorist_notes), 'revoked recipient RLS');
select pg_temp.expect_error(format('select public.motorist_notebook(%L,%L,%L,%L)', '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','get', :'note_id'), 'P0002');
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000004',false);
select pg_temp.assert_true((select count(*) = 0 from public.motorist_notes), 'other organization RLS');
reset role;
update public.motorist_profiles set active = false where id = '20000000-0000-0000-0000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select pg_temp.assert_true((select count(*) = 0 from public.motorist_notes), 'inactive owner RLS');
select pg_temp.expect_error($q$select public.motorist_notebook('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','list')$q$, '42501');
select set_config('request.jwt.claim.sub','',false);
select pg_temp.expect_error($q$select public.motorist_notebook('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','list')$q$, '42501');
reset role;
select pg_temp.assert_true(not exists(select 1 from realtime.test_invalidations where payload <> '{}'::jsonb or not private or event <> 'invalidate'), 'content-free private realtime');
select pg_temp.assert_true((select count(*) >= 2 from realtime.test_invalidations where topic = 'notebook:10000000-0000-0000-0000-000000000001:20000000-0000-0000-0000-000000000002'), 'revocation invalidation reaches former recipient');
select pg_temp.assert_true(not has_function_privilege('anon','public.motorist_notebook(uuid,uuid,text,uuid,integer,text,text,uuid[])','execute'), 'anonymous RPC denied');
select pg_temp.assert_true(not has_function_privilege('authenticated','app_private.motorist_note_dto(public.motorist_notes,uuid)','execute'), 'internal DTO cannot bypass ACL');
-- Inactive recipients lose an existing share; inactive organizations lose every read.
update public.motorist_profiles set active = true where id = '20000000-0000-0000-0000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select public.motorist_notebook('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','save', :'note_id',3,'Only A','PRIVATE_BODY',array['20000000-0000-0000-0000-000000000002']::uuid[]) ->> 'revision';
reset role;
update public.motorist_profiles set active = false where id = '20000000-0000-0000-0000-000000000002';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000002',false);
select pg_temp.assert_true((select count(*) = 0 from public.motorist_notes), 'inactive shared recipient RLS');
select pg_temp.expect_error($q$select public.motorist_notebook('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','list')$q$, '42501');
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false);
select pg_temp.expect_error(format('select public.motorist_notebook(%L,%L,%L,%L,4,%L,%L,array[%L]::uuid[])', '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','save', :'note_id','NO','NO','20000000-0000-0000-0000-000000000002'), '22023');
reset role;
update public.motorist_organizations set active = false where id = '10000000-0000-0000-0000-000000000001';
set role authenticated;
select pg_temp.assert_true((select count(*) = 0 from public.motorist_notes), 'inactive organization RLS');
select pg_temp.expect_error($q$select public.motorist_notebook('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','list')$q$, '42501');
reset role;
update public.motorist_organizations set active = true where id = '10000000-0000-0000-0000-000000000001';
set role authenticated;
select public.motorist_notebook('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','delete', :'note_id',4);
select pg_temp.assert_true((select count(*) = 0 from public.motorist_notes), 'owner delete');
reset role;
select pg_temp.assert_true((select count(*) = 0 from public.motorist_note_shares), 'delete cascades shares');
select pg_temp.assert_true(not has_function_privilege('service_role','public.motorist_notebook(uuid,uuid,text,uuid,integer,text,text,uuid[])','execute'), 'service role cannot impersonate session actor');
select 'Notebook SQL role/revision/revocation matrix passed' as result;
