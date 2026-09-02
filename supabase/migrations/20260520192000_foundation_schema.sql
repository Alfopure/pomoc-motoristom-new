create extension if not exists pgcrypto;

create or replace function public.motorist_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

create table public.motorist_organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.motorist_organization_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.motorist_organizations(id) on delete cascade,
  brand_name text not null,
  default_locale text not null default 'sk-SK',
  timezone text not null default 'Europe/Bratislava',
  primary_phone text,
  enabled_modules text[] not null default array['calls', 'cases', 'maps', 'reports'],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.motorist_organization_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null check (provider in ('viptel', 'viptel_sms', 'google_maps', 'fleet', 'ai')),
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  secret_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

create table public.motorist_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  user_id uuid,
  display_name text not null,
  role text not null check (role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')),
  phone_extension text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id),
  unique (organization_id, phone_extension)
);

create table public.motorist_operator_statuses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null references public.motorist_profiles(id) on delete cascade,
  status text not null check (status in ('available', 'ringing', 'on_call', 'after_call_work', 'working_case', 'paused', 'offline')),
  reason text,
  source text not null default 'manual',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.motorist_telephony_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'viptel',
  external_id text,
  phone_number text not null,
  label text not null,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, phone_number)
);

create table public.motorist_telephony_queues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'viptel',
  external_id text not null,
  label text not null,
  line_id uuid references public.motorist_telephony_lines(id) on delete set null,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, external_id)
);

create table public.motorist_telephony_extensions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'viptel',
  external_id text,
  extension text not null,
  profile_id uuid references public.motorist_profiles(id) on delete set null,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, extension)
);

create table public.motorist_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  name text not null,
  phone text,
  email text,
  role text not null check (role in ('client', 'assistance', 'branch', 'partner')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.motorist_vehicles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  license_plate text,
  vin text,
  make text,
  model text,
  category text,
  transmission text,
  weight_kg integer,
  is_driveable boolean,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.motorist_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  label text not null,
  address text not null,
  lat numeric(10, 7) not null,
  lng numeric(10, 7) not null,
  place_id text,
  provider text,
  confidence numeric(4, 3),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.motorist_branches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  name text not null,
  address text not null,
  phone text,
  location_id uuid references public.motorist_locations(id) on delete set null,
  available_replacement_cars integer not null default 0,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.motorist_fleet_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  kind text not null check (kind in ('tow_truck', 'replacement_car')),
  label text not null,
  license_plate text,
  status text not null check (status in ('available', 'assigned', 'busy', 'offline')),
  branch_id uuid references public.motorist_branches(id) on delete set null,
  current_location_id uuid references public.motorist_locations(id) on delete set null,
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.motorist_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  case_number text not null,
  status text not null check (status in ('new', 'triage', 'open', 'waiting_for_client', 'scheduled', 'assigned', 'dispatched', 'in_progress', 'waiting_for_docs', 'completed_assisted', 'completed_no_assistance', 'rejected', 'cancelled', 'futile_trip')),
  priority text not null check (priority in ('urgent', 'high', 'normal', 'low')),
  source_type text not null check (source_type in ('client', 'assistance', 'samoplatca', 'partner', 'internal')),
  case_type text not null,
  partner_id uuid references public.motorist_contacts(id) on delete set null,
  owner_id uuid references public.motorist_profiles(id) on delete set null,
  contact_id uuid references public.motorist_contacts(id) on delete set null,
  vehicle_id uuid references public.motorist_vehicles(id) on delete set null,
  pickup_location_id uuid references public.motorist_locations(id) on delete set null,
  destination_location_id uuid references public.motorist_locations(id) on delete set null,
  assistance_reference text,
  external_reference text,
  summary text,
  main_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text,
  unique (organization_id, case_number)
);

create table public.motorist_case_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  case_id uuid not null references public.motorist_cases(id) on delete cascade,
  title text not null,
  assigned_to uuid references public.motorist_profiles(id) on delete set null,
  due_at timestamptz,
  status text not null check (status in ('open', 'done', 'overdue')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.motorist_case_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  case_id uuid not null references public.motorist_cases(id) on delete cascade,
  actor_profile_id uuid references public.motorist_profiles(id) on delete set null,
  event_type text not null,
  title text not null,
  body text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.motorist_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'viptel',
  viptel_unique_id text,
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  status text not null check (status in ('incoming', 'ringing_agent', 'answered', 'missed', 'abandoned_queue', 'outbound', 'ended', 'failed')),
  caller_number text,
  caller_name text,
  called_number text,
  line_id uuid references public.motorist_telephony_lines(id) on delete set null,
  queue_id uuid references public.motorist_telephony_queues(id) on delete set null,
  extension_id uuid references public.motorist_telephony_extensions(id) on delete set null,
  operator_id uuid references public.motorist_profiles(id) on delete set null,
  case_id uuid references public.motorist_cases(id) on delete set null,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  wait_seconds integer,
  duration_seconds integer,
  recording_status text not null default 'not_requested' check (recording_status in ('not_requested', 'pending', 'available', 'failed', 'deleted')),
  transcript_status text not null default 'not_requested' check (transcript_status in ('not_requested', 'pending', 'complete', 'failed')),
  summary text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index calls_org_provider_unique_id_idx
  on public.motorist_calls (organization_id, provider, viptel_unique_id)
  where viptel_unique_id is not null;

create table public.motorist_call_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  call_id uuid references public.motorist_calls(id) on delete cascade,
  provider text not null default 'viptel',
  viptel_unique_id text,
  event_type text not null,
  event_fingerprint text not null,
  payload jsonb not null default '{}'::jsonb,
  provider_created_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, provider, event_fingerprint)
);

create table public.motorist_call_recordings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  call_id uuid references public.motorist_calls(id) on delete cascade,
  provider text not null default 'viptel',
  viptel_unique_id text,
  provider_recording_id text,
  storage_bucket text,
  storage_path text,
  status text not null check (status in ('pending', 'available', 'failed', 'deleted')),
  duration_seconds integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index call_recordings_provider_id_idx
  on public.motorist_call_recordings (organization_id, provider, provider_recording_id)
  where provider_recording_id is not null;

create table public.motorist_sms_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'viptel_sms',
  provider_message_id text,
  case_id uuid references public.motorist_cases(id) on delete set null,
  call_id uuid references public.motorist_calls(id) on delete set null,
  to_number text not null,
  from_label text,
  direction text not null check (direction in ('outbound', 'inbound')),
  status text not null check (status in ('queued', 'sent', 'delivered', 'failed', 'received')),
  template_key text,
  body text not null,
  error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.motorist_route_estimates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'google_routes',
  origin_location_id uuid references public.motorist_locations(id) on delete set null,
  destination_location_id uuid references public.motorist_locations(id) on delete set null,
  distance_meters integer,
  duration_seconds integer,
  polyline text,
  stale_after timestamptz,
  provider_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.motorist_audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  actor_profile_id uuid references public.motorist_profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  source text not null default 'app',
  ip_address inet,
  user_agent text,
  before_payload jsonb,
  after_payload jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.motorist_is_org_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.motorist_profiles
    where motorist_profiles.organization_id = target_organization_id
      and motorist_profiles.user_id = auth.uid()
      and motorist_profiles.active = true
  );
$$;

create or replace function public.motorist_has_org_role(target_organization_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.motorist_profiles
    where motorist_profiles.organization_id = target_organization_id
      and motorist_profiles.user_id = auth.uid()
      and motorist_profiles.active = true
      and motorist_profiles.role = any(allowed_roles)
  );
$$;

alter table public.motorist_organizations enable row level security;

create policy organizations_read_member
  on public.motorist_organizations
  for select
  using (public.motorist_is_org_member(id));

create policy organizations_admin_update
  on public.motorist_organizations
  for update
  using (public.motorist_has_org_role(id, array['admin']))
  with check (public.motorist_has_org_role(id, array['admin']));

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'motorist_organization_profiles',
    'motorist_profiles',
    'motorist_operator_statuses',
    'motorist_telephony_lines',
    'motorist_telephony_queues',
    'motorist_telephony_extensions',
    'motorist_contacts',
    'motorist_vehicles',
    'motorist_locations',
    'motorist_branches',
    'motorist_fleet_assets',
    'motorist_cases',
    'motorist_case_tasks',
    'motorist_case_events',
    'motorist_calls',
    'motorist_call_events',
    'motorist_sms_messages',
    'motorist_route_estimates'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I on public.%I for all using (public.motorist_is_org_member(organization_id)) with check (public.motorist_is_org_member(organization_id))',
      table_name || '_organization_access',
      table_name
    );
  end loop;
end $$;

alter table public.motorist_organization_integrations enable row level security;
create policy organization_integrations_admin_access
  on public.motorist_organization_integrations
  for all
  using (public.motorist_has_org_role(organization_id, array['admin']))
  with check (public.motorist_has_org_role(organization_id, array['admin']));

alter table public.motorist_call_recordings enable row level security;
create policy call_recordings_restricted_access
  on public.motorist_call_recordings
  for all
  using (public.motorist_has_org_role(organization_id, array['senior_dispatcher', 'manager', 'admin']))
  with check (public.motorist_has_org_role(organization_id, array['senior_dispatcher', 'manager', 'admin']));

alter table public.motorist_audit_log enable row level security;
create policy audit_log_admin_read
  on public.motorist_audit_log
  for select
  using (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

create trigger organizations_updated_at before update on public.motorist_organizations
  for each row execute function public.motorist_set_updated_at();
create trigger organization_profiles_updated_at before update on public.motorist_organization_profiles
  for each row execute function public.motorist_set_updated_at();
create trigger organization_integrations_updated_at before update on public.motorist_organization_integrations
  for each row execute function public.motorist_set_updated_at();
create trigger profiles_updated_at before update on public.motorist_profiles
  for each row execute function public.motorist_set_updated_at();
create trigger telephony_lines_updated_at before update on public.motorist_telephony_lines
  for each row execute function public.motorist_set_updated_at();
create trigger telephony_queues_updated_at before update on public.motorist_telephony_queues
  for each row execute function public.motorist_set_updated_at();
create trigger telephony_extensions_updated_at before update on public.motorist_telephony_extensions
  for each row execute function public.motorist_set_updated_at();
create trigger contacts_updated_at before update on public.motorist_contacts
  for each row execute function public.motorist_set_updated_at();
create trigger vehicles_updated_at before update on public.motorist_vehicles
  for each row execute function public.motorist_set_updated_at();
create trigger locations_updated_at before update on public.motorist_locations
  for each row execute function public.motorist_set_updated_at();
create trigger branches_updated_at before update on public.motorist_branches
  for each row execute function public.motorist_set_updated_at();
create trigger fleet_assets_updated_at before update on public.motorist_fleet_assets
  for each row execute function public.motorist_set_updated_at();
create trigger cases_updated_at before update on public.motorist_cases
  for each row execute function public.motorist_set_updated_at();
create trigger case_tasks_updated_at before update on public.motorist_case_tasks
  for each row execute function public.motorist_set_updated_at();
create trigger calls_updated_at before update on public.motorist_calls
  for each row execute function public.motorist_set_updated_at();
create trigger call_recordings_updated_at before update on public.motorist_call_recordings
  for each row execute function public.motorist_set_updated_at();
create trigger sms_messages_updated_at before update on public.motorist_sms_messages
  for each row execute function public.motorist_set_updated_at();

create index calls_active_idx on public.motorist_calls (organization_id, status, started_at desc);
create index call_events_call_idx on public.motorist_call_events (organization_id, call_id, created_at desc);
create index cases_active_idx on public.motorist_cases (organization_id, status, updated_at desc);
create index case_tasks_open_idx on public.motorist_case_tasks (organization_id, status, due_at);
create index locations_coordinates_idx on public.motorist_locations (organization_id, lat, lng);
create index audit_log_entity_idx on public.motorist_audit_log (organization_id, entity_type, entity_id, created_at desc);
