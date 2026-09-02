alter table public.motorist_cases
  add column if not exists selected_asset_id uuid references public.motorist_fleet_assets(id) on delete set null;

create index if not exists cases_selected_asset_idx
  on public.motorist_cases (organization_id, selected_asset_id)
  where selected_asset_id is not null;
