-- MANUAL ONLY: guarded rollback of one VIPTel 20-23 bootstrap batch.
--
-- Rollback succeeds only while every extension, bootstrap lease, terminal
-- lifecycle audit, routing snapshot and durable guard is exactly the state
-- recorded by the apply receipt. Immutable audit history is never deleted.
\set ON_ERROR_STOP on

do $migration_precondition$
begin
  if pg_catalog.to_regclass('public.motorist_workplace_leases') is null
    or pg_catalog.to_regclass('public.motorist_workplace_resource_claims') is null
    or pg_catalog.to_regclass('public.motorist_workplace_bootstrap_receipts') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'motorist_telephony_extensions'
        and column_name = 'workplace_seat_generation'
    ) then
    raise exception 'HOTDESK_BOOTSTRAP_APPLY_RECEIPT_REQUIRED' using errcode = '55000';
  end if;
end
$migration_precondition$;

\if :{?organization_id}
\else
  \echo 'Missing -v organization_id=<uuid>'
  \quit
\endif
\if :{?actor_profile_id}
\else
  \echo 'Missing -v actor_profile_id=<manager-or-admin-uuid>'
  \quit
\endif
\if :{?bootstrap_batch_id}
\else
  \echo 'Missing -v bootstrap_batch_id=<uuid-from-apply>'
  \quit
\endif
\if :{?provider_evidence_not_before}
\else
  \echo 'Missing -v provider_evidence_not_before=<ISO-8601>'
  \quit
\endif

drop table if exists pg_temp.motorist_workplace_bootstrap_rollback_input;
create temporary table motorist_workplace_bootstrap_rollback_input (
  organization_id uuid not null,
  actor_profile_id uuid not null,
  bootstrap_batch_id uuid not null,
  provider_evidence_not_before timestamptz not null
) on commit preserve rows;
insert into motorist_workplace_bootstrap_rollback_input values (
  :'organization_id'::uuid, :'actor_profile_id'::uuid, :'bootstrap_batch_id'::uuid,
  :'provider_evidence_not_before'::timestamptz
);

begin isolation level serializable;

drop table if exists pg_temp.motorist_workplace_bootstrap_rollback_runtime;
create temporary table motorist_workplace_bootstrap_rollback_runtime (
  already_rolled_back boolean not null default false
) on commit drop;
insert into motorist_workplace_bootstrap_rollback_runtime default values;

do $rollback$
declare
  v_org uuid;
  v_actor uuid;
  v_batch uuid;
  v_evidence timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_count integer;
  v_receipt public.motorist_workplace_bootstrap_receipts%rowtype;
  v_rollback_audit_id uuid;
  v_prior_lifecycle jsonb;
  v_action text;
begin
  select organization_id, actor_profile_id, bootstrap_batch_id, provider_evidence_not_before
    into strict v_org, v_actor, v_batch, v_evidence
  from pg_temp.motorist_workplace_bootstrap_rollback_input;
  if v_evidence > v_now + interval '5 seconds' or v_evidence < v_now - interval '5 minutes' then
    raise exception 'HOTDESK_BOOTSTRAP_PROVIDER_EVIDENCE_STALE' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_org::text, 2086234981));

  if not exists (
    select 1 from public.motorist_profiles
    where organization_id = v_org and id = v_actor and active = true and role in ('manager', 'admin')
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ACTOR_NOT_ELIGIBLE' using errcode = '42501';
  end if;
  select pg_catalog.count(*) into v_count
  from public.motorist_workplace_bootstrap_receipts
  where organization_id = v_org and bootstrap_batch_id = v_batch;
  if v_count <> 4 then
    raise exception 'HOTDESK_BOOTSTRAP_ROLLBACK_BATCH_NOT_EXACT' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.motorist_workplace_bootstrap_receipts
    where organization_id = v_org and bootstrap_batch_id = v_batch and rolled_back_at is null
  ) then
    if exists (
      select 1
      from public.motorist_workplace_bootstrap_receipts r
      join public.motorist_telephony_extensions e
        on e.organization_id = r.organization_id and e.id = r.extension_id
      left join public.motorist_workplace_leases l
        on l.organization_id = r.organization_id and l.id = r.bootstrap_lease_id
      where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
        and (r.rolled_back_at is null or r.rollback_audit_id is null
          or e.profile_id is distinct from r.before_profile_id
          or e.display_name is distinct from r.before_display_name
          or e.metadata is distinct from r.before_metadata
          or e.workplace_seat_generation is distinct from r.before_workplace_seat_generation
          or l.id is not null
          or not exists (
            select 1 from public.motorist_audit_log a
            where a.organization_id = r.organization_id and a.id = r.rollback_audit_id
              and a.entity_type = 'motorist_telephony_extensions' and a.entity_id = r.extension_id
          ))
    ) then
      raise exception 'HOTDESK_BOOTSTRAP_ROLLBACK_IDEMPOTENT_STATE_CHANGED' using errcode = '55P03';
    end if;
    update pg_temp.motorist_workplace_bootstrap_rollback_runtime set already_rolled_back = true;
    return;
  end if;
  if exists (
    select 1 from public.motorist_workplace_bootstrap_receipts
    where organization_id = v_org and bootstrap_batch_id = v_batch and rolled_back_at is not null
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ROLLBACK_PARTIAL_RECEIPT' using errcode = 'P0001';
  end if;

  -- Follow runtime lock order: durable claims first, then profiles, queues,
  -- extensions and leases. Missing/changed claim rows are rejected below.
  perform 1
  from public.motorist_workplace_resource_claims c
  join lateral (
    select distinct item->>'resourceType' as resource_type, (item->>'resourceId')::uuid as resource_id
    from public.motorist_workplace_bootstrap_receipts r,
      lateral pg_catalog.jsonb_array_elements(r.guard_snapshot) item
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
  ) expected on expected.resource_type = c.resource_type and expected.resource_id = c.resource_id
  where c.organization_id = v_org
  order by c.resource_type, c.resource_id
  for update of c;

  perform 1 from public.motorist_profiles p
  where p.organization_id = v_org and (
    p.id = v_actor or p.id in (
      select coalesce(r.after_profile_id, r.before_profile_id)
      from public.motorist_workplace_bootstrap_receipts r
      where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
    ) or p.id in (
      select r.before_profile_id from public.motorist_workplace_bootstrap_receipts r
      where r.organization_id = v_org and r.bootstrap_batch_id = v_batch and r.before_profile_id is not null
    )
  ) order by p.id for update;
  perform 1 from public.motorist_telephony_queues q
  where q.organization_id = v_org and q.id in (
    select (item->>'id')::uuid
    from public.motorist_workplace_bootstrap_receipts r,
      lateral pg_catalog.jsonb_array_elements(r.routing_snapshot) item
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
  ) order by q.id for update;
  perform 1 from public.motorist_telephony_extensions e
  where e.organization_id = v_org and e.id in (
    select r.extension_id from public.motorist_workplace_bootstrap_receipts r
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
  ) order by e.id for update;
  perform 1 from public.motorist_workplace_leases l
  where l.organization_id = v_org and l.id in (
    select r.bootstrap_lease_id from public.motorist_workplace_bootstrap_receipts r
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch and r.bootstrap_lease_id is not null
  ) order by l.id for update;

  if not exists (
    select 1 from public.motorist_profiles
    where organization_id = v_org and id = v_actor and active = true and role in ('manager', 'admin')
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ACTOR_CHANGED' using errcode = '42501';
  end if;
  if exists (
    select 1
    from public.motorist_workplace_bootstrap_receipts r
    join public.motorist_telephony_extensions e
      on e.organization_id = r.organization_id and e.id = r.extension_id
    left join public.motorist_workplace_leases l
      on l.organization_id = r.organization_id and l.id = r.bootstrap_lease_id
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
      and (e.provider <> 'viptel' or e.active is distinct from true
        or e.extension is distinct from r.extension
        or e.profile_id is distinct from r.after_profile_id
        or e.display_name is distinct from r.after_display_name
        or e.metadata is distinct from r.after_metadata
        or e.workplace_seat_generation is distinct from r.after_workplace_seat_generation
        or e.last_synced_at is null or e.last_synced_at < v_evidence
        or e.is_registered is distinct from false or e.is_viptel_phone_active is distinct from false
        or (r.bootstrap_lease_id is null and l.id is not null)
        or (r.bootstrap_lease_id is not null and pg_catalog.to_jsonb(l) is distinct from r.bootstrap_lease_row)
        or r.terminal_audit_id is distinct from (
          select a.id from public.motorist_audit_log a
          where a.organization_id = r.organization_id
            and a.entity_type = 'motorist_telephony_extensions' and a.entity_id = r.extension_id
            and a.action in ('telephony.extension.assign', 'telephony.extension.unassign')
          order by a.created_at desc, a.id desc limit 1
        ))
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ROLLBACK_STATE_CHANGED' using errcode = '55P03';
  end if;
  if exists (
    select 1 from public.motorist_workplace_bootstrap_receipts r
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
      and ((r.after_profile_id is not null and not exists (
        select 1 from public.motorist_profiles p
        where p.organization_id = r.organization_id and p.id = r.after_profile_id
          and p.active = true and p.phone_extension = r.extension
          and p.role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')
      )) or (r.after_profile_id is null and exists (
        select 1 from public.motorist_profiles p
        where p.organization_id = r.organization_id and p.phone_extension = r.extension
      )))
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ROLLBACK_PROFILE_PROJECTION_CHANGED' using errcode = '55P03';
  end if;

  if exists (
    select 1
    from public.motorist_workplace_bootstrap_receipts r,
      lateral pg_catalog.jsonb_array_elements(r.guard_snapshot) expected
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
      and not exists (
        select 1 from public.motorist_workplace_resource_claims c
        where c.organization_id = v_org
          and c.resource_type = expected->>'resourceType'
          and c.resource_id = (expected->>'resourceId')::uuid
          and c.guard_version = (expected->>'guardVersion')::bigint
          and c.operation_id is null
      )
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ROLLBACK_GUARD_CHANGED' using errcode = '55P03';
  end if;
  if exists (
    select 1
    from public.motorist_workplace_bootstrap_receipts r,
      lateral pg_catalog.jsonb_array_elements(r.routing_snapshot) expected
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
      and not exists (
        select 1 from public.motorist_telephony_queues q
        where q.organization_id = v_org and q.id = (expected->>'id')::uuid
          and q.provider = 'viptel' and q.active = true
          and q.external_id = expected->>'externalId'
          and q.line_id is not distinct from nullif(expected->>'lineId', '')::uuid
          and q.metadata = expected->'metadata'
      )
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ROLLBACK_ROUTING_CHANGED' using errcode = '55P03';
  end if;
  if exists (
    select 1 from public.motorist_calls c
    join public.motorist_workplace_bootstrap_receipts r
      on r.organization_id = c.organization_id
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
      and c.provider = 'viptel' and c.status not in ('ended', 'failed', 'missed', 'abandoned_queue')
      and (c.extension_id = r.extension_id or c.caller_extension = r.extension
        or c.received_extension = r.extension or c.destination_extension = r.extension)
  ) or exists (
    select 1 from public.motorist_telephony_commands c
    join public.motorist_workplace_bootstrap_receipts r on r.organization_id = c.organization_id
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
      and c.provider = 'viptel' and c.status in ('queued', 'sent', 'accepted')
      and (c.extension_id = r.extension_id or c.request_payload->>'extension' = r.extension
        or c.request_payload#>>'{assignmentGuard,extension}' = r.extension
        or pg_catalog.jsonb_path_exists(
          c.request_payload, '$.** ? (@ == $extension)',
          pg_catalog.jsonb_build_object('extension', r.extension)
        ))
  ) or exists (
    select 1 from public.motorist_queue_memberships m
    join public.motorist_workplace_bootstrap_receipts r
      on r.organization_id = m.organization_id and r.extension = m.extension_number
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
      and m.provider = 'viptel' and (m.in_use = true or m.last_synced_at is null or m.last_synced_at < v_evidence)
  ) or exists (
    select 1 from public.motorist_workplace_operations o
    join public.motorist_workplace_bootstrap_receipts r
      on r.organization_id = o.organization_id
      and r.extension_id in (o.source_extension_id, o.target_extension_id)
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
      and o.phase not in ('completed', 'aborted')
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ROLLBACK_LIVE_ACTIVITY_PRESENT' using errcode = '55P03';
  end if;

  for v_receipt in
    select * from public.motorist_workplace_bootstrap_receipts
    where organization_id = v_org and bootstrap_batch_id = v_batch
    order by extension
  loop
    if v_receipt.bootstrap_lease_id is not null then
      delete from public.motorist_workplace_leases as lease
      where lease.organization_id = v_org and lease.id = v_receipt.bootstrap_lease_id
        and pg_catalog.to_jsonb(lease) = v_receipt.bootstrap_lease_row;
      if not found then
        raise exception 'HOTDESK_BOOTSTRAP_ROLLBACK_LEASE_CAS_FAILED' using errcode = '40001';
      end if;
    end if;

    update public.motorist_telephony_extensions
    set profile_id = v_receipt.before_profile_id,
        display_name = v_receipt.before_display_name,
        metadata = v_receipt.before_metadata,
        workplace_seat_generation = v_receipt.before_workplace_seat_generation
    where organization_id = v_org and id = v_receipt.extension_id
      and profile_id is not distinct from v_receipt.after_profile_id
      and display_name is not distinct from v_receipt.after_display_name
      and metadata = v_receipt.after_metadata
      and workplace_seat_generation = v_receipt.after_workplace_seat_generation;
    if not found then
      raise exception 'HOTDESK_BOOTSTRAP_ROLLBACK_EXTENSION_CAS_FAILED' using errcode = '40001';
    end if;

    v_rollback_audit_id := gen_random_uuid();
    v_prior_lifecycle := v_receipt.before_metadata->'assignmentLifecycle';
    v_action := case
      when pg_catalog.jsonb_typeof(v_prior_lifecycle) = 'object'
        and v_prior_lifecycle->>'state' = 'assigned' then 'telephony.extension.assign'
      when pg_catalog.jsonb_typeof(v_prior_lifecycle) = 'object'
        and v_prior_lifecycle->>'state' = 'unassigned' then 'telephony.extension.unassign'
      else 'telephony.extension.bootstrap.rollback'
    end;
    insert into public.motorist_audit_log (
      id, organization_id, actor_profile_id, action, entity_type, entity_id, source,
      before_payload, after_payload, created_at
    ) values (
      v_rollback_audit_id, v_org, v_actor, v_action,
      'motorist_telephony_extensions', v_receipt.extension_id, 'manual_bootstrap_rollback',
      pg_catalog.jsonb_build_object(
        'extension', v_receipt.extension, 'profile_id', v_receipt.after_profile_id,
        'assignment_lifecycle', v_receipt.after_metadata->'assignmentLifecycle',
        'bootstrap_batch_id', v_batch
      ),
      pg_catalog.jsonb_build_object(
        'extension', v_receipt.extension, 'profile_id', v_receipt.before_profile_id,
        'assignment_lifecycle', v_prior_lifecycle, 'bootstrap_batch_id', v_batch,
        'immutable_bootstrap_history_retained', true,
        'requires_rotation_before_reprovisioning', v_prior_lifecycle is null
      ),
      v_now
    );
    update public.motorist_workplace_bootstrap_receipts
    set rolled_back_at = v_now, rollback_audit_id = v_rollback_audit_id
    where organization_id = v_org and id = v_receipt.id and rolled_back_at is null;
    if not found then
      raise exception 'HOTDESK_BOOTSTRAP_ROLLBACK_RECEIPT_CAS_FAILED' using errcode = '40001';
    end if;
  end loop;
end
$rollback$;

select
  r.extension,
  r.before_profile_id as restored_profile_id,
  r.before_workplace_seat_generation as restored_workplace_seat_generation,
  r.rollback_audit_id,
  r.rolled_back_at,
  runtime.already_rolled_back
from public.motorist_workplace_bootstrap_receipts r
cross join pg_temp.motorist_workplace_bootstrap_rollback_runtime runtime
where r.organization_id = :'organization_id'::uuid
  and r.bootstrap_batch_id = :'bootstrap_batch_id'::uuid
order by r.extension;

commit;
drop table pg_temp.motorist_workplace_bootstrap_rollback_input;
