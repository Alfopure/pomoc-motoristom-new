-- AI demo ("Veronika"): one authorised outbound call bridged into an OpenAI
-- GPT-Live session over SIP.
--
-- The demo deliberately does NOT reuse `motorist_call_sessions`. That table is
-- the human dispatch state machine: its reducer expects an operator device, a
-- ring plan and `answered_by` to be a profile, and a fourth leg role would have
-- to be threaded through every transition. One narrow table keeps the human
-- call path byte-identical while still giving the demo durable idempotency.
--
-- Every paid step is preceded by a row transition, so a crash between the two
-- leaves a row the cron can clean up rather than an orphaned billable leg.
-- `failed` is defined as `error_code is not null`; the terminal state is only
-- ever reached through `ending`.
--
-- `latency_probe` exists because the point of the demo is *how fast it feels*.
-- It holds millisecond offsets and a direction only ("in" = caller audio,
-- "out" = Veronika) for the opening exchange — never transcript text, never
-- audio. Nothing else in the system records conversation content.
--
-- Service role only: the browser reaches this exclusively through the
-- admin-gated `/api/telephony/ai-demo/*` routes.

begin;

create table if not exists public.motorist_ai_demo_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  direction text not null default 'outbound' check (direction in ('outbound')),
  request_id uuid,
  actor_profile_id uuid references public.motorist_profiles(id) on delete restrict,
  environment text not null check (environment in ('production', 'development')),
  scenario text not null default 'replacement_vehicle_return',
  target_number text not null,
  from_number text not null,
  correlation_token text not null,

  state text not null default 'requested' check (state in (
    'requested', 'sip_dialing', 'ai_offered', 'ai_accepted',
    'mobile_dialing', 'bridged', 'talking', 'ending', 'ended', 'failed')),
  greeting_status text not null default 'none' check (greeting_status in (
    'none', 'requested', 'appended', 'heard_started', 'failed', 'skipped_replay')),
  end_reason text,
  error_code text,

  sip_dial_command_id text not null,
  mobile_dial_command_id text,
  sip_dial_outcome text not null default 'none' check (sip_dial_outcome in ('none', 'unknown', 'accepted', 'rejected')),
  mobile_dial_outcome text not null default 'none' check (mobile_dial_outcome in ('none', 'unknown', 'accepted', 'rejected')),

  telnyx_sip_call_control_id text,
  telnyx_sip_call_leg_id text,
  telnyx_mobile_call_control_id text,
  telnyx_mobile_call_leg_id text,
  telnyx_call_session_id text,
  openai_session_id text,

  sip_hangup_cause text,
  mobile_hangup_cause text,
  hangup_source text,
  sip_hangup_done_at timestamptz,
  mobile_hangup_done_at timestamptz,
  openai_hangup_done_at timestamptz,
  openai_hangup_attempts integer not null default 0 check (openai_hangup_attempts >= 0),

  requested_at timestamptz not null default now(),
  sip_dialed_at timestamptz,
  sip_initiated_at timestamptz,
  ai_offered_at timestamptz,
  accept_started_at timestamptz,
  ai_accepted_at timestamptz,
  sip_answered_at timestamptz,
  mobile_dialed_at timestamptz,
  mobile_initiated_at timestamptz,
  mobile_answered_at timestamptz,
  bridged_at timestamptz,
  greeting_appended_at timestamptz,
  first_transcript_at timestamptz,
  talking_at timestamptz,
  ending_requested_at timestamptz,
  ended_at timestamptz,
  deadline_at timestamptz not null,

  latency_probe jsonb not null default '[]'::jsonb,
  cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  cleanup_next_attempt_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One demo at a time per organisation: the partial unique index is what makes
-- "one active attempt" a database fact rather than a read-then-write race
-- between two admin tabs.
create unique index if not exists ai_demo_attempts_one_active_idx
  on public.motorist_ai_demo_attempts (organization_id)
  where state not in ('ended', 'failed');

-- Replayed start requests must not dial twice.
create unique index if not exists ai_demo_attempts_request_idx
  on public.motorist_ai_demo_attempts (organization_id, actor_profile_id, request_id)
  where request_id is not null;

-- Provider identifiers arrive on webhooks before we have asked for them.
create unique index if not exists ai_demo_attempts_sip_cc_idx
  on public.motorist_ai_demo_attempts (telnyx_sip_call_control_id)
  where telnyx_sip_call_control_id is not null;
create unique index if not exists ai_demo_attempts_mobile_cc_idx
  on public.motorist_ai_demo_attempts (telnyx_mobile_call_control_id)
  where telnyx_mobile_call_control_id is not null;
create unique index if not exists ai_demo_attempts_openai_session_idx
  on public.motorist_ai_demo_attempts (openai_session_id)
  where openai_session_id is not null;

-- The cron sweep and the history list.
create index if not exists ai_demo_attempts_open_idx
  on public.motorist_ai_demo_attempts (organization_id, state, deadline_at)
  where state not in ('ended', 'failed');
create index if not exists ai_demo_attempts_recent_idx
  on public.motorist_ai_demo_attempts (organization_id, requested_at desc);

drop trigger if exists set_updated_at on public.motorist_ai_demo_attempts;
create trigger set_updated_at
  before update on public.motorist_ai_demo_attempts
  for each row
  execute function public.motorist_set_updated_at();

alter table public.motorist_ai_demo_attempts enable row level security;
revoke all on table public.motorist_ai_demo_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.motorist_ai_demo_attempts to service_role;

commit;
