-- Isolated LOCAL contract only. All fixture rows roll back.
begin;
insert into public.motorist_organizations(id) values('c1000000-0000-4000-8000-000000000001'),('c1000000-0000-4000-8000-000000000002');
insert into auth.users(id) values('c2000000-0000-4000-8000-000000000001');
insert into public.motorist_profiles(id,user_id,organization_id,active,role,email,access_status)
  values('c3000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',true,'manager','office@example.invalid','active');
insert into public.motorist_partner_directory(id,organization_id,name,active) values
  ('c4000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','Historical partner name',true),
  ('c4000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002','Other org',true);
insert into public.motorist_telephony_lines(id,organization_id) values('c8000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001');
insert into public.motorist_call_sessions(id,organization_id) values('c9000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001');
set local role service_role;
do $$
declare
  org uuid := 'c1000000-0000-4000-8000-000000000001'; actor uuid := 'c3000000-0000-4000-8000-000000000001';
  command uuid := 'c7000000-0000-4000-8000-000000000001'; failed_command uuid := 'c7000000-0000-4000-8000-000000000002';
  origin jsonb := '{"partnerId":"c4000000-0000-4000-8000-000000000001","sourceLineId":"c8000000-0000-4000-8000-000000000001","sourceCallId":"c9000000-0000-4000-8000-000000000001"}';
  plan jsonb := '[]'; patch jsonb; result jsonb; replay jsonb;
begin
  patch := jsonb_build_object('organization_id',org,'owner_id',actor,'case_number','PM-2026-0001','status','new','priority','normal','source_type','partner','case_type','Konzultácia', 'payment_details',jsonb_build_object('payer','Independent payer'));
  result := public.motorist_create_case_atomic(org,actor,command,repeat('a',64),patch,plan,'Original history','{"source":"manual_dispatch_form"}',origin);
  replay := public.motorist_create_case_atomic(org,actor,command,repeat('a',64),patch||'{"case_number":"PM-2026-9999"}',plan,'Different preprocessing','{}',origin);
  if result <> replay or result->>'id' <> command::text or result->>'case_number' <> 'PM-2026-0001' then raise exception 'FAIL replay/identity/number'; end if;
  if (select count(*) from public.motorist_case_events where case_id=command) <> 1 or (select count(*) from public.motorist_audit_log where entity_id=command and action='case.create') <> 1 then raise exception 'FAIL duplicated effects'; end if;
  if (select partner_name from public.motorist_partner_case_contexts where case_id=command) <> 'Historical partner name'
    or (select source_call_id from public.motorist_partner_case_contexts where case_id=command) <> 'c9000000-0000-4000-8000-000000000001'::uuid
    or (select settlement->>'approvedCents' from public.motorist_partner_case_contexts where case_id=command) is not null
    or (select payment_details->>'payer' from public.motorist_cases where id=command) <> 'Independent payer' then raise exception 'FAIL immutable origin/independent payer'; end if;
  begin
    perform public.motorist_create_case_atomic(org,actor,command,repeat('b',64),patch,plan,'','{}',origin);
    raise exception 'FAIL changed content replay';
  exception when sqlstate 'PT422' then null; end;
  -- The partner validation fails after the related insert and case insert; both roll back.
  patch := patch || '{"contact_id":"c6000000-0000-4000-8000-000000000001"}';
  plan := '[{"table":"motorist_contacts","id":"c6000000-0000-4000-8000-000000000001","insert":true,"patch":{"name":"Rollback contact","role":"client"}}]';
  begin
    perform public.motorist_create_case_atomic(org,actor,failed_command,repeat('c',64),patch,plan,'','{}',origin||'{"partnerId":"c4000000-0000-4000-8000-000000000002"}');
    raise exception 'FAIL cross-org origin';
  exception when insufficient_privilege then null; end;
  if exists(select 1 from public.motorist_cases where id=failed_command) or exists(select 1 from public.motorist_contacts where id='c6000000-0000-4000-8000-000000000001')
    or exists(select 1 from public.motorist_case_creation_commands where command_id=failed_command) then raise exception 'FAIL partial creation escaped transaction'; end if;
  update public.motorist_profiles set access_status='disabled' where id=actor;
  begin
    perform public.motorist_create_case_atomic(org,actor,command,repeat('a',64),patch,plan,'','{}',origin);
    raise exception 'FAIL disabled receipt replay';
  exception when insufficient_privilege then null; end;
  update public.motorist_profiles set access_status='active' where id=actor;
  result := public.motorist_create_case_atomic(org,actor,failed_command,repeat('d',64),patch,plan,'History with contact','{}',null);
  if result->>'case_number' <> 'PM-2026-0002' or not exists(select 1 from public.motorist_contacts where id='c6000000-0000-4000-8000-000000000001')
    or exists(select 1 from public.motorist_partner_case_contexts where case_id=failed_command) then raise exception 'FAIL ordinary atomic create'; end if;
  if has_function_privilege('authenticated','public.motorist_create_case_atomic(uuid,uuid,uuid,text,jsonb,jsonb,text,jsonb,jsonb)','EXECUTE')
    or has_table_privilege('authenticated','public.motorist_case_creation_commands','SELECT') then raise exception 'FAIL public creation grant'; end if;
end $$;
reset role;
rollback;
