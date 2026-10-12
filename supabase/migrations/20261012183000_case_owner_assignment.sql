-- PREPARED ONLY: apply to dedicated TEST only after exact owner authorization.
-- Add dispatcher assignment without altering the V1 case editor/receipt contract.
begin;

do $$ begin
  if to_regprocedure('public.motorist_save_case_atomic(uuid,uuid,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,text)') is null
    or not exists(select 1 from pg_trigger where tgrelid='public.motorist_cases'::regclass
      and tgname='zz_motorist_case_revision' and not tgisinternal and tgenabled in ('O','A')
      and tgfoid='public.motorist_case_monotonic_revision()'::regprocedure)
    then raise exception 'Atomic case receipt and monotonic revision prerequisites required'; end if;
end $$;

create function public.motorist_case_owner_version()
returns integer language sql immutable security definer set search_path = ''
as $$ select 1 $$;
revoke all on function public.motorist_case_owner_version() from public, anon, authenticated;
grant execute on function public.motorist_case_owner_version() to service_role;

create function public.motorist_assign_case_owner(
  p_organization_id uuid, p_actor_id uuid, p_actor_user_id uuid, p_case_id uuid,
  p_owner_id uuid, p_expected_updated_at timestamptz,
  p_mutation_id uuid, p_fingerprint text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_case public.motorist_cases;
  receipt public.motorist_case_mutation_results;
  target_name text;
  saved_revision timestamptz;
  result jsonb;
begin
  -- Actor authorization always precedes receipts; revoked accounts cannot replay.
  perform p.id from public.motorist_profiles p
    join public.motorist_organizations o on o.id=p.organization_id
    where p.id=p_actor_id and p.user_id=p_actor_user_id and p.organization_id=p_organization_id
      and p.active and p.access_status='active' and p.kind='human' and o.active
      and p.role in ('dispatcher','senior_dispatcher','manager','admin')
    for share of p,o;
  if not found then raise exception 'Case owner access denied' using errcode='42501'; end if;
  if p_case_id is null or p_owner_id is null or p_expected_updated_at is null
    or p_mutation_id is null or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
    then raise exception 'Owner command identity required' using errcode='22023'; end if;

  -- Same namespace/lock as existing immutable editor receipts; cross-command UUID
  -- reuse is a mismatch, never a second operation. The server fingerprints a
  -- versioned owner-command envelope distinct from the V1 edit input.
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_actor_id::text || ':' || p_mutation_id::text, 0));
  select * into receipt from public.motorist_case_mutation_results
    where organization_id=p_organization_id and actor_id=p_actor_id and mutation_id=p_mutation_id;
  if found then
    if receipt.case_id is distinct from p_case_id or receipt.fingerprint is distinct from p_fingerprint
      then raise exception 'Mutation identity reused with different payload' using errcode='PT422'; end if;
    return receipt.result;
  end if;

  select * into current_case from public.motorist_cases
    where id=p_case_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Case not found' using errcode='P0002'; end if;
  if current_case.updated_at is distinct from p_expected_updated_at
    then raise exception 'Case revision conflict' using errcode='PT409'; end if;
  if current_case.owner_id is null and current_case.status in ('completed_assisted','completed_no_assistance','rejected','cancelled','futile_trip')
    then raise exception 'Closed unassigned case cannot be claimed' using errcode='22023'; end if;

  select p.display_name into target_name from public.motorist_profiles p
    where p.id=p_owner_id and p.organization_id=p_organization_id and p.user_id is not null and p.active
      and p.access_status='active' and p.kind='human'
      and p.role in ('dispatcher','senior_dispatcher','manager','admin') for share;
  if not found then raise exception 'Eligible owner required' using errcode='22023'; end if;

  saved_revision := current_case.updated_at;
  if current_case.owner_id is distinct from p_owner_id then
    -- Existing monotonic revision and collaboration triggers remain authoritative.
    update public.motorist_cases set owner_id=p_owner_id
      where id=p_case_id and organization_id=p_organization_id
      returning updated_at into saved_revision;
    insert into public.motorist_case_events(organization_id,case_id,actor_profile_id,event_type,title,body)
      values(p_organization_id,p_case_id,p_actor_id,'case_updated','Dispečer prípadu zmenený','Priradený dispečer: ' || target_name || '.');
    insert into public.motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,before_payload,after_payload)
      values(p_organization_id,p_actor_id,'case.owner.assign','motorist_cases',p_case_id,'mobile',
        jsonb_build_object('owner_id',current_case.owner_id),jsonb_build_object('owner_id',p_owner_id,'mutation_id',p_mutation_id));
  end if;
  result := jsonb_build_object('caseId',p_case_id,'mutationId',p_mutation_id,
    'organizationId',p_organization_id,'actorId',p_actor_id,'ownerId',p_owner_id,'committedRevision',saved_revision);
  insert into public.motorist_case_mutation_results(organization_id,actor_id,mutation_id,case_id,fingerprint,result)
    values(p_organization_id,p_actor_id,p_mutation_id,p_case_id,p_fingerprint,result);
  return result;
end;
$$;
revoke all on function public.motorist_assign_case_owner(uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,text) from public,anon,authenticated;
grant execute on function public.motorist_assign_case_owner(uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,text) to service_role;
commit;
