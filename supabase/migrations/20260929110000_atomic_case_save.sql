-- Case editor writes must commit together. The existing updated_at DTO is an opaque CAS token.
create or replace function public.motorist_case_monotonic_revision()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;
drop trigger if exists zz_motorist_case_revision on public.motorist_cases;
create trigger zz_motorist_case_revision before update on public.motorist_cases
for each row execute function public.motorist_case_monotonic_revision();

create or replace function public.motorist_save_case_atomic(
  p_organization_id uuid, p_actor_id uuid, p_case_id uuid, p_expected_updated_at timestamptz,
  p_case_patch jsonb, p_related jsonb, p_field_labels jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  current_case public.motorist_cases;
  saved_case public.motorist_cases;
  relation jsonb;
  previous jsonb;
  patch jsonb;
  relation_table text;
  relation_id uuid;
  allowed text[];
  columns_sql text;
  changed text[] := '{}';
  field text;
  event_type text;
  event_title text;
  event_body text;
  relation_field text;
  case_columns text[] := array['status','priority','source_type','case_type','summary','main_note','contact_id','vehicle_id','pickup_location_id','destination_location_id','customer_details','vehicle_details','incident_details','location_details','replacement_vehicle_details','payment_details','closure_details','attachments_metadata'];
begin
  if not exists (select 1 from public.motorist_profiles profile join public.motorist_organizations organization on organization.id = profile.organization_id where profile.id = p_actor_id and profile.organization_id = p_organization_id and profile.active and organization.active and profile.role in ('dispatcher','senior_dispatcher','manager','admin')) then
    raise exception 'Case editor membership required' using errcode = '42501';
  end if;
  select * into current_case from public.motorist_cases where id = p_case_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Case not found' using errcode = 'P0002'; end if;
  if p_expected_updated_at is null or current_case.updated_at is distinct from p_expected_updated_at then
    raise exception 'Case revision conflict' using errcode = '40001';
  end if;
  if jsonb_typeof(p_case_patch) <> 'object' or jsonb_typeof(p_related) <> 'array' then raise exception 'Invalid case write plan'; end if;
  if exists (select 1 from jsonb_object_keys(p_case_patch) as keys(key) where not key = any(case_columns)) then raise exception 'Invalid case field'; end if;

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
      else raise exception 'Invalid related table';
    end case;
    if jsonb_typeof(patch) <> 'object' or exists(select 1 from jsonb_object_keys(patch) as keys(key) where not key = any(allowed)) then raise exception 'Invalid related field'; end if;
    if p_case_patch->>relation_field is distinct from relation_id::text then raise exception 'Related row must belong to this case'; end if;
    if not coalesce((relation->>'insert')::boolean, false) then
      if to_jsonb(current_case)->>relation_field is distinct from relation_id::text then raise exception 'Cannot change an unrelated row'; end if;
      execute format('select to_jsonb(row) from public.%I row where id=$1 and organization_id=$2 for update', relation_table)
        into previous using relation_id, p_organization_id;
      if previous is null then raise exception 'Related row not found' using errcode='P0002'; end if;
      if relation ? 'expectedUpdatedAt' and (previous->>'updated_at')::timestamptz is distinct from (relation->>'expectedUpdatedAt')::timestamptz then
        raise exception 'Related row revision conflict' using errcode='40001';
      end if;
      if patch <@ previous then continue; end if;
      select string_agg(format('%I', key), ',') into columns_sql from jsonb_object_keys(patch) as keys(key);
      execute format('update public.%I set (%s) = (select %s from jsonb_populate_record(null::public.%I,$1)) where id=$2 and organization_id=$3', relation_table, columns_sql, columns_sql, relation_table)
        using patch, relation_id, p_organization_id;
    else
      patch := patch || jsonb_build_object('id', relation_id, 'organization_id', p_organization_id);
      select string_agg(format('%I', key), ',') into columns_sql from jsonb_object_keys(patch) as keys(key);
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1)', relation_table, columns_sql, columns_sql, relation_table) using patch;
    end if;
    if not relation_field = any(changed) then changed := array_append(changed, relation_field); end if;
  end loop;

  for field in select key from jsonb_object_keys(p_case_patch) as keys(key) loop
    if p_case_patch->field is distinct from to_jsonb(current_case)->field and not field = any(changed) then changed := array_append(changed, field); end if;
  end loop;
  if 'status' = any(changed) then
    -- Closure is derived inside this transaction; reopening cannot retain a closed report timestamp.
    if p_case_patch->>'status' in ('completed_assisted','completed_no_assistance','rejected','cancelled','futile_trip') then
      p_case_patch := p_case_patch || jsonb_build_object('closed_at', clock_timestamp(), 'closure_details',
        coalesce(p_case_patch->'closure_details', current_case.closure_details) || jsonb_build_object('closedAt', clock_timestamp()));
    else
      p_case_patch := p_case_patch || jsonb_build_object('closed_at', null, 'closure_details',
        coalesce(p_case_patch->'closure_details', current_case.closure_details) - 'closedAt');
    end if;
  end if;
  if cardinality(changed) = 0 then return to_jsonb(current_case); end if;
  select string_agg(format('%I', key), ',') into columns_sql from jsonb_object_keys(p_case_patch) as keys(key);
  execute format('update public.motorist_cases set (%s) = (select %s from jsonb_populate_record(null::public.motorist_cases,$1)) where id=$2 and organization_id=$3 returning *', columns_sql, columns_sql)
    into saved_case using p_case_patch, p_case_id, p_organization_id;

  foreach field in array changed loop
    if field = 'status' then
      event_type := 'status_changed'; event_title := 'Stav prípadu zmenený'; event_body := 'Nový stav: ' || coalesce(p_field_labels->'statusLabels'->>saved_case.status, saved_case.status) || '.';
    elsif field = 'priority' then
      event_type := 'priority_changed'; event_title := 'Priorita prípadu zmenená'; event_body := 'Nová priorita: ' || coalesce(p_field_labels->'priorityLabels'->>saved_case.priority, saved_case.priority) || '.';
    else continue;
    end if;
    insert into public.motorist_case_events(organization_id,case_id,actor_profile_id,event_type,title,body)
      values(p_organization_id,p_case_id,p_actor_id,event_type,event_title,event_body);
  end loop;
  select string_agg(coalesce(p_field_labels->>key,key), ', ') into event_body from unnest(changed) as fields(key) where key not in ('status','priority');
  if event_body is not null then
    insert into public.motorist_case_events(organization_id,case_id,actor_profile_id,event_type,title,body)
      values(p_organization_id,p_case_id,p_actor_id,'case_updated','Karta zásahu upravená','Zmenené: ' || event_body || '.');
  end if;
  insert into public.motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
    values(p_organization_id,p_actor_id,'case.update','motorist_cases',p_case_id,'dispatch_console',jsonb_build_object('case_number',saved_case.case_number,'source','extended_case_card','changed_fields',to_jsonb(changed)));
  return to_jsonb(saved_case);
end;
$$;
revoke all on function public.motorist_save_case_atomic(uuid,uuid,uuid,timestamptz,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.motorist_save_case_atomic(uuid,uuid,uuid,timestamptz,jsonb,jsonb,jsonb) to service_role;
