#!/usr/bin/env python3
"""Journey JSON through exact fenced critical-write SQL; disposable loopback DB.

This verifies PostgreSQL persistence/rollback/CAS, not hosted RLS or provider audio.
Run: LOCAL_PG_PORT=55436 python3 tests/postgres/call-journey-persistence.py
"""
from pathlib import Path
from uuid import uuid4
import json
import os
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host='127.0.0.1', hostaddr='127.0.0.1', port=int(os.environ.get('LOCAL_PG_PORT', '55436')), user='postgres', connect_timeout=5)
NAME = 'journey_persistence_' + uuid4().hex[:12]
ORG, SID, LEG, ATTEMPT = [str(uuid4()) for _ in range(4)]
checks = []
def check(label, value):
    assert value, label
    checks.append(label)
def headers(c, token=None, generation=None):
    value = {'x-telephony-writer': '2'}
    if token:
        value.update({'x-telephony-session': SID, 'x-telephony-token': token, 'x-telephony-generation': str(generation)})
    c.execute("select set_config('request.headers',%s,false)", (json.dumps(value),))
def write(c, version, patch, legs=None, attempts=None):
    return c.execute('select motorist_apply_critical_v2(%s,%s,%s,%s,%s)', (SID, version, Jsonb(patch), Jsonb(legs or []), Jsonb(attempts or []))).fetchone()[0]
def stored(c):
    return c.execute('select metadata,version from motorist_call_sessions where id=%s', (SID,)).fetchone()

with psycopg.connect(dbname='postgres', autocommit=True, **LOCAL) as admin:
    admin.execute('create database ' + NAME)
try:
    with psycopg.connect(dbname=NAME, autocommit=True, **LOCAL) as c:
        c.execute((ROOT/'tests/postgres/presence-fixture.sql').read_text())
        c.execute('''alter table motorist_call_sessions add lease_token text, add lease_until timestamptz, add direction text default 'inbound';
          alter table motorist_ring_attempts add answered_at timestamptz;
          alter table motorist_ring_attempts add constraint result_check check(result in ('offered','answered','cancelled','no_answer'));
          create table motorist_call_legs(id uuid primary key default gen_random_uuid(), organization_id uuid, session_id uuid,
            telnyx_call_control_id text, telnyx_call_leg_id text, role text, profile_id uuid, to_number text, from_number text,
            state text, hangup_cause text, hangup_source text, initiated_at timestamptz, answered_at timestamptz,
            bridged_at timestamptz, ended_at timestamptz, client_state jsonb default '{}', metadata jsonb default '{}');
          create table motorist_calls(id uuid primary key default gen_random_uuid(), session_id uuid, status text,
            recording_source_revision bigint default 0, updated_at timestamptz default now());
          create table motorist_call_participant_intervals(id uuid primary key default gen_random_uuid(),session_id uuid,metadata jsonb);''')
        for migration in ['20260928100000_atomic_presence_contract.sql', '20260928110000_durable_transition_effects.sql',
                          '20260929200000_fenced_telephony_commands.sql', '20261004100000_apply_critical_rows.sql']:
            c.execute((ROOT/'supabase/migrations'/migration).read_text())
        c.execute('grant select,insert,update,delete on all tables in schema public to service_role')
        c.execute('alter role service_role bypassrls; set role service_role')
        c.execute('update motorist_telephony_writer_rollout set new_session_contract=2')
        headers(c)
        c.execute('insert into motorist_call_sessions(id,organization_id) values(%s,%s)', (SID, ORG))
        claim = c.execute('select motorist_session_lease_acquire_v2(%s,%s)', (SID, 'journey-test')).fetchone()[0]
        headers(c, 'journey-test', claim['generation'])
        c.execute("insert into motorist_call_legs(id,organization_id,session_id,telnyx_call_control_id,role,state) values(%s,%s,%s,'test-customer','customer','answered')", (LEG, ORG, SID))
        c.execute("insert into motorist_ring_attempts(id,session_id,result) values(%s,%s,'offered')", (ATTEMPT, SID))
        entries = [{'id': 'e1:step_enter:0:ringing', 'at': '2026-10-05T10:00:00.000Z', 'kind': 'step_enter', 'stepIndex': 0, 'phase': 'ringing'}]
        frozen = {'source': 'incoming_flow', 'flowSignature': 'flow1-0000000000000000', 'steps': [
            {'index': 0, 'sourceId': str(uuid4()), 'occurrenceId': 'ring:0', 'kind': 'ring'},
            {'index': 1, 'sourceId': str(uuid4()), 'occurrenceId': 'wait:1', 'kind': 'wait', 'waitMinutes': 1}]}
        meta = {'ring': {'plan': frozen, 'active_step': 0}, 'recording': {'keep': 'unrelated'}, 'journey': {'version': 1, 'entries': entries}}
        start = write(c, 0, {'metadata': meta, 'state': 'ringing', 'current_step': 1})
        check('initial journey JSON survives exact critical RPC', start['applied'] and stored(c) == (meta, 1))
        entries.extend([
            {'id': 'e2:step_exit:0:completed', 'at': '2026-10-05T10:00:20.000Z', 'kind': 'step_exit', 'stepIndex': 0, 'reason': 'completed'},
            {'id': 'e2:step_enter:1:waiting', 'at': '2026-10-05T10:00:20.000Z', 'kind': 'step_enter', 'stepIndex': 1, 'phase': 'waiting'}])
        meta['waiting'] = {'flow_step_index': 1, 'since': '2026-10-05T10:00:20.000Z', 'max_minutes': 1}
        meta['ring']['active_step'] = None
        result = write(c, 1, {'metadata': meta, 'state': 'waiting', 'current_step': 2},
                       [{'callControlId': 'test-customer', 'values': {'state': 'held'}}],
                       [{'id': ATTEMPT, 'values': {'result': 'no_answer', 'ended_at': '2026-10-05T10:00:20.000Z'}}])
        check('wait transition atomically persists full evidence and attempt result', result['applied'] and stored(c) == (meta, 2)
              and c.execute('select result from motorist_ring_attempts where id=%s', (ATTEMPT,)).fetchone()[0] == 'no_answer'
              and c.execute('select state from motorist_call_legs where id=%s', (LEG,)).fetchone()[0] == 'held')
        check('unrelated metadata and frozen plan survive transition', stored(c)[0]['recording'] == {'keep': 'unrelated'} and stored(c)[0]['ring']['plan'] == frozen)
        stale = write(c, 1, {'metadata': {'journey': {'version': 1, 'entries': []}}})
        check('stale expected version cannot erase journey', stale == {'applied': False} and stored(c) == (meta, 2))
        try:
            write(c, 2, {'metadata': {'bad': 'must roll back'}},
                  [{'callControlId': 'test-customer', 'values': {'state': 'ended'}}],
                  [{'id': ATTEMPT, 'values': {'result': 'INVALID'}}])
            raise AssertionError('invalid attempt accepted')
        except psycopg.errors.CheckViolation:
            check('later critical child failure rolls back earlier journey and leg changes', stored(c) == (meta, 2)
                  and c.execute('select state from motorist_call_legs where id=%s', (LEG,)).fetchone()[0] == 'held')
        headers(c, 'stale-owner', claim['generation'])
        try:
            write(c, 2, {'metadata': {'bad': 'stale owner'}})
            raise AssertionError('stale ownership accepted')
        except psycopg.Error as error:
            check('ownership fence rejects stale journey writer', error.sqlstate == 'PT409')
        headers(c, 'journey-test', claim['generation'])
        check('rejected owner leaves complete history unchanged', stored(c) == (meta, 2))
        for role in ['anon', 'authenticated']:
            check(role + ' cannot invoke privileged critical writer', not c.execute("select has_function_privilege(%s,'motorist_apply_critical_v2(uuid,integer,jsonb,jsonb,jsonb)','EXECUTE')", (role,)).fetchone()[0])
        with psycopg.connect(dbname=NAME, autocommit=True, **LOCAL) as reader:
            check('new connection reads committed journey with exact timestamps', stored(reader) == (meta, 2))
        print(json.dumps({'checks': len(checks), 'passed': checks}, ensure_ascii=False))
finally:
    with psycopg.connect(dbname='postgres', autocommit=True, **LOCAL) as admin:
        admin.execute('drop database ' + NAME + ' with (force)')
