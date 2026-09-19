-- Additive coherent read and combined save. Apply only to this Telnyx copy after explicit authorization.
-- Service-role only: API routes authenticate, scope organization, then redact.
-- This SQL function is ONE statement; all subqueries share its MVCC snapshot.
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
  select body || jsonb_build_object('snapshotId', md5((body - 'devices' - 'presence' - 'operatorSettings')::text)) from snapshot;
$$;
revoke all on function public.motorist_routing_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.motorist_routing_snapshot(uuid) to service_role;

-- Read back inside the writer's transaction. A later manager's commit must not
-- be attributed to this actor by the API's audit diff or save acknowledgement.
create or replace function public.motorist_save_incoming_routing(
  p_organization_id uuid, p_document jsonb, p_expected_version integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after jsonb;
begin
  if p_organization_id is null or p_expected_version is null then
    raise exception 'organization_and_version_required';
  end if;
  if jsonb_typeof(p_document -> 'groups') is distinct from 'array'
     or jsonb_typeof(p_document -> 'plans') is distinct from 'array'
     or (p_document - 'groups' - 'plans') <> '{}'::jsonb then
    raise exception 'incoming_sections_required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_organization_id::text));
  v_before := public.motorist_routing_snapshot(p_organization_id);
  perform public.motorist_replace_ring_plan(p_organization_id, p_document, p_expected_version);
  v_after := public.motorist_routing_snapshot(p_organization_id);
  return jsonb_build_object('before', v_before, 'after', v_after);
end;
$$;
revoke all on function public.motorist_save_incoming_routing(uuid,jsonb,integer) from public, anon, authenticated;
grant execute on function public.motorist_save_incoming_routing(uuid,jsonb,integer) to service_role;
