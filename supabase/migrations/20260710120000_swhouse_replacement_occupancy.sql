-- T2 — SWHouse jediný zdroj pravdy o obsadenosti náhradných vozidiel.
-- Additive-only, backward-compatible. Nasadiť PRED kódom, ktorý tabuľku číta (dispatch loader + assignCase guard).
--
-- Occupancy sync (samostatný ~5-min job) sem upsertuje aktuálny snapshot obsadenosti:
--   occupied_plates = flotila (client_vehicle_db roster) mínus 5-min voľné (getCarsOccupancy)
--   free_plates     = SWHouse voľné náhradné vozidlá
-- Loader číta NAJNOVŠÍ snapshot + jeho vek (stale prah 10 min = GPS_STALE_AFTER_MINUTES).

create table if not exists public.motorist_fleet_replacement_occupancy (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.motorist_organizations(id) on delete cascade,
  captured_at timestamptz not null default now(),
  -- Normalizované ŠPZ (uppercase, len A-Z0-9) — párovanie cez normalizePlateForPairing.
  occupied_plates text[] not null default '{}'::text[],
  free_plates text[] not null default '{}'::text[],
  source text not null default 'swhouse',
  created_at timestamptz not null default now()
);

create index if not exists fleet_replacement_occupancy_org_time_idx
  on public.motorist_fleet_replacement_occupancy (organization_id, captured_at desc);

alter table public.motorist_fleet_replacement_occupancy enable row level security;

drop policy if exists fleet_replacement_occupancy_org_read
  on public.motorist_fleet_replacement_occupancy;
create policy fleet_replacement_occupancy_org_read
  on public.motorist_fleet_replacement_occupancy
  for select
  using (app_private.motorist_is_org_member(organization_id));

-- Occupancy sync reusuje motorist_fleet_sync_runs pre observabilitu (rovnaký vzor ako commander).
-- Rozšírime povolené `mode` o 'occupancy' (additive — existujúce hodnoty ostávajú platné).
alter table public.motorist_fleet_sync_runs
  drop constraint if exists motorist_fleet_sync_runs_mode_check;
alter table public.motorist_fleet_sync_runs
  add constraint motorist_fleet_sync_runs_mode_check
  check (mode in ('vehicles', 'positions', 'rides', 'full', 'occupancy'));
