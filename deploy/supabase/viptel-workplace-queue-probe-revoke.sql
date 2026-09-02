-- MANUAL ONLY: record revocation/expiry closure for a controlled queue probe.
-- IMPORTANT: this audit is evidence, not the kill switch. Disable hot-desk
-- claims and remove the probe environment first, as required by the runbook.
\set ON_ERROR_STOP on

\if :{?organization_id}
\else
  \echo 'Missing -v organization_id=<uuid>'
  \quit
\endif
\if :{?revoking_actor_profile_id}
\else
  \echo 'Missing -v revoking_actor_profile_id=<manager-or-admin-uuid>'
  \quit
\endif
\if :{?approval_evidence_id}
\else
  \echo 'Missing -v approval_evidence_id=<approved-audit-uuid>'
  \quit
\endif
\if :{?revocation_audit_id}
\else
  \echo 'Missing -v revocation_audit_id=<new-uuid>'
  \quit
\endif
\if :{?reason_reference}
\else
  \echo 'Missing -v reason_reference=<bounded-change-reference>'
  \quit
\endif
\if :{?gate_disabled_confirmation}
\else
  \echo 'Missing -v gate_disabled_confirmation=HOTDESK_DISABLED_AND_PROBE_ENV_REMOVED'
  \quit
\endif

drop table if exists pg_temp.motorist_queue_probe_revocation_input;
create temporary table motorist_queue_probe_revocation_input (
  organization_id uuid not null,
  revoking_actor_profile_id uuid not null,
  approval_evidence_id uuid not null,
  revocation_audit_id uuid not null,
  reason_reference text not null,
  gate_disabled_confirmation text not null
) on commit preserve rows;
insert into motorist_queue_probe_revocation_input values (
  :'organization_id'::uuid, :'revoking_actor_profile_id'::uuid,
  :'approval_evidence_id'::uuid, :'revocation_audit_id'::uuid,
  :'reason_reference', :'gate_disabled_confirmation'
);

begin isolation level serializable;

do $revoke$
declare
  v_input pg_temp.motorist_queue_probe_revocation_input%rowtype;
  v_approval public.motorist_audit_log%rowtype;
  v_existing public.motorist_audit_log%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_payload jsonb;
begin
  select * into strict v_input from pg_temp.motorist_queue_probe_revocation_input;
  if v_input.gate_disabled_confirmation <> 'HOTDESK_DISABLED_AND_PROBE_ENV_REMOVED'
    or pg_catalog.length(v_input.reason_reference) not between 6 and 160
    or v_input.reason_reference !~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#-]*$' then
    raise exception 'WORKPLACE_QUEUE_PROBE_REVOCATION_INPUT_INVALID' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('motorist.queue-probe.' || v_input.organization_id::text, 0)
  );
  if not exists (
    select 1 from public.motorist_profiles p
    where p.organization_id = v_input.organization_id
      and p.id = v_input.revoking_actor_profile_id
      and p.active = true and p.role in ('manager', 'admin')
  ) then
    raise exception 'WORKPLACE_QUEUE_PROBE_REVOKER_NOT_ELIGIBLE' using errcode = '42501';
  end if;
  select * into v_approval from public.motorist_audit_log
  where organization_id = v_input.organization_id and id = v_input.approval_evidence_id
    and action = 'telephony.workplace.queue_probe.approved'
    and entity_type = 'motorist_telephony_queues'
  for update;
  if not found
    or v_approval.after_payload->>'schemaVersion' <> '1'
    or v_approval.after_payload->>'capability' <> 'controlled_probe'
    or v_approval.after_payload->>'organizationId' <> v_input.organization_id::text
    or v_approval.after_payload->>'rootQueueId' <> v_approval.entity_id::text then
    raise exception 'WORKPLACE_QUEUE_PROBE_APPROVAL_NOT_FOUND' using errcode = 'P0001';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'capability', 'controlled_probe',
    'approvalEvidenceId', v_approval.id::text,
    'organizationId', v_input.organization_id::text,
    'profileId', v_approval.after_payload->>'profileId',
    'sourceExtension', v_approval.after_payload->>'sourceExtension',
    'rootQueueId', v_approval.entity_id::text,
    'startsAt', v_approval.after_payload->>'startsAt',
    'endsAt', v_approval.after_payload->>'endsAt',
    'fallbackReference', v_approval.after_payload->>'fallbackReference',
    'revokedAt', pg_catalog.to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revokedBy', v_input.revoking_actor_profile_id::text,
    'reasonReference', v_input.reason_reference,
    'enforcement', 'hotdesk_disabled_and_probe_env_removed'
  );
  select * into v_existing from public.motorist_audit_log
  where organization_id = v_input.organization_id and id = v_input.revocation_audit_id
  for update;
  if found then
    v_payload := pg_catalog.jsonb_set(
      v_payload, '{revokedAt}', v_existing.after_payload->'revokedAt', true
    );
    if v_existing.actor_profile_id is distinct from v_input.revoking_actor_profile_id
      or v_existing.action <> 'telephony.workplace.queue_probe.revoked'
      or v_existing.entity_type <> 'motorist_telephony_queues'
      or v_existing.entity_id is distinct from v_approval.entity_id
      or v_existing.after_payload is distinct from v_payload then
      raise exception 'WORKPLACE_QUEUE_PROBE_REVOCATION_ID_CONFLICT' using errcode = '23505';
    end if;
    return;
  end if;
  if exists (
    select 1 from public.motorist_audit_log a
    where a.organization_id = v_input.organization_id
      and a.action = 'telephony.workplace.queue_probe.revoked'
      and a.after_payload->>'approvalEvidenceId' = v_approval.id::text
  ) then
    raise exception 'WORKPLACE_QUEUE_PROBE_ALREADY_REVOKED' using errcode = '23505';
  end if;
  insert into public.motorist_audit_log (
    id, organization_id, actor_profile_id, action, entity_type, entity_id, source,
    after_payload, created_at
  ) values (
    v_input.revocation_audit_id, v_input.organization_id, v_input.revoking_actor_profile_id,
    'telephony.workplace.queue_probe.revoked', 'motorist_telephony_queues',
    v_approval.entity_id, 'manual_queue_probe_revocation', v_payload, v_now
  );
end
$revoke$;

select
  revoked.id as revocation_audit_id,
  revoked.after_payload->>'approvalEvidenceId' as approval_evidence_id,
  revoked.after_payload->>'revokedAt' as revoked_at,
  revoked.after_payload->>'reasonReference' as reason_reference,
  revoked.after_payload->>'enforcement' as required_enforcement
from public.motorist_audit_log revoked
where revoked.organization_id = :'organization_id'::uuid
  and revoked.id = :'revocation_audit_id'::uuid;

commit;
drop table pg_temp.motorist_queue_probe_revocation_input;
