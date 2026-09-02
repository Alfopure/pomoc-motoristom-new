-- MANUAL, READ-ONLY: inspect approval window and immutable revocation evidence.
\set ON_ERROR_STOP on

\if :{?organization_id}
\else
  \echo 'Missing -v organization_id=<uuid>'
  \quit
\endif
\if :{?approval_evidence_id}
\else
  \echo 'Missing -v approval_evidence_id=<approved-audit-uuid>'
  \quit
\endif

begin transaction read only;
with approval as (
  select a.*
  from public.motorist_audit_log a
  where a.organization_id = :'organization_id'::uuid
    and a.id = :'approval_evidence_id'::uuid
    and a.action = 'telephony.workplace.queue_probe.approved'
    and a.entity_type = 'motorist_telephony_queues'
), revocation as (
  select r.id, r.created_at, r.after_payload
  from public.motorist_audit_log r, approval a
  where r.organization_id = a.organization_id
    and r.action = 'telephony.workplace.queue_probe.revoked'
    and r.after_payload->>'approvalEvidenceId' = a.id::text
  order by r.created_at desc, r.id desc
  limit 1
)
select
  a.id as approval_evidence_id,
  a.entity_id as root_queue_id,
  a.after_payload->>'profileId' as profile_id,
  a.after_payload->>'sourceExtension' as source_extension,
  a.after_payload->>'startsAt' as starts_at,
  a.after_payload->>'endsAt' as ends_at,
  case
    when r.id is not null then 'revoked'
    when pg_catalog.clock_timestamp() < (a.after_payload->>'startsAt')::timestamptz then 'not_started'
    when pg_catalog.clock_timestamp() > (a.after_payload->>'endsAt')::timestamptz then 'expired'
    else 'inside_approved_window'
  end as audit_window_state,
  r.id as revocation_audit_id,
  'Audit state does not prove runtime environment state.'::text as safety_note
from approval a
left join revocation r on true;
commit;
