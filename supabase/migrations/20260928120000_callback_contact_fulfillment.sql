-- Additive, service-only callback fulfillment. No queue/table duplication.
-- Deploy only to this copy after explicit migration authorization.
create or replace function public.motorist_callback_number(p_number text) returns text
language sql immutable strict set search_path = public as $$
 select case when length(n) between 8 and 15 then n else null end
 from (select regexp_replace(regexp_replace(p_number, '[^0-9]', '', 'g'), '^00', '') n) normalized
$$;

-- Existing callback_requests_open_idx covers queue ordering, not this lookup.
create index if not exists callback_requests_contact_candidates_v1_idx
 on public.motorist_callback_requests (organization_id, public.motorist_callback_number(caller_number), line_id, created_at)
 where status in ('open', 'scheduled');
create index if not exists callback_requests_schedule_actions_v1_idx
 on public.motorist_callback_requests using gin ((metadata -> 'schedule_action_ids'));

-- A callback whose original write failed can appear after a successful contact.
-- This bounded reverse lookup repairs that ordering without scanning call history.
create index if not exists callback_completed_contact_sessions_v1_idx
 on public.motorist_call_sessions (organization_id,
 public.motorist_callback_number(case when direction='outbound' then called_number else caller_number end),line_id,started_at)
 where (metadata->'callback_contact'->'proofs') @> '[{"version":1}]'::jsonb;

-- All effects are one transaction. An audit/task failure rolls back resolution;
-- the session's historical continuation retries this function, including ended sessions.
create or replace function public.motorist_resolve_callback_v1(
 p_organization_id uuid, p_request_id uuid, p_actor_id uuid,
 p_status text, p_proof jsonb default null, p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.motorist_callback_requests%rowtype; before_status text; task_id uuid;
begin
 if p_status not in ('done','cancelled') then raise exception 'invalid callback status'; end if;
 if p_actor_id is not null and not exists(select 1 from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active) then raise exception 'invalid callback actor'; end if;
 select * into r from motorist_callback_requests where organization_id=p_organization_id and id=p_request_id for update;
 if not found then raise exception 'callback not found'; end if;
 if r.status in ('done','cancelled') then return to_jsonb(r); end if;
 if p_proof is null and r.claimed_by is not null and r.claimed_by is distinct from p_actor_id
   and not exists(select 1 from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and role in ('senior_dispatcher','manager','admin','owner')) then raise exception 'callback already claimed'; end if;
 before_status := r.status;
 update motorist_callback_requests set status=p_status, resolved_at=coalesce((p_proof->>'occurredAt')::timestamptz,now()),
   notes=coalesce(p_notes,notes), updated_at=now(),
   claimed_by=case when p_proof is null then coalesce(claimed_by,p_actor_id) else claimed_by end,
   claimed_at=case when p_proof is null then coalesce(claimed_at,now()) else claimed_at end,
   metadata=metadata || case when p_proof is null then jsonb_build_object('resolved_by',p_actor_id)
     else jsonb_build_object('contact_fulfillment',p_proof) end
 where id=r.id returning * into r;
 insert into motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,before_payload,after_payload)
 values(p_organization_id,p_actor_id,case when p_proof is not null then 'telephony.callback.contact_done' when p_status='done' then 'telephony.callback.done' else 'telephony.callback.cancel' end,
 'telephony_callback',r.id,case when p_proof is null then 'dispatch_console' else 'telephony' end,
 jsonb_build_object('status',before_status),jsonb_build_object('status',r.status,'claimed_by',r.claimed_by,'proof',p_proof));
 -- Never guess a legacy task link or close every callback task on the case.
 if p_status='done' and r.metadata->>'task_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   task_id := (r.metadata->>'task_id')::uuid;
   perform 1 from motorist_case_tasks where id=task_id and organization_id=p_organization_id for update;
   if not exists(select 1 from motorist_callback_requests where organization_id=p_organization_id and status in ('open','scheduled') and metadata->>'task_id'=task_id::text) then
     update motorist_case_tasks set status='done',completed_at=now(),completed_by=p_actor_id
     where id=task_id and organization_id=p_organization_id and case_id=r.case_id and kind='callback' and status='open';
   end if;
 end if;
 return to_jsonb(r);
end $$;

create or replace function public.motorist_reconcile_callback_contact_v1(p_organization_id uuid,p_session_id uuid,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.motorist_call_sessions%rowtype; r public.motorist_callback_requests%rowtype;
 exact_id uuid; number text; ids jsonb := '[]'; proof_at timestamptz; v_case_id uuid; v_line_id uuid;
begin
 select * into s from motorist_call_sessions where organization_id=p_organization_id and id=p_session_id;
 if not found then raise exception 'contact session not found'; end if;
 -- Proof must already be durable under the runner's session CAS; never trust arbitrary proof input.
 if not coalesce(s.metadata->'callback_contact'->'proofs','[]'::jsonb) @> jsonb_build_array(p_proof)
   or p_proof->>'sessionId' is distinct from s.id::text or p_proof->>'version' is distinct from '1' then raise exception 'contact proof not persisted'; end if;
 -- Independent membership webhooks cannot exclude an undelivered leave.
 -- Conference fulfillment requires the single-response provider attestation.
 if p_proof->>'topology'='conference' then
  if p_proof->'conferenceSnapshot'->>'source' is distinct from 'telnyx_conference_participants_v1'
   or p_proof->'conferenceSnapshot'->>'conferenceId' is distinct from p_proof->>'conferenceId'
   or jsonb_typeof(p_proof->'conferenceSnapshot'->'participants') is distinct from 'array' then return ids; end if;
  if jsonb_array_length(p_proof->'conferenceSnapshot'->'participants')<>2
   or (select count(distinct participant->>'callControlId') from jsonb_array_elements(p_proof->'conferenceSnapshot'->'participants') participant
    where participant->>'callControlId' in (p_proof->>'customerControlId',p_proof->>'operatorControlId')
      and nullif(participant->>'callLegId','') is not null and participant->>'status'='joined'
      and participant->'muted'='false'::jsonb and participant->'onHold'='false'::jsonb
      and participant->'whisperCallControlIds'='[]'::jsonb)<>2 then return ids; end if;
 end if;
 proof_at := (p_proof->>'occurredAt')::timestamptz;
 if proof_at < s.started_at or (p_proof->'scope'->>'startedAt')::timestamptz is distinct from s.started_at
   or p_proof->'scope'->>'organizationId' is distinct from s.organization_id::text then raise exception 'invalid contact scope'; end if;
 v_case_id := (p_proof->'scope'->>'caseId')::uuid;
 v_line_id := (p_proof->'scope'->>'lineId')::uuid;
 if s.direction='internal' then return ids; end if;
 number := public.motorist_callback_number(p_proof->'scope'->>'customerNumber');
 if number is distinct from public.motorist_callback_number(case when s.direction='outbound' then s.called_number else s.caller_number end) then return ids; end if;
 if number is null then return ids; end if;
 if s.direction='outbound' and p_proof->'scope'->>'callbackRequestId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then exact_id := (p_proof->'scope'->>'callbackRequestId')::uuid; if exact_id::text is distinct from s.metadata->>'callbackRequestId' then return ids; end if; end if;
 if exact_id is null and v_line_id is null then return ids; end if;
 -- Null-case matching is only allowed when there is no conflicting known case in the same group.
 if exact_id is null and v_case_id is null and exists(select 1 from motorist_callback_requests
   where organization_id=p_organization_id and public.motorist_callback_number(caller_number)=number and line_id=v_line_id
   and status in ('open','scheduled') and created_at<=s.started_at and case_id is not null) then return ids; end if;
 for r in select * from motorist_callback_requests
   where organization_id=p_organization_id and status in ('open','scheduled') and created_at<=s.started_at
     and public.motorist_callback_number(caller_number)=number and case_id is not distinct from v_case_id
     and ((exact_id is not null and id=exact_id) or (exact_id is null and line_id=v_line_id))
   order by id for update
 loop
   -- Preserve another explicitly running callback, even if a different contact succeeded.
   if r.metadata->'callback_call'->>'session_id' is not null and r.metadata->'callback_call'->>'session_id'<>s.id::text
     and exists(select 1 from motorist_call_sessions where organization_id=p_organization_id and id::text=r.metadata->'callback_call'->>'session_id' and state not in ('ended','failed')) then continue; end if;
   perform public.motorist_resolve_callback_v1(p_organization_id,r.id,null,'done',p_proof,null);
   ids := ids || jsonb_build_array(r.id);
 end loop;
 return ids;
end $$;

-- Called after inserting the outbound session, BEFORE reservation and any dial.
create or replace function public.motorist_link_callback_outbound_v1(p_organization_id uuid,p_request_id uuid,p_session_id uuid,p_actor_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare r public.motorist_callback_requests%rowtype; s public.motorist_call_sessions%rowtype;
begin
 select * into r from motorist_callback_requests where organization_id=p_organization_id and id=p_request_id for update;
 if not found or r.status not in ('open','scheduled') or r.claimed_by is distinct from p_actor_id then return false; end if;
 select * into s from motorist_call_sessions where id=p_session_id and organization_id=p_organization_id;
 if not found or s.direction<>'outbound' or s.answered_by_profile_id is distinct from p_actor_id
  or s.metadata->>'callbackRequestId' is distinct from p_request_id::text
  or public.motorist_callback_number(s.called_number) is distinct from public.motorist_callback_number(r.caller_number)
  or s.case_id is distinct from r.case_id then return false; end if;
 if r.metadata->'callback_call'->>'session_id'=s.id::text then return true; end if;
 if exists(select 1 from motorist_call_sessions where organization_id=p_organization_id and id::text=r.metadata->'callback_call'->>'session_id' and state not in ('ended','failed')) then return false; end if;
 update motorist_callback_requests set metadata=metadata || jsonb_build_object('callback_call',jsonb_build_object('version',1,'session_id',s.id,'at',s.started_at,'by',p_actor_id)),updated_at=now() where id=r.id;
 return true;
end $$;

create or replace function public.motorist_schedule_callback_v1(p_organization_id uuid,p_call_id uuid,p_actor_id uuid,p_action_id uuid,p_due_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.motorist_calls%rowtype; r public.motorist_callback_requests%rowtype; number text;
begin
 if not exists(select 1 from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active) then raise exception 'invalid callback actor'; end if;
 -- Same call and repeated user action serialize without a new queue or idempotency table.
 perform pg_advisory_xact_lock(hashtextextended('callback-action:'||p_organization_id::text||':'||p_action_id::text,0));
 select * into r from motorist_callback_requests where organization_id=p_organization_id and (metadata->'schedule_action_ids') @> jsonb_build_array(p_action_id::text) limit 1;
 if found then return to_jsonb(r); end if;
 select * into c from motorist_calls where organization_id=p_organization_id and id=p_call_id for update;
 if not found then raise exception 'callback call not found'; end if;
 if c.session_id is not null then perform pg_advisory_xact_lock(hashtextextended('callback-session:'||c.session_id::text,0)); end if;
 number := public.motorist_callback_number(case when c.direction='outbound' then coalesce(c.destination_number,c.called_number) else c.caller_number end);
 if number is null then raise exception 'callback number unknown'; end if;
 select * into r from motorist_callback_requests where organization_id=p_organization_id and status in ('open','scheduled')
  and ((c.session_id is not null and session_id=c.session_id) or metadata->>'scheduled_call_id'=c.id::text)
  and public.motorist_callback_number(caller_number)=number and case_id is not distinct from c.case_id order by created_at limit 1 for update;
 if found then
   update motorist_callback_requests set due_at=p_due_at,updated_at=now(),
    metadata=metadata || jsonb_build_object('scheduled_call_id',c.id,'schedule_action_ids',coalesce(metadata->'schedule_action_ids','[]'::jsonb)||jsonb_build_array(p_action_id::text))
   where id=r.id returning * into r;
 else
   insert into motorist_callback_requests(organization_id,caller_number,source,status,session_id,line_id,case_id,due_at,metadata)
   values(p_organization_id,'+'||number,'manual','open',c.session_id,c.line_id,c.case_id,p_due_at,
    jsonb_build_object('scheduled_call_id',c.id,'schedule_action_ids',jsonb_build_array(p_action_id::text),'scheduled_by',p_actor_id)) returning * into r;
 end if;
 insert into motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
 values(p_organization_id,p_actor_id,'telephony.callback.schedule','telephony_callback',r.id,'dispatch_console',jsonb_build_object('action_id',p_action_id,'due_at',p_due_at));
 return to_jsonb(r);
end $$;

revoke all on function public.motorist_callback_number(text) from public,anon,authenticated;
-- Index evaluation needs this immutable normalizer for existing allowed row writes.
grant execute on function public.motorist_callback_number(text) to authenticated,service_role;
revoke all on function public.motorist_resolve_callback_v1(uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.motorist_reconcile_callback_contact_v1(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.motorist_link_callback_outbound_v1(uuid,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.motorist_schedule_callback_v1(uuid,uuid,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.motorist_resolve_callback_v1(uuid,uuid,uuid,text,jsonb,text) to service_role;
grant execute on function public.motorist_reconcile_callback_contact_v1(uuid,uuid,jsonb) to service_role;
grant execute on function public.motorist_link_callback_outbound_v1(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.motorist_schedule_callback_v1(uuid,uuid,uuid,uuid,timestamptz) to service_role;

-- Atomic original callback obligation + exactly linked task. A retry never
-- recreates a historical missed obligation, including one already fulfilled.
create or replace function public.motorist_create_callback_obligation_v1(p_organization_id uuid,p_session_id uuid,p_plan jsonb,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.motorist_call_sessions%rowtype; r public.motorist_callback_requests%rowtype; new_task uuid; contact_session record; contact_proof jsonb; canonical_number text;
begin
 perform pg_advisory_xact_lock(hashtextextended('callback-session:'||p_session_id::text,0));
 select * into s from motorist_call_sessions where organization_id=p_organization_id and id=p_session_id;
 if not found then raise exception 'callback session not found'; end if;
 -- The server uses the shared normalizeE164 policy. Reject noncanonical direct
 -- RPC input too: an explicit IVR choice must not silently become a no-op.
 canonical_number := p_plan->>'callerNumber';
 if canonical_number is null or canonical_number !~ '^\+[1-9][0-9]{7,14}$' then
  if p_plan->'request' is not null and p_plan->'request'<>'null'::jsonb then raise exception 'callback number unavailable'; end if;
  return null;
 end if;
 select * into r from motorist_callback_requests where organization_id=p_organization_id and session_id=s.id order by created_at limit 1 for update;
 if found then
  if p_plan->'request' is not null and p_plan->'request'<>'null'::jsonb then
   update motorist_callback_requests set metadata=metadata||jsonb_build_object('request',p_plan->'request'),updated_at=p_now where id=r.id returning * into r;
  end if;
 else
 insert into motorist_callback_requests(organization_id,caller_number,caller_name,source,status,session_id,line_id,case_id,due_at,notes,metadata,created_at)
 values(p_organization_id,canonical_number,s.metadata->'match'->'top'->>'label',p_plan->>'source','open',s.id,s.line_id,s.case_id,p_now+interval '30 minutes',p_plan->>'notes',
 jsonb_build_object('state',s.state,'direction',s.direction,'callback_obligation_version',1)||case when p_plan->'request' is not null then jsonb_build_object('request',p_plan->'request') else '{}'::jsonb end,p_now) returning * into r;
 end if;
 -- Manual scheduling may win the shared session lock. Honor the automatic
 -- task promise on that same live request, without guessing any legacy link.
 if coalesce((p_plan->>'createTask')::boolean,false) and s.case_id is not null
  and r.case_id=s.case_id and r.status in ('open','scheduled') and r.metadata->>'task_id' is null
  and (r.metadata->>'callback_obligation_version'='1' or jsonb_typeof(r.metadata->'schedule_action_ids')='array') then
  insert into motorist_case_tasks(organization_id,case_id,title,kind,status,due_at,assigned_to,priority)
  values(p_organization_id,s.case_id,'Zavolať späť: '||r.caller_number,'callback','open',r.due_at,s.answered_by_profile_id,'high') returning id into new_task;
  update motorist_callback_requests set metadata=metadata||jsonb_build_object('task_id',new_task) where id=r.id returning * into r;
 end if;
 if r.status not in ('open','scheduled') then return to_jsonb(r); end if;
 -- Re-run a previously completed contact only for its original, immutable
 -- matching scope. All fulfillment effects remain in this creator transaction.
 if r.line_id is not null and public.motorist_callback_number(r.caller_number) is not null then
  for contact_session in select cs.id,cs.metadata from motorist_call_sessions cs
   where cs.organization_id=p_organization_id and cs.direction in ('inbound','outbound')
    and public.motorist_callback_number(case when cs.direction='outbound' then cs.called_number else cs.caller_number end)=public.motorist_callback_number(r.caller_number)
    and cs.line_id=r.line_id and cs.started_at>=r.created_at
    and (cs.metadata->'callback_contact'->'proofs') @> '[{"version":1}]'::jsonb
    and exists(select 1 from jsonb_array_elements(cs.metadata->'callback_contact'->'proofs') proof
      where proof->'scope'->>'lineId'=r.line_id::text and (proof->'scope'->>'caseId') is not distinct from r.case_id::text
       and (proof->>'topology' is distinct from 'conference' or proof->'conferenceSnapshot'->>'source'='telnyx_conference_participants_v1')
       and (proof->'scope'->>'callbackRequestId' is null or proof->'scope'->>'callbackRequestId'=r.id::text))
   order by cs.started_at limit 1
  loop
   for contact_proof in select value from jsonb_array_elements(contact_session.metadata->'callback_contact'->'proofs')
    where value->'scope'->>'lineId'=r.line_id::text and (value->'scope'->>'caseId') is not distinct from r.case_id::text
      and (value->>'topology' is distinct from 'conference' or value->'conferenceSnapshot'->>'source'='telnyx_conference_participants_v1')
      and (value->'scope'->>'callbackRequestId' is null or value->'scope'->>'callbackRequestId'=r.id::text)
   loop
    perform public.motorist_reconcile_callback_contact_v1(p_organization_id,contact_session.id,contact_proof);
   end loop;
  end loop;
  select * into r from motorist_callback_requests where id=r.id;
 end if;
 return to_jsonb(r);
end $$;
revoke all on function public.motorist_create_callback_obligation_v1(uuid,uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.motorist_create_callback_obligation_v1(uuid,uuid,jsonb,timestamptz) to service_role;
