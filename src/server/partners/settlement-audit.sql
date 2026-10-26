-- Isolated LOCAL contract only; requires the partner and settlement audit migrations.
begin;
insert into public.motorist_organizations(id) values('ca100000-0000-4000-8000-000000000001');
insert into auth.users(id) values('ca200000-0000-4000-8000-000000000001'),('ca200000-0000-4000-8000-000000000002');
insert into public.motorist_profiles(id,user_id,organization_id,active,role,email,access_status) values
  ('ca300000-0000-4000-8000-000000000001','ca200000-0000-4000-8000-000000000001','ca100000-0000-4000-8000-000000000001',true,'manager','author-one@example.invalid','active'),
  ('ca300000-0000-4000-8000-000000000002','ca200000-0000-4000-8000-000000000002','ca100000-0000-4000-8000-000000000001',true,'manager','author-two@example.invalid','active');
insert into public.motorist_partner_directory(id,organization_id,name,active)
  values('ca400000-0000-4000-8000-000000000001','ca100000-0000-4000-8000-000000000001','Synthetic partner',true);
insert into public.motorist_cases(id,organization_id,case_number,status,priority,source_type,case_type)
  values('ca500000-0000-4000-8000-000000000001','ca100000-0000-4000-8000-000000000001','AUDIT-1','new','normal','partner','Konzultácia');
-- Exercise the row guard even when a service role has ordinary audit DML grants.
grant delete on public.motorist_audit_log to service_role;
set local role service_role;
do $$
declare
  org uuid := 'ca100000-0000-4000-8000-000000000001'; caseid uuid := 'ca500000-0000-4000-8000-000000000001';
  user_one uuid := 'ca200000-0000-4000-8000-000000000001'; user_two uuid := 'ca200000-0000-4000-8000-000000000002';
  command uuid := 'ca700000-0000-4000-8000-000000000002'; payload jsonb; settlement jsonb;
  entry public.motorist_audit_log; failed boolean := false;
begin
  settlement := '{"payer":"Partner","reference":"CONSULT-1","agreement":"Approved agreement","agreementVersion":"1","billable":false,"approvedCents":null,"currency":"EUR","recommendation":"Service only recommended","serviceAccepted":false,"acceptanceEvidence":""}';
  payload := jsonb_build_object('caseId', caseid, 'partnerId', 'ca400000-0000-4000-8000-000000000001', 'settlement', settlement);
  perform public.motorist_partner_command(user_one,org,'ca700000-0000-4000-8000-000000000001',0,'set_context',payload);
  select * into entry from public.motorist_audit_log where entity_id=caseid and action='partner.settlement.create';
  if entry.id is null or entry.actor_profile_id <> 'ca300000-0000-4000-8000-000000000001'::uuid
    or entry.before_payload is not null or entry.after_payload->>'approvedCents' is not null
    or entry.after_payload->>'partnerId' <> 'ca400000-0000-4000-8000-000000000001' or entry.created_at is null then
    raise exception 'FAIL initial context audit';
  end if;
  settlement := settlement || '{"billable":true,"approvedCents":3200,"agreementVersion":"2"}';
  payload := payload || jsonb_build_object('settlement', settlement);
  perform public.motorist_partner_command(user_two,org,command,1,'set_context',payload);
  select * into entry from public.motorist_audit_log where entity_id=caseid and action='partner.settlement.update';
  if entry.id is null or entry.actor_profile_id <> 'ca300000-0000-4000-8000-000000000002'::uuid
    or entry.before_payload->>'approvedCents' is not null or entry.after_payload->>'approvedCents' <> '3200'
    or entry.before_payload->'settlement'->>'agreementVersion' <> '1' or entry.after_payload->'settlement'->>'agreementVersion' <> '2'
    or entry.after_payload->>'caseId' <> caseid::text or entry.after_payload->>'revision' <> '2' then
    raise exception 'FAIL author or before/after settlement';
  end if;
  perform public.motorist_partner_command(user_two,org,command,1,'set_context',payload);
  if (select count(*) from public.motorist_audit_log where entity_id=caseid) <> 2 then raise exception 'FAIL replay duplicated audit'; end if;
  begin
    perform public.motorist_partner_command(user_two,org,'ca700000-0000-4000-8000-000000000003',2,'set_context',
      payload || jsonb_build_object('settlement', settlement || '{"approvedCents":-1}'));
  exception when sqlstate 'P0001' then failed := true; end;
  if not failed or (select count(*) from public.motorist_audit_log where entity_id=caseid) <> 2
    or (select context.settlement->>'approvedCents' from public.motorist_partner_case_contexts context where context.case_id=caseid) <> '3200' then
    raise exception 'FAIL rejected context produced audit/state';
  end if;
  failed := false;
  begin update public.motorist_audit_log set after_payload='{}' where id=entry.id;
  exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'FAIL audit update allowed'; end if;
  failed := false;
  begin delete from public.motorist_audit_log where id=entry.id;
  exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'FAIL audit delete allowed'; end if;
  if has_function_privilege('authenticated','public.motorist_audit_partner_settlement()','EXECUTE') then raise exception 'FAIL browser trigger grant'; end if;
end $$;
reset role;
rollback;
