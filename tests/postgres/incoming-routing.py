#!/usr/bin/env python3
"""Loopback-only contract: actual config RPCs + coherent incoming migration."""
import concurrent.futures
import json
import re
import threading
import time
from pathlib import Path
from uuid import uuid4
import psycopg
from psycopg.types.json import Jsonb
ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host='127.0.0.1', hostaddr='127.0.0.1', port=55432, user='postgres', connect_timeout=5)
NAME = 'routing_contract_' + uuid4().hex[:12]
ORG, OTHER, PROFILE, GROUP, PLAN, MEMBER, STEP, LINE = [str(uuid4()) for _ in range(8)]
checks = []
def check(label, value):
    assert value, label
    checks.append(label)
def connect(): return psycopg.connect(dbname=NAME, autocommit=True, **LOCAL)
def snap(c, org=ORG): return c.execute('select public.motorist_routing_snapshot(%s)', (org,)).fetchone()[0]
def save(c, document, version=0): return c.execute('select public.motorist_save_incoming_routing(%s,%s,%s)', (ORG, Jsonb(document), version)).fetchone()[0]
def document(name='Denný', timeout=20): return {'groups':[{'id':GROUP,'name':'Tím '+name,'active':True,'members':[{'id':MEMBER,'member_kind':'operator','profile_id':PROFILE,'position':0,'ring_secs':10}]}], 'plans':[{'id':PLAN,'name':name,'active':True,'fallback_kind':'waiting_room','steps':[{'id':STEP,'step_index':0,'ring_group_id':GROUP,'timeout_secs':timeout,'strategy':'ordered'}]}]}
with psycopg.connect(dbname='postgres', autocommit=True, **LOCAL) as admin: admin.execute(f'create database {NAME}')
try:
  with connect() as c:
    c.execute('''do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if; end $$;
      create table motorist_organizations(id uuid primary key);
      create table motorist_profiles(id uuid primary key, organization_id uuid references motorist_organizations,display_name text,role text,active boolean default true,access_status text default 'approved');
      create table motorist_call_sessions(id uuid primary key);
      create table motorist_call_legs(id uuid primary key);
    ''')
    base=(ROOT/'supabase/migrations/20260520192000_foundation_schema.sql').read_text()
    c.execute(re.search(r'create table public.motorist_telephony_lines \([\s\S]*?\n\);',base)[0])
    foundation=(ROOT/'supabase/migrations/20260903100000_telnyx_telephony_foundation.sql').read_text()
    for table in ['motorist_business_hours','motorist_business_hours_intervals','motorist_business_hours_exceptions','motorist_ring_groups','motorist_ring_group_members','motorist_ring_plans','motorist_ring_plan_steps','motorist_ivr_menus','motorist_ivr_options','motorist_pause_reasons','motorist_ring_attempts','motorist_operator_presence','motorist_operator_devices','motorist_operator_telephony_settings','motorist_telephony_settings']:
      c.execute(re.search(r'create table if not exists public.'+table+r' \([\s\S]*?\n\);', foundation)[0])
    c.execute(re.search(r'alter table public.motorist_telephony_lines[\s\S]*?;', foundation)[0])
    c.execute('alter table motorist_telephony_settings add column routing_version integer not null default 0; alter table motorist_telephony_settings add column queue_escalate_after_seconds integer not null default 120;')
    c.execute((ROOT/'supabase/migrations/20260920100000_ivr_menu_config.sql').read_text())
    c.execute((ROOT/'supabase/migrations/20260928130000_personal_mobile_ownership.sql').read_text())
    c.execute((ROOT/'supabase/migrations/20261006110000_incoming_routing_workspace.sql').read_text())
    c.execute('insert into motorist_organizations values (%s),(%s)',(ORG,OTHER))
    c.execute("insert into motorist_profiles(id,organization_id,display_name,role) values (%s,%s,'Jana','manager')",(PROFILE,ORG))
    before=snap(c)
    outcome=save(c,document())
    check('new group and referring plan commit together', len(outcome['after']['groups'])==1 and outcome['after']['steps'][0]['ring_group_id']==GROUP)
    check('returned before and after belong to one commit', outcome['before']['settings'] is None and outcome['after']['settings']['routing_version']==1)
    c.execute("insert into motorist_telephony_lines(id,organization_id,phone_number,label,ring_plan_id) values(%s,%s,'+421232408700','Hlavná',%s)",(LINE,ORG,PLAN))
    stamp='2026-09-19T12:00:00+00:00'
    c.execute('update motorist_ring_group_members set last_offered_at=%s,last_answered_at=%s where id=%s',(stamp,stamp,MEMBER))
    second=save(c,document('Večerný',30),1)
    check('stable member IDs keep offered and answered history',second['after']['members'][0]['id']==MEMBER and second['after']['members'][0]['last_offered_at'].startswith('2026-09-19T12:00:00'))
    check('organization isolation',snap(c,OTHER)['groups']==[] and snap(c,OTHER)['lines']==[])
    old=snap(c); c.execute("update motorist_telephony_lines set metadata=jsonb_build_object('return_line_id',%s::text) where id=%s",(str(uuid4()),LINE)); new=snap(c)
    check('line-only changes fingerprint without CAS bump',old['snapshotId']!=new['snapshotId'] and old['settings']['routing_version']==new['settings']['routing_version'])
    old=new; c.execute('update motorist_telephony_settings set max_ring_fanout=2 where organization_id=%s',(ORG,)); new=snap(c)
    check('fanout-only change changes fingerprint',old['snapshotId']!=new['snapshotId'])
    for role in ['anon','authenticated']:
      try:
        c.execute(f'set role {role}'); snap(c); raise AssertionError('read RPC accessible by '+role)
      except psycopg.errors.InsufficientPrivilege: checks.append('read RPC denied to '+role)
      finally: c.execute('reset role')
    broken=document(); broken['plans'][0]['steps'][0]['timeout_secs']=999
    try: save(c,broken,2); raise AssertionError('invalid accepted')
    except psycopg.errors.CheckViolation: pass
    check('invalid second section rolls back first section',snap(c)['groups'][0]['name']=='Tím Večerný' and snap(c)['settings']['routing_version']==2)
    foreign=dict(document()); foreign['groups']=[{'id':str(uuid4()),'name':'Foreign','active':True,'members':[]}]
    c.execute('insert into motorist_ring_groups(id,organization_id,name) values(%s,%s,%s)',(foreign['groups'][0]['id'],OTHER,'Foreign'))
    try: save(c,foreign,2); raise AssertionError('foreign ID accepted')
    except psycopg.errors.RaiseException as e: check('foreign existing IDs refused','cross_organization' in str(e))
    # Two actual transactions compete with the same CAS version: exactly one wins.
    barrier=threading.Barrier(2)
    def compete(name):
      with connect() as db:
        barrier.wait()
        try: return save(db,document(name),2)
        except psycopg.errors.RaiseException as e: return str(e)
    with concurrent.futures.ThreadPoolExecutor(2) as pool: results=list(pool.map(compete,['Ráno','Noc']))
    winners=[r for r in results if isinstance(r,dict)]
    check('two writers one success one stale conflict',len(winners)==1 and any(isinstance(r,str) and 'stale_document' in r for r in results))
    check('winning diff snapshots exclude later writer',winners[0]['before']['plans'][0]['name']=='Večerný' and winners[0]['after']['settings']['routing_version']==3)
    # Read during an uncommitted multi-table edit must see the complete old snapshot.
    with connect() as writer:
      writer.execute('begin'); writer.execute("update motorist_ring_groups set name='Tím Nový' where id=%s",(GROUP,)); writer.execute("update motorist_ring_plans set name='Nový' where id=%s",(PLAN,))
      visible=snap(c); check('uncommitted configuration remains invisible as a whole',visible['groups'][0]['name']=='Tím '+visible['plans'][0]['name'] and visible['plans'][0]['name']!='Nový')
      writer.execute('commit')
    visible=snap(c);check('committed read sees both new rows',visible['groups'][0]['name']=='Tím Nový' and visible['plans'][0]['name']=='Nový')
    # A lost HTTP response is recoverable by reading the authoritative payload/version.
    committed=save(c,document('Overené'),3)
    check('response loss can be reconciled from authoritative snapshot',snap(c)['settings']['routing_version']==committed['after']['settings']['routing_version'] and snap(c)['plans'][0]['name']=='Overené')
    # The additive migration advertises support only after the new writer exists.
    check('old snapshot does not advertise combined mode saves', 'atomicIncomingLineModes' not in snap(c))
    c.execute((ROOT/'supabase/migrations/20261009110000_incoming_routing_line_modes.sql').read_text())
    check('migration enables atomic line modes without changing routing', snap(c)['atomicIncomingLineModes'] is True and snap(c)['settings']['routing_version']==4)
    def modes(name='Spolu', next_mode='ring_all', expected=None, line=LINE):
      result=document(name)
      result['line_modes']=[{'id':line,'inbound_call_mode':next_mode,'expected_inbound_call_mode':expected}]
      return result
    def stored_mode(snapshot): return snapshot['lines'][0]['metadata'].get('inbound_call_mode')
    def rejects(label, payload, code, version=None):
      original=snap(c)
      if version is None: version=original['settings']['routing_version']
      try: save(c,payload,version); raise AssertionError(label+' accepted')
      except psycopg.Error as e: check(label,code in str(e) or code==e.sqlstate)
      check(label+' preserves all routing',snap(c)==original)
    combined=save(c,modes(),4)
    check('groups plans and line mode share one version increment',combined['after']['settings']['routing_version']==5 and stored_mode(combined['after'])=='ring_all' and combined['after']['plans'][0]['name']=='Spolu')
    check('snapshots include old and new line modes',stored_mode(combined['before']) is None and stored_mode(combined['after'])=='ring_all')
    check('mode write preserves unrelated line metadata',combined['before']['lines'][0]['metadata']['return_line_id']==combined['after']['lines'][0]['metadata']['return_line_id'])
    # Valid routing with an invalid mode must not partially save, even via direct RPC.
    for name, value in [('object',{}),('null',None),('scalar',[False]),('missing expectation',[{'id':LINE,'inbound_call_mode':'ring_all'}]),('invalid mode',[{'id':LINE,'inbound_call_mode':'all','expected_inbound_call_mode':'ring_all'}]),('extra field',[{'id':LINE,'inbound_call_mode':None,'expected_inbound_call_mode':'ring_all','active':False}]),('duplicate',[{'id':LINE,'inbound_call_mode':None,'expected_inbound_call_mode':'ring_all'}]*2)]:
      payload=document('Nesmie sa uložiť'); payload['line_modes']=value
      rejects('rejects '+name+' line modes',payload,'incoming_line_mode_invalid')
    rejects('legacy line mode conflict refuses every section',modes(expected=None),'line_mode_conflict')
    rejects('stale routing version refuses mode and every section',modes(next_mode='queue_first',expected='ring_all'),'stale_document',4)
    broken=modes(next_mode='queue_first',expected='ring_all'); broken['plans'][0]['steps'][0]['timeout_secs']=999
    rejects('plan failure rolls back line mode and groups',broken,'23514')
    other_line=str(uuid4())
    c.execute("insert into motorist_telephony_lines(id,organization_id,phone_number,label) values(%s,%s,'+421232408701','Foreign')",(other_line,OTHER))
    rejects('foreign line cannot be edited',modes(line=other_line),'incoming_line_not_found')
    rejects('missing line cannot be edited',modes(line=str(uuid4())),'incoming_line_not_found')
    c.execute("update motorist_telephony_lines set metadata=metadata||'{\"archived_at\":\"2026-10-03T00:00:00Z\"}'::jsonb where id=%s",(LINE,))
    rejects('archived line cannot be edited',modes(expected='ring_all'),'incoming_line_not_found')
    c.execute("update motorist_telephony_lines set metadata=metadata-'archived_at' where id=%s",(LINE,))
    # Force an actual failure after the groups/plans writer, proving the last write rolls everything back.
    c.execute("""create function reject_test_mode() returns trigger language plpgsql as $$ begin
      if new.metadata ->> 'inbound_call_mode' = 'queue_first' then raise exception 'test_line_write_failed'; end if; return new;
      end $$; create trigger reject_test_mode before update on motorist_telephony_lines for each row execute function reject_test_mode();""")
    rejects('last line write failure rolls back groups plans and version',modes(next_mode='queue_first',expected='ring_all'),'test_line_write_failed')
    c.execute('drop trigger reject_test_mode on motorist_telephony_lines; drop function reject_test_mode()')
    for role in ['anon','authenticated']:
      try:
        c.execute(f'set role {role}'); save(c,modes(expected='ring_all'),5); raise AssertionError('write RPC accessible by '+role)
      except psycopg.errors.InsufficientPrivilege: checks.append('combined write denied to '+role)
      finally: c.execute('reset role')
    c.execute('set role service_role')
    inherited=save(c,modes(next_mode=None,expected='ring_all'),5)
    c.execute('reset role')
    check('service role can reset a line to inherited mode',stored_mode(inherited['after']) is None)
    legacy=save(c,document('Starší klient'),6)
    check('older clients save groups/plans without touching line modes',stored_mode(legacy['after']) is None and legacy['after']['settings']['routing_version']==7)

    def wait_until_blocked(pid):
      deadline=time.monotonic()+5
      while time.monotonic()<deadline:
        if c.execute('select cardinality(pg_blocking_pids(%s)) > 0',(pid,)).fetchone()[0]: return
        time.sleep(.01)
      raise AssertionError('concurrent statement never reached the row lock')
    # Legacy PATCH arrives first without changing routing_version. New writer
    # must re-read the mode after the row lock becomes available, then reject.
    with connect() as legacy_db, connect() as combined_db:
      legacy_db.execute('begin')
      legacy_db.execute("update motorist_telephony_lines set metadata=metadata||'{\"inbound_call_mode\":\"queue_first\"}'::jsonb where id=%s",(LINE,))
      def pending_combined():
        try: return save(combined_db,modes(expected=None),7)
        except psycopg.errors.RaiseException as e: return str(e)
      with concurrent.futures.ThreadPoolExecutor(1) as pool:
        pending=pool.submit(pending_combined)
        wait_until_blocked(combined_db.info.backend_pid)
        legacy_db.execute('commit')
        check('combined save detects concurrent legacy PATCH after row-lock wait','line_mode_conflict' in pending.result(timeout=5))
      check('legacy PATCH conflict leaves groups plans and version unchanged',snap(c)['plans'][0]['name']=='Starší klient' and snap(c)['settings']['routing_version']==7 and stored_mode(snap(c))=='queue_first')
    # New combined save arrives first; an old PATCH with previously read
    # metadata/updated_at must affect zero rows after waiting for the commit.
    old_line=snap(c)['lines'][0]
    with connect() as combined_db, connect() as legacy_db:
      combined_db.execute('begin')
      outcome=save(combined_db,modes(next_mode='ring_ordered',expected='queue_first'),7)
      def pending_legacy():
        return legacy_db.execute('update motorist_telephony_lines set metadata=%s where id=%s and organization_id=%s and metadata=%s and updated_at=%s', (Jsonb({**old_line['metadata'],'inbound_call_mode':'ring_all'}),LINE,ORG,Jsonb(old_line['metadata']),old_line['updated_at'])).rowcount
      with concurrent.futures.ThreadPoolExecutor(1) as pool:
        pending=pool.submit(pending_legacy)
        wait_until_blocked(legacy_db.info.backend_pid)
        combined_db.execute('commit')
        check('legacy PATCH cannot overwrite committed atomic mode',pending.result(timeout=5)==0 and stored_mode(snap(c))=='ring_ordered')
      check('combined acknowledgement matches complete committed routing',snap(c)==outcome['after'])
  print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
finally:
  with psycopg.connect(dbname='postgres', autocommit=True, **LOCAL) as admin: admin.execute(f'drop database if exists {NAME} with (force)')
