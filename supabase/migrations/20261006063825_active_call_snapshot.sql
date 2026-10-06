-- Server-authorized, read-only call overview in one consistent database pass.
-- Activation is separate: TELEPHONY_ACTIVE_SNAPSHOT_V1_ENABLED remains off
-- until this exact migration is approved and verified on the target project.
create or replace function public.motorist_active_call_snapshot_v1(
  p_organization_id uuid, p_environment text
) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_result jsonb;
begin
  if p_organization_id is null or p_environment is null
    or p_environment not in ('production', 'development') then
    raise exception 'invalid_active_call_snapshot_scope' using errcode = '22023';
  end if;

  with active_sessions as materialized (
    select s.* from public.motorist_call_sessions s
    where s.organization_id = p_organization_id
      and s.state in ('received', 'greeting', 'ivr', 'ringing', 'talking', 'held',
        'consulting', 'conference', 'parked', 'waiting', 'after_hours', 'callback_offered')
  )
  select jsonb_build_object(
    'sessions', coalesce((select jsonb_agg(to_jsonb(s) order by s.started_at) from active_sessions s), '[]'::jsonb),
    'legs', coalesce((select jsonb_agg(to_jsonb(l)) from public.motorist_call_legs l
      join active_sessions s on s.id = l.session_id and s.organization_id = l.organization_id
      where l.ended_at is null), '[]'::jsonb),
    'attempts', coalesce((select jsonb_agg(to_jsonb(a)) from public.motorist_ring_attempts a
      join active_sessions s on s.id = a.session_id and s.organization_id = a.organization_id
      where a.result = 'offered'), '[]'::jsonb),
    'presence', coalesce((select jsonb_agg(to_jsonb(p)) from public.motorist_operator_presence p
      where p.organization_id = p_organization_id), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(to_jsonb(d)) from public.motorist_operator_devices d
      where d.organization_id = p_organization_id and d.environment = p_environment), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(to_jsonb(l)) from public.motorist_telephony_lines l
      where l.organization_id = p_organization_id), '[]'::jsonb),
    'operatorSettings', coalesce((select jsonb_agg(to_jsonb(o)) from public.motorist_operator_telephony_settings o
      where o.organization_id = p_organization_id), '[]'::jsonb),
    'callRows', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'session_id', c.session_id))
      from public.motorist_calls c join active_sessions s on s.id = c.session_id and s.organization_id = c.organization_id), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.motorist_active_call_snapshot_v1(uuid,text) from public, anon, authenticated;
grant execute on function public.motorist_active_call_snapshot_v1(uuid,text) to service_role;
comment on function public.motorist_active_call_snapshot_v1(uuid,text) is
  'Authorized server-only organization/environment call overview. Read-only; does not claim calls, sweep, change recording or issue provider commands.';
