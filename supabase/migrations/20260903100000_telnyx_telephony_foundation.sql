-- Telnyx telephony foundation (Phase 2, stage 1).
--
-- Extends the provider-neutral call/SMS tables from the foundation schema and
-- adds the Telnyx-specific runtime model: webhook claim ledger, call sessions
-- and legs, ring plans/groups/attempts, business hours, IVR menus, callback
-- requests, operator devices/presence, pause reasons, per-operator and
-- per-organisation telephony settings and daily usage counters.
--
-- Conventions (see 20260520192000_foundation_schema.sql):
--   * RLS through app_private.motorist_is_org_member / motorist_has_org_role
--   * updated_at maintained by public.motorist_set_updated_at()
--   * runtime tables: members may read, only the service role writes
--   * configuration tables: manager/admin may write
--   * RPCs are SECURITY DEFINER, callable by the service role only
--
-- The file is written to be re-runnable on a database where parts of it may
-- already exist (create ... if not exists / drop policy if exists).

-- ---------------------------------------------------------------------------
-- 1. Business hours
-- ---------------------------------------------------------------------------

create table if not exists public.motorist_business_hours (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  name text not null,
  timezone text not null default 'Europe/Bratislava',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists public.motorist_business_hours_intervals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  business_hours_id uuid not null references public.motorist_business_hours(id) on delete cascade,
  -- ISO weekday: 1 = Monday ... 7 = Sunday.
  weekday smallint not null check (weekday between 1 and 7),
  opens time not null,
  closes time not null,
  created_at timestamptz not null default now(),
  check (opens < closes),
  unique (business_hours_id, weekday, opens)
);

create table if not exists public.motorist_business_hours_exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  business_hours_id uuid not null references public.motorist_business_hours(id) on delete cascade,
  date date not null,
  closed boolean not null default true,
  -- Optional replacement intervals for the day: [{"opens":"08:00","closes":"12:00"}].
  intervals jsonb not null default '[]'::jsonb,
  label text,
  created_at timestamptz not null default now(),
  unique (business_hours_id, date)
);

-- ---------------------------------------------------------------------------
-- 2. Ring groups, members, plans, steps
-- ---------------------------------------------------------------------------

create table if not exists public.motorist_ring_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  name text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists public.motorist_ring_group_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  ring_group_id uuid not null references public.motorist_ring_groups(id) on delete cascade,
  member_kind text not null check (member_kind in ('operator', 'external_number')),
  profile_id uuid references public.motorist_profiles(id) on delete cascade,
  external_number text,
  position integer not null check (position >= 0),
  -- Per-member ring time for 'ordered' steps; null = the step timeout.
  ring_secs integer check (ring_secs between 5 and 120),
  last_offered_at timestamptz,
  last_answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (member_kind = 'operator' and profile_id is not null and external_number is null)
    or (member_kind = 'external_number' and external_number is not null and profile_id is null)
  ),
  unique (ring_group_id, position)
);

create unique index if not exists ring_group_members_profile_idx
  on public.motorist_ring_group_members (ring_group_id, profile_id)
  where profile_id is not null;

create unique index if not exists ring_group_members_external_idx
  on public.motorist_ring_group_members (ring_group_id, external_number)
  where external_number is not null;

create table if not exists public.motorist_ring_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  name text not null,
  fallback_kind text not null default 'callback_prompt'
    check (fallback_kind in ('external_number', 'waiting_room', 'callback_prompt', 'hangup_message')),
  fallback_number text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (fallback_kind <> 'external_number' or fallback_number is not null),
  unique (organization_id, name)
);

create table if not exists public.motorist_ring_plan_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  ring_plan_id uuid not null references public.motorist_ring_plans(id) on delete cascade,
  step_index integer not null check (step_index >= 0),
  ring_group_id uuid not null references public.motorist_ring_groups(id) on delete cascade,
  timeout_secs integer not null default 20 check (timeout_secs between 5 and 120),
  strategy text not null default 'all' check (strategy in ('all', 'ordered')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ring_plan_id, step_index)
);

create index if not exists ring_plan_steps_group_idx
  on public.motorist_ring_plan_steps (ring_group_id);

-- ---------------------------------------------------------------------------
-- 3. IVR menus
-- ---------------------------------------------------------------------------

create table if not exists public.motorist_ivr_menus (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  name text not null,
  -- Pre-recorded prompt (served under TELNYX_MEDIA_BASE_URL); tts_text is the fallback.
  prompt_media_url text,
  tts_text text,
  invalid_media_url text,
  timeout_secs integer not null default 5 check (timeout_secs between 1 and 30),
  max_tries integer not null default 2 check (max_tries between 1 and 5),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists public.motorist_ivr_options (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  ivr_menu_id uuid not null references public.motorist_ivr_menus(id) on delete cascade,
  digit text not null check (digit ~ '^[0-9*#]$'),
  action text not null check (action in ('ring_plan', 'callback', 'external_number', 'waiting_room', 'repeat', 'hangup')),
  target_ring_plan_id uuid references public.motorist_ring_plans(id) on delete set null,
  target_number text,
  label text not null,
  prompt_media_url text,
  tts_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (action <> 'ring_plan' or target_ring_plan_id is not null),
  check (action <> 'external_number' or target_number is not null),
  unique (ivr_menu_id, digit)
);

-- ---------------------------------------------------------------------------
-- 4. Telephony lines (DIDs) gain routing configuration
-- ---------------------------------------------------------------------------

alter table public.motorist_telephony_lines
  add column if not exists telnyx_number_id text,
  add column if not exists partner_name text,
  add column if not exists ring_plan_id uuid references public.motorist_ring_plans(id) on delete set null,
  add column if not exists ivr_menu_id uuid references public.motorist_ivr_menus(id) on delete set null,
  add column if not exists business_hours_id uuid references public.motorist_business_hours(id) on delete set null,
  add column if not exists environment text not null default 'production'
    check (environment in ('production', 'development')),
  add column if not exists active boolean not null default true;

create unique index if not exists telephony_lines_org_number_idx
  on public.motorist_telephony_lines (organization_id, phone_number);

create unique index if not exists telephony_lines_telnyx_number_idx
  on public.motorist_telephony_lines (telnyx_number_id)
  where telnyx_number_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Pause reasons, operator presence, devices, per-operator settings
-- ---------------------------------------------------------------------------

create table if not exists public.motorist_pause_reasons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  code text not null,
  label text not null,
  max_minutes integer check (max_minutes is null or max_minutes > 0),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

-- ---------------------------------------------------------------------------
-- 6. Webhook claim ledger (service role only)
-- ---------------------------------------------------------------------------

create table if not exists public.motorist_telnyx_webhook_events (
  event_id text primary key,
  organization_id uuid references public.motorist_organizations(id) on delete set null,
  event_type text not null,
  call_session_id text,
  call_leg_id text,
  call_control_id text,
  connection_id text,
  status text not null default 'queued' check (status in ('queued', 'processed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  claimed_at timestamptz,
  error text,
  payload jsonb,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists telnyx_webhook_events_session_idx
  on public.motorist_telnyx_webhook_events (call_session_id, received_at)
  where call_session_id is not null;

create index if not exists telnyx_webhook_events_status_idx
  on public.motorist_telnyx_webhook_events (status, received_at);

-- ---------------------------------------------------------------------------
-- 7. Call sessions and legs
-- ---------------------------------------------------------------------------

create table if not exists public.motorist_call_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  telnyx_session_id text unique,
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  state text not null default 'received' check (state in (
    'received', 'greeting', 'ivr', 'ringing', 'talking', 'held', 'consulting', 'conference',
    'parked', 'waiting', 'wrap_up', 'after_hours', 'callback_offered', 'missed', 'failed', 'ended'
  )),
  version integer not null default 0,
  lease_token text,
  lease_until timestamptz,
  line_id uuid references public.motorist_telephony_lines(id) on delete set null,
  ring_plan_id uuid references public.motorist_ring_plans(id) on delete set null,
  current_step integer not null default 0 check (current_step >= 0),
  conference_id text,
  conference_name text,
  customer_leg_id uuid,
  answered_by_profile_id uuid references public.motorist_profiles(id) on delete set null,
  case_id uuid references public.motorist_cases(id) on delete set null,
  caller_number text,
  called_number text,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  hold_started_at timestamptz,
  parked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists call_sessions_active_idx
  on public.motorist_call_sessions (organization_id, state)
  where state not in ('ended', 'failed');

create index if not exists call_sessions_started_idx
  on public.motorist_call_sessions (organization_id, started_at desc);

create index if not exists call_sessions_case_idx
  on public.motorist_call_sessions (case_id)
  where case_id is not null;

create table if not exists public.motorist_call_legs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  session_id uuid not null references public.motorist_call_sessions(id) on delete cascade,
  telnyx_call_control_id text not null unique,
  telnyx_call_leg_id text unique,
  role text not null check (role in ('customer', 'operator', 'consult', 'supervisor', 'external')),
  profile_id uuid references public.motorist_profiles(id) on delete set null,
  to_number text,
  from_number text,
  state text not null default 'initiated' check (state in ('initiated', 'ringing', 'answered', 'bridged', 'held', 'ended', 'failed')),
  hangup_cause text,
  hangup_source text,
  initiated_at timestamptz not null default now(),
  answered_at timestamptz,
  bridged_at timestamptz,
  ended_at timestamptz,
  client_state jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists call_legs_session_idx
  on public.motorist_call_legs (session_id, role);

create index if not exists call_legs_profile_open_idx
  on public.motorist_call_legs (profile_id)
  where profile_id is not null and ended_at is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'motorist_call_sessions_customer_leg_fkey'
      and conrelid = 'public.motorist_call_sessions'::regclass
  ) then
    alter table public.motorist_call_sessions
      add constraint motorist_call_sessions_customer_leg_fkey
      foreign key (customer_leg_id) references public.motorist_call_legs(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Ring attempts
-- ---------------------------------------------------------------------------

create table if not exists public.motorist_ring_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  session_id uuid not null references public.motorist_call_sessions(id) on delete cascade,
  step_index integer not null check (step_index >= 0),
  ring_group_id uuid references public.motorist_ring_groups(id) on delete set null,
  member_kind text not null check (member_kind in ('operator', 'external_number')),
  profile_id uuid references public.motorist_profiles(id) on delete cascade,
  external_number text,
  leg_id uuid references public.motorist_call_legs(id) on delete set null,
  position integer not null default 0 check (position >= 0),
  ring_secs integer not null default 20 check (ring_secs between 5 and 120),
  result text not null default 'pending' check (result in (
    'pending', 'offered', 'answered', 'no_answer', 'skipped_offline', 'busy', 'cancelled', 'failed'
  )),
  offered_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (member_kind = 'operator' and profile_id is not null and external_number is null)
    or (member_kind = 'external_number' and external_number is not null and profile_id is null)
  )
);

create unique index if not exists ring_attempts_session_step_profile_idx
  on public.motorist_ring_attempts (session_id, step_index, profile_id)
  where profile_id is not null;

create unique index if not exists ring_attempts_session_step_external_idx
  on public.motorist_ring_attempts (session_id, step_index, external_number)
  where external_number is not null;

-- One open offer per operator across all sessions.
create unique index if not exists ring_attempts_profile_open_offer_idx
  on public.motorist_ring_attempts (profile_id)
  where result = 'offered' and profile_id is not null;

create index if not exists ring_attempts_session_idx
  on public.motorist_ring_attempts (session_id, step_index, position);

-- ---------------------------------------------------------------------------
-- 9. Operator presence, devices, per-operator settings
-- ---------------------------------------------------------------------------

create table if not exists public.motorist_operator_presence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null unique references public.motorist_profiles(id) on delete cascade,
  status text not null default 'offline'
    check (status in ('available', 'ringing', 'on_call', 'after_call_work', 'paused', 'offline')),
  current_session_id uuid references public.motorist_call_sessions(id) on delete set null,
  pause_reason_id uuid references public.motorist_pause_reasons(id) on delete set null,
  wrap_up_until timestamptz,
  status_since timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists operator_presence_org_status_idx
  on public.motorist_operator_presence (organization_id, status);

create table if not exists public.motorist_operator_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null references public.motorist_profiles(id) on delete cascade,
  environment text not null default 'production' check (environment in ('production', 'development')),
  telnyx_credential_id text,
  sip_username text,
  credential_expires_at timestamptz,
  last_token_issued_at timestamptz,
  token_expires_at timestamptz,
  device_seen_at timestamptz,
  device_session_id text,
  registration_state text not null default 'unregistered'
    check (registration_state in ('unregistered', 'registering', 'registered', 'error')),
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, environment)
);

create unique index if not exists operator_devices_sip_username_idx
  on public.motorist_operator_devices (environment, sip_username)
  where sip_username is not null;

create table if not exists public.motorist_operator_telephony_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null unique references public.motorist_profiles(id) on delete cascade,
  default_from_line_id uuid references public.motorist_telephony_lines(id) on delete set null,
  wrap_up_seconds integer not null default 30 check (wrap_up_seconds between 0 and 600),
  auto_answer_outbound boolean not null default true,
  ring_device_volume integer not null default 80 check (ring_device_volume between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 10. Organisation-wide telephony settings (kill switch) and daily usage
-- ---------------------------------------------------------------------------

create table if not exists public.motorist_telephony_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.motorist_organizations(id) on delete cascade,
  live_calls_enabled boolean not null default false,
  sms_live_sends boolean not null default false,
  daily_leg_soft_cap integer not null default 500 check (daily_leg_soft_cap > 0),
  park_max_minutes integer not null default 30 check (park_max_minutes between 1 and 240),
  destination_allowlist text[] not null default array['SK', 'CZ']::text[],
  max_ring_fanout integer not null default 8 check (max_ring_fanout between 1 and 20),
  max_concurrent_legs integer not null default 9 check (max_concurrent_legs between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.motorist_telephony_daily_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  day date not null,
  legs integer not null default 0 check (legs >= 0),
  minutes numeric(10, 2) not null default 0 check (minutes >= 0),
  sms_count integer not null default 0 check (sms_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, day)
);

-- ---------------------------------------------------------------------------
-- 11. Callback requests
-- ---------------------------------------------------------------------------

create table if not exists public.motorist_callback_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  caller_number text not null,
  caller_name text,
  source text not null check (source in ('ivr', 'after_hours', 'park_timeout', 'missed', 'manual')),
  status text not null default 'open' check (status in ('open', 'scheduled', 'done', 'cancelled')),
  session_id uuid references public.motorist_call_sessions(id) on delete set null,
  line_id uuid references public.motorist_telephony_lines(id) on delete set null,
  case_id uuid references public.motorist_cases(id) on delete set null,
  claimed_by uuid references public.motorist_profiles(id) on delete set null,
  claimed_at timestamptz,
  due_at timestamptz,
  resolved_at timestamptz,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists callback_requests_open_idx
  on public.motorist_callback_requests (organization_id, status, due_at, created_at)
  where status in ('open', 'scheduled');

-- ---------------------------------------------------------------------------
-- 12. Existing call / SMS tables
-- ---------------------------------------------------------------------------

alter table public.motorist_calls
  add column if not exists provider_call_id text,
  add column if not exists session_id uuid references public.motorist_call_sessions(id) on delete set null,
  add column if not exists end_reason text,
  add column if not exists received_number text,
  add column if not exists destination_number text,
  add column if not exists ring_seconds integer,
  add column if not exists ring_group_id uuid references public.motorist_ring_groups(id) on delete set null,
  add column if not exists operator_leg_id uuid references public.motorist_call_legs(id) on delete set null,
  -- Latest app-side state; nulled after 30 days by the retention job.
  add column if not exists raw_latest_payload jsonb not null default '{}'::jsonb;

create unique index if not exists calls_session_idx
  on public.motorist_calls (session_id)
  where session_id is not null;

alter table public.motorist_call_events
  add column if not exists provider_timestamp timestamptz,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb;

-- Kept for transcripts-process / CallDetailDrawer; a no-op where the
-- foundation schema already created it.
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

create index if not exists call_transcripts_call_idx
  on public.motorist_call_transcripts (organization_id, call_id, created_at desc);

alter table public.motorist_sms_messages
  add column if not exists from_sender text,
  add column if not exists messaging_profile_id text,
  add column if not exists idempotency_key text,
  add column if not exists retry_count integer not null default 0 check (retry_count >= 0),
  add column if not exists next_attempt_at timestamptz,
  add column if not exists locked_at timestamptz;

create unique index if not exists sms_messages_idempotency_idx
  on public.motorist_sms_messages (organization_id, provider, idempotency_key)
  where idempotency_key is not null;

create table if not exists public.motorist_sms_attempts (
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

create unique index if not exists sms_attempts_message_attempt_number_idx
  on public.motorist_sms_attempts (sms_message_id, attempt_number);

-- ---------------------------------------------------------------------------
-- 13. updated_at triggers
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'motorist_business_hours',
    'motorist_ring_groups',
    'motorist_ring_group_members',
    'motorist_ring_plans',
    'motorist_ring_plan_steps',
    'motorist_ivr_menus',
    'motorist_ivr_options',
    'motorist_pause_reasons',
    'motorist_call_sessions',
    'motorist_call_legs',
    'motorist_ring_attempts',
    'motorist_operator_presence',
    'motorist_operator_devices',
    'motorist_operator_telephony_settings',
    'motorist_telephony_settings',
    'motorist_telephony_daily_usage',
    'motorist_callback_requests',
    'motorist_call_transcripts',
    'motorist_sms_attempts'
  ]
  loop
    -- Skip tables that already carry the foundation trigger (transcripts, SMS attempts).
    if exists (
      select 1
      from pg_trigger
      where tgrelid = format('public.%I', table_name)::regclass
        and not tgisinternal
        and tgfoid = 'public.motorist_set_updated_at()'::regprocedure
    ) then
      continue;
    end if;
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.motorist_set_updated_at()',
      table_name || '_updated_at',
      table_name
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 14. Row level security
-- ---------------------------------------------------------------------------

-- Runtime tables: members read, only the service role (RLS bypass) writes.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'motorist_call_sessions',
    'motorist_call_legs',
    'motorist_ring_attempts',
    'motorist_operator_presence',
    'motorist_operator_devices',
    'motorist_telephony_daily_usage',
    'motorist_callback_requests'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_member_select', table_name);
    execute format(
      'create policy %I on public.%I for select using (app_private.motorist_is_org_member(organization_id))',
      table_name || '_member_select',
      table_name
    );
  end loop;
end $$;

-- Configuration tables: members read, manager/admin write.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'motorist_business_hours',
    'motorist_business_hours_intervals',
    'motorist_business_hours_exceptions',
    'motorist_ring_groups',
    'motorist_ring_group_members',
    'motorist_ring_plans',
    'motorist_ring_plan_steps',
    'motorist_ivr_menus',
    'motorist_ivr_options',
    'motorist_pause_reasons',
    'motorist_operator_telephony_settings',
    'motorist_telephony_settings'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_member_select', table_name);
    execute format(
      'create policy %I on public.%I for select using (app_private.motorist_is_org_member(organization_id))',
      table_name || '_member_select',
      table_name
    );
    execute format('drop policy if exists %I on public.%I', table_name || '_manager_write', table_name);
    execute format(
      'create policy %I on public.%I for all using (app_private.motorist_has_org_role(organization_id, array[''manager'', ''admin''])) with check (app_private.motorist_has_org_role(organization_id, array[''manager'', ''admin'']))',
      table_name || '_manager_write',
      table_name
    );
  end loop;
end $$;

-- Existing tables that may be created here on a fresh database keep the
-- foundation policies; (re)create them only when missing.
alter table public.motorist_call_transcripts enable row level security;
drop policy if exists call_transcripts_restricted_access on public.motorist_call_transcripts;
create policy call_transcripts_restricted_access
  on public.motorist_call_transcripts
  for all
  using (app_private.motorist_has_org_role(organization_id, array['senior_dispatcher', 'manager', 'admin']))
  with check (app_private.motorist_has_org_role(organization_id, array['senior_dispatcher', 'manager', 'admin']));

alter table public.motorist_sms_attempts enable row level security;
drop policy if exists motorist_sms_attempts_organization_access on public.motorist_sms_attempts;
create policy motorist_sms_attempts_organization_access
  on public.motorist_sms_attempts
  for all
  using (app_private.motorist_is_org_member(organization_id))
  with check (app_private.motorist_is_org_member(organization_id));

-- Webhook ledger: service role only, no policies for authenticated users.
alter table public.motorist_telnyx_webhook_events enable row level security;
revoke all on table public.motorist_telnyx_webhook_events from public, anon, authenticated;
grant select, insert, update, delete on table public.motorist_telnyx_webhook_events to service_role;

-- ---------------------------------------------------------------------------
-- 15. RPCs (SECURITY DEFINER, service role only)
-- ---------------------------------------------------------------------------

-- Claims a webhook event for processing. Outcomes:
--   claimed    -> the caller owns the event (new, or a stale/failed claim was taken over)
--   duplicate  -> the event was already processed
--   busy       -> another invocation holds a fresh claim
create or replace function public.motorist_telnyx_claim_webhook_event(
  p_event_id text,
  p_event_type text,
  p_payload jsonb,
  p_organization_id uuid default null,
  p_call_session_id text default null,
  p_call_leg_id text default null,
  p_call_control_id text default null,
  p_connection_id text default null,
  p_occurred_at timestamptz default null,
  p_stale_after_ms integer default 30000
)
returns table (outcome text, event_status text, event_attempts integer, event_claimed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.motorist_telnyx_webhook_events%rowtype;
  v_stale interval := pg_catalog.make_interval(secs => greatest(1000, p_stale_after_ms) / 1000.0);
begin
  insert into public.motorist_telnyx_webhook_events (
    event_id,
    organization_id,
    event_type,
    call_session_id,
    call_leg_id,
    call_control_id,
    connection_id,
    status,
    attempts,
    claimed_at,
    payload,
    occurred_at
  )
  values (
    p_event_id,
    p_organization_id,
    p_event_type,
    p_call_session_id,
    p_call_leg_id,
    p_call_control_id,
    p_connection_id,
    'queued',
    1,
    pg_catalog.now(),
    p_payload,
    p_occurred_at
  )
  on conflict (event_id) do nothing
  returning * into v_row;

  if found then
    outcome := 'claimed';
    event_status := v_row.status;
    event_attempts := v_row.attempts;
    event_claimed_at := v_row.claimed_at;
    return next;
    return;
  end if;

  select *
  into v_row
  from public.motorist_telnyx_webhook_events
  where event_id = p_event_id
  for update;

  if v_row.status = 'processed' then
    outcome := 'duplicate';
    event_status := v_row.status;
    event_attempts := v_row.attempts;
    event_claimed_at := v_row.claimed_at;
    return next;
    return;
  end if;

  if v_row.claimed_at is not null and v_row.claimed_at > pg_catalog.now() - v_stale then
    outcome := 'busy';
    event_status := v_row.status;
    event_attempts := v_row.attempts;
    event_claimed_at := v_row.claimed_at;
    return next;
    return;
  end if;

  update public.motorist_telnyx_webhook_events
  set
    claimed_at = pg_catalog.now(),
    attempts = motorist_telnyx_webhook_events.attempts + 1,
    payload = coalesce(motorist_telnyx_webhook_events.payload, p_payload),
    organization_id = coalesce(motorist_telnyx_webhook_events.organization_id, p_organization_id)
  where event_id = p_event_id
  returning * into v_row;

  outcome := 'claimed';
  event_status := v_row.status;
  event_attempts := v_row.attempts;
  -- The claim stamp identifies this claim: the ledger update is scoped to it so a
  -- late finisher cannot release a claim that a redelivery has already taken over.
  event_claimed_at := v_row.claimed_at;
  return next;
end;
$$;

-- Per-session lease so that concurrent webhook invocations serialise their
-- reducer runs. Re-entrant for the same token.
create or replace function public.motorist_session_lease_acquire(
  p_session_id uuid,
  p_token text,
  p_ttl_ms integer default 4000
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with acquired as (
    update public.motorist_call_sessions
    set
      lease_token = p_token,
      lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => greatest(250, least(p_ttl_ms, 30000)) / 1000.0)
    where id = p_session_id
      and (
        lease_until is null
        or lease_until < pg_catalog.now()
        or lease_token = p_token
      )
    returning 1
  )
  select exists(select 1 from acquired);
$$;

create or replace function public.motorist_session_lease_release(
  p_session_id uuid,
  p_token text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with released as (
    update public.motorist_call_sessions
    set
      lease_token = null,
      lease_until = null
    where id = p_session_id
      and lease_token = p_token
    returning 1
  )
  select exists(select 1 from released);
$$;

-- Atomic operator reservation on the operator leg's call.answered: exactly
-- one session may move an operator to on_call. Re-entrant for the session that
-- already holds the reservation (a version CAS retry re-runs the guard, and a
-- second `false` there would hang up the leg that legitimately answered).
create or replace function public.motorist_reserve_operator(
  p_profile_id uuid,
  p_session_id uuid
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with reserved as (
    update public.motorist_operator_presence
    set
      status = 'on_call',
      current_session_id = p_session_id,
      wrap_up_until = null,
      status_since = pg_catalog.now(),
      updated_at = pg_catalog.now()
    where profile_id = p_profile_id
      and (
        status in ('available', 'ringing', 'after_call_work')
        or current_session_id = p_session_id
      )
      and (current_session_id is null or current_session_id = p_session_id)
    returning 1
  )
  select exists(select 1 from reserved);
$$;

-- Step advance guard: only the winner of the compare-and-set materialises the
-- next ring step.
create or replace function public.motorist_advance_ring_step(
  p_session_id uuid,
  p_expected_step integer
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with advanced as (
    update public.motorist_call_sessions
    set
      current_step = p_expected_step + 1,
      version = version + 1,
      updated_at = pg_catalog.now()
    where id = p_session_id
      and current_step = p_expected_step
    returning 1
  )
  select exists(select 1 from advanced);
$$;

revoke all on function public.motorist_telnyx_claim_webhook_event(text, text, jsonb, uuid, text, text, text, text, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.motorist_session_lease_acquire(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.motorist_session_lease_release(uuid, text)
  from public, anon, authenticated;
revoke all on function public.motorist_reserve_operator(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.motorist_advance_ring_step(uuid, integer)
  from public, anon, authenticated;

grant execute on function public.motorist_telnyx_claim_webhook_event(text, text, jsonb, uuid, text, text, text, text, timestamptz, integer)
  to service_role;
grant execute on function public.motorist_session_lease_acquire(uuid, text, integer)
  to service_role;
grant execute on function public.motorist_session_lease_release(uuid, text)
  to service_role;
grant execute on function public.motorist_reserve_operator(uuid, uuid)
  to service_role;
grant execute on function public.motorist_advance_ring_step(uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 16. Job control for the ledger prune (run by the cron or one-shot only)
-- ---------------------------------------------------------------------------

insert into public.motorist_job_controls (job_name, enabled)
values ('telephony.ledger.prune', false)
on conflict (job_name) do nothing;
