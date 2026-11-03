"""Isolated PostgreSQL contract test for operation-level positions (Moja práca).

Creates a disposable local cluster on a unix socket, applies every repository
migration over minimal auth/storage/realtime stubs and exercises
motorist_operation_position and the 30-day prune. Never reads PG* variables or
remote DSNs.
Run: python3 tests/postgres/operation-positions.py
"""
import json, os, pathlib, subprocess, tempfile
from datetime import datetime, timedelta, timezone
ROOT = pathlib.Path(__file__).resolve().parents[2]
M = ROOT / 'supabase/migrations'
ORG = '00000000-0000-4000-8000-000000000001'
def uid(n): return f'73000000-0000-4000-8000-{n:012d}'
OFFICE, P, Q, D = (uid(n) for n in (10, 11, 12, 13))
checks = []
STUBS = r"""
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema extensions; create schema auth; create schema storage; create schema realtime;
create extension pgcrypto with schema extensions; create extension citext with schema extensions;
alter database postgres set search_path to "$user", public, extensions;
create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', created_at timestamptz default now(), last_sign_in_at timestamptz, banned_until timestamptz, deleted_at timestamptz, encrypted_password text, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
create function auth.role() returns text language sql stable as $$select null::text$$;
create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[], owner uuid, created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql as $$select string_to_array(name,'/')$$;
create table realtime.messages(id bigserial, topic text, extension text, payload jsonb, event text, private boolean);
create function realtime.topic() returns text language sql stable as $$select null::text$$;
create publication supabase_realtime;
"""
# Unrelated seed rows of this migration reference telephony fixtures absent here.
KNOWN_FIXTURE_GAPS = {'20260926100000_assistance_line_labels.sql'}

with tempfile.TemporaryDirectory(prefix='pm-oppos-pg-') as temp:
    base = pathlib.Path(temp); data = base / 'data'; sock = base / 'sock'; sock.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    subprocess.run(['initdb', '-D', str(data), '--auth=trust', '--no-locale', '--encoding=UTF8'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    subprocess.run(['pg_ctl', '-D', str(data), '-l', str(base / 'server.log'), '-o', f"-k {sock} -h '' -p 56512", '-w', 'start'], env=env, stdout=subprocess.DEVNULL, check=True)
    def psql(args, sql=None, ok=True):
        r = subprocess.run(['psql', '-X', '-h', str(sock), '-p', '56512', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', *args], input=sql, env=env, capture_output=True, text=True)
        if ok and r.returncode: raise AssertionError(r.stderr + '\nSQL:' + (sql or str(args))[:1500])
        return r
    def run(sql, ok=True): return psql([], sql, ok)
    def value(sql):
        out = run(sql).stdout.strip()
        return out.splitlines()[-1] if out else ''
    def j(sql): return json.loads(run(sql).stdout.strip().splitlines()[-1])
    def check(name, condition=True):
        assert condition, name
        checks.append(name)
    def denied(sql, code='42501'):
        r = run("\\set VERBOSITY verbose\n" + sql, False)
        return r.returncode != 0 and code in r.stderr
    serial = [2000]
    def op_cmd(who, action, op=None, payload=None, rev=0):
        serial[0] += 1
        c = {'commandId': uid(serial[0]), 'action': action, 'expectedRevision': rev, 'payload': payload or {}}
        if op: c['operationId'] = op
        return j("select public.motorist_operations_command('%s','%s','%s'::jsonb)" % (who, ORG, json.dumps(c).replace("'", "''")))
    def rev(op): return int(value(f"select revision from motorist_logistics_executions where operation_id='{op}'"))
    def step(who, action, op, payload=None): return op_cmd(who, action, op, payload, rev(op))
    def at(delta_seconds=0): return (datetime.now(timezone.utc) + timedelta(seconds=delta_seconds)).isoformat()
    def position_sql(who, op, lat=48.15, lng=17.11, recorded=None, extra=None):
        body = {'lat': lat, 'lng': lng, 'accuracy': 12.5, 'recordedAt': recorded or at()}
        body.update(extra or {})
        return "select public.motorist_operation_position('%s','%s','%s','%s'::jsonb)" % (who, ORG, op, json.dumps(body))
    def position(*a, **k): return j(position_sql(*a, **k))
    def stored(op): return int(value(f"select count(*) from motorist_operation_positions where operation_id='{op}'"))
    try:
        run(STUBS)
        for f in sorted(M.glob('*.sql')):
            r = psql(['-q', '-f', str(f)], ok=False)
            if r.returncode and f.name not in KNOWN_FIXTURE_GAPS: raise AssertionError(f'{f.name}: {r.stderr[-1500:]}')
            if f.name.endswith('foundation_schema.sql'):
                run(f"insert into motorist_organizations(id,slug,name,active) values('{ORG}','fixture','Fixture',true)")
        check('all migrations apply over the stubbed platform schemas')
        for who, email in [(OFFICE, 'o'), (P, 'p'), (Q, 'q'), (D, 'd')]:
            run(f"insert into auth.users(id,email) values('{who}','{email}@example.invalid')")
        run(f"insert into motorist_profiles(organization_id,user_id,display_name,role,active,access_status) values('{ORG}','{OFFICE}','Centrála','dispatcher',true,'active')")
        for who, name, roles in [(P, 'Pristavovač P', ['delivery']), (Q, 'Pristavovač Q', ['delivery']), (D, 'Vodič', ['driver'])]:
            arr = 'array[' + ','.join(f"'{x}'" for x in roles) + ']'
            run(f"insert into motorist_towing_memberships(id,organization_id,auth_user_id,display_name,roles,capabilities) values('{who}','{ORG}','{who}','{name}',{arr},app_private.towing_capabilities({arr}))")

        check('table is closed to clients and even to service_role', denied("set role service_role; select count(*) from public.motorist_operation_positions"))
        check('authenticated cannot call the position RPC', denied(f"set role authenticated; select public.motorist_operation_position('{P}','{ORG}','{uid(1)}','{{}}'::jsonb)"))
        check('row level security is on', value("select relrowsecurity from pg_class where relname='motorist_operation_positions'") == 't')
        check('service_role may call the RPC', value("select has_function_privilege('service_role','public.motorist_operation_position(uuid,uuid,uuid,jsonb)','execute')") == 't')

        op = op_cmd(OFFICE, 'create', payload={'kind': 'transfer', 'from': 'Parkovisko A', 'to': 'Servis B'})['operation']['id']
        step(OFFICE, 'assign', op, {'assigneeId': P})
        check('assigned but not accepted: phone is told to stop', position(P, op) == {'stored': False, 'active': False} and stored(op) == 0)
        check('a member without deliver is refused by the operations actor', denied(position_sql(D, op)))
        check('unknown operation is not found', denied(position_sql(P, uid(999)), 'P0002'))
        step(P, 'accept', op)
        check('another member gets no position into this work', position(Q, op) == {'stored': False, 'active': False} and stored(op) == 0)
        check('own accepted operation stores the reading', position(P, op) == {'stored': True, 'active': True} and stored(op) == 1)
        check('readings closer than 10 s are throttled', position(P, op, recorded=at(2)) == {'stored': False, 'active': True} and stored(op) == 1)
        check('a stale reading is not stored', position(P, op, recorded=at(-20 * 60)) == {'stored': False, 'active': True})
        check('a reading from the future is not stored', position(P, op, recorded=at(10 * 60)) == {'stored': False, 'active': True})
        check('coordinates out of range are rejected', denied(position_sql(P, op, lat=123.0), '22023'))
        check('unknown input keys are rejected', denied(position_sql(P, op, extra={'speed': 3}), '22023'))
        check('a string latitude is rejected', denied(position_sql(P, op, extra={'lat': '48.1'}), '22023'))
        step(P, 'start', op)
        check('en route keeps storing', position(P, op, recorded=at(15)) == {'stored': True, 'active': True} and stored(op) == 2)
        check('only the assigned member is recorded', value(f"select string_agg(distinct member_id::text, ',') from motorist_operation_positions where operation_id='{op}'") == P)
        step(P, 'arrive', op)
        step(P, 'complete', op)
        check('completed operation stops the phone', position(P, op, recorded=at(30)) == {'stored': False, 'active': False} and stored(op) == 2)

        # Reassignment before start: the former assignee stops; the new one starts from their own step.
        op2 = op_cmd(OFFICE, 'create', payload={'kind': 'delivery', 'from': 'Sklad', 'to': 'Klient'})['operation']['id']
        step(OFFICE, 'assign', op2, {'assigneeId': P})
        step(P, 'accept', op2)
        step(OFFICE, 'assign', op2, {'assigneeId': Q})
        check('former assignee is told to stop after reassignment', position(P, op2) == {'stored': False, 'active': False})
        check('new assignee before own acceptance is not tracked', position(Q, op2) == {'stored': False, 'active': False})
        step(Q, 'accept', op2)
        check('a reading from before the own acceptance is not stored', position(Q, op2, recorded=at(-5 * 60)) == {'stored': False, 'active': True})
        check('the new assignee is tracked after acceptance', position(Q, op2) == {'stored': True, 'active': True})

        # Work that came through a legacy app delivery stays in Pristavenia: no operation positions there.
        op3 = op_cmd(OFFICE, 'create', payload={'kind': 'delivery', 'from': 'Sklad', 'to': 'Klient 3'})['operation']['id']
        step(OFFICE, 'assign', op3, {'assigneeId': P})
        step(P, 'accept', op3)
        case_id, contact = uid(60), uid(61)
        run(f"insert into motorist_contacts(id,organization_id,name,phone,role) values('{contact}','{ORG}','Klient','+421900000000','client');"
            f"insert into motorist_cases(id,organization_id,case_number,status,priority,source_type,case_type,contact_id) values('{case_id}','{ORG}','PM-T-9','open','normal','client','breakdown','{contact}')")
        run("set session_replication_role=replica;"
            f"insert into motorist_case_handoffs(organization_id,case_id,recipient_name,recipient_phone,published,token_hash,expires_at,operation_id) values('{ORG}','{case_id}','Pristavovač','+421900000001','{{}}','{'a' * 64}',now()+interval '1 day','{op3}');"
            "set session_replication_role=origin")
        check('a legacy-delivery operation is told to stop', position(P, op3) == {'stored': False, 'active': False} and stored(op3) == 0)
        group = uid(62)
        run("set session_replication_role=replica;"
            f"insert into motorist_work_groups(id,organization_id,name) values('{group}','{ORG}','Žilina');"
            f"insert into motorist_work_requests(organization_id,kind,group_id,status,claimed_by,operation_id,note,created_by) values('{ORG}','delivery','{group}','assigned','{OFFICE}','{op2}','  Kľúče na recepcii ','{OFFICE}');"
            "set session_replication_role=origin")
        ctx = j(f"select public.motorist_field_operations_context('{P}','{ORG}',array['{op}','{op2}','{op3}']::uuid[])")
        check('context names only the member\'s own operations and flags legacy deliveries', set(ctx) == {op, op3} and ctx[op3]['legacy'] is True and ctx[op]['legacy'] is False)
        check('context carries the branch note for the executor', j(f"select public.motorist_field_operations_context('{Q}','{ORG}',array['{op2}']::uuid[])") == {op2: {'legacy': False, 'instructions': 'Kľúče na recepcii'}})
        check('context is refused to a member without deliver', denied(f"select public.motorist_field_operations_context('{D}','{ORG}',array['{op}']::uuid[])"))
        check('context refuses more than 100 ids', denied(f"select public.motorist_field_operations_context('{P}','{ORG}',array_fill('{op}'::uuid,array[101]))", '22023'))

        # Dispatch reads the latest position; executors and unknown operations do not.
        last = j(f"select public.motorist_operation_last_position('{OFFICE}','{ORG}','{op}')")['position']
        check('dispatch reads the latest position with the member name', last['member'] == 'Pristavovač P' and abs(last['lat'] - 48.15) < 1e-9 and last['accuracy'] == 12.5)
        check('an operation without positions reads as none', j(f"select public.motorist_operation_last_position('{OFFICE}','{ORG}','{op3}')") == {'position': None})
        check('an executor cannot read positions', denied(f"select public.motorist_operation_last_position('{P}','{ORG}','{op}')"))
        check('an unknown operation is not found', denied(f"select public.motorist_operation_last_position('{OFFICE}','{ORG}','{uid(998)}')", 'P0002'))
        check('authenticated cannot read positions', denied(f"set role authenticated; select public.motorist_operation_last_position('{OFFICE}','{ORG}','{op}')"))

        run(f"update motorist_towing_memberships set active=false,membership_version=membership_version+1 where id='{Q}'")
        check('a deactivated member cannot send positions', denied(position_sql(Q, op2, recorded=at(20))))

        # Retention through the existing hourly upkeep RPC.
        run(f"insert into motorist_operation_positions(organization_id,operation_id,member_id,lat,lng,recorded_at,received_at) values('{ORG}','{op}','{P}',48,17,now()-interval '31 days',now()-interval '31 days')")
        before = int(value("select count(*) from motorist_operation_positions"))
        pruned = int(value("select public.motorist_handoff_positions_prune()"))
        check('prune removes operation positions older than 30 days', pruned == 1 and int(value("select count(*) from motorist_operation_positions")) == before - 1)
        check('prune keeps recent operation positions', int(value("select count(*) from motorist_operation_positions where received_at>now()-interval '1 day'")) == before - 1)
        print('\n'.join('ok  ' + c for c in checks))
        print(f'{len(checks)} checks passed')
    finally:
        subprocess.run(['pg_ctl', '-D', str(data), '-m', 'immediate', 'stop'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
