insert into public.motorist_organizations (id, slug, name, active)
values ('00000000-0000-4000-8000-000000000001', 'pomoc-motoristom', 'Pomoc Motoristom', true);

insert into public.motorist_organization_profiles (id, organization_id, brand_name, primary_phone, enabled_modules)
values (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'Pomoc Motoristom',
  '0850 005 006',
  array['calls', 'cases', 'maps', 'reports', 'sms', 'attendance']
);

-- Telephony and SMS run through Telnyx. The rows stay "not_configured" until the
-- server env carries TELNYX_API_KEY; the app derives the effective status from
-- the secret presence (see src/data/integration-status.ts).
insert into public.motorist_organization_integrations (
  organization_id,
  provider,
  enabled,
  status,
  enabled_features,
  base_url,
  secret_ref,
  config
)
values
  (
    '00000000-0000-4000-8000-000000000001',
    'telnyx',
    false,
    'not_configured',
    array['voice', 'recordings', 'click_to_call'],
    'https://api.telnyx.com/v2',
    'env:TELNYX_API_KEY',
    '{}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    'telnyx_sms',
    false,
    'not_configured',
    array['sms'],
    'https://api.telnyx.com/v2',
    'env:TELNYX_API_KEY',
    '{}'::jsonb
  );

insert into public.motorist_profiles (id, organization_id, display_name, role, phone_extension, active)
values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'Natália', 'dispatcher', null, true),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001', 'Mango', 'senior_dispatcher', null, true),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000001', 'Michal', 'manager', null, true),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000001', 'Lenka', 'dispatcher', null, true),
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000001', 'Peter', 'dispatcher', null, true);

insert into public.motorist_operator_statuses (organization_id, profile_id, status, source, started_at)
values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'on_call', 'seed', '2026-05-20T18:31:00+02:00'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', 'available', 'seed', '2026-05-20T18:20:00+02:00'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000103', 'after_call_work', 'seed', '2026-05-20T18:25:00+02:00'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000104', 'paused', 'seed', '2026-05-20T18:10:00+02:00'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000105', 'offline', 'seed', '2026-05-20T17:55:00+02:00');

-- Partner lines. Phone numbers are placeholders in E.164 form; replace them with
-- the canonical strings returned by Telnyx `GET /v2/phone_numbers` once the
-- numbers are assigned to the call-control application.
insert into public.motorist_telephony_lines (id, organization_id, provider, phone_number, label, active)
values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001', 'telnyx', '+421232408700', 'Neutrálna linka', true),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000001', 'telnyx', '+421232408718', 'Allianz Assistance', true),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000001', 'telnyx', '+421232408732', 'Autoklub Slovakia Assistance', true),
  ('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000001', 'telnyx', '+421232408760', 'AXA Assistance CZ', true),
  ('00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-000000000001', 'telnyx', '+421232408783', 'Eurocross Assistance CR', true);

insert into public.motorist_attendance_shift_templates (id, organization_id, label, kind, starts_at_local, ends_at_local, planned_minutes, color, sort_order, active)
values
  ('00000000-0000-4000-8000-000000001001', '00000000-0000-4000-8000-000000000001', '8h nočná', 'fixed_8h', '00:00', '08:00', 480, '#0f766e', 10, true),
  ('00000000-0000-4000-8000-000000001002', '00000000-0000-4000-8000-000000000001', '8h denná', 'fixed_8h', '08:00', '16:00', 480, '#2563eb', 20, true),
  ('00000000-0000-4000-8000-000000001003', '00000000-0000-4000-8000-000000000001', '8h večerná', 'fixed_8h', '16:00', '00:00', 480, '#7c3aed', 30, true),
  ('00000000-0000-4000-8000-000000001004', '00000000-0000-4000-8000-000000000001', '12h denná', 'fixed_12h', '08:00', '20:00', 720, '#ea580c', 40, true),
  ('00000000-0000-4000-8000-000000001005', '00000000-0000-4000-8000-000000000001', '12h nočná', 'fixed_12h', '20:00', '08:00', 720, '#334155', 50, true),
  ('00000000-0000-4000-8000-000000001006', '00000000-0000-4000-8000-000000000001', 'Custom výnimka', 'custom', null, null, null, '#71717a', 60, true);

insert into public.motorist_attendance_shifts (
  id,
  organization_id,
  profile_id,
  template_id,
  status,
  date_local,
  timezone,
  planned_start_at,
  planned_end_at,
  published_at,
  confirmed_at,
  notes
)
values
  ('00000000-0000-4000-8000-000000001101', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000001001', 'confirmed', '2026-05-27', 'Europe/Bratislava', '2026-05-27T00:00:00+02:00', '2026-05-27T08:00:00+02:00', '2026-05-26T09:00:00+02:00', '2026-05-26T17:20:00+02:00', null),
  ('00000000-0000-4000-8000-000000001102', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000001002', 'confirmed', '2026-05-27', 'Europe/Bratislava', '2026-05-27T08:00:00+02:00', '2026-05-27T16:00:00+02:00', '2026-05-26T09:00:00+02:00', '2026-05-26T16:45:00+02:00', null),
  ('00000000-0000-4000-8000-000000001103', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000001003', 'published', '2026-05-27', 'Europe/Bratislava', '2026-05-27T16:00:00+02:00', '2026-05-28T00:00:00+02:00', '2026-05-26T09:00:00+02:00', null, 'Čaká na potvrdenie operátorom.'),
  ('00000000-0000-4000-8000-000000001104', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000001001', 'confirmed', '2026-05-28', 'Europe/Bratislava', '2026-05-28T00:00:00+02:00', '2026-05-28T08:00:00+02:00', '2026-05-26T09:00:00+02:00', '2026-05-26T18:12:00+02:00', null),
  ('00000000-0000-4000-8000-000000001105', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000001004', 'published', '2026-05-28', 'Europe/Bratislava', '2026-05-28T08:00:00+02:00', '2026-05-28T20:00:00+02:00', '2026-05-26T09:00:00+02:00', null, null),
  ('00000000-0000-4000-8000-000000001106', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000001005', 'confirmed', '2026-05-28', 'Europe/Bratislava', '2026-05-28T20:00:00+02:00', '2026-05-29T08:00:00+02:00', '2026-05-27T08:00:00+02:00', '2026-05-27T10:10:00+02:00', null),
  ('00000000-0000-4000-8000-000000001107', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000001002', 'draft', '2026-05-29', 'Europe/Bratislava', '2026-05-29T08:00:00+02:00', '2026-05-29T16:00:00+02:00', null, null, 'Návrh čaká na publikovanie.'),
  ('00000000-0000-4000-8000-000000001108', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000001006', 'confirmed', '2026-05-30', 'Europe/Bratislava', '2026-05-30T10:00:00+02:00', '2026-05-30T18:00:00+02:00', '2026-05-27T08:00:00+02:00', '2026-05-27T12:00:00+02:00', 'Custom záskok pre školenie.');

insert into public.motorist_attendance_sessions (id, organization_id, profile_id, shift_id, status, source, started_at, ended_at, notes)
values
  ('00000000-0000-4000-8000-000000001201', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000001102', 'open', 'login', '2026-05-27T08:03:00+02:00', null, 'Automaticky pripravené pre budúci login flow.'),
  ('00000000-0000-4000-8000-000000001202', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000001101', 'closed', 'manual', '2026-05-27T00:01:00+02:00', '2026-05-27T08:02:00+02:00', null);

insert into public.motorist_attendance_employee_settings (id, organization_id, profile_id, default_available, vacation_days_per_year, max_weekly_minutes, notes)
values
  ('00000000-0000-4000-8000-000000001301', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', true, 20, 2400, null),
  ('00000000-0000-4000-8000-000000001302', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', true, 20, 2400, null),
  ('00000000-0000-4000-8000-000000001303', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000103', true, 25, 2400, null),
  ('00000000-0000-4000-8000-000000001304', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000104', true, 20, 2400, null),
  ('00000000-0000-4000-8000-000000001305', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000105', true, 20, 2400, 'Profil je dočasne neaktívny v plánovaní.');

insert into public.motorist_attendance_unavailability_requests (
  id,
  organization_id,
  profile_id,
  type,
  status,
  start_date_local,
  end_date_local,
  start_time_local,
  end_time_local,
  reason,
  decision_note,
  submitted_at,
  decided_at,
  decided_by,
  created_by
)
values
  ('00000000-0000-4000-8000-000000001401', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000104', 'vacation', 'approved', '2026-05-30', '2026-06-02', null, null, 'Rodinná dovolenka', 'Schválené pred plánovaním mesiaca.', '2026-05-20T09:10:00+02:00', '2026-05-21T10:30:00+02:00', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000104'),
  ('00000000-0000-4000-8000-000000001402', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', 'vacation', 'pending', '2026-05-29', '2026-05-29', null, null, 'Krátke voľno', null, '2026-05-25T14:22:00+02:00', null, null, '00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000001403', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'unavailable', 'approved', '2026-05-31', '2026-05-31', '08:00', '16:00', 'Školenie', 'Schválené ako nedostupnosť.', '2026-05-21T11:00:00+02:00', '2026-05-22T08:00:00+02:00', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000101');

insert into public.motorist_attendance_time_off_balances (id, organization_id, profile_id, year, vacation_days_total, vacation_days_used, vacation_days_pending, carried_over_days)
values
  ('00000000-0000-4000-8000-000000001501', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 2026, 20, 3, 0, 1),
  ('00000000-0000-4000-8000-000000001502', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', 2026, 20, 4, 1, 0),
  ('00000000-0000-4000-8000-000000001503', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000103', 2026, 25, 6, 0, 0),
  ('00000000-0000-4000-8000-000000001504', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000104', 2026, 20, 5, 0, 1),
  ('00000000-0000-4000-8000-000000001505', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000105', 2026, 20, 2, 0, 0);

insert into public.motorist_attendance_schedule_batches (id, organization_id, name, status, shift_mode, date_from_local, date_to_local, notes, created_by, published_at)
values
  ('00000000-0000-4000-8000-000000001601', '00000000-0000-4000-8000-000000000001', 'Demo plán 27.-30. máj', 'published', 'fixed_8h', '2026-05-27', '2026-05-30', 'Ukážkový plán z demo seed dát.', '00000000-0000-4000-8000-000000000103', '2026-05-26T09:15:00+02:00');

update public.motorist_attendance_shifts
set schedule_batch_id = '00000000-0000-4000-8000-000000001601',
    batch_created_order = case id
      when '00000000-0000-4000-8000-000000001101' then 1
      when '00000000-0000-4000-8000-000000001102' then 2
      when '00000000-0000-4000-8000-000000001103' then 3
      when '00000000-0000-4000-8000-000000001104' then 4
      when '00000000-0000-4000-8000-000000001105' then 5
      when '00000000-0000-4000-8000-000000001106' then 6
      when '00000000-0000-4000-8000-000000001107' then 7
      when '00000000-0000-4000-8000-000000001108' then 8
      else batch_created_order
    end
where organization_id = '00000000-0000-4000-8000-000000000001'
  and id in (
    '00000000-0000-4000-8000-000000001101',
    '00000000-0000-4000-8000-000000001102',
    '00000000-0000-4000-8000-000000001103',
    '00000000-0000-4000-8000-000000001104',
    '00000000-0000-4000-8000-000000001105',
    '00000000-0000-4000-8000-000000001106',
    '00000000-0000-4000-8000-000000001107',
    '00000000-0000-4000-8000-000000001108'
  );

insert into public.motorist_locations (id, organization_id, label, address, lat, lng, provider)
values
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000001', 'Žilina - Tolstého', 'Tolstého 1201/20, Žilina', 49.2233000, 18.7394000, 'seed'),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000001', 'Bratislava - západ', 'Lamačská cesta, Bratislava', 48.1713000, 17.0646000, 'seed'),
  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000001', 'Pickup - Vráble', 'Hlavná 12, Vráble', 48.2435000, 18.3086000, 'seed'),
  ('00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000001', 'Servis Žilina', 'Tolstého 1201/20, Žilina', 49.2233000, 18.7394000, 'seed');

insert into public.motorist_branches (id, organization_id, name, address, phone, location_id, available_replacement_cars, active)
values
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000001', 'Žilina - Tolstého', 'Tolstého 1201/20, Žilina', '0850 005 006', '00000000-0000-4000-8000-000000000301', 4, true),
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000001', 'Bratislava - západ', 'Lamačská cesta, Bratislava', '0910 541 622', '00000000-0000-4000-8000-000000000302', 2, true);

insert into public.motorist_fleet_assets (id, organization_id, kind, label, license_plate, status, branch_id, current_location_id, last_seen_at)
values ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000001', 'tow_truck', 'Odťah Žilina 01', 'ZA-842PM', 'available', '00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000301', '2026-05-20T18:24:00+02:00');

insert into public.motorist_contacts (id, organization_id, name, phone, role)
values ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000001', 'Peter Kováč', '+421 905 778 122', 'client');

insert into public.motorist_vehicles (id, organization_id, license_plate, make, model, category, is_driveable, notes)
values ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000001', 'ZA-382HL', 'Škoda', 'Fabia', 'osobné', false, 'Nehoda, blokované predné koleso');

insert into public.motorist_cases (
  id,
  organization_id,
  case_number,
  status,
  priority,
  source_type,
  case_type,
  owner_id,
  contact_id,
  vehicle_id,
  pickup_location_id,
  destination_location_id,
  summary,
  main_note
)
values (
  '00000000-0000-4000-8000-000000000801',
  '00000000-0000-4000-8000-000000000001',
  'PM-2026-0517',
  'triage',
  'urgent',
  'client',
  'Odťah + náhradné vozidlo',
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000601',
  '00000000-0000-4000-8000-000000000701',
  '00000000-0000-4000-8000-000000000303',
  '00000000-0000-4000-8000-000000000304',
  'Klient po nehode potrebuje odťah do partnerského servisu a náhradné vozidlo.',
  'Overiť, či je vozidlo mimo jazdného pruhu.'
);

insert into public.motorist_case_tasks (organization_id, case_id, title, assigned_to, due_at, status)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000801', 'Zavolať klientovi o 19:00', '00000000-0000-4000-8000-000000000101', '2026-05-20T19:00:00+02:00', 'open');

insert into public.motorist_case_events (organization_id, case_id, actor_profile_id, event_type, title, body, created_at)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000101', 'case_created', 'Prípad založený', 'Prichádzajúci hovor na linku pomoci.', '2026-05-20T18:29:00+02:00');

insert into public.motorist_calls (
  id,
  organization_id,
  provider,
  provider_session_id,
  direction,
  status,
  caller_number,
  caller_name,
  called_number,
  received_number,
  line_id,
  operator_id,
  case_id,
  started_at,
  answered_at,
  ended_at,
  wait_seconds,
  duration_seconds,
  raw_payload
)
values (
  '00000000-0000-4000-8000-000000000901',
  '00000000-0000-4000-8000-000000000001',
  'telnyx',
  'mock-telnyx-2026-0517',
  'inbound',
  'ended',
  '+421 905 778 122',
  'Peter Kováč',
  '+421232408700',
  '+421232408700',
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000801',
  '2026-05-20T18:31:00+02:00',
  '2026-05-20T18:31:42+02:00',
  '2026-05-20T18:38:10+02:00',
  42,
  388,
  '{"source":"seed"}'::jsonb
);

insert into public.motorist_call_events (organization_id, call_id, provider, provider_session_id, event_type, event_fingerprint, payload, provider_created_at)
values (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000901',
  'telnyx',
  'mock-telnyx-2026-0517',
  'call.initiated',
  'mock-telnyx-2026-0517-initiated',
  '{"line":"Neutrálna linka","to":"+421232408700"}'::jsonb,
  '2026-05-20T18:31:00+02:00'
);

insert into public.motorist_locations (id, organization_id, label, address, lat, lng, provider)
values
  ('00000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-000000000001', 'Pickup - Bratislava Lamač', 'Lamačská cesta, Bratislava', 48.1713000, 17.0646000, 'seed'),
  ('00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-000000000001', 'Servis Nitra', 'Cabajská, Nitra', 48.2797000, 18.0864000, 'seed');

insert into public.motorist_fleet_assets (id, organization_id, kind, label, license_plate, status, branch_id, current_location_id, last_seen_at)
values (
  '00000000-0000-4000-8000-000000000502',
  '00000000-0000-4000-8000-000000000001',
  'tow_truck',
  'Odťah Bratislava 02',
  'BA-204AV',
  'available',
  '00000000-0000-4000-8000-000000000402',
  '00000000-0000-4000-8000-000000000302',
  '2026-05-20T18:38:00+02:00'
);

insert into public.motorist_contacts (id, organization_id, name, phone, role)
values ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000001', 'Europe Assistance', '+421 232 111 222', 'assistance');

insert into public.motorist_vehicles (id, organization_id, license_plate, make, model, category, is_driveable, notes)
values (
  '00000000-0000-4000-8000-000000000702',
  '00000000-0000-4000-8000-000000000001',
  'BA-771XM',
  'BMW',
  'X3',
  'SUV',
  false,
  'Porucha prevodovky, podzemná garáž -2'
);

insert into public.motorist_cases (
  id,
  organization_id,
  case_number,
  status,
  priority,
  source_type,
  case_type,
  owner_id,
  contact_id,
  vehicle_id,
  pickup_location_id,
  destination_location_id,
  summary,
  main_note,
  created_at,
  updated_at
)
values (
  '00000000-0000-4000-8000-000000000802',
  '00000000-0000-4000-8000-000000000001',
  'PM-2026-0518',
  'assigned',
  'high',
  'assistance',
  'Asistenčný odťah',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000602',
  '00000000-0000-4000-8000-000000000702',
  '00000000-0000-4000-8000-000000000305',
  '00000000-0000-4000-8000-000000000306',
  'Asistenčka poslala objednávku, čaká sa potvrdenie techniky pre garáž.',
  'Garáž -2, overiť výšku a prístup. Možný problém s klasickou odťahovkou.',
  '2026-05-20T18:42:00+02:00',
  '2026-05-20T18:48:00+02:00'
);

insert into public.motorist_case_tasks (id, organization_id, case_id, title, assigned_to, due_at, status)
values (
  '00000000-0000-4000-8000-000000000822',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000802',
  'Overiť nízku plošinu pre garáž',
  '00000000-0000-4000-8000-000000000102',
  '2026-05-20T19:10:00+02:00',
  'open'
);

insert into public.motorist_case_events (id, organization_id, case_id, actor_profile_id, event_type, title, body, created_at)
values (
  '00000000-0000-4000-8000-000000000842',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000802',
  '00000000-0000-4000-8000-000000000102',
  'case_created',
  'Objednávka prijatá',
  'Prípad založený z asistenčnej objednávky.',
  '2026-05-20T18:42:00+02:00'
);
