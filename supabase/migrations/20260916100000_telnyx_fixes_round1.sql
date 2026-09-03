-- Phase 2 review fixes, round 1.
--
-- 1. `motorist_reserve_operator` becomes re-entrant for the session that already
--    holds the reservation (a lost `version` compare-and-set makes the runner
--    re-run the guard; a second `false` there hung up the leg that answered).
-- 2. `motorist_telephony_usage_add` so the effects layer can count billable legs
--    and SMS against `motorist_telephony_settings.daily_leg_soft_cap`.
-- 3. `motorist_telephony_lines.phone_number` is normalised to E.164 on write, so
--    the inbound line lookup cannot silently miss.
-- 4. Incident anchor for the capacity guard.
--
-- Re-runnable; all statements are idempotent.

-- ---------------------------------------------------------------------------
-- 1. Re-entrant operator reservation
-- ---------------------------------------------------------------------------

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

revoke all on function public.motorist_reserve_operator(uuid, uuid) from public, anon, authenticated;
grant execute on function public.motorist_reserve_operator(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Daily usage counter (spend cap input)
-- ---------------------------------------------------------------------------

create or replace function public.motorist_telephony_usage_add(
  p_organization_id uuid,
  p_day date,
  p_legs integer default 0,
  p_minutes numeric default 0,
  p_sms integer default 0
)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.motorist_telephony_daily_usage (organization_id, day, legs, minutes, sms_count)
  values (p_organization_id, p_day, greatest(0, coalesce(p_legs, 0)), greatest(0, coalesce(p_minutes, 0)), greatest(0, coalesce(p_sms, 0)))
  on conflict (organization_id, day) do update
  set
    legs = public.motorist_telephony_daily_usage.legs + greatest(0, coalesce(p_legs, 0)),
    minutes = public.motorist_telephony_daily_usage.minutes + greatest(0, coalesce(p_minutes, 0)),
    sms_count = public.motorist_telephony_daily_usage.sms_count + greatest(0, coalesce(p_sms, 0)),
    updated_at = pg_catalog.now()
  returning legs;
$$;

revoke all on function public.motorist_telephony_usage_add(uuid, date, integer, numeric, integer) from public, anon, authenticated;
grant execute on function public.motorist_telephony_usage_add(uuid, date, integer, numeric, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. E.164 normalisation of telephony line numbers
-- ---------------------------------------------------------------------------

create or replace function app_private.motorist_normalize_e164(p_value text, p_default_cc text default '421')
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_digits text;
  v_plus boolean;
  v_intl text;
  v_cc text;
  v_national text;
begin
  if p_value is null then
    return null;
  end if;

  v_plus := pg_catalog.left(pg_catalog.btrim(p_value), 1) = '+';
  v_digits := pg_catalog.regexp_replace(p_value, '[^0-9]', '', 'g');
  if v_digits = '' then
    return p_value;
  end if;

  if v_plus then
    v_intl := v_digits;
  elsif pg_catalog.left(v_digits, 2) = '00' then
    v_intl := pg_catalog.substr(v_digits, 3);
  elsif pg_catalog.left(v_digits, 1) = '0' then
    v_intl := p_default_cc || pg_catalog.substr(v_digits, 2);
  elsif pg_catalog.length(v_digits) = 9 and p_default_cc = '421' then
    v_intl := p_default_cc || v_digits;
  else
    v_intl := v_digits;
  end if;

  -- Drop a national trunk zero kept after the country code (Telnyx reports the
  -- first Bratislava DID as +4210232408700).
  foreach v_cc in array array['421', '420', '43', '49', '36', '48', '44', '33', '31', '32', '40', '385', '386', '380', '375', '370', '371'] loop
    if pg_catalog.left(v_intl, pg_catalog.length(v_cc)) = v_cc then
      v_national := pg_catalog.substr(v_intl, pg_catalog.length(v_cc) + 1);
      if pg_catalog.left(v_national, 1) = '0' and pg_catalog.left(v_national, 2) <> '00' then
        v_intl := v_cc || pg_catalog.substr(v_national, 2);
      end if;
      exit;
    end if;
  end loop;

  if pg_catalog.length(v_intl) < 8 or pg_catalog.length(v_intl) > 15 then
    return p_value;
  end if;
  return '+' || v_intl;
end;
$$;

revoke all on function app_private.motorist_normalize_e164(text, text) from public, anon, authenticated;

create or replace function app_private.motorist_telephony_line_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.phone_number := app_private.motorist_normalize_e164(new.phone_number);
  return new;
end;
$$;

drop trigger if exists motorist_telephony_lines_normalize on public.motorist_telephony_lines;
create trigger motorist_telephony_lines_normalize
  before insert or update of phone_number on public.motorist_telephony_lines
  for each row execute function app_private.motorist_telephony_line_normalize();

-- Backfill, skipping rows whose canonical form is already taken by another line
-- of the same organisation (telephony_lines_org_number_idx); such a duplicate is
-- a configuration error to fix by hand, not something a migration should fail on.
update public.motorist_telephony_lines as l
set phone_number = app_private.motorist_normalize_e164(l.phone_number)
where l.phone_number is distinct from app_private.motorist_normalize_e164(l.phone_number)
  and not exists (
    select 1
    from public.motorist_telephony_lines as other
    where other.organization_id = l.organization_id
      and other.id <> l.id
      and other.phone_number = app_private.motorist_normalize_e164(l.phone_number)
  );

-- ---------------------------------------------------------------------------
-- 4. Incident anchor for the concurrent-leg capacity guard
-- ---------------------------------------------------------------------------

insert into public.motorist_job_controls (job_name, enabled)
values ('telephony.routing.capacity', false)
on conflict (job_name) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Claim ledger: return the claim stamp so the release can be scoped to it
-- ---------------------------------------------------------------------------

drop function if exists public.motorist_telnyx_claim_webhook_event(text, text, jsonb, uuid, text, text, text, text, timestamptz, integer);

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

revoke all on function public.motorist_telnyx_claim_webhook_event(text, text, jsonb, uuid, text, text, text, text, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.motorist_telnyx_claim_webhook_event(text, text, jsonb, uuid, text, text, text, text, timestamptz, integer)
  to service_role;
