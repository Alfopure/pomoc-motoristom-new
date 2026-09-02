create table if not exists public.motorist_location_share_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  case_id uuid not null references public.motorist_cases(id) on delete cascade,
  scope text not null default 'pickup_location' check (scope in ('pickup_location')),
  token_hash text not null,
  status text not null default 'active' check (status in ('active', 'used', 'expired', 'revoked')),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.motorist_profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists location_share_links_token_hash_idx
  on public.motorist_location_share_links (token_hash);

create index if not exists location_share_links_case_scope_idx
  on public.motorist_location_share_links (organization_id, case_id, scope, status, expires_at desc);

create index if not exists location_share_links_expiry_idx
  on public.motorist_location_share_links (status, expires_at)
  where status = 'active';

create table if not exists public.motorist_location_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  case_id uuid not null references public.motorist_cases(id) on delete cascade,
  link_id uuid not null references public.motorist_location_share_links(id) on delete cascade,
  location_id uuid references public.motorist_locations(id) on delete set null,
  lat numeric(10, 7) not null,
  lng numeric(10, 7) not null,
  accuracy_meters numeric(10, 2),
  source text not null default 'browser_geolocation' check (source in ('browser_geolocation')),
  user_agent_hash text,
  ip_hash text,
  submitted_at timestamptz not null default now(),
  accepted boolean not null default true,
  raw_payload_safe jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists location_submissions_case_idx
  on public.motorist_location_submissions (organization_id, case_id, submitted_at desc);

create index if not exists location_submissions_link_idx
  on public.motorist_location_submissions (link_id, submitted_at desc);

alter table public.motorist_location_share_links enable row level security;
alter table public.motorist_location_submissions enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'motorist_location_share_links'
      and policyname = 'location_share_links_organization_access'
  ) then
    create policy location_share_links_organization_access
      on public.motorist_location_share_links
      for all
      using (app_private.motorist_is_org_member(organization_id))
      with check (app_private.motorist_is_org_member(organization_id));
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'motorist_location_submissions'
      and policyname = 'location_submissions_organization_access'
  ) then
    create policy location_submissions_organization_access
      on public.motorist_location_submissions
      for all
      using (app_private.motorist_is_org_member(organization_id))
      with check (app_private.motorist_is_org_member(organization_id));
  end if;
end $$;

drop trigger if exists location_share_links_updated_at on public.motorist_location_share_links;
create trigger location_share_links_updated_at before update on public.motorist_location_share_links
  for each row execute function public.motorist_set_updated_at();
