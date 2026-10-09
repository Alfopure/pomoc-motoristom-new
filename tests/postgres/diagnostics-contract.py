"""Exact diagnostics migration against disposable LOCAL PostgreSQL. No app credentials.
Three OS processes exercise competing admission and idempotency; fixture facts are synthetic.
python3 tests/postgres/diagnostics-contract.py
"""
import json
import multiprocessing
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from uuid import UUID, uuid4
import psycopg
from psycopg.types.json import Jsonb

ROOT=Path(__file__).resolve().parents[2]
LOCAL=dict(host='127.0.0.1',hostaddr='127.0.0.1',port=55432,user='postgres',password='local-fixture-only',passfile='/dev/null',connect_timeout=3)
DB='diagnostics_contract'
ORG,OTHER,PROFILE,MANAGER,FOREIGN,CASE,CALL,DEVICE=(str(UUID(int=n)) for n in range(1,9))
FIXTURE='''
create table motorist_organizations(id uuid primary key);
create table motorist_profiles(id uuid primary key,organization_id uuid,active boolean default true,role text);
create table motorist_cases(id uuid primary key,organization_id uuid);
create table motorist_call_sessions(id uuid primary key,organization_id uuid,answered_by_profile_id uuid,state text,customer_leg_id uuid,direction text,started_at timestamptz,answered_at timestamptz,ended_at timestamptz,termination_requested_at timestamptz,parked_at timestamptz,hold_started_at timestamptz,telnyx_session_id text,metadata jsonb default '{"environment":"development"}');
create table motorist_call_legs(id uuid primary key,organization_id uuid,session_id uuid,profile_id uuid,role text,initiated_at timestamptz,answered_at timestamptz,bridged_at timestamptz,ended_at timestamptz,updated_at timestamptz default now());
create table motorist_call_events(id uuid primary key default gen_random_uuid(),organization_id uuid,provider text,provider_session_id text,event_type text,provider_timestamp timestamptz,received_at timestamptz default now(),payload jsonb,normalized_payload jsonb,handled_status text);
create index call_events_session_idx on motorist_call_events(organization_id,provider,provider_session_id,received_at desc) where provider_session_id is not null;
create index call_legs_session_idx on motorist_call_legs(organization_id,session_id);
create table motorist_operator_devices(id uuid primary key,organization_id uuid,profile_id uuid,device_session_id text,environment text);
'''
def connect():return psycopg.connect(dbname=DB,**LOCAL,autocommit=True)
def event(**extra):
    e=dict(id=str(uuid4()),pageId=str(uuid4()),sequence=0,occurredAt=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),monotonicMs=0,type='operation',module='cases',outcome='ok',operation='case.save',durationMs=12,buildId='fixture',sampled=True,sampleRate=.05)
    e.update(extra);return e

def ingest(c,events,profile=PROFILE,source='browser'):
    return c.execute('select motorist_diagnostics_ingest(%s,%s,%s,%s,%s,%s)',(ORG,profile,'test',source,'fixture',Jsonb(events))).fetchone()[0]

def worker(args):
    evs,profile,*source=args
    with connect() as c:
        c.execute('set role service_role')
        return ingest(c,evs,profile,source[0] if source else 'browser')

class Contracts(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
    with psycopg.connect(dbname='postgres',**LOCAL,autocommit=True) as c:
      for role in ('anon','authenticated','service_role'):
        if not c.execute('select 1 from pg_roles where rolname=%s',(role,)).fetchone():c.execute('create role '+role)
      c.execute('alter role service_role bypassrls')
      c.execute('drop database if exists '+DB+' with (force)');c.execute('create database '+DB)
    with connect() as c:
      # Hosted Supabase supplies these defaults before our migration runs.
      c.execute('alter default privileges in schema public grant all on tables to service_role')
      c.execute(FIXTURE)
      c.execute((ROOT/'supabase/migrations/20261008130000_operations_diagnostics.sql').read_text())
      c.execute((ROOT/'supabase/migrations/20261008130100_diagnostics_device_session_text.sql').read_text())
      cls.hosted_default_write_grants=all(c.execute('select has_table_privilege(%s,%s,%s)',('service_role','public.'+table,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')).fetchone()[0] for table in ('motorist_diagnostic_guard','motorist_diagnostic_counters','motorist_diagnostic_events','motorist_diagnostic_incidents'))
      c.execute((ROOT/'supabase/migrations/20261008130200_diagnostics_service_table_privileges.sql').read_text())
      c.execute((ROOT/'supabase/migrations/20261011120000_diagnostics_call_environment_guard.sql').read_text())
      c.execute('insert into motorist_organizations values(%s),(%s)',(ORG,OTHER))
      c.execute("insert into motorist_profiles values(%s,%s,true,'dispatcher'),(%s,%s,true,'manager'),(%s,%s,true,'dispatcher')",(PROFILE,ORG,MANAGER,ORG,FOREIGN,OTHER))
      c.execute('insert into motorist_cases values(%s,%s)',(CASE,ORG))
      c.execute("insert into motorist_call_sessions(id,organization_id,answered_by_profile_id,state,customer_leg_id,direction,started_at,answered_at,ended_at) values(%s,%s,%s,'talking',null,'inbound',now()-interval '1 hour',now()-interval '59 minutes',null)",(CALL,ORG,PROFILE))
      c.execute("insert into motorist_operator_devices values(gen_random_uuid(),%s,%s,%s,'development')",(ORG,PROFILE,DEVICE))
 @classmethod
 def tearDownClass(cls):
    pass # Preserve evidence for EXPLAIN inspection until the next test run.
 def setUp(self):
    self.c=connect();self.c.execute('truncate motorist_diagnostic_events,motorist_diagnostic_incidents,motorist_diagnostic_counters,motorist_call_events')
    self.c.execute("update motorist_call_sessions set metadata='{\"environment\":\"development\"}',termination_requested_at=null,parked_at=null,hold_started_at=null")
    self.c.execute("update motorist_diagnostic_guard set budget_bytes=134217728,physical_bytes=0,checked_at=now(),blocked=false")
 def tearDown(self):self.c.close()
 def test_hosted_defaults_are_removed_but_service_rpcs_still_write(self):
    self.assertTrue(self.hosted_default_write_grants)
    tables=('motorist_diagnostic_guard','motorist_diagnostic_counters','motorist_diagnostic_events','motorist_diagnostic_incidents')
    for table in tables:
      self.assertTrue(self.c.execute('select has_table_privilege(%s,%s,%s)',('service_role','public.'+table,'SELECT')).fetchone()[0])
      self.assertFalse(self.c.execute('select has_table_privilege(%s,%s,%s)',('service_role','public.'+table,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')).fetchone()[0])
      if int(self.c.execute('show server_version_num').fetchone()[0])>=170000:
        self.assertFalse(self.c.execute('select has_table_privilege(%s,%s,%s)',('service_role','public.'+table,'MAINTAIN')).fetchone()[0])
      for role in ('anon','authenticated'):
        self.assertFalse(self.c.execute('select has_table_privilege(%s,%s,%s)',(role,'public.'+table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')).fetchone()[0])
    rpcs=self.c.execute("select p.oid,p.prosecdef,r.rolname from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.proname in ('motorist_diagnostics_ingest','motorist_diagnostics_read','motorist_diagnostics_maintain')").fetchall()
    self.assertEqual(len(rpcs),3)
    for oid,security_definer,owner in rpcs:
      self.assertTrue(security_definer);self.assertEqual(owner,'postgres')
      self.assertTrue(self.c.execute('select has_function_privilege(%s,%s,%s)',('service_role',oid,'EXECUTE')).fetchone()[0])
      for role in ('anon','authenticated'):
        self.assertFalse(self.c.execute('select has_function_privilege(%s,%s,%s)',(role,oid,'EXECUTE')).fetchone()[0])
    self.c.execute('set role service_role')
    try:
      for table in tables:
        self.c.execute('select * from public.'+table+' limit 1')
        for statement in ('insert into public.'+table+' select * from public.'+table+' where false','delete from public.'+table+' where false','truncate public.'+table):
          with self.assertRaises(psycopg.errors.InsufficientPrivilege):self.c.execute(statement)
      value=event(type='ui_error',outcome='failed')
      self.assertEqual(ingest(self.c,[value])['acceptedIds'],[value['id']])
      maintained=self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,false)",(ORG,)).fetchone()[0]
      self.assertFalse(maintained['blocked'])
      overview=self.c.execute("select motorist_diagnostics_read(%s,%s,'test','overview')",(ORG,MANAGER)).fetchone()[0]
      incident=overview['incidents'][0]['id']
      updated=self.c.execute("select motorist_diagnostics_read(%s,%s,'test','status',p_id=>%s,p_status=>'resolved')",(ORG,MANAGER,incident)).fetchone()[0]
      self.assertEqual(updated['incident']['status'],'resolved')
      self.assertEqual(self.c.execute('select count(*) from motorist_diagnostic_events where id=%s',(value['id'],)).fetchone()[0],1)
    finally:self.c.execute('reset role')
 def test_actor_isolation_and_history(self):
    own=event(deviceSessionId=DEVICE,callSessionId=CALL,caseId=CASE)
    self.assertEqual(ingest(self.c,[own])['acceptedIds'],[own['id']])
    self.c.execute('update motorist_operator_devices set device_session_id=gen_random_uuid()')
    late=event(deviceSessionId=DEVICE);ingest(self.c,[late])
    self.assertEqual(self.c.execute('select device_session_id::text from motorist_diagnostic_events where id=%s',(late['id'],)).fetchone()[0],DEVICE)
    unknown=event(deviceSessionId=str(uuid4()));ingest(self.c,[unknown])
    self.assertIsNone(self.c.execute('select device_session_id from motorist_diagnostic_events where id=%s',(unknown['id'],)).fetchone()[0])
    foreign_case=event(caseId=str(uuid4()));self.assertEqual(ingest(self.c,[foreign_case])['rejectedIds'],[foreign_case['id']])
    with self.assertRaises(psycopg.Error):ingest(self.c,[event()],FOREIGN)
    with self.assertRaises(psycopg.Error):self.c.execute("select motorist_diagnostics_read(%s,%s,'test','overview')",(ORG,PROFILE))
    for role in ('anon','authenticated'):
      self.c.execute('set role '+role)
      with self.assertRaises(psycopg.Error):self.c.execute('select * from motorist_diagnostic_events')
      with self.assertRaises(psycopg.Error):ingest(self.c,[event()])
      self.c.execute('reset role')
 def test_three_process_dedupe_and_profile_rate(self):
    remaining=60-time.time()%60
    if remaining<3:time.sleep(remaining+.02)
    same=event()
    with multiprocessing.get_context('spawn').Pool(3) as pool:
      results=pool.map(worker,[([same],PROFILE)]*3)
      self.assertTrue(all(x['acceptedIds']==[same['id']] for x in results))
      results+=pool.map(worker,[([event()],PROFILE) for _ in range(27)])
    self.assertEqual(sum(bool(x.get('rateLimited')) for x in results),10)
    self.assertEqual(self.c.execute('select count(*) from motorist_diagnostic_events').fetchone()[0],18)
 def test_three_process_org_rate_and_daily_limit(self):
    # Admission is intentionally minute-windowed; do not straddle a real boundary.
    remaining=60-time.time()%60
    if remaining<3:time.sleep(remaining+.02)
    profiles=[]
    for n in range(30):
      p=str(UUID(int=100+n));profiles.append(p)
      self.c.execute("insert into motorist_profiles values(%s,%s,true,'dispatcher') on conflict do nothing",(p,ORG))
    ingest(self.c,[event()]);self.c.execute("update motorist_diagnostic_counters set batches=298 where key='org'")
    with multiprocessing.get_context('spawn').Pool(3) as pool:res=pool.map(worker,[([event()],p) for p in profiles])
    self.assertEqual(sum(bool(x.get('rateLimited')) for x in res),28)
    self.c.execute("update motorist_diagnostic_counters set batches=0,daily_normal=14999,daily_events=19999 where key='org'")
    with multiprocessing.get_context('spawn').Pool(3) as pool:res=pool.map(worker,[([event()],p) for p in profiles[:3]])
    self.assertEqual(sum(len(x['acceptedIds']) for x in res),1)
 def test_quotas_reserves_and_fully_exhausted(self):
    ingest(self.c,[event()]);self.c.execute("update motorist_diagnostic_counters set event_count=28672 where key='org'")
    critical=event(type='ui_error',outcome='failed')
    r=ingest(self.c,[critical]);self.assertTrue(r['degraded']);self.assertEqual(r['acceptedIds'],[])
    self.assertEqual(self.c.execute('select count(*) from motorist_diagnostic_incidents').fetchone()[0],1)
    self.c.execute("update motorist_diagnostic_counters set incident_count=1536,counter_count=4096 where key='org'")
    before=self.c.execute('select count(*) from motorist_diagnostic_incidents').fetchone()[0]
    ingest(self.c,[event(type='user_report',outcome='unknown')])
    self.assertEqual(self.c.execute('select count(*) from motorist_diagnostic_incidents').fetchone()[0],before)
 def test_physical_guard_cleanup_and_backlog(self):
    ingest(self.c,[event()]);self.c.execute("update motorist_diagnostic_events set received_at=now()-interval '15 days'")
    self.c.execute("insert into motorist_diagnostic_events select gen_random_uuid(),organization_id,environment,profile_id,source,received_at,server_build,call_session_id,case_id,device_session_id,event from motorist_diagnostic_events cross join generate_series(1,1000)")
    self.c.execute("update motorist_diagnostic_counters set event_count=1001 where key='org'")
    result=self.c.execute("select motorist_diagnostics_maintain(%s,'test',1,false)",(ORG,)).fetchone()[0]
    self.assertTrue(result['blocked']);self.assertEqual(result['deletedEvents'],800);self.assertTrue(result['cleanupBacklog'])
    self.assertTrue(ingest(self.c,[event()])['unavailable'])
 def test_call_grace_simultaneous_end_and_late_intent(self):
    operator,customer=str(uuid4()),str(uuid4())
    self.c.execute('delete from motorist_call_legs')
    self.c.execute("insert into motorist_call_legs(id,organization_id,session_id,profile_id,role,initiated_at,answered_at,bridged_at,ended_at) values(%s,%s,%s,%s,'operator',now()-interval '5 minutes',now()-interval '4 minutes',now()-interval '4 minutes',now()-interval '20 seconds'),(%s,%s,%s,null,'customer',now()-interval '5 minutes',now()-interval '4 minutes',now()-interval '4 minutes',null)",(operator,ORG,CALL,PROFILE,customer,ORG,CALL))
    self.c.execute("update motorist_call_sessions set customer_leg_id=%s,state='talking' where id=%s",(customer,CALL))
    self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,true)",(ORG,))
    self.assertEqual(self.c.execute('select classification from motorist_diagnostic_incidents').fetchone()[0],'interruption_observed')
    ended=self.c.execute('select ended_at from motorist_call_legs where id=%s',(operator,)).fetchone()[0]
    self.c.execute("insert into motorist_call_legs(id,organization_id,session_id,role,initiated_at,answered_at,ended_at) values(gen_random_uuid(),%s,%s,'supervisor',now()-interval '2 minutes',now()-interval '1 minute',%s-interval '20 seconds')",(ORG,CALL,ended))
    self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,true)",(ORG,))
    self.assertEqual(self.c.execute('select classification from motorist_diagnostic_incidents').fetchone()[0],'interruption_observed')
    ingest(self.c,[event(callSessionId=CALL,type='phone_lifecycle',reason='hangup_requested',occurredAt='2026-02-30T00:00:00.000Z')])
    supervisor_event=event(callSessionId=CALL,type='phone_lifecycle',reason='hangup_requested',occurredAt=ended.isoformat(timespec='milliseconds').replace('+00:00','Z'))
    ingest(self.c,[supervisor_event],MANAGER)
    self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,true)",(ORG,))
    self.assertEqual(self.c.execute('select classification from motorist_diagnostic_incidents').fetchone()[0],'interruption_observed')
    self.c.execute('update motorist_call_sessions set termination_requested_at=%s where id=%s',(ended,CALL))
    self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,true)",(ORG,))
    self.assertEqual(self.c.execute('select classification,status from motorist_diagnostic_incidents').fetchone(),('expected_end','resolved'))
    self.c.execute('update motorist_call_sessions set termination_requested_at=null where id=%s',(CALL,))
    # Later customer/operator end evidence still permits correction after prior classification.

    ingest(self.c,[event(callSessionId=CALL,type='phone_lifecycle',reason='hangup_requested',occurredAt=ended.isoformat(timespec='milliseconds').replace('+00:00','Z'))])
    self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,true)",(ORG,))
    self.assertEqual(self.c.execute('select classification from motorist_diagnostic_incidents').fetchone()[0],'expected_end')
    self.c.execute('truncate motorist_diagnostic_events')
    self.c.execute('update motorist_call_legs set ended_at=%s where id=%s',(ended,customer))
    self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,true)",(ORG,))
    self.assertEqual(self.c.execute('select classification from motorist_diagnostic_incidents').fetchone()[0],'expected_end')
 def test_fifteen_hundred_normal_calls_do_not_consume_incident_reserve(self):
    self.c.execute('delete from motorist_call_legs')
    for n in range(1501):
      session,operator,customer=str(uuid4()),str(uuid4()),str(uuid4())
      self.c.execute("insert into motorist_call_sessions(id,organization_id,answered_by_profile_id,state,customer_leg_id,direction,started_at,answered_at,ended_at) values(%s,%s,%s,'ended',%s,'inbound',now()-interval '5 minutes',now()-interval '4 minutes',now()-interval '20 seconds')",(session,ORG,PROFILE,customer))
      self.c.execute("insert into motorist_call_legs(id,organization_id,session_id,profile_id,role,initiated_at,answered_at,bridged_at,ended_at) values(%s,%s,%s,%s,'operator',now()-interval '5 minutes',now()-interval '4 minutes',now()-interval '4 minutes',now()-interval '20 seconds'),(%s,%s,%s,null,'customer',now()-interval '5 minutes',now()-interval '4 minutes',now()-interval '4 minutes',case when %s then null else now()-interval '20 seconds' end)",(operator,ORG,session,PROFILE,customer,ORG,session,n==1500))
    for _ in range(7):
      result=self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,true)",(ORG,)).fetchone()[0]
      self.assertLessEqual(result['candidates'],500)
    self.assertEqual(self.c.execute('select count(*) from motorist_diagnostic_incidents').fetchone()[0],1)
    self.assertEqual(self.c.execute('select classification from motorist_diagnostic_incidents').fetchone()[0],'interruption_observed')
    self.assertEqual(self.c.execute("select incident_count,dropped from motorist_diagnostic_counters where key='org'").fetchone(),(1,0))
    self.c.execute('delete from motorist_call_legs');self.c.execute('delete from motorist_call_sessions where id<>%s',(CALL,))
 def test_classifier_requires_explicit_same_environment_and_rechecks_foreign_incidents(self):
    operator,customer=str(uuid4()),str(uuid4())
    self.c.execute('delete from motorist_call_legs')
    self.c.execute("insert into motorist_call_legs(id,organization_id,session_id,profile_id,role,answered_at,bridged_at,ended_at) values(%s,%s,%s,%s,'operator',now()-interval '20 minutes',now()-interval '20 minutes',now()-interval '10 minutes'),(%s,%s,%s,null,'customer',now()-interval '20 minutes',now()-interval '20 minutes',null)",(operator,ORG,CALL,PROFILE,customer,ORG,CALL))
    self.c.execute("update motorist_call_sessions set customer_leg_id=%s,metadata='{}' where id=%s",(customer,CALL))
    for metadata in ({},{'environment':'production'},{'environment':'test'}):
      self.c.execute('update motorist_call_sessions set metadata=%s where id=%s',(Jsonb(metadata),CALL))
      self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,true)",(ORG,))
      self.assertEqual(self.c.execute('select count(*) from motorist_diagnostic_incidents').fetchone()[0],0)
      self.assertEqual(self.c.execute("select motorist_diagnostic_classify_leg(%s,'test',%s,now())",(ORG,operator)).fetchone()[0],'unknown')
    self.c.execute('update motorist_call_sessions set metadata=%s where id=%s',(Jsonb({'environment':'development'}),CALL))
    self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,true)",(ORG,))
    self.assertEqual(self.c.execute('select classification from motorist_diagnostic_incidents').fetchone()[0],'interruption_observed')
    self.assertEqual(self.c.execute("select motorist_diagnostic_classify_leg(%s,'production',%s,now())",(ORG,operator)).fetchone()[0],'unknown')
    self.c.execute('update motorist_call_sessions set metadata=%s where id=%s',(Jsonb({'environment':'production'}),CALL))
    self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,true)",(ORG,))
    self.assertEqual(self.c.execute('select classification from motorist_diagnostic_incidents').fetchone()[0],'unknown')
    self.assertEqual(self.c.execute("select motorist_diagnostic_classify_leg(%s,'production',%s,now())",(ORG,operator)).fetchone()[0],'interruption_observed')
 def test_hold_park_transfer_and_hangup_are_expected_not_interruptions(self):
    operator,customer=str(uuid4()),str(uuid4())
    self.c.execute('delete from motorist_call_legs')
    self.c.execute("insert into motorist_call_legs(id,organization_id,session_id,profile_id,role,answered_at,bridged_at,ended_at) values(%s,%s,%s,%s,'operator',now()-interval '20 minutes',now()-interval '20 minutes',now()-interval '10 minutes'),(%s,%s,%s,null,'customer',now()-interval '20 minutes',now()-interval '20 minutes',null)",(operator,ORG,CALL,PROFILE,customer,ORG,CALL))
    self.c.execute('update motorist_call_sessions set customer_leg_id=%s where id=%s',(customer,CALL))
    ended=self.c.execute('select ended_at from motorist_call_legs where id=%s',(operator,)).fetchone()[0]
    for field in ('hold_started_at','parked_at','termination_requested_at'):
      self.c.execute('update motorist_call_sessions set '+field+'=%s where id=%s',(ended,CALL))
      self.assertEqual(self.c.execute("select motorist_diagnostic_classify_leg(%s,'test',%s,now())",(ORG,operator)).fetchone()[0],'expected_end')
      self.c.execute('update motorist_call_sessions set '+field+'=null where id=%s',(CALL,))
    for metadata in ({'hangup':{'at':ended.isoformat()}},{'transfer':{'by':PROFILE,'completed_at':ended.isoformat()}},{'park':{'by':PROFILE,'at':ended.isoformat()}},{'transfer':{'kind':'blind','by':PROFILE,'at':ended.isoformat(),'completed_at':(ended+timedelta(seconds=40)).isoformat()}}):
      self.c.execute('update motorist_call_sessions set metadata=%s where id=%s',(Jsonb({'environment':'development',**metadata}),CALL))
      self.assertEqual(self.c.execute("select motorist_diagnostic_classify_leg(%s,'test',%s,now())",(ORG,operator)).fetchone()[0],'expected_end')
    self.c.execute('update motorist_call_sessions set metadata=%s where id=%s',(Jsonb({'environment':'development','transfer':{'by':MANAGER,'completed_at':ended.isoformat()}}),CALL))
    self.assertEqual(self.c.execute("select motorist_diagnostic_classify_leg(%s,'test',%s,now())",(ORG,operator)).fetchone()[0],'interruption_observed')
 def test_expected_leave_requires_processed_same_actor_command_and_existing_sibling(self):
    operator,customer,sibling=str(uuid4()),str(uuid4()),str(uuid4())
    self.c.execute('delete from motorist_call_legs')
    self.c.execute("insert into motorist_call_legs(id,organization_id,session_id,profile_id,role,answered_at,bridged_at,ended_at) values(%s,%s,%s,%s,'operator',now()-interval '20 minutes',now()-interval '20 minutes',now()-interval '10 minutes'),(%s,%s,%s,null,'customer',now()-interval '20 minutes',now()-interval '20 minutes',null)",(operator,ORG,CALL,PROFILE,customer,ORG,CALL))
    self.c.execute("update motorist_call_sessions set customer_leg_id=%s,telnyx_session_id='provider-session' where id=%s",(customer,CALL))
    ended=self.c.execute('select ended_at from motorist_call_legs where id=%s',(operator,)).fetchone()[0]
    def classification():return self.c.execute("select motorist_diagnostic_classify_leg(%s,'test',%s,now())",(ORG,operator)).fetchone()[0]
    self.assertEqual(classification(),'interruption_observed')
    valid={'session_id':CALL,'error':None,'commands':[{'kind':'conference_leave','ok':True}]}
    self.c.execute("insert into motorist_call_events(organization_id,provider,provider_session_id,event_type,provider_timestamp,payload,normalized_payload,handled_status) values(%s,'telnyx','provider-session','app.leave_conference',%s,%s,%s,'processed')",(ORG,ended,Jsonb({'actor':PROFILE}),Jsonb(valid)))
    self.assertEqual(classification(),'expected_end')
    for payload,normalized,status in [({'actor':MANAGER},valid,'processed'),({'actor':PROFILE},{**valid,'commands':[{'kind':'conference_leave','ok':False}]},'processed'),({'actor':PROFILE},{**valid,'commands':[{'kind':'conference_leave','ok':True,'skipped':True}]},'processed'),({'actor':PROFILE},valid,'failed'),({'actor':PROFILE},{**valid,'session_id':OTHER},'processed')]:
      self.c.execute('update motorist_call_events set payload=%s,normalized_payload=%s,handled_status=%s',(Jsonb(payload),Jsonb(normalized),status))
      self.assertEqual(classification(),'interruption_observed')
    self.c.execute('truncate motorist_call_events')
    self.c.execute("insert into motorist_call_legs(id,organization_id,session_id,profile_id,role,bridged_at) values(%s,%s,%s,%s,'operator',%s)",(sibling,ORG,CALL,PROFILE,ended-timedelta(seconds=1)))
    self.assertEqual(classification(),'expected_end')
    self.c.execute('update motorist_call_legs set bridged_at=%s where id=%s',(ended+timedelta(seconds=1),sibling))
    self.assertEqual(classification(),'interruption_observed')
    self.c.execute('update motorist_call_legs set bridged_at=%s,profile_id=%s where id=%s',(ended-timedelta(seconds=1),MANAGER,sibling))
    self.assertEqual(classification(),'interruption_observed')
    self.c.execute('delete from motorist_call_legs')
 def test_foreign_rows_cannot_fill_new_candidate_budget(self):
    self.c.execute('delete from motorist_call_legs')
    for n in range(251):
      session,operator,customer=str(uuid4()),str(uuid4()),str(uuid4())
      self.c.execute("insert into motorist_call_sessions(id,organization_id,customer_leg_id,direction,metadata) values(%s,%s,%s,'inbound',%s)",(session,ORG,customer,Jsonb({'environment':'development' if n==250 else 'production'})))
      self.c.execute("insert into motorist_call_legs(id,organization_id,session_id,profile_id,role,answered_at,bridged_at,ended_at,updated_at) values(%s,%s,%s,%s,'operator',now()-interval '20 minutes',now()-interval '20 minutes',now()-interval '10 minutes',now()+(%s * interval '1 millisecond')),(%s,%s,%s,null,'customer',now()-interval '20 minutes',now()-interval '20 minutes',null,now())",(operator,ORG,session,PROFILE,n,customer,ORG,session))
    result=self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,true)",(ORG,)).fetchone()[0]
    self.assertEqual(result['candidates'],2) # one admitted + one late-evidence recheck
    self.assertEqual(self.c.execute('select count(*) from motorist_diagnostic_incidents').fetchone()[0],1)
    self.c.execute('delete from motorist_call_legs');self.c.execute('delete from motorist_call_sessions where id<>%s',(CALL,))
 def test_sources_share_storage_reserve_and_daily_quota(self):
    ingest(self.c,[event()])
    self.c.execute("update motorist_diagnostic_counters set daily_events=19999 where key='org'")
    with multiprocessing.get_context('spawn').Pool(3) as pool:
      result=pool.map(worker,[([event(type='ui_error',outcome='failed')],PROFILE,source) for source in ['browser','server','server']])
    self.assertEqual(sum(len(r['acceptedIds']) for r in result),1)
    self.assertEqual(self.c.execute("select daily_events from motorist_diagnostic_counters where key='org'").fetchone()[0],20000)
 def test_incident_evidence_bound_and_retention(self):
    for _ in range(2):ingest(self.c,[event(type='ui_error',outcome='failed') for _ in range(16)])
    row=self.c.execute('select count,cardinality(evidence_ids) from motorist_diagnostic_incidents').fetchone()
    self.assertEqual(row,(32,20))
    self.c.execute("update motorist_diagnostic_incidents set last_seen_at=now()-interval '91 days'")
    self.c.execute("update motorist_diagnostic_counters set updated_at=now()-interval '2 days' where key<>'org'")
    result=self.c.execute("select motorist_diagnostics_maintain(%s,'test',134217728,false)",(ORG,)).fetchone()[0]
    self.assertEqual(result['deletedIncidents'],1);self.assertEqual(result['deletedCounters'],1)
    self.assertEqual(self.c.execute('select count(*) from motorist_diagnostic_events').fetchone()[0],32)
 def test_read_query_can_use_scoped_indexes(self):
    ev=event(callSessionId=CALL);ingest(self.c,[ev])
    self.c.execute("insert into motorist_diagnostic_events select gen_random_uuid(),organization_id,environment,profile_id,source,now()-random()*interval '7 days',server_build,call_session_id,case_id,device_session_id,event from motorist_diagnostic_events cross join generate_series(1,20000)")
    self.c.execute('analyze motorist_diagnostic_events')
    for query,args in [("select * from motorist_diagnostic_events where organization_id=%s and environment='test' and received_at>now()-interval '7 days' order by received_at desc,id desc limit 100",(ORG,)),("select * from motorist_diagnostic_events where organization_id=%s and environment='test' and call_session_id=%s and received_at>now()-interval '7 days' order by received_at desc,id desc limit 100",(ORG,CALL))]:
      plan=json.dumps(self.c.execute('explain (format json,analyze,buffers) '+query,args).fetchone()[0])
      self.assertIn('Index Scan',plan);self.assertNotIn('Seq Scan',plan)
 def test_postgrest_hoists_exact_ingest_statement_timeout(self):
    binary=os.environ.get('POSTGREST_BIN') or shutil.which('postgrest')
    if not binary:self.skipTest('POSTGREST_BIN required to verify HTTP statement timeout hoisting')
    self.c.execute("create or replace function diagnostic_slow_fixture() returns trigger language plpgsql as $$begin perform pg_sleep(2);return new;end$$")
    self.c.execute('create trigger diagnostic_slow_fixture before insert on motorist_diagnostic_events for each row execute function diagnostic_slow_fixture()')
    with tempfile.TemporaryDirectory(prefix='diagnostics-http-') as folder:
      config=Path(folder)/'postgrest.conf'
      config.write_text('db-uri = "postgres://postgres:local-fixture-only@127.0.0.1:55432/diagnostics_contract"\ndb-schemas = "public"\ndb-anon-role = "service_role"\nserver-host = "127.0.0.1"\nserver-port = 55433\n')
      env={k:v for k,v in os.environ.items() if not k.startswith('PGRST_')}
      proc=subprocess.Popen([binary,str(config)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
      try:
        for _ in range(100):
          try:urllib.request.urlopen('http://127.0.0.1:55433/',timeout=.2);break
          except Exception:time.sleep(.05)
        value=event()
        req=urllib.request.Request('http://127.0.0.1:55433/rpc/motorist_diagnostics_ingest',data=json.dumps(dict(p_org=ORG,p_profile=PROFILE,p_environment='test',p_source='browser',p_build='fixture',p_events=[value])).encode(),headers={'Content-Type':'application/json'})
        start=time.monotonic()
        with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(req,timeout=3)
        duration=time.monotonic()-start
        self.assertEqual(json.loads(error.exception.read())['code'],'57014')
        self.assertLess(duration,1.8)
        self.assertEqual(self.c.execute('select count(*) from motorist_diagnostic_events where id=%s',(value['id'],)).fetchone()[0],0)
      finally:
        proc.terminate();proc.wait(timeout=5)
        self.c.execute('drop trigger diagnostic_slow_fixture on motorist_diagnostic_events')
 def test_read_samples_and_status(self):
    ev=event(type='operation',outcome='failed',callSessionId=CALL);ingest(self.c,[ev,event(sampled=False,durationMs=80000)])
    payload=self.c.execute("select motorist_diagnostics_read(%s,%s,'test','overview')",(ORG,MANAGER)).fetchone()[0]
    self.assertEqual(payload['operations'][0]['samples'],1);self.assertIsNone(payload['operations'][0]['p95Ms']);self.assertEqual(payload['operations'][0]['p50Ms'],12)
    self.assertIsNone(payload['calls'][0]['averageAnsweredToEndSeconds'])
    iid=payload['incidents'][0]['id'];result=self.c.execute("select motorist_diagnostics_read(%s,%s,'test','status',p_id=>%s,p_status=>'resolved')",(ORG,MANAGER,iid)).fetchone()[0]
    self.assertEqual(result['incident']['status'],'resolved');self.assertEqual(result['events'][0]['id'],ev['id'])

if __name__=='__main__':unittest.main(verbosity=2)
