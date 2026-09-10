"""R07 exact migrations, disposable loopback PG only; no providers or remote DB."""
from pathlib import Path
import json, uuid
import psycopg
from psycopg.types.json import Jsonb
ROOT=Path(__file__).resolve().parents[2]
DSN='host=127.0.0.1 hostaddr=127.0.0.1 port=55432 user=postgres connect_timeout=5'
DB='callback_target_contract'
def sql(path):
 return '\n'.join(sql(path.parent/line[4:]) if line.startswith('\\ir ') else line for line in path.read_text().splitlines())
with psycopg.connect(DSN+' dbname=postgres',autocommit=True) as c:
 c.execute('drop database if exists '+DB);c.execute('create database '+DB)
with psycopg.connect(DSN+' dbname='+DB,autocommit=True) as c:
 c.execute(sql(ROOT/'tests/postgres/task-workspace-fixture.sql'))
 c.execute('''
 alter table motorist_callback_requests add caller_number text,add caller_name text,add source text,add session_id uuid,add line_id uuid,add due_at timestamptz,add notes text,add claimed_by uuid,add claimed_at timestamptz,add created_at timestamptz default now(),add updated_at timestamptz default now();
 create table motorist_call_sessions(id uuid primary key,organization_id uuid,case_id uuid,line_id uuid,state text default 'ended',direction text default 'inbound',caller_number text,called_number text,metadata jsonb default '{}',started_at timestamptz,answered_by_profile_id uuid);
 create table motorist_calls(id uuid primary key,organization_id uuid,session_id uuid,case_id uuid,line_id uuid,direction text,caller_number text,called_number text,destination_number text);
 create table motorist_contacts(id uuid primary key,organization_id uuid,name text,phone text);
 ''')
 for f in ['20260928120000_callback_contact_fulfillment.sql','20260929120000_task_workspace.sql','20260929160000_verified_callback_targets.sql']:c.execute(sql(ROOT/'supabase/migrations'/f))
 org='10000000-0000-0000-0000-000000000001';otherorg='10000000-0000-0000-0000-000000000002'
 actor='20000000-0000-0000-0000-000000000001';admin='20000000-0000-0000-0000-000000000003';other='20000000-0000-0000-0000-000000000004';case='40000000-0000-0000-0000-000000000003'
 source,target,foreign,line=[str(uuid.uuid4()) for _ in range(4)]
 c.execute('insert into motorist_contacts values(%s,%s,\'No-return switchboard\',\'02/32 408 700\'),(%s,%s,\'Verified dispatcher\',\'+421905123456\'),(%s,%s,\'Foreign\',\'+421905123457\')',(source,org,target,org,foreign,otherorg))
 def resolve(number):return c.execute('select motorist_resolve_callback_target(%s,%s)',(org,number)).fetchone()[0]
 def policy(non=True,targetid=None,rev=0,verified=False,by=admin):return c.execute("select motorist_contact_callback_policy(%s,%s,%s,'save',%s,%s,%s,%s)",(org,by,source,non,targetid,rev,verified)).fetchone()[0]
 def rejects(fn,code):
  try:fn()
  except psycopg.Error as e:assert e.sqlstate==code,(e.sqlstate,str(e));return
  raise AssertionError('Expected SQL rejection '+code)
 assert resolve('0900 123 456')['dialNumber']=='0900 123 456'
 assert resolve('anonymous')['status']=='original'
 rejects(lambda:policy(by=actor),'42501');rejects(lambda:policy(by=other),'42501')
 p=policy();assert p['revision']==1 and resolve('+4210232408700')['status']=='blocked'
 rejects(lambda:policy(targetid=target,rev=1),'22023');rejects(lambda:policy(targetid=target,rev=1,verified=None),'22023');rejects(lambda:policy(rev=None),'40001');rejects(lambda:policy(targetid=foreign,rev=1,verified=True),'22023')
 p=policy(targetid=target,rev=1,verified=True);verification=p['verificationId']
 assert resolve('00421 2 3240 8700')['dialNumber']=='+421905123456'
 rejects(lambda:policy(rev=1),'40001')
 assert not c.execute("select has_function_privilege('authenticated','motorist_contact_callback_policy(uuid,uuid,uuid,text,boolean,uuid,bigint,boolean)','execute')").fetchone()[0]
 assert not c.execute("select has_table_privilege('service_role','motorist_callback_target_verifications','update')").fetchone()[0]
 print('PASS: unknown unchanged, explicit verification, canonical source match, ACL/CAS, no cross-org targets, immutable verification')
 def request():
  rid=str(uuid.uuid4());c.execute("insert into motorist_callback_requests(id,organization_id,caller_number,case_id,line_id,claimed_by,created_at) values(%s,%s,'02/32 408 700',%s,%s,%s,'2026-09-07T09:00:00Z')",(rid,org,case,line,actor));return rid
 def session(rid,number='+421905123456'):
  sid=str(uuid.uuid4());c.execute("insert into motorist_call_sessions(id,organization_id,case_id,line_id,direction,called_number,answered_by_profile_id,started_at,state,metadata) values(%s,%s,%s,%s,'outbound',%s,%s,'2026-09-07T10:00:00Z','talking',%s)",(sid,org,case,line,number,actor,Jsonb({'callbackRequestId':rid,'outbound':{'by':actor}})));return sid
 def link(rid,sid):return c.execute('select motorist_link_callback_outbound_v1(%s,%s,%s,%s)',(org,rid,sid,actor)).fetchone()[0]
 def approve(rid,vid=verification):return c.execute('select motorist_approve_callback_target(%s,%s,%s,%s)',(org,actor,rid,vid)).fetchone()[0]
 rid,sibling=request(),request();sid=session(rid)
 assert not link(rid,sid)
 approve(rid);assert link(rid,sid) and link(rid,sid)
 assert not link(sibling,sid)
 binding=c.execute("select metadata->'callback_target_authorization' from motorist_call_sessions where id=%s",(sid,)).fetchone()[0]
 proof={'version':1,'id':'proof-target','sessionId':sid,'occurredAt':'2026-09-07T10:01:00Z','scope':{'organizationId':org,'caseId':case,'lineId':line,'customerNumber':'+421905123456','startedAt':'2026-09-07T10:00:00Z','callbackRequestId':rid,'callbackTargetAuthorization':binding}}
 def reconcile(p):
  c.execute("update motorist_call_sessions set metadata=jsonb_set(metadata,'{callback_contact}',%s) where id=%s",(Jsonb({'proofs':[p]}),sid))
  return c.execute('select motorist_reconcile_callback_contact_v1(%s,%s,%s)',(org,sid,Jsonb(p))).fetchone()[0]
 for patch in [{'callbackRequestId':sibling},{'customerNumber':'+421905999999'},{'callbackTargetAuthorization':{**binding,'verificationId':str(uuid.uuid4())}},{'callbackTargetAuthorization':{**binding,'targetNumber':'+421905999999'}},{'callbackTargetAuthorization':None}]:
  assert reconcile({**proof,'scope':{**proof['scope'],**patch}})==[]
 # Ordinary task wrapper stays compatible when activated; historical proof uses bound verification even after directory edit.
 c.execute("update motorist_task_workspace_settings set enabled=true,writer_inventory_verified_at=now(),writer_inventory_note='Local R07 contract only'")
 c.execute("update motorist_contacts set phone='+421905111111' where id=%s",(target,))
 assert resolve('02/32 408 700')['status']=='blocked'
 rejects(lambda:approve(sibling),'40001')
 c.execute('update motorist_call_sessions set answered_by_profile_id=%s where id=%s',(admin,sid))
 assert reconcile(proof)==[rid] and reconcile(proof)==[]
 assert c.execute('select status,caller_number from motorist_callback_requests where id=%s',(rid,)).fetchone()==('done','02/32 408 700')
 assert c.execute('select status from motorist_callback_requests where id=%s',(sibling,)).fetchone()[0]=='open'
 print('PASS: exact request+actor+target approval before dial, forged/wrong/missing binding rejected; proof survives revocation, one obligation only, retry idempotent, caller history intact')
 c.execute("update motorist_contacts set phone='+421232408701' where id=%s",(source,))
 assert resolve('02/32 408 700')['status']=='blocked' and resolve('+421232408701')['status']=='blocked'
 c.execute("update motorist_contacts set phone='+421905123456' where id=%s",(target,))
 revision=c.execute("select revision from motorist_contact_callback_policies where source_contact_id=%s",(source,)).fetchone()[0]
 p=policy(targetid=target,rev=revision,verified=True)
 assert resolve('+421232408701')['status']=='verified_alternative' and resolve('02/32 408 700')['status']=='blocked'
 print('PASS: source/target phone edits invalidate old verification; historical noncallback number stays blocked; new current number requires reverification')
