-- Separate Telnyx copy. Operational owner instruction is not an app-user action.
-- Service-role writes only; this adds no public activation endpoint or account.
begin;

create function public.motorist_recording_policy_fingerprint(p_policy jsonb)
returns text language sql immutable strict set search_path=public,pg_temp as $$
 select encode(sha256(convert_to((
  (p_policy - array['revision','approved_at','approved_by','created_at','updated_at','config'])
  || jsonb_build_object('config',coalesce(p_policy->'config','{}'::jsonb)-'owner_approval')
 )::text,'UTF8')),'hex')
$$;

create function public.motorist_recording_owner_approval_valid(p_policy jsonb)
returns boolean language sql immutable strict set search_path=public,pg_temp as $$
 select coalesce(
  jsonb_typeof(p_policy#>'{config,owner_approval}')='object'
  and p_policy#>>'{config,owner_approval,source}'='owner_instruction'
  and length(p_policy#>>'{config,owner_approval,reference}') between 32 and 2000
  and p_policy#>>'{config,owner_approval,instruction_sha256}' ~ '^[0-9a-f]{64}$'
  and p_policy#>>'{config,owner_approval,contact_email}'=p_policy->>'contact_email'
  and coalesce(p_policy->>'contact_email','')<>''
  and coalesce(p_policy->>'controller_name','')<>''
  and p_policy#>>'{config,owner_approval,policy_sha256}'=motorist_recording_policy_fingerprint(p_policy)
 ,false)
$$;

alter table public.motorist_call_recording_policies
 drop constraint motorist_call_recording_policies_check,
 add constraint recording_policy_approval_required check(
  (not(recording_enabled or transcription_enabled or analysis_enabled or quality_enabled) or approved_at is not null)
  and (approved_at is null or approved_by is not null or motorist_recording_owner_approval_valid(to_jsonb(motorist_call_recording_policies)))
 );

create function public.motorist_recording_policy_clear_owner_approval()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 -- The existing app RPC names the authenticated manager. Do not retain a stale
 -- deployment authorization when an app approval replaces or revokes it.
 if new.approved_by is not null or new.approved_at is null then
  new.config:=new.config-'owner_approval';
 end if;
 return new;
end $$;
create trigger recording_policy_clear_owner_approval before insert or update
 on public.motorist_call_recording_policies for each row
 execute function public.motorist_recording_policy_clear_owner_approval();

create function public.motorist_recording_policy_audit_owner_approval()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.approved_by is null and new.approved_at is not null
 and (tg_op='INSERT' or old.config->'owner_approval' is distinct from new.config->'owner_approval' or old.approved_at is distinct from new.approved_at) then
  insert into motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
  values(new.organization_id,null,'recording_policy.owner_instruction','recording_policy',new.organization_id,'deployment',
   jsonb_build_object('revision',new.revision,'approved_at',new.approved_at,'provenance',new.config->'owner_approval'));
 end if;
 return new;
end $$;
create trigger recording_policy_audit_owner_approval after insert or update
 on public.motorist_call_recording_policies for each row
 execute function public.motorist_recording_policy_audit_owner_approval();

revoke all on function public.motorist_recording_policy_fingerprint(jsonb),public.motorist_recording_owner_approval_valid(jsonb),public.motorist_recording_policy_clear_owner_approval(),public.motorist_recording_policy_audit_owner_approval() from public,anon,authenticated;
grant execute on function public.motorist_recording_policy_fingerprint(jsonb),public.motorist_recording_owner_approval_valid(jsonb) to service_role;
commit;
