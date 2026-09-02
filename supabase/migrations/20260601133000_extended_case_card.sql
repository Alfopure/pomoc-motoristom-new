alter table public.motorist_vehicles
  add column if not exists production_year integer,
  add column if not exists color text,
  add column if not exists drive_type text;

alter table public.motorist_cases
  add column if not exists customer_details jsonb not null default '{}'::jsonb,
  add column if not exists vehicle_details jsonb not null default '{}'::jsonb,
  add column if not exists incident_details jsonb not null default '{}'::jsonb,
  add column if not exists location_details jsonb not null default '{}'::jsonb,
  add column if not exists replacement_vehicle_details jsonb not null default '{}'::jsonb,
  add column if not exists payment_details jsonb not null default '{}'::jsonb,
  add column if not exists closure_details jsonb not null default '{}'::jsonb,
  add column if not exists attachments_metadata jsonb not null default '[]'::jsonb;

create index if not exists cases_customer_details_gin_idx
  on public.motorist_cases using gin (customer_details);

create index if not exists cases_incident_details_gin_idx
  on public.motorist_cases using gin (incident_details);
