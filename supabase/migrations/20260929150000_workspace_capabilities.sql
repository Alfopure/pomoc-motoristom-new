begin;
create or replace function public.motorist_workspace_capabilities(p_organization_id uuid, p_actor_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare task_enabled boolean;
begin
  if not exists(select 1 from motorist_profiles p join motorist_organizations o on o.id=p.organization_id where p.id=p_actor_id and p.organization_id=p_organization_id and p.active and o.active) then
    raise exception 'Workspace forbidden' using errcode='42501';
  end if;
  select s.enabled and s.writer_inventory_verified_at is not null and length(trim(s.writer_inventory_note))>0 into task_enabled
    from motorist_task_workspace_settings s where s.organization_id=p_organization_id;
  return jsonb_build_object('notes',true,'tasks',coalesce(task_enabled,false),'atomicCaseSave',true,'pdf',true);
end $$;
revoke all on function public.motorist_workspace_capabilities(uuid,uuid) from public,anon,authenticated;
grant execute on function public.motorist_workspace_capabilities(uuid,uuid) to service_role;
commit;
