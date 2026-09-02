alter table public.motorist_fleet_assets
  add column if not exists assigned_driver_name text,
  add column if not exists assigned_driver_phone text,
  add column if not exists assigned_driver_status text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.motorist_fleet_assets'::regclass
      and conname = 'fleet_assets_driver_status_check'
  ) then
    alter table public.motorist_fleet_assets
      add constraint fleet_assets_driver_status_check
      check (
        assigned_driver_status is null
        or assigned_driver_status in ('available', 'on_shift', 'on_call', 'off_shift')
      );
  end if;
end $$;
