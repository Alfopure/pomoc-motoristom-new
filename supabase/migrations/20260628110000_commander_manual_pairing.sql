alter table public.motorist_fleet_asset_links
  alter column fleet_asset_id drop not null;

drop index if exists public.fleet_asset_links_active_pair_idx;
create unique index if not exists fleet_asset_links_active_pair_idx
  on public.motorist_fleet_asset_links (organization_id, external_vehicle_record_id, fleet_asset_id, source_provider)
  where fleet_asset_id is not null and link_status <> 'rejected';
