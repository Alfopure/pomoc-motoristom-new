-- Isolated database only; apply the actual operations and access-link migrations first.
begin;
do $test$
declare org uuid:=gen_random_uuid(); office uuid:=gen_random_uuid(); driver uuid:=gen_random_uuid(); second_driver uuid:=gen_random_uuid(); profile uuid:=gen_random_uuid();
 member uuid:=gen_random_uuid(); member2 uuid:=gen_random_uuid(); asset uuid:=gen_random_uuid(); record_id uuid:=gen_random_uuid(); case_id uuid:=gen_random_uuid();
 op uuid; cycle uuid; collection uuid; legacy_operation uuid; grant_id uuid; legacy_id uuid:=gen_random_uuid(); ctx jsonb; cmd jsonb; issued jsonb; repeated jsonb; result jsonb; accepted jsonb; revoked jsonb;
 session_hash text:=repeat('b',64); token_hash text:=repeat('a',64); rev bigint;
begin
 insert into auth.users(id) values(office),(driver),(second_driver);
 insert into public.motorist_organizations(id) values(org);
 insert into public.motorist_profiles(id,organization_id,user_id,role,display_name) values(profile,org,office,'dispatcher','Office');
 insert into public.motorist_towing_memberships(id,organization_id,auth_user_id,display_name,roles,capabilities,password_set_at)
 values(member,org,driver,'Assigned driver',array['delivery'],array['deliver'],now()),(member2,org,second_driver,'Other driver',array['delivery'],array['deliver'],now());
 insert into public.motorist_cases(id,organization_id,case_number) values(case_id,org,'GRANTS-TEST');
 insert into public.motorist_fleet_assets(id,organization_id,kind,label,status) values(asset,org,'replacement_car','Synthetic car','rented');
 insert into public.motorist_external_vehicle_records(id,organization_id,source_active,latest_payload_snapshot) values(record_id,org,true,jsonb_build_object('occupancy',jsonb_build_object('state','occupied','checkedAt',now())));
 insert into public.motorist_fleet_asset_links(id,organization_id,fleet_asset_id,external_vehicle_record_id,source_provider,link_status) values(gen_random_uuid(),org,asset,record_id,'client_vehicle_db','confirmed');
 result:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'action','create','expectedRevision',0,'payload',jsonb_build_object('kind','delivery','caseId',case_id,'fleetAssetId',asset,'from','Depot','to','Client')));
 op:=(result->'operation'->>'id')::uuid; cycle:=(result->'operation'->>'cycleId')::uuid;
 result:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'action','assign','operationId',op,'expectedRevision',1,'payload',jsonb_build_object('assigneeId',member)));
 ctx:=public.motorist_operation_grant(office,org,op,'context','{}');
 cmd:=jsonb_build_object('commandId',gen_random_uuid(),'expectedRevision',ctx->'operationRevision','previewVersion',ctx->'previewVersion','hours',24,'issuedId',gen_random_uuid(),'tokenHash',token_hash,'tokenEnvelope','{}'::jsonb,'linkOrigin','https://synthetic.invalid');
 issued:=public.motorist_operation_grant(office,org,op,'issue',cmd); grant_id:=(issued->'grant'->>'id')::uuid;
 repeated:=public.motorist_operation_grant(office,org,op,'issue',jsonb_set(jsonb_set(cmd,'{tokenHash}',to_jsonb(repeat('c',64))),'{issuedId}',to_jsonb(gen_random_uuid())));
 if issued<>repeated then raise exception 'Issue retry changed committed receipt'; end if;
 begin perform public.motorist_operation_grant(office,org,op,'issue',jsonb_set(cmd,'{hours}','4')); raise exception 'Changed retry accepted'; exception when sqlstate 'PT409' then null; end;
 begin perform public.motorist_operation_grant(office,org,op,'issue',jsonb_set(cmd,'{commandId}',to_jsonb(gen_random_uuid()))); raise exception 'Duplicate active grant accepted'; exception when sqlstate 'PT409' then null; end;
 begin perform public.motorist_operation_grant(driver,org,op,'context','{}'); raise exception 'Field publication privilege accepted'; exception when insufficient_privilege then null; end;
 begin
  insert into public.motorist_case_handoffs(id,organization_id,case_id,recipient_name,recipient_phone,published,token_hash,expires_at,operation_id)
  values(legacy_id,org,case_id,'Old recipient','+421900000000','{}',repeat('d',64),now()+interval '1 day',op);
  raise exception 'Legacy writer duplicated new operation grant';
 exception when sqlstate 'PT409' then null; end;
 result:=public.motorist_public_operation_grant('session',token_hash,jsonb_build_object('sessionHash',session_hash));
 if result->'publication'->'snapshot'->>'recipientName'<>'Assigned driver' then raise exception 'Wrong recipient snapshot'; end if;
 begin perform public.motorist_public_operation_grant('read',session_hash,jsonb_build_object('grantId',gen_random_uuid())); raise exception 'Session crossed grant'; exception when no_data_found then null; end;
 cmd:=jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'action','accept','expectedRevision',2);
 accepted:=public.motorist_public_operation_grant('command',session_hash,cmd);
 repeated:=public.motorist_public_operation_grant('command',session_hash,cmd);
 if repeated<>accepted then raise exception 'Public retry changed receipt'; end if;
 if (select count(*) from public.motorist_operation_events where actor_grant_id=grant_id)<>1 then raise exception 'Retry duplicated execution event'; end if;
 begin perform public.motorist_public_operation_grant('command',session_hash,jsonb_set(cmd,'{action}','"start"')); raise exception 'Changed public retry accepted'; exception when sqlstate 'PT409' then null; end;
 begin perform public.motorist_public_operation_grant('command',session_hash,jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'action','start','expectedRevision',3)); raise exception 'Occupied delivery started'; exception when sqlstate 'PT409' then null; end;
 update public.motorist_external_vehicle_records set latest_payload_snapshot=jsonb_build_object('occupancy',jsonb_build_object('state','free','checkedAt',now())) where id=record_id;
 result:=public.motorist_public_operation_grant('command',session_hash,jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'action','start','expectedRevision',3));
 result:=public.motorist_public_operation_grant('command',session_hash,jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'action','arrive','expectedRevision',4));
 result:=public.motorist_public_operation_grant('command',session_hash,jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'action','complete','expectedRevision',5));
 if result->'publication'->'snapshot'<>'null'::jsonb then raise exception 'Completed contact not redacted'; end if;
 repeated:=public.motorist_public_operation_grant('command',session_hash,cmd);
 if repeated->'publication'->'snapshot'<>'null'::jsonb or repeated->'publication'->>'status'<>'completed' or repeated->>'committedRevision'<>accepted->>'committedRevision' then raise exception 'Old replay revived contact or lost committed outcome'; end if;
 if exists(select 1 from public.motorist_operation_evidence where operation_id=op) then raise exception 'Completion fabricated evidence'; end if;

 -- Collection has its own publication and collected step while the old delivery
 -- grant remains terminal. Neither the case nor the old grant owns this work.
 result:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'action','return','operationId',op,'expectedRevision',6,'payload',jsonb_build_object('returnMode','collect','nextOwner','Office')));
 select operation_id into collection from public.motorist_logistics_executions where cycle_return_id=cycle and status<>'cancelled';
 result:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'action','assign','operationId',collection,'expectedRevision',1,'payload',jsonb_build_object('assigneeId',member)));
 ctx:=public.motorist_operation_grant(office,org,collection,'context','{}');
 cmd:=jsonb_build_object('commandId',gen_random_uuid(),'expectedRevision',ctx->'operationRevision','previewVersion',ctx->'previewVersion','hours',24,'issuedId',gen_random_uuid(),'tokenHash',repeat('e',64),'tokenEnvelope','{}'::jsonb,'linkOrigin','https://synthetic.invalid');
 result:=public.motorist_operation_grant(office,org,collection,'issue',cmd); grant_id:=(result->'grant'->>'id')::uuid;
 perform public.motorist_public_operation_grant('session',repeat('e',64),jsonb_build_object('sessionHash',repeat('f',64)));
 update public.motorist_towing_memberships set password_set_at=null where id=member;
 begin perform public.motorist_public_operation_grant('read',repeat('f',64),jsonb_build_object('grantId',grant_id)); raise exception 'Password-pending grant remained usable'; exception when no_data_found then null; end;
 update public.motorist_towing_memberships set password_set_at=now() where id=member;
 result:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'action','assign','operationId',collection,'expectedRevision',2,'payload',jsonb_build_object('assigneeId',member2)));
 begin perform public.motorist_public_operation_grant('read',repeat('f',64),jsonb_build_object('grantId',grant_id)); raise exception 'Reassigned grant remained usable'; exception when no_data_found then null; end;
 ctx:=public.motorist_operation_grant(office,org,collection,'context','{}');
 cmd:=jsonb_build_object('commandId',gen_random_uuid(),'expectedRevision',ctx->'operationRevision','previewVersion',ctx->'previewVersion','hours',24,'issuedId',gen_random_uuid(),'tokenHash',repeat('1',64),'tokenEnvelope','{}'::jsonb,'linkOrigin','https://synthetic.invalid');
 result:=public.motorist_operation_grant(office,org,collection,'issue',cmd); grant_id:=(result->'grant'->>'id')::uuid;
 perform public.motorist_public_operation_grant('session',repeat('1',64),jsonb_build_object('sessionHash',repeat('2',64)));
 update public.motorist_towing_memberships set active=false where id=member2;
 begin perform public.motorist_public_operation_grant('read',repeat('2',64),jsonb_build_object('grantId',grant_id)); raise exception 'Disabled member link remained usable'; exception when no_data_found then null; end;
 update public.motorist_towing_memberships set active=true where id=member2;
 update public.motorist_logistics_executions set destination='Changed destination',revision=revision+1 where operation_id=collection;
 begin perform public.motorist_public_operation_grant('read',repeat('2',64),jsonb_build_object('grantId',grant_id)); raise exception 'Stale publication remained usable'; exception when no_data_found then null; end;
 begin perform public.motorist_operation_grant(office,org,collection,'issue',jsonb_set(cmd,'{commandId}',to_jsonb(gen_random_uuid()))); raise exception 'Stale preview issued'; exception when sqlstate 'PT409' then null; end;
 ctx:=public.motorist_operation_grant(office,org,collection,'context','{}');
 cmd:=jsonb_build_object('commandId',gen_random_uuid(),'expectedRevision',ctx->'operationRevision','previewVersion',ctx->'previewVersion','hours',24,'issuedId',gen_random_uuid(),'tokenHash',repeat('3',64),'tokenEnvelope','{}'::jsonb,'linkOrigin','https://synthetic.invalid');
 result:=public.motorist_operation_grant(office,org,collection,'issue',cmd); grant_id:=(result->'grant'->>'id')::uuid;
 perform public.motorist_public_operation_grant('session',repeat('3',64),jsonb_build_object('sessionHash',repeat('4',64)));
 cmd:=jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'reason','Replace link','expectedRevision',ctx->'operationRevision');
 revoked:=public.motorist_operation_grant(office,org,collection,'revoke',cmd);
 if public.motorist_operation_grant(office,org,collection,'revoke',cmd)<>revoked then raise exception 'Revoke retry changed receipt'; end if;
 begin perform public.motorist_public_operation_grant('read',repeat('4',64),jsonb_build_object('grantId',grant_id)); raise exception 'Revoked session remained usable'; exception when no_data_found then null; end;
 if (select status from public.motorist_logistics_executions where operation_id=collection)<>'assigned' or (select status from public.motorist_vehicle_use_cycles where id=cycle)<>'open' then raise exception 'Revoke cancelled durable work/cycle'; end if;
 -- An occupied rental may be collected; the collected step is mandatory.
 update public.motorist_external_vehicle_records set latest_payload_snapshot=jsonb_build_object('occupancy',jsonb_build_object('state','occupied','checkedAt',now())) where id=record_id;
 ctx:=public.motorist_operation_grant(office,org,collection,'context','{}');
 cmd:=jsonb_build_object('commandId',gen_random_uuid(),'expectedRevision',ctx->'operationRevision','previewVersion',ctx->'previewVersion','hours',24,'issuedId',gen_random_uuid(),'tokenHash',repeat('5',64),'tokenEnvelope','{}'::jsonb,'linkOrigin','https://synthetic.invalid');
 result:=public.motorist_operation_grant(office,org,collection,'issue',cmd); grant_id:=(result->'grant'->>'id')::uuid;
 perform public.motorist_public_operation_grant('session',repeat('5',64),jsonb_build_object('sessionHash',repeat('6',64)));
 rev:=(ctx->>'operationRevision')::bigint;
 result:=public.motorist_public_operation_grant('command',repeat('6',64),jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'action','accept','expectedRevision',rev)); rev:=rev+1;
 result:=public.motorist_public_operation_grant('command',repeat('6',64),jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'action','start','expectedRevision',rev)); rev:=rev+1;
 result:=public.motorist_public_operation_grant('command',repeat('6',64),jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'action','arrive','expectedRevision',rev)); rev:=rev+1;
 begin perform public.motorist_public_operation_grant('command',repeat('6',64),jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'action','complete','expectedRevision',rev)); raise exception 'Collection completed before pickup'; exception when sqlstate 'PT409' then null; end;
 result:=public.motorist_public_operation_grant('command',repeat('6',64),jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'action','collect','expectedRevision',rev)); rev:=rev+1;
 result:=public.motorist_public_operation_grant('command',repeat('6',64),jsonb_build_object('commandId',gen_random_uuid(),'grantId',grant_id,'action','complete','expectedRevision',rev));
 if (select status from public.motorist_vehicle_use_cycles where id=cycle)<>'returned' or exists(select 1 from public.motorist_cycle_return_owners where cycle_id=cycle) then raise exception 'Collection did not return its single cycle'; end if;
 -- Conversely, an existing legacy publication occupies the same operation slot.
 result:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'action','create','expectedRevision',0,'payload',jsonb_build_object('kind','delivery','caseId',case_id,'from','Legacy depot','to','Legacy client')));
 legacy_operation:=(result->'operation'->>'id')::uuid;
 perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'action','assign','operationId',legacy_operation,'expectedRevision',1,'payload',jsonb_build_object('assigneeId',member2)));
 insert into public.motorist_case_handoffs(id,organization_id,case_id,recipient_name,recipient_phone,published,token_hash,expires_at,operation_id,recipient_member_id)
 values(legacy_id,org,case_id,'Legacy recipient','+421900000000','{}',repeat('d',64),now()+interval '1 day',legacy_operation,member2);
 ctx:=public.motorist_operation_grant(office,org,legacy_operation,'context','{}');
 cmd:=jsonb_build_object('commandId',gen_random_uuid(),'expectedRevision',ctx->'operationRevision','previewVersion',ctx->'previewVersion','hours',24,'issuedId',gen_random_uuid(),'tokenHash',repeat('7',64),'tokenEnvelope','{}'::jsonb,'linkOrigin','https://synthetic.invalid');
 begin perform public.motorist_operation_grant(office,org,legacy_operation,'issue',cmd); raise exception 'New writer duplicated legacy publication'; exception when sqlstate 'PT409' then null; end;
 update public.motorist_case_handoffs set status='expired' where id=legacy_id;
 if (select status from public.motorist_logistics_executions where operation_id=legacy_operation) in ('cancelled','completed') then raise exception 'Legacy expiry closed work'; end if;
 -- New collection/transfer rows never enter strict mobile lists: separate tables.
 if exists(select 1 from public.motorist_case_handoffs where operation_id=collection) then raise exception 'Collection leaked into legacy handoffs'; end if;
 if has_function_privilege('anon','public.motorist_public_operation_grant(text,text,jsonb)','execute') or has_function_privilege('authenticated','public.motorist_operation_grant(uuid,uuid,uuid,text,jsonb)','execute') or has_table_privilege('service_role','public.motorist_operation_grants','select') then raise exception 'Privileged access leaked'; end if;
 raise notice 'PASS: scoped publication, exact issue/revoke replay, public idempotency, assignment/member/password revocation, stale snapshots, legacy cross-slot, occupied delivery gate, contact redaction and durable work';
end $test$;
rollback;
