#!/usr/bin/env python3
"""Exact read migration in a disposable loopback PostgreSQL database only."""
from pathlib import Path
from uuid import uuid4
import json, os, re, time
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host='127.0.0.1', hostaddr='127.0.0.1', port=int(os.environ.get('LOCAL_PG_PORT','55436')), user='postgres', connect_timeout=5)
NAME = 'callback_priority_' + uuid4().hex[:12]
ORG, OTHER, SESSION, FOREIGN = [str(uuid4()) for _ in range(4)]
checks = []
def check(label, result):
    assert result, label
    checks.append(label)
def page(c, cursor=None, limit=100, org=ORG):
    return c.execute('select motorist_callback_queue_page_v1(%s,%s,%s)', (org, Jsonb(cursor) if cursor is not None else None, limit)).fetchone()[0]
def cursor(p, i=-2):
    entry = p['entries'][i]
    return dict(version=2, revision=p['revision'], rank=entry['rank'], sortAt=entry['sortAt'], id=entry['request']['id'])
def seed(c, metadata=None, source='missed', org=ORG, session=None, created='2026-10-01T12:00:00Z'):
    return str(c.execute('''insert into motorist_callback_requests(organization_id,caller_number,source,session_id,created_at,metadata)
      values(%s,'+421900000000',%s,%s,%s,%s) returning id''', (org,source,session,created,Jsonb(metadata or {}))).fetchone()[0])
def request(at): return {'request': {'kind':'requested','digit':'1','requested_at':at,'context':'waiting_room'}}

with psycopg.connect(dbname='postgres',autocommit=True,**LOCAL) as admin: admin.execute(f'create database {NAME}')
try:
  with psycopg.connect(dbname=NAME,autocommit=True,**LOCAL) as c:
    c.execute('''do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
      end $$;
      create table motorist_organizations(id uuid primary key);
      create table motorist_call_sessions(id uuid primary key, organization_id uuid, metadata jsonb default '{}');
      create table motorist_telephony_lines(id uuid primary key);
      create table motorist_cases(id uuid primary key);
      create table motorist_profiles(id uuid primary key);''')
    foundation=(ROOT/'supabase/migrations/20260903100000_telnyx_telephony_foundation.sql').read_text()
    c.execute(re.search(r'create table if not exists public.motorist_callback_requests \([\s\S]*?\n\);',foundation)[0])
    c.execute(re.search(r'create index if not exists callback_requests_open_idx[\s\S]*?;',foundation)[0])
    c.execute('insert into motorist_organizations values(%s),(%s)',(ORG,OTHER))
    c.execute('insert into motorist_call_sessions values(%s,%s,%s),(%s,%s,%s)',(SESSION,ORG,Jsonb({'callback':{'confirmed':True,'requested_at':'2026-10-04T12:00:00.123455Z'}}),FOREIGN,OTHER,Jsonb({'callback':{'confirmed':True,'requested_at':'2026-10-01T00:00:00Z'}})))
    missed=[seed(c) for _ in range(125)]
    requested=seed(c,request('2026-10-04T12:00:00.123456Z'))
    legacy=seed(c,session=SESSION)
    foreign_link=seed(c,session=FOREIGN)
    seed(c,request('2026-10-01T00:00:00Z'),org=OTHER)
    before=c.execute('select jsonb_agg(to_jsonb(c) order by id) from motorist_callback_requests c').fetchone()[0]
    c.execute((ROOT/'supabase/migrations/20261011110000_callback_queue_priority.sql').read_text())
    check('migration preserves all existing records',before==c.execute('select jsonb_agg(to_jsonb(c) order by id) from motorist_callback_requests c').fetchone()[0])
    p=page(c)
    check('requested before 125 older missed rows', [e['request']['id'] for e in p['entries'][:2]]==[legacy,requested])
    check('global totals include pages and exclude foreign org',p['openTotal']==128 and p['totalsByOrigin']=={'requested':2,'missed':126,'manual':0,'unknown':0})
    check('foreign linked session cannot prove a request',next(e for e in page(c,limit=100,org=OTHER)['entries'])['request']['organization_id']==OTHER)
    p2=page(c,cursor(p))
    ids=[e['request']['id'] for e in p['entries'][:100]+p2['entries']]
    check('no skipped or duplicated page boundary',len(ids)==len(set(ids))==128 and foreign_link in ids)
    check('foreign session proof is ignored',next(e for e in p['entries'][:100]+p2['entries'] if e['request']['id']==foreign_link)['rank']==1)
    tiny=page(c,limit=1)
    check('preserves first microsecond timestamp',tiny['entries'][0]['sortAt'].endswith('.123455Z'))
    after=page(c,cursor(tiny,0),1)
    check('microsecond cursor admits next request exactly once',after['entries'][0]['request']['id']==requested)
    old=cursor(p)
    c.execute('update motorist_callback_requests set metadata=%s where id=%s',(Jsonb(request('2026-10-04T13:00:00Z')),missed[-1]))
    changed=page(c,old)
    check('upgraded request resets pagination to first page',changed['reset'] and changed['entries'][2]['request']['id']==missed[-1])
    invalid=seed(c,request('2026-99-99T12:00:00Z'))
    check('malformed recorded date cannot crash the queue',page(c)['openTotal']==129)
    for invalid_date in ('2026-10-04T12:00:00+99:99','2026-10-04T12:00:00+16:00'):
      check('invalid timezone cannot abort a page',c.execute('select motorist_callback_queue_time_v1(%s,null)',(invalid_date,)).fetchone()[0] is None)
    check('unknown request time sorts behind known requests',page(c)['entries'][0]['request']['id']==legacy)
    check('legacy proof travels in same page snapshot',page(c)['entries'][0]['sessionMetadata']['callback']['confirmed'] is True)
    misleading=seed(c,{'request':{'kind':'requested','requested_at':'2026-10-04T14:00:00Z'}},source='ivr')
    check('offering callback without recorded digit is not consent',page(c)['totalsByOrigin']['unknown']==1)
    for role in ('anon','authenticated'):
      check(role+' has no execute privilege',not c.execute("select has_function_privilege(%s,'motorist_callback_queue_page_v1(uuid,jsonb,integer)','EXECUTE')",(role,)).fetchone()[0])
      c.execute('set role '+role)
      try: page(c); raise AssertionError(role+' accessed private queue')
      except psycopg.errors.InsufficientPrivilege: checks.append(role+' denied in actual execution')
      finally: c.execute('reset role')
    c.execute('grant select on motorist_callback_requests,motorist_call_sessions to service_role; set role service_role')
    check('authorized service role can read requested organization',page(c)['openTotal']==130)
    c.execute('reset role')
    for bad in ({}, {'version':2,'revision':'a'*32,'rank':0,'sortAt':'2026-10-04T12:00:00Z','id':'not-uuid'}, {**old,'sortAt':'2026-99-99T12:00:00Z'}):
      try: page(c,bad); raise AssertionError('invalid cursor accepted')
      except psycopg.errors.InvalidParameterValue: checks.append('malformed SQL cursor rejected')
    empty=page(c,org=str(uuid4()))
    check('empty organization returns empty bounded page',empty['entries']==[] and empty['openTotal']==0)
    c.execute("insert into motorist_callback_requests(organization_id,caller_number,source) select %s,'+421900000000','missed' from generate_series(1,3000)",(ORG,))
    c.execute("set statement_timeout='2s'")
    started=time.monotonic(); large=page(c); elapsed=time.monotonic()-started
    check('large open queue remains bounded',len(large['entries'])==101 and large['openTotal']==3130)
    print(json.dumps({'checks':len(checks),'passed':checks,'largePageMs':round(elapsed*1000,1)},ensure_ascii=False))
finally:
  with psycopg.connect(dbname='postgres',autocommit=True,**LOCAL) as admin: admin.execute(f'drop database {NAME} with (force)')
