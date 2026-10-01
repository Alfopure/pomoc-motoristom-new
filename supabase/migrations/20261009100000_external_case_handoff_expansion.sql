begin;

alter table public.motorist_case_handoffs
 add column token_envelope jsonb,
 add column link_origin text,
 add column created_by_name text,
 add column published_at timestamptz;
alter table public.motorist_handoff_receipts add column token_generation integer;
alter table public.motorist_case_handoffs add constraint motorist_handoff_envelope_pair
 check ((token_envelope is null and link_origin is null) or
  (token_envelope is not null and link_origin is not null and jsonb_typeof(token_envelope)='object' and link_origin ~ '^https?://[a-zA-Z0-9.-]+(:[0-9]+)?$' and length(token_envelope::text)<2000
   and token_envelope ?& array['version','keyId','iv','tag','ciphertext'] and token_envelope-array['version','keyId','iv','tag','ciphertext']='{}'::jsonb
   and token_envelope->>'version'='1' and token_envelope->>'keyId' ~ '^[a-zA-Z0-9_-]{1,40}$'
   and token_envelope->>'iv' ~ '^[a-zA-Z0-9_-]{16}$' and token_envelope->>'tag' ~ '^[a-zA-Z0-9_-]{22}$' and token_envelope->>'ciphertext' ~ '^[a-zA-Z0-9_-]{58}$'));

create or replace function app_private.motorist_handoff_case(p_org uuid,p_case uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('schemaVersion',3,'caseNumber',c.case_number,'action',coalesce(c.case_type,'Asistenčný úkon'),
  'contact',jsonb_build_object('name',coalesce(n.name,''),'phone',coalesce(n.phone,'')),
  'vehicle',jsonb_build_object('make',coalesce(v.make,''),'model',coalesce(v.model,''),'plate',coalesce(v.license_plate,''),
   'color',coalesce(v.color,''),'driveable',v.is_driveable,'conditionFlags',coalesce((select jsonb_agg(distinct flag order by flag)
    from jsonb_array_elements_text(case when jsonb_typeof(c.vehicle_details->'conditionFlags')='array' then c.vehicle_details->'conditionFlags' else '[]'::jsonb end) flag
    where flag in ('immobile','locked','no_keys','blocked_wheel','after_accident','overturned','in_ditch')),'[]'::jsonb)),
  'pickup',case when p.id is not null then jsonb_build_object('address',p.address,'lat',p.lat,'lng',p.lng) when nullif(btrim(c.location_details->>'manualPickupAddress'),'') is not null then jsonb_build_object('address',c.location_details->>'manualPickupAddress','lat',null,'lng',null) else null end,
  'destination',case when d.id is not null then jsonb_build_object('address',d.address,'lat',d.lat,'lng',d.lng) when nullif(btrim(c.location_details->>'manualDestinationAddress'),'') is not null then jsonb_build_object('address',c.location_details->>'manualDestinationAddress','lat',null,'lng',null) else null end,
  'assistance',jsonb_build_object('name',left(coalesce(c.customer_details->>'assistanceServiceName',''),160),
   'reference',left(coalesce(nullif(btrim(c.customer_details->>'assistanceReference'),''),c.assistance_reference,''),160)),
  'replacement',jsonb_build_object('needed',case when c.replacement_vehicle_details->'needed'='true'::jsonb then true when c.replacement_vehicle_details->'needed'='false'::jsonb then false else null end,
   'category',case when c.replacement_vehicle_details->>'category' in ('small_car','wagon','suv','van') then c.replacement_vehicle_details->>'category' else '' end,
   'requestedType',left(coalesce(c.replacement_vehicle_details->>'requestedType',''),160),
   'preferences',coalesce((select jsonb_agg(distinct preference order by preference) from jsonb_array_elements_text(case when jsonb_typeof(c.replacement_vehicle_details->'preferences')='array' then c.replacement_vehicle_details->'preferences' else '[]'::jsonb end) preference
    where preference in ('automatic','manual','suv','wagon','van','ev')),'[]'::jsonb),
   'status',case when c.replacement_vehicle_details->'needed'='false'::jsonb then 'not_needed' when c.replacement_vehicle_details->>'provisionStatus'='not_provided' then 'not_provided' when car.total=1 then 'assigned' when c.replacement_vehicle_details->>'provisionStatus'='provided' then 'provided' else 'pending' end,
   'deliveryPlace',left(coalesce(c.replacement_vehicle_details->>'deliveryPlace',''),500),
   'vehicle',case when car.total=1 and c.replacement_vehicle_details->'needed' is distinct from 'false'::jsonb and c.replacement_vehicle_details->>'provisionStatus' is distinct from 'not_provided' then car.vehicle else null end),
  'incident',jsonb_build_object('description',left(coalesce(c.incident_details->>'description',''),1000),
   'passengersCount',case when c.incident_details->>'passengersCount' ~ '^([0-9]|[1-4][0-9]|50)$' then (c.incident_details->>'passengersCount')::integer else null end,
   'access',left(coalesce(c.location_details->>'complications',''),500)),
  'caseCreatedAt',c.created_at,'firstCallAt',(select min(call.started_at) from public.motorist_calls call where call.organization_id=p_org and call.case_id=c.id and call.direction='inbound'))
 from public.motorist_cases c
 left join public.motorist_contacts n on n.id=c.contact_id and n.organization_id=c.organization_id
 left join public.motorist_vehicles v on v.id=c.vehicle_id and v.organization_id=c.organization_id
 left join public.motorist_locations p on p.id=c.pickup_location_id and p.organization_id=c.organization_id
 left join public.motorist_locations d on d.id=c.destination_location_id and d.organization_id=c.organization_id
 left join lateral (select count(*) total,(jsonb_agg(jsonb_build_object('make',coalesce(asset.make,''),'model',coalesce(asset.model,''),'plate',coalesce(asset.license_plate,'')) order by asset.id))->0 vehicle
  from public.motorist_fleet_assets asset where asset.organization_id=c.organization_id and asset.kind='replacement_car' and (asset.occupancy_case_id=c.id or (asset.id=c.selected_asset_id and asset.occupancy_case_id is null))) car on true
 where c.id=p_case and c.organization_id=p_org
$$;

create or replace function app_private.motorist_handoff_dto(p_id uuid,p_public boolean default false) returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('id',h.id,'status',case when h.expires_at<=clock_timestamp() and h.status in ('offered','accepted','en_route','arrived') then 'expired' else h.status end,
  'revision',h.revision,'publishedVersion',h.published_version,'recipientName',h.recipient_name,
  'expiresAt',h.expires_at,'createdAt',h.created_at,'openedAt',h.opened_at,'eta',h.eta,
  'createdBy',h.created_by_name,'publishedAt',h.published_at,
  'published',case when p_public and h.status in ('completed','rejected') then null else h.published end,
  'events',case when p_public and h.status in ('completed','rejected') then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'comment',e.comment,
   'actor',case when e.actor_profile_id is null then 'Držiteľ odkazu' else 'Dispečing' end,'createdAt',e.created_at) order by e.created_at,e.id)
   from public.motorist_handoff_events e where e.handoff_id=h.id),'[]'::jsonb) end)
  || case when p_public then '{}'::jsonb else jsonb_build_object('recipientPhone',h.recipient_phone,'canRenew',h.status in ('offered','accepted','en_route','arrived'),
   'tokenGeneration',h.token_generation,'recoverable',h.token_envelope is not null) end
 from public.motorist_case_handoffs h where h.id=p_id
$$;

create or replace function public.motorist_case_handoff(p_organization_id uuid,p_actor_id uuid,p_case_id uuid,p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare h public.motorist_case_handoffs; receipt public.motorist_handoff_receipts; snapshot jsonb; fingerprint jsonb;
 cid uuid; v_actor_key text; handoff_id uuid; hours integer; comment text; token text; actor_name text;
begin
 select p.display_name into actor_name from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
  where p.id=p_actor_id and p.user_id=auth.uid() and p.organization_id=p_organization_id and p.active and p.access_status='active'
  and p.role in ('dispatcher','senior_dispatcher','manager','admin');
 if auth.uid() is null or not found then raise exception 'Forbidden' using errcode='42501'; end if;
 perform 1 from public.motorist_cases where id=p_case_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Case unavailable' using errcode='P0002'; end if;
 if p_action='link' then
  select * into h from public.motorist_case_handoffs where id=(p_input->>'handoffId')::uuid and organization_id=p_organization_id and case_id=p_case_id for update;
  if h.id is null or h.status not in ('offered','accepted','en_route','arrived') or h.expires_at<=clock_timestamp() then raise exception 'Grant unavailable' using errcode='P0002'; end if;
  if h.token_envelope is null then raise exception 'Legacy grant requires explicit rotation' using errcode='PT409'; end if;
  if p_input ? 'generation' and h.token_generation is distinct from (p_input->>'generation')::integer then raise exception 'Rotated grant' using errcode='PT409'; end if;
  if not exists(select 1 from public.motorist_handoff_events event where event.handoff_id=h.id and event.action='recover' and event.command_id=(p_input->>'commandId')::uuid and event.actor_profile_id=p_actor_id) then
   insert into public.motorist_handoff_events(handoff_id,action,actor_profile_id,command_id,revision) values(h.id,'recover',p_actor_id,(p_input->>'commandId')::uuid,h.revision);
  end if;
  return jsonb_build_object('handoff',app_private.motorist_handoff_dto(h.id),'envelope',h.token_envelope,'tokenHash',h.token_hash,'generation',h.token_generation,'origin',h.link_origin);
 end if;
 snapshot:=app_private.motorist_handoff_case(p_organization_id,p_case_id);
 if p_action='context' then return jsonb_build_object('preview',snapshot,'previewVersion',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'),
  'handoffs',coalesce((select jsonb_agg(app_private.motorist_handoff_dto(t.id) order by t.created_at desc) from public.motorist_case_handoffs t where t.organization_id=p_organization_id and t.case_id=p_case_id),'[]'::jsonb)); end if;
 if p_action not in ('issue','publish','renew','extend','revoke') or jsonb_typeof(p_input)<>'object' then raise exception 'Invalid command' using errcode='22023'; end if;
 cid:=(p_input->>'commandId')::uuid; if cid is null then raise exception 'Command required' using errcode='22023'; end if;
 v_actor_key:='profile:'||p_actor_id;
 fingerprint:=jsonb_build_object('case',p_case_id,'action',p_action,'input',p_input-array['tokenHash','tokenEnvelope','linkOrigin','issuedId','secretGeneration']);
 select * into receipt from public.motorist_handoff_receipts r where r.actor_key=v_actor_key and r.command_id=cid;
 if found then
  if receipt.payload<>fingerprint then raise exception 'Command conflict' using errcode='PT409'; end if;
  return jsonb_build_object('handoff',app_private.motorist_handoff_dto(receipt.handoff_id),'commandId',cid,'committedRevision',receipt.committed_revision,'tokenAccepted',false,'linkGeneration',receipt.token_generation);
 end if;
 if p_action in ('issue','publish') then
  if p_input->>'previewVersion' is distinct from encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') then raise exception 'Case changed' using errcode='PT409'; end if;
  comment:=btrim(coalesce(p_input->>'instructions',''));
  if length(comment)>2000 then raise exception 'Instructions too long' using errcode='22023'; end if;
  snapshot:=snapshot||jsonb_build_object('instructions',comment,'scheduledAt',nullif(p_input->>'scheduledAt','')::timestamptz);
 end if;
 if p_action in ('issue','renew','extend') then
  hours:=coalesce((p_input->>'hours')::integer,24);
  if hours<1 or hours>72 then raise exception 'Invalid expiry' using errcode='22023'; end if;
 end if;
 if p_action in ('issue','renew') then
  token:=p_input->>'tokenHash';
  if token is null or token!~'^[a-f0-9]{64}$' then raise exception 'Invalid grant' using errcode='22023'; end if;
  if p_input ? 'tokenEnvelope' and (jsonb_typeof(p_input->'tokenEnvelope') is distinct from 'object' or
   p_input->>'issuedId' is null or p_input->>'secretGeneration' is null or p_input->>'linkOrigin' is null) then raise exception 'Invalid envelope' using errcode='22023'; end if;
 end if;
 if p_action='issue' then
  if length(btrim(coalesce(p_input->>'recipientName',''))) not between 1 and 160 or coalesce(p_input->>'recipientPhone','')!~'^\+?[0-9 ()-]{5,30}$' then raise exception 'Recipient required' using errcode='22023'; end if;
  if p_input ? 'tokenEnvelope' and (p_input->>'secretGeneration')::integer<>1 then raise exception 'Invalid generation' using errcode='22023'; end if;
  update public.motorist_case_handoffs set status='expired',revision=revision+1,updated_at=clock_timestamp() where organization_id=p_organization_id and case_id=p_case_id and status in ('offered','accepted','en_route','arrived') and expires_at<=clock_timestamp();
  if exists(select 1 from public.motorist_case_handoffs where organization_id=p_organization_id and case_id=p_case_id and status in ('offered','accepted','en_route','arrived')) then raise exception 'Active handoff exists' using errcode='PT409'; end if;
  insert into public.motorist_case_handoffs(id,organization_id,case_id,created_by,created_by_name,recipient_name,recipient_phone,published,published_at,token_hash,token_envelope,link_origin,expires_at)
   values(coalesce((p_input->>'issuedId')::uuid,gen_random_uuid()),p_organization_id,p_case_id,p_actor_id,actor_name,btrim(p_input->>'recipientName'),p_input->>'recipientPhone',snapshot,clock_timestamp(),token,p_input->'tokenEnvelope',p_input->>'linkOrigin',clock_timestamp()+make_interval(hours=>hours)) returning * into h;
 else
  handoff_id:=(p_input->>'handoffId')::uuid;
  select * into h from public.motorist_case_handoffs where id=handoff_id and organization_id=p_organization_id and case_id=p_case_id for update;
  if not found then raise exception 'Handoff unavailable' using errcode='P0002'; end if;
  if h.revision is distinct from (p_input->>'expectedRevision')::integer then raise exception 'Handoff changed' using errcode='PT409'; end if;
  if h.status not in ('offered','accepted','en_route','arrived') then raise exception 'Terminal handoff' using errcode='PT409'; end if;
  if p_action='revoke' then
   comment:=regexp_replace(coalesce(p_input->>'comment',''),'^[[:space:]]+|[[:space:]]+$','','g'); if length(comment) not between 1 and 1000 then raise exception 'Reason required' using errcode='22023'; end if;
   h.status:='cancelled'; h.token_generation:=h.token_generation+1;
  elsif p_action='renew' then
   if p_input ? 'tokenEnvelope' and ((p_input->>'secretGeneration')::integer<>h.token_generation+1 or (p_input->>'issuedId')::uuid<>h.id) then raise exception 'Invalid generation' using errcode='PT409'; end if;
   h.token_hash:=token; h.token_generation:=h.token_generation+1; h.expires_at:=clock_timestamp()+make_interval(hours=>hours);
   h.token_envelope:=p_input->'tokenEnvelope'; h.link_origin:=p_input->>'linkOrigin';
  elsif p_action='extend' then
   h.expires_at:=greatest(h.expires_at,clock_timestamp()+make_interval(hours=>hours));
  else
   if h.expires_at<=clock_timestamp() then raise exception 'Grant expired' using errcode='PT409'; end if;
   h.published:=snapshot; h.published_version:=h.published_version+1; h.published_at:=clock_timestamp();
  end if;
  h.revision:=h.revision+1;
  update public.motorist_case_handoffs set status=h.status,token_hash=h.token_hash,token_generation=h.token_generation,expires_at=h.expires_at,
   token_envelope=h.token_envelope,link_origin=h.link_origin,published=h.published,published_at=h.published_at,published_version=h.published_version,revision=h.revision,updated_at=clock_timestamp() where id=h.id;
 end if;
 insert into public.motorist_handoff_events(handoff_id,action,comment,actor_profile_id,command_id,revision) values(h.id,p_action,case when p_action='revoke' then comment else '' end,p_actor_id,cid,h.revision);
 insert into public.motorist_handoff_receipts(actor_key,command_id,handoff_id,payload,committed_revision,token_generation) values(v_actor_key,cid,h.id,fingerprint,h.revision,case when p_action in ('issue','renew') and h.token_envelope is not null then h.token_generation else null end);
 return jsonb_build_object('handoff',app_private.motorist_handoff_dto(h.id),'commandId',cid,'committedRevision',h.revision,'tokenAccepted',p_action in ('issue','renew'),'linkGeneration',case when p_action in ('issue','renew') and h.token_envelope is not null then h.token_generation else null end);
end $$;

revoke all on function app_private.motorist_handoff_case(uuid,uuid),app_private.motorist_handoff_dto(uuid,boolean) from public,anon,authenticated,service_role;
revoke all on function public.motorist_case_handoff(uuid,uuid,uuid,text,jsonb) from public,anon,service_role;
grant execute on function public.motorist_case_handoff(uuid,uuid,uuid,text,jsonb) to authenticated;

commit;
