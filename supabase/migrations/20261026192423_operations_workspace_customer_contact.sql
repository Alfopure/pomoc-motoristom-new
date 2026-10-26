-- Add a current, minimal contact only to authorized workspace GETs. Stored command
-- receipts and legacy/mobile DTOs remain unchanged and contact-free.
begin;
do $patch$
declare definition text; anchor text:='app_private.operation_json(f.o) dto'; projection text;
begin
 definition:=pg_get_functiondef('public.motorist_operations_workspace(uuid,uuid,jsonb)'::regprocedure);
 if position(anchor in definition)=0 then raise exception 'Unexpected operations workspace definition' using errcode='55000'; end if;
 projection:=$projection$app_private.operation_json(f.o) || coalesce((
  select jsonb_build_object('customer',jsonb_build_object('name',coalesce(contact.name,''),'phone',coalesce(contact.phone,'')))
  from public.motorist_cases customer_case
  join public.motorist_contacts contact on contact.id=customer_case.contact_id and contact.organization_id=customer_case.organization_id
  where customer_case.id=(f.o).case_id and customer_case.organization_id=p_organization_id
   and ((actor->>'canDispatch')::boolean or (
    exists(select 1 from public.motorist_logistics_executions assignment where assignment.operation_id=(f.o).id
     and assignment.organization_id=p_organization_id and assignment.assignee_id=(actor->>'memberId')::uuid
     and assignment.status not in ('completed','cancelled'))
    and (not exists(select 1 from public.motorist_case_handoffs legacy where legacy.operation_id=(f.o).id)
      or exists(select 1 from public.motorist_case_handoffs live_grant where live_grant.operation_id=(f.o).id
       and live_grant.organization_id=p_organization_id and live_grant.recipient_member_id=(actor->>'memberId')::uuid
       and live_grant.published is not null and live_grant.expires_at>clock_timestamp()
       and live_grant.status in ('offered','accepted','en_route','arrived')))))
 ),'{}'::jsonb) dto$projection$;
 execute replace(definition,anchor,projection);
end $patch$;
commit;
