-- Additive, read-only history search. No routing, call or customer rows are changed.
-- Only the authenticated server may invoke this RPC; the actor is checked again.
create or replace function public.motorist_history_fold(value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select translate(lower(coalesce(value,'')),
    'áäčďéěíĺľňóôöŕřšťúůüýžàâãåæçèêëìîïñòõøùûÿ',
    'aacdeeillnooorrstuuuyzaaaaaceeeiiinooouuy')
$$;
revoke all on function public.motorist_history_fold(text) from public;
grant execute on function public.motorist_history_fold(text) to service_role;

-- Match domestic Slovak, 00-prefixed and E.164 numbers; preserve short partial searches.
create or replace function public.motorist_history_phone(value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case when digits like '00%' then substr(digits,3)
    when digits like '0%' and length(digits)=10 then '421'||substr(digits,2)
    else digits end
  from (select regexp_replace(coalesce(value,''),'[^0-9]','','g') digits) normalized
$$;
revoke all on function public.motorist_history_phone(text) from public;
grant execute on function public.motorist_history_phone(text) to service_role;

create index if not exists motorist_calls_history_page_idx
  on public.motorist_calls(organization_id, started_at desc nulls last, id desc);

create or replace function public.motorist_search_call_history(
  p_organization_id uuid, p_actor_id uuid, p_query text default '',
  p_from timestamptz default null, p_to timestamptz default null,
  p_direction text default null, p_outcome text default null,
  p_operator_id uuid default null, p_line_id uuid default null,
  p_cursor_at timestamptz default null, p_cursor_id uuid default null,
  p_limit integer default 26
) returns setof public.motorist_calls
language plpgsql stable security definer set search_path = '' as $$
declare needle text := public.motorist_history_fold(trim(coalesce(p_query,'')));
  phone text := public.motorist_history_phone(p_query);
begin
  if not exists (select 1 from public.motorist_profiles p
    join public.motorist_organizations o on o.id=p.organization_id and o.active
    where p.id=p_actor_id and p.organization_id=p_organization_id and p.active
      and p.access_status='active' and p.role in ('dispatcher','senior_dispatcher','manager','admin')) then
    raise exception using errcode='42501', message='History access denied';
  end if;
  if p_limit < 1 or p_limit > 101 or length(needle)>160 then
    raise exception using errcode='22023',message='Invalid history query';
  end if;
  return query select c.* from public.motorist_calls c
    left join public.motorist_cases k on k.id=c.case_id and k.organization_id=p_organization_id
    left join public.motorist_contacts contact on contact.id=k.contact_id and contact.organization_id=p_organization_id
    left join public.motorist_vehicles vehicle on vehicle.id=k.vehicle_id and vehicle.organization_id=p_organization_id
  where c.organization_id=p_organization_id
    and (p_from is null or c.started_at>=p_from)
    and (p_to is null or c.started_at<p_to)
    and (p_direction is null or c.direction::text=p_direction)
    and (p_outcome is null
      or (p_outcome='answered' and c.answered_at is not null)
      or (p_outcome<>'answered' and (c.status::text=p_outcome or c.raw_latest_payload->>'outcome'=p_outcome)))
    and (p_operator_id is null or c.operator_id=p_operator_id)
    and (p_line_id is null or c.line_id=p_line_id)
    and (p_cursor_id is null
      or (p_cursor_at is null and c.started_at is null and c.id<p_cursor_id)
      or (p_cursor_at is not null and (c.started_at<p_cursor_at or c.started_at is null or (c.started_at=p_cursor_at and c.id<p_cursor_id))))
    and (needle='' or strpos(public.motorist_history_fold(concat_ws(' ',
      c.caller_name,c.caller_number,c.called_number,c.received_number,c.destination_number,
      k.case_number,contact.name,k.customer_details->>'firstName',k.customer_details->>'lastName',
      k.customer_details->>'companyName',vehicle.license_plate,k.vehicle_details->>'licensePlate')),needle)>0
      or (p_query ~ '^[+0-9 ()/.-]+$' and length(phone)>=3 and (
        strpos(public.motorist_history_phone(c.caller_number),phone)>0
        or strpos(public.motorist_history_phone(c.called_number),phone)>0
        or strpos(public.motorist_history_phone(c.received_number),phone)>0
        or strpos(public.motorist_history_phone(c.destination_number),phone)>0)))
  order by c.started_at desc nulls last,c.id desc limit p_limit;
end $$;
revoke all on function public.motorist_search_call_history(uuid,uuid,text,timestamptz,timestamptz,text,text,uuid,uuid,timestamptz,uuid,integer) from public,anon,authenticated;
grant execute on function public.motorist_search_call_history(uuid,uuid,text,timestamptz,timestamptz,text,text,uuid,uuid,timestamptz,uuid,integer) to service_role;
notify pgrst, 'reload schema';
