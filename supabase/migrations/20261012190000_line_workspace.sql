-- Unified line properties and finite internal routing. No saved routes or provider resources are changed by applying this migration.
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
    'profiles', (select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'display_name',t.display_name,'role',t.role,'active',t.active,'access_status',t.access_status) order by display_name, id), '[]'::jsonb) from public.motorist_profiles t where t.organization_id = p_organization_id and t.kind = 'human'),
    'operatorSettings', (select coalesce(jsonb_agg(to_jsonb(t) order by profile_id), '[]'::jsonb) from public.motorist_operator_telephony_settings t where t.organization_id = p_organization_id),
    'devices', (select coalesce(jsonb_agg(to_jsonb(t) order by profile_id), '[]'::jsonb) from public.motorist_operator_devices t where t.organization_id = p_organization_id),
    'settings', (select to_jsonb(t) from public.motorist_telephony_settings t where t.organization_id = p_organization_id)
    ) as body
  )
  select body || jsonb_build_object('snapshotId', md5((body - 'devices' - 'presence' - 'operatorSettings')::text), 'atomicIncomingLineModes', true,
    'lineWorkspace', true, 'unifiedIncomingFlow', exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.motorist_ring_attempts'::regclass and attname = 'application_device' and not attisdropped)) from snapshot;
$$;
revoke all on function public.motorist_routing_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.motorist_routing_snapshot(uuid) to service_role;

create or replace function public.motorist_save_line_workspace(
  p_organization_id uuid, p_changes jsonb, p_expected_version integer, p_expected_snapshot_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_change jsonb;
  v_step jsonb;
  v_person jsonb;
  v_line public.motorist_telephony_lines%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_version integer;
  v_changed boolean := false;
begin
  if p_organization_id is null or p_expected_version is null or p_expected_version < 0
     or p_expected_snapshot_id is null or p_expected_snapshot_id !~ '^[0-9a-f]{32}$' then
    raise exception 'organization_and_version_required';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'incoming_flow_invalid'; end if;
  if jsonb_array_length(p_changes) not between 1 and 200 then raise exception 'incoming_flow_invalid'; end if;
  for v_change in select value from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(v_change) is distinct from 'object'
       or not (v_change ?& array['id','flow','expected_flow'])
       or (v_change - 'id' - 'flow' - 'expected_flow' - 'patch') <> '{}'::jsonb
       or jsonb_typeof(v_change -> 'id') is distinct from 'string'
       or (v_change ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_change -> 'flow') not in ('object','null')
       or jsonb_typeof(coalesce(v_change -> 'patch','{}'::jsonb)) is distinct from 'object'
       or (coalesce(v_change -> 'patch','{}'::jsonb) - 'label' - 'partnerName' - 'active' - 'businessHoursId' - 'environment' - 'returnLineId' - 'ringPlanId' - 'ivrMenuId' - 'inboundCallMode') <> '{}'::jsonb
       or (jsonb_typeof(v_change -> 'expected_flow') not in ('object','null')) then
      raise exception 'incoming_flow_invalid';
    end if;
    if v_change -> 'flow' <> 'null'::jsonb and (
       (v_change -> 'flow' -> 'version') is distinct from '1'::jsonb
       or jsonb_typeof(v_change -> 'flow' -> 'steps') is distinct from 'array'
       or jsonb_array_length(v_change -> 'flow' -> 'steps') not between 1 and 20
       or coalesce(v_change -> 'flow' ->> 'ending','') not in ('hangup_message','callback_prompt','hangup')
       or ((v_change -> 'flow') - 'version' - 'steps' - 'ending') <> '{}'::jsonb) then
      raise exception 'incoming_flow_invalid';
    end if;
  end loop;
  if (select count(*) <> count(distinct (value ->> 'id')::uuid) from jsonb_array_elements(p_changes)) then raise exception 'incoming_flow_invalid'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_organization_id::text));
  -- Preferences are excluded from the public snapshot hash. A short SHARE
  -- lock covers both edits and new preference inserts while ownership is
  -- rechecked. Calls and presence do not write this configuration table.
  perform pg_catalog.set_config('lock_timeout', '3s', true);
  lock table public.motorist_operator_telephony_settings in share mode;
  lock table public.motorist_telephony_lines in share row exclusive mode;
  -- Same order as motorist_save_incoming_routing: selected lines, then settings.
  for v_change in select value from jsonb_array_elements(p_changes) order by (value ->> 'id')::uuid loop
    select * into v_line from public.motorist_telephony_lines
      where organization_id = p_organization_id and id = (v_change ->> 'id')::uuid for update;
    if not found or (
      jsonb_typeof(v_line.metadata -> 'archived_at') = 'string' and btrim(v_line.metadata ->> 'archived_at') <> ''
    ) then raise exception 'incoming_line_not_found'; end if;
    if v_change -> 'flow' <> 'null'::jsonb and (v_line.ivr_menu_id is not null
       or nullif(v_line.metadata ->> 'return_line_id','') is not null
       or exists (select 1 from public.motorist_telephony_lines other where other.organization_id = p_organization_id and other.metadata ->> 'return_line_id' = v_line.id::text)) then
      raise exception 'incoming_route_changed';
    end if;
    if coalesce(v_line.metadata -> 'incoming_flow', 'null'::jsonb) is distinct from v_change -> 'expected_flow' then raise exception 'flow_conflict'; end if;
    if v_change -> 'patch' ? 'label' and (jsonb_typeof(v_change -> 'patch' -> 'label') <> 'string' or length(btrim(v_change -> 'patch' ->> 'label')) not between 1 and 180) then raise exception 'incoming_flow_invalid'; end if;
    if v_change -> 'patch' ? 'partnerName' and (jsonb_typeof(v_change -> 'patch' -> 'partnerName') not in ('string','null') or length(v_change -> 'patch' ->> 'partnerName') > 180) then raise exception 'incoming_flow_invalid'; end if;
    if v_change -> 'patch' ? 'active' and jsonb_typeof(v_change -> 'patch' -> 'active') <> 'boolean' then raise exception 'incoming_flow_invalid'; end if;
    if v_change -> 'patch' ? 'environment' and coalesce(v_change -> 'patch' ->> 'environment','') not in ('production','development') then raise exception 'incoming_flow_invalid'; end if;
    if v_line.metadata -> 'incoming_flow' <> 'null'::jsonb and v_change -> 'patch' ?| array['returnLineId','ringPlanId','ivrMenuId','inboundCallMode'] then raise exception 'incoming_route_changed'; end if;
    if v_change -> 'patch' ? 'inboundCallMode' and v_change -> 'patch' ->> 'inboundCallMode' is not null and v_change -> 'patch' ->> 'inboundCallMode' not in ('ring_first','ring_all','ring_ordered','queue_first') then raise exception 'incoming_flow_invalid'; end if;
    if v_change -> 'patch' ? 'ringPlanId' and v_change -> 'patch' ->> 'ringPlanId' is not null then
      perform 1 from public.motorist_ring_plans where organization_id=p_organization_id and id=(v_change -> 'patch' ->> 'ringPlanId')::uuid;
      if not found then raise exception 'incoming_flow_invalid'; end if;
    end if;
    if v_change -> 'patch' ? 'ivrMenuId' and v_change -> 'patch' ->> 'ivrMenuId' is not null then
      perform 1 from public.motorist_ivr_menus where organization_id=p_organization_id and id=(v_change -> 'patch' ->> 'ivrMenuId')::uuid;
      if not found then raise exception 'incoming_flow_invalid'; end if;
    end if;
    if v_change -> 'patch' ? 'businessHoursId'  and v_change -> 'patch' ->> 'businessHoursId' is not null then
      perform 1 from public.motorist_business_hours where organization_id = p_organization_id and id = (v_change -> 'patch' ->> 'businessHoursId')::uuid;
      if not found then raise exception 'incoming_flow_invalid'; end if;
    end if;
    for v_step in select value from jsonb_array_elements(case when v_change -> 'flow' = 'null'::jsonb then '[]'::jsonb else v_change -> 'flow' -> 'steps' end) loop
      if jsonb_typeof(v_step) is distinct from 'object'
         or coalesce(v_step ->> 'type','') not in ('ring','wait','repeat','external','line') then raise exception 'incoming_flow_invalid'; end if;
      if v_step ->> 'type' = 'line' then
        if jsonb_typeof(v_step -> 'lineId') is distinct from 'string'
           or (v_step ->> 'lineId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or v_step is distinct from (v_change -> 'flow' -> 'steps' -> (jsonb_array_length(v_change -> 'flow' -> 'steps') - 1)) then raise exception 'incoming_flow_invalid'; end if;
      end if;
      if v_step ->> 'type' = 'ring' then
        if jsonb_typeof(v_step -> 'people') is distinct from 'array' then raise exception 'incoming_flow_invalid'; end if;
        if jsonb_array_length(v_step -> 'people') not between 1 and 20 then raise exception 'incoming_flow_invalid'; end if;
        for v_person in select value from jsonb_array_elements(v_step -> 'people') loop
          if jsonb_typeof(v_person -> 'profileId') is distinct from 'string'
             or (v_person ->> 'profileId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'incoming_profile_invalid'; end if;
          perform 1 from public.motorist_profiles p where p.organization_id = p_organization_id
            and p.id = (v_person ->> 'profileId')::uuid and p.active and p.access_status = 'active'
            and p.kind = 'human' and p.role in ('dispatcher','senior_dispatcher','manager','admin') for key share;
          if not found then raise exception 'incoming_profile_invalid'; end if;
          if v_person ->> 'personalNumber' is not null and exists (
            select 1 from public.motorist_operator_telephony_settings prefs
            where prefs.organization_id = p_organization_id
              and prefs.profile_id <> (v_person ->> 'profileId')::uuid
              and prefs.default_mobile_number = v_person ->> 'personalNumber'
          ) then raise exception 'incoming_number_owner_conflict'; end if;
        end loop;
      end if;
    end loop;
  end loop;
  select routing_version into v_version from public.motorist_telephony_settings
    where organization_id = p_organization_id for update;
  if not found or v_version <> p_expected_version then raise exception 'stale_document'; end if;
  v_before := public.motorist_routing_snapshot(p_organization_id);
  if v_before ->> 'snapshotId' is distinct from p_expected_snapshot_id then raise exception 'stale_document'; end if;

  for v_change in select value from jsonb_array_elements(p_changes) loop
    if (v_change -> 'flow' <> 'null'::jsonb and v_change -> 'flow' is distinct from v_change -> 'expected_flow') or coalesce(v_change -> 'patch','{}'::jsonb) <> '{}'::jsonb then
      update public.motorist_telephony_lines set
        metadata = (case when jsonb_typeof(metadata) = 'object' then metadata else '{}'::jsonb end)
          || case when v_change -> 'flow' = 'null'::jsonb then '{}'::jsonb else jsonb_build_object('incoming_flow', v_change -> 'flow') end
          || case when v_change -> 'patch' ? 'returnLineId' then jsonb_build_object('return_line_id', v_change -> 'patch' -> 'returnLineId') else '{}'::jsonb end
          || case when v_change -> 'patch' ? 'inboundCallMode' then jsonb_build_object('inbound_call_mode', v_change -> 'patch' -> 'inboundCallMode') else '{}'::jsonb end,
        label = case when v_change -> 'patch' ? 'label' then btrim(v_change -> 'patch' ->> 'label') else label end,
        partner_name = case when v_change -> 'patch' ? 'partnerName' then nullif(btrim(v_change -> 'patch' ->> 'partnerName'),'') else partner_name end,
        active = case when v_change -> 'patch' ? 'active' then (v_change -> 'patch' ->> 'active')::boolean else active end,
        environment = case when v_change -> 'patch' ? 'environment' then v_change -> 'patch' ->> 'environment' else environment end,
        ring_plan_id = case when v_change -> 'patch' ? 'ringPlanId' then (v_change -> 'patch' ->> 'ringPlanId')::uuid else ring_plan_id end,
        ivr_menu_id = case when v_change -> 'patch' ? 'ivrMenuId' then (v_change -> 'patch' ->> 'ivrMenuId')::uuid else ivr_menu_id end,
        business_hours_id = case when v_change -> 'patch' ? 'businessHoursId' then (v_change -> 'patch' ->> 'businessHoursId')::uuid else business_hours_id end,
        updated_at = clock_timestamp()
      where organization_id = p_organization_id and id = (v_change ->> 'id')::uuid;
      v_changed := true;
    end if;
  end loop;
  -- Validate the final graph under the configuration lock, including changes
  -- to a destination's active flag/environment in this same transaction.
  if exists (
    select 1 from public.motorist_telephony_lines src
    cross join lateral jsonb_array_elements(coalesce(src.metadata -> 'incoming_flow' -> 'steps','[]'::jsonb)) step
    left join public.motorist_telephony_lines dst on dst.id = (step ->> 'lineId')::uuid and dst.organization_id = p_organization_id
    where src.organization_id = p_organization_id and step ->> 'type' = 'line'
      and (dst.id is null or not dst.active or dst.environment <> src.environment or dst.ivr_menu_id is not null
        or nullif(btrim(dst.metadata ->> 'archived_at'),'') is not null)
  ) then raise exception 'incoming_line_target_invalid'; end if;
  if exists (
    with recursive edges as (
      select src.id as source, (step ->> 'lineId')::uuid as target from public.motorist_telephony_lines src
      cross join lateral jsonb_array_elements(coalesce(src.metadata -> 'incoming_flow' -> 'steps','[]'::jsonb)) step
      where src.organization_id = p_organization_id and step ->> 'type' = 'line'
      union all
      select id, (metadata ->> 'return_line_id')::uuid from public.motorist_telephony_lines
      where organization_id = p_organization_id and nullif(metadata ->> 'return_line_id','') is not null
    ), walk(node,path,cycle) as (
      select target,array[source,target],source=target from edges
      union all select e.target,w.path || e.target,e.target=any(w.path) from walk w join edges e on e.source=w.node
      where not w.cycle and cardinality(w.path) <= 8
    ) select 1 from walk where cycle or cardinality(path)>8
  ) then raise exception 'incoming_line_loop'; end if;
  if v_changed then
    update public.motorist_telephony_settings set routing_version = routing_version + 1
      where organization_id = p_organization_id;
  end if;
  v_after := public.motorist_routing_snapshot(p_organization_id);
  return jsonb_build_object('before', v_before, 'after', v_after);
end;
$$;
revoke all on function public.motorist_save_line_workspace(uuid,jsonb,integer,text) from public, anon, authenticated;
grant execute on function public.motorist_save_line_workspace(uuid,jsonb,integer,text) to service_role;
-- One bounded read for all numbers in an active snapshot or history page.
-- Contact names are labels only; this does not change caller/case proof.
create or replace function public.motorist_resolve_call_contacts(p_organization_id uuid, p_numbers text[])
returns table(number text, name text) language sql stable security definer set search_path = '' as $$
  with entries as (
    select c.name, c.phone, 0 as priority from public.motorist_contacts c where c.organization_id=p_organization_id
    union all
    select c.name, c.phone, 1 from public.motorist_partner_directory c where c.organization_id=p_organization_id and c.active
    union all
    select c.name, c.phone, 2 from public.motorist_branches c where c.organization_id=p_organization_id and c.active
  ), digits as (
    select e.name, e.priority, regexp_replace(e.phone, '[^0-9]', '', 'g') as phone from entries e
  ), normalized as (
    select d.name, d.priority, case when d.phone like '00%' then substr(d.phone,3)
      when d.phone like '0%' then '421'||substr(d.phone,2) else d.phone end as number from digits d
  )
  select distinct on (n.number) n.number, btrim(n.name) from normalized n
    where n.number=any(p_numbers) and btrim(n.name)<>'' and cardinality(p_numbers) between 1 and 200
    order by n.number,n.priority,n.name;
$$;
revoke all on function public.motorist_resolve_call_contacts(uuid,text[]) from public, anon, authenticated;
grant execute on function public.motorist_resolve_call_contacts(uuid,text[]) to service_role;
commit;
