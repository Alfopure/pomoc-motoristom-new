-- A single SQL statement reads one MVCC snapshot of the saved case and its history.
-- Task links migration must be installed first. No notebook/chat payload is selected.
begin;
create or replace function public.motorist_case_pdf_snapshot(p_organization_id uuid, p_actor_id uuid, p_case_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare snapshot jsonb;
begin
  if not exists (
    select 1 from motorist_profiles p join motorist_organizations o on o.id = p.organization_id
    where p.id = p_actor_id and p.organization_id = p_organization_id and p.active and o.active
      and p.role in ('dispatcher','senior_dispatcher','manager','admin')
  ) then raise exception 'Case export forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
    'case', to_jsonb(c),
    'snapshotAt', statement_timestamp(),
    'assignedAsset', (select jsonb_build_object('label',v.label,'license_plate',v.license_plate,'kind',v.kind,
      'assignedDriverName',v.assigned_driver_name,'assignedDriverPhone',v.assigned_driver_phone)
      from motorist_fleet_assets v where v.id=c.selected_asset_id and v.organization_id=c.organization_id),
    'contact', (select to_jsonb(v) from motorist_contacts v where v.id=c.contact_id and v.organization_id=c.organization_id),
    'vehicle', (select to_jsonb(v) from motorist_vehicles v where v.id=c.vehicle_id and v.organization_id=c.organization_id),
    'pickup', (select jsonb_build_object('label',v.label,'address',v.address,'lat',v.lat,'lng',v.lng) from motorist_locations v where v.id=c.pickup_location_id and v.organization_id=c.organization_id),
    'destination', (select jsonb_build_object('label',v.label,'address',v.address,'lat',v.lat,'lng',v.lng) from motorist_locations v where v.id=c.destination_location_id and v.organization_id=c.organization_id),
    'owner', (select p.display_name from motorist_profiles p where p.id=c.owner_id and p.organization_id=c.organization_id),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('title',t.title,'status',t.status,'priority',t.priority,'dueAt',t.due_at,'assignedTo',p.display_name) order by t.created_at,t.id)
      from motorist_case_tasks t left join motorist_profiles p on p.id=t.assigned_to and p.organization_id=t.organization_id
      where t.organization_id=c.organization_id and exists(select 1 from motorist_task_case_links l where l.task_id=t.id and l.case_id=c.id and l.organization_id=c.organization_id)), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('title',e.title,'body',e.body,'createdAt',e.created_at,'actor',p.display_name) order by e.created_at,e.id)
      from motorist_case_events e left join motorist_profiles p on p.id=e.actor_profile_id and p.organization_id=e.organization_id
      where e.case_id=c.id and e.organization_id=c.organization_id), '[]'::jsonb),
    'sms', coalesce((select jsonb_agg(jsonb_build_object('body',s.body,'direction',s.direction,'to',s.to_number,'from',s.from_label,'status',s.status,'createdAt',s.created_at) order by s.created_at,s.id)
      from motorist_sms_messages s where s.case_id=c.id and s.organization_id=c.organization_id), '[]'::jsonb)
  ) into snapshot from motorist_cases c where c.id=p_case_id and c.organization_id=p_organization_id;
  if snapshot is null then raise exception 'Case not found' using errcode = 'P0002'; end if;
  return snapshot;
end $$;
revoke all on function public.motorist_case_pdf_snapshot(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.motorist_case_pdf_snapshot(uuid,uuid,uuid) to service_role;
commit;
