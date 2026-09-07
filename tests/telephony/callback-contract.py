"""Isolated PostgreSQL callback contracts, not a Supabase reset or live QA.
Run: python3 tests/telephony/callback-contract.py
Uses only loopback PostgreSQL on port 55432 and a dedicated temporary database.
"""
from pathlib import Path
import json
import threading
import time
import uuid
import psycopg
from psycopg.types.json import Jsonb

DATABASE = 'callbacks_contract'
DSN = f'host=127.0.0.1 port=55432 user=postgres dbname={DATABASE}'
with psycopg.connect('host=127.0.0.1 port=55432 user=postgres dbname=postgres', autocommit=True) as bootstrap:
    if not bootstrap.execute('select 1 from pg_database where datname=%s', (DATABASE,)).fetchone():
        bootstrap.execute(f'create database {DATABASE}')
conn = psycopg.connect(DSN, autocommit=True)
# This is a dedicated fixture database only, never a configured application DB.
conn.execute('drop schema public cascade; create schema public')
for role in ('anon', 'authenticated', 'service_role'):
    conn.execute(f"do $$ begin if not exists(select 1 from pg_roles where rolname='{role}') then create role {role}; end if; end $$")
conn.execute('''
create table motorist_profiles(id uuid primary key,organization_id uuid,active boolean default true,role text);
create table motorist_call_sessions(id uuid primary key,organization_id uuid,direction text,caller_number text,called_number text,line_id uuid,case_id uuid,answered_by_profile_id uuid,started_at timestamptz,state text,metadata jsonb default '{}');
create table motorist_calls(id uuid primary key,organization_id uuid,direction text,caller_number text,called_number text,destination_number text,line_id uuid,case_id uuid,session_id uuid);
create table motorist_callback_requests(id uuid primary key default gen_random_uuid(),organization_id uuid,caller_number text,caller_name text,source text,status text default 'open',session_id uuid,line_id uuid,case_id uuid,claimed_by uuid,claimed_at timestamptz,due_at timestamptz,resolved_at timestamptz,notes text,metadata jsonb default '{}',created_at timestamptz default now(),updated_at timestamptz default now());
create table motorist_case_tasks(id uuid primary key default gen_random_uuid(),organization_id uuid,case_id uuid,title text,kind text,status text,due_at timestamptz,assigned_to uuid,priority text,completed_at timestamptz,completed_by uuid);
create table motorist_audit_log(id uuid primary key default gen_random_uuid(),organization_id uuid,actor_profile_id uuid,action text,entity_type text,entity_id uuid,source text,before_payload jsonb,after_payload jsonb);
''')
conn.execute(Path('supabase/migrations/20260928120000_callback_contact_fulfillment.sql').read_text())
org, other_org, actor, actor2, line, other_line, case, other_case, session = [uuid.uuid4() for _ in range(9)]
conn.execute('insert into motorist_profiles(id,organization_id,role) values(%s,%s,\'dispatcher\'),(%s,%s,\'dispatcher\')',(actor,org,actor2,org))
proof = {'version':1,'id':'proof-1','sessionId':str(session),'occurredAt':'2026-09-07T10:01:00Z','scope':{'organizationId':str(org),'caseId':str(case),'lineId':str(line),'customerNumber':'+421900123456','startedAt':'2026-09-07T10:00:00Z','callbackRequestId':None}}
conn.execute("insert into motorist_call_sessions values(%s,%s,'inbound','+421 900 123 456',null,%s,%s,%s,'2026-09-07T10:00:00Z','ended',%s)",(session,org,line,case,actor,Jsonb({'callback_contact':{'proofs':[proof]}})))

def request(**overrides):
    values = dict(id=uuid.uuid4(),organization_id=org,caller_number='+421900123456',line_id=line,case_id=case,created_at='2026-09-07T09:00:00Z',status='open',metadata=Jsonb({}))
    values.update(overrides)
    if isinstance(values['metadata'],dict): values['metadata']=Jsonb(values['metadata'])
    cols=','.join(values); holders=','.join(['%s']*len(values))
    conn.execute(f'insert into motorist_callback_requests({cols}) values({holders})',list(values.values()))
    return values['id']

def reconcile(sid=session, p=proof):
    return conn.execute('select motorist_reconcile_callback_contact_v1(%s,%s,%s)',(org,sid,Jsonb(p))).fetchone()[0]

def status(rid): return conn.execute('select status from motorist_callback_requests where id=%s',(rid,)).fetchone()[0]

task=uuid.uuid4(); protected_task=uuid.uuid4()
conn.execute("insert into motorist_case_tasks(id,organization_id,case_id,kind,status) values(%s,%s,%s,'callback','open'),(%s,%s,%s,'callback','open')",(task,org,case,protected_task,org,case))
old=request(claimed_by=actor2,metadata={'task_id':str(task)})
shared=request(metadata={'task_id':str(protected_task)})
new=request(created_at='2026-09-07T10:00:01Z',metadata={'task_id':str(protected_task)})
foreign=[request(organization_id=other_org),request(line_id=other_line),request(case_id=other_case),request(caller_number='anonymous')]
assert set(reconcile())=={str(old),str(shared)}
assert status(old)=='done' and all(status(r)=='open' for r in [new,*foreign])
assert conn.execute('select claimed_by from motorist_callback_requests where id=%s',(old,)).fetchone()[0]==actor2
assert conn.execute('select status from motorist_case_tasks where id=%s',(task,)).fetchone()[0]=='done'
assert conn.execute('select status from motorist_case_tasks where id=%s',(protected_task,)).fetchone()[0]=='open'
assert reconcile()==[]
assert conn.execute('select count(*) from motorist_audit_log where entity_id=%s',(old,)).fetchone()[0]==1
print('PASS CB-01/03/04/08/10: atomic historical resolution, scope/cutoff/claim/task preservation and replay')

# Transaction rollback at the audit boundary, then retry after session already ended.
failure=request()
conn.execute("create function fail_audit() returns trigger language plpgsql as $$ begin raise exception 'injected audit failure'; end $$; create trigger injected before insert on motorist_audit_log for each row execute function fail_audit()")
try: reconcile(); raise AssertionError('expected audit failure')
except psycopg.errors.RaiseException: pass
assert status(failure)=='open'
conn.execute('drop trigger injected on motorist_audit_log')
assert str(failure) in reconcile() and status(failure)=='done'
print('PASS CB-11: request rolls back on audit failure; terminal proof retry completes atomically')

# Delayed session case edits cannot replace the original contact's scope, and
# requests moved to another case are skipped rather than forced back.
changed_case=request(); same_original_case=request()
conn.execute('update motorist_callback_requests set case_id=%s where id=%s',(other_case,changed_case))
conn.execute('update motorist_call_sessions set case_id=%s where id=%s',(other_case,session))
assert reconcile()==[str(same_original_case)] and status(changed_case)=='open'
conn.execute('update motorist_call_sessions set case_id=%s where id=%s',(case,session))
print('PASS CB-03/08: immutable proof scope survives later session/request case edits')


# Exact outbound link permits fallback line but rejects done and active duplicate.
outbound=uuid.uuid4(); exact=request(); outbound_proof={**proof,'id':'proof-out','sessionId':str(outbound),'scope':{**proof['scope'],'callbackRequestId':str(exact),'lineId':str(other_line)}}
conn.execute("insert into motorist_call_sessions values(%s,%s,'outbound','+421900999999','+421900123456',%s,%s,%s,'2026-09-07T10:00:00Z','talking',%s)",(outbound,org,other_line,case,actor,Jsonb({'callbackRequestId':str(exact),'callback_contact':{'proofs':[outbound_proof]}})))
conn.execute('update motorist_callback_requests set claimed_by=%s where id=%s',(actor,exact))
assert conn.execute('select motorist_link_callback_outbound_v1(%s,%s,%s,%s)',(org,exact,outbound,actor)).fetchone()[0]
assert reconcile(outbound,outbound_proof)==[str(exact)]
assert not conn.execute('select motorist_link_callback_outbound_v1(%s,%s,%s,%s)',(org,exact,outbound,actor)).fetchone()[0]
print('PASS CB-02/07/09: pre-dial exact fallback-line binding and no authorization after done')

# Unknown-case ambiguity remains open.
null_session=uuid.uuid4(); null_proof={**proof,'sessionId':str(null_session),'scope':{**proof['scope'],'caseId':None}}
conn.execute("insert into motorist_call_sessions values(%s,%s,'inbound','+421900123456',null,%s,null,%s,'2026-09-07T10:00:00Z','ended',%s)",(null_session,org,line,actor,Jsonb({'callback_contact':{'proofs':[null_proof]}})))
null_request=request(case_id=None)
assert reconcile(null_session,null_proof)==[] and status(null_request)=='open'

# Separate joins, including an undelivered leave gap, never authorize done.
# Only a captured single-page provider pair can fulfill after the call ended.
conference_session,conference_case,conference_id=uuid.uuid4(),uuid.uuid4(),uuid.uuid4()
conference_proof={**proof,'id':'conference-proof','sessionId':str(conference_session),'topology':'conference','conferenceId':str(conference_id),
    'customerControlId':'customer-cc','operatorControlId':'operator-cc','scope':{**proof['scope'],'caseId':str(conference_case),'customerNumber':'+421900222222'}}
conn.execute("insert into motorist_call_sessions values(%s,%s,'inbound','+421900222222',null,%s,%s,%s,'2026-09-07T10:00:00Z','ended','{}')",(conference_session,org,line,conference_case,actor))
conference_request=request(case_id=conference_case,caller_number='+421900222222')
def persist_conference_proof(value):
    conn.execute('update motorist_call_sessions set metadata=%s where id=%s',(Jsonb({'callback_contact':{'proofs':[value]}}),conference_session))
persist_conference_proof(conference_proof)
assert reconcile(conference_session,conference_proof)==[] and status(conference_request)=='open'
participants=[{'id':f'participant-{control}','callControlId':control,'callLegId':f'leg-{control}','status':'joined','muted':False,'onHold':False,'whisperCallControlIds':[]} for control in ('customer-cc','operator-cc')]
conference_proof['conferenceSnapshot']={'source':'telnyx_conference_participants_v1','conferenceId':str(conference_id),'requestedAt':proof['occurredAt'],'observedAt':proof['occurredAt'],'participants':[participants[1]]}
persist_conference_proof(conference_proof)
assert reconcile(conference_session,conference_proof)==[] and status(conference_request)=='open'
for missing in ('status','muted','onHold','whisperCallControlIds','callLegId'):
    malformed={k:v for k,v in participants[0].items() if k!=missing}
    conference_proof['conferenceSnapshot']['participants']=[malformed,participants[1]]
    persist_conference_proof(conference_proof)
    assert reconcile(conference_session,conference_proof)==[] and status(conference_request)=='open'
conference_proof['conferenceSnapshot']['participants']=participants
persist_conference_proof(conference_proof)
assert reconcile(conference_session,conference_proof)==[str(conference_request)] and status(conference_request)=='done'
assert reconcile(conference_session,conference_proof)==[]
print('PASS CB-06/08/11: absent/incomplete conference snapshots never fulfill; exact captured pair fulfills once after terminal')

# Explicit schedule has its own action id, works without case and leaves historical tasks alone.
call=uuid.uuid4(); action=uuid.uuid4()
conn.execute("insert into motorist_calls(id,organization_id,direction,caller_number,line_id) values(%s,%s,'inbound','+421900888888',%s)",(call,org,line))
def schedule(action_id): return conn.execute('select motorist_schedule_callback_v1(%s,%s,%s,%s,%s)',(org,call,actor,action_id,'2026-09-07T11:00:00Z')).fetchone()[0]
scheduled=schedule(action); assert schedule(action)['id']==scheduled['id'] and scheduled['case_id'] is None
second_action=uuid.uuid4(); assert schedule(second_action)['id']==scheduled['id']
conn.execute("select motorist_resolve_callback_v1(%s,%s,%s,'done')",(org,scheduled['id'],actor))
assert schedule(action)['id']==scheduled['id']
assert schedule(uuid.uuid4())['id']!=scheduled['id']
print('PASS CB-14: no-case schedule, idempotent action, live update, fresh obligation after done')

# Root transition creator commits request and promised task together.
created_session=uuid.uuid4()
conn.execute("insert into motorist_call_sessions values(%s,%s,'inbound','+421900777777',null,%s,%s,null,'2026-09-07T10:00:00Z','ended','{}')",(created_session,org,line,case))
plan={'source':'missed','callerNumber':'+421900777777','createTask':True}
def create_obligation():
    return conn.execute('select motorist_create_callback_obligation_v1(%s,%s,%s,%s)',(org,created_session,Jsonb(plan),'2026-09-07T10:02:00Z')).fetchone()[0]
conn.execute("create function fail_task() returns trigger language plpgsql as $$ begin raise exception 'injected task failure'; end $$; create trigger injected_task before insert on motorist_case_tasks for each row execute function fail_task()")
try: create_obligation(); raise AssertionError('expected task failure')
except psycopg.errors.RaiseException: pass
assert conn.execute('select count(*) from motorist_callback_requests where session_id=%s',(created_session,)).fetchone()[0]==0
conn.execute('drop trigger injected_task on motorist_case_tasks')
created=create_obligation(); assert created['metadata']['task_id']
assert create_obligation()['id']==created['id']
conn.execute("select motorist_resolve_callback_v1(%s,%s,%s,'done')",(org,created['id'],actor))
assert create_obligation()['status']=='done'
assert conn.execute('select status from motorist_case_tasks where id=%s',(created['metadata']['task_id'],)).fetchone()[0]=='done'
print('PASS RC-03/CB-10/14: atomic creator/task rollback, exact link, replay after done never resurrects obligation')

# The service-only RPC also rejects unusable explicit choices directly, even
# when an older session request exists. Automatic unknown-number accounting skips.
for bad_number in ('anonymous','sip:anonymous@invalid','+123','<script>123</script>'):
    invalid_plan={'source':'ivr','callerNumber':bad_number,'createTask':False,'request':{'kind':'requested','event_id':'invalid-choice','digit':'2','context':'ivr','requested_at':'2026-09-07T10:02:00Z'}}
    try:
        conn.execute('select motorist_create_callback_obligation_v1(%s,%s,%s,%s)',(org,created_session,Jsonb(invalid_plan),'2026-09-07T10:02:00Z'))
        raise AssertionError('explicit invalid caller must not return a success/no-op')
    except psycopg.errors.RaiseException: pass
    invalid_plan.pop('request')
    assert conn.execute('select motorist_create_callback_obligation_v1(%s,%s,%s,%s)',(org,created_session,Jsonb(invalid_plan),'2026-09-07T10:02:00Z')).fetchone()[0] is None
print('PASS IVR/CB-14: RPC rejects explicit unusable numbers and never reports a silent successful choice')


# A missed obligation failed at t0; another contact completed at t1 before the
# original obligation existed. Retrying the creator at t2 must discover t1.
late_missed,later_contact=uuid.uuid4(),uuid.uuid4()
late_number='+421900555555'
conn.execute("insert into motorist_call_sessions values(%s,%s,'inbound',%s,null,%s,%s,null,'2026-09-07T09:58:00Z','ended','{}')",(late_missed,org,late_number,line,case))
late_plan={'source':'missed','callerNumber':late_number,'createTask':True}
def create_late(): return conn.execute('select motorist_create_callback_obligation_v1(%s,%s,%s,%s)',(org,late_missed,Jsonb(late_plan),'2026-09-07T09:59:00Z')).fetchone()[0]
conn.execute('create trigger injected_task before insert on motorist_case_tasks for each row execute function fail_task()')
try: create_late(); raise AssertionError('expected first missed write to fail')
except psycopg.errors.RaiseException: pass
conn.execute('drop trigger injected_task on motorist_case_tasks')
late_proof={**proof,'id':'later-contact','sessionId':str(later_contact),'scope':{**proof['scope'],'customerNumber':late_number}}
conn.execute("insert into motorist_call_sessions values(%s,%s,'inbound',%s,null,%s,%s,%s,'2026-09-07T10:00:00Z','ended',%s)",(later_contact,org,late_number,line,case,actor,Jsonb({'callback_contact':{'version':1,'proofs':[late_proof]}})))
assert reconcile(later_contact,late_proof)==[]
# A pre-snapshot inferred conference record must not consume the bounded first
# eligible-contact slot and hide the later valid contact.
unverified_contact=uuid.uuid4()
unverified_proof={**late_proof,'id':'old-inferred-conference','sessionId':str(unverified_contact),'topology':'conference',
    'scope':{**late_proof['scope'],'startedAt':'2026-09-07T09:59:30Z'}}
conn.execute("insert into motorist_call_sessions values(%s,%s,'inbound',%s,null,%s,%s,%s,'2026-09-07T09:59:30Z','ended',%s)",(unverified_contact,org,late_number,line,case,actor,Jsonb({'callback_contact':{'version':1,'proofs':[unverified_proof]}})))
late=create_late()
assert late['status']=='done' and late['created_at'].startswith('2026-09-07T09:59:00')
assert conn.execute('select status from motorist_case_tasks where id=%s',(late['metadata']['task_id'],)).fetchone()[0]=='done'
assert create_late()['id']==late['id']
print('PASS CB-04/11: late missed-write recovery rechecks earlier completed contact, preserving original obligation time')



# Two real clients contend for the same request; locked claimant beats manual done.
race=request(); first=psycopg.connect(DSN); second=psycopg.connect(DSN)
first.execute('update motorist_callback_requests set claimed_by=%s where id=%s',(actor2,race))
started=threading.Event(); outcome=[]
def resolve_race():
    started.set()
    try:
        second.execute("select motorist_resolve_callback_v1(%s,%s,%s,'done')",(org,race,actor)); second.commit(); outcome.append('resolved')
    except psycopg.errors.RaiseException: second.rollback(); outcome.append('claim-won')
thread=threading.Thread(target=resolve_race); thread.start(); assert started.wait(3); first.commit(); thread.join(5)
assert outcome==['claim-won'] and status(race)=='open'
first.close(); second.close()
for role in ('anon','authenticated'):
    for fn in ('motorist_resolve_callback_v1(uuid,uuid,uuid,text,jsonb,text)','motorist_reconcile_callback_contact_v1(uuid,uuid,jsonb)','motorist_link_callback_outbound_v1(uuid,uuid,uuid,uuid)','motorist_schedule_callback_v1(uuid,uuid,uuid,uuid,timestamp with time zone)'):
        assert conn.execute('select has_function_privilege(%s,%s,\'EXECUTE\')',(role,fn)).fetchone()[0] is False
print('PASS CB-09: two-connection claim/resolve contention; service-only mutation grants')

def contend(first_action, second_action):
    """Hold the actual row lock until the competing backend is observed waiting."""
    a,b=psycopg.connect(DSN),psycopg.connect(DSN)
    loser=[];errors=[]
    try:
        winner=first_action(a)
        def run_second():
            try: loser.append(second_action(b));b.commit()
            except Exception as error: errors.append(error);b.rollback()
        worker=threading.Thread(target=run_second);worker.start()
        deadline=time.monotonic()+5
        while not conn.execute('select pg_blocking_pids(%s)',(b.info.backend_pid,)).fetchone()[0]:
            assert time.monotonic()<deadline and not errors,'competing transaction did not reach row lock'
        a.commit();worker.join(5)
        assert not worker.is_alive() and not errors and len(loser)==1,errors
        return winner,loser[0]
    finally: a.close();b.close()

# Manual done, cancel and automatic fulfillment must serialize in either order.
# All six winners preserve the claimant and emit exactly one final audit/task effect.
for first_kind,second_kind in [('done','cancelled'),('cancelled','done'),('done','auto'),('auto','done'),('cancelled','auto'),('auto','cancelled')]:
    race_session,race_case,race_task=uuid.uuid4(),uuid.uuid4(),uuid.uuid4()
    race_proof={**proof,'id':f'{first_kind}-{second_kind}','sessionId':str(race_session),'scope':{**proof['scope'],'caseId':str(race_case),'customerNumber':'+421900111111'}}
    conn.execute("insert into motorist_call_sessions values(%s,%s,'inbound','+421900111111',null,%s,%s,%s,'2026-09-07T10:00:00Z','ended',%s)",(race_session,org,line,race_case,actor,Jsonb({'callback_contact':{'proofs':[race_proof]}})))
    conn.execute("insert into motorist_case_tasks(id,organization_id,case_id,kind,status) values(%s,%s,%s,'callback','open')",(race_task,org,race_case))
    race_request=request(caller_number='+421900111111',case_id=race_case,claimed_by=actor2,metadata={'task_id':str(race_task)})
    def finish(client,kind):
        if kind=='auto': return client.execute('select motorist_reconcile_callback_contact_v1(%s,%s,%s)',(org,race_session,Jsonb(race_proof))).fetchone()[0]
        return client.execute('select motorist_resolve_callback_v1(%s,%s,%s,%s)',(org,race_request,actor2,kind)).fetchone()[0]
    contend(lambda client:finish(client,first_kind),lambda client:finish(client,second_kind))
    expected='done' if first_kind=='auto' else first_kind
    assert status(race_request)==expected
    assert conn.execute('select claimed_by from motorist_callback_requests where id=%s',(race_request,)).fetchone()[0]==actor2
    assert conn.execute('select count(*) from motorist_audit_log where entity_id=%s',(race_request,)).fetchone()[0]==1
    assert conn.execute('select status from motorist_case_tasks where id=%s',(race_task,)).fetchone()[0]==('done' if expected=='done' else 'open')
    finish(conn,first_kind);finish(conn,second_kind)
    assert status(race_request)==expected and conn.execute('select count(*) from motorist_audit_log where entity_id=%s',(race_request,)).fetchone()[0]==1
print('PASS CB-09: all six real done/cancel/automatic lock orders preserve one audit, claimant and exact task result')

# A competing successful contact must not steal an explicitly active outbound
# callback; conversely, done winning first must prohibit the outbound pre-dial link.
for link_first in (True,False):
    inbound_session,outbound_session,owned_case=uuid.uuid4(),uuid.uuid4(),uuid.uuid4()
    owned_proof={**proof,'id':'competing-contact','sessionId':str(inbound_session),'scope':{**proof['scope'],'caseId':str(owned_case),'customerNumber':'+421900101010'}}
    conn.execute("insert into motorist_call_sessions values(%s,%s,'inbound','+421900101010',null,%s,%s,%s,'2026-09-07T10:00:00Z','ended',%s)",(inbound_session,org,line,owned_case,actor,Jsonb({'callback_contact':{'proofs':[owned_proof]}})))
    conn.execute("insert into motorist_call_sessions values(%s,%s,'outbound','+421900999999','+421900101010',%s,%s,%s,'2026-09-07T10:00:00Z','talking','{}')",(outbound_session,org,line,owned_case,actor2))
    owned_request=request(caller_number='+421900101010',case_id=owned_case,claimed_by=actor2)
    conn.execute('update motorist_call_sessions set metadata=%s where id=%s',(Jsonb({'callbackRequestId':str(owned_request)}),outbound_session))
    def own(client): return client.execute('select motorist_link_callback_outbound_v1(%s,%s,%s,%s)',(org,owned_request,outbound_session,actor2)).fetchone()[0]
    def competing_contact(client): return client.execute('select motorist_reconcile_callback_contact_v1(%s,%s,%s)',(org,inbound_session,Jsonb(owned_proof))).fetchone()[0]
    winner,loser=contend(own if link_first else competing_contact,competing_contact if link_first else own)
    if link_first:
        assert winner is True and loser==[] and status(owned_request)=='open'
        assert conn.execute('select count(*) from motorist_audit_log where entity_id=%s',(owned_request,)).fetchone()[0]==0
        assert conn.execute('select metadata from motorist_callback_requests where id=%s',(owned_request,)).fetchone()[0]['callback_call']['session_id']==str(outbound_session)
        assert not conn.execute('select motorist_link_callback_outbound_v1(%s,%s,%s,%s)',(org,owned_request,inbound_session,actor)).fetchone()[0]
    else:
        assert winner==[str(owned_request)] and loser is False and status(owned_request)=='done'
        assert conn.execute('select count(*) from motorist_audit_log where entity_id=%s',(owned_request,)).fetchone()[0]==1
    assert conn.execute('select claimed_by from motorist_callback_requests where id=%s',(owned_request,)).fetchone()[0]==actor2
print('PASS CB-09: both real outbound-link/automatic-contact lock orders preserve active ownership or deny dial after done')

for first_index in (0,1):
    owner_case=uuid.uuid4(); outbound_ids=[uuid.uuid4(),uuid.uuid4()]
    owned_request=request(caller_number='+421900121212',case_id=owner_case,claimed_by=actor2)
    for outbound_id in outbound_ids:
        conn.execute("insert into motorist_call_sessions values(%s,%s,'outbound','+421900999999','+421900121212',%s,%s,%s,'2026-09-07T10:00:00Z','calling','{}')",(outbound_id,org,line,owner_case,actor2))
        conn.execute('update motorist_call_sessions set metadata=%s where id=%s',(Jsonb({'callbackRequestId':str(owned_request)}),outbound_id))
    def link(client,index): return client.execute('select motorist_link_callback_outbound_v1(%s,%s,%s,%s)',(org,owned_request,outbound_ids[index],actor2)).fetchone()[0]
    winner,loser=contend(lambda client:link(client,first_index),lambda client:link(client,1-first_index))
    assert winner is True and loser is False and status(owned_request)=='open'
    assert conn.execute('select metadata from motorist_callback_requests where id=%s',(owned_request,)).fetchone()[0]['callback_call']['session_id']==str(outbound_ids[first_index])
    assert link(conn,first_index) is True and link(conn,1-first_index) is False
    assert conn.execute('select claimed_by from motorist_callback_requests where id=%s',(owned_request,)).fetchone()[0]==actor2
print('PASS CB-09: both real competing outbound-start lock orders grant exactly one active pre-dial ownership')

# Manual scheduling and automatic creation share the same session lock. Exercise
# both lock winners and observe the real backend blocked before releasing it.
for auto_first in (False,True):
    same_session,same_call,same_action,same_case=uuid.uuid4(),uuid.uuid4(),uuid.uuid4(),uuid.uuid4()
    conn.execute("insert into motorist_call_sessions values(%s,%s,'inbound','+421900444444',null,%s,%s,null,'2026-09-07T10:00:00Z','ended','{}')",(same_session,org,line,same_case))
    conn.execute("insert into motorist_calls(id,organization_id,direction,caller_number,line_id,session_id,case_id) values(%s,%s,'inbound','+421900444444',%s,%s,%s)",(same_call,org,line,same_session,same_case))
    a,b=psycopg.connect(DSN),psycopg.connect(DSN)
    def issue(client,automatic):
        if automatic: return client.execute('select motorist_create_callback_obligation_v1(%s,%s,%s,%s)',(org,same_session,Jsonb({'source':'missed','callerNumber':'+421900444444','createTask':True}),'2026-09-07T10:01:00Z')).fetchone()[0]
        return client.execute('select motorist_schedule_callback_v1(%s,%s,%s,%s,%s)',(org,same_call,actor,same_action,'2026-09-07T10:31:00Z')).fetchone()[0]
    winner=issue(a,auto_first); loser=[]
    def competing_create():
        loser.append(issue(b,not auto_first));b.commit()
    worker=threading.Thread(target=competing_create);worker.start()
    deadline=time.monotonic()+5
    while not conn.execute('select pg_blocking_pids(%s)',(b.info.backend_pid,)).fetchone()[0]:
        assert time.monotonic()<deadline,'expected real advisory lock contention'
    a.commit();worker.join(5)
    assert loser and loser[0]['id']==winner['id']
    assert conn.execute("select count(*) from motorist_callback_requests where session_id=%s and status in ('open','scheduled')",(same_session,)).fetchone()[0]==1
    final=conn.execute('select metadata from motorist_callback_requests where id=%s',(winner['id'],)).fetchone()[0]
    assert final.get('task_id')
    assert conn.execute('select count(*) from motorist_case_tasks where case_id=%s',(same_case,)).fetchone()[0]==1
    replay=issue(conn,True);assert replay['metadata']['task_id']==final['task_id']
    conn.execute("select motorist_resolve_callback_v1(%s,%s,%s,'done')",(org,winner['id'],actor))
    assert issue(conn,True)['status']=='done'
    assert conn.execute('select count(*) from motorist_case_tasks where case_id=%s',(same_case,)).fetchone()[0]==1
    assert conn.execute('select status from motorist_case_tasks where id=%s',(final['task_id'],)).fetchone()[0]=='done'
    a.close();b.close()
print('PASS CB-09/14: both real lock orderings produce one request and exact promised task; replay never duplicates/resurrects')

# Adding the promised task to a request that scheduling already committed is
# equally atomic: a task failure preserves the manual row and its choice audit.
manual_session,manual_call,manual_case=uuid.uuid4(),uuid.uuid4(),uuid.uuid4()
conn.execute("insert into motorist_call_sessions values(%s,%s,'inbound','+421900333333',null,%s,%s,null,'2026-09-07T10:00:00Z','ended','{}')",(manual_session,org,line,manual_case))
conn.execute("insert into motorist_calls(id,organization_id,direction,caller_number,line_id,session_id,case_id) values(%s,%s,'inbound','+421900333333',%s,%s,%s)",(manual_call,org,line,manual_session,manual_case))
manual=conn.execute('select motorist_schedule_callback_v1(%s,%s,%s,%s,%s)',(org,manual_call,actor,uuid.uuid4(),'2026-09-07T11:00:00Z')).fetchone()[0]
manual_plan={'source':'missed','callerNumber':'+421900333333','createTask':True}
def attach_manual_task():
    return conn.execute('select motorist_create_callback_obligation_v1(%s,%s,%s,%s)',(org,manual_session,Jsonb(manual_plan),'2026-09-07T10:01:00Z')).fetchone()[0]
conn.execute('create trigger injected_task before insert on motorist_case_tasks for each row execute function fail_task()')
try: attach_manual_task();raise AssertionError('expected existing request task failure')
except psycopg.errors.RaiseException: pass
assert conn.execute('select metadata from motorist_callback_requests where id=%s',(manual['id'],)).fetchone()[0]==manual['metadata']
assert conn.execute('select count(*) from motorist_case_tasks where case_id=%s',(manual_case,)).fetchone()[0]==0
conn.execute('drop trigger injected_task on motorist_case_tasks')
attached=attach_manual_task();assert attached['id']==manual['id'] and attached['metadata']['task_id']
assert attach_manual_task()['metadata']['task_id']==attached['metadata']['task_id']
assert conn.execute('select count(*) from motorist_case_tasks where case_id=%s',(manual_case,)).fetchone()[0]==1
print('PASS RC-03: existing scheduled request task failure rolls back and retries one exact linked task')


conn.execute("insert into motorist_callback_requests(organization_id,caller_number,line_id,created_at,status) select %s,'+4219'||lpad(n::text,8,'0'),%s,now(),'open' from generate_series(1,10000) n",(org,line))
conn.execute('analyze motorist_callback_requests')
plan=conn.execute("explain (analyze,format json) select id from motorist_callback_requests where organization_id=%s and public.motorist_callback_number(caller_number)='421900123456' and line_id=%s and status in ('open','scheduled') and created_at<='2026-09-07T10:00:00Z'",(org,line)).fetchone()[0]
assert 'callback_requests_contact_candidates_v1_idx' in json.dumps(plan),plan
exact_plan=conn.execute('explain (format json) select * from motorist_callback_requests where id=%s',(old,)).fetchone()[0]
assert 'motorist_callback_requests_pkey' in json.dumps(exact_plan)
print('PASS CB-13: 10,000-row EXPLAIN uses partial contact index; exact link uses primary key')
print(json.dumps(plan))
conn.execute("insert into motorist_call_sessions(id,organization_id,direction,caller_number,line_id,started_at,metadata) select gen_random_uuid(),%s,'inbound','+4218'||lpad(n::text,8,'0'),%s,now(),%s from generate_series(1,10000)n",(org,line,Jsonb({'callback_contact':{'proofs':[proof]}})))
conn.execute('analyze motorist_call_sessions')
reverse_plan=conn.execute("explain(format json) select id from motorist_call_sessions where organization_id=%s and public.motorist_callback_number(case when direction='outbound' then called_number else caller_number end)='421900555555' and line_id=%s and started_at>='2026-09-07T09:59:00Z' and (metadata->'callback_contact'->'proofs') @> '[{\"version\":1}]'::jsonb order by started_at limit 1",(org,line)).fetchone()[0]
assert 'callback_completed_contact_sessions_v1_idx' in json.dumps(reverse_plan)
print('PASS CB-13: reverse recovery uses partial contact-session index over 10,000 synthetic contacts')
conn.close()
