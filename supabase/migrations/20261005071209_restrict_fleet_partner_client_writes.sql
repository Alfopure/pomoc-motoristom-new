-- B1 security audit: keep organization-scoped client reads and server-authorized writes.
-- Owner approved this exact SQL for TEST nzpnqdstvkfncflgqlny on 2026-10-05.
-- Applied there as 20261005071209; production requires separate authorization.
begin;

-- Keep client reads. All writes already use an authorized server path.
-- ALL is scoped to exactly these tables, including non-DML table privileges.
revoke all privileges on table public.motorist_fleet_assets,
  public.motorist_partner_directory from public, anon, authenticated;
grant select on table public.motorist_fleet_assets,
  public.motorist_partner_directory to anon, authenticated;

-- Read-only policies also prevent an accidental later DML regrant from
-- reopening the member-write path. Service-role writers retain their grants.
drop policy motorist_fleet_assets_organization_access on public.motorist_fleet_assets;
create policy motorist_fleet_assets_organization_access
  on public.motorist_fleet_assets for select to authenticated
  using (app_private.motorist_is_org_member(organization_id));

drop policy partner_directory_organization_access on public.motorist_partner_directory;
create policy partner_directory_organization_access
  on public.motorist_partner_directory for select to authenticated
  using (app_private.motorist_is_org_member(organization_id));

commit;
