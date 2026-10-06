-- B2: histories are written by authorized server operations, not browser DML.
-- Apply only to the exact project explicitly approved for this SQL.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke all privileges on table public.motorist_case_events,
  public.motorist_call_events from public, anon, authenticated;
grant select on table public.motorist_case_events,
  public.motorist_call_events to anon, authenticated;

-- Preserve organization-scoped reads; prevent a later DML regrant from
-- reopening client writes. Existing service_role grants remain unchanged.
drop policy motorist_case_events_organization_access on public.motorist_case_events;
create policy motorist_case_events_organization_access
  on public.motorist_case_events for select to authenticated
  using (app_private.motorist_is_org_member(organization_id));

drop policy motorist_call_events_organization_access on public.motorist_call_events;
create policy motorist_call_events_organization_access
  on public.motorist_call_events for select to authenticated
  using (app_private.motorist_is_org_member(organization_id));

commit;
