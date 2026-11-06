-- Keep automatic source fulfillment independent of optional human checklist
-- confirmation. Only the existing service-role entrypoints receive this scope;
-- their unchanged private delegates still validate the durable source, org,
-- case, provider proof/claim and pending review before touching a task.
begin;

alter function public.motorist_complete_task_source_v1(uuid,text,uuid,uuid)
 rename to motorist_complete_task_source_before_checklists;
alter function public.motorist_complete_task_source_before_checklists(uuid,text,uuid,uuid)set schema app_private;
revoke all on function app_private.motorist_complete_task_source_before_checklists(uuid,text,uuid,uuid)from public,anon,authenticated,service_role;

create function public.motorist_complete_task_source_v1(p_organization_id uuid,p_source_type text,p_source_id uuid,p_actor_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous_override text;result jsonb;
begin
 previous_override:=current_setting('app.employee_task_checklist_override',true);
 perform set_config('app.employee_task_checklist_override','v1',true);
 result:=app_private.motorist_complete_task_source_before_checklists(p_organization_id,p_source_type,p_source_id,p_actor_id);
 perform set_config('app.employee_task_checklist_override',coalesce(previous_override,''),true);
 return result;
exception when others then
 perform set_config('app.employee_task_checklist_override',coalesce(previous_override,''),true);
 raise;
end $$;
revoke all on function public.motorist_complete_task_source_v1(uuid,text,uuid,uuid)from public,anon,authenticated;
grant execute on function public.motorist_complete_task_source_v1(uuid,text,uuid,uuid)to service_role;

alter function public.motorist_resolve_callback_v1(uuid,uuid,uuid,text,jsonb,text)
 rename to motorist_resolve_callback_before_checklists;
alter function public.motorist_resolve_callback_before_checklists(uuid,uuid,uuid,text,jsonb,text)set schema app_private;
revoke all on function app_private.motorist_resolve_callback_before_checklists(uuid,uuid,uuid,text,jsonb,text)from public,anon,authenticated,service_role;

create function public.motorist_resolve_callback_v1(p_organization_id uuid,p_request_id uuid,p_actor_id uuid,p_status text,p_proof jsonb default null,p_notes text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous_override text;result jsonb;
begin
 previous_override:=current_setting('app.employee_task_checklist_override',true);
 perform set_config('app.employee_task_checklist_override','v1',true);
 result:=app_private.motorist_resolve_callback_before_checklists(p_organization_id,p_request_id,p_actor_id,p_status,p_proof,p_notes);
 perform set_config('app.employee_task_checklist_override',coalesce(previous_override,''),true);
 return result;
exception when others then
 perform set_config('app.employee_task_checklist_override',coalesce(previous_override,''),true);
 raise;
end $$;
revoke all on function public.motorist_resolve_callback_v1(uuid,uuid,uuid,text,jsonb,text)from public,anon,authenticated;
grant execute on function public.motorist_resolve_callback_v1(uuid,uuid,uuid,text,jsonb,text)to service_role;

notify pgrst,'reload schema';
commit;
