#!/usr/bin/env python3
"""Exact new flow + mobile endpoint migrations; disposable loopback database only."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4
import json, os, re, threading, time
import psycopg
from psycopg.types.json import Jsonb
ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host='127.0.0.1',hostaddr='127.0.0.1',port=int(os.environ.get('LOCAL_PG_PORT','55434')),user='postgres',connect_timeout=5)
NAME = 'unified_flow_' + uuid4().hex[:12]
ORG, OTHER, PROFILE, FOREIGN, LINE, LINE2, FOREIGN_LINE, SESSION, SESSION2 = [str(uuid4()) for _ in range(9)]
checks=[]
def check(label,condition):
    assert condition,label
    checks.append(label)
def connect(): return psycopg.connect(dbname=NAME,autocommit=True,**LOCAL)
def snapshot(c): return c.execute('select motorist_routing_snapshot(%s)',(ORG,)).fetchone()[0]
def flow(seconds=20): return {'version':1,'steps':[{'id':'00000000-0000-4000-8000-000000000001','type':'ring','seconds':seconds,'people':[{'profileId':PROFILE,'application':True,'personalNumber':'+421910123456'}]}],'ending':'hangup'}
def changes(next_flow=None,expected=None,line=LINE): return [{'id':line,'flow':next_flow or flow(),'expected_flow':expected}]
def save(c,payload,read=None):
    read=read or snapshot(c)
    return c.execute('select motorist_save_incoming_flow(%s,%s,%s,%s)',(ORG,Jsonb(payload),read['settings']['routing_version'],read['snapshotId'])).fetchone()[0]
def rejected(c,label,payload,code,read=None):
    before=snapshot(c)
    try: save(c,payload,read); raise AssertionError(label+' accepted')
    except psycopg.Error as error: check(label,code in str(error) or code==error.sqlstate)
    check(label+' is atomic',snapshot(c)==before)
def attempt(c,device=None,kind='operator',session=SESSION,number=None,step=0):
    return c.execute('''insert into motorist_ring_attempts(organization_id,session_id,step_index,member_kind,profile_id,external_number,application_device,result)
      values(%s,%s,%s,%s,%s,%s,%s,'offered') returning id''',(ORG,session,step,kind,PROFILE,number,device)).fetchone()[0]
def attempt_rejected(c,label,code,**kwargs):
    try: attempt(c,**kwargs); raise AssertionError(label+' accepted')
    except psycopg.Error as error: check(label,error.sqlstate==code)
def wait_lock(c,pid):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
      if c.execute('select cardinality(pg_blocking_pids(%s))>0',(pid,)).fetchone()[0]: return
      time.sleep(.01)
    raise AssertionError('competing query did not reach row lock')
with psycopg.connect(dbname='postgres',autocommit=True,**LOCAL) as admin: admin.execute(f'create database {NAME}')
try:
  with connect() as c:
    c.execute('''do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if; end $$;
      create table motorist_organizations(id uuid primary key);
      create table motorist_profiles(id uuid primary key,organization_id uuid references motorist_organizations,display_name text,role text,active boolean default true,access_status text default 'active',kind text default 'human');
      create table motorist_call_sessions(id uuid primary key);
      create table motorist_call_legs(id uuid primary key);''')
    base=(ROOT/'supabase/migrations/20260520192000_foundation_schema.sql').read_text()
    c.execute(re.search(r'create table public.motorist_telephony_lines \([\s\S]*?\n\);',base)[0])
    foundation=(ROOT/'supabase/migrations/20260903100000_telnyx_telephony_foundation.sql').read_text()
    for table in ['motorist_business_hours','motorist_business_hours_intervals','motorist_business_hours_exceptions','motorist_ring_groups','motorist_ring_group_members','motorist_ring_plans','motorist_ring_plan_steps','motorist_ivr_menus','motorist_ivr_options','motorist_pause_reasons','motorist_operator_presence','motorist_operator_devices','motorist_operator_telephony_settings','motorist_telephony_settings']:
      c.execute(re.search(r'create table if not exists public.'+table+r' \([\s\S]*?\n\);',foundation)[0])
    c.execute(foundation[foundation.index('create table if not exists public.motorist_ring_attempts ('):foundation.index('-- 9. Operator presence')].rsplit('-- ---------------------------------------------------------------------------',1)[0])
    c.execute(re.search(r'alter table public.motorist_telephony_lines[\s\S]*?;',foundation)[0])
    c.execute('alter table motorist_telephony_settings add column routing_version integer not null default 0; alter table motorist_telephony_settings add column queue_escalate_after_seconds integer not null default 120;')
    for name in ['20260920100000_ivr_menu_config.sql','20260923100000_operator_pause_routing.sql','20260928130000_personal_mobile_ownership.sql','20261006110000_incoming_routing_workspace.sql','20261008130300_parallel_operator_ring_endpoints.sql','20261009110000_incoming_routing_line_modes.sql']:
      c.execute((ROOT/'supabase/migrations'/name).read_text())
    c.execute('insert into motorist_organizations values(%s),(%s)',(ORG,OTHER))
    c.execute("insert into motorist_profiles(id,organization_id,display_name,role) values(%s,%s,'Michal','admin'),(%s,%s,'Foreign','admin')",(PROFILE,ORG,FOREIGN,OTHER))
    c.execute('insert into motorist_telephony_settings(organization_id) values(%s)',(ORG,))
    c.execute("insert into motorist_telephony_lines(id,organization_id,phone_number,label,metadata) values(%s,%s,'+421232408774','TEST','{\"inbound_call_mode\":\"queue_first\",\"custom\":{\"keep\":true}}'),(%s,%s,'+421232408775','TEST 2','{}'),(%s,%s,'+421232408776','Foreign','{}')",(LINE,ORG,LINE2,ORG,FOREIGN_LINE,OTHER))
    c.execute('insert into motorist_call_sessions values(%s),(%s)',(SESSION,SESSION2))
    original=snapshot(c)
    c.execute((ROOT/'supabase/migrations/20261010110000_unified_incoming_flow.sql').read_text())
    after=snapshot(c)
    check('flow migration writes no routing data',after['snapshotId']==original['snapshotId'] and after['lines']==original['lines'])
    check('flow capability waits for application endpoint migration',after['unifiedIncomingFlow'] is False)
    c.execute("insert into motorist_ring_attempts(organization_id,session_id,step_index,member_kind,profile_id,result) values(%s,%s,0,'operator',%s,'offered')",(ORG,SESSION,PROFILE))
    legacy=c.execute('select to_jsonb(t) from motorist_ring_attempts t').fetchone()[0]
    c.execute((ROOT/'supabase/migrations/20261010120000_mobile_app_ring_endpoints.sql').read_text())
    check('capability enables only after all prerequisites',snapshot(c)['unifiedIncomingFlow'] is True)
    preserved=c.execute("select to_jsonb(t)-'application_device' from motorist_ring_attempts t").fetchone()[0]
    check('mobile migration preserves legacy attempt',preserved==legacy)
    check('web mobile app and personal PSTN can coexist',bool(attempt(c,'mobile')) and bool(attempt(c,kind='external_number',number='+421910123456')))
    attempt_rejected(c,'explicit web duplicates legacy NULL web','23505',device='web')
    attempt_rejected(c,'second mobile app endpoint duplicates','23505',device='mobile')
    attempt_rejected(c,'mobile app cannot open another step while offered','23505',device='mobile',step=1)
    attempt_rejected(c,'PSTN cannot pretend to be app','23514',device='mobile',kind='external_number',number='+421910123457')
    attempt_rejected(c,'other caller cannot reserve operator with different PSTN','23P01',kind='external_number',session=SESSION2,number='+421910123457')
    c.execute('truncate motorist_ring_attempts')
    saved=save(c,changes())
    stored=next(row for row in saved['after']['lines'] if row['id']==LINE)
    check('flow save keeps legacy routing metadata and unrelated keys',stored['metadata']['custom']=={'keep':True} and stored['metadata']['inbound_call_mode']=='queue_first')
    check('flow save returns committed before and after',saved['before']['settings']['routing_version']==0 and saved['after']['settings']['routing_version']==1 and stored['metadata']['incoming_flow']==flow())
    before=snapshot(c);noop=save(c,changes(expected=flow()))
    check('identical save changes no version timestamp or metadata',noop['before']==noop['after'] and snapshot(c)==before)
    rejected(c,'old flow expectation',changes(flow(30)), 'flow_conflict')
    rejected(c,'duplicate line',changes(expected=flow())*2,'incoming_flow_invalid')
    rejected(c,'foreign line',changes(line=FOREIGN_LINE),'incoming_line_not_found')
    invalid=flow();invalid['steps'][0]['people'][0]['profileId']=FOREIGN
    rejected(c,'foreign operator',changes(invalid,flow()),'incoming_profile_invalid')
    rejected(c,'unknown flow schema',changes({'version':2,'steps':[],'ending':'hangup'},flow()),'incoming_flow_invalid')
    for field,value in [('active',False),('access_status','disabled'),('kind','ai'),('role','driver')]:
      c.execute(f'update motorist_profiles set {field}=%s where id=%s',(value,PROFILE))
      rejected(c,'ineligible '+field,changes(flow(30),flow()),'incoming_profile_invalid')
      c.execute("update motorist_profiles set active=true,access_status='active',kind='human',role='admin' where id=%s",(PROFILE,))
    # Preference writes do not change the public snapshot, so the RPC itself
    # rechecks ownership after locking those rows.
    c.execute("insert into motorist_operator_telephony_settings(organization_id,profile_id,default_mobile_number) values(%s,%s,'+421910999999')",(ORG,PROFILE))
    second_profile=str(uuid4())
    c.execute("insert into motorist_profiles(id,organization_id,display_name,role) values(%s,%s,'Other operator','dispatcher')",(second_profile,ORG))
    c.execute("insert into motorist_operator_telephony_settings(organization_id,profile_id,default_mobile_number) values(%s,%s,'+421910111111')",(ORG,second_profile))
    read=snapshot(c)
    c.execute("update motorist_operator_telephony_settings set default_mobile_number='+421910123456' where profile_id=%s",(second_profile,))
    check('preference changes are excluded from public hash',snapshot(c)['snapshotId']==read['snapshotId'])
    rejected(c,'concurrent phone ownership preference is rechecked',changes(flow(30),flow()),'incoming_number_owner_conflict',read)
    c.execute("update motorist_operator_telephony_settings set default_mobile_number='+421910111111' where profile_id=%s",(second_profile,))
    read=snapshot(c)
    with connect() as preference,connect() as saver,ThreadPoolExecutor(1) as pool:
      preference.execute('begin');preference.execute("update motorist_operator_telephony_settings set default_mobile_number='+421910123456' where profile_id=%s",(second_profile,))
      def pending_ownership_save():
        try:return save(saver,changes(flow(30),flow()),read)
        except psycopg.Error as error:return str(error)
      future=pool.submit(pending_ownership_save);wait_lock(c,saver.info.backend_pid);preference.execute('commit')
      check('ownership check sees preference committed after row lock wait','incoming_number_owner_conflict' in future.result(timeout=5))
    c.execute("update motorist_operator_telephony_settings set default_mobile_number='+421910111111' where profile_id=%s",(second_profile,))
    c.execute('delete from motorist_operator_telephony_settings where profile_id=%s',(second_profile,))
    read=snapshot(c)
    with connect() as preference,connect() as saver,ThreadPoolExecutor(1) as pool:
      preference.execute('begin');preference.execute("insert into motorist_operator_telephony_settings(organization_id,profile_id,default_mobile_number) values(%s,%s,'+421910123456')",(ORG,second_profile))
      def pending_insert_save():
        try:return save(saver,changes(flow(30),flow()),read)
        except psycopg.Error as error:return str(error)
      future=pool.submit(pending_insert_save);wait_lock(c,saver.info.backend_pid);preference.execute('commit')
      check('ownership check covers brand-new preference insert','incoming_number_owner_conflict' in future.result(timeout=5))
    c.execute("update motorist_operator_telephony_settings set default_mobile_number='+421910111111' where profile_id=%s",(second_profile,))
    for role in ['anon','authenticated']:
      try:
        c.execute(f'set role {role}'); c.execute('select motorist_save_incoming_flow(%s,%s,1,%s)',(ORG,Jsonb(changes(flow(30),flow())),'a'*32)); raise AssertionError('RPC callable by '+role)
      except psycopg.errors.InsufficientPrivilege: checks.append('write denied to '+role)
      finally: c.execute('reset role')
    read=snapshot(c); c.execute("update motorist_telephony_lines set label='Renamed' where id=%s",(LINE,))
    rejected(c,'snapshot catches non-versioned legacy change',changes(flow(30),flow()),'stale_document',read)
    c.execute("update motorist_telephony_lines set metadata=metadata||jsonb_build_object('return_line_id',%s::text) where id=%s",(LINE2,LINE))
    rejected(c,'return link is protected',changes(flow(30),flow()),'incoming_route_changed')
    c.execute("update motorist_telephony_lines set metadata=metadata-'return_line_id' where id=%s",(LINE,))
    # Two writers actually race; exactly one commit is accepted.
    read=snapshot(c);barrier=threading.Barrier(2)
    def compete(seconds):
      with connect() as db:
        barrier.wait()
        try:return save(db,changes(flow(seconds),flow()),read)
        except psycopg.Error as error:return str(error)
    with ThreadPoolExecutor(2) as pool: results=list(pool.map(compete,[30,40]))
    check('two flow writers cannot overwrite each other',len([x for x in results if isinstance(x,dict)])==1 and any(isinstance(x,str) and ('flow_conflict' in x or 'stale_document' in x) for x in results))
    current=next(row for row in snapshot(c)['lines'] if row['id']==LINE)['metadata']['incoming_flow']
    # A legacy patch holds the exact row; after waiting, snapshot CAS must reject.
    read=snapshot(c)
    with connect() as old,connect() as new,ThreadPoolExecutor(1) as pool:
      old.execute('begin');old.execute("update motorist_telephony_lines set label='Concurrent legacy' where id=%s",(LINE,))
      def save_after_wait():
        try:return save(new,changes(flow(50),current),read)
        except psycopg.Error as error:return str(error)
      future=pool.submit(save_after_wait);wait_lock(c,new.info.backend_pid);old.execute('commit')
      check('flow save detects legacy change after row lock wait','stale_document' in future.result(timeout=5))
    # A late failure rolls back every selected line and the single version.
    c.execute("""create function fail_second_flow() returns trigger language plpgsql as $$ begin if new.label='TEST 2' then raise exception 'late_failure'; end if; return new; end $$;
      create trigger fail_second_flow before update on motorist_telephony_lines for each row execute function fail_second_flow();""")
    rejected(c,'last line write rollback',changes(flow(50),current)+changes(line=LINE2),'late_failure')
    c.execute('drop trigger fail_second_flow on motorist_telephony_lines;drop function fail_second_flow()')
    # Service-role access uses locked-down definer functions, not table grants.
    read=snapshot(c);c.execute('set role service_role');save(c,changes(flow(50),current),read);c.execute('reset role')
    check('service role can save through restricted RPC',snapshot(c)['settings']['routing_version']==3)
    security=c.execute("select prosecdef,proconfig from pg_proc where oid='motorist_save_incoming_flow(uuid,jsonb,integer,text)'::regprocedure").fetchone()
    check('RPC definer search path is fixed',security[0] and 'search_path=""' in security[1])
  print(json.dumps({'checks':len(checks),'passed':checks},ensure_ascii=False,indent=2))
finally:
  with psycopg.connect(dbname='postgres',autocommit=True,**LOCAL) as admin: admin.execute(f'drop database {NAME} with (force)')
