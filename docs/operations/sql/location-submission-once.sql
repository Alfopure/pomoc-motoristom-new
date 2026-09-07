-- Pending explicit approval. Target: ifpaeegaesdmljfkdvcn only.
-- No historical rows are changed. Existing API callers remain compatible.
-- The row lock serializes submissions against the same link. Consuming the
-- link and inserting the accepted submission commit or roll back together.
create or replace function public.motorist_guard_location_submission()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  link public.motorist_location_share_links%rowtype;
begin
  if not new.accepted then return new; end if;
  select * into link from public.motorist_location_share_links
    where id = new.link_id for update;
  if not found or link.organization_id <> new.organization_id
    or link.case_id <> new.case_id then
    raise exception 'location_link_invalid' using errcode = 'P0001';
  end if;
  if link.status <> 'active' or link.expires_at <= clock_timestamp()
    or exists (select 1 from public.motorist_location_submissions
      where link_id = link.id and accepted) then
    raise exception 'location_link_inactive' using errcode = 'P0001';
  end if;
  update public.motorist_location_share_links
    set status = 'used', used_at = new.submitted_at where id = link.id;
  return new;
end;
$$;

revoke all on function public.motorist_guard_location_submission() from public, anon, authenticated;
create trigger location_submission_once
  before insert on public.motorist_location_submissions
  for each row execute function public.motorist_guard_location_submission();
