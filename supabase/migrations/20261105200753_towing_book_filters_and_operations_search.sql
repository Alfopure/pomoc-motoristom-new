begin;
-- Read-only book semantics. No historical requester reclassification or timestamp rewrite.
create function app_private.towing_book_timestamp(value text) returns timestamptz language plpgsql stable set search_path='' as $$
declare parsed timestamptz;
begin
 if value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then return null; end if;
 parsed:=nullif(value,'')::timestamptz;
 return case when isfinite(parsed) then parsed else null end;
exception when invalid_datetime_format or datetime_field_overflow then return null;
end $$;
create function app_private.towing_book_date(o public.motorist_towing_orders,basis text) returns timestamptz language sql stable set search_path='' as $$
 select case when basis='dispatch' then coalesce(case when o.fields->>'startSource' is distinct from 'assignment' then app_private.towing_book_timestamp(o.fields->>'startedAt') end,app_private.towing_book_timestamp(o.fields->>'plannedAt'),o.created_at) else o.created_at end
$$;
create function app_private.towing_book_stage(o public.motorist_towing_orders) returns text language plpgsql stable set search_path='' as $$
declare due bigint; received bigint;
begin
 if o.work_status in ('cancelled','needs_changes') then return o.work_status; end if;
 if o.work_status='draft' then return case when o.fields->>'executionOrigin'='awp_record_only' then 'review' else 'draft' end; end if;
 if o.work_status in ('assigned','in_progress') then return 'active'; end if;
 if o.billing_status in ('invoiced','not_required') then
  due:=app_private.towing_due(o.id);
  select coalesce(sum(amount_cents),0) into received from public.motorist_towing_payments where order_id=o.id;
  if due is not null and received>=due then return 'paid'; end if;
 end if;
 return case o.billing_status when 'invoiced' then 'invoiced' when 'ready' then 'ready' when 'not_required' then 'ready' else 'review' end;
end $$;
revoke all on function app_private.towing_book_timestamp(text),app_private.towing_book_date(public.motorist_towing_orders,text),app_private.towing_book_stage(public.motorist_towing_orders) from public,anon,authenticated;

-- Keep all existing authorization and projections; extend the one filtered CTE
-- used by rows, count and financial aggregates. Fail closed if its source drifts.
do $patch$
declare definition text; anchor text; replacement text;
begin
 definition:=pg_get_functiondef('public.motorist_towing_workspace(uuid,uuid,bigint,text,jsonb)'::regprocedure);
 anchor:=$a$with filtered as (select o.* from public.motorist_towing_orders o where o.organization_id=p_organization_id$a$;
 replacement:=$r$with filtered as (select o.* from public.motorist_towing_orders o where o.organization_id=p_organization_id
 and (nullif(p_filters->>'stage','') is null or app_private.towing_book_stage(o)=p_filters->>'stage')
 and (nullif(p_filters->>'requesterType','') is null or coalesce(nullif(o.fields->>'requesterType',''),'unknown')=p_filters->>'requesterType')
 and (nullif(p_filters->>'requesterId','') is null or o.fields->>'requesterId'=p_filters->>'requesterId')$r$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing book filter' using errcode='55000'; end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=$a$ perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing workspace validation' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$
 if (p_filters->>'sort' is not null and p_filters->>'sort' not in ('operational','date_asc','date_desc','amount_desc','driver_asc'))
 or (p_filters->>'dateBasis' is not null and p_filters->>'dateBasis' not in ('created','dispatch'))
 or (p_filters->>'stage' is not null and p_filters->>'stage' not in ('draft','active','review','ready','invoiced','paid','cancelled','needs_changes'))
 or (p_filters->>'requesterType' is not null and p_filters->>'requesterType' not in ('assistance','selfpayer','unknown')) then raise exception 'Invalid book query' using errcode='22023'; end if;
 $r$||anchor);

 anchor:=$a$coalesce(o.fields->'requester'->>'name','') ilike '%'||(p_filters->>'requester')||'%'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing requester search' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$concat_ws(' ',o.fields->'requester'->>'name',o.fields->>'assistancePartnerName') ilike '%'||(p_filters->>'requester')||'%'$r$);
 anchor:=$a$o.created_at>=(p_filters->>'from')::timestamptz$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing book from' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$app_private.towing_book_date(o,p_filters->>'dateBasis')>=case when p_filters->>'from' ~ '^\d{4}-\d{2}-\d{2}$' then (p_filters->>'from')::date::timestamp at time zone 'Europe/Bratislava' else (p_filters->>'from')::timestamptz end$r$);
 anchor:=$a$o.created_at<(p_filters->>'to')::timestamptz$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing book to' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$app_private.towing_book_date(o,p_filters->>'dateBasis')<case when p_filters->>'to' ~ '^\d{4}-\d{2}-\d{2}$' then ((p_filters->>'to')::date+1)::timestamp at time zone 'Europe/Bratislava' else (p_filters->>'to')::timestamptz end$r$);
 anchor:=$a$paged as(select * from filtered order by case work_status when 'draft' then 0 when 'assigned' then 1 when 'in_progress' then 2 when 'needs_changes' then 3 else 4 end,updated_at desc limit least(greatest(coalesce((p_filters->>'limit')::int,50),1),100) offset greatest(coalesce((p_filters->>'offset')::int,0),0))$a$;
 replacement:=$r$paged as(select f.* from filtered f order by
 case when coalesce(p_filters->>'sort','operational')='operational' then case when f.fields->>'executionOrigin'='awp_record_only' and f.work_status='draft' then 4 else case f.work_status when 'draft' then 0 when 'assigned' then 1 when 'in_progress' then 2 when 'needs_changes' then 3 else 4 end end end,
 case when p_filters->>'sort'='date_asc' then app_private.towing_book_date(f,p_filters->>'dateBasis') end asc nulls last,
 case when p_filters->>'sort'='date_desc' then app_private.towing_book_date(f,p_filters->>'dateBasis') end desc nulls last,
 case when p_filters->>'sort'='amount_desc' then f.approved_cents end desc nulls last,
 case when p_filters->>'sort'='driver_asc' then (select lower(mb.display_name) from public.motorist_towing_memberships mb where mb.id=f.driver_id and mb.organization_id=p_organization_id) end asc nulls last,
 f.updated_at desc,f.id
 limit least(greatest(coalesce((p_filters->>'limit')::int,50),1),50) offset greatest(coalesce((p_filters->>'offset')::int,0),0))$r$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing book page' using errcode='55000'; end if;
 definition:=replace(definition,anchor,replacement);
 definition:=replace(definition,'jsonb_agg(app_private.towing_order_json(p,d,m.id))',$order$jsonb_agg(app_private.towing_order_json(p,d,m.id) order by case when coalesce(p_filters->>'sort','operational')='operational' then case when p.fields->>'executionOrigin'='awp_record_only' and p.work_status='draft' then 4 else case p.work_status when 'draft' then 0 when 'assigned' then 1 when 'in_progress' then 2 when 'needs_changes' then 3 else 4 end end end,
 case when p_filters->>'sort'='date_asc' then app_private.towing_book_date(p,p_filters->>'dateBasis') end asc nulls last,
 case when p_filters->>'sort'='date_desc' then app_private.towing_book_date(p,p_filters->>'dateBasis') end desc nulls last,
 case when p_filters->>'sort'='amount_desc' then p.approved_cents end desc nulls last,
 case when p_filters->>'sort'='driver_asc' then (select lower(mb.display_name) from public.motorist_towing_memberships mb where mb.id=p.driver_id and mb.organization_id=p_organization_id) end asc nulls last,
 p.updated_at desc,p.id)$order$);
 execute definition;
end $patch$;

-- Explicit contact provenance is office-owned, nullable for historical rows.
do $patch$
declare definition text; anchor text;
begin
 definition:=pg_get_functiondef('public.motorist_towing_command(uuid,uuid,bigint,jsonb)'::regprocedure);
 anchor:=$a$'photoException','requester','owner','customer','recipient'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing fields allowlist' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$'photoException','requesterType','requesterId','dispatchInstructions','requester','owner','customer','recipient'$r$);
 anchor:=$a$if nullif(f->>'assistancePartnerId','') is not null then$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected towing requester validation' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$if f->>'requesterType' is not null and f->>'requesterType' not in ('assistance','selfpayer') then raise exception 'Invalid requester type' using errcode='22023'; end if;
 if nullif(f->>'requesterId','') is not null and not exists(select 1 from public.motorist_contacts c where c.id=(f->>'requesterId')::uuid and c.organization_id=p_organization_id and c.role in ('assistance','partner')) then raise exception 'Invalid requester contact' using errcode='22023'; end if;
 if length(coalesce(f->>'dispatchInstructions',''))>4000 then raise exception 'Dispatch instructions too long' using errcode='22023'; end if;
 $r$||anchor);
 execute definition;
 -- Extend only the driver read projection, never their editable field allowlist.
 definition:=pg_get_functiondef('app_private.towing_driver_fields(jsonb)'::regprocedure);
 anchor:=$a$'driverNotes'$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected driver fields projection' using errcode='55000'; end if;
 execute replace(definition,anchor,$r$'dispatchInstructions','driverNotes'$r$);
end $patch$;

-- Search the complete authorized operation set before pagination, using joined
-- display values rather than loading every DTO or doing client-side N+1 reads.
do $patch$
declare definition text; anchor text;
begin
 definition:=pg_get_functiondef('public.motorist_operations_workspace(uuid,uuid,jsonb)'::regprocedure);
 anchor:=$a$left join public.motorist_towing_orders t on t.id=o.towing_order_id$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected operation search joins' using errcode='55000'; end if;
 definition:=replace(definition,anchor,anchor||$r$
 left join public.motorist_cases search_case on search_case.id=o.case_id and search_case.organization_id=p_organization_id

 left join public.motorist_contacts search_case_contact on search_case_contact.id=search_case.contact_id and search_case_contact.organization_id=p_organization_id and ((actor->>'canDispatch')::boolean or (e.assignee_id=(actor->>'memberId')::uuid and e.status not in ('completed','cancelled') and (not exists(select 1 from public.motorist_case_handoffs legacy where legacy.operation_id=o.id) or exists(select 1 from public.motorist_case_handoffs live_grant where live_grant.operation_id=o.id and live_grant.organization_id=p_organization_id and live_grant.recipient_member_id=(actor->>'memberId')::uuid and live_grant.published is not null and live_grant.expires_at>clock_timestamp() and live_grant.status in ('offered','accepted','en_route','arrived')))))
 left join public.motorist_contacts search_case_partner on search_case_partner.id=search_case.partner_id and search_case_partner.organization_id=p_organization_id and ((actor->>'canDispatch')::boolean or (e.assignee_id=(actor->>'memberId')::uuid and e.status not in ('completed','cancelled') and (not exists(select 1 from public.motorist_case_handoffs legacy where legacy.operation_id=o.id) or exists(select 1 from public.motorist_case_handoffs live_grant where live_grant.operation_id=o.id and live_grant.organization_id=p_organization_id and live_grant.recipient_member_id=(actor->>'memberId')::uuid and live_grant.published is not null and live_grant.expires_at>clock_timestamp() and live_grant.status in ('offered','accepted','en_route','arrived')))))
 left join public.motorist_contacts search_towing_requester on search_towing_requester.id::text=t.fields->>'requesterId' and search_towing_requester.organization_id=p_organization_id left join public.motorist_vehicle_use_cycles search_cycle on search_cycle.id=o.cycle_id and search_cycle.organization_id=p_organization_id
 left join public.motorist_fleet_assets search_asset on search_asset.id=coalesce(search_cycle.fleet_asset_id,e.fleet_asset_id) and search_asset.organization_id=p_organization_id
 left join public.motorist_towing_memberships search_member on search_member.id=coalesce(t.driver_id,e.assignee_id) and search_member.organization_id=p_organization_id$r$);
 anchor:=$a$where o.organization_id=p_organization_id$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected operation search predicate' using errcode='55000'; end if;
 definition:=replace(definition,anchor,anchor||$r$
 and (nullif(btrim(p_filters->>'query'),'') is null or strpos(lower(concat_ws(' ',search_case.case_number,coalesce(search_asset.label,t.fields->>'subjectDescription'),coalesce(t.fields->>'pickup',e.pickup),coalesce(t.fields->>'destination',e.destination),search_member.display_name,search_asset.license_plate,search_asset.vin,t.fields->>'plate',t.fields->>'vin',t.fields->'requester'->>'name',t.fields->>'assistancePartnerName',t.fields->>'assistanceReference',search_towing_requester.name,search_case_contact.name,search_case_partner.name,case when ((actor->>'canDispatch')::boolean or (e.assignee_id=(actor->>'memberId')::uuid and e.status not in ('completed','cancelled') and (not exists(select 1 from public.motorist_case_handoffs legacy where legacy.operation_id=o.id) or exists(select 1 from public.motorist_case_handoffs live_grant where live_grant.operation_id=o.id and live_grant.organization_id=p_organization_id and live_grant.recipient_member_id=(actor->>'memberId')::uuid and live_grant.published is not null and live_grant.expires_at>clock_timestamp() and live_grant.status in ('offered','accepted','en_route','arrived'))))) then search_case.assistance_reference end)),lower(btrim(p_filters->>'query')))>0)$r$);
 definition:=replace(definition,'least(100,greatest(1,coalesce((p_filters->>''limit'')::integer,50)))','least(50,greatest(1,coalesce((p_filters->>''limit'')::integer,50)))');
 execute definition;
end $patch$;
notify pgrst,'reload schema';
commit;
