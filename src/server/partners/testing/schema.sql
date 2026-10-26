-- Minimal schema fixture for a fresh LOCAL database only; never apply remotely.
create schema auth; create schema storage;
create table auth.users(id uuid primary key);
create table public.motorist_organizations(id uuid primary key);
create table public.motorist_profiles(id uuid primary key,user_id uuid,organization_id uuid,active boolean,role text,email text);
create table public.motorist_partner_directory(id uuid primary key,organization_id uuid,name text,active boolean);
create table public.motorist_telephony_lines(id uuid primary key,organization_id uuid);
create table public.motorist_call_sessions(id uuid primary key,organization_id uuid,case_id uuid);
create table public.motorist_cases(id uuid primary key,organization_id uuid,case_number text,status text,priority text,source_type text,case_type text,assistance_reference text,payment_details jsonb,customer_details jsonb,summary text);
create table public.motorist_towing_memberships(id uuid primary key,organization_id uuid,auth_user_id uuid,active boolean,email text);
create table public.motorist_operations(id uuid primary key,organization_id uuid,case_id uuid);
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
