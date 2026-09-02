-- MANUAL ONLY: create one immutable, time-bounded controlled queue-probe approval.
-- This file is outside supabase/migrations and never runs during deployment.
\set ON_ERROR_STOP on

\if :{?organization_id}
\else
  \echo 'Missing -v organization_id=<uuid>'
  \quit
\endif
\if :{?approving_actor_profile_id}
\else
  \echo 'Missing -v approving_actor_profile_id=<manager-or-admin-uuid>'
  \quit
\endif
\if :{?evidence_id}
\else
  \echo 'Missing -v evidence_id=<new-uuid>'
  \quit
\endif
\if :{?root_queue_id}
\else
  \echo 'Missing -v root_queue_id=<exact-601-row-uuid>'
  \quit
\endif
\if :{?probe_profile_id}
\else
  \echo 'Missing -v probe_profile_id=<exact-test-profile-uuid>'
  \quit
\endif
\if :{?source_extension}
\else
  \echo 'Missing -v source_extension=<20|21|22|23>'
  \quit
\endif
\if :{?starts_at}
\else
  \echo 'Missing -v starts_at=<canonical-ISO-8601>'
  \quit
\endif
\if :{?ends_at}
\else
  \echo 'Missing -v ends_at=<canonical-ISO-8601>'
  \quit
\endif
\if :{?fallback_reference}
\else
  \echo 'Missing -v fallback_reference=<approved-evidence-reference>'
  \quit
\endif
\if :{?provider_evidence_not_before}
\else
  \echo 'Missing -v provider_evidence_not_before=<canonical-ISO-8601>'
  \quit
\endif

drop table if exists pg_temp.motorist_queue_probe_approval_input;
create temporary table motorist_queue_probe_approval_input (
  organization_id uuid not null,
  approving_actor_profile_id uuid not null,
  evidence_id uuid not null,
  root_queue_id uuid not null,
  probe_profile_id uuid not null,
  source_extension text not null,
  starts_at_text text not null,
  starts_at timestamptz not null,
  ends_at_text text not null,
  ends_at timestamptz not null,
  fallback_reference text not null,
  provider_evidence_not_before timestamptz not null
) on commit preserve rows;
insert into motorist_queue_probe_approval_input values (
  :'organization_id'::uuid, :'approving_actor_profile_id'::uuid, :'evidence_id'::uuid,
  :'root_queue_id'::uuid, :'probe_profile_id'::uuid, :'source_extension',
  :'starts_at', :'starts_at'::timestamptz, :'ends_at', :'ends_at'::timestamptz,
  :'fallback_reference', :'provider_evidence_not_before'::timestamptz
);

begin isolation level serializable;

do $approve$
declare
  v_input pg_temp.motorist_queue_probe_approval_input%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_payload jsonb;
  v_existing public.motorist_audit_log%rowtype;
begin
  select * into strict v_input from pg_temp.motorist_queue_probe_approval_input;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('motorist.queue-probe.' || v_input.organization_id::text, 0)
  );

  if v_input.source_extension not in ('20','21','22','23')
    or v_input.starts_at_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    or v_input.ends_at_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    or pg_catalog.to_char(v_input.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_input.starts_at_text
    or pg_catalog.to_char(v_input.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_input.ends_at_text
    or v_input.starts_at < v_now - interval '5 minutes'
    or v_input.ends_at <= v_now
    or v_input.ends_at <= v_input.starts_at
    or v_input.ends_at > v_input.starts_at + interval '12 hours'
    or pg_catalog.length(v_input.fallback_reference) not between 6 and 160
    or v_input.fallback_reference !~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#-]*$'
    or v_input.provider_evidence_not_before > v_now + interval '5 seconds'
    or v_input.provider_evidence_not_before < v_now - interval '5 minutes' then
    raise exception 'WORKPLACE_QUEUE_PROBE_INPUT_INVALID' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.motorist_profiles p
    where p.organization_id = v_input.organization_id
      and p.id = v_input.approving_actor_profile_id
      and p.active = true and p.role in ('manager', 'admin')
  ) then
    raise exception 'WORKPLACE_QUEUE_PROBE_APPROVER_NOT_ELIGIBLE' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.motorist_profiles p
    where p.organization_id = v_input.organization_id and p.id = v_input.probe_profile_id
      and p.active = true and p.role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')
      and p.phone_extension = v_input.source_extension
  ) then
    raise exception 'WORKPLACE_QUEUE_PROBE_PROFILE_MISMATCH' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.motorist_telephony_queues q
    where q.organization_id = v_input.organization_id and q.id = v_input.root_queue_id
      and q.provider = 'viptel' and q.external_id = '601' and q.active = true and q.line_id is null
      and coalesce(q.metadata#>>'{dispatchRouting,operation,status}', '') in ('', 'completed', 'aborted')
      and coalesce(q.metadata->'workplaceOwnerTransition', '{}'::jsonb) = '{}'::jsonb
      and pg_catalog.jsonb_typeof(q.metadata#>'{dispatchRouting,currentPlan}') = 'object'
      and (
        select pg_catalog.count(*) from pg_catalog.jsonb_each_text(q.metadata#>'{dispatchRouting,currentPlan}') slot
        where slot.key in ('601','602','603') and slot.value = v_input.source_extension
      ) = 1
  ) or (select pg_catalog.count(*) from public.motorist_telephony_queues q
        where q.organization_id = v_input.organization_id and q.provider = 'viptel'
          and q.external_id in ('601','602','603') and q.active = true) <> 3 then
    raise exception 'WORKPLACE_QUEUE_PROBE_ROOT_OR_PLAN_MISMATCH' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.motorist_telephony_extensions e
    where e.organization_id = v_input.organization_id and e.provider = 'viptel'
      and e.extension = v_input.source_extension and e.profile_id = v_input.probe_profile_id
      and e.active = true and e.workplace_seat_generation is not null
      and e.metadata#>>'{assignmentLifecycle,state}' = 'assigned'
      and e.metadata#>>'{assignmentLifecycle,assignmentMode}' = 'workplace_claim'
      and e.metadata#>>'{assignmentLifecycle,profileId}' = v_input.probe_profile_id::text
      and e.metadata#>>'{assignmentLifecycle,extension}' = v_input.source_extension
      and exists (
        select 1 from public.motorist_audit_log a
        where a.organization_id = e.organization_id
          and a.id = (
            select latest.id from public.motorist_audit_log latest
            where latest.organization_id = e.organization_id
              and latest.entity_type = 'motorist_telephony_extensions' and latest.entity_id = e.id
              and latest.action in ('telephony.extension.assign', 'telephony.extension.unassign')
            order by latest.created_at desc, latest.id desc limit 1
          )
          and a.action = 'telephony.extension.assign'
          and a.after_payload->'assignment_lifecycle' = e.metadata->'assignmentLifecycle'
      )
  ) then
    raise exception 'WORKPLACE_QUEUE_PROBE_SOURCE_NOT_CANONICAL' using errcode = 'P0001';
  end if;
  if (select pg_catalog.count(*) from (
        select distinct on (s.queue_number) s.queue_number, s.waiting_calls, s.captured_at
        from public.motorist_queue_snapshots s
        where s.organization_id = v_input.organization_id and s.provider = 'viptel'
          and s.queue_number in ('601','602','603')
        order by s.queue_number, s.captured_at desc, s.id desc
      ) latest
      where latest.waiting_calls = 0 and latest.captured_at >= v_input.provider_evidence_not_before) <> 3 then
    raise exception 'WORKPLACE_QUEUE_PROBE_PROVIDER_EVIDENCE_INCOMPLETE' using errcode = '55P03';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'capability', 'controlled_probe',
    'organizationId', v_input.organization_id::text,
    'profileId', v_input.probe_profile_id::text,
    'sourceExtension', v_input.source_extension,
    'rootQueueId', v_input.root_queue_id::text,
    'startsAt', v_input.starts_at_text,
    'endsAt', v_input.ends_at_text,
    'fallbackReference', v_input.fallback_reference
  );
  select * into v_existing from public.motorist_audit_log
  where organization_id = v_input.organization_id and id = v_input.evidence_id
  for update;
  if found then
    if v_existing.actor_profile_id is distinct from v_input.approving_actor_profile_id
      or v_existing.action <> 'telephony.workplace.queue_probe.approved'
      or v_existing.entity_type <> 'motorist_telephony_queues'
      or v_existing.entity_id is distinct from v_input.root_queue_id
      or v_existing.after_payload is distinct from v_payload then
      raise exception 'WORKPLACE_QUEUE_PROBE_EVIDENCE_ID_CONFLICT' using errcode = '23505';
    end if;
    if exists (
      select 1
      from public.motorist_audit_log revoked
      where revoked.organization_id = v_input.organization_id
        and revoked.action = 'telephony.workplace.queue_probe.revoked'
        and revoked.after_payload->>'approvalEvidenceId' = v_existing.id::text
    ) then
      raise exception 'WORKPLACE_QUEUE_PROBE_APPROVAL_REVOKED' using errcode = '55000';
    end if;
    return;
  end if;
  if exists (
    select 1 from public.motorist_audit_log a
    where a.organization_id = v_input.organization_id
      and a.action = 'telephony.workplace.queue_probe.approved'
      and a.after_payload->>'profileId' = v_input.probe_profile_id::text
      and a.after_payload->>'sourceExtension' = v_input.source_extension
      and (a.after_payload->>'endsAt')::timestamptz > v_now
      and not exists (
        select 1 from public.motorist_audit_log revoked
        where revoked.organization_id = a.organization_id
          and revoked.action = 'telephony.workplace.queue_probe.revoked'
          and revoked.after_payload->>'approvalEvidenceId' = a.id::text
      )
  ) then
    raise exception 'WORKPLACE_QUEUE_PROBE_OVERLAPPING_APPROVAL' using errcode = '55P03';
  end if;

  insert into public.motorist_audit_log (
    id, organization_id, actor_profile_id, action, entity_type, entity_id, source,
    after_payload, created_at
  ) values (
    v_input.evidence_id, v_input.organization_id, v_input.approving_actor_profile_id,
    'telephony.workplace.queue_probe.approved', 'motorist_telephony_queues',
    v_input.root_queue_id, 'manual_queue_probe_approval', v_payload, v_now
  );
end
$approve$;

select
  a.id as viptel_workplace_queue_evidence_id,
  a.actor_profile_id as approved_by,
  a.entity_id as root_queue_id,
  a.after_payload->>'profileId' as probe_profile_id,
  a.after_payload->>'sourceExtension' as source_extension,
  a.after_payload->>'startsAt' as starts_at,
  a.after_payload->>'endsAt' as ends_at,
  a.after_payload->>'fallbackReference' as fallback_reference
from public.motorist_audit_log a
where a.organization_id = :'organization_id'::uuid and a.id = :'evidence_id'::uuid;

commit;
drop table pg_temp.motorist_queue_probe_approval_input;
