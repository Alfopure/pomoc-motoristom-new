-- Additive contract: legacy callers retain the seven-argument atomic save.
-- Results are private, immutable receipts; removing them would permit key reuse.
create table public.motorist_case_mutation_results (
  organization_id uuid not null,
  actor_id uuid not null,
  mutation_id uuid not null,
  case_id uuid not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, actor_id, mutation_id)
);
alter table public.motorist_case_mutation_results enable row level security;
revoke all on public.motorist_case_mutation_results from public, anon, authenticated;

create function public.motorist_case_mutation_result(
  p_organization_id uuid, p_actor_id uuid, p_case_id uuid, p_mutation_id uuid, p_fingerprint text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare receipt public.motorist_case_mutation_results;
begin
  if not exists (select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id
    where p.id=p_actor_id and p.organization_id=p_organization_id and p.active and o.active and p.role in ('dispatcher','senior_dispatcher','manager','admin')) then
    raise exception 'Case editor membership required' using errcode='42501';
  end if;
  if p_mutation_id is null or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'Mutation identity required' using errcode='22023';
  end if;
  select * into receipt from public.motorist_case_mutation_results
    where organization_id=p_organization_id and actor_id=p_actor_id and mutation_id=p_mutation_id;
  if not found then return null; end if;
  if receipt.case_id is distinct from p_case_id or receipt.fingerprint is distinct from p_fingerprint then
    raise exception 'Mutation identity reused with different payload' using errcode='PT422';
  end if;
  return receipt.result;
end;
$$;

create function public.motorist_save_case_atomic(
  p_organization_id uuid, p_actor_id uuid, p_case_id uuid, p_expected_updated_at timestamptz,
  p_case_patch jsonb, p_related jsonb, p_field_labels jsonb, p_mutation_id uuid, p_fingerprint text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare saved jsonb;
begin
  -- Identical concurrent requests serialize before testing the case revision.
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_actor_id::text || ':' || p_mutation_id::text, 0));
  saved := public.motorist_case_mutation_result(p_organization_id,p_actor_id,p_case_id,p_mutation_id,p_fingerprint);
  if saved is not null then return saved; end if;
  saved := public.motorist_save_case_atomic(p_organization_id,p_actor_id,p_case_id,p_expected_updated_at,p_case_patch,p_related,p_field_labels);
  insert into public.motorist_case_mutation_results(organization_id,actor_id,mutation_id,case_id,fingerprint,result)
    values(p_organization_id,p_actor_id,p_mutation_id,p_case_id,p_fingerprint,saved);
  return saved;
end;
$$;
revoke all on function public.motorist_case_mutation_result(uuid,uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.motorist_case_mutation_result(uuid,uuid,uuid,uuid,text) to service_role;
revoke all on function public.motorist_save_case_atomic(uuid,uuid,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,text) from public, anon, authenticated;
grant execute on function public.motorist_save_case_atomic(uuid,uuid,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,text) to service_role;
