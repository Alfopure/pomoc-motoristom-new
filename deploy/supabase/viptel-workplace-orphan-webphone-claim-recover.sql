-- MANUAL ONLY: recover one exact orphaned webphone-session assignment claim.
-- This file never runs during deployment. It does not change ownership,
-- assignment lifecycle, queue routing, SIP state, or any provider resource.
\set ON_ERROR_STOP on

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
\if :{?extension}
\else
  \echo 'Missing -v extension=<20|21|22|23>'
  \quit
\endif
\if :{?expected_profile_id}
\else
  \echo 'Missing -v expected_profile_id=<current-owner-uuid>'
  \quit
\endif
\if :{?expected_claim_id}
\else
  \echo 'Missing -v expected_claim_id=<orphan-claim-uuid>'
  \quit
\endif
\if :{?expected_extension_updated_at}
\else
  \echo 'Missing -v expected_extension_updated_at=<exact-db-timestamptz>'
  \quit
\endif
\if :{?provider_snapshot_command_id}
\else
  \echo 'Missing -v provider_snapshot_command_id=<confirmed-command-uuid>'
  \quit
\endif
\if :{?provider_evidence_captured_at}
\else
  \echo 'Missing -v provider_evidence_captured_at=<canonical-ISO-8601>'
  \quit
\endif
\if :{?recovery_audit_id}
\else
  \echo 'Missing -v recovery_audit_id=<new-uuid>'
  \quit
\endif
\if :{?recovery_reference}
\else
  \echo 'Missing -v recovery_reference=<bounded-change-reference>'
  \quit
\endif

drop table if exists pg_temp.motorist_orphan_webphone_claim_recovery_input;
create temporary table motorist_orphan_webphone_claim_recovery_input (
  organization_id uuid not null,
  actor_profile_id uuid not null,
  extension text not null,
  expected_profile_id uuid not null,
  expected_claim_id uuid not null,
  expected_extension_updated_at timestamptz not null,
  provider_snapshot_command_id uuid not null,
  provider_evidence_captured_at_text text not null,
  provider_evidence_captured_at timestamptz not null,
  recovery_audit_id uuid not null,
  recovery_reference text not null
) on commit preserve rows;

insert into motorist_orphan_webphone_claim_recovery_input values (
  :'organization_id'::uuid,
  :'actor_profile_id'::uuid,
  :'extension',
  :'expected_profile_id'::uuid,
  :'expected_claim_id'::uuid,
  :'expected_extension_updated_at'::timestamptz,
  :'provider_snapshot_command_id'::uuid,
  :'provider_evidence_captured_at',
  :'provider_evidence_captured_at'::timestamptz,
  :'recovery_audit_id'::uuid,
  :'recovery_reference'
);

begin isolation level serializable;

drop table if exists pg_temp.motorist_orphan_webphone_claim_recovery_runtime;
create temporary table motorist_orphan_webphone_claim_recovery_runtime (
  extension_id uuid not null,
  extension text not null,
  profile_id uuid not null,
  recovered_claim_id uuid not null,
  provider_snapshot_command_id uuid not null,
  provider_evidence_captured_at timestamptz not null,
  recovery_audit_id uuid not null,
  recovered_at timestamptz not null,
  extension_updated_at timestamptz not null,
  already_recovered boolean not null
) on commit preserve rows;

do $recover$
declare
  v_input pg_temp.motorist_orphan_webphone_claim_recovery_input%rowtype;
  v_extension public.motorist_telephony_extensions%rowtype;
  v_actor public.motorist_profiles%rowtype;
  v_owner public.motorist_profiles%rowtype;
  v_evidence public.motorist_telephony_commands%rowtype;
  v_existing_audit public.motorist_audit_log%rowtype;
  v_terminal_audit public.motorist_audit_log%rowtype;
  v_claim jsonb;
  v_lifecycle jsonb;
  v_snapshot jsonb;
  v_next_metadata jsonb;
  v_routing_snapshot jsonb;
  v_projection_before jsonb;
  v_projection_after jsonb;
  v_after_updated_at timestamptz;
  v_claimed_at timestamptz;
  v_updated_count integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select * into strict v_input
  from pg_temp.motorist_orphan_webphone_claim_recovery_input;

  if v_input.extension not in ('20', '21', '22', '23')
    or pg_catalog.length(v_input.recovery_reference) not between 6 and 160
    or v_input.recovery_reference !~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#-]*$'
    or v_input.provider_evidence_captured_at_text
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    or pg_catalog.to_char(
      v_input.provider_evidence_captured_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) <> v_input.provider_evidence_captured_at_text
    or v_input.provider_evidence_captured_at > v_now + interval '5 seconds'
    or v_input.provider_evidence_captured_at < v_now - interval '5 minutes' then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_INPUT_INVALID' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'motorist.orphan-webphone-claim.' || v_input.organization_id::text || '.' || v_input.extension,
      0
    )
  );

  select * into v_actor
  from public.motorist_profiles p
  where p.organization_id = v_input.organization_id
    and p.id = v_input.actor_profile_id
    and p.active = true
    and p.role in ('manager', 'admin')
  for share;
  if not found then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_ACTOR_NOT_ELIGIBLE' using errcode = '42501';
  end if;

  -- Lock the complete provider projection in stable order. The recovery also
  -- materializes the exact 20-23 registration snapshot needed by bootstrap.
  perform e.id
  from public.motorist_telephony_extensions e
  where e.organization_id = v_input.organization_id
    and e.provider = 'viptel'
    and e.extension in ('20', '21', '22', '23')
  order by e.extension
  for update;
  if (select pg_catalog.count(*)
      from public.motorist_telephony_extensions e
      where e.organization_id = v_input.organization_id
        and e.provider = 'viptel'
        and e.extension in ('20', '21', '22', '23')) <> 4 then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_EXTENSION_CATALOG_MISMATCH' using errcode = 'P0001';
  end if;

  select * into v_extension
  from public.motorist_telephony_extensions e
  where e.organization_id = v_input.organization_id
    and e.provider = 'viptel'
    and e.extension = v_input.extension;
  if not found then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_EXTENSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', e.id,
      'extension', e.extension,
      'profileId', e.profile_id,
      'catalogActive', e.active,
      'metadata', e.metadata,
      'isRegistered', e.is_registered,
      'isViptelPhoneActive', e.is_viptel_phone_active,
      'lastSyncedAt', e.last_synced_at,
      'updatedAt', e.updated_at
    ) order by e.extension
  ) into v_projection_before
  from public.motorist_telephony_extensions e
  where e.organization_id = v_input.organization_id
    and e.provider = 'viptel'
    and e.extension in ('20', '21', '22', '23');

  -- An exact audit replay is allowed after the claim was removed. It cannot
  -- be used to clear another claim or to hide a later owner/lifecycle change.
  select * into v_existing_audit
  from public.motorist_audit_log a
  where a.id = v_input.recovery_audit_id
  for update;
  if found then
    if v_existing_audit.organization_id is distinct from v_input.organization_id
      or v_existing_audit.actor_profile_id is distinct from v_input.actor_profile_id
      or v_existing_audit.action <> 'telephony.extension.assignment_claim.recovered'
      or v_existing_audit.entity_type <> 'motorist_telephony_extensions'
      or v_existing_audit.entity_id is distinct from v_extension.id
      or v_existing_audit.source <> 'manual_orphan_webphone_claim_recovery'
      or v_existing_audit.before_payload->>'extension' <> v_input.extension
      or v_existing_audit.before_payload->>'profileId' <> v_input.expected_profile_id::text
      or v_existing_audit.before_payload#>>'{assignmentActionClaim,claimId}' <> v_input.expected_claim_id::text
      or (v_existing_audit.before_payload->>'extensionUpdatedAt')::timestamptz
        is distinct from v_input.expected_extension_updated_at
      or v_existing_audit.after_payload->>'providerSnapshotCommandId'
        <> v_input.provider_snapshot_command_id::text
      or v_existing_audit.after_payload->>'providerCapturedAt'
        <> v_input.provider_evidence_captured_at_text
      or v_existing_audit.after_payload->>'recoveryReference' <> v_input.recovery_reference
      or v_extension.active is distinct from true
      or v_extension.profile_id is distinct from v_input.expected_profile_id
      or v_extension.metadata ? 'assignmentActionClaim'
      or v_extension.metadata->'assignmentLifecycle'
        is distinct from v_existing_audit.after_payload->'assignmentLifecycle'
      or v_extension.metadata->>'assignmentGeneration'
        is distinct from v_existing_audit.after_payload->>'assignmentGeneration'
      or v_extension.updated_at is distinct from
        (v_existing_audit.after_payload->>'extensionUpdatedAt')::timestamptz
      or v_projection_before is distinct from
        v_existing_audit.after_payload->'providerProjectionAfter' then
      raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_AUDIT_ID_CONFLICT' using errcode = '23505';
    end if;

    insert into pg_temp.motorist_orphan_webphone_claim_recovery_runtime values (
      v_extension.id,
      v_extension.extension,
      v_extension.profile_id,
      v_input.expected_claim_id,
      v_input.provider_snapshot_command_id,
      v_input.provider_evidence_captured_at,
      v_existing_audit.id,
      v_existing_audit.created_at,
      v_extension.updated_at,
      true
    );
    return;
  end if;

  if v_extension.active is distinct from true
    or v_extension.profile_id is distinct from v_input.expected_profile_id
    or v_extension.updated_at is distinct from v_input.expected_extension_updated_at
    or coalesce(v_extension.metadata->'telephonyActionClaim', '{}'::jsonb) <> '{}'::jsonb
    or coalesce(v_extension.metadata#>>'{assignmentTransition,active}', 'false') = 'true'
    or coalesce(v_extension.metadata#>>'{workplaceOwnerTransition,active}', 'false') = 'true' then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_EXTENSION_CHANGED' using errcode = '40001';
  end if;
  if exists (
    select 1
    from public.motorist_telephony_extensions e
    where e.organization_id = v_input.organization_id
      and e.provider = 'viptel'
      and e.extension in ('20', '21', '22', '23')
      and (
        e.active is distinct from true
        or coalesce(e.metadata->'telephonyActionClaim', '{}'::jsonb) <> '{}'::jsonb
        or coalesce(e.metadata#>>'{assignmentTransition,active}', 'false') = 'true'
        or coalesce(e.metadata#>>'{workplaceOwnerTransition,active}', 'false') = 'true'
        or (
          e.extension <> v_input.extension
          and coalesce(e.metadata->'assignmentActionClaim', '{}'::jsonb) <> '{}'::jsonb
        )
      )
  ) then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_PROJECTION_NOT_QUIESCENT' using errcode = '55P03';
  end if;

  select * into v_owner
  from public.motorist_profiles p
  where p.organization_id = v_input.organization_id
    and p.id = v_input.expected_profile_id
    and p.active = true
    and p.role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')
    and p.phone_extension = v_input.extension
  for share;
  if not found then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_OWNER_MISMATCH' using errcode = 'P0001';
  end if;

  v_claim := v_extension.metadata->'assignmentActionClaim';
  v_lifecycle := v_extension.metadata->'assignmentLifecycle';
  if pg_catalog.jsonb_typeof(v_claim) is distinct from 'object'
    or v_claim->>'action' <> 'webphone.session.issue'
    or v_claim->>'claimId' <> v_input.expected_claim_id::text
    or v_claim->>'profileId' <> v_input.expected_profile_id::text
    or v_claim->>'generation' is distinct from v_extension.metadata->>'assignmentGeneration'
    or v_claim->>'lifecycleEpoch' is distinct from v_lifecycle->>'epoch'
    or v_claim ? 'routingOperationId'
    or coalesce(v_claim->>'claimedAt', '')
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_NOT_EXACT_WEBPHONE_CLAIM' using errcode = 'P0001';
  end if;
  v_claimed_at := (v_claim->>'claimedAt')::timestamptz;
  if pg_catalog.to_char(v_claimed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      <> v_claim->>'claimedAt'
    or v_input.provider_evidence_captured_at <= v_claimed_at + interval '2 minutes' then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_CLAIM_NOT_STALE' using errcode = '55P03';
  end if;

  if pg_catalog.jsonb_typeof(v_lifecycle) is distinct from 'object'
    or v_lifecycle->>'schemaVersion' <> '1'
    or v_lifecycle->>'state' <> 'assigned'
    or v_lifecycle->>'extensionId' <> v_extension.id::text
    or v_lifecycle->>'extension' <> v_extension.extension
    or v_lifecycle->>'profileId' <> v_extension.profile_id::text
    or v_lifecycle->>'epoch' is distinct from v_extension.metadata->>'assignmentGeneration'
    or coalesce(v_lifecycle->>'assignmentMode', '') not in
      ('initial_provisioning', 'rotated_handoff', 'workplace_claim') then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_LIFECYCLE_MISMATCH' using errcode = 'P0001';
  end if;

  select * into v_terminal_audit
  from public.motorist_audit_log a
  where a.organization_id = v_input.organization_id
    and a.entity_type = 'motorist_telephony_extensions'
    and a.entity_id = v_extension.id
    and a.action in ('telephony.extension.assign', 'telephony.extension.unassign')
  order by a.created_at desc, a.id desc
  limit 1
  for share;
  if not found
    or v_terminal_audit.action <> 'telephony.extension.assign'
    or v_terminal_audit.after_payload->'assignment_lifecycle' is distinct from v_lifecycle then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_TERMINAL_AUDIT_MISMATCH' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.motorist_telephony_commands c
    where c.organization_id = v_input.organization_id
      and c.provider = 'viptel'
      and c.request_payload#>>'{assignmentGuard,claimId}' = v_input.expected_claim_id::text
  ) then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_COMMAND_OWNS_CLAIM' using errcode = '55P03';
  end if;
  if exists (
    select 1
    from public.motorist_calls c
    join public.motorist_telephony_extensions e
      on e.organization_id = c.organization_id
      and e.provider = 'viptel'
      and e.extension in ('20', '21', '22', '23')
    where c.organization_id = v_input.organization_id
      and c.provider = 'viptel'
      and c.status not in ('ended', 'failed', 'missed', 'abandoned_queue')
      and (
        c.extension_id = e.id
        or c.caller_extension = e.extension
        or c.received_extension = e.extension
        or c.destination_extension = e.extension
      )
  ) then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_DB_CALL_ACTIVE' using errcode = '55P03';
  end if;
  if exists (
    select 1
    from public.motorist_telephony_commands c
    join public.motorist_telephony_extensions e
      on e.organization_id = c.organization_id
      and e.provider = 'viptel'
      and e.extension in ('20', '21', '22', '23')
    where c.organization_id = v_input.organization_id
      and c.provider = 'viptel'
      and c.status in ('queued', 'sent', 'accepted')
      and (
        c.extension_id = e.id
        or c.request_payload->>'extension' = e.extension
        or c.request_payload#>>'{assignmentGuard,extension}' = e.extension
        or pg_catalog.jsonb_path_exists(
          c.request_payload,
          '$.** ? (@ == $extension)',
          pg_catalog.jsonb_build_object('extension', e.extension)
        )
      )
  ) then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_DB_COMMAND_ACTIVE' using errcode = '55P03';
  end if;

  select * into v_evidence
  from public.motorist_telephony_commands c
  where c.id = v_input.provider_snapshot_command_id
    and c.organization_id = v_input.organization_id
    and c.provider = 'viptel'
    and c.command_type = 'provider.snapshot'
  for share;
  if not found
    or v_evidence.status <> 'confirmed_by_event'
    or v_evidence.confirmed_at is null
    or v_evidence.request_payload->>'schemaVersion' <> '1'
    or coalesce(v_evidence.request_payload->>'requestHmac', '') !~ '^[0-9a-f]{64}$'
    or v_evidence.provider_response->>'schemaVersion' <> '1'
    or coalesce(v_evidence.provider_response->>'responseHmac', '') !~ '^[0-9a-f]{64}$'
    or coalesce(v_evidence.provider_response->>'listenerInstance', '') = '' then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_PROVIDER_EVIDENCE_INVALID' using errcode = 'P0001';
  end if;

  v_snapshot := v_evidence.provider_response->'snapshot';
  if pg_catalog.jsonb_typeof(v_snapshot) is distinct from 'object'
    or v_snapshot->>'schemaVersion' <> '1'
    or v_snapshot->>'capturedAt' <> v_input.provider_evidence_captured_at_text
    or pg_catalog.jsonb_typeof(v_snapshot->'personalExtensions') is distinct from 'array'
    or pg_catalog.jsonb_typeof(v_snapshot->'extensions') is distinct from 'array'
    or pg_catalog.jsonb_typeof(v_snapshot->'activeCalls') is distinct from 'array'
    or pg_catalog.jsonb_typeof(v_snapshot->'queues') is distinct from 'array'
    or pg_catalog.jsonb_typeof(v_snapshot->'queueStatuses') is distinct from 'array' then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_PROVIDER_SNAPSHOT_MALFORMED' using errcode = 'P0001';
  end if;

  if pg_catalog.jsonb_array_length(v_snapshot->'activeCalls') <> 0
    or (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements_text(v_snapshot->'personalExtensions')) <> 4
    or exists (
      select 1 from pg_catalog.jsonb_array_elements_text(v_snapshot->'personalExtensions') x(value)
      where x.value not in ('20', '21', '22', '23')
    )
    or (select pg_catalog.count(distinct x.value)
        from pg_catalog.jsonb_array_elements_text(v_snapshot->'personalExtensions') x(value)) <> 4
    or (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(v_snapshot->'extensions')) <> 4
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(v_snapshot->'extensions') x(value)
      where x.value->>'extension' not in ('20', '21', '22', '23')
        or x.value->'isRegistered' is distinct from 'false'::jsonb
        or x.value->'isViptelPhoneActive' is distinct from 'false'::jsonb
    )
    or (select pg_catalog.count(distinct x.value->>'extension')
        from pg_catalog.jsonb_array_elements(v_snapshot->'extensions') x(value)) <> 4 then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_PROVIDER_NOT_IDLE' using errcode = '55P03';
  end if;

  if (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(v_snapshot->'queues')) <> 3
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(v_snapshot->'queues') q(value)
      where q.value->>'id' not in ('601', '602', '603')
    )
    or (select pg_catalog.count(distinct q.value->>'id')
        from pg_catalog.jsonb_array_elements(v_snapshot->'queues') q(value)) <> 3
    or (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(v_snapshot->'queueStatuses')) <> 3
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(v_snapshot->'queueStatuses') q(value)
      where q.value->>'queue' not in ('601', '602', '603')
        or q.value->'waitingCalls' is distinct from '0'::jsonb
        or pg_catalog.jsonb_typeof(q.value->'members') is distinct from 'array'
        or exists (
          select 1 from pg_catalog.jsonb_array_elements(q.value->'members') m(value)
          where m.value->'inUse' is distinct from 'false'::jsonb
        )
    )
    or (select pg_catalog.count(distinct q.value->>'queue')
        from pg_catalog.jsonb_array_elements(v_snapshot->'queueStatuses') q(value)) <> 3 then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_QUEUE_NOT_IDLE' using errcode = '55P03';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', q.id,
      'externalId', q.external_id,
      'lineId', q.line_id,
      'metadata', q.metadata,
      'updatedAt', q.updated_at
    ) order by q.external_id
  ) into v_routing_snapshot
  from public.motorist_telephony_queues q
  where q.organization_id = v_input.organization_id
    and q.provider = 'viptel'
    and q.active = true
    and q.external_id in ('601', '602', '603');
  if pg_catalog.jsonb_array_length(coalesce(v_routing_snapshot, '[]'::jsonb)) <> 3 then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_ROUTING_CATALOG_MISMATCH' using errcode = 'P0001';
  end if;

  v_next_metadata := v_extension.metadata - 'assignmentActionClaim';
  update public.motorist_telephony_extensions e
  set
    metadata = case when e.id = v_extension.id then v_next_metadata else e.metadata end,
    is_registered = (provider.value->>'isRegistered')::boolean,
    is_viptel_phone_active = (provider.value->>'isViptelPhoneActive')::boolean,
    last_synced_at = v_input.provider_evidence_captured_at
  from pg_catalog.jsonb_array_elements(v_snapshot->'extensions') provider(value)
  where e.organization_id = v_input.organization_id
    and e.provider = 'viptel'
    and e.active = true
    and e.extension in ('20', '21', '22', '23')
    and provider.value->>'extension' = e.extension
    and (
      e.id <> v_extension.id
      or (
        e.profile_id = v_input.expected_profile_id
        and e.updated_at = v_input.expected_extension_updated_at
        and e.metadata = v_extension.metadata
      )
    );
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 4 then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_CAS_LOST' using errcode = '40001';
  end if;

  select e.updated_at into strict v_after_updated_at
  from public.motorist_telephony_extensions e
  where e.id = v_extension.id and e.organization_id = v_input.organization_id;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', e.id,
      'extension', e.extension,
      'profileId', e.profile_id,
      'catalogActive', e.active,
      'metadata', e.metadata,
      'isRegistered', e.is_registered,
      'isViptelPhoneActive', e.is_viptel_phone_active,
      'lastSyncedAt', e.last_synced_at,
      'updatedAt', e.updated_at
    ) order by e.extension
  ) into v_projection_after
  from public.motorist_telephony_extensions e
  where e.organization_id = v_input.organization_id
    and e.provider = 'viptel'
    and e.extension in ('20', '21', '22', '23');

  if pg_catalog.jsonb_array_length(coalesce(v_projection_after, '[]'::jsonb)) <> 4
    or exists (
      select 1
      from public.motorist_telephony_extensions e
      where e.organization_id = v_input.organization_id
        and e.provider = 'viptel'
        and e.extension in ('20', '21', '22', '23')
        and (
          e.is_registered is distinct from false
          or e.is_viptel_phone_active is distinct from false
          or e.last_synced_at is distinct from v_input.provider_evidence_captured_at
          or e.profile_id is distinct from (
            select nullif(before_row.value->>'profileId', '')::uuid
            from pg_catalog.jsonb_array_elements(v_projection_before) before_row(value)
            where before_row.value->>'extension' = e.extension
          )
          or e.active is distinct from (
            select (before_row.value->>'catalogActive')::boolean
            from pg_catalog.jsonb_array_elements(v_projection_before) before_row(value)
            where before_row.value->>'extension' = e.extension
          )
          or e.metadata is distinct from case
            when e.id = v_extension.id then v_next_metadata
            else (
              select before_row.value->'metadata'
              from pg_catalog.jsonb_array_elements(v_projection_before) before_row(value)
              where before_row.value->>'extension' = e.extension
            )
          end
        )
    ) then
    raise exception 'HOTDESK_ORPHAN_CLAIM_RECOVERY_PROJECTION_WRITE_MISMATCH' using errcode = 'P0001';
  end if;

  insert into public.motorist_audit_log (
    id,
    organization_id,
    actor_profile_id,
    action,
    entity_type,
    entity_id,
    source,
    before_payload,
    after_payload,
    created_at
  ) values (
    v_input.recovery_audit_id,
    v_input.organization_id,
    v_input.actor_profile_id,
    'telephony.extension.assignment_claim.recovered',
    'motorist_telephony_extensions',
    v_extension.id,
    'manual_orphan_webphone_claim_recovery',
    pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'extension', v_extension.extension,
      'profileId', v_extension.profile_id,
      'extensionUpdatedAt', v_extension.updated_at,
      'assignmentGeneration', v_extension.metadata->>'assignmentGeneration',
      'assignmentLifecycle', v_lifecycle,
      'assignmentActionClaim', v_claim,
      'terminalAssignmentAuditId', v_terminal_audit.id,
      'routingSnapshot', v_routing_snapshot,
      'providerProjectionBefore', v_projection_before
    ),
    pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'recoveryKind', 'orphan_webphone_session_issue',
      'extension', v_extension.extension,
      'profileId', v_extension.profile_id,
      'extensionUpdatedAt', v_after_updated_at,
      'assignmentGeneration', v_next_metadata->>'assignmentGeneration',
      'assignmentLifecycle', v_next_metadata->'assignmentLifecycle',
      'assignmentActionClaim', null,
      'recoveredClaimId', v_input.expected_claim_id,
      'providerSnapshotCommandId', v_input.provider_snapshot_command_id,
      'providerCapturedAt', v_input.provider_evidence_captured_at_text,
      'recoveryReference', v_input.recovery_reference,
      'terminalAssignmentAuditId', v_terminal_audit.id,
      'routingSnapshot', v_routing_snapshot,
      'providerProjectionAfter', v_projection_after,
      'projectionFieldsRefreshed', pg_catalog.jsonb_build_array(
        'is_registered', 'is_viptel_phone_active', 'last_synced_at'
      )
    ),
    v_now
  );

  insert into pg_temp.motorist_orphan_webphone_claim_recovery_runtime values (
    v_extension.id,
    v_extension.extension,
    v_extension.profile_id,
    v_input.expected_claim_id,
    v_input.provider_snapshot_command_id,
    v_input.provider_evidence_captured_at,
    v_input.recovery_audit_id,
    v_now,
    v_after_updated_at,
    false
  );
end
$recover$;

select
  r.extension,
  r.profile_id,
  r.recovered_claim_id,
  r.provider_snapshot_command_id,
  r.provider_evidence_captured_at,
  r.recovery_audit_id,
  r.recovered_at,
  r.extension_updated_at,
  r.already_recovered
from pg_temp.motorist_orphan_webphone_claim_recovery_runtime r;

commit;
drop table pg_temp.motorist_orphan_webphone_claim_recovery_runtime;
drop table pg_temp.motorist_orphan_webphone_claim_recovery_input;
