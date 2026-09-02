-- Server-only receipts for the separately executed VIPTel 20-23 bootstrap.
-- Keeping this table in migration history makes the manual bootstrap itself
-- data-only and leaves its exact before/after state auditable and reversible.

create table if not exists public.motorist_workplace_bootstrap_receipts (
  id uuid primary key,
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  bootstrap_batch_id uuid not null,
  actor_profile_id uuid not null,
  provider_evidence_not_before timestamptz not null,
  extension_id uuid not null,
  extension text not null check (extension in ('20', '21', '22', '23')),
  bootstrap_mode text not null check (bootstrap_mode in ('unassigned', 'offline_owner')),
  expected_profile_id uuid,
  before_profile_id uuid,
  before_display_name text,
  before_metadata jsonb not null,
  before_workplace_seat_generation uuid,
  after_profile_id uuid,
  after_display_name text,
  after_metadata jsonb not null,
  after_workplace_seat_generation uuid not null,
  assignment_generation uuid not null,
  bootstrap_lease_id uuid,
  bootstrap_lease_row jsonb,
  terminal_audit_id uuid not null,
  guard_snapshot jsonb not null,
  routing_snapshot jsonb not null,
  applied_at timestamptz not null,
  rolled_back_at timestamptz,
  rollback_audit_id uuid,
  unique (organization_id, bootstrap_batch_id, extension),
  unique (organization_id, bootstrap_batch_id, extension_id),
  check ((bootstrap_mode = 'offline_owner') = (expected_profile_id is not null)),
  check ((bootstrap_lease_id is null) = (bootstrap_lease_row is null)),
  check ((bootstrap_mode = 'offline_owner') = (bootstrap_lease_id is not null)),
  check ((rolled_back_at is null) = (rollback_audit_id is null))
);

create unique index if not exists motorist_workplace_bootstrap_one_current_extension_idx
  on public.motorist_workplace_bootstrap_receipts (organization_id, extension_id)
  where rolled_back_at is null;

alter table public.motorist_workplace_bootstrap_receipts enable row level security;
alter table public.motorist_workplace_bootstrap_receipts force row level security;
revoke all on table public.motorist_workplace_bootstrap_receipts from public;

do $privileges$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.motorist_workplace_bootstrap_receipts from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.motorist_workplace_bootstrap_receipts from authenticated';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on table public.motorist_workplace_bootstrap_receipts to service_role';
  end if;
end
$privileges$;

comment on table public.motorist_workplace_bootstrap_receipts is
  'Server-only receipts for the separately executed VIPTel 20-23 bootstrap; never browser-readable.';
