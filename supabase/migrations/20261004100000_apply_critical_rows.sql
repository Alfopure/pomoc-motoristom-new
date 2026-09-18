-- ---------------------------------------------------------------------------
-- The critical row writes of a transition, in one round trip
-- ---------------------------------------------------------------------------
-- The phase that holds the caller waiting for audio writes the session, then
-- looks up and updates each answered leg, then updates each ring attempt —
-- every one its own round trip, to a database that takes the same session lock
-- each time.
--
-- Presence is deliberately *not* here. Its guards read an application feature
-- flag and an operator's wrap-up setting, and deciding those in SQL would move
-- policy out of the reducer that owns it. This function writes rows and makes
-- no decision the caller was not already making.
--
-- Patching follows `motorist_stage_transition_v1`: `jsonb_populate_record`
-- over the existing row, so a key that is absent keeps its value and a key
-- that is present is applied with the column's own type.
--
-- Fenced by the ordinary triggers. The caller holds the lease and its headers
-- carry the token and generation, exactly as for the statements this replaces.

create or replace function public.motorist_apply_critical_v2(
  p_session_id uuid,
  p_expected_version integer,
  p_patch jsonb,
  p_legs jsonb,
  p_attempts jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_session public.motorist_call_sessions%rowtype;
  v_patched public.motorist_call_sessions%rowtype;
  v_leg public.motorist_call_legs%rowtype;
  v_leg_patched public.motorist_call_legs%rowtype;
  item jsonb;
  v_values jsonb;
begin
  select * into v_session from public.motorist_call_sessions where id = p_session_id for update;
  if not found then raise exception 'session not found'; end if;

  -- The same optimistic check the caller made: a loser writes nothing and is
  -- told so, rather than writing over the winner.
  if p_expected_version is not null and v_session.version is distinct from p_expected_version then
    return jsonb_build_object('applied', false);
  end if;

  if (p_patch is not null and p_patch <> '{}'::jsonb) or p_expected_version is not null then
    v_patched := jsonb_populate_record(v_session, coalesce(p_patch, '{}'::jsonb));
    update public.motorist_call_sessions set
      state = v_patched.state, line_id = v_patched.line_id, ring_plan_id = v_patched.ring_plan_id,
      current_step = v_patched.current_step, conference_id = v_patched.conference_id,
      conference_name = v_patched.conference_name, customer_leg_id = v_patched.customer_leg_id,
      answered_by_profile_id = v_patched.answered_by_profile_id, case_id = v_patched.case_id,
      caller_number = v_patched.caller_number, called_number = v_patched.called_number,
      answered_at = v_patched.answered_at, ended_at = v_patched.ended_at,
      hold_started_at = v_patched.hold_started_at, parked_at = v_patched.parked_at,
      metadata = v_patched.metadata,
      version = coalesce(p_expected_version, v_session.version) + 1
      where id = p_session_id returning * into v_session;
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_legs, '[]'::jsonb)) loop
    select * into v_leg from public.motorist_call_legs
      where session_id = p_session_id and telnyx_call_control_id = item->>'callControlId';
    if not found then continue; end if;
    v_values := coalesce(item->'values', '{}'::jsonb);
    -- A leg that has already ended keeps its ending: a late patch may add
    -- detail but must never reopen it.
    if v_leg.ended_at is not null and not (v_values ? 'ended_at') then
      v_values := v_values - 'state' - 'ended_at';
    end if;
    if v_values = '{}'::jsonb then continue; end if;
    v_leg_patched := jsonb_populate_record(v_leg, v_values);
    update public.motorist_call_legs set
      telnyx_call_leg_id = v_leg_patched.telnyx_call_leg_id, role = v_leg_patched.role,
      profile_id = v_leg_patched.profile_id, to_number = v_leg_patched.to_number,
      from_number = v_leg_patched.from_number, state = v_leg_patched.state,
      hangup_cause = v_leg_patched.hangup_cause, hangup_source = v_leg_patched.hangup_source,
      initiated_at = v_leg_patched.initiated_at, answered_at = v_leg_patched.answered_at,
      bridged_at = v_leg_patched.bridged_at, ended_at = v_leg_patched.ended_at,
      client_state = v_leg_patched.client_state, metadata = v_leg_patched.metadata
      where id = v_leg.id and session_id = p_session_id;
  end loop;

  for item in select * from jsonb_array_elements(coalesce(p_attempts, '[]'::jsonb)) loop
    update public.motorist_ring_attempts a set
      result = coalesce(item->'values'->>'result', a.result),
      ended_at = case when item->'values' ? 'ended_at' then (item->'values'->>'ended_at')::timestamptz else a.ended_at end,
      answered_at = case when item->'values' ? 'answered_at' then (item->'values'->>'answered_at')::timestamptz else a.answered_at end
      where a.id = (item->>'id')::uuid and a.session_id = p_session_id
        and (not coalesce((item->>'openOnly')::boolean, false) or a.ended_at is null);
  end loop;

  return jsonb_build_object('applied', true, 'session', to_jsonb(v_session));
end $function$;

revoke execute on function public.motorist_apply_critical_v2(uuid, integer, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.motorist_apply_critical_v2(uuid, integer, jsonb, jsonb, jsonb) to service_role;
