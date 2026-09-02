-- Manual, read-only preflight for canonical VIPTel hot-desk seats 20-23.
-- This file is intentionally outside supabase/migrations and is never applied
-- by the normal deployment path. Run only with psql and the variables listed
-- in docs/operations/viptel-workplace-bootstrap.md.
\set ON_ERROR_STOP on

do $migration_precondition$
begin
  if pg_catalog.to_regclass('public.motorist_workplace_leases') is null
    or pg_catalog.to_regclass('public.motorist_workplace_resource_claims') is null
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

begin transaction read only;

do $preflight$
declare
  v_org uuid;
  v_actor uuid;
  v_evidence timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select organization_id, actor_profile_id, provider_evidence_not_before
  into strict v_org, v_actor, v_evidence
  from pg_temp.motorist_workplace_bootstrap_input limit 1;

  if v_evidence > v_now + interval '5 seconds' or v_evidence < v_now - interval '5 minutes' then
    raise exception 'HOTDESK_BOOTSTRAP_PROVIDER_EVIDENCE_STALE' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.motorist_profiles
    where organization_id = v_org and id = v_actor and active = true and role in ('manager', 'admin')
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_ACTOR_NOT_ELIGIBLE' using errcode = '42501';
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
  if (select pg_catalog.count(*) from public.motorist_telephony_extensions e
      join pg_temp.motorist_workplace_bootstrap_input i
        on i.organization_id = e.organization_id and i.extension = e.extension
      where e.provider = 'viptel' and e.active = true) <> 4 then
    raise exception 'HOTDESK_BOOTSTRAP_SEAT_CATALOG_MISMATCH' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from pg_temp.motorist_workplace_bootstrap_input i
    join public.motorist_telephony_extensions e
      on e.organization_id = i.organization_id and e.provider = 'viptel' and e.extension = i.extension
    left join public.motorist_profiles p
      on p.organization_id = i.organization_id and p.id = i.expected_profile_id
    where e.profile_id is distinct from i.expected_profile_id
      or e.workplace_seat_generation is not null
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
    raise exception 'HOTDESK_BOOTSTRAP_OWNERSHIP_PROJECTION_MISMATCH' using errcode = 'P0001';
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
    select 1 from public.motorist_telephony_extensions e
    join pg_temp.motorist_workplace_bootstrap_input i
      on i.organization_id = e.organization_id and i.extension = e.extension
    where e.provider <> 'viptel' or e.active is distinct from true
      or e.last_synced_at is null or e.last_synced_at < v_evidence
      or e.is_registered is distinct from false or e.is_viptel_phone_active is distinct from false
      or coalesce(e.metadata->'assignmentActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(e.metadata->'telephonyActionClaim', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(e.metadata#>>'{assignmentTransition,active}', 'false') = 'true'
      or coalesce(e.metadata#>>'{workplaceOwnerTransition,active}', 'false') = 'true'
      or coalesce(e.metadata#>>'{dispatchRouting,operation,status}', '') not in ('', 'completed', 'aborted')
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_EXTENSION_NOT_QUIESCENT' using errcode = '55P03';
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
  ) or exists (
    select 1 from public.motorist_workplace_resource_claims c
    join public.motorist_telephony_extensions e
      on c.organization_id = e.organization_id and c.resource_type = 'extension' and c.resource_id = e.id
    join pg_temp.motorist_workplace_bootstrap_input i
      on i.organization_id = e.organization_id and i.extension = e.extension
    where c.operation_id is not null
  ) then
    raise exception 'HOTDESK_BOOTSTRAP_DURABLE_OPERATION_PRESENT' using errcode = '55P03';
  end if;
  if (select pg_catalog.count(*) from public.motorist_telephony_queues q
      where q.organization_id = v_org and q.provider = 'viptel' and q.active = true
        and q.external_id in ('601','602','603')) <> 3
    or not exists (
      select 1 from public.motorist_telephony_queues q
      where q.organization_id = v_org and q.provider = 'viptel' and q.active = true
        and q.external_id = '601' and q.line_id is null
    )
    or exists (
      select 1 from public.motorist_telephony_queues q
      where q.organization_id = v_org and q.provider = 'viptel' and q.active = true
        and q.external_id in ('601','602','603')
        and (coalesce(q.metadata->'dispatchRouting'->'operation', '{}'::jsonb) <> '{}'::jsonb
          or coalesce(q.metadata->'workplaceOwnerTransition', '{}'::jsonb) <> '{}'::jsonb)
    ) then
    raise exception 'HOTDESK_BOOTSTRAP_ROUTING_NOT_QUIESCENT' using errcode = '55P03';
  end if;
end
$preflight$;

select
  i.extension,
  case when i.expected_profile_id is null then 'ready_unassigned' else 'ready_offline_owner' end as bootstrap_mode,
  i.expected_profile_id,
  e.id as extension_id,
  e.last_synced_at as provider_checked_at
from pg_temp.motorist_workplace_bootstrap_input i
join public.motorist_telephony_extensions e
  on e.organization_id = i.organization_id and e.provider = 'viptel' and e.extension = i.extension
order by i.extension;

commit;
drop table pg_temp.motorist_workplace_bootstrap_input;
