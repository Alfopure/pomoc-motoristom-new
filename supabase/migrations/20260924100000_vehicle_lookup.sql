-- Isolated, on-demand vehicle lookup. No cron, worker or telephony changes.
create table public.motorist_vehicle_lookup_controls (
  organization_id uuid primary key references public.motorist_organizations(id) on delete cascade,
  enabled boolean not null default true,
  skp_enabled boolean not null default true,
  stkonline_enabled boolean not null default true,
  haka_enabled boolean not null default true,
  vpic_enabled boolean not null default true,
  minute_window timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0),
  user_counts jsonb not null default '{}',
  lease_token uuid,
  lease_query_hash text,
  lease_until timestamptz,
  skp_failures integer not null default 0,
  skp_blocked_until timestamptz,
  updated_at timestamptz not null default now()
);
create table public.motorist_vehicle_lookup_cache (
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  query_hash text not null check (query_hash ~ '^[a-f0-9]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object' and octet_length(result::text) < 65536),
  valid_until timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, query_hash)
);
create index motorist_vehicle_lookup_cache_expiry on public.motorist_vehicle_lookup_cache (organization_id, valid_until);
alter table public.motorist_vehicle_lookup_controls enable row level security;
alter table public.motorist_vehicle_lookup_cache enable row level security;
-- No direct client access: results contain identifiers and are returned by the scoped API.
revoke all on public.motorist_vehicle_lookup_controls, public.motorist_vehicle_lookup_cache from anon, authenticated;
grant all on public.motorist_vehicle_lookup_controls, public.motorist_vehicle_lookup_cache to service_role;

create function public.motorist_vehicle_lookup_claim(p_organization_id uuid, p_profile_id uuid, p_query_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  control public.motorist_vehicle_lookup_controls%rowtype;
  cached jsonb;
  token uuid;
  user_count integer;
begin
  if p_query_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_query_hash'; end if;
  if not exists (select 1 from public.motorist_profiles p where p.id = p_profile_id and p.organization_id = p_organization_id and p.active and p.role in ('dispatcher','senior_dispatcher','manager','admin')) then
    raise exception 'lookup_profile_denied';
  end if;
  insert into public.motorist_vehicle_lookup_controls(organization_id) values(p_organization_id) on conflict do nothing;
  select * into control from public.motorist_vehicle_lookup_controls where organization_id = p_organization_id for update;
  if not control.enabled then return jsonb_build_object('status','disabled'); end if;
  select result into cached from public.motorist_vehicle_lookup_cache where organization_id = p_organization_id and query_hash = p_query_hash and valid_until > clock_timestamp();
  if cached is not null then return jsonb_build_object('status','cached','result',cached); end if;
  if control.lease_until > clock_timestamp() then return jsonb_build_object('status','pending'); end if;
  if control.minute_window <= clock_timestamp() - interval '1 minute' then
    control.request_count := 0; control.user_counts := '{}'; control.minute_window := clock_timestamp();
  end if;
  user_count := coalesce((control.user_counts ->> p_profile_id::text)::integer, 0);
  if control.request_count >= 30 or user_count >= 5 then return jsonb_build_object('status','rate_limited'); end if;
  token := gen_random_uuid();
  update public.motorist_vehicle_lookup_controls set
    minute_window = control.minute_window, request_count = control.request_count + 1,
    user_counts = jsonb_set(control.user_counts, array[p_profile_id::text], to_jsonb(user_count + 1)),
    lease_token = token, lease_query_hash = p_query_hash, lease_until = clock_timestamp() + interval '55 seconds', updated_at = clock_timestamp()
  where organization_id = p_organization_id;
  -- Bounded opportunistic cleanup; operational manual cleanup covers inactive orgs.
  delete from public.motorist_vehicle_lookup_cache where (organization_id,query_hash) in (
    select organization_id,query_hash from public.motorist_vehicle_lookup_cache where organization_id = p_organization_id and valid_until < clock_timestamp() - interval '1 day' limit 50
  );
  return jsonb_build_object('status','reserved','token',token,'providers',jsonb_build_object(
    'skp',control.skp_enabled and (control.skp_blocked_until is null or control.skp_blocked_until <= clock_timestamp()),
    'stkonline',control.stkonline_enabled,'haka',control.haka_enabled,'vpic',control.vpic_enabled));
end;
$$;

create function public.motorist_vehicle_lookup_finish(p_organization_id uuid, p_token uuid, p_query_hash text, p_result jsonb, p_success boolean, p_skp_failed boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare control public.motorist_vehicle_lookup_controls%rowtype; failures integer;
begin
  select * into control from public.motorist_vehicle_lookup_controls where organization_id = p_organization_id for update;
  if not found or control.lease_token is distinct from p_token or control.lease_query_hash is distinct from p_query_hash then return false; end if;
  if p_result is not null then
    insert into public.motorist_vehicle_lookup_cache(organization_id,query_hash,result,valid_until)
    values(p_organization_id,p_query_hash,p_result,clock_timestamp() + case when p_success then interval '15 minutes' else interval '1 minute' end)
    on conflict (organization_id,query_hash) do update set result=excluded.result,valid_until=excluded.valid_until,updated_at=clock_timestamp();
  end if;
  failures := case when p_skp_failed is null then control.skp_failures when p_skp_failed then control.skp_failures + 1 else 0 end;
  update public.motorist_vehicle_lookup_controls set lease_token=null,lease_query_hash=null,lease_until=null,skp_failures=failures,
    skp_blocked_until=case when p_skp_failed and failures >= 3 then clock_timestamp() + interval '15 minutes' when p_skp_failed = false then null else control.skp_blocked_until end,
    updated_at=clock_timestamp()
  where organization_id=p_organization_id;
  return true;
end;
$$;
revoke all on function public.motorist_vehicle_lookup_claim(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.motorist_vehicle_lookup_finish(uuid,uuid,text,jsonb,boolean,boolean) from public,anon,authenticated;
grant execute on function public.motorist_vehicle_lookup_claim(uuid,uuid,text) to service_role;
grant execute on function public.motorist_vehicle_lookup_finish(uuid,uuid,text,jsonb,boolean,boolean) to service_role;
