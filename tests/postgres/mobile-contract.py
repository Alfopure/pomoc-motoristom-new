"""Exact mobile migration over a minimal fixture with a legacy replace stub.
This verifies the added wrapper contract, not the full original config RPC.
"""
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

# Explicit hostaddr prevents inherited PGHOSTADDR from redirecting fixture writes.
LOOPBACK_DSN = "host=127.0.0.1 hostaddr=127.0.0.1 port=55432 user=postgres connect_timeout=5"

ROOT=Path(__file__).resolve().parents[2]
ORG="00000000-0000-4000-8000-000000000001"
OTHER="00000000-0000-4000-8000-000000000002"
OWNER="00000000-0000-4000-8000-000000000011"
FOREIGN="00000000-0000-4000-8000-000000000012"
MEMBER="00000000-0000-4000-8000-000000000021"
with psycopg.connect(f"{LOOPBACK_DSN} dbname=postgres",autocommit=True) as c:
    c.execute("drop database if exists mobile_contract with (force)")
    c.execute("create database mobile_contract")
with psycopg.connect(f"{LOOPBACK_DSN} dbname=mobile_contract",autocommit=True) as c:
    c.execute("""
      do $$ begin
        if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
      end $$;
      create table motorist_profiles(id uuid primary key,organization_id uuid);
      create table motorist_operator_telephony_settings(profile_id uuid,organization_id uuid,default_mobile_number text);
      create table motorist_ring_group_members(id uuid primary key,organization_id uuid,member_kind text,external_number text);
      create table motorist_ring_attempts(member_kind text,profile_id uuid,external_number text,
        constraint motorist_ring_attempts_check check (
          (member_kind='operator' and profile_id is not null and external_number is null) or
          (member_kind='external_number' and external_number is not null and profile_id is null)));
      create function motorist_replace_ring_plan(p_organization_id uuid,p_document jsonb,p_expected_version integer default null)
      returns jsonb language plpgsql security definer set search_path='' as $$
      begin
        if p_document ? 'groups' then
          delete from public.motorist_ring_group_members where organization_id=p_organization_id;
          insert into public.motorist_ring_group_members(id,organization_id,member_kind,external_number)
            select (m->>'id')::uuid,p_organization_id,m->>'member_kind',m->>'external_number'
              from jsonb_array_elements(p_document->'groups') g,
                lateral jsonb_array_elements(g->'members') m;
        end if;
        return jsonb_build_object('fixture','legacy replace stub');
      end $$;
    """)
    c.execute((ROOT/"supabase/migrations/20260928130000_personal_mobile_ownership.sql").read_text())
    c.execute("insert into motorist_profiles values(%s,%s),(%s,%s)",(OWNER,ORG,FOREIGN,OTHER))
    c.execute("insert into motorist_operator_telephony_settings(profile_id,organization_id,default_mobile_number) values(%s,%s,'+421900000001')",(OWNER,ORG))
    assert c.execute("select delivery_mode from motorist_operator_telephony_settings").fetchone()[0]=="web"
    print("PASS default web preserves old pause/mobile configuration without enabling availability")
    member={"id":MEMBER,"member_kind":"external_number","external_number":"+421900000001","owner_profile_id":OWNER}
    def replace(m):
        return c.execute("select motorist_replace_ring_plan(%s,%s,null)",(ORG,Jsonb({"groups":[{"members":[m]}]}))).fetchone()[0]
    c.execute("set role service_role")
    replace(member)
    c.execute("reset role")
    assert c.execute("select owner_profile_id::text from motorist_ring_group_members").fetchone()[0]==OWNER
    legacy={k:v for k,v in member.items() if k!="owner_profile_id"}
    replace(legacy)
    assert c.execute("select owner_profile_id::text from motorist_ring_group_members").fetchone()[0]==OWNER
    print("PASS explicit owner saved and old-client replace omission preserves it")
    try:
        replace({**member,"owner_profile_id":FOREIGN})
        raise AssertionError("cross-org owner accepted")
    except psycopg.errors.RaiseException: pass
    assert c.execute("select owner_profile_id::text from motorist_ring_group_members").fetchone()[0]==OWNER
    replace({**member,"owner_profile_id":None})
    assert c.execute("select owner_profile_id from motorist_ring_group_members").fetchone()[0] is None
    print("PASS cross-org owner rejected transactionally; explicit null clears owner")
    for role in ("anon","authenticated"):
        c.execute("set role "+role)
        try:
            replace(member)
            raise AssertionError("untrusted wrapper invocation")
        except psycopg.errors.InsufficientPrivilege: pass
        finally: c.execute("reset role")
    c.execute("set role service_role")
    try:
        c.execute("select motorist_replace_ring_plan_pre_mobile(%s,%s,null)",(ORG,Jsonb({})))
        raise AssertionError("service role bypassed wrapper")
    except psycopg.errors.InsufficientPrivilege: pass
    finally: c.execute("reset role")
    print("PASS wrapper restricted to service role; underlying bypass function revoked")
    c.execute("insert into motorist_ring_attempts values('external_number',%s,'+421900000001'),('operator',%s,null)",(OWNER,OWNER))
    try:
        c.execute("insert into motorist_ring_attempts values('operator',null,'+421900000001')")
        raise AssertionError("invalid operator attempt accepted")
    except psycopg.errors.CheckViolation: pass
    print("PASS owned PSTN attempt accepted and invalid operator shape rejected")
