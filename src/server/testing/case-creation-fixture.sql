-- Extend src/server/partners/testing/schema.sql in a fresh LOCAL database only.
alter table public.motorist_organizations add column active boolean not null default true;
alter table public.motorist_profiles add column access_status text not null default 'active';
alter table public.motorist_cases
  add column owner_id uuid, add column contact_id uuid, add column vehicle_id uuid,
  add column pickup_location_id uuid, add column destination_location_id uuid,
  add column main_note text, add column selected_asset_id uuid,
  add column vehicle_details jsonb, add column incident_details jsonb, add column location_details jsonb,
  add column replacement_vehicle_details jsonb, add column closure_details jsonb, add column attachments_metadata jsonb,
  add column created_at timestamptz not null default now(), add column updated_at timestamptz not null default now();
create table public.motorist_contacts(id uuid primary key, organization_id uuid, name text, phone text, email text, role text, notes text);
create table public.motorist_vehicles(id uuid primary key, organization_id uuid, license_plate text, vin text, make text, model text, category text, transmission text, production_year int, color text, drive_type text, weight_kg int, is_driveable boolean, notes text);
create table public.motorist_locations(id uuid primary key, organization_id uuid, label text, address text, lat double precision, lng double precision, place_id text, provider text, confidence double precision, metadata jsonb);
create table public.motorist_case_events(id uuid primary key default gen_random_uuid(), organization_id uuid, case_id uuid, actor_profile_id uuid, event_type text, title text, body text, payload jsonb);
create table public.motorist_audit_log(id uuid primary key default gen_random_uuid(), organization_id uuid, actor_profile_id uuid, action text, entity_type text, entity_id uuid, source text, before_payload jsonb, after_payload jsonb, created_at timestamptz not null default now());
grant select, insert, update on public.motorist_organizations, public.motorist_profiles, public.motorist_cases, public.motorist_contacts, public.motorist_vehicles, public.motorist_locations, public.motorist_case_events, public.motorist_audit_log to service_role;
grant select on public.motorist_partner_directory, public.motorist_telephony_lines, public.motorist_call_sessions to service_role;
