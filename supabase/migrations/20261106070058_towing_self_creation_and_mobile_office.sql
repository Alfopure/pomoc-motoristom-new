begin;

-- Provenance belongs to the existing order; it never changes the actor's role.
alter table public.motorist_towing_orders
 add column created_by_member_id uuid,
 add column creation_origin text check (creation_origin in ('self','office','office_history')),
 add constraint motorist_towing_order_creator_fk foreign key(organization_id,created_by_member_id)
  references public.motorist_towing_memberships(organization_id,id);
create index motorist_towing_order_creator on public.motorist_towing_orders(organization_id,created_by_member_id);

-- Operational creation is intentionally narrower than the office command envelope.
create function app_private.towing_creation_fields(org uuid,raw jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare f jsonb; party_value jsonb; k text; lines jsonb;
begin
 if jsonb_typeof(raw) is distinct from 'object' or
 (raw-array['serviceType','subjectType','subjectDescription','plate','vin','pickup','destination','contact','noContactReason','branchId','fleetAssetId','plannedAt','startedAt','finishedAt','driverNotes','performedQuantity','photoException','handoverRecipientName','handedOverAt','handoverException','odometer','paymentIntent','realizedItems','requesterType','requesterId','requester','owner','customer','recipient','assistanceReference','assistancePartnerId','parkingId','dispatchInstructions'])<>'{}'::jsonb
 then raise exception 'Unknown creation fields' using errcode='22023'; end if;
 if exists(select 1 from jsonb_each(raw) x where x.key not in ('realizedItems','requester','owner','customer','recipient')
  and (jsonb_typeof(x.value) not in ('string','null') or length(x.value#>>'{}')>4000))
 then raise exception 'Invalid creation field value' using errcode='22023'; end if;
 foreach k in array array['requester','owner','customer','recipient'] loop
  party_value:=raw->k;
  if party_value is not null and party_value<>'null'::jsonb and (jsonb_typeof(party_value)<>'object'
   or (party_value-array['name','phone','email','address','companyId','taxId'])<>'{}'::jsonb
   or jsonb_typeof(party_value->'name') is distinct from 'string'
   or exists(select 1 from jsonb_each(party_value) x where jsonb_typeof(x.value) not in ('string','null') or length(x.value#>>'{}')>2000))
  then raise exception 'Invalid party fields' using errcode='22023'; end if;
 end loop;
 f:=jsonb_strip_nulls(jsonb_build_object('serviceType','tow','subjectType','vehicle','subjectDescription','','pickup','')||raw)||jsonb_build_object('executionOrigin','local');
 if jsonb_typeof(f->'subjectDescription') is distinct from 'string' or jsonb_typeof(f->'pickup') is distinct from 'string'
  or coalesce(f->>'serviceType','') not in ('tow','repair','transport','storage','relocation')
  or coalesce(f->>'subjectType','') not in ('vehicle','machine','material')
  or (f->>'requesterType' is not null and f->>'requesterType' not in ('assistance','selfpayer'))
  or (f->>'paymentIntent' is not null and f->>'paymentIntent' not in ('partner_invoice','deferred_invoice','card_terminal','cash_terminal','cash_other'))
  or (nullif(f->>'odometer','') is not null and f->>'odometer' !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$')
  or length(coalesce(f->>'handoverRecipientName',''))>300 or length(coalesce(f->>'handoverException',''))>2000
 then raise exception 'Invalid creation fields' using errcode='22023'; end if;
 foreach k in array array['plannedAt','startedAt','finishedAt','handedOverAt'] loop
  if nullif(f->>k,'') is not null then
   if f->>k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    or not isfinite((f->>k)::timestamptz)
    or (k<>'plannedAt' and (f->>k)::timestamptz>now()+interval '5 minutes')
   then raise exception 'Invalid actual work time' using errcode='22023'; end if;
  end if;
 end loop;
 if nullif(f->>'startedAt','') is not null then f:=f||jsonb_build_object('startSource','manual'); end if;
 if nullif(f->>'startedAt','') is not null and nullif(f->>'finishedAt','') is not null and (f->>'finishedAt')::timestamptz<(f->>'startedAt')::timestamptz
 then raise exception 'End precedes start' using errcode='22023'; end if;
 if nullif(f->>'branchId','') is not null and not exists(select 1 from public.motorist_branches where id=(f->>'branchId')::uuid and organization_id=org and active)
 then raise exception 'Invalid branch' using errcode='22023'; end if;
 if nullif(f->>'fleetAssetId','') is not null and not exists(select 1 from public.motorist_fleet_assets where id=(f->>'fleetAssetId')::uuid and organization_id=org and kind='tow_truck')
 then raise exception 'Invalid towing fleet' using errcode='22023'; end if;
 foreach k in array array['requesterId','assistancePartnerId'] loop
  if nullif(f->>k,'') is not null and not exists(select 1 from public.motorist_contacts where id=(f->>k)::uuid and organization_id=org and role in ('assistance','partner'))
  then raise exception 'Invalid requester contact' using errcode='22023'; end if;
 end loop;
 if nullif(f->>'assistancePartnerId','') is not null then
  select f||jsonb_build_object('assistancePartnerName',name) into f from public.motorist_contacts where id=(f->>'assistancePartnerId')::uuid and organization_id=org;
 end if;
 if nullif(f->>'parkingId','') is not null then
  select f||jsonb_build_object('parkingName',name,'parkingAddress',address) into f from public.motorist_towing_parking_sites
   where id=(f->>'parkingId')::uuid and organization_id=org and active;
  if f is null then raise exception 'Invalid parking site' using errcode='22023'; end if;
 end if;
 perform app_private.towing_validate_realized_items(f->'realizedItems',org,false,false);
 if f?'realizedItems' then
  if exists(select 1 from jsonb_array_elements(f->'realizedItems') item
   join public.motorist_towing_parking_sites site on site.id=nullif(item->>'parkingId','')::uuid and site.organization_id=org where not site.active)
  then raise exception 'Inactive realized item parking cannot be newly selected' using errcode='22023'; end if;
  select coalesce(jsonb_agg((item.value-array['parkingName','parkingAddress'])||case when site.id is null then '{}'::jsonb
   else jsonb_build_object('parkingName',site.name,'parkingAddress',site.address) end order by item.ordinal),'[]'::jsonb) into lines
  from jsonb_array_elements(f->'realizedItems') with ordinality item(value,ordinal)
  left join public.motorist_towing_parking_sites site on site.id=nullif(item.value->>'parkingId','')::uuid and site.organization_id=org;
  f:=jsonb_set(f,'{realizedItems}',lines);
 end if;
 return f;
end $$;
revoke all on function app_private.towing_creation_fields(uuid,jsonb) from public,anon,authenticated;

create function public.motorist_towing_create(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.motorist_towing_memberships; member public.motorist_towing_memberships; o public.motorist_towing_orders;
 old public.motorist_towing_commands; cid uuid; target uuid; mode text; cap text; driver uuid; done boolean;
 f jsonb; fp text; result jsonb; step jsonb; n bigint; action text;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));
 m:=app_private.towing_authorize(p_user_id,p_organization_id,p_membership_version);
 if jsonb_typeof(p_input) is distinct from 'object'
  or (p_input-array['commandId','targetId','mode','fields','driverId','completed','officeNotes'])<>'{}'::jsonb
  or jsonb_typeof(p_input->'mode') is distinct from 'string'
 then raise exception 'Invalid creation input' using errcode='22023'; end if;
 cid:=(p_input->>'commandId')::uuid; target:=(p_input->>'targetId')::uuid; mode:=p_input->>'mode';
 if cid is null or target is null or mode not in ('self','office') then raise exception 'Invalid creation identity' using errcode='22023'; end if;
 cap:=case mode when 'self' then 'drive' else 'operate' end;
 if not cap=any(m.capabilities) then raise exception 'Towing access denied' using errcode='42501'; end if;
 if mode='self' and (p_input ?| array['driverId','completed','officeNotes']) then raise exception 'Own creation only' using errcode='42501'; end if;
 if p_input?'completed' and jsonb_typeof(p_input->'completed') is distinct from 'boolean' then raise exception 'Invalid completed flag' using errcode='22023'; end if;
 if p_input?'officeNotes' and (jsonb_typeof(p_input->'officeNotes') is distinct from 'string' or length(p_input->>'officeNotes')>10000)
 then raise exception 'Invalid office notes' using errcode='22023'; end if;
 fp:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
 action:=case mode when 'self' then 'create_self' else 'create_office' end;
 -- Authorization and current assignment precede replay. Nothing is inserted twice.
 select * into old from public.motorist_towing_commands where organization_id=p_organization_id and command_id=cid;
 if found then
  if old.actor_id<>m.id or old.action<>action or old.target_id<>target or old.fingerprint<>fp or old.required_capability<>cap
   then raise exception 'Command identity conflict' using errcode='PT409'; end if;
  if mode='self' and not exists(select 1 from public.motorist_towing_orders x where x.id=target and x.organization_id=p_organization_id
    and x.driver_id=m.id and x.assignment_generation=old.assignment_generation)
   then raise exception 'Towing access denied' using errcode='42501'; end if;
  return old.result;
 end if;
 f:=app_private.towing_creation_fields(p_organization_id,p_input->'fields');
 done:=coalesce((p_input->>'completed')::boolean,false);
 driver:=case mode when 'self' then m.id else nullif(p_input->>'driverId','')::uuid end;
 if done and driver is null then raise exception 'Historical order requires driver' using errcode='22023'; end if;
 if driver is not null then
  select * into member from public.motorist_towing_memberships where id=driver and organization_id=p_organization_id for share;
  if not found or not member.active or not 'drive'=any(member.capabilities) then raise exception 'Invalid driver' using errcode='22023'; end if;
  perform app_private.towing_authorize(member.auth_user_id,p_organization_id,member.membership_version);
  if nullif(btrim(f->>'pickup'),'') is null or nullif(f->>'branchId','') is null
   or (nullif(btrim(f->>'contact'),'') is null and nullif(btrim(f->>'noContactReason'),'') is null)
   or (f->>'serviceType'='storage' and nullif(f->>'parkingId','') is null)
  then raise exception 'Assignment incomplete' using errcode='22023'; end if;
  perform app_private.towing_validate_realized_items(f->'realizedItems',p_organization_id,true,false);
 end if;
 if mode='self' or done then
  -- Historical work is evidence, never a newly ringing/live assignment.
  insert into public.motorist_towing_orders(id,organization_id,fields,driver_id,assignment_generation,work_status,office_notes,created_by_member_id,creation_origin)
   values(target,p_organization_id,f,driver,1,case when done then 'submitted' else 'assigned' end,coalesce(p_input->>'officeNotes',''),m.id,
    case when done then 'office_history' else 'self' end) returning * into o;
  if done then perform app_private.towing_assert_complete(o); end if;
  insert into public.motorist_towing_assignments(organization_id,order_id,driver_id,generation,ended_at)
   values(p_organization_id,target,driver,1,case when done then now() else null end);
  n:=o.revision;
 else
  -- The ordinary office path keeps the existing command validation and events.
  step:=public.motorist_towing_command(p_user_id,p_organization_id,p_membership_version,jsonb_build_object(
   'commandId',md5('towing-create:'||cid::text)::uuid,'targetId',target,'type','create_order',
   'payload',jsonb_build_object('fields',f-array['startSource','executionOrigin','assistancePartnerName','parkingName','parkingAddress'],
    'officeNotes',coalesce(p_input->>'officeNotes',''))));
  n:=(step->>'revision')::bigint;
  if driver is not null then
   step:=public.motorist_towing_command(p_user_id,p_organization_id,p_membership_version,jsonb_build_object(
    'commandId',md5('towing-create-assign:'||cid::text)::uuid,'targetId',target,'type','assign','expectedRevision',n,
    'payload',jsonb_build_object('driverId',driver)));
   n:=(step->>'revision')::bigint;
  end if;
  update public.motorist_towing_orders set created_by_member_id=m.id,creation_origin='office' where id=target and organization_id=p_organization_id;
 end if;
 result:=jsonb_build_object('commandId',cid,'targetId',target,'revision',n,'result',jsonb_build_object('mode',mode,'completed',done));
 insert into public.motorist_towing_events(organization_id,target_id,actor_id,action,command_id,payload)
  values(p_organization_id,target,m.id,case when done then 'create_history' else action end,cid,p_input);
 insert into public.motorist_towing_commands(organization_id,command_id,actor_id,action,target_id,fingerprint,required_capability,result,assignment_generation)
  values(p_organization_id,cid,m.id,action,target,fp,cap,result,case when mode='self' then 1 else null end);
 return result;
end $$;
revoke all on function public.motorist_towing_create(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_towing_create(uuid,uuid,bigint,jsonb) to service_role;

-- Active own assignments can be completed operationally, not repriced or reassigned.
do $patch$
declare definition text; anchor text; replacement text;
begin
 definition:=pg_get_functiondef('public.motorist_towing_command(uuid,uuid,bigint,jsonb)'::regprocedure);
 anchor:=$a$if driver_op and (f-array['startedAt','finishedAt','driverNotes','performedQuantity','photoException','destination','subjectDescription','plate','vin','odometer','realizedItems','paymentIntent','handoverRecipientName','handedOverAt','handoverException','owner'])<>'{}'::jsonb then raise exception 'Driver fields denied' using errcode='42501';end if;$a$;
 replacement:=$r$if driver_op and (f-array['startedAt','finishedAt','driverNotes','performedQuantity','photoException','destination','subjectDescription','plate','vin','odometer','realizedItems','paymentIntent','handoverRecipientName','handedOverAt','handoverException','owner','pickup','contact','noContactReason','branchId','fleetAssetId','plannedAt','assistanceReference','assistancePartnerId','requesterType','requesterId','requester','recipient','serviceType','subjectType','parkingId'])<>'{}'::jsonb then raise exception 'Driver fields denied' using errcode='42501';end if;$r$;
 if position(anchor in definition)=0 then raise exception 'Unexpected driver operational allowlist' using errcode='55000'; end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=$a$((f->'owner')-array['name','phone','address','companyId'])$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected driver owner allowlist' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$((f->'owner')-array['name','phone','email','address','companyId'])$r$);
 anchor:=$a$if driver_op and (p-array['fields'])<>'{}'::jsonb then raise exception 'Driver fields denied' using errcode='42501';end if;$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected driver operational envelope' using errcode='55000'; end if;
 definition:=replace(definition,anchor,anchor||$r$
 if driver_op and exists(select 1 from jsonb_each(f) party where party.key in ('requester','recipient')
  and (jsonb_typeof(party.value) is distinct from 'object' or (party.value-array['name','phone','email','address','companyId'])<>'{}'::jsonb))
 then raise exception 'Driver party fields denied' using errcode='42501'; end if;
 if driver_op and exists(select 1 from jsonb_each(f) stamp where stamp.key in ('plannedAt','startedAt','finishedAt','handedOverAt') and nullif(stamp.value#>>'{}','') is not null
  and (not isfinite((stamp.value#>>'{}')::timestamptz) or (stamp.key<>'plannedAt' and (stamp.value#>>'{}')::timestamptz>now()+interval '5 minutes')))
 then raise exception 'Invalid actual work time' using errcode='22023'; end if;$r$);
 -- Require the same towing directory on ordinary edits as on new creation.
 anchor:=$a$if nullif(f->>'fleetAssetId','') is not null and not exists(select 1 from public.motorist_fleet_assets where id=(f->>'fleetAssetId')::uuid and organization_id=p_organization_id) then raise exception 'Invalid fleet' using errcode='22023';end if;$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing fleet validation' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$if nullif(f->>'fleetAssetId','') is not null and (p->'fields'?'fleetAssetId' or action='create_order') and not exists(select 1 from public.motorist_fleet_assets where id=(f->>'fleetAssetId')::uuid and organization_id=p_organization_id and kind='tow_truck') then raise exception 'Invalid fleet' using errcode='22023';end if;$r$);
 execute definition;

 definition:=pg_get_functiondef('app_private.towing_driver_fields(jsonb)'::regprocedure);
 anchor:=$a$'assistanceReference','assistancePartnerName'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected driver requester projection' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$'assistanceReference','assistancePartnerName','assistancePartnerId','requesterType','requesterId'$r$);
 foreach anchor in array array['requester','recipient','owner'] loop
  -- Existing merged owner/customer data is retained; only operational contact fields are added.
  replacement:=format($r$jsonb_build_object('name',f->%L->>'name','phone',f->%L->>'phone')$r$,anchor,anchor);
  if position(replacement in definition)>0 then
   definition:=replace(definition,replacement,format($r$jsonb_build_object('name',f->%L->>'name','phone',f->%L->>'phone','email',f->%L->>'email','address',f->%L->>'address','companyId',f->%L->>'companyId')$r$,anchor,anchor,anchor,anchor,anchor));
  end if;
 end loop;
 anchor:=$a$'address',f->'owner'->>'address','companyId',f->'owner'->>'companyId'$a$;
 if position(anchor in definition)>0 then definition:=replace(definition,anchor,anchor||$r$,'email',f->'owner'->>'email'$r$); end if;
 execute definition;

 definition:=pg_get_functiondef('public.motorist_towing_workspace(uuid,uuid,bigint,text,jsonb)'::regprocedure);
 anchor:=$a$from public.motorist_fleet_assets where organization_id=p_organization_id)$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing workspace fleet catalogue' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$from public.motorist_fleet_assets where organization_id=p_organization_id and kind='tow_truck')$r$);
 anchor:=$a$'branches',case when d then '[]'::jsonb else$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected driver branch directory' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$'branches',case when d then coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name) order by b.name) from public.motorist_branches b where b.organization_id=p_organization_id and b.active),'[]'::jsonb) else$r$);
 anchor:=$a$'fleet',case when d then '[]'::jsonb else$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected driver fleet directory' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$'fleet',case when d then coalesce((select jsonb_agg(jsonb_build_object('id',fleet_ref.id,'name',fleet_ref.label) order by fleet_ref.label) from public.motorist_fleet_assets fleet_ref where fleet_ref.organization_id=p_organization_id and fleet_ref.kind='tow_truck'),'[]'::jsonb) else$r$);
 anchor:=$a$'partners',case when d then '[]'::jsonb else$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected driver partner directory' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$'partners',case when d then coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.name) from public.motorist_contacts c where c.organization_id=p_organization_id and c.role in ('partner','assistance')),'[]'::jsonb) else$r$);
 execute definition;
end $patch$;

notify pgrst,'reload schema';
commit;
