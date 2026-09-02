-- Additive foundation for dynamic VIPTel workplaces. This migration creates
-- server-only state and RPCs; it deliberately does not bootstrap or mutate the
-- live dispatch extensions and does not change any queue membership.

create unique index if not exists motorist_profiles_organization_id_key
  on public.motorist_profiles (organization_id, id);
create unique index if not exists motorist_telephony_extensions_organization_id_key
  on public.motorist_telephony_extensions (organization_id, id);

-- The stable seat generation is populated only by the separately approved
-- provider/lifecycle bootstrap. NULL therefore means "not a canonical seat".
alter table public.motorist_telephony_extensions
  add column if not exists workplace_seat_generation uuid;

-- Existing application behavior already assumes one active personal extension
-- per provider/profile. Fail the migration instead of silently preserving an
-- ambiguous owner that could later be interpreted as a free hot-desk seat.
do $$
begin
  if exists (
    select 1
    from public.motorist_telephony_extensions
    where active = true and profile_id is not null
    group by organization_id, provider, profile_id
    having pg_catalog.count(*) > 1
  ) then
    raise exception 'HOTDESK_PREFLIGHT_DUPLICATE_ACTIVE_PROFILE_EXTENSION' using errcode = '23505';
  end if;
end;
$$;
create unique index if not exists motorist_telephony_extensions_one_active_profile_idx
  on public.motorist_telephony_extensions (organization_id, provider, profile_id)
  where active = true and profile_id is not null;

create table public.motorist_workplace_operations (
  id uuid primary key,
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  idempotency_key uuid not null,
  intent_hash text not null check (intent_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('claim', 'takeover', 'switch', 'leave', 'browser_transfer')),
  actor_profile_id uuid not null,
  source_profile_id uuid,
  target_previous_profile_id uuid,
  source_extension_id uuid,
  target_extension_id uuid,
  source_lease_id uuid,
  target_lease_id uuid,
  browser_instance_id uuid not null,
  expected_source_assignment_generation uuid,
  expected_target_assignment_generation uuid,
  expected_source_lease_version bigint,
  expected_target_lease_version bigint,
  expected_source_heartbeat_at timestamptz,
  expected_target_heartbeat_at timestamptz,
  phase text not null default 'created' check (phase in (
    'created', 'claimed', 'browser_presence_checked', 'provider_checked',
    'ownership_committed', 'audits_verified', 'completed', 'aborted',
    'manual_recovery_required'
  )),
  claim_generation uuid not null,
  locked_at timestamptz,
  claim_expires_at timestamptz,
  provider_checked_at timestamptz,
  provider_proof_hash text check (provider_proof_hash is null or provider_proof_hash ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz,
  completed_at timestamptz,
  recovery_owner text,
  recovery_expires_at timestamptz,
  last_error_safe text,
  result_safe jsonb,
  source_unassign_audit_id uuid,
  target_unassign_audit_id uuid,
  target_assign_audit_id uuid,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, idempotency_key),
  unique (organization_id, id),
  foreign key (organization_id, actor_profile_id)
    references public.motorist_profiles(organization_id, id) on delete restrict,
  foreign key (organization_id, source_profile_id)
    references public.motorist_profiles(organization_id, id) on delete restrict,
  foreign key (organization_id, target_previous_profile_id)
    references public.motorist_profiles(organization_id, id) on delete restrict,
  foreign key (organization_id, source_extension_id)
    references public.motorist_telephony_extensions(organization_id, id) on delete restrict,
  foreign key (organization_id, target_extension_id)
    references public.motorist_telephony_extensions(organization_id, id) on delete restrict,
  check (expected_source_lease_version is null or expected_source_lease_version > 0),
  check (expected_target_lease_version is null or expected_target_lease_version > 0),
  check (source_extension_id is null or target_extension_id is null or source_extension_id <> target_extension_id),
  check (last_error_safe is null or pg_catalog.length(last_error_safe) <= 1000)
);

create table public.motorist_workplace_leases (
  id uuid primary key,
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  extension_id uuid not null,
  profile_id uuid not null,
  assignment_generation uuid not null,
  browser_instance_id uuid not null,
  lease_version bigint not null default 1 check (lease_version > 0),
  leader_epoch bigint not null default 1 check (leader_epoch > 0),
  resume_secret_hash text not null check (resume_secret_hash ~ '^[0-9a-f]{64}$'),
  resume_requested_at timestamptz,
  heartbeat_suspended_at timestamptz,
  heartbeat_suspension_operation_id uuid,
  state text not null default 'active' check (state in ('active', 'ending', 'ended', 'revoked')),
  claimed_at timestamptz not null default pg_catalog.now(),
  heartbeat_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null default (pg_catalog.now() + interval '60 seconds'),
  ended_at timestamptz,
  ended_reason text check (ended_reason is null or pg_catalog.length(ended_reason) <= 160),
  revoked_by uuid,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, id),
  foreign key (organization_id, extension_id)
    references public.motorist_telephony_extensions(organization_id, id) on delete restrict,
  foreign key (organization_id, profile_id)
    references public.motorist_profiles(organization_id, id) on delete restrict,
  foreign key (organization_id, revoked_by)
    references public.motorist_profiles(organization_id, id) on delete restrict,
  foreign key (organization_id, heartbeat_suspension_operation_id)
    references public.motorist_workplace_operations(organization_id, id) on delete restrict,
  check (expires_at >= heartbeat_at and expires_at <= heartbeat_at + interval '60 seconds'),
  check (
    (state in ('active', 'ending') and ended_at is null)
    or (state in ('ended', 'revoked') and ended_at is not null)
  ),
  check ((heartbeat_suspended_at is null) = (heartbeat_suspension_operation_id is null))
);

alter table public.motorist_workplace_operations
  add constraint motorist_workplace_operations_source_lease_org_fkey
    foreign key (organization_id, source_lease_id)
    references public.motorist_workplace_leases(organization_id, id) on delete restrict,
  add constraint motorist_workplace_operations_target_lease_org_fkey
    foreign key (organization_id, target_lease_id)
    references public.motorist_workplace_leases(organization_id, id) on delete restrict;

create unique index motorist_workplace_leases_one_current_extension_idx
  on public.motorist_workplace_leases (organization_id, extension_id)
  where state in ('active', 'ending');
create unique index motorist_workplace_leases_one_current_profile_idx
  on public.motorist_workplace_leases (organization_id, profile_id)
  where state in ('active', 'ending');
create index motorist_workplace_leases_expiry_idx
  on public.motorist_workplace_leases (organization_id, expires_at)
  where state in ('active', 'ending');

create table public.motorist_telephony_guard_operations (
  id uuid primary key,
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  kind text not null check (kind in (
    'workplace_claim', 'workplace_takeover', 'workplace_switch', 'workplace_leave',
    'workplace_browser_transfer', 'routing_apply', 'call_command', 'dtmf_intent',
    'queue_action', 'webphone_session_issue', 'assignment'
  )),
  owner_entity_type text not null check (owner_entity_type in (
    'workplace_operation', 'routing_operation', 'telephony_command',
    'webphone_session', 'assignment_transition'
  )),
  owner_entity_id uuid not null,
  phase text not null,
  recovery_policy text not null check (recovery_policy in (
    'workplace_precommit_abort_postcommit_rollforward', 'provider_reconcile', 'safe_abort'
  )),
  claim_generation uuid not null,
  claim_expires_at timestamptz not null,
  terminal_at timestamptz,
  last_error_safe text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, id),
  unique (organization_id, owner_entity_type, owner_entity_id),
  check (last_error_safe is null or pg_catalog.length(last_error_safe) <= 1000)
);

create table public.motorist_workplace_resource_claims (
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  resource_type text not null check (resource_type in (
    'profile', 'extension', 'workplace_lease', 'routing_plan', 'call', 'queue'
  )),
  resource_id uuid not null,
  operation_id uuid,
  claim_generation uuid,
  acquired_at timestamptz,
  expires_at timestamptz,
  guard_version bigint not null default 0 check (guard_version >= 0),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, resource_type, resource_id),
  foreign key (organization_id, operation_id)
    references public.motorist_telephony_guard_operations(organization_id, id) on delete restrict,
  check (
    (operation_id is null and claim_generation is null and acquired_at is null and expires_at is null)
    or (operation_id is not null and claim_generation is not null and acquired_at is not null and expires_at is not null)
  )
);

create index motorist_workplace_operations_recovery_idx
  on public.motorist_workplace_operations (organization_id, phase, claim_expires_at)
  where phase not in ('completed', 'aborted');
create index motorist_guard_operations_recovery_idx
  on public.motorist_telephony_guard_operations (organization_id, claim_expires_at)
  where terminal_at is null;
create index motorist_resource_claims_operation_idx
  on public.motorist_workplace_resource_claims (organization_id, operation_id)
  where operation_id is not null;

create trigger workplace_operations_updated_at before update on public.motorist_workplace_operations
  for each row execute function public.motorist_set_updated_at();
create trigger workplace_leases_updated_at before update on public.motorist_workplace_leases
  for each row execute function public.motorist_set_updated_at();
create trigger telephony_guard_operations_updated_at before update on public.motorist_telephony_guard_operations
  for each row execute function public.motorist_set_updated_at();
create trigger workplace_resource_claims_updated_at before update on public.motorist_workplace_resource_claims
  for each row execute function public.motorist_set_updated_at();

alter table public.motorist_workplace_operations enable row level security;
alter table public.motorist_workplace_operations force row level security;
alter table public.motorist_workplace_leases enable row level security;
alter table public.motorist_workplace_leases force row level security;
alter table public.motorist_telephony_guard_operations enable row level security;
alter table public.motorist_telephony_guard_operations force row level security;
alter table public.motorist_workplace_resource_claims enable row level security;
alter table public.motorist_workplace_resource_claims force row level security;

revoke all on table public.motorist_workplace_operations from public, anon, authenticated;
revoke all on table public.motorist_workplace_leases from public, anon, authenticated;
revoke all on table public.motorist_telephony_guard_operations from public, anon, authenticated;
revoke all on table public.motorist_workplace_resource_claims from public, anon, authenticated;
grant select, insert, update, delete on table public.motorist_workplace_operations to service_role;
grant select, insert, update, delete on table public.motorist_workplace_leases to service_role;
grant select, insert, update, delete on table public.motorist_telephony_guard_operations to service_role;
grant select, insert, update, delete on table public.motorist_workplace_resource_claims to service_role;

comment on table public.motorist_workplace_leases is
  'Server-only, DB-time workplace presence leases. Contains hashes/fencing values and is never browser-readable.';
comment on table public.motorist_workplace_resource_claims is
  'Canonical durable guards shared by ownership, routing, session and call mutations.';

create or replace function public.motorist_acquire_telephony_resource_claims(
  p_organization_id uuid,
  p_operation_id uuid,
  p_resources jsonb,
  p_claim_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_guard public.motorist_telephony_guard_operations%rowtype;
  v_resource record;
  v_claim public.motorist_workplace_resource_claims%rowtype;
  v_count integer;
  v_ttl integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_expires_at timestamptz;
begin
  v_ttl := greatest(30, least(coalesce(p_claim_ttl_seconds, 90), 120));
  v_expires_at := v_now + pg_catalog.make_interval(secs => v_ttl);

  select * into v_guard
  from public.motorist_telephony_guard_operations
  where organization_id = p_organization_id and id = p_operation_id
  for update;
  if not found or v_guard.terminal_at is not null then
    raise exception 'TELEPHONY_GUARD_OPERATION_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  if pg_catalog.jsonb_typeof(p_resources) <> 'array' then
    raise exception 'TELEPHONY_RESOURCE_SET_INVALID' using errcode = '22023';
  end if;
  select pg_catalog.count(*) into v_count from pg_catalog.jsonb_array_elements(p_resources);
  if v_count < 1 or v_count > 16 then
    raise exception 'TELEPHONY_RESOURCE_SET_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_resources) as item(value)
    where coalesce(value->>'resource_type', '') not in ('profile', 'extension', 'workplace_lease', 'routing_plan', 'call', 'queue')
      or not coalesce(value->>'resource_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) or (
    select pg_catalog.count(*)
    from (
      select distinct value->>'resource_type', value->>'resource_id'
      from pg_catalog.jsonb_array_elements(p_resources) as item(value)
    ) deduplicated
  ) <> v_count then
    raise exception 'TELEPHONY_RESOURCE_SET_INVALID' using errcode = '22023';
  end if;

  for v_resource in
    select value->>'resource_type' as resource_type, (value->>'resource_id')::uuid as resource_id
    from pg_catalog.jsonb_array_elements(p_resources) as item(value)
    order by value->>'resource_type', (value->>'resource_id')::uuid
  loop
    insert into public.motorist_workplace_resource_claims (
      organization_id, resource_type, resource_id
    ) values (
      p_organization_id, v_resource.resource_type, v_resource.resource_id
    ) on conflict (organization_id, resource_type, resource_id) do nothing;

    select * into v_claim
    from public.motorist_workplace_resource_claims
    where organization_id = p_organization_id
      and resource_type = v_resource.resource_type
      and resource_id = v_resource.resource_id
    for update;

    -- Expiry is a recovery signal, never authority to steal an uncertain
    -- provider mutation. Only the exact current operation may renew its claim.
    if v_claim.operation_id is not null and v_claim.operation_id <> p_operation_id then
      raise exception 'TELEPHONY_RESOURCE_BUSY' using errcode = '55P03';
    end if;
    if v_claim.operation_id = p_operation_id
      and v_claim.claim_generation <> v_guard.claim_generation then
      raise exception 'TELEPHONY_RESOURCE_CLAIM_MISMATCH' using errcode = 'P0001';
    end if;

    update public.motorist_workplace_resource_claims
    set
      operation_id = p_operation_id,
      claim_generation = v_guard.claim_generation,
      acquired_at = case when operation_id is null then v_now else acquired_at end,
      expires_at = v_expires_at,
      guard_version = guard_version + 1
    where organization_id = p_organization_id
      and resource_type = v_resource.resource_type
      and resource_id = v_resource.resource_id;
  end loop;

  update public.motorist_telephony_guard_operations
  set claim_expires_at = v_expires_at
  where organization_id = p_organization_id and id = p_operation_id;

  return pg_catalog.jsonb_build_object(
    'operationId', p_operation_id,
    'claimGeneration', v_guard.claim_generation,
    'claimExpiresAt', v_expires_at,
    'databaseNow', v_now,
    'resourceCount', v_count
  );
end;
$$;

create or replace function public.motorist_release_telephony_resource_claims(
  p_organization_id uuid,
  p_operation_id uuid,
  p_claim_generation uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released integer;
begin
  update public.motorist_workplace_resource_claims
  set
    operation_id = null,
    claim_generation = null,
    acquired_at = null,
    expires_at = null,
    guard_version = guard_version + 1
  where organization_id = p_organization_id
    and operation_id = p_operation_id
    and claim_generation = p_claim_generation;
  get diagnostics v_released = row_count;

  if exists (
    select 1 from public.motorist_workplace_resource_claims
    where organization_id = p_organization_id and operation_id = p_operation_id
  ) then
    raise exception 'TELEPHONY_RESOURCE_RELEASE_INCOMPLETE' using errcode = 'P0001';
  end if;
  return v_released;
end;
$$;

create or replace function public.motorist_begin_workplace_operation(
  p_operation_id uuid,
  p_organization_id uuid,
  p_idempotency_key uuid,
  p_intent_hash text,
  p_kind text,
  p_actor_profile_id uuid,
  p_source_extension_id uuid,
  p_target_extension_id uuid,
  p_source_lease_id uuid,
  p_target_lease_id uuid,
  p_browser_instance_id uuid,
  p_expected_source_assignment_generation uuid,
  p_expected_target_assignment_generation uuid,
  p_expected_source_lease_version bigint,
  p_expected_target_lease_version bigint,
  p_expected_source_heartbeat_at timestamptz,
  p_expected_target_heartbeat_at timestamptz,
  p_resources jsonb,
  p_claim_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.motorist_workplace_operations%rowtype;
  v_actor public.motorist_profiles%rowtype;
  v_source public.motorist_telephony_extensions%rowtype;
  v_target public.motorist_telephony_extensions%rowtype;
  v_source_lease public.motorist_workplace_leases%rowtype;
  v_target_lease public.motorist_workplace_leases%rowtype;
  v_source_audit public.motorist_audit_log%rowtype;
  v_target_audit public.motorist_audit_log%rowtype;
  v_expected_target_audit_action text;
  v_expected_target_lifecycle_state text;
  v_expected_target_profile_id text;
  v_claim_generation uuid := pg_catalog.gen_random_uuid();
  v_claim jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  -- Serialize ownership row discovery inside an organization before touching
  -- source/target rows. Canonical resource ordering then protects all later
  -- telephony operations without an A->B/B->A row-lock inversion.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('motorist.workplace.' || p_organization_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_organization_id::text),
    pg_catalog.hashtext(p_idempotency_key::text)
  );

  select * into v_existing
  from public.motorist_workplace_operations
  where organization_id = p_organization_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_existing.id <> p_operation_id
      or v_existing.intent_hash <> p_intent_hash
      or v_existing.kind <> p_kind
      or v_existing.actor_profile_id <> p_actor_profile_id then
      raise exception 'WORKPLACE_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object(
      'operationId', v_existing.id,
      'phase', v_existing.phase,
      'claimGeneration', v_existing.claim_generation,
      'claimExpiresAt', v_existing.claim_expires_at,
      'databaseNow', v_now,
      'idempotent', true,
      'terminalResult', v_existing.result_safe
    );
  end if;

  if p_intent_hash !~ '^[0-9a-f]{64}$'
    or p_kind not in ('claim', 'takeover', 'switch', 'leave', 'browser_transfer') then
    raise exception 'WORKPLACE_INTENT_INVALID' using errcode = '22023';
  end if;
  if (p_kind in ('claim', 'takeover') and (p_source_extension_id is not null or p_target_extension_id is null))
    or (p_kind = 'switch' and (p_source_extension_id is null or p_target_extension_id is null))
    or (p_kind = 'leave' and (p_source_extension_id is null or p_target_extension_id is not null))
    or (p_kind = 'browser_transfer' and (p_source_extension_id is not null or p_target_extension_id is null))
    or (p_source_extension_id is not null and p_source_extension_id = p_target_extension_id) then
    raise exception 'WORKPLACE_INTENT_INVALID' using errcode = '22023';
  end if;

  select * into v_actor
  from public.motorist_profiles
  where organization_id = p_organization_id
    and id = p_actor_profile_id
    and active = true
    and role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')
  for update;
  if not found then
    raise exception 'WORKPLACE_ACTOR_NOT_ELIGIBLE' using errcode = '42501';
  end if;

  if p_source_extension_id is not null then
    select * into v_source
    from public.motorist_telephony_extensions
    where organization_id = p_organization_id and id = p_source_extension_id and active = true
    for update;
    if not found or v_source.workplace_seat_generation is null or v_source.profile_id <> p_actor_profile_id then
      raise exception 'WORKPLACE_SOURCE_MISMATCH' using errcode = 'P0001';
    end if;
    if v_actor.phone_extension is distinct from v_source.extension then
      raise exception 'WORKPLACE_SOURCE_PROFILE_RESERVATION_MISMATCH' using errcode = 'P0001';
    end if;
    if coalesce(v_source.metadata->'assignmentActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_source.metadata->'telephonyActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_source.metadata#>>'{assignmentTransition,active}', 'false') = 'true'
      or coalesce(v_source.metadata#>>'{workplaceOwnerTransition,active}', 'false') = 'true'
      or coalesce(v_source.metadata#>>'{dispatchRouting,operation,status}', '') not in ('', 'completed', 'aborted') then
      raise exception 'WORKPLACE_SOURCE_LEGACY_INTERLOCK_ACTIVE' using errcode = '55P03';
    end if;
    select * into v_source_audit
    from public.motorist_audit_log
    where organization_id = p_organization_id
      and entity_type = 'motorist_telephony_extensions'
      and entity_id = v_source.id
      and action in ('telephony.extension.assign', 'telephony.extension.unassign')
    order by created_at desc, id desc
    limit 1;
    if not found or v_source_audit.action <> 'telephony.extension.assign'
      or v_source_audit.after_payload->'assignment_lifecycle' is distinct from v_source.metadata->'assignmentLifecycle'
      or v_source.metadata#>>'{assignmentLifecycle,state}' is distinct from 'assigned'
      or v_source.metadata#>>'{assignmentLifecycle,profileId}' is distinct from p_actor_profile_id::text then
      raise exception 'WORKPLACE_SOURCE_IMMUTABLE_LIFECYCLE_MISMATCH' using errcode = 'P0001';
    end if;
    if p_source_lease_id is null or p_expected_source_assignment_generation is null
      or p_expected_source_lease_version is null or p_expected_source_heartbeat_at is null then
      raise exception 'WORKPLACE_SOURCE_LEASE_REQUIRED' using errcode = '22023';
    end if;
    select * into v_source_lease
    from public.motorist_workplace_leases
    where organization_id = p_organization_id and id = p_source_lease_id
    for update;
    if found and v_source_lease.expires_at < v_now then
      raise exception 'WORKPLACE_SOURCE_LEASE_EXPIRED' using errcode = '55P03';
    end if;
    if not found or v_source_lease.state <> 'active'
      or v_source_lease.extension_id <> v_source.id
      or v_source_lease.profile_id <> p_actor_profile_id
      or v_source_lease.assignment_generation <> p_expected_source_assignment_generation
      or v_source_lease.lease_version <> p_expected_source_lease_version
      or v_source_lease.heartbeat_at <> p_expected_source_heartbeat_at
      or v_source_lease.browser_instance_id <> p_browser_instance_id
      or v_source.metadata->>'assignmentGeneration' <> p_expected_source_assignment_generation::text then
      raise exception 'WORKPLACE_SOURCE_LEASE_MISMATCH' using errcode = 'P0001';
    end if;
  elsif p_source_lease_id is not null
    or p_expected_source_assignment_generation is not null
    or p_expected_source_lease_version is not null
    or p_expected_source_heartbeat_at is not null then
    raise exception 'WORKPLACE_SOURCE_UNEXPECTED' using errcode = '22023';
  elsif v_actor.phone_extension is not null and p_kind <> 'browser_transfer' then
    raise exception 'WORKPLACE_ACTOR_ALREADY_HAS_SEAT' using errcode = '55P03';
  end if;

  if p_target_extension_id is not null then
    select * into v_target
    from public.motorist_telephony_extensions
    where organization_id = p_organization_id and id = p_target_extension_id and active = true
    for update;
    if not found or v_target.workplace_seat_generation is null then
      raise exception 'WORKPLACE_TARGET_NOT_CANONICAL' using errcode = 'P0001';
    end if;
    if p_kind = 'browser_transfer' and (
      v_target.profile_id is distinct from p_actor_profile_id
      or v_actor.phone_extension is distinct from v_target.extension
    ) then
      raise exception 'WORKPLACE_BROWSER_TRANSFER_OWNER_MISMATCH' using errcode = 'P0001';
    end if;
    if p_expected_target_assignment_generation is null
      or v_target.metadata->>'assignmentGeneration' <> p_expected_target_assignment_generation::text then
      raise exception 'WORKPLACE_TARGET_GENERATION_MISMATCH' using errcode = 'P0001';
    end if;
    if coalesce(v_target.metadata->'assignmentActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_target.metadata->'telephonyActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_target.metadata#>>'{assignmentTransition,active}', 'false') = 'true'
      or coalesce(v_target.metadata#>>'{workplaceOwnerTransition,active}', 'false') = 'true'
      or coalesce(v_target.metadata#>>'{dispatchRouting,operation,status}', '') not in ('', 'completed', 'aborted') then
      raise exception 'WORKPLACE_TARGET_LEGACY_INTERLOCK_ACTIVE' using errcode = '55P03';
    end if;
    v_expected_target_audit_action := case when v_target.profile_id is null
      then 'telephony.extension.unassign' else 'telephony.extension.assign' end;
    v_expected_target_lifecycle_state := case when v_target.profile_id is null
      then 'unassigned' else 'assigned' end;
    v_expected_target_profile_id := case when v_target.profile_id is null
      then null else v_target.profile_id::text end;
    select * into v_target_audit
    from public.motorist_audit_log
    where organization_id = p_organization_id
      and entity_type = 'motorist_telephony_extensions'
      and entity_id = v_target.id
      and action in ('telephony.extension.assign', 'telephony.extension.unassign')
    order by created_at desc, id desc
    limit 1;
    if not found
      or v_target_audit.action is distinct from v_expected_target_audit_action
      or v_target_audit.after_payload->'assignment_lifecycle' is distinct from v_target.metadata->'assignmentLifecycle'
      or v_target.metadata#>>'{assignmentLifecycle,state}' is distinct from v_expected_target_lifecycle_state
      or v_target.metadata#>>'{assignmentLifecycle,profileId}' is distinct from v_expected_target_profile_id then
      raise exception 'WORKPLACE_TARGET_IMMUTABLE_LIFECYCLE_MISMATCH' using errcode = 'P0001';
    end if;

    if v_target.profile_id is null then
      if p_kind in ('takeover', 'browser_transfer') or p_target_lease_id is not null
        or p_expected_target_lease_version is not null or p_expected_target_heartbeat_at is not null then
        raise exception 'WORKPLACE_TARGET_FREE_MISMATCH' using errcode = 'P0001';
      end if;
    else
      if p_kind = 'claim' then
        raise exception 'WORKPLACE_TARGET_OCCUPIED' using errcode = '55P03';
      end if;
      if p_target_lease_id is null or p_expected_target_assignment_generation is null
        or p_expected_target_lease_version is null or p_expected_target_heartbeat_at is null then
        raise exception 'WORKPLACE_TARGET_LEASE_REQUIRED' using errcode = '22023';
      end if;
      select * into v_target_lease
      from public.motorist_workplace_leases
      where organization_id = p_organization_id and id = p_target_lease_id
      for update;
      if not found or v_target_lease.state <> 'active'
        or v_target_lease.extension_id <> v_target.id
        or v_target_lease.profile_id <> v_target.profile_id
        or v_target_lease.assignment_generation <> p_expected_target_assignment_generation
        or v_target_lease.lease_version <> p_expected_target_lease_version
        or v_target_lease.heartbeat_at <> p_expected_target_heartbeat_at then
        raise exception 'WORKPLACE_TARGET_LEASE_MISMATCH' using errcode = 'P0001';
      end if;
      if p_kind = 'browser_transfer'
        and v_target_lease.browser_instance_id = p_browser_instance_id then
        raise exception 'WORKPLACE_BROWSER_TRANSFER_REQUIRES_NEW_BROWSER' using errcode = '22023';
      end if;
      if v_target_lease.expires_at >= v_now then
        raise exception 'WORKPLACE_TARGET_ACTIVE' using errcode = '55P03';
      end if;
    end if;
  end if;

  -- A client cannot omit a resource it wants the operation to mutate. The
  -- generic guard additionally sorts and locks the complete set atomically.
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(p_resources) item(value)
    where value->>'resource_type' = 'profile' and (value->>'resource_id')::uuid = p_actor_profile_id
  ) or (
    p_source_extension_id is not null and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_resources) item(value)
      where value->>'resource_type' = 'extension' and (value->>'resource_id')::uuid = p_source_extension_id
    )
  ) or (
    p_target_extension_id is not null and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_resources) item(value)
      where value->>'resource_type' = 'extension' and (value->>'resource_id')::uuid = p_target_extension_id
    )
  ) or (
    p_source_lease_id is not null and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_resources) item(value)
      where value->>'resource_type' = 'workplace_lease' and (value->>'resource_id')::uuid = p_source_lease_id
    )
  ) or (
    p_target_lease_id is not null and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_resources) item(value)
      where value->>'resource_type' = 'workplace_lease' and (value->>'resource_id')::uuid = p_target_lease_id
    )
  ) or (
    v_target.profile_id is not null and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_resources) item(value)
      where value->>'resource_type' = 'profile' and (value->>'resource_id')::uuid = v_target.profile_id
    )
  ) then
    raise exception 'WORKPLACE_RESOURCE_SET_INCOMPLETE' using errcode = '22023';
  end if;

  insert into public.motorist_workplace_operations (
    id, organization_id, idempotency_key, intent_hash, kind, actor_profile_id,
    source_profile_id, target_previous_profile_id, source_extension_id, target_extension_id,
    source_lease_id, target_lease_id, browser_instance_id,
    expected_source_assignment_generation, expected_target_assignment_generation,
    expected_source_lease_version, expected_target_lease_version,
    expected_source_heartbeat_at, expected_target_heartbeat_at,
    phase, claim_generation, locked_at
  ) values (
    p_operation_id, p_organization_id, p_idempotency_key, p_intent_hash, p_kind, p_actor_profile_id,
    case when p_source_extension_id is null then null else p_actor_profile_id end,
    case when p_target_extension_id is null then null else v_target.profile_id end,
    p_source_extension_id, p_target_extension_id, p_source_lease_id, p_target_lease_id,
    p_browser_instance_id, p_expected_source_assignment_generation,
    p_expected_target_assignment_generation, p_expected_source_lease_version,
    p_expected_target_lease_version, p_expected_source_heartbeat_at,
    p_expected_target_heartbeat_at, 'created', v_claim_generation, v_now
  );
  insert into public.motorist_telephony_guard_operations (
    id, organization_id, kind, owner_entity_type, owner_entity_id, phase,
    recovery_policy, claim_generation, claim_expires_at
  ) values (
    p_operation_id, p_organization_id, 'workplace_' || p_kind, 'workplace_operation',
    p_operation_id, 'created', 'workplace_precommit_abort_postcommit_rollforward',
    v_claim_generation, v_now + interval '90 seconds'
  );

  v_claim := public.motorist_acquire_telephony_resource_claims(
    p_organization_id, p_operation_id, p_resources, p_claim_ttl_seconds
  );
  update public.motorist_workplace_operations
  set phase = 'claimed', claim_expires_at = (v_claim->>'claimExpiresAt')::timestamptz
  where organization_id = p_organization_id and id = p_operation_id;
  update public.motorist_telephony_guard_operations
  set phase = 'claimed'
  where organization_id = p_organization_id and id = p_operation_id;

  return pg_catalog.jsonb_build_object(
    'operationId', p_operation_id,
    'phase', 'claimed',
    'claimGeneration', v_claim_generation,
    'claimExpiresAt', v_claim->'claimExpiresAt',
    'databaseNow', v_now,
    'idempotent', false,
    'terminalResult', null
  );
end;
$$;

create or replace function public.motorist_mark_workplace_provider_checked(
  p_organization_id uuid,
  p_operation_id uuid,
  p_claim_generation uuid,
  p_provider_proof_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation public.motorist_workplace_operations%rowtype;
  v_guard public.motorist_telephony_guard_operations%rowtype;
  v_source_lease public.motorist_workplace_leases%rowtype;
  v_target_lease public.motorist_workplace_leases%rowtype;
  v_source public.motorist_telephony_extensions%rowtype;
  v_target public.motorist_telephony_extensions%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('motorist.workplace.' || p_organization_id::text, 0)
  );
  select * into v_operation
  from public.motorist_workplace_operations
  where organization_id = p_organization_id and id = p_operation_id
  for update;
  select * into v_guard
  from public.motorist_telephony_guard_operations
  where organization_id = p_organization_id and id = p_operation_id
  for update;
  if v_operation.id is null or v_guard.id is null
    or v_operation.claim_generation <> p_claim_generation
    or v_guard.claim_generation <> p_claim_generation
    or v_operation.phase not in ('claimed', 'browser_presence_checked', 'provider_checked')
    or v_guard.terminal_at is not null or v_guard.claim_expires_at <= v_now then
    raise exception 'WORKPLACE_OPERATION_NOT_CLAIMED' using errcode = '55P03';
  end if;
  if p_provider_proof_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'WORKPLACE_PROVIDER_PROOF_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.motorist_workplace_resource_claims claims
    where claims.organization_id = p_organization_id
      and claims.operation_id = p_operation_id
      and claims.claim_generation <> p_claim_generation
  ) or not exists (
    select 1 from public.motorist_workplace_resource_claims claims
    where claims.organization_id = p_organization_id
      and claims.operation_id = p_operation_id
      and claims.claim_generation = p_claim_generation
  ) then
    raise exception 'WORKPLACE_RESOURCE_CLAIM_MISMATCH' using errcode = 'P0001';
  end if;

  if v_operation.source_lease_id is not null then
    select * into v_source
    from public.motorist_telephony_extensions
    where organization_id = p_organization_id and id = v_operation.source_extension_id
    for update;
    if not found or v_source.profile_id <> v_operation.actor_profile_id
      or v_source.metadata->>'assignmentGeneration' is distinct from v_operation.expected_source_assignment_generation::text
      or coalesce(v_source.metadata->'assignmentActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_source.metadata->'telephonyActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_source.metadata#>>'{assignmentTransition,active}', 'false') = 'true'
      or coalesce(v_source.metadata#>>'{workplaceOwnerTransition,active}', 'false') = 'true'
      or coalesce(v_source.metadata#>>'{dispatchRouting,operation,status}', '') not in ('', 'completed', 'aborted') then
      raise exception 'WORKPLACE_SOURCE_CHANGED_AFTER_BEGIN' using errcode = '55P03';
    end if;
    select * into v_source_lease
    from public.motorist_workplace_leases
    where organization_id = p_organization_id and id = v_operation.source_lease_id
    for update;
    if not found or v_source_lease.state <> 'active'
      or v_source_lease.heartbeat_at <> v_operation.expected_source_heartbeat_at
      or v_source_lease.resume_requested_at is not null then
      raise exception 'WORKPLACE_SOURCE_PRESENCE_RESUMED' using errcode = '55P03';
    end if;
  end if;
  if v_operation.target_lease_id is not null then
    select * into v_target
    from public.motorist_telephony_extensions
    where organization_id = p_organization_id and id = v_operation.target_extension_id
    for update;
    if not found or v_target.profile_id is distinct from v_operation.target_previous_profile_id
      or v_target.metadata->>'assignmentGeneration' is distinct from v_operation.expected_target_assignment_generation::text
      or coalesce(v_target.metadata->'assignmentActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_target.metadata->'telephonyActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_target.metadata#>>'{assignmentTransition,active}', 'false') = 'true'
      or coalesce(v_target.metadata#>>'{workplaceOwnerTransition,active}', 'false') = 'true'
      or coalesce(v_target.metadata#>>'{dispatchRouting,operation,status}', '') not in ('', 'completed', 'aborted') then
      raise exception 'WORKPLACE_TARGET_CHANGED_AFTER_BEGIN' using errcode = '55P03';
    end if;
    select * into v_target_lease
    from public.motorist_workplace_leases
    where organization_id = p_organization_id and id = v_operation.target_lease_id
    for update;
    if not found or v_target_lease.state <> 'active'
      or v_target_lease.heartbeat_at <> v_operation.expected_target_heartbeat_at
      or v_target_lease.expires_at >= v_now
      or v_target_lease.resume_requested_at is not null then
      raise exception 'WORKPLACE_TARGET_PRESENCE_RESUMED' using errcode = '55P03';
    end if;
  elsif v_operation.target_extension_id is not null then
    select * into v_target
    from public.motorist_telephony_extensions
    where organization_id = p_organization_id and id = v_operation.target_extension_id
    for update;
    if not found or v_target.profile_id is not null
      or v_target.metadata->>'assignmentGeneration' is distinct from v_operation.expected_target_assignment_generation::text
      or coalesce(v_target.metadata->'assignmentActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_target.metadata->'telephonyActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_target.metadata#>>'{assignmentTransition,active}', 'false') = 'true'
      or coalesce(v_target.metadata#>>'{workplaceOwnerTransition,active}', 'false') = 'true'
      or coalesce(v_target.metadata#>>'{dispatchRouting,operation,status}', '') not in ('', 'completed', 'aborted') then
      raise exception 'WORKPLACE_TARGET_CHANGED_AFTER_BEGIN' using errcode = '55P03';
    end if;
  end if;

  if v_operation.phase = 'provider_checked' then
    if v_operation.provider_proof_hash <> p_provider_proof_hash then
      raise exception 'WORKPLACE_PROVIDER_PROOF_CONFLICT' using errcode = '23505';
    end if;
  else
    update public.motorist_workplace_operations
    set
      phase = 'provider_checked',
      provider_checked_at = v_now,
      provider_proof_hash = p_provider_proof_hash
    where organization_id = p_organization_id and id = p_operation_id;
    update public.motorist_telephony_guard_operations
    set phase = 'provider_checked'
    where organization_id = p_organization_id and id = p_operation_id;
    v_operation.phase := 'provider_checked';
  end if;

  return pg_catalog.jsonb_build_object(
    'operationId', p_operation_id,
    'phase', 'provider_checked',
    'claimGeneration', p_claim_generation,
    'claimExpiresAt', v_guard.claim_expires_at,
    'databaseNow', v_now,
    'idempotent', v_operation.provider_checked_at is not null,
    'terminalResult', null
  );
end;
$$;

create or replace function public.motorist_heartbeat_workplace_lease(
  p_organization_id uuid,
  p_lease_id uuid,
  p_profile_id uuid,
  p_assignment_generation uuid,
  p_browser_instance_id uuid,
  p_leader_epoch bigint,
  p_lease_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease public.motorist_workplace_leases%rowtype;
  v_claim public.motorist_workplace_resource_claims%rowtype;
  v_operation public.motorist_workplace_operations%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select * into v_lease
  from public.motorist_workplace_leases
  where organization_id = p_organization_id and id = p_lease_id
  for update;
  if not found or v_lease.profile_id <> p_profile_id
    or v_lease.assignment_generation <> p_assignment_generation
    or v_lease.state not in ('active', 'ending') then
    return pg_catalog.jsonb_build_object(
      'status', 'lease_lost', 'leaseId', p_lease_id,
      'assignmentGeneration', p_assignment_generation, 'browserInstanceId', null,
      'leaderEpoch', greatest(coalesce(p_leader_epoch, 1), 1),
      'leaseVersion', greatest(coalesce(p_lease_version, 1), 1),
      'expiresAt', null, 'databaseNow', v_now
    );
  end if;

  insert into public.motorist_workplace_resource_claims (
    organization_id, resource_type, resource_id
  ) values (
    p_organization_id, 'workplace_lease', p_lease_id
  ) on conflict (organization_id, resource_type, resource_id) do nothing;
  select * into v_claim
  from public.motorist_workplace_resource_claims
  where organization_id = p_organization_id
    and resource_type = 'workplace_lease' and resource_id = p_lease_id
  for update;

  if v_claim.operation_id is not null then
    select * into v_operation
    from public.motorist_workplace_operations
    where organization_id = p_organization_id and id = v_claim.operation_id;
    if v_operation.id is not null
      and v_operation.phase in ('created', 'claimed', 'browser_presence_checked', 'provider_checked')
      and (
        -- Any heartbeat from a stale takeover target proves that the old
        -- operator returned, even when it carries the previous exact fence.
        v_operation.target_lease_id = v_lease.id
        -- The voluntary source leader is expected to observe transitioning;
        -- another browser/epoch is a resume request and aborts precommit.
        or (
          v_operation.source_lease_id = v_lease.id and (
            v_lease.browser_instance_id <> p_browser_instance_id
            or v_lease.leader_epoch <> p_leader_epoch
            or p_lease_version <= 0
            or p_lease_version > v_lease.lease_version
          )
        )
      ) then
      update public.motorist_workplace_leases
      set resume_requested_at = v_now
      where organization_id = p_organization_id and id = p_lease_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'lease_transitioning', 'leaseId', v_lease.id,
      'assignmentGeneration', v_lease.assignment_generation,
      'browserInstanceId', v_lease.browser_instance_id,
      'leaderEpoch', v_lease.leader_epoch, 'leaseVersion', v_lease.lease_version,
      'expiresAt', v_lease.expires_at, 'databaseNow', v_now
    );
  end if;

  if v_lease.state <> 'active'
    or v_lease.browser_instance_id <> p_browser_instance_id
    or v_lease.leader_epoch <> p_leader_epoch
    or p_lease_version <= 0
    or p_lease_version > v_lease.lease_version then
    return pg_catalog.jsonb_build_object(
      'status', 'lease_lost', 'leaseId', v_lease.id,
      'assignmentGeneration', v_lease.assignment_generation, 'browserInstanceId', null,
      'leaderEpoch', v_lease.leader_epoch, 'leaseVersion', v_lease.lease_version,
      'expiresAt', null, 'databaseNow', v_now
    );
  end if;

  update public.motorist_workplace_leases
  set
    heartbeat_at = v_now,
    expires_at = v_now + interval '60 seconds',
    lease_version = lease_version + 1,
    resume_requested_at = null
  where organization_id = p_organization_id and id = p_lease_id
  returning * into v_lease;

  return pg_catalog.jsonb_build_object(
    'status', 'renewed', 'leaseId', v_lease.id,
    'assignmentGeneration', v_lease.assignment_generation,
    'browserInstanceId', v_lease.browser_instance_id,
    'leaderEpoch', v_lease.leader_epoch, 'leaseVersion', v_lease.lease_version,
    'expiresAt', v_lease.expires_at, 'databaseNow', v_now
  );
end;
$$;

create or replace function public.motorist_resume_workplace_lease(
  p_organization_id uuid,
  p_lease_id uuid,
  p_profile_id uuid,
  p_assignment_generation uuid,
  p_previous_resume_secret_hash text,
  p_new_resume_secret_hash text,
  p_new_browser_instance_id uuid,
  p_expected_leader_epoch bigint,
  p_expected_lease_version bigint,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease public.motorist_workplace_leases%rowtype;
  v_claim public.motorist_workplace_resource_claims%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_idempotency_key is null
    or p_previous_resume_secret_hash !~ '^[0-9a-f]{64}$'
    or p_new_resume_secret_hash !~ '^[0-9a-f]{64}$'
    or p_previous_resume_secret_hash = p_new_resume_secret_hash then
    raise exception 'WORKPLACE_RESUME_SECRET_INVALID' using errcode = '22023';
  end if;
  select * into v_lease
  from public.motorist_workplace_leases
  where organization_id = p_organization_id and id = p_lease_id
  for update;
  if not found or v_lease.profile_id <> p_profile_id
    or v_lease.assignment_generation <> p_assignment_generation
    or v_lease.state <> 'active'
    or not (
      (
        v_lease.resume_secret_hash = p_previous_resume_secret_hash
        and v_lease.leader_epoch = p_expected_leader_epoch
        and v_lease.lease_version = p_expected_lease_version
      )
      or (
        v_lease.resume_secret_hash = p_new_resume_secret_hash
        and v_lease.browser_instance_id = p_new_browser_instance_id
        and v_lease.leader_epoch = p_expected_leader_epoch + 1
        and v_lease.lease_version >= p_expected_lease_version + 1
      )
    ) then
    return pg_catalog.jsonb_build_object(
      'status', 'lease_lost', 'leaseId', p_lease_id,
      'assignmentGeneration', p_assignment_generation, 'browserInstanceId', null,
      'leaderEpoch', greatest(coalesce(p_expected_leader_epoch, 1), 1),
      'leaseVersion', greatest(coalesce(p_expected_lease_version, 1), 1),
      'expiresAt', null, 'databaseNow', v_now
    );
  end if;
  select * into v_claim
  from public.motorist_workplace_resource_claims
  where organization_id = p_organization_id
    and resource_type = 'workplace_lease' and resource_id = p_lease_id
  for update;
  if found and v_claim.operation_id is not null then
    update public.motorist_workplace_leases
    set resume_requested_at = v_now
    where organization_id = p_organization_id and id = p_lease_id;
    return pg_catalog.jsonb_build_object(
      'status', 'lease_transitioning', 'leaseId', v_lease.id,
      'assignmentGeneration', v_lease.assignment_generation,
      'browserInstanceId', v_lease.browser_instance_id,
      'leaderEpoch', v_lease.leader_epoch, 'leaseVersion', v_lease.lease_version,
      'expiresAt', v_lease.expires_at, 'databaseNow', v_now
    );
  end if;

  -- Idempotent replay after the atomic rotation committed but its HTTP/RPC
  -- response was lost. The deterministic next hash, browser and exact epoch
  -- successor jointly bind this replay to the original resume request.
  if v_lease.resume_secret_hash = p_new_resume_secret_hash then
    return pg_catalog.jsonb_build_object(
      'status', 'resumed', 'leaseId', v_lease.id,
      'assignmentGeneration', v_lease.assignment_generation,
      'browserInstanceId', v_lease.browser_instance_id,
      'leaderEpoch', v_lease.leader_epoch, 'leaseVersion', v_lease.lease_version,
      'expiresAt', v_lease.expires_at, 'databaseNow', v_now
    );
  end if;

  update public.motorist_workplace_leases
  set
    browser_instance_id = p_new_browser_instance_id,
    resume_secret_hash = p_new_resume_secret_hash,
    leader_epoch = leader_epoch + 1,
    lease_version = lease_version + 1,
    heartbeat_at = v_now,
    expires_at = v_now + interval '60 seconds',
    resume_requested_at = null
  where organization_id = p_organization_id and id = p_lease_id
  returning * into v_lease;
  return pg_catalog.jsonb_build_object(
    'status', 'resumed', 'leaseId', v_lease.id,
    'assignmentGeneration', v_lease.assignment_generation,
    'browserInstanceId', v_lease.browser_instance_id,
    'leaderEpoch', v_lease.leader_epoch, 'leaseVersion', v_lease.lease_version,
    'expiresAt', v_lease.expires_at, 'databaseNow', v_now
  );
end;
$$;

create or replace function public.motorist_verify_workplace_lease(
  p_organization_id uuid,
  p_profile_id uuid,
  p_extension_id uuid,
  p_lease_id uuid,
  p_assignment_generation uuid,
  p_browser_instance_id uuid,
  p_leader_epoch bigint,
  p_lease_version bigint,
  p_require_fence boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease public.motorist_workplace_leases%rowtype;
  v_extension public.motorist_telephony_extensions%rowtype;
  v_claim public.motorist_workplace_resource_claims%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_status text;
begin
  select * into v_extension
  from public.motorist_telephony_extensions
  where organization_id = p_organization_id and id = p_extension_id and active = true
  for share;
  select * into v_lease
  from public.motorist_workplace_leases
  where organization_id = p_organization_id
    and profile_id = p_profile_id
    and extension_id = p_extension_id
    and state in ('active', 'ending')
  for share;
  if not found or v_extension.id is null
    or v_extension.workplace_seat_generation is null
    or v_extension.profile_id <> v_lease.profile_id
    or v_extension.metadata->>'assignmentGeneration' is distinct from v_lease.assignment_generation::text then
    return pg_catalog.jsonb_build_object(
      'status', 'lease_lost', 'leaseId', null, 'assignmentGeneration', null,
      'browserInstanceId', null, 'leaderEpoch', null, 'leaseVersion', null,
      'expiresAt', null, 'databaseNow', v_now
    );
  end if;

  select * into v_claim
  from public.motorist_workplace_resource_claims
  where organization_id = p_organization_id
    and resource_type = 'workplace_lease' and resource_id = v_lease.id
  for share;
  if found and v_claim.operation_id is not null then
    v_status := 'transitioning';
  elsif coalesce(p_require_fence, true) and (
    p_lease_id is null or p_assignment_generation is null or p_browser_instance_id is null
    or p_leader_epoch is null or p_lease_version is null
    or v_lease.id <> p_lease_id
    or v_lease.assignment_generation <> p_assignment_generation
    or v_lease.browser_instance_id <> p_browser_instance_id
    or v_lease.leader_epoch <> p_leader_epoch
    -- A heartbeat may safely advance the server version between UI capture and
    -- action verification. Future/invalid versions fail; stale versions remain
    -- fenced by browser instance + leader epoch + assignment generation.
    or p_lease_version <= 0
    or p_lease_version > v_lease.lease_version
  ) then
    v_status := 'lease_lost';
  elsif v_lease.state = 'ending' then
    v_status := 'transitioning';
  elsif v_now > v_lease.expires_at then
    v_status := 'expired';
  else
    v_status := 'verified';
  end if;

  return pg_catalog.jsonb_build_object(
    'status', v_status, 'leaseId', v_lease.id,
    'assignmentGeneration', v_lease.assignment_generation,
    'browserInstanceId', v_lease.browser_instance_id,
    'leaderEpoch', v_lease.leader_epoch, 'leaseVersion', v_lease.lease_version,
    'expiresAt', v_lease.expires_at, 'databaseNow', v_now
  );
end;
$$;

create or replace function public.motorist_workplace_database_now()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('databaseNow', pg_catalog.clock_timestamp());
$$;

create or replace function public.motorist_finalize_workplace_operation(
  p_organization_id uuid,
  p_operation_id uuid,
  p_claim_generation uuid,
  p_new_lease_id uuid,
  p_new_assignment_generation uuid,
  p_new_browser_instance_id uuid,
  p_new_resume_secret_hash text,
  p_source_lifecycle jsonb,
  p_target_lifecycle jsonb,
  p_source_unassign_audit_id uuid,
  p_target_unassign_audit_id uuid,
  p_target_assign_audit_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation public.motorist_workplace_operations%rowtype;
  v_guard public.motorist_telephony_guard_operations%rowtype;
  v_actor public.motorist_profiles%rowtype;
  v_source public.motorist_telephony_extensions%rowtype;
  v_target public.motorist_telephony_extensions%rowtype;
  v_displaced public.motorist_profiles%rowtype;
  v_source_lease public.motorist_workplace_leases%rowtype;
  v_target_lease public.motorist_workplace_leases%rowtype;
  v_new_lease public.motorist_workplace_leases%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_result jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('motorist.workplace.' || p_organization_id::text, 0)
  );
  select * into v_operation
  from public.motorist_workplace_operations
  where organization_id = p_organization_id and id = p_operation_id
  for update;
  select * into v_guard
  from public.motorist_telephony_guard_operations
  where organization_id = p_organization_id and id = p_operation_id
  for update;
  if v_operation.id is null or v_guard.id is null
    or v_operation.claim_generation <> p_claim_generation
    or v_guard.claim_generation <> p_claim_generation then
    raise exception 'WORKPLACE_OPERATION_CLAIM_MISMATCH' using errcode = 'P0001';
  end if;
  if v_operation.phase = 'completed' then
    return v_operation.result_safe;
  end if;
  if v_operation.phase <> 'provider_checked' or v_guard.terminal_at is not null
    or v_guard.claim_expires_at <= v_now then
    raise exception 'WORKPLACE_OPERATION_NOT_FINALIZABLE' using errcode = '55P03';
  end if;
  if exists (
    select 1 from public.motorist_workplace_resource_claims claims
    where claims.organization_id = p_organization_id
      and claims.operation_id = p_operation_id
      and claims.claim_generation <> p_claim_generation
  ) or not exists (
    select 1 from public.motorist_workplace_resource_claims claims
    where claims.organization_id = p_organization_id
      and claims.operation_id = p_operation_id
      and claims.claim_generation = p_claim_generation
  ) then
    raise exception 'WORKPLACE_RESOURCE_CLAIM_MISMATCH' using errcode = 'P0001';
  end if;

  select * into v_actor
  from public.motorist_profiles
  where organization_id = p_organization_id
    and id = v_operation.actor_profile_id
    and active = true
    and role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')
  for update;
  if not found then
    raise exception 'WORKPLACE_ACTOR_NOT_ELIGIBLE' using errcode = '42501';
  end if;

  if v_operation.source_extension_id is not null then
    select * into v_source
    from public.motorist_telephony_extensions
    where organization_id = p_organization_id and id = v_operation.source_extension_id and active = true
    for update;
    select * into v_source_lease
    from public.motorist_workplace_leases
    where organization_id = p_organization_id and id = v_operation.source_lease_id
    for update;
    if v_source.id is null or v_source.profile_id <> v_operation.actor_profile_id
      or v_actor.phone_extension is distinct from v_source.extension
      or v_source.metadata->>'assignmentGeneration' is distinct from v_operation.expected_source_assignment_generation::text
      or coalesce(v_source.metadata->'assignmentActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_source.metadata->'telephonyActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_source.metadata#>>'{assignmentTransition,active}', 'false') = 'true'
      or coalesce(v_source.metadata#>>'{workplaceOwnerTransition,active}', 'false') = 'true'
      or coalesce(v_source.metadata#>>'{dispatchRouting,operation,status}', '') not in ('', 'completed', 'aborted')
      or v_source_lease.id is null or v_source_lease.state <> 'active'
      or v_source_lease.profile_id <> v_operation.actor_profile_id
      or v_source_lease.assignment_generation <> v_operation.expected_source_assignment_generation
      or v_source_lease.lease_version <> v_operation.expected_source_lease_version
      or v_source_lease.heartbeat_at <> v_operation.expected_source_heartbeat_at
      or v_source_lease.resume_requested_at is not null then
      raise exception 'WORKPLACE_SOURCE_CHANGED' using errcode = '55P03';
    end if;
    if p_source_unassign_audit_id is null or p_source_lifecycle is null
      or p_source_lifecycle->>'schemaVersion' is distinct from '1'
      or p_source_lifecycle->>'state' is distinct from 'unassigned'
      or p_source_lifecycle->>'assignmentMode' is distinct from 'workplace_claim'
      or p_source_lifecycle->>'extensionId' is distinct from v_source.id::text
      or p_source_lifecycle->>'extension' is distinct from v_source.extension
      or p_source_lifecycle->'profileId' is distinct from 'null'::jsonb
      or p_source_lifecycle->>'epoch' is distinct from v_operation.expected_source_assignment_generation::text
      or p_source_lifecycle->>'unassignedBy' is distinct from v_operation.actor_profile_id::text
      or not coalesce(p_source_lifecycle->>'unassignedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then
      raise exception 'WORKPLACE_SOURCE_LIFECYCLE_INVALID' using errcode = '22023';
    end if;
  elsif p_source_unassign_audit_id is not null or p_source_lifecycle is not null then
    raise exception 'WORKPLACE_SOURCE_LIFECYCLE_UNEXPECTED' using errcode = '22023';
  end if;

  if v_operation.target_extension_id is not null then
    select * into v_target
    from public.motorist_telephony_extensions
    where organization_id = p_organization_id and id = v_operation.target_extension_id and active = true
    for update;
    if not found or v_target.workplace_seat_generation is null
      or v_target.profile_id is distinct from v_operation.target_previous_profile_id
      or v_target.metadata->>'assignmentGeneration' is distinct from v_operation.expected_target_assignment_generation::text
      or coalesce(v_target.metadata->'assignmentActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_target.metadata->'telephonyActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(v_target.metadata#>>'{assignmentTransition,active}', 'false') = 'true'
      or coalesce(v_target.metadata#>>'{workplaceOwnerTransition,active}', 'false') = 'true'
      or coalesce(v_target.metadata#>>'{dispatchRouting,operation,status}', '') not in ('', 'completed', 'aborted') then
      raise exception 'WORKPLACE_TARGET_CHANGED' using errcode = '55P03';
    end if;
    if v_operation.target_lease_id is not null then
      select * into v_target_lease
      from public.motorist_workplace_leases
      where organization_id = p_organization_id and id = v_operation.target_lease_id
      for update;
      if not found or v_target_lease.state <> 'active'
        or v_target_lease.profile_id <> v_operation.target_previous_profile_id
        or v_target_lease.assignment_generation <> v_operation.expected_target_assignment_generation
        or v_target_lease.lease_version <> v_operation.expected_target_lease_version
        or v_target_lease.heartbeat_at <> v_operation.expected_target_heartbeat_at
        or v_target_lease.expires_at >= v_now or v_target_lease.resume_requested_at is not null then
        raise exception 'WORKPLACE_TARGET_PRESENCE_CHANGED' using errcode = '55P03';
      end if;
    elsif v_target.profile_id is not null then
      raise exception 'WORKPLACE_TARGET_LEASE_MISSING' using errcode = 'P0001';
    end if;
    if p_new_lease_id is null or p_new_assignment_generation is null
      or p_new_browser_instance_id is null or p_new_resume_secret_hash !~ '^[0-9a-f]{64}$'
      or p_target_assign_audit_id is null or p_target_unassign_audit_id is not null
      or p_target_lifecycle is null
      or p_target_lifecycle->>'schemaVersion' is distinct from '1'
      or p_target_lifecycle->>'state' is distinct from 'assigned'
      or p_target_lifecycle->>'assignmentMode' is distinct from 'workplace_claim'
      or p_target_lifecycle->>'extensionId' is distinct from v_target.id::text
      or p_target_lifecycle->>'extension' is distinct from v_target.extension
      or p_target_lifecycle->>'profileId' is distinct from v_operation.actor_profile_id::text
      or p_target_lifecycle->>'epoch' is distinct from p_new_assignment_generation::text
      or p_target_lifecycle->>'assignedBy' is distinct from v_operation.actor_profile_id::text
      or not coalesce(p_target_lifecycle->>'assignedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then
      raise exception 'WORKPLACE_TARGET_LIFECYCLE_INVALID' using errcode = '22023';
    end if;
  elsif p_new_lease_id is not null or p_new_assignment_generation is not null
    or p_new_browser_instance_id is not null or p_new_resume_secret_hash is not null
    or p_target_lifecycle is not null or p_target_unassign_audit_id is not null
    or p_target_assign_audit_id is not null then
    raise exception 'WORKPLACE_TARGET_LIFECYCLE_UNEXPECTED' using errcode = '22023';
  end if;
  if v_operation.source_extension_id is null and v_actor.phone_extension is not null
    and (
      v_operation.kind <> 'browser_transfer'
      or v_operation.target_extension_id is null
      or v_operation.target_previous_profile_id is distinct from v_operation.actor_profile_id
      or v_actor.phone_extension is distinct from v_target.extension
    ) then
    raise exception 'WORKPLACE_ACTOR_ALREADY_HAS_SEAT' using errcode = '55P03';
  end if;

  update public.motorist_workplace_operations
  set phase = 'ownership_committed', committed_at = v_now,
      source_unassign_audit_id = p_source_unassign_audit_id,
      target_unassign_audit_id = p_target_unassign_audit_id,
      target_assign_audit_id = p_target_assign_audit_id
  where organization_id = p_organization_id and id = p_operation_id;
  update public.motorist_telephony_guard_operations
  set phase = 'ownership_committed'
  where organization_id = p_organization_id and id = p_operation_id;

  if v_operation.source_extension_id is not null then
    update public.motorist_workplace_leases
    set state = 'ended', ended_at = v_now,
        ended_reason = case when v_operation.kind = 'switch' then 'switched_seat' else 'left_seat' end
    where organization_id = p_organization_id and id = v_source_lease.id;
    update public.motorist_telephony_extensions
    set
      profile_id = null,
      display_name = null,
      metadata = pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(metadata, '{assignmentGeneration}', pg_catalog.to_jsonb(p_source_lifecycle->>'epoch'), true),
        '{assignmentLifecycle}', p_source_lifecycle, true
      )
    where organization_id = p_organization_id and id = v_source.id;
    update public.motorist_profiles
    set phone_extension = null
    where organization_id = p_organization_id and id = v_operation.actor_profile_id
      and phone_extension = v_source.extension;
    insert into public.motorist_audit_log (
      id, organization_id, actor_profile_id, action, entity_type, entity_id, source,
      before_payload, after_payload
    ) values (
      p_source_unassign_audit_id, p_organization_id, v_operation.actor_profile_id,
      'telephony.extension.unassign', 'motorist_telephony_extensions', v_source.id, 'web',
      pg_catalog.jsonb_build_object(
        'extension', v_source.extension, 'profile_id', v_operation.actor_profile_id,
        'assignment_lifecycle', v_source.metadata->'assignmentLifecycle', 'operation_id', p_operation_id
      ),
      pg_catalog.jsonb_build_object(
        'extension', v_source.extension, 'profile_id', null,
        'sharing_mode', 'workplace_claim', 'assignment_lifecycle', p_source_lifecycle,
        'operation_id', p_operation_id
      )
    );
  end if;

  if v_operation.target_extension_id is not null then
    if v_operation.target_previous_profile_id is not null then
      select * into v_displaced
      from public.motorist_profiles
      where organization_id = p_organization_id and id = v_operation.target_previous_profile_id
      for update;
      if not found or v_displaced.phone_extension <> v_target.extension then
        raise exception 'WORKPLACE_DISPLACED_PROFILE_MISMATCH' using errcode = 'P0001';
      end if;
      if v_operation.kind = 'browser_transfer' then
        if v_displaced.id <> v_operation.actor_profile_id then
          raise exception 'WORKPLACE_BROWSER_TRANSFER_OWNER_CHANGED' using errcode = 'P0001';
        end if;
      else
        update public.motorist_profiles
        set phone_extension = null
        where organization_id = p_organization_id and id = v_displaced.id;
      end if;
      update public.motorist_workplace_leases
      set state = 'revoked', ended_at = v_now,
          ended_reason = case when v_operation.kind = 'browser_transfer'
            then 'browser_transfer' else 'offline_takeover' end,
          revoked_by = v_operation.actor_profile_id
      where organization_id = p_organization_id and id = v_target_lease.id;
    end if;

    update public.motorist_telephony_extensions
    set
      profile_id = v_operation.actor_profile_id,
      display_name = v_actor.display_name,
      metadata = pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(metadata, '{assignmentGeneration}', pg_catalog.to_jsonb(p_new_assignment_generation::text), true),
        '{assignmentLifecycle}', p_target_lifecycle, true
      )
    where organization_id = p_organization_id and id = v_target.id;
    update public.motorist_profiles
    set phone_extension = v_target.extension
    where organization_id = p_organization_id and id = v_operation.actor_profile_id;

    insert into public.motorist_workplace_leases (
      id, organization_id, extension_id, profile_id, assignment_generation,
      browser_instance_id, lease_version, leader_epoch, resume_secret_hash,
      state, claimed_at, heartbeat_at, expires_at
    ) values (
      p_new_lease_id, p_organization_id, v_target.id, v_operation.actor_profile_id,
      p_new_assignment_generation, p_new_browser_instance_id, 1, 1,
      p_new_resume_secret_hash, 'active', v_now, v_now, v_now + interval '60 seconds'
    ) returning * into v_new_lease;

    insert into public.motorist_audit_log (
      id, organization_id, actor_profile_id, action, entity_type, entity_id, source,
      before_payload, after_payload
    ) values (
      p_target_assign_audit_id, p_organization_id, v_operation.actor_profile_id,
      'telephony.extension.assign', 'motorist_telephony_extensions', v_target.id, 'web',
      pg_catalog.jsonb_build_object(
        'extension', v_target.extension, 'profile_id', v_operation.target_previous_profile_id,
        'assignment_lifecycle', v_target.metadata->'assignmentLifecycle', 'operation_id', p_operation_id
      ),
      pg_catalog.jsonb_build_object(
        'extension', v_target.extension, 'profile_id', v_operation.actor_profile_id,
        'previous_profile_id', v_operation.target_previous_profile_id,
        'sharing_mode', 'workplace_claim', 'assignment_lifecycle', p_target_lifecycle,
        'operation_id', p_operation_id, 'lease_id', p_new_lease_id
      )
    );
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'operationId', p_operation_id,
    'phase', 'completed',
    'leaseId', v_new_lease.id,
    'assignmentGeneration', v_new_lease.assignment_generation,
    'leaderEpoch', v_new_lease.leader_epoch,
    'leaseVersion', v_new_lease.lease_version,
    'expiresAt', v_new_lease.expires_at,
    'databaseNow', v_now
  );
  update public.motorist_workplace_operations
  set phase = 'completed', completed_at = v_now, result_safe = v_result
  where organization_id = p_organization_id and id = p_operation_id;
  perform public.motorist_release_telephony_resource_claims(
    p_organization_id, p_operation_id, p_claim_generation
  );
  update public.motorist_telephony_guard_operations
  set phase = 'completed', terminal_at = v_now
  where organization_id = p_organization_id and id = p_operation_id;
  return v_result;
end;
$$;

create or replace function public.motorist_abort_workplace_operation(
  p_organization_id uuid,
  p_operation_id uuid,
  p_claim_generation uuid,
  p_error_safe text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation public.motorist_workplace_operations%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('motorist.workplace.' || p_organization_id::text, 0)
  );
  select * into v_operation
  from public.motorist_workplace_operations
  where organization_id = p_organization_id and id = p_operation_id
  for update;
  if not found or v_operation.claim_generation <> p_claim_generation then
    raise exception 'WORKPLACE_OPERATION_CLAIM_MISMATCH' using errcode = 'P0001';
  end if;
  if v_operation.phase = 'aborted' then
    return pg_catalog.jsonb_build_object(
      'operationId', p_operation_id, 'phase', 'aborted', 'databaseNow', v_now
    );
  end if;
  if v_operation.phase in ('ownership_committed', 'audits_verified', 'completed') then
    raise exception 'WORKPLACE_OPERATION_MUST_ROLL_FORWARD' using errcode = 'P0001';
  end if;
  update public.motorist_workplace_operations
  set phase = 'aborted', completed_at = v_now,
      last_error_safe = pg_catalog.left(coalesce(p_error_safe, 'Operation aborted.'), 1000),
      result_safe = pg_catalog.jsonb_build_object(
        'operationId', p_operation_id, 'phase', 'aborted', 'databaseNow', v_now
      )
  where organization_id = p_organization_id and id = p_operation_id;
  perform public.motorist_release_telephony_resource_claims(
    p_organization_id, p_operation_id, p_claim_generation
  );
  update public.motorist_telephony_guard_operations
  set phase = 'aborted', terminal_at = v_now,
      last_error_safe = pg_catalog.left(coalesce(p_error_safe, 'Operation aborted.'), 1000)
  where organization_id = p_organization_id and id = p_operation_id
    and claim_generation = p_claim_generation;
  return pg_catalog.jsonb_build_object(
    'operationId', p_operation_id, 'phase', 'aborted', 'databaseNow', v_now
  );
end;
$$;

create or replace function public.motorist_recover_expired_workplace_operation(
  p_organization_id uuid,
  p_operation_id uuid,
  p_recovery_owner text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation public.motorist_workplace_operations%rowtype;
  v_guard public.motorist_telephony_guard_operations%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('motorist.workplace.' || p_organization_id::text, 0)
  );
  if p_recovery_owner !~ '^[a-zA-Z0-9._:-]{8,128}$' then
    raise exception 'WORKPLACE_RECOVERY_OWNER_INVALID' using errcode = '22023';
  end if;
  select * into v_operation
  from public.motorist_workplace_operations
  where organization_id = p_organization_id and id = p_operation_id
  for update;
  select * into v_guard
  from public.motorist_telephony_guard_operations
  where organization_id = p_organization_id and id = p_operation_id
  for update;
  if v_operation.id is null or v_guard.id is null
    or v_operation.claim_generation <> v_guard.claim_generation then
    raise exception 'WORKPLACE_RECOVERY_STATE_MISMATCH' using errcode = 'P0001';
  end if;
  if v_operation.phase = 'aborted' then
    return coalesce(v_operation.result_safe, pg_catalog.jsonb_build_object(
      'operationId', p_operation_id, 'phase', 'aborted', 'databaseNow', v_now
    ));
  end if;
  if v_operation.phase in ('ownership_committed', 'audits_verified', 'completed') then
    raise exception 'WORKPLACE_OPERATION_MUST_ROLL_FORWARD' using errcode = 'P0001';
  end if;
  if v_operation.phase not in ('created', 'claimed', 'browser_presence_checked', 'provider_checked')
    or v_operation.claim_expires_at is null or v_operation.claim_expires_at >= v_now
    or v_guard.claim_expires_at >= v_now or v_guard.terminal_at is not null then
    raise exception 'WORKPLACE_OPERATION_NOT_RECOVERABLE' using errcode = '55P03';
  end if;

  update public.motorist_workplace_operations
  set recovery_owner = p_recovery_owner,
      recovery_expires_at = v_now + interval '30 seconds',
      phase = 'aborted', completed_at = v_now,
      last_error_safe = 'Expired precommit operation recovered safely.',
      result_safe = pg_catalog.jsonb_build_object(
        'operationId', p_operation_id, 'phase', 'aborted',
        'recovered', true, 'databaseNow', v_now
      )
  where organization_id = p_organization_id and id = p_operation_id
    and claim_generation = v_operation.claim_generation;
  perform public.motorist_release_telephony_resource_claims(
    p_organization_id, p_operation_id, v_operation.claim_generation
  );
  update public.motorist_telephony_guard_operations
  set phase = 'aborted', terminal_at = v_now,
      last_error_safe = 'Expired precommit operation recovered safely.'
  where organization_id = p_organization_id and id = p_operation_id
    and claim_generation = v_operation.claim_generation;
  return pg_catalog.jsonb_build_object(
    'operationId', p_operation_id, 'phase', 'aborted',
    'recovered', true, 'databaseNow', v_now
  );
end;
$$;

revoke all on function public.motorist_acquire_telephony_resource_claims(uuid, uuid, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.motorist_release_telephony_resource_claims(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.motorist_begin_workplace_operation(
  uuid, uuid, uuid, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  bigint, bigint, timestamptz, timestamptz, jsonb, integer
) from public, anon, authenticated;
revoke all on function public.motorist_mark_workplace_provider_checked(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.motorist_heartbeat_workplace_lease(uuid, uuid, uuid, uuid, uuid, bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.motorist_resume_workplace_lease(uuid, uuid, uuid, uuid, text, text, uuid, bigint, bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.motorist_verify_workplace_lease(uuid, uuid, uuid, uuid, uuid, uuid, bigint, bigint, boolean)
  from public, anon, authenticated;
revoke all on function public.motorist_workplace_database_now()
  from public, anon, authenticated;
revoke all on function public.motorist_finalize_workplace_operation(
  uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, uuid, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.motorist_abort_workplace_operation(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.motorist_recover_expired_workplace_operation(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.motorist_acquire_telephony_resource_claims(uuid, uuid, jsonb, integer)
  to service_role;
grant execute on function public.motorist_release_telephony_resource_claims(uuid, uuid, uuid)
  to service_role;
grant execute on function public.motorist_begin_workplace_operation(
  uuid, uuid, uuid, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  bigint, bigint, timestamptz, timestamptz, jsonb, integer
) to service_role;
grant execute on function public.motorist_mark_workplace_provider_checked(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.motorist_heartbeat_workplace_lease(uuid, uuid, uuid, uuid, uuid, bigint, bigint)
  to service_role;
grant execute on function public.motorist_resume_workplace_lease(uuid, uuid, uuid, uuid, text, text, uuid, bigint, bigint, uuid)
  to service_role;
grant execute on function public.motorist_verify_workplace_lease(uuid, uuid, uuid, uuid, uuid, uuid, bigint, bigint, boolean)
  to service_role;
grant execute on function public.motorist_workplace_database_now()
  to service_role;
grant execute on function public.motorist_finalize_workplace_operation(
  uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, uuid, uuid, uuid
) to service_role;
grant execute on function public.motorist_abort_workplace_operation(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.motorist_recover_expired_workplace_operation(uuid, uuid, text)
  to service_role;

alter function public.motorist_acquire_telephony_resource_claims(uuid, uuid, jsonb, integer) owner to postgres;
alter function public.motorist_release_telephony_resource_claims(uuid, uuid, uuid) owner to postgres;
alter function public.motorist_begin_workplace_operation(
  uuid, uuid, uuid, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
  bigint, bigint, timestamptz, timestamptz, jsonb, integer
) owner to postgres;
alter function public.motorist_mark_workplace_provider_checked(uuid, uuid, uuid, text) owner to postgres;
alter function public.motorist_heartbeat_workplace_lease(uuid, uuid, uuid, uuid, uuid, bigint, bigint) owner to postgres;
alter function public.motorist_resume_workplace_lease(uuid, uuid, uuid, uuid, text, text, uuid, bigint, bigint, uuid) owner to postgres;
alter function public.motorist_verify_workplace_lease(uuid, uuid, uuid, uuid, uuid, uuid, bigint, bigint, boolean) owner to postgres;
alter function public.motorist_workplace_database_now() owner to postgres;
alter function public.motorist_finalize_workplace_operation(
  uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, uuid, uuid, uuid
) owner to postgres;
alter function public.motorist_abort_workplace_operation(uuid, uuid, uuid, text) owner to postgres;
alter function public.motorist_recover_expired_workplace_operation(uuid, uuid, text) owner to postgres;
