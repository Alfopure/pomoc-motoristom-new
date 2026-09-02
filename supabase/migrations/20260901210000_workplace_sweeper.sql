-- Durable recovery for stuck workplace state.
--
-- Until now nothing recovered expired workplace operations unless a browser was
-- open: `recoverExpiredWorkplaceOperations` runs only inside request handlers,
-- and in practice it ran because the console polls workplace-selection every ten
-- seconds. Close every console and expired operations, orphaned resource claims
-- and abandoned leases persist indefinitely.
--
-- Three gaps are closed here, all additively:
--
--   1. A claim whose owning operation already finished could never be released.
--      `motorist_acquire_telephony_resource_claims` refuses any resource held by
--      a different operation, and only finalize/abort/recover release one -- so a
--      crash between the phase write and the release left the seat busy forever.
--   2. `manual_recovery_required` is declared in the operations CHECK constraint
--      and handled in the application, but no code ever wrote it. The roll-forward
--      branch it guards was therefore unreachable.
--   3. An expired lease had no reaper.
--
-- Every function here is additive and none of them touches
-- `motorist_telephony_extensions`. Reaping a lease must never null extension
-- ownership: those are correlated state machines and half-releasing them is what
-- produces the "stuck in a workstation" reports in the first place.

-- ---------------------------------------------------------------------------
-- 1. Claim acquisition: raise the TTL ceiling and self-heal a terminal owner.
-- ---------------------------------------------------------------------------
-- The ceiling moves from 120s to 300s because the switch/leave flow returns
-- `disconnect_required` and then waits for a human to unplug a desk phone, while
-- finalize hard-rejects an expired guard. Anyone slower than the old 90s window
-- lost the operation and landed in exactly the orphaned-claim trap above. The
-- default stays 90 so no existing caller changes behaviour.
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
  v_owner_phase text;
  v_owner_terminal_at timestamptz;
  v_count integer;
  v_ttl integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_expires_at timestamptz;
begin
  v_ttl := greatest(30, least(coalesce(p_claim_ttl_seconds, 90), 300));
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
    --
    -- The one exception is provable rather than time-based: if the owning
    -- operation is already terminal AND its guard is terminal, the release
    -- simply crashed between the phase write and the release call. No uncertain
    -- provider mutation can still be outstanding behind a terminal guard, so the
    -- claim is safe to reclaim. Age alone still grants nothing.
    if v_claim.operation_id is not null and v_claim.operation_id <> p_operation_id then
      select o.phase, g.terminal_at into v_owner_phase, v_owner_terminal_at
      from public.motorist_workplace_operations o
      left join public.motorist_telephony_guard_operations g
        on g.organization_id = o.organization_id and g.id = o.id
      where o.organization_id = p_organization_id and o.id = v_claim.operation_id;

      if v_owner_phase in ('completed', 'aborted') and v_owner_terminal_at is not null then
        update public.motorist_workplace_resource_claims
        set operation_id = null,
            claim_generation = null,
            acquired_at = null,
            expires_at = null,
            guard_version = guard_version + 1,
            last_released_reason = 'TERMINAL_OWNER_RECLAIMED',
            last_released_at = v_now
        where organization_id = p_organization_id
          and resource_type = v_resource.resource_type
          and resource_id = v_resource.resource_id;
        select * into v_claim
        from public.motorist_workplace_resource_claims
        where organization_id = p_organization_id
          and resource_type = v_resource.resource_type
          and resource_id = v_resource.resource_id
        for update;
      else
        raise exception 'TELEPHONY_RESOURCE_BUSY' using errcode = '55P03';
      end if;
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

-- ---------------------------------------------------------------------------
-- 2. Renew a precommit claim while waiting for a human to disconnect.
-- ---------------------------------------------------------------------------
create or replace function public.motorist_renew_workplace_operation_claim(
  p_organization_id uuid,
  p_operation_id uuid,
  p_claim_generation uuid,
  p_claim_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation public.motorist_workplace_operations%rowtype;
  v_guard public.motorist_telephony_guard_operations%rowtype;
  v_resources jsonb;
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
  if v_operation.id is null or v_guard.id is null then
    raise exception 'WORKPLACE_RECOVERY_STATE_MISMATCH' using errcode = 'P0001';
  end if;
  if v_operation.claim_generation <> p_claim_generation
    or v_guard.claim_generation <> p_claim_generation then
    raise exception 'WORKPLACE_OPERATION_CLAIM_MISMATCH' using errcode = 'P0001';
  end if;
  if v_guard.terminal_at is not null then
    raise exception 'TELEPHONY_GUARD_OPERATION_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  -- Only a precommit operation may be extended. Once ownership is committed the
  -- operation must roll forward, not linger.
  if v_operation.phase not in ('created', 'claimed', 'browser_presence_checked', 'provider_checked') then
    raise exception 'WORKPLACE_OPERATION_NOT_CLAIMED' using errcode = 'P0001';
  end if;

  -- Renew exactly the set this operation already holds; never widen it.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object('resource_type', resource_type, 'resource_id', resource_id)
  ) into v_resources
  from public.motorist_workplace_resource_claims
  where organization_id = p_organization_id and operation_id = p_operation_id;
  if v_resources is null then
    raise exception 'WORKPLACE_RESOURCE_SET_INCOMPLETE' using errcode = 'P0001';
  end if;

  perform public.motorist_acquire_telephony_resource_claims(
    p_organization_id, p_operation_id, v_resources, p_claim_ttl_seconds
  );
  return pg_catalog.jsonb_build_object(
    'operationId', p_operation_id,
    'claimGeneration', p_claim_generation,
    'databaseNow', v_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Sweeper: release claims whose owning operation is already terminal.
-- ---------------------------------------------------------------------------
create or replace function public.motorist_release_terminal_telephony_resource_claims(
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
  v_released integer := 0;
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
  if v_operation.id is null then
    raise exception 'WORKPLACE_RECOVERY_STATE_MISMATCH' using errcode = 'P0001';
  end if;
  if v_operation.phase not in ('completed', 'aborted')
    and (v_guard.id is null or v_guard.terminal_at is null) then
    raise exception 'WORKPLACE_OPERATION_NOT_RECOVERABLE' using errcode = '55P03';
  end if;

  -- Never free a resource that a live lease still depends on. An extension or
  -- lease whose lease is active and heartbeating belongs to somebody working.
  if exists (
    select 1
    from public.motorist_workplace_resource_claims c
    join public.motorist_workplace_leases l
      on l.organization_id = c.organization_id
     and (l.id = c.resource_id or l.extension_id = c.resource_id)
    where c.organization_id = p_organization_id
      and c.operation_id = p_operation_id
      and c.resource_type in ('extension', 'workplace_lease')
      and l.state = 'active'
      and l.expires_at > v_now
  ) then
    raise exception 'TELEPHONY_RESOURCE_BUSY' using errcode = '55P03';
  end if;

  update public.motorist_workplace_resource_claims
  set operation_id = null,
      claim_generation = null,
      acquired_at = null,
      expires_at = null,
      guard_version = guard_version + 1,
      last_released_reason = 'TERMINAL_OWNER_SWEPT',
      last_released_at = v_now
  where organization_id = p_organization_id and operation_id = p_operation_id;
  get diagnostics v_released = row_count;

  -- Mirror the operation's own terminal phase rather than always saying
  -- "aborted": a completed operation whose release merely crashed did not fail.
  if v_guard.id is not null and v_guard.terminal_at is null then
    update public.motorist_telephony_guard_operations
    set phase = case when v_operation.phase = 'completed' then 'completed' else 'aborted' end,
        terminal_at = v_now,
        last_error_safe = 'Terminal operation claims released by sweeper.'
    where organization_id = p_organization_id and id = p_operation_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'operationId', p_operation_id,
    'releasedClaims', v_released,
    'recoveryOwner', p_recovery_owner,
    'databaseNow', v_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The first writer of `manual_recovery_required`.
-- ---------------------------------------------------------------------------
-- A post-commit operation must never be silently released: its claims stay held
-- until somebody rolls it forward. Marking it makes it visible and unblocks the
-- application branches that already handle this phase but could never see it.
create or replace function public.motorist_mark_workplace_operation_manual_recovery(
  p_organization_id uuid,
  p_operation_id uuid,
  p_recovery_owner text,
  p_reason_safe text
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
  if p_recovery_owner !~ '^[a-zA-Z0-9._:-]{8,128}$' then
    raise exception 'WORKPLACE_RECOVERY_OWNER_INVALID' using errcode = '22023';
  end if;
  if p_reason_safe is null or p_reason_safe !~ '^[A-Za-z0-9 ._:-]{3,200}$' then
    raise exception 'WORKPLACE_RECOVERY_REASON_INVALID' using errcode = '22023';
  end if;
  select * into v_operation
  from public.motorist_workplace_operations
  where organization_id = p_organization_id and id = p_operation_id
  for update;
  if v_operation.id is null then
    raise exception 'WORKPLACE_RECOVERY_STATE_MISMATCH' using errcode = 'P0001';
  end if;
  if v_operation.phase = 'manual_recovery_required' then
    return coalesce(v_operation.result_safe, pg_catalog.jsonb_build_object(
      'operationId', p_operation_id, 'phase', 'manual_recovery_required', 'databaseNow', v_now
    ));
  end if;
  if v_operation.phase not in ('ownership_committed', 'audits_verified') then
    raise exception 'WORKPLACE_OPERATION_NOT_RECOVERABLE' using errcode = '55P03';
  end if;

  update public.motorist_workplace_operations
  set phase = 'manual_recovery_required',
      recovery_owner = p_recovery_owner,
      recovery_expires_at = v_now + interval '30 seconds',
      last_error_safe = p_reason_safe
  where organization_id = p_organization_id and id = p_operation_id
    and claim_generation = v_operation.claim_generation;

  return pg_catalog.jsonb_build_object(
    'operationId', p_operation_id,
    'phase', 'manual_recovery_required',
    'databaseNow', v_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Reap an expired lease -- and nothing else.
-- ---------------------------------------------------------------------------
-- Deliberately does not touch motorist_telephony_extensions. Ending the lease is
-- what lets availability derivation drop the operator; extension ownership stays
-- until a real leave or takeover. Half-releasing these correlated rows is the
-- documented way to make a workstation permanently stuck.
create or replace function public.motorist_reap_expired_workplace_lease(
  p_organization_id uuid,
  p_lease_id uuid,
  p_recovery_owner text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease public.motorist_workplace_leases%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('motorist.workplace.' || p_organization_id::text, 0)
  );
  if p_recovery_owner !~ '^[a-zA-Z0-9._:-]{8,128}$' then
    raise exception 'WORKPLACE_RECOVERY_OWNER_INVALID' using errcode = '22023';
  end if;
  select * into v_lease
  from public.motorist_workplace_leases
  where organization_id = p_organization_id and id = p_lease_id
  for update;
  if v_lease.id is null then
    raise exception 'WORKPLACE_RECOVERY_STATE_MISMATCH' using errcode = 'P0001';
  end if;
  if v_lease.state not in ('active', 'ending') then
    return pg_catalog.jsonb_build_object(
      'leaseId', p_lease_id, 'state', v_lease.state, 'reaped', false, 'databaseNow', v_now
    );
  end if;
  -- Five minutes past expiry, not merely expired: a lease that is only just
  -- late is a browser that may still be recovering.
  if v_lease.expires_at >= v_now - interval '5 minutes' then
    raise exception 'WORKPLACE_OPERATION_NOT_RECOVERABLE' using errcode = '55P03';
  end if;
  -- A lease referenced by a live operation, or still held by a resource claim,
  -- belongs to that operation's recovery path rather than to this reaper.
  if exists (
    select 1 from public.motorist_workplace_operations
    where organization_id = p_organization_id
      and (source_lease_id = p_lease_id or target_lease_id = p_lease_id)
      and phase not in ('completed', 'aborted')
  ) or exists (
    select 1 from public.motorist_workplace_resource_claims
    where organization_id = p_organization_id
      and operation_id is not null
      and resource_type = 'workplace_lease'
      and resource_id = p_lease_id
  ) then
    raise exception 'TELEPHONY_RESOURCE_BUSY' using errcode = '55P03';
  end if;

  update public.motorist_workplace_leases
  set state = 'ended', ended_at = v_now, ended_reason = 'expired_swept'
  where organization_id = p_organization_id and id = p_lease_id
    and state = v_lease.state;

  return pg_catalog.jsonb_build_object(
    'leaseId', p_lease_id,
    'state', 'ended',
    'reaped', true,
    'recoveryOwner', p_recovery_owner,
    'databaseNow', v_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Supporting columns and index.
-- ---------------------------------------------------------------------------
alter table public.motorist_workplace_resource_claims
  add column if not exists last_released_reason text,
  add column if not exists last_released_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'motorist_workplace_resource_claims_release_reason_check'
  ) then
    alter table public.motorist_workplace_resource_claims
      add constraint motorist_workplace_resource_claims_release_reason_check
      check (last_released_reason is null or last_released_reason ~ '^[A-Z][A-Z0-9_]{2,64}$');
  end if;
end;
$$;

create index if not exists motorist_guard_operations_terminal_idx
  on public.motorist_telephony_guard_operations (organization_id, terminal_at, claim_expires_at);

-- ---------------------------------------------------------------------------
-- Privileges: service-role only, exactly like the rest of the hot-desk surface.
-- ---------------------------------------------------------------------------
revoke all on function public.motorist_acquire_telephony_resource_claims(uuid, uuid, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.motorist_renew_workplace_operation_claim(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.motorist_release_terminal_telephony_resource_claims(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.motorist_mark_workplace_operation_manual_recovery(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.motorist_reap_expired_workplace_lease(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.motorist_acquire_telephony_resource_claims(uuid, uuid, jsonb, integer)
  to service_role;
grant execute on function public.motorist_renew_workplace_operation_claim(uuid, uuid, uuid, integer)
  to service_role;
grant execute on function public.motorist_release_terminal_telephony_resource_claims(uuid, uuid, text)
  to service_role;
grant execute on function public.motorist_mark_workplace_operation_manual_recovery(uuid, uuid, text, text)
  to service_role;
grant execute on function public.motorist_reap_expired_workplace_lease(uuid, uuid, text)
  to service_role;

alter function public.motorist_acquire_telephony_resource_claims(uuid, uuid, jsonb, integer) owner to postgres;
alter function public.motorist_renew_workplace_operation_claim(uuid, uuid, uuid, integer) owner to postgres;
alter function public.motorist_release_terminal_telephony_resource_claims(uuid, uuid, text) owner to postgres;
alter function public.motorist_mark_workplace_operation_manual_recovery(uuid, uuid, text, text) owner to postgres;
alter function public.motorist_reap_expired_workplace_lease(uuid, uuid, text) owner to postgres;

-- ---------------------------------------------------------------------------
-- Job control row, inserted disabled.
-- ---------------------------------------------------------------------------
-- Enabling the sweeper is a separate, explicit operational step taken only after
-- a clean worker heartbeat on the release that contains it.
insert into public.motorist_job_controls (job_name, enabled)
values ('telephony.workplace.sweep', false)
on conflict (job_name) do nothing;
