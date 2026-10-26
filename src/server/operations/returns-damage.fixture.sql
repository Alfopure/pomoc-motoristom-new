-- Isolated local database only; all synthetic data rolls back.
begin;
do $test$
declare org uuid:=gen_random_uuid(); office uuid:=gen_random_uuid(); driver uuid:=gen_random_uuid(); member uuid:=gen_random_uuid();
 case_id uuid:=gen_random_uuid(); asset uuid; asset1 uuid; record_id uuid; op uuid; op1 uuid; cycle uuid; cycle1 uuid; collection uuid; damage uuid;
 receipt jsonb; replay jsonb; command jsonb; page1 jsonb; page2 jsonb; rev bigint; i integer; original jsonb;
begin
 insert into auth.users(id) values(office),(driver);
 insert into public.motorist_organizations(id) values(org);
 insert into public.motorist_profiles(id,organization_id,user_id,role,display_name) values(gen_random_uuid(),org,office,'dispatcher','Office');
 insert into public.motorist_towing_memberships(id,organization_id,auth_user_id,display_name,roles,capabilities,password_set_at) values(member,org,driver,'Field',array['delivery'],array['deliver'],now());
 insert into public.motorist_cases(id,organization_id,case_number) values(case_id,org,'TEST-P5');
 for i in 1..3 loop
  asset:=gen_random_uuid(); record_id:=gen_random_uuid();
  insert into public.motorist_fleet_assets(id,organization_id,kind,label,status) values(asset,org,'replacement_car','P5 asset '||i,'available');
  insert into public.motorist_external_vehicle_records(id,organization_id,source_active,latest_payload_snapshot) values(record_id,org,true,jsonb_build_object('occupancy',jsonb_build_object('state','free','checkedAt',now())));
  insert into public.motorist_fleet_asset_links(id,organization_id,fleet_asset_id,external_vehicle_record_id,source_provider,link_status) values(gen_random_uuid(),org,asset,record_id,'client_vehicle_db','confirmed');
  receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'action','create','expectedRevision',0,'payload',jsonb_build_object('kind','delivery','caseId',case_id,'fleetAssetId',asset,'from','Depot','to','Client')));
  op:=(receipt->'operation'->>'id')::uuid; cycle:=(receipt->'operation'->>'cycleId')::uuid;
  -- Model a completed physical handover, including a legacy client with no new evidence.
  update public.motorist_logistics_executions set status='completed',finished_at=now(),assignee_id=member where operation_id=op;
  if i=1 then op1:=op; cycle1:=cycle; asset1:=asset;
  elsif i=2 then
   receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op,'action','return','expectedRevision',1,'payload',jsonb_build_object('returnMode','collect','returnAt',now()+interval '2 days','nextOwner','Office')));
   collection:=(receipt->'operation'->'cycle'->>'returnOperationId')::uuid;
  end if;
 end loop;
 -- Unrelated recent completed work must not consume a returns page.
 for i in 1..3 loop
  receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'action','create','expectedRevision',0,'payload',jsonb_build_object('kind','transfer','from','A','to','B')));
  update public.motorist_logistics_executions set status='completed' where operation_id=(receipt->'operation'->>'id')::uuid;
 end loop;
 page1:=public.motorist_operations_workspace(office,org,'{"view":"returns","limit":1,"offset":0}');
 page2:=public.motorist_operations_workspace(office,org,'{"view":"returns","limit":1,"offset":1}');
 if (page1->>'totalCount')::integer<>3 or (page2->>'totalCount')::integer<>3 or jsonb_array_length(page1->'operations')<>1 or page1->'operations'->0->>'cycleId'=page2->'operations'->0->>'cycleId' then raise exception 'Returns pagination lost or duplicated a cycle'; end if;
 receipt:=public.motorist_operations_workspace(office,org,jsonb_build_object('view','returns','fleetAssetId',asset1));
 if receipt->>'totalCount'<>'1' or receipt->'operations'->0->>'id'<>op1::text or receipt->'operations'->0->>'status'<>'completed' then raise exception 'Completed delivery with unresolved return disappeared'; end if;
 if not exists(select 1 from jsonb_array_elements(public.motorist_operations_workspace(office,org,'{"view":"returns"}')->'operations') item where item->>'id'=collection::text) then raise exception 'Active return owner was not selected'; end if;
 receipt:=public.motorist_operations_workspace(driver,org,'{"view":"returns"}');
 if exists(select 1 from jsonb_array_elements(receipt->'operations') item where item->>'assigneeId'<>member::text) then raise exception 'Returns view leaked another assignment'; end if;

 receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','return','expectedRevision',1,'payload',jsonb_build_object('returnMode','customer_returns','returned',true,'nextOwner','Office')));
 if exists(select 1 from public.motorist_operations where cycle_id=cycle1 and kind='collection') then raise exception 'Customer return fabricated a drive'; end if;
 receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','evidence','expectedRevision',2,'payload',jsonb_build_object('stage','inspection','source','exception','observedAt',now(),'note','Checked at depot','missingReason','Legacy photo and measurements unavailable')));
 begin
  perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','inspect','expectedRevision',3,'payload',jsonb_build_object('note','Checked')));
  raise exception 'Inspection bypassed missing handover evidence';
 exception when sqlstate 'PT409' then null; end;
 perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','evidence','expectedRevision',3,'payload',jsonb_build_object('stage','handover','source','exception','observedAt',now(),'person','Client','missingReason','Legacy client did not capture photos or measurements')));
 receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','inspect','expectedRevision',4,'payload',jsonb_build_object('note','Inspected with documented exception')));
 if receipt->'operation'->'cycle'->>'readiness'<>'ready' then raise exception 'Valid documented evidence could not satisfy inspection'; end if;

 begin
  perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','evidence','expectedRevision',5,'payload',jsonb_build_object('stage','damage','source','exception','observedAt',now(),'note','Scratch','missingReason','Camera unavailable')));
  raise exception 'Damage accepted without a resolver';
 exception when invalid_parameter_value then null; end;
 receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','evidence','expectedRevision',5,'payload',jsonb_build_object('stage','damage','source','exception','observedAt',now(),'note','Original scratch report','missingReason','Camera unavailable at reporting','damageResolver','Fleet office')));
 select id,jsonb_build_object('note',note,'author',author_user_id,'observedAt',observed_at,'missingReason',missing_reason) into damage,original from public.motorist_operation_evidence where operation_id=op1 and stage='damage';
 if receipt->'operation'->'cycle'->>'status'<>'returned' or receipt->'operation'->'cycle'->>'readiness'='ready' or app_private.operations_asset_free(org,asset1) then raise exception 'Open damage failed to invalidate readiness/new use'; end if;
 receipt:=public.motorist_operations_workspace(office,org,jsonb_build_object('view','damage','fleetAssetId',asset1));
 if receipt->>'totalCount'<>'1' then raise exception 'Damage report missing from vehicle-filtered overview'; end if;
 begin
  perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','inspect','expectedRevision',6,'payload',jsonb_build_object('note','Still damaged')));
  raise exception 'Open damage inspection accepted';
 exception when sqlstate 'PT409' then null; end;
 begin
  perform public.motorist_operations_command(driver,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','damage_update','expectedRevision',6,'payload',jsonb_build_object('evidenceId',damage,'damageStatus','resolved','damageResolver','Field')));
  raise exception 'Field user resolved damage';
 exception when insufficient_privilege then null; end;
 command:=jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','damage_update','expectedRevision',6,'payload',jsonb_build_object('evidenceId',damage,'damageStatus','resolved','damageResolver','Fleet manager'));
 receipt:=public.motorist_operations_command(office,org,command); replay:=public.motorist_operations_command(office,org,command);
 if receipt<>replay or receipt->'operation'->'cycle'->>'status'<>'returned' or receipt->'operation'->'cycle'->>'readiness'='ready' then raise exception 'Damage resolution fabricated inspection or lost replay'; end if;
 if original<>(select jsonb_build_object('note',note,'author',author_user_id,'observedAt',observed_at,'missingReason',missing_reason) from public.motorist_operation_evidence where id=damage) then raise exception 'Resolution overwrote original damage report'; end if;
 begin
  perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','inspect','expectedRevision',7,'payload',jsonb_build_object('note','Old inspection photo')));
  raise exception 'Old evidence was reused after a new damage report';
 exception when sqlstate 'PT409' then null; end;
 perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','evidence','expectedRevision',7,'payload',jsonb_build_object('stage','inspection','source','exception','observedAt',now(),'note','New inspection after damage resolution','missingReason','Camera unavailable, inspection recorded by office')));
 receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op1,'action','inspect','expectedRevision',8,'payload',jsonb_build_object('note','Rechecked after repair')));
 if receipt->'operation'->'cycle'->>'readiness'<>'ready' then raise exception 'Resolved and re-inspected asset remained blocked'; end if;
 -- Damage reported on a later standalone transfer still belongs to the same car
 -- and must leave a visible path to repeat its most recent inspection.
 receipt:=public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'action','create','expectedRevision',0,'payload',jsonb_build_object('kind','transfer','fleetAssetId',asset1,'from','Depot','to','Service')));
 op:=(receipt->'operation'->>'id')::uuid;
 perform public.motorist_operations_command(office,org,jsonb_build_object('commandId',gen_random_uuid(),'operationId',op,'action','evidence','expectedRevision',1,'payload',jsonb_build_object('stage','damage','source','exception','observedAt',now(),'note','Damage during later transfer','missingReason','Photo unavailable','damageResolver','Fleet office')));
 if (select status from public.motorist_vehicle_use_cycles where id=cycle1)<>'returned' or app_private.operations_asset_free(org,asset1) then raise exception 'Transfer damage bypassed asset block or left no reinspection step'; end if;
 delete from public.motorist_cases where id=case_id;
 receipt:=public.motorist_operations_workspace(office,org,'{"view":"returns"}');
 if receipt->>'totalCount'<>'3' then raise exception 'Case deletion lost pending returns or a required reinspection'; end if;
 if has_function_privilege('anon','app_private.operation_evidence_complete(uuid)','execute') or has_function_privilege('authenticated','public.motorist_operations_command(uuid,uuid,jsonb)','execute') then raise exception 'P5 privileged SQL exposed'; end if;
 raise notice 'PASS: paginated cycle returns, completed deliveries, owner dedupe, assignment scope, customer return without drive, evidence/readiness gates, damage resolver/status/audit/replay, reinspection, case survival and grants';
end $test$;
rollback;
