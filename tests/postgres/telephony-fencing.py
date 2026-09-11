"""Real local PostgreSQL ownership/journal races. Never connects outside loopback.
Run: python3 tests/postgres/telephony-fencing.py (psycopg 3, PostgreSQL :55432).
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import json
import uuid
import os
import socket
import subprocess
import time
import urllib.request
import urllib.error
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[2]
BASE = 'host=127.0.0.1 hostaddr=127.0.0.1 port=55432 user=postgres connect_timeout=5'
NAME = 'telephony_fencing_' + uuid.uuid4().hex[:10]
DSN = BASE + ' dbname=' + NAME
SID, ORG = str(uuid.uuid4()), str(uuid.uuid4())

def conn(): return psycopg.connect(DSN, autocommit=True)
def headers(c, token=None, generation=None, writer='2'):
    values = {'x-telephony-writer':writer}
    if token: values.update({'x-telephony-session':SID,'x-telephony-token':token,'x-telephony-generation':str(generation)})
    c.execute("select set_config('request.headers',%s,false)",(json.dumps(values),))
def acquire(c, token):
    return c.execute('select motorist_session_lease_acquire_v2(%s,%s)',(SID,token)).fetchone()[0]
def expire(c):
    c.execute("begin")
    c.execute("select set_config('motorist.telephony_internal','1',true)")
    c.execute("update motorist_call_sessions set lease_until=clock_timestamp()-interval '1 second' where id=%s",(SID,))
    c.execute('commit')
def rejected(work):
    try: work()
    except psycopg.Error as e:
        assert e.sqlstate=='PT409', (e.sqlstate,str(e))
        return
    raise AssertionError('stale or incompatible write accepted')
def prepare(c, command='dial1', fingerprint='fp', path='/calls'):
    return c.execute("select motorist_provider_command_prepare_v2(%s,%s,%s,'POST',%s)",(SID,command,fingerprint,path)).fetchone()[0]
def evidence(c,command,generation,token,status=200,result=None,retry=None):
    return c.execute('select motorist_provider_command_result_v2(%s,%s,%s,%s,%s,%s,%s,%s)',
      (SID,command,'fp',generation,token,status,Jsonb(result or {'data':{'call_control_id':'exact-leg'}}),retry)).fetchone()[0]
def passed(name): print('PASS',name,flush=True)

with psycopg.connect(BASE+' dbname=postgres',autocommit=True) as setup:
    setup.execute('create database '+NAME)
try:
    with conn() as c:
        c.execute((ROOT/'tests/postgres/presence-fixture.sql').read_text())
        c.execute("alter table motorist_call_sessions add lease_token text,add lease_until timestamptz,add direction text default 'inbound'")
        c.execute('create table motorist_call_legs(id uuid primary key default gen_random_uuid(),session_id uuid,metadata jsonb)')
        c.execute('create table motorist_calls(id uuid primary key default gen_random_uuid(),session_id uuid,status text,recording_source_revision bigint default 0,updated_at timestamptz default now())')
        c.execute('create table motorist_call_participant_intervals(id uuid primary key default gen_random_uuid(),session_id uuid,metadata jsonb)')
        c.execute((ROOT/'supabase/migrations/20260928100000_atomic_presence_contract.sql').read_text())
        c.execute((ROOT/'supabase/migrations/20260928110000_durable_transition_effects.sql').read_text())
        c.execute((ROOT/'supabase/migrations/20260929200000_fenced_telephony_commands.sql').read_text())
        c.execute('grant select,insert,update,delete on all tables in schema public to service_role')
        c.execute('revoke insert,update,delete on motorist_provider_commands from service_role')
        c.execute('alter role service_role bypassrls')
        c.execute('set role service_role')
        # Expand permits v1; switching admissions enforces new-writer identity.
        legacy=str(uuid.uuid4())
        c.execute('insert into motorist_call_sessions(id,organization_id) values(%s,%s)',(legacy,ORG))
        c.execute("update motorist_call_sessions set version=version+1 where id=%s",(legacy,))
        c.execute('update motorist_telephony_writer_rollout set new_session_contract=2')
        rejected(lambda:c.execute('insert into motorist_call_sessions(id,organization_id) values(%s,%s)',(SID,ORG)))
        headers(c)
        rejected(lambda:c.execute("insert into motorist_call_sessions(id,organization_id,direction) values(%s,%s,'outbound')",(str(uuid.uuid4()),ORG)))
        c.execute('insert into motorist_call_sessions(id,organization_id) values(%s,%s)',(SID,ORG))
        assert not c.execute("select motorist_session_lease_acquire(%s,'old')",(SID,)).fetchone()[0]
        rejected(lambda:c.execute('update motorist_call_sessions set version=99 where id=%s',(SID,)))
        a=acquire(c,'A'); headers(c,'A',a['generation'])
        c.execute('update motorist_call_sessions set version=version+1 where id=%s',(SID,))
        c.execute('insert into motorist_call_legs(session_id) values(%s)',(SID,))
        c.execute('insert into motorist_calls(session_id,status) values(%s,%s)',(SID,'ringing'))
        passed('old/new writer x old/new session admission and direct-write fence')

        main={'sessionPatch':{'state':'talking'},'entry':{'id':'event1','commands':[]}}
        assert c.execute('select motorist_stage_transition_v1(%s,%s,1,%s)',(ORG,SID,Jsonb(main))).fetchone()[0]['applied']
        expire(c)
        assert not c.execute('select motorist_session_lease_renew_v2(%s,%s,%s)',(SID,'A',a['generation'])).fetchone()[0]
        b=acquire(c,'B'); headers(c,'B',b['generation'])
        assert b['generation']>a['generation']
        c.execute('update motorist_call_sessions set version=version+1 where id=%s',(SID,))
        with conn() as old:
            old.execute('set role service_role'); headers(old,'A',a['generation'])
            # A stale writer reads the new version; it still cannot checkpoint.
            version=old.execute('select version from motorist_call_sessions where id=%s',(SID,)).fetchone()[0]
            rejected(lambda:old.execute('update motorist_call_sessions set pending_effects=null,version=version+1 where id=%s and version=%s',(SID,version)))
            rejected(lambda:old.execute('update motorist_call_legs set metadata=\'{}\' where session_id=%s',(SID,)))
            rejected(lambda:old.execute('insert into motorist_ring_attempts(session_id) values(%s)',(SID,)))
            rejected(lambda:old.execute('insert into motorist_calls(session_id) values(%s)',(SID,)))
            old.execute('update motorist_calls set recording_source_revision=recording_source_revision+1,updated_at=now() where session_id=%s',(SID,))
            rejected(lambda:old.execute("update motorist_calls set recording_source_revision=recording_source_revision+1,status='ended' where session_id=%s",(SID,)))
            rejected(lambda:old.execute('update motorist_calls set recording_source_revision=recording_source_revision-1 where session_id=%s',(SID,)))
            rejected(lambda:old.execute('insert into motorist_call_participant_intervals(session_id) values(%s)',(SID,)))
            rejected(lambda:old.execute('select motorist_stage_transition_v1(%s,%s,%s,%s)',(ORG,SID,version,Jsonb({'sessionPatch':{},'entry':{'id':'stale'}}))))
        passed('expired renewal and stale owner with fresh version cannot stage/checkpoint/modify children')

        assert prepare(c)['dispatch']
        # Provider accepts, but topology checkpoint fails after owner takeover.
        expire(c); d=acquire(c,'C'); headers(c,'C',d['generation'])
        assert evidence(c,'dial1',b['generation'],'B')
        adopted=prepare(c)
        assert not adopted['dispatch'] and adopted['outcome']=='accepted'
        assert adopted['result']['data']['call_control_id']=='exact-leg'
        rejected(lambda:prepare(c,fingerprint='changed'))
        assert not evidence(c,'dial1',d['generation'],'C',result={'data':{'call_control_id':'wrong-leg'}})
        passed('accepted result survives lost ownership/checkpoint; exact result adopted and payload reuse rejected')

        for age in (61,301):
            command='unknown'+str(age)
            assert prepare(c,command)['dispatch']
            c.execute('reset role')
            c.execute("update motorist_provider_commands set first_dispatched_at=clock_timestamp()-make_interval(secs=>%s) where session_id=%s and command_id=%s",(age,SID,command))
            c.execute('set role service_role')
            assert prepare(c,command)==dict(prepare(c,command),dispatch=False)
            assert prepare(c,command)['outcome']=='unknown'
        passed('real 61s/301s-old unknown commands never dispatch again')
        assert c.execute("select motorist_provider_command_prepare_v2(%s,'observed','fp','POST','/calls','exact-state',%s)",
          (SID,Jsonb({'client_state':'exact-state','to':'sip:frozen@example.invalid'}))).fetchone()[0]['dispatch']
        assert not c.execute("select motorist_provider_observe_dial_v2(%s,'wrong-state','unrelated',null,null,true)",(SID,)).fetchone()[0]
        assert c.execute("select motorist_provider_observe_dial_v2(%s,'exact-state','observed-leg','observed-leg-id','provider-session',true)",(SID,)).fetchone()[0]
        observed=c.execute("select motorist_provider_command_lookup_v2(%s,'observed')",(SID,)).fetchone()[0]
        assert observed['outcome']=='accepted' and observed['result']['data']['call_control_id']=='observed-leg'
        passed('exact uniquely correlated provider event reconciles lost dial response')

        assert prepare(c,'rate')['dispatch']
        assert evidence(c,'rate',d['generation'],'C',status=429,retry=30000)
        assert not prepare(c,'rate')['dispatch']
        passed('full 429 retry interval remains durable')
        c.execute('select motorist_session_terminate_v2(%s,%s)',(ORG,SID))
        rejected(lambda:prepare(c,'late'))
        assert prepare(c,'hangup',path='/calls/exact-leg/actions/hangup')['dispatch']
        assert {item['callControlId'] for item in c.execute('select motorist_provider_termination_legs_v2(%s)',(SID,)).fetchone()[0]}=={'exact-leg','observed-leg'}
        passed('termination blocks new dial and retains exact late-leg compensation evidence')
        assert c.execute('select termination_next_attempt_at is not null from motorist_call_sessions where id=%s',(SID,)).fetchone()[0]
        checkpoint=lambda commands:c.execute('select motorist_provider_termination_checkpoint_v2(%s,%s)',(SID,commands)).fetchone()[0]
        assert checkpoint(['dial1','observed'])['pending']  # Lost responses still need exact evidence.
        assert c.execute('select motorist_provider_termination_legs_v2(%s)',(SID,)).fetchone()[0]==[]
        # An operator-visible clear cannot discard late provider evidence. Force
        # this boundary as an administrative fixture; the next result re-arms it.
        c.execute('reset role')
        c.execute("begin")
        c.execute("select set_config('motorist.telephony_internal','1',true)")
        c.execute('update motorist_call_sessions set termination_next_attempt_at=null where id=%s',(SID,))
        c.execute('commit')
        c.execute('set role service_role')
        assert evidence(c,'unknown61',d['generation'],'C')
        assert c.execute('select termination_next_attempt_at is not null from motorist_call_sessions where id=%s',(SID,)).fetchone()[0]
        assert checkpoint(['unknown61'])['pending']
        assert evidence(c,'unknown301',d['generation'],'C',status=400)
        assert not checkpoint([])['pending']
        assert c.execute('select termination_next_attempt_at is null from motorist_call_sessions where id=%s',(SID,)).fetchone()[0]
        assert c.execute('select motorist_provider_termination_legs_v2(%s)',(SID,)).fetchone()[0]==[]
        passed('termination intent survives pre-handler crash; late acceptance re-arms cleanup; confirmed cleanup stops polling')


        # PostgreSQL lock barrier proves takeover cannot overtake a fenced write.
        with conn() as first,conn() as second,ThreadPoolExecutor() as pool:
            first.execute('set role service_role'); second.execute('set role service_role')
            headers(first,'C',d['generation']); headers(second)
            first.execute('begin')
            first.execute('update motorist_call_sessions set version=version+1 where id=%s',(SID,))
            entered=Event()
            def contender():
                entered.set(); return acquire(second,'D')
            future=pool.submit(contender); assert entered.wait(5)
            for _ in range(10000):
                c.execute('reset role')
                wait=c.execute('select wait_event_type from pg_stat_activity where pid=%s',(second.info.backend_pid,)).fetchone()
                c.execute('set role service_role')
                if wait and wait[0]=='Lock':break
            else:raise AssertionError('contender did not reach session lock')
            first.execute('commit'); assert future.result(timeout=5) is None
        passed('two real connections serialize takeover behind fenced transaction')

        # Unique initial identity also arbitrates simultaneous HTTP requests that
        # both passed read-only preflight before either inserted its session.
        identity={'actorId':str(uuid.uuid4()),'id':str(uuid.uuid4()),'fingerprint':'frozen','sipUri':'sip:frozen@example.invalid'}
        def concurrent_start(_):
            with conn() as client:
                client.execute('set role service_role'); headers(client)
                try:
                    client.execute('insert into motorist_call_sessions(id,organization_id,metadata) values(%s,%s,%s)',
                      (str(uuid.uuid4()),ORG,Jsonb({'initial_operation':identity})))
                    return True
                except psycopg.errors.UniqueViolation:return False
        with ThreadPoolExecutor(max_workers=20) as pool:
            assert sum(pool.map(concurrent_start,range(20)))==1
        passed('20 simultaneous initial requests insert one frozen operation/session')

        binary=ROOT/'.context/telephony-execution/bin/postgrest'
        if not binary.exists():
            raise AssertionError('PostgREST binary missing: HTTP header fencing remains unverified')
        with socket.socket() as port_socket:
            port_socket.bind(('127.0.0.1',0)); port=port_socket.getsockname()[1]
        env={**os.environ,'PGRST_DB_URI':f'postgresql://postgres@127.0.0.1:55432/{NAME}',
          'PGRST_DB_SCHEMAS':'public','PGRST_DB_ANON_ROLE':'service_role','PGRST_SERVER_HOST':'127.0.0.1','PGRST_SERVER_PORT':str(port)}
        server=subprocess.Popen([str(binary)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        def http(path,body=None,extra=None,method='POST'):
            request=urllib.request.Request(f'http://127.0.0.1:{port}'+path,data=json.dumps(body).encode() if body is not None else None,
              headers={'Content-Type':'application/json',**(extra or {})},method=method)
            try:
                with urllib.request.urlopen(request,timeout=5) as response:return response.status,json.loads(response.read() or 'null')
            except urllib.error.HTTPError as error:return error.code,json.loads(error.read() or 'null')
        try:
            for _ in range(100):
                try:
                    status,_=http('/',method='GET')
                    if status==200:break
                except urllib.error.URLError:pass
                if server.poll() is not None:raise AssertionError('PostgREST exited during startup')
                time.sleep(.05)
            else:raise AssertionError('PostgREST did not start')
            c.execute('reset role'); expire(c); c.execute('set role service_role')
            status,claim=http('/rpc/motorist_session_lease_acquire_v2',{'p_session_id':SID,'p_token':'HTTP'}, {'x-telephony-writer':'2'})
            assert status==200 and claim['contract']==2,(status,claim)
            h={'x-telephony-writer':'2','x-telephony-session':SID,'x-telephony-token':'HTTP','x-telephony-generation':str(claim['generation'])}
            assert http('/motorist_call_sessions?id=eq.'+SID,{'version':20},method='PATCH')[0]==409
            assert http('/motorist_call_sessions?id=eq.'+SID,{'version':20},h,method='PATCH')[0]==204
            stale={**h,'x-telephony-generation':str(claim['generation']-1)}
            assert http('/motorist_call_sessions?id=eq.'+SID,{'version':21},stale,method='PATCH')[0]==409
            assert http('/motorist_call_legs',{'session_id':SID},stale)[0]==409
            assert http('/motorist_call_legs',{'session_id':SID},h)[0]==201
            passed('PostgREST real request.headers reject legacy/stale PATCH and child INSERT')
        finally:
            server.terminate()
            try:server.wait(timeout=5)
            except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)

finally:
    with psycopg.connect(BASE+' dbname=postgres',autocommit=True) as setup:
        setup.execute('drop database '+NAME+' with (force)')
