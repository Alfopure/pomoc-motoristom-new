-- Exact client-facing assistance names and provider ids for all eight active DIDs.
update public.motorist_telephony_lines
set
  label = case phone_number
    when '+421232408718' then 'Allianz Assistance'
    when '+421232408732' then 'Autoklub Slovakia Assistance s.r.o'
    when '+421232408760' then 'AXA Assistance CZ s.r.o'
    when '+421232408783' then 'Eurocross Assistance Czech Republic s.r.o'
    else label
  end,
  partner_name = case phone_number
    when '+421232408718' then 'Allianz Assistance'
    when '+421232408732' then 'Autoklub Slovakia Assistance s.r.o'
    when '+421232408760' then 'AXA Assistance CZ s.r.o'
    when '+421232408783' then 'Eurocross Assistance Czech Republic s.r.o'
    else partner_name
  end,
  telnyx_number_id = case phone_number
    when '+421232408718' then '3040142888064255967'
    when '+421232408732' then '3040142888089421792'
    when '+421232408760' then '3040142888089421793'
    when '+421232408783' then '3040142888097810402'
    else telnyx_number_id
  end
where provider = 'telnyx'
  and phone_number in (
    '+421232408718',
    '+421232408732',
    '+421232408760',
    '+421232408783'
  );

insert into public.motorist_telephony_lines (
  id,
  organization_id,
  provider,
  phone_number,
  label,
  partner_name,
  telnyx_number_id,
  ring_plan_id,
  ivr_menu_id,
  business_hours_id,
  environment,
  active
)
values
  (
    '00000000-0000-4000-8000-000000000206',
    '00000000-0000-4000-8000-000000000001',
    'telnyx',
    '+421232408770',
    'Europ Assistance',
    'Europ Assistance',
    '3043592669088449601',
    '00000000-0000-4000-8000-000000002301',
    null,
    '00000000-0000-4000-8000-000000002001',
    'production',
    true
  ),
  (
    '00000000-0000-4000-8000-000000000207',
    '00000000-0000-4000-8000-000000000001',
    'telnyx',
    '+421232408771',
    'LeasePlan Slovakia s.r.o',
    'LeasePlan Slovakia s.r.o',
    '3043592669113615426',
    '00000000-0000-4000-8000-000000002301',
    null,
    '00000000-0000-4000-8000-000000002001',
    'production',
    true
  ),
  (
    '00000000-0000-4000-8000-000000000208',
    '00000000-0000-4000-8000-000000000001',
    'telnyx',
    '+421232408774',
    'Neutrálna linka 2',
    null,
    '3043592669122004035',
    '00000000-0000-4000-8000-000000002301',
    '00000000-0000-4000-8000-000000002401',
    '00000000-0000-4000-8000-000000002001',
    'production',
    true
  )
on conflict (organization_id, phone_number) do update
set
  label = excluded.label,
  partner_name = excluded.partner_name,
  telnyx_number_id = excluded.telnyx_number_id,
  ring_plan_id = excluded.ring_plan_id,
  ivr_menu_id = excluded.ivr_menu_id,
  business_hours_id = excluded.business_hours_id,
  environment = excluded.environment,
  active = excluded.active;
