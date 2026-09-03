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
  provider text not null check (provider in ('telnyx', 'telnyx_sms', 'google_maps', 'fleet', 'ai')),
  enabled boolean not null default false,
  status text not null default 'not_configured' check (status in ('not_configured', 'configured', 'live', 'degraded', 'disabled')),
  enabled_features text[] not null default '{}'::text[],
  base_url text,
  config jsonb not null default '{}'::jsonb,
  secret_ref text,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
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
  provider text not null default 'telnyx',
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
  provider text not null default 'telnyx',
  external_id text not null,
  label text not null,
  line_id uuid references public.motorist_telephony_lines(id) on delete set null,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, external_id)
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
  provider text not null default 'telnyx',
  -- Provider-side session id that groups every leg of one call.
  provider_session_id text,
  -- Provider-side id of the leg this row was created from.
  provider_call_id text,
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  status text not null check (status in ('incoming', 'ringing_agent', 'answered', 'missed', 'abandoned_queue', 'outbound', 'ended', 'failed')),
  end_reason text,
  caller_number text,
  caller_name text,
  called_number text,
  received_number text,
  destination_number text,
  line_id uuid references public.motorist_telephony_lines(id) on delete set null,
  queue_id uuid references public.motorist_telephony_queues(id) on delete set null,
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
  -- Latest app-side state (outcome, callback minutes, notes) merged by the workflow layer.
  raw_latest_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index calls_org_provider_session_idx
  on public.motorist_calls (organization_id, provider, provider_session_id)
  where provider_session_id is not null;

create index calls_provider_call_id_idx
  on public.motorist_calls (organization_id, provider, provider_call_id)
  where provider_call_id is not null;

create table public.motorist_call_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  call_id uuid references public.motorist_calls(id) on delete cascade,
  provider text not null default 'telnyx',
  provider_session_id text,
  event_type text not null,
  event_fingerprint text not null,
  payload jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  normalized_payload jsonb not null default '{}'::jsonb,
  handled_status text not null default 'processed' check (handled_status in ('processed', 'ignored', 'failed', 'unknown')),
  provider_created_at timestamptz,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, provider, event_fingerprint)
);

create index call_events_session_idx
  on public.motorist_call_events (organization_id, provider, provider_session_id, received_at desc)
  where provider_session_id is not null;

create index call_events_type_idx
  on public.motorist_call_events (organization_id, provider, event_type, received_at desc);

create table public.motorist_call_recordings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  call_id uuid references public.motorist_calls(id) on delete cascade,
  provider text not null default 'telnyx',
  provider_session_id text,
  provider_recording_id text,
  storage_bucket text,
  storage_path text,
  mime_type text,
  status text not null check (status in ('pending', 'available', 'failed', 'deleted')),
  duration_seconds integer,
  fetched_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index call_recordings_provider_id_idx
  on public.motorist_call_recordings (organization_id, provider, provider_recording_id)
  where provider_recording_id is not null;

create table public.motorist_call_transcripts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  call_id uuid not null references public.motorist_calls(id) on delete cascade,
  recording_id uuid references public.motorist_call_recordings(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'complete', 'failed', 'restricted')),
  language text not null default 'sk',
  transcript_text text,
  speaker_segments jsonb not null default '[]'::jsonb,
  summary text,
  extracted_fields jsonb not null default '{}'::jsonb,
  qa_score numeric(5, 2),
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index call_transcripts_call_idx
  on public.motorist_call_transcripts (organization_id, call_id, created_at desc);

create table public.motorist_sms_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'telnyx_sms',
  provider_message_id text,
  case_id uuid references public.motorist_cases(id) on delete set null,
  call_id uuid references public.motorist_calls(id) on delete set null,
  to_number text not null,
  from_label text,
  direction text not null check (direction in ('outbound', 'inbound')),
  status text not null check (status in ('queued', 'sent', 'delivered', 'failed', 'received')),
  status_detail text,
  template_key text,
  body text not null,
  error text,
  raw_payload jsonb not null default '{}'::jsonb,
  idempotency_key text,
  request_fingerprint text,
  queued_at timestamptz,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  retry_count integer not null default 0 check (retry_count >= 0),
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sms_messages_provider_id_idx
  on public.motorist_sms_messages (organization_id, provider, provider_message_id)
  where provider_message_id is not null;

create unique index sms_messages_idempotency_idx
  on public.motorist_sms_messages (organization_id, provider, idempotency_key)
  where idempotency_key is not null;

create index sms_messages_outbox_claim_idx
  on public.motorist_sms_messages (organization_id, status, next_attempt_at, created_at)
  where direction = 'outbound'
    and status = 'queued';

-- Provider-neutral per-attempt audit of outbound SMS delivery.
create table public.motorist_sms_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  sms_message_id uuid not null references public.motorist_sms_messages(id) on delete cascade,
  provider text not null default 'telnyx_sms',
  attempt_number integer not null check (attempt_number >= 1),
  claim_id uuid not null default gen_random_uuid(),
  idempotency_key text not null,
  request_fingerprint text not null,
  status text not null check (status in ('queued', 'sending', 'accepted', 'failed', 'skipped')),
  provider_status_code integer,
  provider_message_id text,
  request_payload_safe jsonb not null default '{}'::jsonb,
  provider_response_safe jsonb not null default '{}'::jsonb,
  error_class text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index sms_attempts_message_attempt_number_idx
  on public.motorist_sms_attempts (sms_message_id, attempt_number);

create index sms_attempts_idempotency_idx
  on public.motorist_sms_attempts (organization_id, provider, idempotency_key, created_at desc);

create index sms_attempts_status_idx
  on public.motorist_sms_attempts (organization_id, provider, status, created_at desc);

create index sms_attempts_provider_message_idx
  on public.motorist_sms_attempts (organization_id, provider, provider_message_id)
  where provider_message_id is not null;

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

-- Safe request/response log shared by every external integration (fleet syncs,
-- telephony and SMS providers, internal job summaries).
create table public.motorist_integration_raw_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null,
  channel text not null check (channel in ('rest', 'websocket', 'sms', 'internal')),
  direction text not null check (direction in ('inbound', 'outbound')),
  event_type text not null,
  correlation_id text,
  request_id text,
  status_code integer,
  payload jsonb not null default '{}'::jsonb,
  headers_safe jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create index integration_raw_events_lookup_idx
  on public.motorist_integration_raw_events (organization_id, provider, channel, received_at desc);

create index integration_raw_events_correlation_idx
  on public.motorist_integration_raw_events (organization_id, provider, correlation_id)
  where correlation_id is not null;

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
    'motorist_sms_attempts',
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

alter table public.motorist_call_transcripts enable row level security;
create policy call_transcripts_restricted_access
  on public.motorist_call_transcripts
  for all
  using (public.motorist_has_org_role(organization_id, array['senior_dispatcher', 'manager', 'admin']))
  with check (public.motorist_has_org_role(organization_id, array['senior_dispatcher', 'manager', 'admin']));

alter table public.motorist_integration_raw_events enable row level security;
create policy integration_raw_events_admin_access
  on public.motorist_integration_raw_events
  for all
  using (public.motorist_has_org_role(organization_id, array['manager', 'admin']))
  with check (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

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
create trigger sms_attempts_updated_at before update on public.motorist_sms_attempts
  for each row execute function public.motorist_set_updated_at();
create trigger call_transcripts_updated_at before update on public.motorist_call_transcripts
  for each row execute function public.motorist_set_updated_at();

create index organization_integrations_status_idx on public.motorist_organization_integrations (organization_id, provider, status);
create index calls_active_idx on public.motorist_calls (organization_id, status, started_at desc);
create index call_events_call_idx on public.motorist_call_events (organization_id, call_id, created_at desc);
create index cases_active_idx on public.motorist_cases (organization_id, status, updated_at desc);
create index case_tasks_open_idx on public.motorist_case_tasks (organization_id, status, due_at);
create index locations_coordinates_idx on public.motorist_locations (organization_id, lat, lng);
create index audit_log_entity_idx on public.motorist_audit_log (organization_id, entity_type, entity_id, created_at desc);
