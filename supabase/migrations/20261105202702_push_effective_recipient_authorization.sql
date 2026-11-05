begin;
-- Re-check effective identity immediately before claiming queued notices. A lead
-- seat needs no delivery capability; executor assignment notices do.
do $patch$
declare definition text; anchor text; replacement text;
begin
 definition:=pg_get_functiondef('app_private.push_still_valid(public.motorist_push_outbox)'::regprocedure);
 anchor:=$a$when o.member_id is not null and not exists(select 1 from public.motorist_towing_memberships m where m.id=o.member_id and m.active) then false$a$;
 replacement:=$r$when not exists(select 1 from public.motorist_organizations org where org.id=o.organization_id and org.active) then false
  when o.member_id is not null and not exists(select 1 from public.motorist_towing_memberships m where m.id=o.member_id and m.organization_id=o.organization_id and m.active and m.auth_user_id is not null
   and (m.office_profile_id is null or exists(select 1 from public.motorist_profiles p where p.id=m.office_profile_id and p.user_id=m.auth_user_id and p.organization_id=m.organization_id and p.active and p.access_status<>'disabled'))) then false$r$;
 if position(anchor in definition)=0 then raise exception 'Unexpected push membership guard' using errcode='55000'; end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=$a$when o.profile_id is not null and not exists(select 1 from public.motorist_profiles p where p.id=o.profile_id and p.active and p.access_status='active') then false$a$;
 replacement:=$r$when o.profile_id is not null and not exists(select 1 from public.motorist_profiles p where p.id=o.profile_id and p.organization_id=o.organization_id and p.active and p.access_status='active' and p.kind is distinct from 'ai'
   and p.role in ('dispatcher','senior_dispatcher','manager','admin')
   and (o.event<>'branch_waiting' or p.role in ('senior_dispatcher','manager','admin'))) then false$r$;
 if position(anchor in definition)=0 then raise exception 'Unexpected push profile guard' using errcode='55000'; end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=$a$when o.event in ('work_assigned','work_changed') then exists($a$;
 replacement:=$r$when o.event in ('work_assigned','work_changed') then exists(select 1 from public.motorist_towing_memberships m where m.id=o.member_id and m.organization_id=o.organization_id and app_private.motorist_delivery_member_ready(m)) and exists($r$;
 if position(anchor in definition)=0 then raise exception 'Unexpected push executor guard' using errcode='55000'; end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=$a$when o.event='tow_assigned' then exists($a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected push towing assignment guard' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$when o.event='tow_assigned' then exists(select 1 from public.motorist_towing_memberships m where m.id=o.member_id and m.organization_id=o.organization_id and 'drive'=any(m.capabilities)) and exists($r$);
 anchor:=$a$when o.event='tow_needs_changes' then exists($a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected push towing return guard' using errcode='55000'; end if;
 definition:=replace(definition,anchor,$r$when o.event='tow_needs_changes' then exists(select 1 from public.motorist_towing_memberships m where m.id=o.member_id and m.organization_id=o.organization_id and 'drive'=any(m.capabilities)) and exists($r$);
 execute definition;
end $patch$;
notify pgrst,'reload schema';
commit;
