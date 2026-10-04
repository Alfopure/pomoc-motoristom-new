-- Additive API capability and transactional line-mode updates for the incoming editor.
-- Apply only to an explicitly authorized project. No stored routing is changed.
begin;

create or replace function public.motorist_routing_snapshot(p_organization_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with snapshot as (
    select jsonb_build_object(
    'groups', (select coalesce(jsonb_agg(to_jsonb(t) order by name, id), '[]'::jsonb) from public.motorist_ring_groups t where t.organization_id = p_organization_id),
    'members', (select coalesce(jsonb_agg(to_jsonb(t) order by ring_group_id, position, id), '[]'::jsonb) from public.motorist_ring_group_members t where t.organization_id = p_organization_id),
    'plans', (select coalesce(jsonb_agg(to_jsonb(t) order by name, id), '[]'::jsonb) from public.motorist_ring_plans t where t.organization_id = p_organization_id),
    'steps', (select coalesce(jsonb_agg(to_jsonb(t) order by ring_plan_id, step_index, id), '[]'::jsonb) from public.motorist_ring_plan_steps t where t.organization_id = p_organization_id),
    'hours', (select coalesce(jsonb_agg(to_jsonb(t) order by name, id), '[]'::jsonb) from public.motorist_business_hours t where t.organization_id = p_organization_id),
    'intervals', (select coalesce(jsonb_agg(to_jsonb(t) order by business_hours_id, weekday, opens), '[]'::jsonb) from public.motorist_business_hours_intervals t where t.organization_id = p_organization_id),
    'exceptions', (select coalesce(jsonb_agg(to_jsonb(t) order by business_hours_id, date), '[]'::jsonb) from public.motorist_business_hours_exceptions t where t.organization_id = p_organization_id),
    'pauseReasons', (select coalesce(jsonb_agg(to_jsonb(t) order by sort_order, id), '[]'::jsonb) from public.motorist_pause_reasons t where t.organization_id = p_organization_id),
    'presence', (select coalesce(jsonb_agg(jsonb_build_object('pause_reason_id', t.pause_reason_id) order by profile_id), '[]'::jsonb) from public.motorist_operator_presence t where t.organization_id = p_organization_id),
    'lines', (select coalesce(jsonb_agg(to_jsonb(t) order by phone_number, id), '[]'::jsonb) from public.motorist_telephony_lines t where t.organization_id = p_organization_id),
    'ivrMenus', (select coalesce(jsonb_agg(to_jsonb(t) order by name, id), '[]'::jsonb) from public.motorist_ivr_menus t where t.organization_id = p_organization_id),
    'ivrOptions', (select coalesce(jsonb_agg(to_jsonb(t) order by ivr_menu_id, digit, id), '[]'::jsonb) from public.motorist_ivr_options t where t.organization_id = p_organization_id),
    'profiles', (select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'display_name',t.display_name,'role',t.role,'active',t.active,'access_status',t.access_status) order by display_name, id), '[]'::jsonb) from public.motorist_profiles t where t.organization_id = p_organization_id),
    'operatorSettings', (select coalesce(jsonb_agg(to_jsonb(t) order by profile_id), '[]'::jsonb) from public.motorist_operator_telephony_settings t where t.organization_id = p_organization_id),
    'devices', (select coalesce(jsonb_agg(to_jsonb(t) order by profile_id), '[]'::jsonb) from public.motorist_operator_devices t where t.organization_id = p_organization_id),
    'settings', (select to_jsonb(t) from public.motorist_telephony_settings t where t.organization_id = p_organization_id)
    ) as body
  )
  select body || jsonb_build_object('snapshotId', md5((body - 'devices' - 'presence' - 'operatorSettings')::text), 'atomicIncomingLineModes', true) from snapshot;
$$;
revoke all on function public.motorist_routing_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.motorist_routing_snapshot(uuid) to service_role;

-- Old clients may continue to submit groups/plans without line_modes.
-- Changed line rows use row locks plus mode CAS: legacy line PATCH writes do
-- not increment routing_version, but already compare metadata + updated_at.
create or replace function public.motorist_save_incoming_routing(
  p_organization_id uuid, p_document jsonb, p_expected_version integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_changes jsonb := coalesce(p_document -> 'line_modes', '[]'::jsonb);
  v_change jsonb;
  v_line public.motorist_telephony_lines%rowtype;
  v_mode text;
begin
  if p_organization_id is null or p_expected_version is null then
    raise exception 'organization_and_version_required';
  end if;
  if jsonb_typeof(p_document -> 'groups') is distinct from 'array'
     or jsonb_typeof(p_document -> 'plans') is distinct from 'array'
     or (p_document - 'groups' - 'plans' - 'line_modes') <> '{}'::jsonb then
    raise exception 'incoming_sections_required';
  end if;
  if jsonb_typeof(v_changes) is distinct from 'array' then
    raise exception 'incoming_line_mode_invalid';
  end if;
  if jsonb_array_length(v_changes) > 200 then
    raise exception 'incoming_line_mode_invalid';
  end if;
  for v_change in select value from jsonb_array_elements(v_changes) loop
    if jsonb_typeof(v_change) is distinct from 'object'
       or not (v_change ?& array['id', 'inbound_call_mode', 'expected_inbound_call_mode'])
       or (v_change - 'id' - 'inbound_call_mode' - 'expected_inbound_call_mode') <> '{}'::jsonb
       or jsonb_typeof(v_change -> 'id') is distinct from 'string'
       or (v_change ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (v_change -> 'inbound_call_mode') not in ('null'::jsonb, '"ring_first"'::jsonb, '"ring_all"'::jsonb, '"ring_ordered"'::jsonb, '"queue_first"'::jsonb)
       or (v_change -> 'expected_inbound_call_mode') not in ('null'::jsonb, '"ring_first"'::jsonb, '"ring_all"'::jsonb, '"ring_ordered"'::jsonb, '"queue_first"'::jsonb) then
      raise exception 'incoming_line_mode_invalid';
    end if;
  end loop;
  if (select count(*) <> count(distinct (value ->> 'id')::uuid) from jsonb_array_elements(v_changes)) then
    raise exception 'incoming_line_mode_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_organization_id::text));
  -- Deterministic row ordering avoids cycles between combined saves.
  for v_change in select value from jsonb_array_elements(v_changes) order by (value ->> 'id')::uuid loop
    select * into v_line from public.motorist_telephony_lines
      where organization_id = p_organization_id and id = (v_change ->> 'id')::uuid for update;
    if not found or (
      jsonb_typeof(v_line.metadata -> 'archived_at') = 'string'
      and btrim(v_line.metadata ->> 'archived_at') <> ''
    ) then
      raise exception 'incoming_line_not_found';
    end if;
    -- Match the read model: absent, null and unsupported legacy values inherit.
    v_mode := case when v_line.metadata ->> 'inbound_call_mode' in ('ring_first', 'ring_all', 'ring_ordered', 'queue_first')
      then v_line.metadata ->> 'inbound_call_mode' else null end;
    if v_mode is distinct from (v_change ->> 'expected_inbound_call_mode') then
      raise exception 'line_mode_conflict';
    end if;
  end loop;

  v_before := public.motorist_routing_snapshot(p_organization_id);
  perform public.motorist_replace_ring_plan(p_organization_id, p_document - 'line_modes', p_expected_version);
  -- Preserve all unrelated metadata; a failure anywhere rolls back every section.
  update public.motorist_telephony_lines l set
    metadata = (case when jsonb_typeof(l.metadata) = 'object' then l.metadata else '{}'::jsonb end)
      || jsonb_build_object('inbound_call_mode', change -> 'inbound_call_mode'),
    updated_at = clock_timestamp()
  from jsonb_array_elements(v_changes) change
  where l.organization_id = p_organization_id and l.id = (change ->> 'id')::uuid;
  v_after := public.motorist_routing_snapshot(p_organization_id);
  return jsonb_build_object('before', v_before, 'after', v_after);
end;
$$;
revoke all on function public.motorist_save_incoming_routing(uuid,jsonb,integer) from public, anon, authenticated;
grant execute on function public.motorist_save_incoming_routing(uuid,jsonb,integer) to service_role;

commit;
