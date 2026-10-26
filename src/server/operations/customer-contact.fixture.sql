-- Focused additive-migration check in the isolated operations validation database.
begin;
do $test$
declare org uuid:=gen_random_uuid(); office uuid:=gen_random_uuid(); driver uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();
 member uuid:=gen_random_uuid(); other_member uuid:=gen_random_uuid(); case_id uuid:=gen_random_uuid(); contact_id uuid:=gen_random_uuid();
 operation uuid; receipt jsonb; result jsonb; assign_command jsonb;
begin
 insert into auth.users(id) values(office),(driver),(outsider);
 insert into public.motorist_organizations(id) values(org);
 insert into public.motorist_profiles(id,organization_id,user_id,role,display_name) values(gen_random_uuid(),org,office,'dispatcher','Office');
 insert into public.motorist_towing_memberships(id,organization_id,auth_user_id,display_name,roles,capabilities,password_set_at) values(member,org,driver,'Field',array['delivery'],array['deliver'],now()),(other_member,org,outsider,'Other',array['delivery'],array['deliver'],now());
 insert into public.motorist_contacts(id,organization_id,name,phone) values(contact_id,org,'Explicit customer','+421900123456');
 insert into public.motorist_cases(id,organization_id,case_number,contact_id,status) values(case_id,org,'CONTACT',contact_id,'open');
 receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'action','create','expectedRevision',0,'payload',jsonb_build_object('kind','delivery','caseId',case_id,'from','A','to','B')));
 operation:=(receipt->'operation'->>'id')::uuid;
 if receipt->'operation'?'customer' then raise exception 'Create receipt stores contact'; end if;
 assign_command:=jsonb_build_object('commandId',gen_random_uuid(),'operationId',operation,'action','assign','expectedRevision',1,'payload',jsonb_build_object('assigneeId',member));
 receipt:=public.motorist_operations_command(office,org,assign_command);
 if receipt->'operation'?'customer' then raise exception 'Assignment receipt stores contact'; end if;
 result:=public.motorist_operations_workspace(driver,org,jsonb_build_object('id',operation));
 if result->'operations'->0->'customer'<>jsonb_build_object('name','Explicit customer','phone','+421900123456') then raise exception 'Assigned active field lacks explicit minimal contact'; end if;
 if (result->'operations'->0->'customer')-array['name','phone']<>'{}'::jsonb then raise exception 'Contact projection too broad'; end if;
 result:=public.motorist_operations_workspace(outsider,org,jsonb_build_object('id',operation));
 if jsonb_array_length(result->'operations')<>0 then raise exception 'Other member sees operation/contact'; end if;
 update public.motorist_cases set closed_at=now(),status='completed_assisted' where id=case_id;
 result:=public.motorist_operations_workspace(driver,org,jsonb_build_object('id',operation));
 if result->'operations'->0->'customer'->>'phone'<>'+421900123456' then raise exception 'Case closure removed independent return contact'; end if;
 result:=public.motorist_operations_workspace(office,org,jsonb_build_object('id',operation));
 if result->'operations'->0->'customer'->>'phone'<>'+421900123456' then raise exception 'Office lost return-coordination contact'; end if;
 -- A historical grant is a separate access boundary; expiry/revocation cannot be
 -- turned back into contact access through the new shared workspace.
 insert into public.motorist_case_handoffs(organization_id,case_id,operation_id,recipient_name,recipient_phone,recipient_member_id,published,token_hash,expires_at)
 values(org,case_id,operation,'Field','+421900123456',member,'{}',encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),now()+interval '1 day');
 result:=public.motorist_operations_workspace(driver,org,jsonb_build_object('id',operation));
 if result->'operations'->0->'customer'->>'phone'<>'+421900123456' then raise exception 'Live original grant lost contact'; end if;
 update public.motorist_case_handoffs set expires_at=now()-interval '1 second' where operation_id=operation;
 result:=public.motorist_operations_workspace(driver,org,jsonb_build_object('id',operation));
 if result->'operations'->0?'customer' then raise exception 'Expired legacy contact revived'; end if;
 update public.motorist_case_handoffs set expires_at=now()+interval '1 day',status='cancelled' where operation_id=operation;
 result:=public.motorist_operations_workspace(driver,org,jsonb_build_object('id',operation));
 if result->'operations'->0?'customer' then raise exception 'Revoked legacy contact revived'; end if;
 update public.motorist_cases set closed_at=null,status='open' where id=case_id;
 update public.motorist_logistics_executions set status='completed' where operation_id=operation;
 result:=public.motorist_operations_workspace(driver,org,jsonb_build_object('id',operation));
 if result->'operations'->0?'customer' then raise exception 'Terminal assignment contact leaks to field'; end if;
 result:=public.motorist_operations_command(office,org,assign_command);
 if result<>receipt or result->'operation'?'customer' then raise exception 'Receipt replay restores or changes contact'; end if;
 update public.motorist_towing_memberships set active=false where id=member;
 begin perform public.motorist_operations_workspace(driver,org,'{}'); raise exception 'Revoked member authorized'; exception when insufficient_privilege then null; end;
 raise notice 'PASS: explicit minimal contact, own active assignment, IDOR, independent closed-case return contact, live-only legacy contact, terminal field redaction, contact-free exact receipt replay, revocation';
end $test$;
rollback;
