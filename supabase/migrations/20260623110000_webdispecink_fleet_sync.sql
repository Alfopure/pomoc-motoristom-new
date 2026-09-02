alter table public.motorist_fleet_assets
  add column if not exists source_system text,
  add column if not exists external_id text,
  add column if not exists location_source text;

create unique index if not exists fleet_assets_source_external_uidx
  on public.motorist_fleet_assets (organization_id, source_system, external_id)
  where source_system is not null and external_id is not null;

create index if not exists fleet_assets_location_source_idx
  on public.motorist_fleet_assets (organization_id, location_source, last_seen_at desc)
  where location_source is not null;

create table if not exists public.motorist_fleet_provider_vehicles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'webdispecink',
  external_id text not null,
  label text,
  license_plate text,
  driver_name text,
  unit_name text,
  object_number text,
  vehicle_type text,
  online boolean,
  disabled boolean,
  linked_asset_id uuid references public.motorist_fleet_assets(id) on delete set null,
  latest_location_id uuid references public.motorist_locations(id) on delete set null,
  latest_position_at timestamptz,
  latest_local_position_at timestamptz,
  speed_kph numeric(10, 2),
  odometer_km numeric(12, 2),
  raw_catalog jsonb not null default '{}'::jsonb,
  raw_position jsonb not null default '{}'::jsonb,
  last_catalog_sync_at timestamptz,
  last_position_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, external_id)
);

create index if not exists fleet_provider_vehicles_provider_idx
  on public.motorist_fleet_provider_vehicles (organization_id, provider, updated_at desc);

create index if not exists fleet_provider_vehicles_linked_asset_idx
  on public.motorist_fleet_provider_vehicles (organization_id, linked_asset_id)
  where linked_asset_id is not null;

create index if not exists fleet_provider_vehicles_license_idx
  on public.motorist_fleet_provider_vehicles (organization_id, provider, license_plate)
  where license_plate is not null;

drop trigger if exists fleet_provider_vehicles_updated_at on public.motorist_fleet_provider_vehicles;
create trigger fleet_provider_vehicles_updated_at before update on public.motorist_fleet_provider_vehicles
  for each row execute function public.motorist_set_updated_at();

alter table public.motorist_fleet_provider_vehicles enable row level security;

drop policy if exists fleet_provider_vehicles_organization_access on public.motorist_fleet_provider_vehicles;
create policy fleet_provider_vehicles_organization_access
  on public.motorist_fleet_provider_vehicles
  for all
  using (app_private.motorist_is_org_member(organization_id))
  with check (app_private.motorist_is_org_member(organization_id));

insert into public.motorist_organization_integrations (
  organization_id,
  provider,
  enabled,
  status,
  enabled_features,
  base_url,
  secret_ref,
  config
)
select
  organizations.id,
  'fleet',
  false,
  'not_configured',
  array['webdispecink_catalog', 'webdispecink_positions']::text[],
  'https://api.webdispecink.cz/code/WebDispecinkServiceNet.php',
  'env:WEBDISPECINK_COMPANY_CODE,WEBDISPECINK_USERNAME,WEBDISPECINK_PASSWORD',
  '{"source":"webdispecink","refreshSeconds":60,"catalogRefreshHours":12,"staleAfterMinutes":10,"monthlyFreeLimit":60000}'::jsonb
from public.motorist_organizations organizations
where organizations.slug = 'pomoc-motoristom'
on conflict (organization_id, provider) do update
set
  enabled_features = excluded.enabled_features,
  base_url = excluded.base_url,
  secret_ref = coalesce(public.motorist_organization_integrations.secret_ref, excluded.secret_ref),
  config = public.motorist_organization_integrations.config || excluded.config,
  status = case
    when public.motorist_organization_integrations.enabled then public.motorist_organization_integrations.status
    else 'not_configured'
  end;
