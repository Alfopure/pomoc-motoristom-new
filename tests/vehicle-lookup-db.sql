-- Run explicitly against this copy after its migration. All generated data rolls back.
begin;
do $$
declare
  org_a uuid; org_b uuid; profile_a uuid; profile_b uuid;
  claim_a jsonb; claim_b jsonb; next_claim jsonb; key_a text := repeat('a',64);
  rejected boolean := false; i integer;
begin
  insert into public.motorist_organizations(slug,name) values('lookup-test-'||gen_random_uuid(),'Lookup transaction test') returning id into org_a;
  insert into public.motorist_organizations(slug,name) values('lookup-test-'||gen_random_uuid(),'Lookup isolation test') returning id into org_b;
  insert into public.motorist_profiles(organization_id,display_name,role) values(org_a,'Lookup test','dispatcher') returning id into profile_a;
  insert into public.motorist_profiles(organization_id,display_name,role) values(org_b,'Lookup test','dispatcher') returning id into profile_b;
  assert not has_function_privilege('authenticated','public.motorist_vehicle_lookup_claim(uuid,uuid,text)','EXECUTE');
  assert not has_table_privilege('anon','public.motorist_vehicle_lookup_cache','SELECT');
  claim_a := public.motorist_vehicle_lookup_claim(org_a,profile_a,key_a);
  assert claim_a->>'status'='reserved';
  assert public.motorist_vehicle_lookup_claim(org_a,profile_a,key_a)->>'status'='pending';
  claim_b := public.motorist_vehicle_lookup_claim(org_b,profile_b,key_a);
  assert claim_b->>'status'='reserved';
  assert claim_a->>'token' <> claim_b->>'token';
  begin
    perform public.motorist_vehicle_lookup_claim(org_b,profile_a,key_a);
  exception when raise_exception then rejected := true;
  end;
  assert rejected, 'cross_org_profile_must_fail';
  assert not public.motorist_vehicle_lookup_finish(org_a,gen_random_uuid(),key_a,'{}',true,false);
  assert public.motorist_vehicle_lookup_finish(org_a,(claim_a->>'token')::uuid,key_a,'{"marker":"test"}',true,false);
  assert public.motorist_vehicle_lookup_claim(org_a,profile_a,key_a)->>'status'='cached';
  -- Expired cache cannot be reused; an expired owner cannot finish someone else's lease.
  update public.motorist_vehicle_lookup_cache set valid_until=now()-interval '1 second' where organization_id=org_a;
  next_claim := public.motorist_vehicle_lookup_claim(org_a,profile_a,key_a);
  assert next_claim->>'status'='reserved';
  assert not public.motorist_vehicle_lookup_finish(org_a,(claim_a->>'token')::uuid,key_a,'{}',true,false);
  assert public.motorist_vehicle_lookup_finish(org_a,(next_claim->>'token')::uuid,key_a,null,false,true);
  -- Three technical SKP failures open its circuit without disabling STKonline.
  for i in 1..2 loop
    next_claim := public.motorist_vehicle_lookup_claim(org_a,profile_a,key_a);
    assert next_claim->>'status'='reserved';
    perform public.motorist_vehicle_lookup_finish(org_a,(next_claim->>'token')::uuid,key_a,null,false,true);
  end loop;
  next_claim := public.motorist_vehicle_lookup_claim(org_a,profile_a,key_a);
  assert next_claim->>'status'='reserved';
  assert (next_claim->'providers'->>'skp')::boolean=false;
  assert (next_claim->'providers'->>'stkonline')::boolean=true;
  perform public.motorist_vehicle_lookup_finish(org_a,(next_claim->>'token')::uuid,key_a,null,false,null);
  assert public.motorist_vehicle_lookup_claim(org_a,profile_a,key_a)->>'status'='rate_limited';
  update public.motorist_vehicle_lookup_controls set minute_window=now()-interval '2 minutes' where organization_id=org_a;
  assert public.motorist_vehicle_lookup_claim(org_a,profile_a,key_a)->>'status'='reserved';
end;
$$;
rollback;
select 'vehicle lookup DB isolation, lease, cache, circuit and rate-limit assertions passed; test rows rolled back' as result;
