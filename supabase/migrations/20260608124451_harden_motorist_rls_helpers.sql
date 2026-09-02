create schema if not exists app_private;

grant usage on schema app_private to anon, authenticated, service_role;

alter function public.motorist_is_org_member(uuid) set schema app_private;
alter function public.motorist_has_org_role(uuid, text[]) set schema app_private;

grant execute on function app_private.motorist_is_org_member(uuid) to anon, authenticated, service_role;
grant execute on function app_private.motorist_has_org_role(uuid, text[]) to anon, authenticated, service_role;
