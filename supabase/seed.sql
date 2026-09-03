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

-- Partner lines (Bratislava DIDs, normalised E.164). Telnyx stores the first
-- number as +4210232408700 (extra leading 0); inbound `to` is normalised before
-- the lookup. Routing columns are filled in the telephony section below.
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

-- ---------------------------------------------------------------------------
-- Telnyx telephony routing configuration (Phase 2). Media paths are relative
-- to TELNYX_MEDIA_BASE_URL (public/telephony/*.mp3).
-- ---------------------------------------------------------------------------

insert into public.motorist_telephony_settings (
  id,
  organization_id,
  live_calls_enabled,
  sms_live_sends,
  daily_leg_soft_cap,
  park_max_minutes,
  destination_allowlist
)
values (
  '00000000-0000-4000-8000-000000002601',
  '00000000-0000-4000-8000-000000000001',
  false,
  false,
  500,
  30,
  array['SK', 'CZ']::text[]
)
on conflict (organization_id) do nothing;

insert into public.motorist_business_hours (id, organization_id, name, timezone, active)
values ('00000000-0000-4000-8000-000000002001', '00000000-0000-4000-8000-000000000001', 'Pracovný čas', 'Europe/Bratislava', true)
on conflict (id) do nothing;

-- Mon-Fri 07:00-12:00 and 12:30-19:00 (ISO weekday 1 = Monday).
insert into public.motorist_business_hours_intervals (organization_id, business_hours_id, weekday, opens, closes)
select
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000002001',
  weekday,
  opens,
  closes
from (values (1), (2), (3), (4), (5)) as days(weekday)
cross join (values ('07:00'::time, '12:00'::time), ('12:30'::time, '19:00'::time)) as slots(opens, closes)
on conflict (business_hours_id, weekday, opens) do nothing;

insert into public.motorist_business_hours_exceptions (organization_id, business_hours_id, date, closed, label)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000002001', '2026-12-24', true, 'Štedrý deň')
on conflict (business_hours_id, date) do nothing;

insert into public.motorist_ring_groups (id, organization_id, name, description, active)
values
  ('00000000-0000-4000-8000-000000002201', '00000000-0000-4000-8000-000000000001', 'Dispečing A', 'Primárna skupina, zvoní všetkým naraz.', true),
  ('00000000-0000-4000-8000-000000002202', '00000000-0000-4000-8000-000000000001', 'Dispečing B', 'Záložná skupina, zvoní postupne, externé číslo posledné.', true)
on conflict (id) do nothing;

insert into public.motorist_ring_group_members (id, organization_id, ring_group_id, member_kind, profile_id, external_number, position, ring_secs)
values
  ('00000000-0000-4000-8000-000000002211', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000002201', 'operator', '00000000-0000-4000-8000-000000000101', null, 0, null),
  ('00000000-0000-4000-8000-000000002212', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000002201', 'operator', '00000000-0000-4000-8000-000000000102', null, 1, null),
  ('00000000-0000-4000-8000-000000002213', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000002201', 'operator', '00000000-0000-4000-8000-000000000105', null, 2, null),
  ('00000000-0000-4000-8000-000000002221', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000002202', 'operator', '00000000-0000-4000-8000-000000000104', null, 0, 15),
  ('00000000-0000-4000-8000-000000002222', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000002202', 'operator', '00000000-0000-4000-8000-000000000103', null, 1, 15),
  -- Placeholder external number (dispatcher mobile); replace before go-live.
  ('00000000-0000-4000-8000-000000002223', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000002202', 'external_number', null, '+421910988882', 2, 15)
on conflict (id) do nothing;

insert into public.motorist_ring_plans (id, organization_id, name, fallback_kind, fallback_number, active)
values ('00000000-0000-4000-8000-000000002301', '00000000-0000-4000-8000-000000000001', 'Denný', 'callback_prompt', null, true)
on conflict (id) do nothing;

insert into public.motorist_ring_plan_steps (id, organization_id, ring_plan_id, step_index, ring_group_id, timeout_secs, strategy)
values
  ('00000000-0000-4000-8000-000000002311', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000002301', 0, '00000000-0000-4000-8000-000000002201', 20, 'all'),
  ('00000000-0000-4000-8000-000000002312', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000002301', 1, '00000000-0000-4000-8000-000000002202', 15, 'ordered')
on conflict (id) do nothing;

insert into public.motorist_ivr_menus (id, organization_id, name, prompt_media_url, tts_text, invalid_media_url, timeout_secs, max_tries, active)
values (
  '00000000-0000-4000-8000-000000002401',
  '00000000-0000-4000-8000-000000000001',
  'Hlavné menu',
  'ivr-main.mp3',
  'Pre spojenie s dispečingom stlačte jednotku. Ak chcete, aby sme vám zavolali späť, stlačte dvojku.',
  'invalid-input.mp3',
  5,
  2,
  true
)
on conflict (id) do nothing;

insert into public.motorist_ivr_options (id, organization_id, ivr_menu_id, digit, action, target_ring_plan_id, target_number, label, prompt_media_url, tts_text)
values
  ('00000000-0000-4000-8000-000000002411', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000002401', '1', 'ring_plan', '00000000-0000-4000-8000-000000002301', null, 'Dispečing', null, null),
  ('00000000-0000-4000-8000-000000002412', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000002401', '2', 'callback', null, null, 'Spätné volanie', 'callback-offer.mp3', 'Zavoláme vám späť, hneď ako sa uvoľní operátor.')
on conflict (id) do nothing;

insert into public.motorist_pause_reasons (id, organization_id, code, label, max_minutes, sort_order, active)
values
  ('00000000-0000-4000-8000-000000002501', '00000000-0000-4000-8000-000000000001', 'obed', 'Obed', 45, 10, true),
  ('00000000-0000-4000-8000-000000002502', '00000000-0000-4000-8000-000000000001', 'porada', 'Porada', 90, 20, true),
  ('00000000-0000-4000-8000-000000002503', '00000000-0000-4000-8000-000000000001', 'admin', 'Administratíva', null, 30, true)
on conflict (id) do nothing;

-- Lines: every DID follows the "Denný" plan and the shared business hours; the
-- neutral line additionally offers the IVR. telnyx_number_id comes from
-- GET /v2/phone_numbers (only the first number's id is known at seed time).
update public.motorist_telephony_lines
set
  ring_plan_id = '00000000-0000-4000-8000-000000002301',
  business_hours_id = '00000000-0000-4000-8000-000000002001',
  ivr_menu_id = case id when '00000000-0000-4000-8000-000000000201' then '00000000-0000-4000-8000-000000002401'::uuid else ivr_menu_id end,
  telnyx_number_id = case id when '00000000-0000-4000-8000-000000000201' then '3040091148564563176' else telnyx_number_id end,
  partner_name = case id
    when '00000000-0000-4000-8000-000000000202' then 'Allianz Assistance'
    when '00000000-0000-4000-8000-000000000203' then 'Autoklub Slovakia Assistance'
    when '00000000-0000-4000-8000-000000000204' then 'AXA Assistance CZ'
    when '00000000-0000-4000-8000-000000000205' then 'Eurocross Assistance CR'
    else partner_name
  end
where organization_id = '00000000-0000-4000-8000-000000000001'
  and id in (
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    '00000000-0000-4000-8000-000000000203',
    '00000000-0000-4000-8000-000000000204',
    '00000000-0000-4000-8000-000000000205'
  );

insert into public.motorist_operator_presence (id, organization_id, profile_id, status, status_since)
values
  ('00000000-0000-4000-8000-000000002701', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'available', '2026-09-03T07:00:00+02:00'),
  ('00000000-0000-4000-8000-000000002702', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', 'available', '2026-09-03T07:00:00+02:00'),
  ('00000000-0000-4000-8000-000000002703', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000103', 'offline', '2026-09-03T07:00:00+02:00'),
  ('00000000-0000-4000-8000-000000002704', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000104', 'offline', '2026-09-03T07:00:00+02:00'),
  ('00000000-0000-4000-8000-000000002705', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000105', 'available', '2026-09-03T07:00:00+02:00')
on conflict (profile_id) do nothing;
