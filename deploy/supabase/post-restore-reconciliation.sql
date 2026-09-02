-- A logical project dump intentionally excludes Storage/Auth platform schemas.
-- Recreate only application-owned objects on those schemas.

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter function public.handle_new_user() set search_path = '';
revoke all on function public.handle_new_user() from public, anon, authenticated;

alter function public.auth_is_active() set search_path = '';
alter function app_private.motorist_is_org_member(uuid) set search_path = '';
alter function app_private.motorist_has_org_role(uuid, text[]) set search_path = '';
alter function public.motorist_prevent_last_admin_profile_loss() set search_path = '';

create or replace function public.motorist_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

-- Some late source policies depend on a public SECURITY DEFINER compatibility
-- helper. Keep the stable signature, but make the wrapper SECURITY INVOKER and
-- delegate authorization to the private helper.
create or replace function public.motorist_is_org_member(target_organization_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select app_private.motorist_is_org_member(target_organization_id);
$$;

revoke all on function public.motorist_is_org_member(uuid) from public;
grant execute on function public.motorist_is_org_member(uuid) to anon, authenticated, service_role;

drop policy if exists "Active users can delete own photos" on storage.objects;
create policy "Active users can delete own photos"
  on storage.objects for delete to public
  using (
    public.auth_is_active()
    and bucket_id = any (array['rental-photos', 'signatures', 'vehicle-photos']::text[])
  );

drop policy if exists "Active users can delete vehicle damage photos" on storage.objects;
create policy "Active users can delete vehicle damage photos"
  on storage.objects for delete to public
  using (public.auth_is_active() and bucket_id = 'vehicle-damage-photos');

drop policy if exists "Active users can update vehicle photos" on storage.objects;
create policy "Active users can update vehicle photos"
  on storage.objects for update to public
  using (public.auth_is_active() and bucket_id = 'vehicle-photos')
  with check (public.auth_is_active() and bucket_id = 'vehicle-photos');

drop policy if exists "Active users can upload rental photos" on storage.objects;
create policy "Active users can upload rental photos"
  on storage.objects for insert to public
  with check (
    public.auth_is_active()
    and bucket_id = any (array['rental-photos', 'signatures', 'vehicle-photos']::text[])
  );

drop policy if exists "Active users can upload vehicle damage photos" on storage.objects;
create policy "Active users can upload vehicle damage photos"
  on storage.objects for insert to public
  with check (public.auth_is_active() and bucket_id = 'vehicle-damage-photos');

drop policy if exists "Active users can view rental photos" on storage.objects;
create policy "Active users can view rental photos"
  on storage.objects for select to public
  using (
    public.auth_is_active()
    and bucket_id = any (array['rental-photos', 'signatures', 'vehicle-photos']::text[])
  );

drop policy if exists "Active users can view vehicle damage photos" on storage.objects;
create policy "Active users can view vehicle damage photos"
  on storage.objects for select to public
  using (public.auth_is_active() and bucket_id = 'vehicle-damage-photos');

drop policy if exists "Public can view vehicle photos" on storage.objects;
create policy "Public can view vehicle photos"
  on storage.objects for select to public
  using (bucket_id = 'vehicle-photos');

drop policy if exists case_attachments_select_member on storage.objects;
create policy case_attachments_select_member
  on storage.objects for select
  using (
    bucket_id = 'motorist-case-attachments'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and app_private.motorist_is_org_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists case_attachments_insert_member on storage.objects;
drop policy if exists case_attachments_update_member on storage.objects;
drop policy if exists case_attachments_delete_member on storage.objects;

drop policy if exists call_recordings_select_restricted on storage.objects;
create policy call_recordings_select_restricted
  on storage.objects for select
  using (
    bucket_id = 'motorist-call-recordings'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and app_private.motorist_has_org_role(
      ((storage.foldername(name))[1])::uuid,
      array['senior_dispatcher', 'manager', 'admin']
    )
  );

drop policy if exists call_recordings_insert_restricted on storage.objects;
drop policy if exists call_recordings_update_restricted on storage.objects;
drop policy if exists call_recordings_delete_restricted on storage.objects;

-- This target-only rewrite is also recorded as migration
-- 20260714203408_rehome_rentals_vehicle_photo_urls.sql. Restore normalizes the
-- migration history rather than replaying repository migrations, so keep the
-- data rewrite in the same atomic reconciliation transaction as the restore.
do $migration$
declare
  affected_photo_rows integer;
  affected_vehicle_rows integer;
begin
  update public.vehicle_photos p
  set public_url = 'https://sjcsrygkkmersoczpunh.supabase.co/storage/v1/object/public/vehicle-photos/' || p.storage_path
  where p.public_url = 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/storage/v1/object/public/vehicle-photos/' || p.storage_path
    and exists (
      select 1
      from storage.objects o
      where o.bucket_id = 'vehicle-photos'
        and o.name = p.storage_path
    );
  get diagnostics affected_photo_rows = row_count;
  if affected_photo_rows <> 15 then
    raise exception 'Expected to rewrite 15 vehicle_photos rows, rewrote %', affected_photo_rows;
  end if;

  update public.vehicles v
  set photo_url = replace(
    v.photo_url,
    'https://jcwbiulwuwyrnmzjjbgr.supabase.co/storage/v1/object/public/vehicle-photos/',
    'https://sjcsrygkkmersoczpunh.supabase.co/storage/v1/object/public/vehicle-photos/'
  )
  where v.photo_url like 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/storage/v1/object/public/vehicle-photos/%'
    and exists (
      select 1
      from storage.objects o
      where o.bucket_id = 'vehicle-photos'
        and v.photo_url = 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/storage/v1/object/public/vehicle-photos/' || o.name
    );
  get diagnostics affected_vehicle_rows = row_count;
  if affected_vehicle_rows <> 1 then
    raise exception 'Expected to rewrite 1 vehicles row, rewrote %', affected_vehicle_rows;
  end if;

  if exists (
    select 1 from public.vehicle_photos
    where public_url like 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/%'
  ) or exists (
    select 1 from public.vehicles
    where photo_url like 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/%'
  ) then
    raise exception 'Old project URL remains in a live vehicle photo field';
  end if;
end
$migration$;

-- Fail-safe: no scheduler or queued HTTP work may survive a rehearsal restore.
do $$
declare
  active_job record;
begin
  if to_regclass('cron.job') is not null then
    for active_job in select jobid from cron.job where active loop
      perform cron.alter_job(active_job.jobid, active => false);
    end loop;
  end if;

  if to_regclass('net.http_request_queue') is not null
     and exists (select 1 from net.http_request_queue) then
    raise exception 'HTTP_REQUEST_QUEUE_NOT_EMPTY_AFTER_RESTORE';
  end if;

  if to_regclass('public.motorist_job_controls') is not null then
    execute 'update public.motorist_job_controls set enabled = false';
  end if;
end;
$$;
