do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.motorist_fleet_assets'::regclass
      and conname = 'motorist_fleet_assets_id_organization_unique'
  ) then
    alter table public.motorist_fleet_assets
      add constraint motorist_fleet_assets_id_organization_unique unique (id, organization_id);
  end if;
end $$;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.motorist_organization_integrations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%provider%'
  loop
    execute format('alter table public.motorist_organization_integrations drop constraint %I', constraint_name);
  end loop;

  alter table public.motorist_organization_integrations
    add constraint organization_integrations_provider_check
    check (provider in ('telnyx', 'telnyx_sms', 'google_maps', 'fleet', 'ai', 'commander', 'client_vehicle_db'));
end $$;

create table public.motorist_external_vehicle_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  source_provider text not null check (source_provider in ('commander', 'client_vehicle_db')),
  source_vehicle_id text not null,
  normalized_license_plate text,
  normalized_vin text,
  label text,
  make text,
  model text,
  kind_hint text check (kind_hint is null or kind_hint in ('tow_truck', 'replacement_car')),
  source_active boolean not null default true,
  source_deleted_at timestamptz,
  latest_payload_snapshot jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source_provider, source_vehicle_id),
  unique (id, organization_id)
);

create table public.motorist_fleet_asset_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  fleet_asset_id uuid not null,
  external_vehicle_record_id uuid not null,
  source_provider text not null check (source_provider in ('commander', 'client_vehicle_db')),
  link_status text not null check (link_status in ('candidate', 'confirmed', 'rejected')),
  match_method text not null check (match_method in ('vin', 'license_plate', 'manual', 'existing_external_id')),
  match_confidence numeric(4, 3) not null check (match_confidence >= 0 and match_confidence <= 1),
  confirmed_at timestamptz,
  confirmed_by uuid references public.motorist_profiles(id) on delete set null,
  rejected_at timestamptz,
  rejected_by uuid references public.motorist_profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (fleet_asset_id, organization_id)
    references public.motorist_fleet_assets(id, organization_id)
    on delete cascade,
  foreign key (external_vehicle_record_id, organization_id)
    references public.motorist_external_vehicle_records(id, organization_id)
    on delete cascade,
  check (
    (link_status = 'confirmed' and confirmed_at is not null and rejected_at is null)
    or (link_status = 'rejected' and rejected_at is not null)
    or (link_status = 'candidate' and confirmed_at is null and rejected_at is null)
  )
);

create table public.motorist_fleet_current_positions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  external_vehicle_record_id uuid not null,
  fleet_asset_id uuid references public.motorist_fleet_assets(id) on delete set null,
  source_provider text not null check (source_provider in ('commander', 'client_vehicle_db')),
  source_vehicle_id text not null,
  gps_time timestamptz not null,
  lat numeric(10, 7) not null check (lat >= -90 and lat <= 90),
  lng numeric(10, 7) not null check (lng >= -180 and lng <= 180),
  speed_kmh numeric(8, 2) check (speed_kmh is null or speed_kmh >= 0),
  heading_degrees numeric(6, 2) check (heading_degrees is null or (heading_degrees >= 0 and heading_degrees < 360)),
  ignition_on boolean,
  odometer_m numeric(14, 2) check (odometer_m is null or odometer_m >= 0),
  payload_hash text,
  latest_payload_snapshot jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_vehicle_record_id),
  foreign key (external_vehicle_record_id, organization_id)
    references public.motorist_external_vehicle_records(id, organization_id)
    on delete cascade
);

create table public.motorist_fleet_position_samples (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  external_vehicle_record_id uuid not null,
  fleet_asset_id uuid references public.motorist_fleet_assets(id) on delete set null,
  source_provider text not null check (source_provider in ('commander', 'client_vehicle_db')),
  source_vehicle_id text not null,
  sampled_at timestamptz not null,
  lat numeric(10, 7) not null check (lat >= -90 and lat <= 90),
  lng numeric(10, 7) not null check (lng >= -180 and lng <= 180),
  speed_kmh numeric(8, 2) check (speed_kmh is null or speed_kmh >= 0),
  heading_degrees numeric(6, 2) check (heading_degrees is null or (heading_degrees >= 0 and heading_degrees < 360)),
  ignition_on boolean,
  odometer_m numeric(14, 2) check (odometer_m is null or odometer_m >= 0),
  payload_hash text,
  latest_payload_snapshot jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, source_provider, source_vehicle_id, sampled_at),
  foreign key (external_vehicle_record_id, organization_id)
    references public.motorist_external_vehicle_records(id, organization_id)
    on delete cascade
);

create table public.motorist_fleet_trips (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  external_vehicle_record_id uuid not null,
  fleet_asset_id uuid references public.motorist_fleet_assets(id) on delete set null,
  source_provider text not null check (source_provider in ('commander', 'client_vehicle_db')),
  source_vehicle_id text not null,
  source_trip_id text not null,
  status text not null default 'imported' check (status in ('imported', 'details_unavailable', 'details_available')),
  started_at timestamptz not null,
  ended_at timestamptz,
  start_lat numeric(10, 7) check (start_lat is null or (start_lat >= -90 and start_lat <= 90)),
  start_lng numeric(10, 7) check (start_lng is null or (start_lng >= -180 and start_lng <= 180)),
  stop_lat numeric(10, 7) check (stop_lat is null or (stop_lat >= -90 and stop_lat <= 90)),
  stop_lng numeric(10, 7) check (stop_lng is null or (stop_lng >= -180 and stop_lng <= 180)),
  start_address text,
  stop_address text,
  duration_s integer check (duration_s is null or duration_s >= 0),
  distance_m numeric(14, 2) check (distance_m is null or distance_m >= 0),
  odometer_start_m numeric(14, 2) check (odometer_start_m is null or odometer_start_m >= 0),
  odometer_end_m numeric(14, 2) check (odometer_end_m is null or odometer_end_m >= 0),
  driver_id text,
  driver_name text,
  latest_payload_snapshot jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source_provider, source_trip_id),
  foreign key (external_vehicle_record_id, organization_id)
    references public.motorist_external_vehicle_records(id, organization_id)
    on delete cascade
);

create table public.motorist_fleet_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null check (provider in ('commander', 'client_vehicle_db')),
  mode text not null check (mode in ('vehicles', 'positions', 'rides', 'full')),
  status text not null check (status in ('running', 'success', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched_count integer not null default 0 check (fetched_count >= 0),
  created_count integer not null default 0 check (created_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  linked_count integer not null default 0 check (linked_count >= 0),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  rate_limit_limit integer,
  rate_limit_remaining integer,
  rate_limit_reset timestamptz,
  retry_after_seconds integer,
  endpoint_errors jsonb not null default '[]'::jsonb,
  error_summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index external_vehicle_records_plate_idx
  on public.motorist_external_vehicle_records (organization_id, normalized_license_plate)
  where normalized_license_plate is not null;

create index external_vehicle_records_vin_idx
  on public.motorist_external_vehicle_records (organization_id, normalized_vin)
  where normalized_vin is not null;

create index external_vehicle_records_provider_active_idx
  on public.motorist_external_vehicle_records (organization_id, source_provider, source_active);

create unique index fleet_asset_links_active_pair_idx
  on public.motorist_fleet_asset_links (organization_id, external_vehicle_record_id, fleet_asset_id, source_provider)
  where link_status <> 'rejected';

create unique index fleet_asset_links_confirmed_external_idx
  on public.motorist_fleet_asset_links (organization_id, external_vehicle_record_id)
  where link_status = 'confirmed';

create unique index fleet_asset_links_confirmed_asset_provider_idx
  on public.motorist_fleet_asset_links (organization_id, fleet_asset_id, source_provider)
  where link_status = 'confirmed';

create index fleet_current_positions_asset_idx
  on public.motorist_fleet_current_positions (organization_id, fleet_asset_id)
  where fleet_asset_id is not null;

create index fleet_position_samples_asset_time_idx
  on public.motorist_fleet_position_samples (organization_id, fleet_asset_id, sampled_at desc)
  where fleet_asset_id is not null;

create index fleet_trips_asset_time_idx
  on public.motorist_fleet_trips (organization_id, fleet_asset_id, started_at desc)
  where fleet_asset_id is not null;

create index fleet_sync_runs_provider_time_idx
  on public.motorist_fleet_sync_runs (organization_id, provider, started_at desc);

create or replace function public.motorist_assert_external_vehicle_source()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  actual_provider text;
  actual_fleet_org uuid;
begin
  select source_provider
    into actual_provider
  from public.motorist_external_vehicle_records
  where id = new.external_vehicle_record_id
    and organization_id = new.organization_id;

  if actual_provider is null then
    raise exception 'External vehicle record % for organization % was not found.', new.external_vehicle_record_id, new.organization_id;
  end if;

  if actual_provider <> new.source_provider then
    raise exception 'External vehicle source_provider mismatch: expected %, got %.', actual_provider, new.source_provider;
  end if;

  if new.fleet_asset_id is not null then
    select organization_id
      into actual_fleet_org
    from public.motorist_fleet_assets
    where id = new.fleet_asset_id;

    if actual_fleet_org is null then
      raise exception 'Fleet asset % was not found.', new.fleet_asset_id;
    end if;

    if actual_fleet_org <> new.organization_id then
      raise exception 'Fleet asset % belongs to organization %, not %.', new.fleet_asset_id, actual_fleet_org, new.organization_id;
    end if;
  end if;

  return new;
end;
$$;

alter table public.motorist_external_vehicle_records enable row level security;
alter table public.motorist_fleet_asset_links enable row level security;
alter table public.motorist_fleet_current_positions enable row level security;
alter table public.motorist_fleet_position_samples enable row level security;
alter table public.motorist_fleet_trips enable row level security;
alter table public.motorist_fleet_sync_runs enable row level security;

create policy external_vehicle_records_org_read
  on public.motorist_external_vehicle_records
  for select
  using (app_private.motorist_is_org_member(organization_id));

create policy fleet_asset_links_org_read
  on public.motorist_fleet_asset_links
  for select
  using (app_private.motorist_is_org_member(organization_id));

do $$
declare
  role_helper text;
begin
  if to_regprocedure('app_private.motorist_has_org_role(uuid, text[])') is not null then
    role_helper := 'app_private.motorist_has_org_role';
  elsif to_regprocedure('public.motorist_has_org_role(uuid, text[])') is not null then
    role_helper := 'public.motorist_has_org_role';
  else
    raise exception 'Required organization role helper motorist_has_org_role(uuid, text[]) was not found.';
  end if;

  execute format(
    'create policy fleet_asset_links_manager_update
       on public.motorist_fleet_asset_links
       for update
       using (%1$s(organization_id, array[''manager'', ''admin'']))
       with check (%1$s(organization_id, array[''manager'', ''admin'']))',
    role_helper
  );
end $$;

create policy fleet_current_positions_org_read
  on public.motorist_fleet_current_positions
  for select
  using (app_private.motorist_is_org_member(organization_id));

create policy fleet_position_samples_org_read
  on public.motorist_fleet_position_samples
  for select
  using (app_private.motorist_is_org_member(organization_id));

create policy fleet_trips_org_read
  on public.motorist_fleet_trips
  for select
  using (app_private.motorist_is_org_member(organization_id));

create policy fleet_sync_runs_org_read
  on public.motorist_fleet_sync_runs
  for select
  using (app_private.motorist_is_org_member(organization_id));

create trigger external_vehicle_records_updated_at before update on public.motorist_external_vehicle_records
  for each row execute function public.motorist_set_updated_at();

create trigger fleet_asset_links_updated_at before update on public.motorist_fleet_asset_links
  for each row execute function public.motorist_set_updated_at();

create trigger fleet_current_positions_updated_at before update on public.motorist_fleet_current_positions
  for each row execute function public.motorist_set_updated_at();

create trigger fleet_trips_updated_at before update on public.motorist_fleet_trips
  for each row execute function public.motorist_set_updated_at();

create trigger fleet_sync_runs_updated_at before update on public.motorist_fleet_sync_runs
  for each row execute function public.motorist_set_updated_at();

create trigger fleet_asset_links_source_check before insert or update on public.motorist_fleet_asset_links
  for each row execute function public.motorist_assert_external_vehicle_source();

create trigger fleet_current_positions_source_check before insert or update on public.motorist_fleet_current_positions
  for each row execute function public.motorist_assert_external_vehicle_source();

create trigger fleet_position_samples_source_check before insert or update on public.motorist_fleet_position_samples
  for each row execute function public.motorist_assert_external_vehicle_source();

create trigger fleet_trips_source_check before insert or update on public.motorist_fleet_trips
  for each row execute function public.motorist_assert_external_vehicle_source();

insert into public.motorist_organization_integrations (
  organization_id,
  provider,
  enabled,
  config,
  secret_ref,
  status,
  enabled_features,
  base_url
)
select
  id,
  'commander',
  false,
  '{}'::jsonb,
  'COMMANDER_API_USERNAME,COMMANDER_API_PASSWORD',
  'not_configured',
  array['vehicles', 'last_positions', 'all_rides']::text[],
  'https://online.commander-systems.com/api/v1'
from public.motorist_organizations
on conflict (organization_id, provider) do nothing;
