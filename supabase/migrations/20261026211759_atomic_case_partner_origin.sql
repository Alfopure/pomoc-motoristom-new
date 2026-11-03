begin;

-- A creation receipt outlives the browser request. No direct browser access.
create table public.motorist_case_creation_commands (
  organization_id uuid not null references public.motorist_organizations(id),
  command_id uuid not null,
  actor_id uuid not null references public.motorist_profiles(id),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, command_id)
);
alter table public.motorist_case_creation_commands enable row level security;
revoke all on public.motorist_case_creation_commands from public, anon, authenticated, service_role;
grant select, insert on public.motorist_case_creation_commands to service_role;

create function public.motorist_create_case_atomic(
  p_organization_id uuid, p_actor_id uuid, p_command_id uuid, p_fingerprint text,
  p_case_patch jsonb, p_related jsonb, p_event_body text, p_event_payload jsonb,
  p_partner_origin jsonb default null
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  actor public.motorist_profiles;
  prior public.motorist_case_creation_commands;
  saved public.motorist_cases;
  relation jsonb;
  patch jsonb;
  relation_table text;
  relation_field text;
  relation_id uuid;
  allowed text[];
  columns_sql text;
  prefix text;
  sequence_number bigint;
  next_number text;
  case_columns constant text[] := array['organization_id','case_number','status','priority','source_type','case_type','owner_id','contact_id','vehicle_id','pickup_location_id','destination_location_id','summary','main_note','selected_asset_id','customer_details','vehicle_details','incident_details','location_details','replacement_vehicle_details','payment_details','closure_details','attachments_metadata'];
begin
  select profile.* into actor from public.motorist_profiles profile
  join public.motorist_organizations org on org.id = profile.organization_id and org.active
  where profile.id = p_actor_id and profile.organization_id = p_organization_id and profile.active and profile.access_status = 'active'
    and profile.role in ('dispatcher','senior_dispatcher','manager','admin') for share of profile;
  if actor.id is null then raise insufficient_privilege; end if;
  if p_command_id is null or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid creation identity' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('case-create:' || p_organization_id::text || ':' || p_command_id::text, 0));
  select * into prior from public.motorist_case_creation_commands
    where organization_id = p_organization_id and command_id = p_command_id;
  if found then
    if prior.actor_id <> p_actor_id then raise insufficient_privilege; end if;
    if prior.fingerprint <> p_fingerprint then raise exception 'Creation content mismatch' using errcode = 'PT422'; end if;
    return prior.result;
  end if;
  if jsonb_typeof(p_case_patch) is distinct from 'object' or jsonb_typeof(p_related) is distinct from 'array'
    or jsonb_array_length(p_related) > 4 or octet_length(p_case_patch::text) > 262144
    or exists(select 1 from jsonb_object_keys(p_case_patch) keys(key) where not key = any(case_columns))
    or p_case_patch->>'organization_id' is distinct from p_organization_id::text
    or p_case_patch->>'owner_id' is distinct from p_actor_id::text
    or p_case_patch->>'status' is distinct from 'new'
    or coalesce(p_case_patch->>'case_number', '') !~ '^PM-[0-9]{4}-[0-9]{4,}$'
    or jsonb_typeof(p_event_payload) is distinct from 'object' then
    raise exception 'Invalid creation plan' using errcode = '22023';
  end if;

  for relation in select * from jsonb_array_elements(p_related) loop
    relation_table := relation->>'table'; relation_id := (relation->>'id')::uuid; patch := relation->'patch';
    case relation_table
      when 'motorist_contacts' then
        allowed := array['name','phone','email','role','notes']; relation_field := 'contact_id';
      when 'motorist_vehicles' then
        allowed := array['license_plate','vin','make','model','category','transmission','production_year','color','drive_type','weight_kg','is_driveable','notes']; relation_field := 'vehicle_id';
      when 'motorist_locations' then
        allowed := array['label','address','lat','lng','place_id','provider','confidence','metadata'];
        relation_field := case when p_case_patch->>'pickup_location_id' = relation_id::text then 'pickup_location_id' else 'destination_location_id' end;
      else raise exception 'Invalid related table' using errcode = '22023';
    end case;
    if relation_id is null or jsonb_typeof(patch) is distinct from 'object'
      or not coalesce((relation->>'insert')::boolean, false)
      or p_case_patch->>relation_field is distinct from relation_id::text
      or exists(select 1 from jsonb_object_keys(patch) keys(key) where not key = any(allowed)) then
      raise exception 'Invalid related creation' using errcode = '22023';
    end if;
    patch := patch || jsonb_build_object('id', relation_id, 'organization_id', p_organization_id);
    select string_agg(format('%I', key), ',') into columns_sql from jsonb_object_keys(patch) keys(key);
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1)',
      relation_table, columns_sql, columns_sql, relation_table) using patch;
  end loop;
  -- An ID outside this plan must still be in the authenticated organization.
  if (p_case_patch->>'contact_id' is not null and not exists(select 1 from public.motorist_contacts where id = (p_case_patch->>'contact_id')::uuid and organization_id = p_organization_id))
    or (p_case_patch->>'vehicle_id' is not null and not exists(select 1 from public.motorist_vehicles where id = (p_case_patch->>'vehicle_id')::uuid and organization_id = p_organization_id))
    or (p_case_patch->>'pickup_location_id' is not null and not exists(select 1 from public.motorist_locations where id = (p_case_patch->>'pickup_location_id')::uuid and organization_id = p_organization_id))
    or (p_case_patch->>'destination_location_id' is not null and not exists(select 1 from public.motorist_locations where id = (p_case_patch->>'destination_location_id')::uuid and organization_id = p_organization_id)) then
    raise insufficient_privilege;
  end if;

  -- Keep the existing PM-YYYY-NNNN format, allocating under an organization lock.
  perform pg_advisory_xact_lock(hashtextextended('case-number:' || p_organization_id::text, 0));
  prefix := substring(p_case_patch->>'case_number' from '^PM-[0-9]{4}-');
  select coalesce(max(split_part(case_number, '-', 3)::bigint), 0) + 1 into sequence_number from public.motorist_cases
    where organization_id = p_organization_id and case_number ~ ('^' || prefix || '[0-9]+$');
  next_number := prefix || lpad(sequence_number::text, greatest(4, length(sequence_number::text)), '0');
  patch := p_case_patch || jsonb_build_object('id', p_command_id, 'case_number', next_number, 'selected_asset_id', null);
  select string_agg(format('%I', key), ',') into columns_sql from jsonb_object_keys(patch) keys(key);
  execute format('insert into public.motorist_cases (%s) select %s from jsonb_populate_record(null::public.motorist_cases,$1) returning *', columns_sql, columns_sql)
    into saved using patch;

  if p_partner_origin is not null and p_partner_origin <> 'null'::jsonb then
    if jsonb_typeof(p_partner_origin) is distinct from 'object' or p_partner_origin->>'partnerId' is null then
      raise exception 'Invalid partner origin' using errcode = '22023';
    end if;
    -- Reuse the existing partner/line/call validation in this same transaction.
    perform public.motorist_partner_command(actor.user_id, p_organization_id, p_command_id, 0, 'set_context',
      p_partner_origin || jsonb_build_object('caseId', saved.id, 'settlement',
        '{"payer":"","reference":"","agreement":"","agreementVersion":"","billable":false,"approvedCents":null,"currency":"EUR","recommendation":"","serviceAccepted":false,"acceptanceEvidence":""}'::jsonb));
  end if;
  insert into public.motorist_case_events(organization_id, case_id, actor_profile_id, event_type, title, body, payload)
    values(p_organization_id, saved.id, p_actor_id, 'case_created', 'Prípad vytvorený operátorom', p_event_body, p_event_payload);
  insert into public.motorist_audit_log(organization_id, actor_profile_id, action, entity_type, entity_id, source, after_payload)
    values(p_organization_id, p_actor_id, 'case.create', 'motorist_cases', saved.id, 'dispatch_console',
      jsonb_build_object('case_number', saved.case_number, 'source', 'manual_dispatch_form', 'partnerOrigin', p_partner_origin, 'commandId', p_command_id));
  insert into public.motorist_case_creation_commands(organization_id, command_id, actor_id, fingerprint, result)
    values(p_organization_id, p_command_id, p_actor_id, p_fingerprint, to_jsonb(saved));
  return to_jsonb(saved);
end;
$$;
revoke all on function public.motorist_create_case_atomic(uuid,uuid,uuid,text,jsonb,jsonb,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.motorist_create_case_atomic(uuid,uuid,uuid,text,jsonb,jsonb,text,jsonb,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
