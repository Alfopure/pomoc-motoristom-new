-- MANUAL ONLY: canonicalize VIPTel extensions 20-23 as dynamic workplaces.
--
-- This script is intentionally outside supabase/migrations. It never changes
-- queue membership, queue ordering, VIPTel, or a browser session. Run it only
-- after viptel-workplace-bootstrap-preflight.sql and the maintenance/provider
-- checks in docs/operations/viptel-workplace-bootstrap.md.
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
    )
    or pg_catalog.to_regprocedure(
      'public.motorist_begin_workplace_operation(uuid,uuid,uuid,text,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,bigint,timestamptz,timestamptz,jsonb,integer)'
    ) is null then
    raise exception 'HOTDESK_BOOTSTRAP_MIGRATION_20260807102059_REQUIRED' using errcode = '55000';
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
  \echo 'Missing -v bootstrap_batch_id=<new-uuid>'
  \quit
\endif
\if :{?provider_evidence_not_before}
\else
  \echo 'Missing -v provider_evidence_not_before=<ISO-8601>'
  \quit
\endif
\if :{?seat20_profile_id}
\else
  \echo 'Missing -v seat20_profile_id=<uuid-or-empty>'
  \quit
\endif
\if :{?seat21_profile_id}
\else
  \echo 'Missing -v seat21_profile_id=<uuid-or-empty>'
  \quit
\endif
\if :{?seat22_profile_id}
\else
  \echo 'Missing -v seat22_profile_id=<uuid-or-empty>'
  \quit
\endif
\if :{?seat23_profile_id}
\else
  \echo 'Missing -v seat23_profile_id=<uuid-or-empty>'
  \quit
\endif

drop table if exists pg_temp.motorist_workplace_bootstrap_input;
create temporary table motorist_workplace_bootstrap_input (
  organization_id uuid not null,
  actor_profile_id uuid not null,
  bootstrap_batch_id uuid not null,
  provider_evidence_not_before timestamptz not null,
  extension text not null,
  expected_profile_id uuid,
  primary key (extension)
) on commit preserve rows;

insert into motorist_workplace_bootstrap_input values
  (:'organization_id'::uuid, :'actor_profile_id'::uuid, :'bootstrap_batch_id'::uuid,
    :'provider_evidence_not_before'::timestamptz, '20', nullif(:'seat20_profile_id', '')::uuid),
  (:'organization_id'::uuid, :'actor_profile_id'::uuid, :'bootstrap_batch_id'::uuid,
    :'provider_evidence_not_before'::timestamptz, '21', nullif(:'seat21_profile_id', '')::uuid),
  (:'organization_id'::uuid, :'actor_profile_id'::uuid, :'bootstrap_batch_id'::uuid,
    :'provider_evidence_not_before'::timestamptz, '22', nullif(:'seat22_profile_id', '')::uuid),
  (:'organization_id'::uuid, :'actor_profile_id'::uuid, :'bootstrap_batch_id'::uuid,
    :'provider_evidence_not_before'::timestamptz, '23', nullif(:'seat23_profile_id', '')::uuid);

begin isolation level serializable;

drop table if exists pg_temp.motorist_workplace_bootstrap_runtime;
create temporary table motorist_workplace_bootstrap_runtime (
  already_applied boolean not null default false,
  guard_snapshot jsonb,
  routing_snapshot jsonb
) on commit drop;
insert into motorist_workplace_bootstrap_runtime default values;

do $apply$
declare
  v_org uuid;
  v_actor uuid;
  v_batch uuid;
  v_evidence timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_iso text;
  v_existing_count integer;
  v_guard_snapshot jsonb;
  v_routing_snapshot jsonb;
  v_extension public.motorist_telephony_extensions%rowtype;
  v_input record;
  v_profile public.motorist_profiles%rowtype;
  v_lifecycle jsonb;
  v_after_metadata jsonb;
  v_seat_generation uuid;
  v_assignment_generation uuid;
  v_audit_id uuid;
  v_lease_id uuid;
  v_lease_row jsonb;
  v_receipt_id uuid;
begin
  select organization_id, actor_profile_id, bootstrap_batch_id, provider_evidence_not_before
    into strict v_org, v_actor, v_batch, v_evidence
  from pg_temp.motorist_workplace_bootstrap_input limit 1;
  v_iso := pg_catalog.to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  if v_evidence > v_now + interval '5 seconds' or v_evidence < v_now - interval '5 minutes' then
    raise exception 'HOTDESK_BOOTSTRAP_PROVIDER_EVIDENCE_STALE' using errcode = '22023';
  end if;
  if (select pg_catalog.count(*) from pg_temp.motorist_workplace_bootstrap_input) <> 4
    or (select pg_catalog.array_agg(extension order by extension) from pg_temp.motorist_workplace_bootstrap_input)
      <> array['20','21','22','23']::text[] then
    raise exception 'HOTDESK_BOOTSTRAP_SEAT_SET_INVALID' using errcode = '22023';
  end if;
  if (select pg_catalog.count(distinct expected_profile_id)
      from pg_temp.motorist_workplace_bootstrap_input where expected_profile_id is not null)
    <> (select pg_catalog.count(*) from pg_temp.motorist_workplace_bootstrap_input where expected_profile_id is not null) then
    raise exception 'HOTDESK_BOOTSTRAP_DUPLICATE_PROFILE' using errcode = '23505';
  end if;

  -- Serialize all manual batches for the organization. Runtime operations use
  -- the durable resource rows below; this lock only coordinates this runbook.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_org::text, 2086234981));

  if not exists (
    select 1 from public.motorist_profiles
    where organization_id = v_org and id = v_actor and active = true and role in ('manager', 'admin')
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ACTOR_NOT_ELIGIBLE' using errcode = '42501';
  end if;

  select pg_catalog.count(*) into v_existing_count
  from public.motorist_workplace_bootstrap_receipts
  where organization_id = v_org and bootstrap_batch_id = v_batch;
  if v_existing_count > 0 then
    if v_existing_count <> 4 or exists (
      select 1
      from pg_temp.motorist_workplace_bootstrap_input i
      left join public.motorist_workplace_bootstrap_receipts r
        on r.organization_id = i.organization_id and r.bootstrap_batch_id = i.bootstrap_batch_id
       and r.extension = i.extension
      where r.id is null or r.rolled_back_at is not null
        or r.actor_profile_id <> i.actor_profile_id
        or r.provider_evidence_not_before <> i.provider_evidence_not_before
        or r.expected_profile_id is distinct from i.expected_profile_id
    ) then
      raise exception 'HOTDESK_BOOTSTRAP_BATCH_REUSE_MISMATCH' using errcode = 'P0001';
    end if;
    if exists (
      select 1
      from public.motorist_workplace_bootstrap_receipts r
      join public.motorist_telephony_extensions e
        on e.organization_id = r.organization_id and e.id = r.extension_id
      left join public.motorist_workplace_leases l
        on l.organization_id = r.organization_id and l.id = r.bootstrap_lease_id
      where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
        and (e.profile_id is distinct from r.after_profile_id
          or e.display_name is distinct from r.after_display_name
          or e.metadata is distinct from r.after_metadata
          or e.workplace_seat_generation is distinct from r.after_workplace_seat_generation
          or (r.bootstrap_lease_id is null and l.id is not null)
          or (r.bootstrap_lease_id is not null and pg_catalog.to_jsonb(l) is distinct from r.bootstrap_lease_row)
          or not exists (
            select 1 from public.motorist_audit_log a
            where a.organization_id = r.organization_id and a.id = r.terminal_audit_id
              and a.entity_type = 'motorist_telephony_extensions' and a.entity_id = r.extension_id
              and a.after_payload->'assignment_lifecycle' = r.after_metadata->'assignmentLifecycle'
          )
          or r.terminal_audit_id is distinct from (
            select a.id from public.motorist_audit_log a
            where a.organization_id = r.organization_id
              and a.entity_type = 'motorist_telephony_extensions' and a.entity_id = r.extension_id
              and a.action in ('telephony.extension.assign', 'telephony.extension.unassign')
            order by a.created_at desc, a.id desc limit 1
          ))
    ) then
      raise exception 'HOTDESK_BOOTSTRAP_IDEMPOTENT_STATE_CHANGED' using errcode = '55P03';
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
    ) or exists (
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
      raise exception 'HOTDESK_BOOTSTRAP_IDEMPOTENT_GUARD_CHANGED' using errcode = '55P03';
    end if;
    update pg_temp.motorist_workplace_bootstrap_runtime set already_applied = true;
    return;
  end if;

  if exists (
    select 1 from public.motorist_workplace_bootstrap_receipts r
    join public.motorist_telephony_extensions e
      on e.organization_id = r.organization_id and e.id = r.extension_id
    join pg_temp.motorist_workplace_bootstrap_input i
      on i.organization_id = e.organization_id and i.extension = e.extension
    where r.rolled_back_at is null
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_SEAT_ALREADY_RECEIPTED' using errcode = '55P03';
  end if;
  if (select pg_catalog.count(*) from public.motorist_telephony_extensions e
      join pg_temp.motorist_workplace_bootstrap_input i
        on i.organization_id = e.organization_id and i.extension = e.extension
      where e.provider = 'viptel' and e.active = true) <> 4 then
    raise exception 'HOTDESK_BOOTSTRAP_SEAT_CATALOG_MISMATCH' using errcode = 'P0001';
  end if;
  if (select pg_catalog.count(*) from public.motorist_telephony_queues q
      where q.organization_id = v_org and q.provider = 'viptel' and q.active = true
        and q.external_id in ('601','602','603')) <> 3
    or not exists (
      select 1 from public.motorist_telephony_queues q
      where q.organization_id = v_org and q.provider = 'viptel' and q.active = true
        and q.external_id = '601' and q.line_id is null
    ) then
    raise exception 'HOTDESK_BOOTSTRAP_QUEUE_CATALOG_MISMATCH' using errcode = 'P0001';
  end if;

  -- Seed/lock the same canonical resources used by runtime workplace, queue,
  -- call and routing mutations. No claim is stolen, even after expiry.
  insert into public.motorist_workplace_resource_claims (organization_id, resource_type, resource_id)
  select v_org, resource_type, resource_id
  from (
    select 'extension'::text as resource_type, e.id as resource_id
    from public.motorist_telephony_extensions e
    join pg_temp.motorist_workplace_bootstrap_input i
      on i.organization_id = e.organization_id and i.extension = e.extension
    where e.provider = 'viptel'
    union
    select 'profile', i.expected_profile_id
    from pg_temp.motorist_workplace_bootstrap_input i where i.expected_profile_id is not null
    union
    select 'routing_plan', q.id
    from public.motorist_telephony_queues q
    where q.organization_id = v_org and q.provider = 'viptel' and q.external_id = '601' and q.active = true
    union
    select 'queue', q.id
    from public.motorist_telephony_queues q
    where q.organization_id = v_org and q.provider = 'viptel' and q.external_id in ('601','602','603') and q.active = true
  ) resources
  on conflict (organization_id, resource_type, resource_id) do nothing;

  perform 1
  from public.motorist_workplace_resource_claims c
  where c.organization_id = v_org and (
    (c.resource_type = 'extension' and c.resource_id in (
      select e.id from public.motorist_telephony_extensions e
      join pg_temp.motorist_workplace_bootstrap_input i
        on i.organization_id = e.organization_id and i.extension = e.extension
      where e.provider = 'viptel'
    )) or (c.resource_type = 'profile' and c.resource_id in (
      select expected_profile_id from pg_temp.motorist_workplace_bootstrap_input where expected_profile_id is not null
    )) or (c.resource_type = 'routing_plan' and c.resource_id in (
      select q.id from public.motorist_telephony_queues q where q.organization_id = v_org
        and q.provider = 'viptel' and q.external_id = '601' and q.active = true
    )) or (c.resource_type = 'queue' and c.resource_id in (
      select q.id from public.motorist_telephony_queues q where q.organization_id = v_org
        and q.provider = 'viptel' and q.external_id in ('601','602','603') and q.active = true
    ))
  )
  order by c.resource_type, c.resource_id
  for update;

  if exists (
    select 1 from public.motorist_workplace_resource_claims c
    where c.organization_id = v_org and c.operation_id is not null and (
      (c.resource_type = 'extension' and c.resource_id in (
        select e.id from public.motorist_telephony_extensions e
        join pg_temp.motorist_workplace_bootstrap_input i
          on i.organization_id = e.organization_id and i.extension = e.extension
      )) or (c.resource_type = 'profile' and c.resource_id in (
        select expected_profile_id from pg_temp.motorist_workplace_bootstrap_input where expected_profile_id is not null
      )) or (c.resource_type in ('routing_plan', 'queue') and c.resource_id in (
        select q.id from public.motorist_telephony_queues q where q.organization_id = v_org
          and q.provider = 'viptel' and q.external_id in ('601','602','603') and q.active = true
      ))
    )
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_RESOURCE_BUSY' using errcode = '55P03';
  end if;

  perform 1 from public.motorist_profiles p
  where p.organization_id = v_org and (p.id = v_actor or p.id in (
    select expected_profile_id from pg_temp.motorist_workplace_bootstrap_input where expected_profile_id is not null
  )) order by p.id for update;
  perform 1 from public.motorist_telephony_queues q
  where q.organization_id = v_org and q.provider = 'viptel' and q.external_id in ('601','602','603')
  order by q.id for update;
  perform 1 from public.motorist_telephony_extensions e
  join pg_temp.motorist_workplace_bootstrap_input i
    on i.organization_id = e.organization_id and i.extension = e.extension
  where e.provider = 'viptel' order by e.id for update of e;

  -- Repeat every safety-sensitive preflight after locks are held.
  if not exists (
    select 1 from public.motorist_profiles
    where organization_id = v_org and id = v_actor and active = true and role in ('manager', 'admin')
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ACTOR_CHANGED' using errcode = '42501';
  end if;
  if (select pg_catalog.count(*) from public.motorist_telephony_queues q
      where q.organization_id = v_org and q.provider = 'viptel' and q.active = true
        and q.external_id in ('601','602','603')) <> 3
    or not exists (
      select 1 from public.motorist_telephony_queues q
      where q.organization_id = v_org and q.provider = 'viptel' and q.active = true
        and q.external_id = '601' and q.line_id is null
    ) then
    raise exception 'HOTDESK_BOOTSTRAP_QUEUE_CHANGED' using errcode = '55P03';
  end if;
  if exists (
    select 1 from pg_temp.motorist_workplace_bootstrap_input i
    join public.motorist_telephony_extensions e
      on e.organization_id = i.organization_id and e.provider = 'viptel' and e.extension = i.extension
    left join public.motorist_profiles p
      on p.organization_id = i.organization_id and p.id = i.expected_profile_id
    where e.active is distinct from true or e.profile_id is distinct from i.expected_profile_id
      or e.workplace_seat_generation is not null
      or e.last_synced_at is null or e.last_synced_at < v_evidence
      or e.is_registered is distinct from false or e.is_viptel_phone_active is distinct from false
      or coalesce(e.metadata->'assignmentActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(e.metadata->'telephonyActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(e.metadata#>>'{assignmentTransition,active}', 'false') = 'true'
      or coalesce(e.metadata#>>'{workplaceOwnerTransition,active}', 'false') = 'true'
      or coalesce(e.metadata#>>'{dispatchRouting,operation,status}', '') not in ('', 'completed', 'aborted')
      or (i.expected_profile_id is not null and (
        p.id is null or p.active is distinct from true
        or p.role not in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')
        or p.phone_extension is distinct from i.extension
      ))
      or (i.expected_profile_id is null and exists (
        select 1 from public.motorist_profiles reserved
        where reserved.organization_id = i.organization_id and reserved.phone_extension = i.extension
      ))
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_EXTENSION_NOT_QUIESCENT' using errcode = '55P03';
  end if;
  if exists (
    select 1 from pg_temp.motorist_workplace_bootstrap_input i
    join public.motorist_telephony_extensions e
      on e.organization_id = i.organization_id and e.provider = 'viptel' and e.extension = i.extension
    left join lateral (
      select a.id, a.action, a.after_payload
      from public.motorist_audit_log a
      where a.organization_id = i.organization_id
        and a.entity_type = 'motorist_telephony_extensions' and a.entity_id = e.id
        and a.action in ('telephony.extension.assign', 'telephony.extension.unassign')
      order by a.created_at desc, a.id desc limit 1
    ) latest on true
    where (
      e.metadata ? 'assignmentLifecycle' and (
        pg_catalog.jsonb_typeof(e.metadata->'assignmentLifecycle') <> 'object'
        or e.metadata#>>'{assignmentLifecycle,schemaVersion}' is distinct from '1'
        or coalesce(e.metadata#>>'{assignmentLifecycle,epoch}', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(e.metadata#>>'{assignmentLifecycle,assignmentMode}', '') not in
          ('initial_provisioning', 'rotated_handoff', 'workplace_claim')
        or e.metadata#>>'{assignmentLifecycle,extensionId}' is distinct from e.id::text
        or e.metadata#>>'{assignmentLifecycle,extension}' is distinct from e.extension
        or e.metadata#>>'{assignmentLifecycle,profileId}' is distinct from e.profile_id::text
        or e.metadata#>>'{assignmentLifecycle,state}' is distinct from
          case when e.profile_id is null then 'unassigned' else 'assigned' end
        or coalesce(e.metadata#>>'{assignmentLifecycle,assignedAt}', '')
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        or pg_catalog.to_char(
          (e.metadata#>>'{assignmentLifecycle,assignedAt}')::timestamptz at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) is distinct from e.metadata#>>'{assignmentLifecycle,assignedAt}'
        or coalesce(e.metadata#>>'{assignmentLifecycle,assignedBy}', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or (e.profile_id is null and (
          coalesce(e.metadata#>>'{assignmentLifecycle,unassignedAt}', '')
            !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
          or pg_catalog.to_char(
            (e.metadata#>>'{assignmentLifecycle,unassignedAt}')::timestamptz at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) is distinct from e.metadata#>>'{assignmentLifecycle,unassignedAt}'
          or coalesce(e.metadata#>>'{assignmentLifecycle,unassignedBy}', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ))
        or latest.id is null
        or latest.action is distinct from
          case when e.profile_id is null then 'telephony.extension.unassign' else 'telephony.extension.assign' end
        or latest.after_payload->'assignment_lifecycle' is distinct from e.metadata->'assignmentLifecycle'
      )
    ) or (
      not (e.metadata ? 'assignmentLifecycle') and
      (
        e.profile_id is not null or latest.id is not null
        or exists (
          select 1 from public.motorist_audit_log history
          where history.organization_id = i.organization_id
            and history.entity_type = 'motorist_telephony_extensions'
            and history.entity_id = e.id
            and history.action like 'telephony.extension.%'
        )
        or exists (
          select 1 from public.motorist_audit_log history
          where history.organization_id = i.organization_id
            and history.entity_type = 'motorist_telephony_extensions'
            and history.action in ('telephony.extension.assign', 'telephony.extension.unassign')
            and history.entity_id is distinct from e.id
            and (
              history.before_payload->>'extension' = e.extension
              or history.after_payload->>'extension' = e.extension
              or history.before_payload#>>'{assignment_lifecycle,extension}' = e.extension
              or history.after_payload#>>'{assignment_lifecycle,extension}' = e.extension
            )
        )
      )
    )
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_IMMUTABLE_BASELINE_MISMATCH' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.motorist_calls c
    join public.motorist_telephony_extensions e on e.organization_id = c.organization_id
    join pg_temp.motorist_workplace_bootstrap_input i
      on i.organization_id = e.organization_id and i.extension = e.extension
    where c.provider = 'viptel' and c.status not in ('ended', 'failed', 'missed', 'abandoned_queue')
      and (c.extension_id = e.id or c.caller_extension = e.extension
        or c.received_extension = e.extension or c.destination_extension = e.extension)
  ) or exists (
    select 1 from public.motorist_telephony_commands c
    join pg_temp.motorist_workplace_bootstrap_input i on i.organization_id = c.organization_id
    join public.motorist_telephony_extensions e
      on e.organization_id = i.organization_id and e.extension = i.extension and e.provider = 'viptel'
    where c.provider = 'viptel' and c.status in ('queued', 'sent', 'accepted')
      and (c.extension_id = e.id or c.request_payload->>'extension' = e.extension
        or c.request_payload#>>'{assignmentGuard,extension}' = e.extension
        or pg_catalog.jsonb_path_exists(
          c.request_payload, '$.** ? (@ == $extension)',
          pg_catalog.jsonb_build_object('extension', e.extension)
        ))
  ) or exists (
    select 1 from public.motorist_queue_memberships m
    join pg_temp.motorist_workplace_bootstrap_input i
      on i.organization_id = m.organization_id and i.extension = m.extension_number
    where m.provider = 'viptel' and (m.in_use = true or m.last_synced_at is null or m.last_synced_at < v_evidence)
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_LIVE_ACTIVITY_PRESENT' using errcode = '55P03';
  end if;
  if exists (
    select 1 from public.motorist_workplace_leases l
    join public.motorist_telephony_extensions e on e.id = l.extension_id and e.organization_id = l.organization_id
    join pg_temp.motorist_workplace_bootstrap_input i
      on i.organization_id = e.organization_id and i.extension = e.extension
    where l.state in ('active', 'ending')
  ) or exists (
    select 1 from public.motorist_workplace_operations o
    join public.motorist_telephony_extensions e
      on e.id in (o.source_extension_id, o.target_extension_id) and e.organization_id = o.organization_id
    join pg_temp.motorist_workplace_bootstrap_input i
      on i.organization_id = e.organization_id and i.extension = e.extension
    where o.phase not in ('completed', 'aborted')
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_DURABLE_OPERATION_PRESENT' using errcode = '55P03';
  end if;
  if exists (
    select 1 from public.motorist_telephony_queues q
    where q.organization_id = v_org and q.provider = 'viptel' and q.active = true
      and q.external_id in ('601','602','603')
      and (coalesce(q.metadata->'dispatchRouting'->'operation', '{}'::jsonb) <> '{}'::jsonb
        or coalesce(q.metadata->'workplaceOwnerTransition', '{}'::jsonb) <> '{}'::jsonb)
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ROUTING_NOT_QUIESCENT' using errcode = '55P03';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'resourceType', c.resource_type, 'resourceId', c.resource_id,
    'guardVersion', c.guard_version, 'operationId', c.operation_id
  ) order by c.resource_type, c.resource_id) into v_guard_snapshot
  from public.motorist_workplace_resource_claims c
  where c.organization_id = v_org and (
    (c.resource_type = 'extension' and c.resource_id in (
      select e.id from public.motorist_telephony_extensions e
      join pg_temp.motorist_workplace_bootstrap_input i
        on i.organization_id = e.organization_id and i.extension = e.extension
    )) or (c.resource_type = 'profile' and c.resource_id in (
      select expected_profile_id from pg_temp.motorist_workplace_bootstrap_input where expected_profile_id is not null
    )) or (c.resource_type = 'routing_plan' and c.resource_id in (
      select q.id from public.motorist_telephony_queues q where q.organization_id = v_org
        and q.provider = 'viptel' and q.external_id = '601' and q.active = true
    )) or (c.resource_type = 'queue' and c.resource_id in (
      select q.id from public.motorist_telephony_queues q where q.organization_id = v_org
        and q.provider = 'viptel' and q.external_id in ('601','602','603') and q.active = true
    ))
  );
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', q.id, 'externalId', q.external_id, 'lineId', q.line_id, 'metadata', q.metadata
  ) order by q.external_id) into v_routing_snapshot
  from public.motorist_telephony_queues q
  where q.organization_id = v_org and q.provider = 'viptel' and q.active = true
    and q.external_id in ('601','602','603');
  if v_guard_snapshot is null or v_routing_snapshot is null then
    raise exception 'HOTDESK_BOOTSTRAP_SNAPSHOT_MISSING' using errcode = 'P0001';
  end if;
  update pg_temp.motorist_workplace_bootstrap_runtime
    set guard_snapshot = v_guard_snapshot, routing_snapshot = v_routing_snapshot;

  for v_input in
    select * from pg_temp.motorist_workplace_bootstrap_input order by extension
  loop
    select * into strict v_extension
    from public.motorist_telephony_extensions
    where organization_id = v_org and provider = 'viptel' and extension = v_input.extension;
    if v_input.expected_profile_id is not null then
      select * into strict v_profile from public.motorist_profiles
      where organization_id = v_org and id = v_input.expected_profile_id;
    end if;

    v_seat_generation := gen_random_uuid();
    v_assignment_generation := gen_random_uuid();
    v_audit_id := gen_random_uuid();
    v_receipt_id := gen_random_uuid();
    v_lease_id := case when v_input.expected_profile_id is null then null else gen_random_uuid() end;
    v_lifecycle := pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'epoch', v_assignment_generation::text,
      'state', case when v_input.expected_profile_id is null then 'unassigned' else 'assigned' end,
      'extensionId', v_extension.id::text,
      'extension', v_extension.extension,
      'profileId', pg_catalog.to_jsonb(v_input.expected_profile_id),
      'assignmentMode', 'workplace_claim',
      'assignedAt', v_iso,
      'assignedBy', v_actor::text
    );
    if v_input.expected_profile_id is null then
      v_lifecycle := v_lifecycle || pg_catalog.jsonb_build_object(
        'unassignedAt', v_iso, 'unassignedBy', v_actor::text
      );
    end if;

    v_after_metadata := pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(
        v_extension.metadata - 'assignmentAttestation' - 'assignmentQuarantine',
        '{assignmentGeneration}', pg_catalog.to_jsonb(v_assignment_generation::text), true
      ),
      '{assignmentLifecycle}', v_lifecycle, true
    );
    if v_input.expected_profile_id is null then
      v_after_metadata := v_after_metadata || pg_catalog.jsonb_build_object(
        'assignmentQuarantine', pg_catalog.jsonb_build_object(
          'active', false, 'extension', v_extension.extension,
          'previousProfileId', v_extension.profile_id,
          'releasedAt', v_iso, 'releasedBy', v_actor::text,
          'sharingMode', 'workplace_claim', 'bootstrapBatchId', v_batch::text
        )
      );
    else
      v_after_metadata := v_after_metadata || pg_catalog.jsonb_build_object(
        'assignmentAttestation', pg_catalog.jsonb_build_object(
          'assignedAt', v_iso, 'assignedBy', v_actor::text,
          'assignedToProfileId', v_input.expected_profile_id::text,
          'mode', 'workplace_claim', 'bootstrapBatchId', v_batch::text
        ),
        'assignmentQuarantine', pg_catalog.jsonb_build_object(
          'active', false, 'previousProfileId', v_extension.profile_id,
          'releasedAt', v_iso, 'releasedBy', v_actor::text,
          'sharingMode', 'workplace_claim', 'bootstrapBatchId', v_batch::text
        )
      );
    end if;

    update public.motorist_telephony_extensions
    set profile_id = v_input.expected_profile_id,
        display_name = case when v_input.expected_profile_id is null then null else v_profile.display_name end,
        metadata = v_after_metadata,
        workplace_seat_generation = v_seat_generation
    where organization_id = v_org and id = v_extension.id and workplace_seat_generation is null;
    if not found then
      raise exception 'HOTDESK_BOOTSTRAP_EXTENSION_CAS_FAILED' using errcode = '40001';
    end if;

    v_lease_row := null;
    if v_lease_id is not null then
      insert into public.motorist_workplace_leases (
        id, organization_id, extension_id, profile_id, assignment_generation,
        browser_instance_id, lease_version, leader_epoch, resume_secret_hash,
        state, claimed_at, heartbeat_at, expires_at
      ) values (
        v_lease_id, v_org, v_extension.id, v_input.expected_profile_id, v_assignment_generation,
        gen_random_uuid(), 1, 1,
        replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
        'active', v_now - interval '61 seconds', v_now - interval '61 seconds', v_now - interval '1 second'
      );
      select pg_catalog.to_jsonb(l) into strict v_lease_row
      from public.motorist_workplace_leases l where l.organization_id = v_org and l.id = v_lease_id;
    end if;

    insert into public.motorist_audit_log (
      id, organization_id, actor_profile_id, action, entity_type, entity_id, source,
      before_payload, after_payload, created_at
    ) values (
      v_audit_id, v_org, v_actor,
      case when v_input.expected_profile_id is null
        then 'telephony.extension.unassign' else 'telephony.extension.assign' end,
      'motorist_telephony_extensions', v_extension.id, 'manual_bootstrap',
      pg_catalog.jsonb_build_object(
        'extension', v_extension.extension, 'profile_id', v_extension.profile_id,
        'assignment_lifecycle', v_extension.metadata->'assignmentLifecycle',
        'bootstrap_batch_id', v_batch
      ),
      pg_catalog.jsonb_build_object(
        'extension', v_extension.extension, 'profile_id', v_input.expected_profile_id,
        'sharing_mode', 'workplace_claim', 'assignment_lifecycle', v_lifecycle,
        'bootstrap_batch_id', v_batch, 'workplace_seat_generation', v_seat_generation,
        'bootstrap_lease_id', v_lease_id
      ),
      v_now
    );

    insert into public.motorist_workplace_bootstrap_receipts (
      id, organization_id, bootstrap_batch_id, actor_profile_id, provider_evidence_not_before,
      extension_id, extension,
      bootstrap_mode, expected_profile_id,
      before_profile_id, before_display_name, before_metadata, before_workplace_seat_generation,
      after_profile_id, after_display_name, after_metadata, after_workplace_seat_generation,
      assignment_generation, bootstrap_lease_id, bootstrap_lease_row, terminal_audit_id,
      guard_snapshot, routing_snapshot, applied_at
    ) values (
      v_receipt_id, v_org, v_batch, v_actor, v_evidence, v_extension.id, v_extension.extension,
      case when v_input.expected_profile_id is null then 'unassigned' else 'offline_owner' end,
      v_input.expected_profile_id,
      v_extension.profile_id, v_extension.display_name, v_extension.metadata, v_extension.workplace_seat_generation,
      v_input.expected_profile_id,
      case when v_input.expected_profile_id is null then null else v_profile.display_name end,
      v_after_metadata, v_seat_generation, v_assignment_generation,
      v_lease_id, v_lease_row, v_audit_id, v_guard_snapshot, v_routing_snapshot, v_now
    );
  end loop;

  if exists (
    select 1 from public.motorist_workplace_bootstrap_receipts r
    where r.organization_id = v_org and r.bootstrap_batch_id = v_batch
      and r.terminal_audit_id is distinct from (
        select a.id from public.motorist_audit_log a
        where a.organization_id = r.organization_id
          and a.entity_type = 'motorist_telephony_extensions' and a.entity_id = r.extension_id
          and a.action in ('telephony.extension.assign', 'telephony.extension.unassign')
        order by a.created_at desc, a.id desc limit 1
      )
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_TERMINAL_AUDIT_NOT_HEAD' using errcode = 'P0001';
  end if;
end
$apply$;

select
  r.extension,
  r.bootstrap_mode,
  r.expected_profile_id,
  r.after_workplace_seat_generation as workplace_seat_generation,
  r.assignment_generation,
  r.bootstrap_lease_id,
  r.applied_at,
  runtime.already_applied
from public.motorist_workplace_bootstrap_receipts r
cross join pg_temp.motorist_workplace_bootstrap_runtime runtime
where r.organization_id = :'organization_id'::uuid
  and r.bootstrap_batch_id = :'bootstrap_batch_id'::uuid
order by r.extension;

commit;
drop table pg_temp.motorist_workplace_bootstrap_input;
