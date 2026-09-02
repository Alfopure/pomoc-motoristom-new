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

  if not (
    (affected_photo_rows = 15 and affected_vehicle_rows = 1)
    or (affected_photo_rows = 0 and affected_vehicle_rows = 0)
  ) then
    raise exception 'Expected to rewrite 15/1 or 0/0 photo rows, rewrote %/%',
      affected_photo_rows,
      affected_vehicle_rows;
  end if;

  if exists (
    select 1
    from public.vehicle_photos
    where public_url like 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/%'
  ) or exists (
    select 1
    from public.vehicles
    where photo_url like 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/%'
  ) then
    raise exception 'Old project URL remains in a live vehicle photo field';
  end if;
end
$migration$;
