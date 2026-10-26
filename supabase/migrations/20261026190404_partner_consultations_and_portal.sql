-- Server-only, additive partner portal. No copied contacts, rates or membership seeds.
create table public.motorist_partner_memberships (
 id uuid primary key, organization_id uuid not null references public.motorist_organizations(id), partner_id uuid not null references public.motorist_partner_directory(id),
 auth_user_id uuid not null references auth.users(id), email text not null, display_name text not null,
 status text not null check(status in ('invited','active','disabled')), membership_version bigint not null default 1,
 password_set_at timestamptz, unique(organization_id,auth_user_id), unique(organization_id,id)
);
create table public.motorist_partner_invitation_intents (
 id uuid primary key, organization_id uuid not null references public.motorist_organizations(id), partner_id uuid not null references public.motorist_partner_directory(id),
 membership_id uuid not null, actor_id uuid not null, email text not null, display_name text not null, auth_user_id uuid not null, payload_hash text not null,
 state text not null default 'pending' check(state in ('pending','invited','accepted','revoked')), expires_at timestamptz not null default now()+interval '7 days', created_at timestamptz not null default now()
);
create index motorist_partner_invite_member on public.motorist_partner_invitation_intents(organization_id,membership_id,state);
create table public.motorist_partner_line_origins (
 line_id uuid primary key references public.motorist_telephony_lines(id), organization_id uuid not null references public.motorist_organizations(id), partner_id uuid not null references public.motorist_partner_directory(id), revision bigint not null default 1
);
create table public.motorist_partner_case_contexts (
 case_id uuid primary key references public.motorist_cases(id), organization_id uuid not null references public.motorist_organizations(id), partner_id uuid not null references public.motorist_partner_directory(id), partner_name text not null,
 source_call_id uuid references public.motorist_call_sessions(id), source_line_id uuid references public.motorist_telephony_lines(id), revision bigint not null default 1,
 settlement jsonb not null default '{"payer":"","reference":"","agreement":"","agreementVersion":"","billable":false,"approvedCents":null,"currency":"EUR","recommendation":"","serviceAccepted":false,"acceptanceEvidence":""}', updated_by uuid not null, updated_at timestamptz not null default now()
);
create index motorist_partner_case_org on public.motorist_partner_case_contexts(organization_id,partner_id);
create table public.motorist_partner_case_links (
 id uuid primary key, organization_id uuid not null references public.motorist_organizations(id), parent_case_id uuid not null references public.motorist_cases(id), child_case_id uuid not null unique references public.motorist_cases(id), kind text not null default 'assistance_followup' check(kind='assistance_followup'), created_by uuid not null, created_at timestamptz not null default now(), check(parent_case_id<>child_case_id)
);
create table public.motorist_partner_outputs (
 id uuid primary key, organization_id uuid not null references public.motorist_organizations(id), case_id uuid not null references public.motorist_cases(id), partner_id uuid not null references public.motorist_partner_directory(id), version bigint not null, snapshot jsonb not null, document_hash text not null, created_by uuid not null, created_at timestamptz not null default now(), unique(organization_id,case_id,version)
);
create table public.motorist_partner_shares (
 output_id uuid primary key references public.motorist_partner_outputs(id), organization_id uuid not null references public.motorist_organizations(id), partner_id uuid not null references public.motorist_partner_directory(id), created_by uuid not null, revoked_at timestamptz, created_at timestamptz not null default now()
);
create index motorist_partner_share_partner on public.motorist_partner_shares(organization_id,partner_id,created_at desc) where revoked_at is null;
create table public.motorist_partner_commands (organization_id uuid not null, command_id uuid not null, actor_id uuid not null, fingerprint text not null, result jsonb not null, created_at timestamptz not null default now(), primary key(organization_id,command_id));
create table public.motorist_partner_email_intents (id uuid primary key, organization_id uuid not null, output_id uuid references public.motorist_partner_outputs(id), invitation_id uuid references public.motorist_partner_invitation_intents(id), recipient text not null, document_hash text not null, status text not null default 'pending' check(status in ('pending','accepted','unknown','failed')), provider_message_id text, created_at timestamptz not null default now(), check(num_nonnulls(output_id,invitation_id)=1));

create function public.motorist_partner_actor(p_user_id uuid,p_organization_id uuid,p_allow_invited boolean default false) returns jsonb language sql security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object('id',m.id,'userId',m.auth_user_id,'organizationId',m.organization_id,'partnerId',m.partner_id,'displayName',m.display_name,'version',m.membership_version,'status',m.status)
 from motorist_partner_memberships m join motorist_partner_directory p on p.id=m.partner_id and p.organization_id=m.organization_id and p.active
 where m.organization_id=p_organization_id and m.auth_user_id=p_user_id and (m.status='active' or (p_allow_invited and m.status='invited' and exists(select 1 from motorist_partner_invitation_intents i where i.membership_id=m.id and i.state='invited' and i.expires_at>now())))
$$;
create function public.motorist_partner_accept(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_invitation_id uuid default null) returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare m motorist_partner_memberships;
begin
 select * into m from motorist_partner_memberships where organization_id=p_organization_id and auth_user_id=p_user_id for update;
 if m.id is null or m.membership_version<>p_membership_version or m.status='disabled' then raise insufficient_privilege; end if;
 if m.status='invited' then
  update motorist_partner_invitation_intents set state='accepted' where id=p_invitation_id and membership_id=m.id and organization_id=m.organization_id and auth_user_id=p_user_id and state='invited' and expires_at>now();
  if not found then raise insufficient_privilege; end if;
 end if;
 update motorist_partner_memberships set status='active',password_set_at=now() where id=m.id;
end $$;
create function public.motorist_partner_read(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_output_id uuid default null) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare m motorist_partner_memberships; result jsonb;
begin
 select * into m from motorist_partner_memberships where auth_user_id=p_user_id and organization_id=p_organization_id and status='active' and membership_version=p_membership_version;
 if m.id is null or not exists(select 1 from motorist_partner_directory where id=m.partner_id and organization_id=m.organization_id and active) then raise insufficient_privilege; end if;
 select coalesce(jsonb_agg(q.snapshot order by q.created_at desc),'[]') into result from (select o.snapshot,o.created_at from motorist_partner_outputs o join motorist_partner_shares s on s.output_id=o.id and s.organization_id=o.organization_id and s.partner_id=o.partner_id and s.revoked_at is null where o.organization_id=m.organization_id and o.partner_id=m.partner_id and (p_output_id is null or o.id=p_output_id) order by o.created_at desc limit 100) q;
 if p_output_id is not null and jsonb_array_length(result)=0 then raise insufficient_privilege; end if;
 return result;
end $$;

create function public.motorist_partner_command(p_user_id uuid,p_organization_id uuid,p_command_id uuid,p_expected_revision bigint,p_action text,p_payload jsonb) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a motorist_profiles; prior motorist_partner_commands; ctx motorist_partner_case_contexts; c motorist_cases; partner motorist_partner_directory; outrow motorist_partner_outputs; result jsonb; fingerprint text; target uuid; child uuid; ver bigint; settlement jsonb;
begin
 select * into a from motorist_profiles where user_id=p_user_id and organization_id=p_organization_id and active and role in ('dispatcher','senior_dispatcher','manager','admin');
 if a.id is null then raise insufficient_privilege; end if;
 if p_command_id is null or p_payload is null or octet_length(p_payload::text)>32000 then raise exception 'Neplatný príkaz'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_command_id::text,0));
 fingerprint:=md5(jsonb_build_array(p_user_id,p_action,p_expected_revision,p_payload)::text);
 select * into prior from motorist_partner_commands where organization_id=p_organization_id and command_id=p_command_id;
 if found then if prior.fingerprint<>fingerprint then raise exception 'command_content_conflict' using errcode='40001'; end if; return case when p_action='email_intent' then prior.result||'{"shouldSend":false}'::jsonb else prior.result end; end if;
 if p_action='map_line' then
  if a.role not in ('manager','admin') then raise insufficient_privilege; end if;
  if not exists(select 1 from motorist_telephony_lines where id=(p_payload->>'lineId')::uuid and organization_id=p_organization_id) or not exists(select 1 from motorist_partner_directory where id=(p_payload->>'partnerId')::uuid and organization_id=p_organization_id and active) then raise insufficient_privilege; end if;
  insert into motorist_partner_line_origins(line_id,organization_id,partner_id) values((p_payload->>'lineId')::uuid,p_organization_id,(p_payload->>'partnerId')::uuid) on conflict(line_id) do update set partner_id=excluded.partner_id,revision=motorist_partner_line_origins.revision+1 where motorist_partner_line_origins.organization_id=p_organization_id and motorist_partner_line_origins.revision=p_expected_revision;
  if not found then raise exception 'revision_conflict' using errcode='40001'; end if; result:='{"ok":true}';
 else
  target:=(p_payload->>'caseId')::uuid;
  select * into c from motorist_cases where id=target and organization_id=p_organization_id for update;
  if c.id is null then raise insufficient_privilege; end if;
  select * into ctx from motorist_partner_case_contexts where case_id=target and organization_id=p_organization_id for update;
  if p_action='set_context' then
   if coalesce(ctx.revision,0)<>p_expected_revision then raise exception 'revision_conflict' using errcode='40001'; end if;
   select * into partner from motorist_partner_directory where id=(p_payload->>'partnerId')::uuid and organization_id=p_organization_id and active;
   if partner.id is null then raise insufficient_privilege; end if;
   if ctx.case_id is not null and ctx.partner_id<>partner.id then raise exception 'Pôvod existujúcej konzultácie je nemenný'; end if;
   if nullif(p_payload->>'sourceLineId','') is not null and not exists(select 1 from motorist_telephony_lines where id=(p_payload->>'sourceLineId')::uuid and organization_id=p_organization_id) then raise insufficient_privilege; end if;
   if nullif(p_payload->>'sourceCallId','') is not null and not exists(select 1 from motorist_call_sessions where id=(p_payload->>'sourceCallId')::uuid and organization_id=p_organization_id) then raise insufficient_privilege; end if;
   settlement:=p_payload->'settlement';
   if settlement is null or jsonb_typeof(settlement)<>'object' or settlement->>'currency'<>'EUR' or (settlement->>'approvedCents')::bigint<0 or ((settlement->>'billable')::boolean and (settlement->>'approvedCents' is null or nullif(settlement->>'agreement','') is null or nullif(settlement->>'agreementVersion','') is null or nullif(settlement->>'payer','') is null)) or ((settlement->>'serviceAccepted')::boolean and nullif(settlement->>'acceptanceEvidence','') is null) then raise exception 'Potvrďte dohodu, platiteľa, sumu a dôkaz prijatia'; end if;
   insert into motorist_partner_case_contexts(case_id,organization_id,partner_id,partner_name,source_line_id,source_call_id,settlement,updated_by) values(target,p_organization_id,partner.id,partner.name,nullif(p_payload->>'sourceLineId','')::uuid,nullif(p_payload->>'sourceCallId','')::uuid,settlement,a.id) on conflict(case_id) do update set settlement=excluded.settlement,revision=motorist_partner_case_contexts.revision+1,updated_by=a.id,updated_at=now(); result:='{"ok":true}';
  else
   if ctx.case_id is null or ctx.revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='40001'; end if;
   if p_action='create_assistance' then
    if exists(select 1 from motorist_partner_case_links where child_case_id=target) then raise exception 'Asistenciu možno založiť iba z konzultácie'; end if;
    if nullif(btrim(p_payload->>'payer'),'') is null or nullif(btrim(p_payload->>'reference'),'') is null then raise exception 'Vyplňte samostatného platiteľa a referenciu asistencie'; end if;
    child:=gen_random_uuid();
    insert into motorist_cases(id,organization_id,case_number,status,priority,source_type,case_type,assistance_reference,payment_details,customer_details,summary) values(child,p_organization_id,'A-'||upper(substr(replace(child::text,'-',''),1,14)),'new','normal','assistance','Asistencia',p_payload->>'reference',jsonb_build_object('payer',p_payload->>'payer'),jsonb_build_object('type','insurance','assistanceServiceName',p_payload->>'payer','assistanceReference',p_payload->>'reference'),coalesce(p_payload->>'summary','Nadväzujúca asistencia'));
    insert into motorist_partner_case_links(id,organization_id,parent_case_id,child_case_id,created_by) values(p_command_id,p_organization_id,target,child,a.id);
    result:=jsonb_build_object('ok',true,'caseId',child);
   elsif p_action='publish' then
    if coalesce(p_payload->>'confirmed','false')<>'true' or nullif(btrim(p_payload->>'title'),'') is null or nullif(btrim(p_payload->>'result'),'') is null or coalesce(p_payload->>'recipient','') !~ '^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$' then raise exception 'Potvrďte obsah a príjemcu výstupu'; end if;
    select coalesce(max(version),0)+1 into ver from motorist_partner_outputs where organization_id=p_organization_id and case_id=target;
    result:=jsonb_build_object('id',p_command_id,'caseId',target,'caseNumber',c.case_number,'partnerId',ctx.partner_id,'partnerName',ctx.partner_name,'version',ver,'title',p_payload->>'title','result',p_payload->>'result','recipient',lower(p_payload->>'recipient'),'publishedAt',now());
    result:=result||jsonb_build_object('hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
    insert into motorist_partner_outputs(id,organization_id,case_id,partner_id,version,snapshot,document_hash,created_by) values(p_command_id,p_organization_id,target,ctx.partner_id,ver,result,result->>'hash',a.id);
    insert into motorist_partner_shares(output_id,organization_id,partner_id,created_by) values(p_command_id,p_organization_id,ctx.partner_id,a.id);
   elsif p_action='revoke_share' then
    update motorist_partner_shares set revoked_at=now() where output_id=(p_payload->>'outputId')::uuid and organization_id=p_organization_id and exists(select 1 from motorist_partner_outputs o where o.id=motorist_partner_shares.output_id and o.case_id=target); if not found then raise insufficient_privilege; end if; result:='{"ok":true}';
   elsif p_action='email_intent' then
    select * into outrow from motorist_partner_outputs where id=(p_payload->>'outputId')::uuid and organization_id=p_organization_id and case_id=target;
    if outrow.id is null or not exists(select 1 from motorist_partner_shares where output_id=outrow.id and revoked_at is null) then raise insufficient_privilege; end if;
    insert into motorist_partner_email_intents(id,organization_id,output_id,recipient,document_hash) values(p_command_id,p_organization_id,outrow.id,outrow.snapshot->>'recipient',p_payload->>'documentHash'); result:=jsonb_build_object('shouldSend',true);
   elsif p_action='email_result' then
    update motorist_partner_email_intents set status=p_payload->>'status',provider_message_id=p_payload->>'providerMessageId' where id=(p_payload->>'intentId')::uuid and organization_id=p_organization_id and output_id=(p_payload->>'outputId')::uuid and status='pending'; result:='{"ok":true}';
   else raise exception 'Nepovolená operácia'; end if;
  end if;
 end if;
 insert into motorist_partner_commands(organization_id,command_id,actor_id,fingerprint,result) values(p_organization_id,p_command_id,a.id,fingerprint,result);
 return result;
end $$;

do $$ declare t text; f regprocedure; begin
 foreach t in array array['motorist_partner_memberships','motorist_partner_invitation_intents','motorist_partner_line_origins','motorist_partner_case_contexts','motorist_partner_case_links','motorist_partner_outputs','motorist_partner_shares','motorist_partner_commands','motorist_partner_email_intents'] loop
 execute format('alter table public.%I enable row level security',t); execute format('revoke all on public.%I from anon,authenticated',t); execute format('grant all on public.%I to service_role',t);
 end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('motorist_partner_actor','motorist_partner_accept','motorist_partner_read','motorist_partner_command') loop
 execute format('revoke all on function %s from public,anon,authenticated',f); execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
create function public.motorist_partner_membership_command(p_user_id uuid,p_organization_id uuid,p_action text,p_payload jsonb) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a motorist_profiles; i motorist_partner_invitation_intents; m motorist_partner_memberships; prior motorist_partner_commands; fp text;
begin
 select * into a from motorist_profiles where user_id=p_user_id and organization_id=p_organization_id and active and role in ('admin','manager');
 if a.id is null then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||(p_payload->>'membershipId'),0));
 if p_action='prepare' then
  if not exists(select 1 from motorist_partner_directory where id=(p_payload->>'partnerId')::uuid and organization_id=p_organization_id and active) then raise insufficient_privilege; end if;
  select * into i from motorist_partner_invitation_intents where id=(p_payload->>'commandId')::uuid;
  if i.id is not null then
   if i.organization_id<>p_organization_id or i.actor_id<>a.id or i.payload_hash<>p_payload->>'payloadHash' then raise exception 'invite_content_conflict' using errcode='40001'; end if; return to_jsonb(i);
  end if;
  select * into m from motorist_partner_memberships where id=(p_payload->>'membershipId')::uuid;
  if m.id is not null and (m.organization_id<>p_organization_id or m.partner_id<>(p_payload->>'partnerId')::uuid or m.auth_user_id<>(p_payload->>'userId')::uuid) then raise insufficient_privilege; end if;
  if p_payload->>'existing'='true' and not (
    exists(select 1 from motorist_profiles where user_id=(p_payload->>'userId')::uuid and organization_id=p_organization_id and active and lower(email)=lower(p_payload->>'email')) or
    exists(select 1 from motorist_towing_memberships where auth_user_id=(p_payload->>'userId')::uuid and organization_id=p_organization_id and active and lower(email)=lower(p_payload->>'email')) or
    exists(select 1 from motorist_partner_memberships where auth_user_id=(p_payload->>'userId')::uuid and organization_id=p_organization_id and id=(p_payload->>'membershipId')::uuid and lower(email)=lower(p_payload->>'email'))
  ) then raise insufficient_privilege; end if;
  insert into motorist_partner_invitation_intents(id,organization_id,partner_id,membership_id,actor_id,email,display_name,auth_user_id,payload_hash)
   values((p_payload->>'commandId')::uuid,p_organization_id,(p_payload->>'partnerId')::uuid,(p_payload->>'membershipId')::uuid,a.id,p_payload->>'email',p_payload->>'displayName',(p_payload->>'userId')::uuid,p_payload->>'payloadHash') returning * into i;
  return to_jsonb(i);
 elsif p_action='commit' then
  select * into i from motorist_partner_invitation_intents where id=(p_payload->>'commandId')::uuid and organization_id=p_organization_id and actor_id=a.id for update;
  if i.id is null or i.expires_at<=now() or i.state='revoked' then raise insufficient_privilege; end if;
  if i.state in ('invited','accepted') then return jsonb_build_object('ok',true); end if;
  update motorist_partner_invitation_intents set state='revoked' where membership_id=i.membership_id and id<>i.id and state in ('pending','invited');
  insert into motorist_partner_memberships(id,organization_id,partner_id,auth_user_id,email,display_name,status) values(i.membership_id,i.organization_id,i.partner_id,i.auth_user_id,i.email,i.display_name,'invited')
   on conflict(id) do update set status='invited',membership_version=motorist_partner_memberships.membership_version+1 where motorist_partner_memberships.organization_id=i.organization_id and motorist_partner_memberships.partner_id=i.partner_id and motorist_partner_memberships.auth_user_id=i.auth_user_id;
  if not found then raise insufficient_privilege; end if;
  update motorist_partner_invitation_intents set state='invited' where id=i.id;
  return jsonb_build_object('ok',true);
 elsif p_action='disable' then
  if nullif(p_payload->>'commandId','') is null then raise exception 'command_id_required'; end if;
  fp:=md5(jsonb_build_array(p_user_id,p_action,p_payload)::text);
  select * into prior from motorist_partner_commands where organization_id=p_organization_id and command_id=(p_payload->>'commandId')::uuid;
  if prior.command_id is not null then if prior.fingerprint<>fp then raise exception 'command_content_conflict' using errcode='40001'; end if; return prior.result; end if;
  update motorist_partner_memberships set status='disabled',membership_version=membership_version+1 where id=(p_payload->>'membershipId')::uuid and organization_id=p_organization_id and membership_version=(p_payload->>'expectedVersion')::bigint;
  if not found then raise exception 'revision_conflict' using errcode='40001'; end if;
  update motorist_partner_invitation_intents set state='revoked' where membership_id=(p_payload->>'membershipId')::uuid and organization_id=p_organization_id and state in ('pending','invited');
  insert into motorist_partner_commands(organization_id,command_id,actor_id,fingerprint,result) values(p_organization_id,(p_payload->>'commandId')::uuid,a.id,fp,'{"ok":true}');
  return jsonb_build_object('ok',true);
 else raise exception 'Neplatná operácia'; end if;
end $$;
revoke all on function public.motorist_partner_membership_command(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_partner_membership_command(uuid,uuid,text,jsonb) to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('motorist-partner-documents','motorist-partner-documents',false,10485760,array['application/pdf']) on conflict(id) do nothing;
-- Published versions and command receipts cannot be edited by the application.
revoke update,delete on public.motorist_partner_outputs,public.motorist_partner_commands from service_role;
create function public.motorist_partner_report(p_user_id uuid,p_organization_id uuid) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from motorist_profiles where user_id=p_user_id and organization_id=p_organization_id and active and role in ('dispatcher','senior_dispatcher','manager','admin')) then raise insufficient_privilege; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('partnerId',d.id,'partnerName',d.name,
  'consultations',(select count(*) from motorist_partner_case_contexts c where c.organization_id=p_organization_id and c.partner_id=d.id),
  'calls',(select count(distinct s.id) from motorist_call_sessions s join motorist_partner_case_contexts c on c.case_id=s.case_id and c.organization_id=s.organization_id where c.organization_id=p_organization_id and c.partner_id=d.id),
  'operations',(select count(distinct o.id) from motorist_operations o where o.organization_id=p_organization_id and (exists(select 1 from motorist_partner_case_contexts c where c.organization_id=o.organization_id and c.partner_id=d.id and c.case_id=o.case_id) or exists(select 1 from motorist_partner_case_links l join motorist_partner_case_contexts c on c.case_id=l.parent_case_id and c.organization_id=l.organization_id where l.organization_id=o.organization_id and l.child_case_id=o.case_id and c.partner_id=d.id))),
  'approvedCents',(select sum((c.settlement->>'approvedCents')::bigint) from motorist_partner_case_contexts c where c.organization_id=p_organization_id and c.partner_id=d.id and c.settlement->>'billable'='true'),
  'unpriced',(select count(*) from motorist_partner_case_contexts c where c.organization_id=p_organization_id and c.partner_id=d.id and c.settlement->>'approvedCents' is null)
 )) from motorist_partner_directory d where d.organization_id=p_organization_id and exists(select 1 from motorist_partner_case_contexts c where c.organization_id=p_organization_id and c.partner_id=d.id)),'[]');
end $$;
revoke all on function public.motorist_partner_report(uuid,uuid) from public,anon,authenticated;
grant execute on function public.motorist_partner_report(uuid,uuid) to service_role;
