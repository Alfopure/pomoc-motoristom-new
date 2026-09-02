alter table public.motorist_organization_integrations
  add column if not exists status text not null default 'not_configured',
  add column if not exists enabled_features text[] not null default '{}'::text[],
  add column if not exists base_url text,
  add column if not exists websocket_url text,
  add column if not exists last_success_at timestamptz,
  add column if not exists last_error_at timestamptz,
  add column if not exists last_error text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.motorist_organization_integrations'::regclass
      and conname = 'organization_integrations_status_check'
  ) then
    alter table public.motorist_organization_integrations
      add constraint organization_integrations_status_check
      check (status in ('not_configured', 'configured', 'live', 'degraded', 'disabled'));
  end if;
end $$;

alter table public.motorist_telephony_extensions
  add column if not exists display_name text,
  add column if not exists outbound_cid text,
  add column if not exists call_forwarding text,
  add column if not exists is_registered boolean,
  add column if not exists is_viptel_phone_active boolean,
  add column if not exists allowed_changes text[] not null default '{}'::text[],
  add column if not exists last_synced_at timestamptz,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb;

update public.motorist_telephony_extensions extensions
set display_name = profiles.display_name
from public.motorist_profiles profiles
where extensions.profile_id = profiles.id
  and extensions.display_name is null;

alter table public.motorist_calls
  add column if not exists provider_call_id text,
  add column if not exists type text,
  add column if not exists application text,
  add column if not exists end_reason text,
  add column if not exists received_number text,
  add column if not exists destination_number text,
  add column if not exists caller_extension text,
  add column if not exists received_extension text,
  add column if not exists destination_extension text,
  add column if not exists queue_number text,
  add column if not exists from_queue_unique_id text,
  add column if not exists ring_seconds integer,
  add column if not exists complete_duration_seconds integer,
  add column if not exists recording_file text,
  add column if not exists raw_latest_payload jsonb not null default '{}'::jsonb;

update public.motorist_calls
set raw_latest_payload = raw_payload
where raw_latest_payload = '{}'::jsonb
  and raw_payload <> '{}'::jsonb;

alter table public.motorist_call_events
  add column if not exists provider_timestamp timestamptz,
  add column if not exists received_at timestamptz not null default now(),
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists normalized_payload jsonb not null default '{}'::jsonb,
  add column if not exists handled_status text not null default 'processed';

update public.motorist_call_events
set raw_payload = payload
where raw_payload = '{}'::jsonb
  and payload <> '{}'::jsonb;

update public.motorist_call_events
set provider_timestamp = provider_created_at
where provider_timestamp is null
  and provider_created_at is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.motorist_call_events'::regclass
      and conname = 'call_events_handled_status_check'
  ) then
    alter table public.motorist_call_events
      add constraint call_events_handled_status_check
      check (handled_status in ('processed', 'ignored', 'failed', 'unknown'));
  end if;
end $$;

alter table public.motorist_call_recordings
  add column if not exists cdr_id text,
  add column if not exists recording_file text,
  add column if not exists provider_download_ref text,
  add column if not exists mime_type text,
  add column if not exists size_bytes bigint,
  add column if not exists checksum text,
  add column if not exists fetched_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists retention_until timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.motorist_call_recordings'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table public.motorist_call_recordings drop constraint %I', constraint_name);
  end loop;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.motorist_call_recordings'::regclass
      and conname = 'call_recordings_status_check'
  ) then
    alter table public.motorist_call_recordings
      add constraint call_recordings_status_check
      check (status in ('pending', 'available', 'failed', 'deleted', 'restricted'));
  end if;
end $$;

alter table public.motorist_sms_messages
  add column if not exists from_identity text,
  add column if not exists provider_conversation_id text,
  add column if not exists status_detail text,
  add column if not exists price numeric(10, 4),
  add column if not exists segments integer,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists queued_at timestamptz,
  add column if not exists received_at timestamptz;

update public.motorist_sms_messages
set from_identity = from_label
where from_identity is null
  and from_label is not null;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.motorist_sms_messages'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table public.motorist_sms_messages drop constraint %I', constraint_name);
  end loop;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.motorist_sms_messages'::regclass
      and conname = 'sms_messages_status_check'
  ) then
    alter table public.motorist_sms_messages
      add constraint sms_messages_status_check
      check (status in ('draft', 'queued', 'sent', 'delivered', 'failed', 'received'));
  end if;
end $$;

create table if not exists public.motorist_integration_raw_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'viptel',
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

create table if not exists public.motorist_telephony_commands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'viptel',
  command_type text not null,
  requested_by uuid references public.motorist_profiles(id) on delete set null,
  call_id uuid references public.motorist_calls(id) on delete set null,
  queue_id uuid references public.motorist_telephony_queues(id) on delete set null,
  extension_id uuid references public.motorist_telephony_extensions(id) on delete set null,
  request_payload jsonb not null default '{}'::jsonb,
  provider_response jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'sent', 'accepted', 'failed', 'confirmed_by_event')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  confirmed_at timestamptz,
  unique (organization_id, provider, idempotency_key)
);

create table if not exists public.motorist_queue_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'viptel',
  queue_id uuid references public.motorist_telephony_queues(id) on delete cascade,
  extension_id uuid references public.motorist_telephony_extensions(id) on delete cascade,
  queue_number text not null,
  extension_number text not null,
  member_name text,
  paused boolean not null default false,
  in_use boolean not null default false,
  calls_taken integer not null default 0,
  last_call_taken_ago integer,
  joined_at timestamptz,
  last_synced_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, queue_number, extension_number)
);

create table if not exists public.motorist_queue_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  provider text not null default 'viptel',
  queue_id uuid references public.motorist_telephony_queues(id) on delete set null,
  queue_number text not null,
  current_calls_count integer not null default 0,
  waiting_calls integer not null default 0,
  members jsonb not null default '[]'::jsonb,
  captured_at timestamptz not null default now(),
  source text not null default 'rest_poll' check (source in ('rest_poll', 'websocket_event', 'manual_refresh')),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.motorist_call_transcripts (
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

drop trigger if exists telephony_commands_updated_at on public.motorist_telephony_commands;
create trigger telephony_commands_updated_at before update on public.motorist_telephony_commands
  for each row execute function public.motorist_set_updated_at();

drop trigger if exists queue_memberships_updated_at on public.motorist_queue_memberships;
create trigger queue_memberships_updated_at before update on public.motorist_queue_memberships
  for each row execute function public.motorist_set_updated_at();

drop trigger if exists call_transcripts_updated_at on public.motorist_call_transcripts;
create trigger call_transcripts_updated_at before update on public.motorist_call_transcripts
  for each row execute function public.motorist_set_updated_at();

alter table public.motorist_integration_raw_events enable row level security;
alter table public.motorist_telephony_commands enable row level security;
alter table public.motorist_queue_memberships enable row level security;
alter table public.motorist_queue_snapshots enable row level security;
alter table public.motorist_call_transcripts enable row level security;

drop policy if exists integration_raw_events_admin_access on public.motorist_integration_raw_events;
create policy integration_raw_events_admin_access
  on public.motorist_integration_raw_events
  for all
  using (public.motorist_has_org_role(organization_id, array['manager', 'admin']))
  with check (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

drop policy if exists telephony_commands_organization_access on public.motorist_telephony_commands;
create policy telephony_commands_organization_access
  on public.motorist_telephony_commands
  for all
  using (public.motorist_is_org_member(organization_id))
  with check (public.motorist_is_org_member(organization_id));

drop policy if exists queue_memberships_organization_access on public.motorist_queue_memberships;
create policy queue_memberships_organization_access
  on public.motorist_queue_memberships
  for all
  using (public.motorist_is_org_member(organization_id))
  with check (public.motorist_is_org_member(organization_id));

drop policy if exists queue_snapshots_organization_access on public.motorist_queue_snapshots;
create policy queue_snapshots_organization_access
  on public.motorist_queue_snapshots
  for all
  using (public.motorist_is_org_member(organization_id))
  with check (public.motorist_is_org_member(organization_id));

drop policy if exists call_transcripts_restricted_access on public.motorist_call_transcripts;
create policy call_transcripts_restricted_access
  on public.motorist_call_transcripts
  for all
  using (public.motorist_has_org_role(organization_id, array['senior_dispatcher', 'manager', 'admin']))
  with check (public.motorist_has_org_role(organization_id, array['senior_dispatcher', 'manager', 'admin']));

create index if not exists organization_integrations_status_idx
  on public.motorist_organization_integrations (organization_id, provider, status);

create index if not exists telephony_extensions_provider_extension_idx
  on public.motorist_telephony_extensions (organization_id, provider, extension);

create index if not exists calls_provider_call_id_idx
  on public.motorist_calls (organization_id, provider, provider_call_id)
  where provider_call_id is not null;

create index if not exists calls_viptel_queue_idx
  on public.motorist_calls (organization_id, queue_number, started_at desc)
  where queue_number is not null;

create index if not exists call_events_unique_id_idx
  on public.motorist_call_events (organization_id, provider, viptel_unique_id, received_at desc)
  where viptel_unique_id is not null;

create index if not exists call_events_type_idx
  on public.motorist_call_events (organization_id, provider, event_type, received_at desc);

create index if not exists call_recordings_retention_idx
  on public.motorist_call_recordings (organization_id, retention_until)
  where retention_until is not null;

create index if not exists sms_messages_provider_id_idx
  on public.motorist_sms_messages (organization_id, provider, provider_message_id)
  where provider_message_id is not null;

create index if not exists integration_raw_events_lookup_idx
  on public.motorist_integration_raw_events (organization_id, provider, channel, received_at desc);

create index if not exists integration_raw_events_correlation_idx
  on public.motorist_integration_raw_events (organization_id, provider, correlation_id)
  where correlation_id is not null;

create index if not exists telephony_commands_status_idx
  on public.motorist_telephony_commands (organization_id, provider, status, created_at desc);

create index if not exists queue_memberships_queue_idx
  on public.motorist_queue_memberships (organization_id, provider, queue_number);

create index if not exists queue_snapshots_queue_idx
  on public.motorist_queue_snapshots (organization_id, provider, queue_number, captured_at desc);

create index if not exists call_transcripts_call_idx
  on public.motorist_call_transcripts (organization_id, call_id, created_at desc);

insert into public.motorist_organization_integrations (
  organization_id,
  provider,
  enabled,
  status,
  enabled_features,
  base_url,
  websocket_url,
  secret_ref,
  config
)
select
  organizations.id,
  'viptel',
  false,
  'not_configured',
  array['rest', 'websocket', 'recordings', 'click_to_call', 'queue_control']::text[],
  'https://pbxmanager.viptel.sk/',
  'wss://pbxmanager.viptel.sk:8088',
  'env:VIPTEL_USERNAME,VIPTEL_PASSWORD',
  '{"requires_activation":true,"requires_ip_allowlist":true,"rate_limit":{"requests":20,"interval_seconds":5,"block_minutes":30}}'::jsonb
from public.motorist_organizations organizations
where organizations.slug = 'pomoc-motoristom'
on conflict (organization_id, provider) do update
set
  status = case
    when public.motorist_organization_integrations.enabled then public.motorist_organization_integrations.status
    else 'not_configured'
  end,
  enabled_features = excluded.enabled_features,
  base_url = excluded.base_url,
  websocket_url = excluded.websocket_url,
  secret_ref = coalesce(public.motorist_organization_integrations.secret_ref, excluded.secret_ref),
  config = public.motorist_organization_integrations.config || excluded.config;

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
  'viptel_sms',
  false,
  'not_configured',
  array['sms']::text[],
  'https://smsapi.viptel.sk/api/',
  'env:VIPTEL_SMS_USERNAME,VIPTEL_SMS_PASSWORD',
  '{"requires_activation":true,"public_endpoint_docs_available":true,"smoke_tests":["GET /identities/","GET /credits/"]}'::jsonb
from public.motorist_organizations organizations
where organizations.slug = 'pomoc-motoristom'
on conflict (organization_id, provider) do update
set
  status = case
    when public.motorist_organization_integrations.enabled then public.motorist_organization_integrations.status
    else 'not_configured'
  end,
  enabled_features = excluded.enabled_features,
  base_url = excluded.base_url,
  secret_ref = coalesce(public.motorist_organization_integrations.secret_ref, excluded.secret_ref),
  config = public.motorist_organization_integrations.config || excluded.config;
