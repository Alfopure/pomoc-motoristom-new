alter table public.motorist_fleet_assets
  add column if not exists make text,
  add column if not exists model text,
  add column if not exists vin text,
  add column if not exists category text,
  add column if not exists weight_kg integer,
  add column if not exists notes text,
  add column if not exists insurance_valid_until date,
  add column if not exists highway_vignette_valid_until date,
  add column if not exists technical_inspection_valid_until date,
  add column if not exists emission_inspection_valid_until date,
  add column if not exists occupied_from timestamptz,
  add column if not exists occupied_until timestamptz,
  add column if not exists occupancy_type text,
  add column if not exists occupancy_case_id uuid references public.motorist_cases(id) on delete set null,
  add column if not exists occupancy_note text,
  add column if not exists tow_category text,
  add column if not exists capabilities text[] not null default '{}'::text[];

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.motorist_fleet_assets'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table public.motorist_fleet_assets drop constraint %I', constraint_name);
  end loop;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.motorist_fleet_assets'::regclass
      and conname = 'fleet_assets_status_check'
  ) then
    alter table public.motorist_fleet_assets
      add constraint fleet_assets_status_check
      check (status in ('available', 'reserved', 'rented', 'assigned', 'busy', 'service', 'offline'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.motorist_fleet_assets'::regclass
      and conname = 'fleet_assets_occupancy_type_check'
  ) then
    alter table public.motorist_fleet_assets
      add constraint fleet_assets_occupancy_type_check
      check (occupancy_type is null or occupancy_type in ('reservation', 'rental', 'case_assignment'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.motorist_fleet_assets'::regclass
      and conname = 'fleet_assets_tow_category_check'
  ) then
    alter table public.motorist_fleet_assets
      add constraint fleet_assets_tow_category_check
      check (tow_category is null or tow_category in ('personal', 'van', 'specialized', 'heavy'));
  end if;
end $$;

create index if not exists fleet_assets_status_idx
  on public.motorist_fleet_assets (organization_id, kind, status);

create index if not exists fleet_assets_docs_idx
  on public.motorist_fleet_assets (
    organization_id,
    insurance_valid_until,
    highway_vignette_valid_until,
    technical_inspection_valid_until,
    emission_inspection_valid_until
  );
