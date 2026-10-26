-- Read only aggregate data through a scoped RPC. Operations base tables remain
-- inaccessible to service_role; the current office profile is revalidated inside.
begin;
create or replace function public.motorist_partner_report(p_user_id uuid,p_organization_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.motorist_profiles where user_id=p_user_id and organization_id=p_organization_id and active and role in ('dispatcher','senior_dispatcher','manager','admin')) then raise insufficient_privilege; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('partnerId',d.id,'partnerName',d.name,
  'consultations',(select count(*) from public.motorist_partner_case_contexts c where c.organization_id=p_organization_id and c.partner_id=d.id),
  'calls',(select count(distinct s.id) from public.motorist_call_sessions s join public.motorist_partner_case_contexts c on c.case_id=s.case_id and c.organization_id=s.organization_id where c.organization_id=p_organization_id and c.partner_id=d.id),
  'operations',(select count(distinct o.id) from public.motorist_operations o where o.organization_id=p_organization_id and (exists(select 1 from public.motorist_partner_case_contexts c where c.organization_id=o.organization_id and c.partner_id=d.id and c.case_id=o.case_id) or exists(select 1 from public.motorist_partner_case_links l join public.motorist_partner_case_contexts c on c.case_id=l.parent_case_id and c.organization_id=l.organization_id where l.organization_id=o.organization_id and l.child_case_id=o.case_id and c.partner_id=d.id))),
  'approvedCents',(select sum((c.settlement->>'approvedCents')::bigint) from public.motorist_partner_case_contexts c where c.organization_id=p_organization_id and c.partner_id=d.id and c.settlement->>'billable'='true'),
  'unpriced',(select count(*) from public.motorist_partner_case_contexts c where c.organization_id=p_organization_id and c.partner_id=d.id and c.settlement->>'approvedCents' is null)
 )) from public.motorist_partner_directory d where d.organization_id=p_organization_id and exists(select 1 from public.motorist_partner_case_contexts c where c.organization_id=p_organization_id and c.partner_id=d.id)),'[]');
end $$;
revoke all on function public.motorist_partner_report(uuid,uuid) from public,anon,authenticated;
grant execute on function public.motorist_partner_report(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
commit;
