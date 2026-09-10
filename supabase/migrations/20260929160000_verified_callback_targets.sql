-- Explicit directory verification. Never rewrite historical callers or infer a target.
create table public.motorist_callback_target_verifications (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations,
 source_contact_id uuid not null references public.motorist_contacts on delete restrict,
 target_contact_id uuid not null references public.motorist_contacts on delete restrict,
 source_number text not null, target_number text not null, verified_by uuid not null references public.motorist_profiles,
 verified_at timestamptz not null default now(), check(source_contact_id<>target_contact_id),check(source_number<>target_number)
);
create table public.motorist_contact_callback_policies (
 source_contact_id uuid primary key references public.motorist_contacts on delete cascade,
 organization_id uuid not null references public.motorist_organizations, non_callback boolean not null default false,
 verification_id uuid references public.motorist_callback_target_verifications, revision bigint not null default 1,
 updated_at timestamptz not null default now()
);
-- Retain explicitly non-callback source numbers through later contact edits.
create table public.motorist_noncallback_source_numbers (
 organization_id uuid not null references public.motorist_organizations,
 source_contact_id uuid not null references public.motorist_contacts on delete cascade,
 number text not null, primary key(source_contact_id,number)
);
alter table public.motorist_noncallback_source_numbers enable row level security;
revoke all on public.motorist_noncallback_source_numbers from public,anon,authenticated,service_role;
grant select on public.motorist_noncallback_source_numbers to service_role;
alter table public.motorist_callback_target_verifications enable row level security;
alter table public.motorist_contact_callback_policies enable row level security;
revoke all on public.motorist_callback_target_verifications,public.motorist_contact_callback_policies from public,anon,authenticated,service_role;
grant select on public.motorist_callback_target_verifications,public.motorist_contact_callback_policies to service_role;

-- Same conservative SK-default normalization as normalize-e164.ts. Not a fuzzy lookup.
create or replace function public.motorist_directory_number(p_value text) returns text
language plpgsql immutable set search_path=public as $$
declare v text:=trim(p_value); cc text; international boolean:=false;
begin
 if v is null or v='' then return null; end if;
 v:=regexp_replace(v,'^tel:','','i');
 v:=replace(v,'(0)',''); v:=regexp_replace(v,'[[:space:]()./-]','','g');
 if v like '+%' then v:=substr(v,2); international:=true;
 elsif v like '00%' then v:=substr(v,3); international:=true; end if;
 if v!~'^[0-9]+$' then return null; end if;
 if not international then
  if v like '0%' then v:='421'||substr(v,2);
  elsif length(v)=9 then v:='421'||v;
  elsif length(v)<11 or not(v ~ '^(421|420|43|49|36|48|44|33|31|32|40|385|386|380|375|370|371)') then return null; end if;
 end if;
 foreach cc in array array['421','420','43','49','36','48','44','33','31','32','40','385','386','380','375','370','371'] loop
  if v like cc||'%' then
   if substr(v,length(cc)+1,1)='0' then v:=cc||substr(v,length(cc)+2); if substr(v,length(cc)+1,1)='0' then return null; end if; end if;
   exit;
  end if;
 end loop;
 if v!~'^[1-9][0-9]{7,14}$' then return null; end if;
 return '+'||v;
end $$;

create or replace function public.motorist_resolve_callback_target(p_organization_id uuid,p_number text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare result jsonb:=jsonb_build_object('originalNumber',p_number,'dialNumber',p_number,'status','original','sourceContactId',null,'sourceName',null,'targetContactId',null,'targetName',null,'verificationId',null);
 c public.motorist_contacts%rowtype; t public.motorist_contacts%rowtype; p public.motorist_contact_callback_policies%rowtype; v public.motorist_callback_target_verifications%rowtype; n text:=public.motorist_directory_number(p_number); total int;
begin
 if n is null then return result; end if;
 select count(*) into total from motorist_contact_callback_policies cp join motorist_contacts co on co.id=cp.source_contact_id and co.organization_id=cp.organization_id
  where cp.organization_id=p_organization_id and cp.non_callback and (public.motorist_directory_number(co.phone)=n or exists(select 1 from motorist_noncallback_source_numbers sn where sn.source_contact_id=co.id and sn.organization_id=p_organization_id and sn.number=n));
 if total=0 then return result; end if;
 result:=result||jsonb_build_object('dialNumber',null,'status','blocked');
 if total<>1 then return result; end if;
 select cp.* into p from motorist_contact_callback_policies cp join motorist_contacts co on co.id=cp.source_contact_id and co.organization_id=cp.organization_id
  where cp.organization_id=p_organization_id and cp.non_callback and (public.motorist_directory_number(co.phone)=n or exists(select 1 from motorist_noncallback_source_numbers sn where sn.source_contact_id=co.id and sn.organization_id=p_organization_id and sn.number=n));
 select * into c from motorist_contacts where id=p.source_contact_id and organization_id=p_organization_id;
 result:=result||jsonb_build_object('sourceContactId',c.id,'sourceName',c.name);
 select * into v from motorist_callback_target_verifications where id=p.verification_id and organization_id=p_organization_id and source_contact_id=c.id and source_number=n;
 if not found then return result; end if;
 select * into t from motorist_contacts where id=v.target_contact_id and organization_id=p_organization_id and public.motorist_directory_number(phone)=v.target_number;
 if not found or exists(select 1 from motorist_contact_callback_policies cp join motorist_contacts co on co.id=cp.source_contact_id where cp.organization_id=p_organization_id and cp.non_callback and (public.motorist_directory_number(co.phone)=v.target_number or exists(select 1 from motorist_noncallback_source_numbers sn where sn.source_contact_id=co.id and sn.organization_id=p_organization_id and sn.number=v.target_number))) then return result; end if;
 return result||jsonb_build_object('dialNumber',v.target_number,'status','verified_alternative','targetContactId',t.id,'targetName',t.name,'verificationId',v.id);
end $$;

create or replace function public.motorist_contact_callback_policy(p_organization_id uuid,p_actor_id uuid,p_contact_id uuid,p_action text,p_non_callback boolean default false,p_target_contact_id uuid default null,p_expected_revision bigint default 0,p_verified boolean default false) returns jsonb
language plpgsql security definer set search_path=public as $$
declare actor_role text; c public.motorist_contacts%rowtype; t public.motorist_contacts%rowtype; p public.motorist_contact_callback_policies%rowtype; v public.motorist_callback_target_verifications%rowtype;
begin
 select role into actor_role from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active;
 if actor_role is null or actor_role not in ('dispatcher','senior_dispatcher','manager','admin') or p_action='save' and actor_role not in ('manager','admin') then raise exception 'unauthorized actor' using errcode='42501'; end if;
 select * into c from motorist_contacts where id=p_contact_id and organization_id=p_organization_id for update;
 if not found then raise exception 'contact not found' using errcode='P0002'; end if;
 select * into p from motorist_contact_callback_policies where source_contact_id=c.id and organization_id=p_organization_id;
 if p_action='save' then
  if p_non_callback is null then raise exception 'invalid noncallback policy' using errcode='22023'; end if;
  if coalesce(p.revision,0) is distinct from p_expected_revision then raise exception 'stale policy' using errcode='40001'; end if;
  if p_target_contact_id is not null then
   select * into t from motorist_contacts where id=p_target_contact_id and organization_id=p_organization_id for share;
   if not found or t.id=c.id or p_non_callback is not true or p_verified is not true or public.motorist_directory_number(c.phone) is null or public.motorist_directory_number(t.phone) is null
    or public.motorist_directory_number(t.phone)=public.motorist_directory_number(c.phone)
    or exists(select 1 from motorist_contact_callback_policies cp join motorist_contacts co on co.id=cp.source_contact_id where cp.organization_id=p_organization_id and cp.non_callback and (public.motorist_directory_number(co.phone)=public.motorist_directory_number(t.phone) or exists(select 1 from motorist_noncallback_source_numbers sn where sn.source_contact_id=co.id and sn.organization_id=p_organization_id and sn.number=public.motorist_directory_number(t.phone)))) then raise exception 'invalid verified target' using errcode='22023'; end if;
   insert into motorist_callback_target_verifications(organization_id,source_contact_id,target_contact_id,source_number,target_number,verified_by)
    values(p_organization_id,c.id,t.id,public.motorist_directory_number(c.phone),public.motorist_directory_number(t.phone),p_actor_id) returning * into v;
  end if;
  if p_non_callback and public.motorist_directory_number(c.phone) is not null then
   insert into motorist_noncallback_source_numbers values(p_organization_id,c.id,public.motorist_directory_number(c.phone)) on conflict do nothing;
  end if;
  insert into motorist_contact_callback_policies(source_contact_id,organization_id,non_callback,verification_id,revision)
   values(c.id,p_organization_id,p_non_callback,v.id,coalesce(p.revision,0)+1)
   on conflict(source_contact_id) do update set non_callback=excluded.non_callback,verification_id=excluded.verification_id,revision=excluded.revision,updated_at=now() returning * into p;
 elsif p_action<>'get' then raise exception 'invalid action' using errcode='22023'; end if;
 select * into v from motorist_callback_target_verifications where id=p.verification_id;
 return jsonb_build_object('sourceContactId',c.id,'nonCallback',coalesce(p.non_callback,false),'targetContactId',v.target_contact_id,'verificationId',v.id,'revision',coalesce(p.revision,0),'verifiedAt',v.verified_at);
end $$;

-- Contact edits invalidate current verification and retain the old blocked source.
create or replace function public.motorist_invalidate_callback_verification() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if public.motorist_directory_number(old.phone) is not distinct from public.motorist_directory_number(new.phone) then return new; end if;
 if exists(select 1 from motorist_contact_callback_policies where source_contact_id=old.id and non_callback) and public.motorist_directory_number(old.phone) is not null then
  insert into motorist_noncallback_source_numbers values(old.organization_id,old.id,public.motorist_directory_number(old.phone)) on conflict do nothing;
 end if;
 update motorist_contact_callback_policies cp set verification_id=null,revision=revision+1,updated_at=now()
  where cp.source_contact_id=old.id or cp.verification_id in (select id from motorist_callback_target_verifications where target_contact_id=old.id);
 return new;
end $$;
create trigger motorist_contacts_invalidate_callback_target before update of phone on public.motorist_contacts for each row execute function public.motorist_invalidate_callback_verification();

create or replace function public.motorist_approve_callback_target(p_organization_id uuid,p_actor_id uuid,p_request_id uuid,p_verification_id uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare r public.motorist_callback_requests%rowtype; target jsonb; v_authorization jsonb;
begin
 if not exists(select 1 from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active and role in ('dispatcher','senior_dispatcher','manager','admin')) then raise exception 'unauthorized actor' using errcode='42501'; end if;
 select * into r from motorist_callback_requests where organization_id=p_organization_id and id=p_request_id for update;
 if not found then raise exception 'request not found' using errcode='P0002'; end if;
 if r.status not in ('open','scheduled') or r.claimed_by is distinct from p_actor_id then raise exception 'request not owned' using errcode='42501'; end if;
 target:=public.motorist_resolve_callback_target(p_organization_id,r.caller_number);
 if target->>'status'<>'verified_alternative' or target->>'verificationId' is distinct from p_verification_id::text then raise exception 'verification changed' using errcode='40001'; end if;
 v_authorization:=jsonb_build_object('version',1,'requestId',r.id,'verificationId',p_verification_id,'originalNumber',public.motorist_directory_number(r.caller_number),'targetNumber',target->>'dialNumber','actorProfileId',p_actor_id,'approvedAt',now());
 update motorist_callback_requests set metadata=coalesce(metadata,'{}')||jsonb_build_object('callback_target_authorization',v_authorization),updated_at=now() where id=r.id;
 return target;
end $$;

create or replace function public.motorist_link_callback_outbound_v1(p_organization_id uuid,p_request_id uuid,p_session_id uuid,p_actor_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare r public.motorist_callback_requests%rowtype; s public.motorist_call_sessions%rowtype; target jsonb; v_authorization jsonb;
begin
 select * into r from motorist_callback_requests where organization_id=p_organization_id and id=p_request_id for update;
 if not found or r.status not in ('open','scheduled') or r.claimed_by is distinct from p_actor_id then return false; end if;
 select * into s from motorist_call_sessions where id=p_session_id and organization_id=p_organization_id;
 if not found or s.direction<>'outbound' or s.answered_by_profile_id is distinct from p_actor_id
  or s.metadata->>'callbackRequestId' is distinct from p_request_id::text
  or s.case_id is distinct from r.case_id then return false; end if;
 if r.metadata->'callback_call'->>'session_id'=s.id::text then return true; end if;
 target:=public.motorist_resolve_callback_target(p_organization_id,r.caller_number);
 if target->>'status'='blocked' then return false; end if;
 if target->>'status'='original' then
  if public.motorist_directory_number(s.called_number) is distinct from public.motorist_directory_number(r.caller_number) then return false; end if;
 else
  v_authorization:=r.metadata->'callback_target_authorization';
  if v_authorization->>'version' is distinct from '1' or v_authorization->>'requestId' is distinct from r.id::text
   or v_authorization->>'actorProfileId' is distinct from p_actor_id::text
   or v_authorization->>'verificationId' is distinct from target->>'verificationId'
   or v_authorization->>'originalNumber' is distinct from public.motorist_directory_number(r.caller_number)
   or v_authorization->>'targetNumber' is distinct from target->>'dialNumber'
   or public.motorist_directory_number(s.called_number) is distinct from target->>'dialNumber' then return false; end if;
  -- Before reservation/dial, freeze exact approval into the new session. The runner
  -- subsequently owns session metadata via CAS, so no late session writes here.
  update motorist_call_sessions set metadata=coalesce(metadata,'{}')||jsonb_build_object('callback_target_authorization',v_authorization) where id=s.id;
 end if;
 if exists(select 1 from motorist_call_sessions where organization_id=p_organization_id and id::text=r.metadata->'callback_call'->>'session_id' and state not in ('ended','failed')) then return false; end if;
 update motorist_callback_requests set metadata=metadata || jsonb_build_object('callback_call',jsonb_build_object('version',1,'session_id',s.id,'at',s.started_at,'by',p_actor_id)),updated_at=now() where id=r.id;
 return true;
end $$;


create or replace function public.motorist_reconcile_callback_contact_v1(p_organization_id uuid,p_session_id uuid,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.motorist_call_sessions%rowtype; r public.motorist_callback_requests%rowtype;
 exact_id uuid; number text; v_authorization jsonb; alternate boolean:=false; ids jsonb := '[]'; proof_at timestamptz; v_case_id uuid; v_line_id uuid;
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
 v_authorization:=p_proof->'scope'->'callbackTargetAuthorization';
 if v_authorization is not null then
  if exact_id is null or s.direction<>'outbound' or v_authorization is distinct from s.metadata->'callback_target_authorization'
   or v_authorization->>'version' is distinct from '1' or v_authorization->>'requestId' is distinct from exact_id::text
   or v_authorization->>'actorProfileId' is distinct from s.metadata->'outbound'->>'by'
   or v_authorization->>'targetNumber' is distinct from public.motorist_directory_number(s.called_number)
   or not exists(select 1 from motorist_callback_target_verifications v where v.id::text=v_authorization->>'verificationId' and v.organization_id=p_organization_id
     and v.source_number=v_authorization->>'originalNumber' and v.target_number=v_authorization->>'targetNumber')
   or not exists(select 1 from motorist_callback_requests cr where cr.id=exact_id and cr.organization_id=p_organization_id
     and public.motorist_directory_number(cr.caller_number)=v_authorization->>'originalNumber'
     and cr.metadata->'callback_call'->>'session_id'=s.id::text) then return ids; end if;
  alternate:=true;
 end if;
 -- Alternate target must carry its frozen binding; a bare actual customer number
 -- can never group-fulfill obligations for the original or sibling callers.
 if s.metadata ? 'callback_target_authorization' and not alternate then return ids; end if;
 if exact_id is null and v_line_id is null then return ids; end if;
 -- Null-case matching is only allowed when there is no conflicting known case in the same group.
 if exact_id is null and v_case_id is null and exists(select 1 from motorist_callback_requests
   where organization_id=p_organization_id and public.motorist_callback_number(caller_number)=number and line_id=v_line_id
   and status in ('open','scheduled') and created_at<=s.started_at and case_id is not null) then return ids; end if;
 for r in select * from motorist_callback_requests
   where organization_id=p_organization_id and status in ('open','scheduled') and created_at<=s.started_at
     and ((not alternate and public.motorist_callback_number(caller_number)=number) or (alternate and id=exact_id and public.motorist_directory_number(caller_number)=v_authorization->>'originalNumber')) and case_id is not distinct from v_case_id
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


revoke all on function public.motorist_resolve_callback_target(uuid,text),public.motorist_contact_callback_policy(uuid,uuid,uuid,text,boolean,uuid,bigint,boolean),public.motorist_approve_callback_target(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.motorist_resolve_callback_target(uuid,text),public.motorist_contact_callback_policy(uuid,uuid,uuid,text,boolean,uuid,bigint,boolean),public.motorist_approve_callback_target(uuid,uuid,uuid,uuid) to service_role;

notify pgrst, 'reload schema';
