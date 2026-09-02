update public.motorist_organization_integrations
set
  base_url = 'https://smsapi.viptel.sk/api/',
  config = config || '{"public_endpoint_docs_available":true,"smoke_tests":["GET /identities/","GET /credits/"]}'::jsonb,
  updated_at = now()
where provider = 'viptel_sms'
  and (
    base_url is distinct from 'https://smsapi.viptel.sk/api/'
    or config->>'public_endpoint_docs_available' is distinct from 'true'
  );
