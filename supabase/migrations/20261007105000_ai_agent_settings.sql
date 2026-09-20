-- How the assistant behaves, in one row per organisation.
--
-- Everything here is off by default. A deployment that runs this migration and
-- nothing else has an assistant that cannot read a case, cannot write one and
-- cannot send a message — which is the only safe state for a switch nobody has
-- looked at yet.
--
-- What is deliberately NOT here: when she picks up. That is the ring plan's
-- job and duplicating it would give two places to set one thing. Nor the line
-- she is reached on: `motorist_operator_telephony_settings` already owns that
-- for every operator, and she is an operator.

begin;

create table if not exists public.motorist_ai_agent_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.motorist_organizations(id) on delete cascade,

  -- The profile she signs her work with. Null until someone creates it.
  profile_id uuid references public.motorist_profiles(id) on delete set null,

  -- Identity. The name is hers to change; the voice decides the grammatical
  -- gender of how she describes herself, so the two belong together.
  display_name text not null default 'Veronika',
  voice text not null default 'gleam',
  intro_style text not null default 'expert_helper'
    check (intro_style in ('expert_helper', 'assistant', 'custom')),
  intro_custom text,

  -- Appended to the voice prompt on every call. The cap is asserted in
  -- agent-settings.test.ts, not here: a CHECK cannot know how much room the rest
  -- of the prompt is using this week.
  standing_rules text,

  -- Permissions. Each one is read by the server before a tool is registered,
  -- so an unchecked box means the model never sees the tool at all.
  reads_caller_cases boolean not null default false,
  requires_plate_check boolean not null default true,
  creates_draft_cases boolean not null default false,
  adds_case_notes boolean not null default false,

  sms_enabled boolean not null default false,
  sms_max_per_call integer not null default 1 check (sms_max_per_call between 1 and 3),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint motorist_ai_agent_settings_intro_custom_check
    check (intro_style <> 'custom' or (intro_custom is not null and length(intro_custom) between 1 and 60)),
  constraint motorist_ai_agent_settings_display_name_check
    check (length(display_name) between 2 and 20),
  constraint motorist_ai_agent_settings_standing_rules_check
    check (standing_rules is null or length(standing_rules) <= 600)
);

comment on table public.motorist_ai_agent_settings is
  'One row per organisation. Every permission defaults to false; an unset switch means the tool is never registered with the model.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.motorist_ai_agent_settings'::regclass
      and tgname = 'motorist_ai_agent_settings_touch'
  ) then
    create trigger motorist_ai_agent_settings_touch
      before update on public.motorist_ai_agent_settings
      for each row execute function public.motorist_set_updated_at();
  end if;
end $$;

alter table public.motorist_ai_agent_settings enable row level security;

commit;
