begin;

alter table public.motorist_call_sessions
  add column if not exists pending_effects jsonb,
  add column if not exists effects_next_attempt_at timestamptz;

create index if not exists motorist_sessions_pending_effects_idx
  on public.motorist_call_sessions (organization_id, effects_next_attempt_at, id)
  where pending_effects is not null;

create index if not exists motorist_sessions_cancelled_offers_idx
  on public.motorist_call_sessions (organization_id, cancellations_next_attempt_at, id)
  where cancellations_next_attempt_at is not null;

-- The answer owner, chosen session transition and its remaining obligations
-- either all commit or all roll back. Provider commands happen after commit.
create or replace function public.motorist_stage_transition_v1(
  p_organization_id uuid,
  p_session_id uuid,
  p_expected_version integer,
  p_main jsonb,
  p_rejected jsonb default null,
  p_guard jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_session public.motorist_call_sessions%rowtype;
  v_patched public.motorist_call_sessions%rowtype;
  v_choice jsonb := p_main;
  v_reservation jsonb;
  v_entries jsonb;
begin
  select * into v_session from public.motorist_call_sessions
    where id = p_session_id and organization_id = p_organization_id for update;
  if not found then raise exception 'session not found'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(v_session.pending_effects->'entries', '[]'::jsonb)) e
      where e->>'id' = p_main->'entry'->>'id') then
    return jsonb_build_object('applied', true, 'session', to_jsonb(v_session));
  end if;
  if v_session.version is distinct from p_expected_version then
    return jsonb_build_object('applied', false);
  end if;
  if p_guard is not null and p_guard <> 'null'::jsonb then
    v_reservation := public.motorist_presence_transition_v1(
      p_organization_id, (p_guard->>'profileId')::uuid, 'answer', p_session_id,
      null, p_guard->>'offerToken');
    if not coalesce((v_reservation->>'applied')::boolean, false) then
      if p_rejected is null or p_rejected = 'null'::jsonb then raise exception 'missing rejected transition'; end if;
      v_choice := p_rejected;
    end if;
  end if;
  v_patched := jsonb_populate_record(v_session, v_choice->'sessionPatch');
  v_entries := coalesce(v_session.pending_effects->'entries', '[]'::jsonb) || jsonb_build_array(v_choice->'entry');
  update public.motorist_call_sessions set
    state = v_patched.state, line_id = v_patched.line_id, ring_plan_id = v_patched.ring_plan_id,
    current_step = v_patched.current_step, conference_id = v_patched.conference_id,
    conference_name = v_patched.conference_name, customer_leg_id = v_patched.customer_leg_id,
    answered_by_profile_id = v_patched.answered_by_profile_id, case_id = v_patched.case_id,
    caller_number = v_patched.caller_number, called_number = v_patched.called_number,
    answered_at = v_patched.answered_at, ended_at = v_patched.ended_at,
    hold_started_at = v_patched.hold_started_at, parked_at = v_patched.parked_at,
    metadata = v_patched.metadata, version = v_session.version + 1,
    pending_effects = jsonb_build_object('version', 1, 'entries', v_entries),
    effects_next_attempt_at = now()
    where id = p_session_id and organization_id = p_organization_id returning * into v_session;
  return jsonb_build_object('applied', true, 'session', to_jsonb(v_session));
end;
$$;

revoke all on function public.motorist_stage_transition_v1(uuid,uuid,integer,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.motorist_stage_transition_v1(uuid,uuid,integer,jsonb,jsonb,jsonb) to service_role;

commit;
