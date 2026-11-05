begin;
-- Operational facts are distinct from office-owned priced lines and receipts.
create function app_private.towing_validate_realized_items(items jsonb,org uuid,require_details boolean,require_quantity boolean) returns void language plpgsql stable set search_path='' as $$
declare item jsonb; ids uuid[]:='{}'; item_id uuid;
begin
 if items is null then return; end if;
 if jsonb_typeof(items)<>'array' or jsonb_array_length(items)>50 then raise exception 'Invalid realized items' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(items) loop
  if jsonb_typeof(item)<>'object' or (item-array['id','kind','description','quantity','unit','parkingId','parkingName','parkingAddress','destination'])<>'{}'::jsonb
   or exists(select 1 from jsonb_each(item) x where jsonb_typeof(x.value) not in ('string','null') or length(x.value#>>'{}')>2000)
   or coalesce(item->>'kind','') not in ('tow','repair','transport','storage','relocation')
   or coalesce(jsonb_typeof(item->'description'),'null')<>'string'
   or coalesce(jsonb_typeof(item->'quantity'),'null')<>'string'
   or coalesce(jsonb_typeof(item->'unit'),'null')<>'string'
   or length(item->>'unit')>40
   or (item->>'quantity'<>'' and item->>'quantity' !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$') then raise exception 'Invalid realized item fields' using errcode='22023'; end if;
  item_id:=(item->>'id')::uuid;
  if item_id is null or item_id=any(ids) then raise exception 'Duplicate or missing realized item ID' using errcode='22023'; end if;
  ids:=array_append(ids,item_id);
  if nullif(item->>'parkingId','') is not null and not exists(select 1 from public.motorist_towing_parking_sites s where s.id=(item->>'parkingId')::uuid and s.organization_id=org) then raise exception 'Invalid realized item parking' using errcode='22023'; end if;
  if require_details and item->>'kind'='storage' and nullif(item->>'parkingId','') is null then raise exception 'Storage item requires an identified parking site' using errcode='22023'; end if;
  if require_details and item->>'kind' in ('tow','transport','relocation') and nullif(btrim(item->>'destination'),'') is null then raise exception 'Transport item requires a destination' using errcode='22023'; end if;
  if require_quantity and (coalesce(nullif(item->>'quantity',''),'0')::numeric<=0 or nullif(btrim(item->>'unit'),'') is null or nullif(btrim(item->>'description'),'') is null) then raise exception 'Realized item requires description, positive quantity and unit' using errcode='22023'; end if;
 end loop;
end $$;
revoke all on function app_private.towing_validate_realized_items(jsonb,uuid,boolean,boolean) from public,anon,authenticated;

do $patch$
declare definition text; anchor text;
begin
 definition:=pg_get_functiondef('public.motorist_towing_command(uuid,uuid,bigint,jsonb)'::regprocedure);
 -- An array is permitted only under this operational key. Money, tax and
 -- arbitrary nested objects still fail the existing bounded field/party checks.
 anchor:=$a$x.key not in ('requester','owner','customer','recipient')$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing text field validation' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$x.key not in ('realizedItems','requester','owner','customer','recipient')$r$);
 anchor:=$a$'photoException','requesterType'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing office operational fields' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$'photoException','realizedItems','odometer','paymentIntent','requesterType'$r$);
 anchor:=$a$if driver_op and (f-array['startedAt','finishedAt','driverNotes','performedQuantity','photoException','destination'])<>'{}'::jsonb then raise exception 'Driver fields denied' using errcode='42501';end if;$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing driver edit allowlist' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$if driver_op and (f-array['startedAt','finishedAt','driverNotes','performedQuantity','photoException','destination','subjectDescription','plate','vin','odometer','realizedItems','paymentIntent','owner'])<>'{}'::jsonb then raise exception 'Driver fields denied' using errcode='42501';end if;
 if driver_op and f?'owner' and (jsonb_typeof(f->'owner') is distinct from 'object' or ((f->'owner')-array['name','phone','address','companyId'])<>'{}'::jsonb) then raise exception 'Driver owner fields denied' using errcode='42501'; end if;$r$);
 anchor:=$a$f:=case when action='create_order' then$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing fields merge' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$if driver_op and f?'owner' then f:=jsonb_set(f,'{owner}',coalesce(o.fields->'owner','{}'::jsonb)||(f->'owner')); end if;
 $r$||anchor);
 anchor:=$a$f:=jsonb_strip_nulls(f);$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing operational field validation' using errcode='55000'; end if;
 definition:=replace(definition,anchor,anchor||$r$
 if nullif(f->>'odometer','') is not null and f->>'odometer' !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$' then raise exception 'Invalid odometer' using errcode='22023'; end if;
 if f->>'paymentIntent' is not null and f->>'paymentIntent' not in ('partner_invoice','deferred_invoice','card_terminal','cash_terminal','cash_other') then raise exception 'Invalid payment intent' using errcode='22023'; end if;
 perform app_private.towing_validate_realized_items(f->'realizedItems',p_organization_id,false,false);
 if f?'realizedItems' then
  if exists(select 1 from jsonb_array_elements(f->'realizedItems') candidate
   join public.motorist_towing_parking_sites site on site.id=nullif(candidate->>'parkingId','')::uuid and site.organization_id=p_organization_id
   where not site.active and not exists(select 1 from jsonb_array_elements(coalesce(o.fields->'realizedItems','[]')) prior_item
    where prior_item->>'id'=candidate->>'id' and prior_item->>'parkingId'=candidate->>'parkingId')) then raise exception 'Inactive realized item parking cannot be newly selected' using errcode='22023'; end if;
  select coalesce(jsonb_agg((item.value-array['parkingName','parkingAddress'])||case when site.id is null then '{}'::jsonb else jsonb_build_object('parkingName',coalesce(previous.value->>'parkingName',site.name),'parkingAddress',coalesce(previous.value->>'parkingAddress',site.address)) end order by item.ordinal),'[]'::jsonb) into lines
  from jsonb_array_elements(f->'realizedItems') with ordinality item(value,ordinal)
  left join public.motorist_towing_parking_sites site on site.id=nullif(item.value->>'parkingId','')::uuid and site.organization_id=p_organization_id
  left join lateral (select previous_item.value from jsonb_array_elements(coalesce(o.fields->'realizedItems','[]')) previous_item(value) where previous_item.value->>'id'=item.value->>'id' and previous_item.value->>'parkingId'=item.value->>'parkingId' limit 1) previous on true;
  f:=jsonb_set(f,'{realizedItems}',lines);
 end if;$r$);
 anchor:=$a$elsif action='assign' then$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing assign transition' using errcode='55000'; end if;
 definition:=replace(definition,anchor,anchor||$r$
 perform app_private.towing_validate_realized_items(o.fields->'realizedItems',p_organization_id,true,false);
 if o.fields->>'serviceType'='storage' and nullif(o.fields->>'parkingId','') is null then raise exception 'Storage requires an identified parking site' using errcode='22023'; end if;$r$);
 execute definition;
 definition:=pg_get_functiondef('app_private.towing_assert_complete(public.motorist_towing_orders)'::regprocedure);
 anchor:=$a$begin$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing completeness function' using errcode='55000'; end if;
 definition:=replace(definition,anchor,anchor||$r$
 perform app_private.towing_validate_realized_items(o.fields->'realizedItems',o.organization_id,true,true);
 if exists(select 1 from jsonb_array_elements(coalesce(o.fields->'realizedItems','[]')) item where item->>'kind' in ('tow','transport','relocation'))
 and nullif(btrim(o.fields->>'photoException'),'') is null and not exists(select 1 from public.motorist_towing_attachments where order_id=o.id and status='ready' and kind='handover' and mime_type like 'image/%') then raise exception 'Realized transport item requires handover photograph or exception' using errcode='22023'; end if;$r$);
 execute definition;
 definition:=pg_get_functiondef('app_private.towing_driver_fields(jsonb)'::regprocedure);
 anchor:=$a$'dispatchInstructions','driverNotes'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected driver operational projection' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$'odometer','realizedItems','paymentIntent','dispatchInstructions','driverNotes'$r$);
 anchor:=$a$jsonb_build_object('name',f->'owner'->>'name','phone',f->'owner'->>'phone')$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected driver owner projection' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$jsonb_build_object('name',f->'owner'->>'name','phone',f->'owner'->>'phone','address',f->'owner'->>'address','companyId',f->'owner'->>'companyId')$r$);
 execute definition;
end $patch$;
-- The authorized driver needs the operational directory to select secondary
-- storage. Office retains its original complete directory, including history.
do $patch$
declare definition text; anchor text:=$a$'parking',case when d then '[]'::jsonb else$a$;
begin
 definition:=pg_get_functiondef('public.motorist_towing_workspace(uuid,uuid,bigint,text,jsonb)'::regprocedure);
 if position(anchor in definition)=0 then raise exception 'Unexpected driver parking directory projection' using errcode='55000'; end if;
 execute replace(definition,anchor,$r$'parking',case when d then coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'address',x.address,'active',x.active,'revision',x.revision) order by x.name) from public.motorist_towing_parking_sites x where x.organization_id=p_organization_id and x.active),'[]'::jsonb) else$r$);
end $patch$;
notify pgrst,'reload schema';
commit;
