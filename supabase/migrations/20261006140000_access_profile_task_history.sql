-- Account removal needs to know whether a profile is retained by a private
-- task-workflow retry receipt. Expose only that boolean to the trusted account
-- service; the receipt payload and command identity remain unreadable.
begin;

create function public.motorist_access_profile_has_task_workflow_history(
  p_organization_id uuid,
  p_profile_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.motorist_task_workflow_commands command
    where command.organization_id = p_organization_id
      and command.actor_profile_id = p_profile_id
  );
$$;

revoke all on function public.motorist_access_profile_has_task_workflow_history(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.motorist_access_profile_has_task_workflow_history(uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';
commit;
