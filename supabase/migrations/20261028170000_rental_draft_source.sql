begin;
-- Allowlisted source fields for the rental draft preview of one delivery.
-- Operations tables are RPC-only; office operations actors only.
create function public.motorist_rental_draft_source(p_user_id uuid, p_organization_id uuid, p_operation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; op public.motorist_operations; c public.motorist_cases; phone text; branch text;
begin
 actor:=app_private.operations_actor(p_user_id,p_organization_id);
 if not (actor->>'canDispatch')::boolean then raise exception 'Forbidden' using errcode='42501'; end if;
 select * into op from public.motorist_operations where id=p_operation_id and organization_id=p_organization_id;
 if not found or op.kind<>'delivery' then raise exception 'Delivery unavailable' using errcode='P0002'; end if;
 if op.case_id is not null then
  select * into c from public.motorist_cases where id=op.case_id and organization_id=p_organization_id;
  select ct.phone into phone from public.motorist_contacts ct where ct.id=c.contact_id and ct.organization_id=p_organization_id;
 end if;
 select coalesce(b.name,g.name) into branch from public.motorist_work_requests r join public.motorist_work_groups g on g.id=r.group_id
  left join public.motorist_branches b on b.id=g.branch_id where r.operation_id=op.id and r.organization_id=p_organization_id;
 return jsonb_build_object('operationId',op.id,'caseId',op.case_id,'caseNumber',c.case_number,'caseAssistanceReference',c.assistance_reference,
  'customer',case when c.id is null then null else jsonb_build_object('type',c.customer_details->>'type','firstName',c.customer_details->>'firstName','lastName',c.customer_details->>'lastName',
   'companyName',c.customer_details->>'companyName','assistanceServiceName',c.customer_details->>'assistanceServiceName','assistanceReference',c.customer_details->>'assistanceReference',
   'contacts',coalesce((select jsonb_agg(jsonb_build_object('phone',x->>'phone','isPrimary',(x->>'isPrimary')::boolean)) from jsonb_array_elements(case when jsonb_typeof(c.customer_details->'contacts')='array' then c.customer_details->'contacts' else '[]'::jsonb end) x),'[]')) end,
  'contactPhone',phone,'branchName',branch);
end $$;
revoke all on function public.motorist_rental_draft_source(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.motorist_rental_draft_source(uuid,uuid,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
