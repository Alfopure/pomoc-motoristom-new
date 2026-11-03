-- Isolated database only. Run after actual towing/handoff and operations migrations.
begin;
do $test$
declare org uuid:=gen_random_uuid(); office uuid:=gen_random_uuid(); driver uuid:=gen_random_uuid(); other_driver uuid:=gen_random_uuid();
 profile uuid:=gen_random_uuid(); member uuid:=gen_random_uuid(); member2 uuid:=gen_random_uuid(); asset uuid:=gen_random_uuid(); record_id uuid:=gen_random_uuid(); case_id uuid:=gen_random_uuid();
 cmd jsonb; receipt jsonb; replay jsonb; operation uuid; collection uuid; cycle uuid; rev bigint; output jsonb; tow uuid:=gen_random_uuid(); handoff uuid:=gen_random_uuid(); legacy_operation uuid;
begin
 insert into auth.users(id) values(office),(driver),(other_driver);
 insert into public.motorist_organizations(id) values(org);
 insert into public.motorist_profiles(id,organization_id,user_id,role,display_name) values(profile,org,office,'dispatcher','Office');
 insert into public.motorist_towing_memberships(id,organization_id,auth_user_id,display_name,roles,capabilities,password_set_at) values(member,org,driver,'Field',array['delivery'],array['deliver'],now()),(member2,org,other_driver,'Other',array['delivery'],array['deliver'],now());
 insert into public.motorist_cases(id,organization_id,case_number) values(case_id,org,'TEST');
 insert into public.motorist_fleet_assets(id,organization_id,kind,label,status) values(asset,org,'replacement_car','Confirmed asset','rented');
 insert into public.motorist_external_vehicle_records(id,organization_id,source_active,latest_payload_snapshot) values(record_id,org,true,jsonb_build_object('occupancy',jsonb_build_object('state','occupied','checkedAt',now())));
 insert into public.motorist_fleet_asset_links(id,organization_id,fleet_asset_id,external_vehicle_record_id,source_provider,link_status) values(gen_random_uuid(),org,asset,record_id,'client_vehicle_db','confirmed');
 cmd:=jsonb_build_object('commandId',gen_random_uuid(),'action','create','expectedRevision',0,'payload',jsonb_build_object('kind','delivery','caseId',case_id,'fleetAssetId',asset,'from','A','to','B'));
 receipt:=public.motorist_operations_command(office,org,cmd); operation:=(receipt->'operation'->>'id')::uuid; cycle:=(receipt->'operation'->>'cycleId')::uuid;
 replay:=public.motorist_operations_command(office,org,cmd);
 if replay<>receipt then raise exception 'Replay changed receipt'; end if;
 begin perform public.motorist_operations_command(office,org,jsonb_set(cmd,'{payload,to}','"different"')); raise exception 'Mismatched replay accepted'; exception when sqlstate 'PT409' then null; end;
 perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',operation,'action','assign','expectedRevision',1,'payload',jsonb_build_object('assigneeId',member)));
 -- Queued responsibility does not manufacture a physical interval.
 if exists(select 1 from public.motorist_logistics_executions where operation_id=operation and (started_at is not null or confirmed_at is not null)) then raise exception 'Assignment fabricated start'; end if;
 begin perform public.motorist_operations_command(driver,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',operation,'action','start','expectedRevision',2,'payload','{}'::jsonb)); raise exception 'Occupied delivery started'; exception when sqlstate 'PT409' then null; end;
 receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',operation,'action','return','expectedRevision',2,'payload',jsonb_build_object('returnMode','collect','returnAt',now()+interval '2 days','nextOwner','Office')));
 collection:=(receipt->'operation'->'cycle'->>'returnOperationId')::uuid;
 if collection is null then raise exception 'Return missing'; end if;
 receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',operation,'action','return','expectedRevision',3,'payload',jsonb_build_object('returnMode','collect','returnAt',now()+interval '3 days','nextOwner','Office')));
 if collection<>(receipt->'operation'->'cycle'->>'returnOperationId')::uuid then raise exception 'Reschedule duplicated return'; end if;
 perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',collection,'action','assign','expectedRevision',2,'payload',jsonb_build_object('assigneeId',member)));
 receipt:=public.motorist_operations_command(driver,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',collection,'action','start','expectedRevision',3,'payload','{}'::jsonb));
 if receipt->'operation'->>'status'<>'en_route' then raise exception 'Occupied collection rejected'; end if;
 begin perform public.motorist_operations_command(other_driver,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',collection,'action','arrive','expectedRevision',4,'payload','{}'::jsonb)); raise exception 'Unassigned field IDOR'; exception when insufficient_privilege then null; end;
 perform public.motorist_operations_command(driver,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',collection,'action','arrive','expectedRevision',4,'payload','{}'::jsonb));
 perform public.motorist_operations_command(driver,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',collection,'action','collect','expectedRevision',5,'payload','{}'::jsonb));
 receipt:=public.motorist_operations_command(driver,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',collection,'action','complete','expectedRevision',6,'payload','{}'::jsonb));
 if receipt->'operation'->>'evidenceState'<>'pending' or receipt->'operation'->'cycle'->>'status'<>'returned' then raise exception 'Physical complete invented evidence/readiness'; end if;
 -- Post-completion office evidence is separate and records an explicit exception,
 -- never a forged field observation or fabricated measurement.
 begin perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',collection,'action','evidence','expectedRevision',7,'payload',jsonb_build_object('stage','handover','source','observed','observedAt',now(),'person','Client','missingReason','No photo'))); raise exception 'Office impersonated driver'; exception when insufficient_privilege then null; end;
 perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',collection,'action','evidence','expectedRevision',7,'payload',jsonb_build_object('stage','pickup','source','exception','observedAt',now(),'person','Client','missingReason','Legacy client supplied no photo or measurements')));
 receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',collection,'action','evidence','expectedRevision',8,'payload',jsonb_build_object('stage','handover','source','exception','observedAt',now(),'person','Depot','missingReason','Legacy client supplied no photo or measurements')));
 if receipt->'operation'->>'evidenceState'<>'complete' then raise exception 'Documented exception not retained'; end if;
 -- Legacy grant lifecycle is an adapter on the same owner, with no evidence invention.
 insert into public.motorist_case_handoffs(id,organization_id,case_id,recipient_name,recipient_phone,recipient_member_id,published,token_hash,expires_at) values(handoff,org,case_id,'Field','+421900000000',member,'{}',repeat('a',64),now()+interval '1 day');
 select operation_id into legacy_operation from public.motorist_case_handoffs where id=handoff;
 update public.motorist_case_handoffs set status='accepted' where id=handoff;
 update public.motorist_case_handoffs set status='expired' where id=handoff;
 if (select status from public.motorist_logistics_executions where operation_id=legacy_operation)<>'accepted' then raise exception 'Grant expiration cancelled work'; end if;
 -- The existing mobile command and exact committed receipt remain replayable.
 insert into public.motorist_case_handoffs(id,organization_id,case_id,recipient_name,recipient_phone,recipient_member_id,published,token_hash,expires_at,status) values(gen_random_uuid(),org,case_id,'Field','+421900000001',member,app_private.motorist_handoff_case(org,case_id),repeat('b',64),now()+interval '1 day','arrived') returning id into handoff;
 cmd:=jsonb_build_object('handoffId',handoff,'commandId',gen_random_uuid(),'action','complete','expectedRevision',1,'publishedVersion',1);
 receipt:=public.motorist_member_handoff(driver,org,1,'command',cmd);
 replay:=public.motorist_member_handoff(driver,org,1,'command',cmd);
 if receipt<>replay or (receipt-array['handoff','commandId','committedRevision'])<>'{}'::jsonb or (receipt->'handoff')?'operationId' then raise exception 'Legacy receipt/wire changed'; end if;
 select operation_id into legacy_operation from public.motorist_case_handoffs where id=handoff;
 if (select status from public.motorist_logistics_executions where operation_id=legacy_operation)<>'completed' or exists(select 1 from public.motorist_operation_evidence where operation_id=legacy_operation) then raise exception 'Legacy physical complete diverged'; end if;
 -- Record-only towing owns the work exactly once and cannot be dispatched.
 update public.motorist_towing_memberships set roles=array['manager'],capabilities=app_private.towing_capabilities(array['manager']) where id=member2;
 receipt:=public.motorist_towing_command(other_driver,org,1,jsonb_build_object('commandId',gen_random_uuid(),'type','create_order','targetId',tow,'payload',jsonb_build_object('fields',jsonb_build_object('executionOrigin','awp_record_only','externalReference','AWP-TEST'))));
 if not exists(select 1 from public.motorist_operations where towing_order_id=tow) then raise exception 'Towing identity absent'; end if;
 begin perform public.motorist_towing_command(other_driver,org,1,jsonb_build_object('commandId',gen_random_uuid(),'type','assign','targetId',tow,'expectedRevision',1,'payload',jsonb_build_object('driverId',member))); raise exception 'Record-only dispatched'; exception when invalid_parameter_value then null; end;
 perform public.motorist_towing_command(other_driver,org,1,jsonb_build_object('commandId',gen_random_uuid(),'type','convert_record_only','targetId',tow,'expectedRevision',1,'payload',jsonb_build_object('reason','Office explicitly takes work')));
 if (select fields->>'executionOrigin' from public.motorist_towing_orders where id=tow)<>'local' then raise exception 'Conversion changed wrong identity'; end if;
 delete from public.motorist_cases where id=case_id;
 if not exists(select 1 from public.motorist_operations saved where saved.id=collection and saved.case_id is null) or not exists(select 1 from public.motorist_vehicle_use_cycles where id=cycle) then raise exception 'Case deletion removed work'; end if;
 update public.motorist_towing_memberships set active=false where id=member;
 begin perform public.motorist_operations_workspace(driver,org,'{}'); raise exception 'Revoked member authorized'; exception when insufficient_privilege then null; end;
 if has_function_privilege('anon','public.motorist_operations_command(uuid,uuid,jsonb)','execute') or has_function_privilege('authenticated','public.motorist_operations_workspace(uuid,uuid,jsonb)','execute') or has_table_privilege('authenticated','public.motorist_operations','select') then raise exception 'Public grant leaked'; end if;
 raise notice 'PASS: replay, conflict, queue, occupied collection, return reschedule, IDOR, physical/evidence separation, survival, grants, legacy expiry, exact mobile receipt replay and AWP conversion';
end $test$;
rollback;
