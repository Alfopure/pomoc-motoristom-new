"""Isolated PostgreSQL contract test for background positions of own operations (Moja práca).

Creates a disposable local cluster on a unix socket, applies every repository
migration over minimal auth/storage/realtime stubs and exercises
motorist_operation_tracker, motorist_operation_track and the 30-day prune of
20261028150000_operation_background_tracking.sql. Never reads PG* variables or
remote DSNs.
Run: python3 tests/postgres/operation-background-tracking.py
"""
import hashlib, json, os, pathlib, subprocess, tempfile, uuid
from datetime import datetime, timedelta, timezone
ROOT = pathlib.Path(__file__).resolve().parents[2]
M = ROOT / 'supabase/migrations'
ORG = '00000000-0000-4000-8000-000000000001'
def uid(n): return f'74000000-0000-4000-8000-{n:012d}'
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

with tempfile.TemporaryDirectory(prefix='pm-opbg-pg-') as temp:
    base = pathlib.Path(temp); data = base / 'data'; sock = base / 'sock'; sock.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    subprocess.run(['initdb', '-D', str(data), '--auth=trust', '--no-locale', '--encoding=UTF8'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    subprocess.run(['pg_ctl', '-D', str(data), '-l', str(base / 'server.log'), '-o', f"-k {sock} -h '' -p 56513", '-w', 'start'], env=env, stdout=subprocess.DEVNULL, check=True)
    def psql(args, sql=None, ok=True):
        r = subprocess.run(['psql', '-X', '-h', str(sock), '-p', '56513', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', *args], input=sql, env=env, capture_output=True, text=True)
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
    def denied(sql, code='42501', message=None):
        r = run("\\set VERBOSITY verbose\n" + sql, False)
        return r.returncode != 0 and code in r.stderr and (message is None or message in r.stderr)
    serial = [3000]
    def op_cmd(who, action, op=None, payload=None, rev=0):
        serial[0] += 1
        c = {'commandId': uid(serial[0]), 'action': action, 'expectedRevision': rev, 'payload': payload or {}}
        if op: c['operationId'] = op
        return j("select public.motorist_operations_command('%s','%s','%s'::jsonb)" % (who, ORG, json.dumps(c).replace("'", "''")))
    def rev(op): return int(value(f"select revision from motorist_logistics_executions where operation_id='{op}'"))
    def step(who, action, op, payload=None): return op_cmd(who, action, op, payload, rev(op))
    def at(delta_seconds=0): return (datetime.now(timezone.utc) + timedelta(seconds=delta_seconds)).isoformat()
    def reading(delta_seconds=0, **extra): return {'lat': 48.15, 'lng': 17.11, 'accuracy': 9.5, 'recordedAt': at(delta_seconds), **extra}
    def secret(): return hashlib.sha256(('tracker-' + uuid.uuid4().hex).encode()).hexdigest()
    def tracker_sql(who, op, action='issue', token=None):
        hashed = 'null' if token is None else f"'{token}'"
        return f"select public.motorist_operation_tracker('{who}','{ORG}','{op}','{action}',{hashed})"
    def issue(who, op, token): return j(tracker_sql(who, op, 'issue', token))
    def track_sql(token, batch): return "select public.motorist_operation_track('%s','%s'::jsonb)" % (token, json.dumps(batch).replace("'", "''"))
    def track(token, batch): return j(track_sql(token, batch))
    def stored(op): return int(value(f"select count(*) from motorist_operation_positions where operation_id='{op}'"))
    def revoked(token): return value(f"select revoked_at is not null from motorist_operation_trackers where token_hash='{token}'") == 't'
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

        # Closed surface: only the service role calls the RPCs; nobody reads the secrets.
        check('tracker table is closed to clients and even to service_role', denied("set role service_role; select count(*) from public.motorist_operation_trackers"))
        check('tracker table has row level security', value("select relrowsecurity from pg_class where relname='motorist_operation_trackers'") == 't')
        check('authenticated cannot issue a tracker', denied(f"set role authenticated; {tracker_sql(P, uid(1), 'issue', 'a' * 64)}"))
        check('authenticated cannot send background positions', denied(f"set role authenticated; select public.motorist_operation_track('{'a' * 64}','[]'::jsonb)"))
        check('service_role may call both RPCs', value("select has_function_privilege('service_role','public.motorist_operation_tracker(uuid,uuid,uuid,text,text)','execute') and has_function_privilege('service_role','public.motorist_operation_track(text,jsonb)','execute')") == 't')
        check('the batch helper is private', value("select has_function_privilege('service_role','app_private.motorist_operation_record_positions(uuid,uuid,uuid,jsonb)','execute')") == 'f')

        op = op_cmd(OFFICE, 'create', payload={'kind': 'transfer', 'from': 'Parkovisko A', 'to': 'Servis B'})['operation']['id']
        step(OFFICE, 'assign', op, {'assigneeId': P})
        first = secret()
        check('no secret before the member accepted', denied(tracker_sql(P, op, 'issue', first), 'PT409', 'Not tracking'))
        check('a member without deliver gets no secret', denied(tracker_sql(D, op, 'issue', first)))
        check('an unknown operation is not found', denied(tracker_sql(P, uid(999), 'issue', first), 'P0002'))
        step(P, 'accept', op)
        check('another member gets no secret for this work', denied(tracker_sql(Q, op, 'issue', first), 'PT409', 'Not tracking'))
        check('a malformed hash is refused', denied(tracker_sql(P, op, 'issue', 'x'), '22023') and denied(tracker_sql(P, op, 'issue', None), '22023'))
        check('an unknown action is refused', denied(tracker_sql(P, op, 'pause', first), '22023'))
        issued = issue(P, op, first)
        expires = datetime.fromisoformat(issued['expiresAt'])
        check('the secret lasts 8 days', timedelta(days=7, hours=23) < expires - datetime.now(timezone.utc) <= timedelta(days=8))
        check('only the hash is kept', value(f"select count(*) from motorist_operation_trackers where token_hash='{first}' and member_id='{P}' and operation_id='{op}'") == '1')

        check('an unknown secret is told to stop', track(hashlib.sha256(b'unknown').hexdigest(), [reading()]) == {'stored': 0, 'active': False})
        check('a malformed secret is told to stop', track('not-a-hash', [reading()]) == {'stored': 0, 'active': False})
        check('a batch spaced 10 s apart is stored', track(first, [reading(-30), reading(-15)]) == {'stored': 2, 'active': True} and stored(op) == 2)
        check('readings closer than 10 s are throttled', track(first, [reading(-12)]) == {'stored': 0, 'active': True} and stored(op) == 2)
        check('the open app shares the same throttle', j(f"select public.motorist_operation_position('{P}','{ORG}','{op}','{json.dumps(reading(-10))}'::jsonb)") == {'stored': False, 'active': True})
        check('a reading from the future is not stored', track(first, [reading(10 * 60)]) == {'stored': 0, 'active': True})
        check('only the assigned member is recorded', value(f"select string_agg(distinct member_id::text, ',') from motorist_operation_positions where operation_id='{op}'") == P)
        check('an empty batch is refused', denied(track_sql(first, []), '22023'))
        check('more than 100 readings are refused', denied(track_sql(first, [reading(i * 11) for i in range(101)]), '22023'))
        check('coordinates out of range are refused', denied(track_sql(first, [reading(1, lat=91)]), '22023'))
        check('unknown keys in a reading are refused', denied(track_sql(first, [reading(1, speed=3)]), '22023'))
        check('a string latitude is refused', denied(track_sql(first, [reading(1, lat='48.1')]), '22023'))
        check('a refused batch stores nothing', stored(op) == 2)

        # A phone long without signal sends what it kept: up to half a day, never before the assignment.
        old = op_cmd(OFFICE, 'create', payload={'kind': 'transfer', 'from': 'Klient', 'to': 'Sklad'})['operation']['id']
        step(OFFICE, 'assign', old, {'assigneeId': P})
        step(P, 'accept', old)
        run(f"update motorist_operation_events set created_at=now()-interval '7 hours' where operation_id='{old}' and action='assign';"
            f"update motorist_operation_events set created_at=now()-interval '6 hours' where operation_id='{old}' and action='accept'")
        kept = secret(); issue(P, old, kept)
        result = track(kept, [reading(-13 * 3600), reading(-6.5 * 3600), reading(-5 * 3600), reading(-4 * 3600)])
        check('kept readings after the own acceptance are stored, older ones are not', result == {'stored': 2, 'active': True} and stored(old) == 2)

        step(P, 'start', old)
        step(P, 'arrive', old)
        check('arrived still takes the position', track(kept, [reading(-60)]) == {'stored': 1, 'active': True})
        step(P, 'complete', old)

        # A new secret replaces the previous one; revoking ends the current one.
        second = secret(); issue(P, op, second)
        check('the replaced secret stops the phone', track(first, [reading(5)]) == {'stored': 0, 'active': False} and revoked(first))
        check('the new secret goes on', track(second, [reading(5)])['active'] is True)
        check('revoking answers revoked', j(tracker_sql(P, op, 'revoke')) == {'revoked': True})
        check('a revoked secret stops the phone', track(second, [reading(20)]) == {'stored': 0, 'active': False})
        check('revoking for an unknown operation is not found', denied(tracker_sql(P, uid(998), 'revoke'), 'P0002'))

        # The work ends or leaves the member: the phone is told to stop and the secret ends.
        third = secret(); issue(P, op, third)
        step(P, 'start', op)
        check('en route keeps storing', track(third, [reading(40)]) == {'stored': 1, 'active': True})
        step(P, 'arrive', op)
        step(P, 'complete', op)
        check('completed work stops the phone and ends its secret', track(third, [reading(60)]) == {'stored': 0, 'active': False} and revoked(third))
        check('completed work issues no new secret', denied(tracker_sql(P, op, 'issue', secret()), 'PT409', 'Not tracking'))

        moved = op_cmd(OFFICE, 'create', payload={'kind': 'delivery', 'from': 'Sklad', 'to': 'Klient 2'})['operation']['id']
        step(OFFICE, 'assign', moved, {'assigneeId': P})
        step(P, 'accept', moved)
        former = secret(); issue(P, moved, former)
        step(OFFICE, 'assign', moved, {'assigneeId': Q})
        check('a reassignment stops the former assignee', track(former, [reading()]) == {'stored': 0, 'active': False} and revoked(former))
        step(Q, 'accept', moved)
        newer = secret(); issue(Q, moved, newer)
        check('the new assignee sends nothing from before own acceptance', track(newer, [reading(-5 * 60), reading()]) == {'stored': 1, 'active': True})

        # Work of a legacy app delivery is tracked by Pristavenia only, never twice.
        legacy = op_cmd(OFFICE, 'create', payload={'kind': 'delivery', 'from': 'Sklad', 'to': 'Klient 3'})['operation']['id']
        step(OFFICE, 'assign', legacy, {'assigneeId': P})
        step(P, 'accept', legacy)
        early = secret(); issue(P, legacy, early)
        case_id, contact = uid(60), uid(61)
        run(f"insert into motorist_contacts(id,organization_id,name,phone,role) values('{contact}','{ORG}','Klient','+421900000000','client');"
            f"insert into motorist_cases(id,organization_id,case_number,status,priority,source_type,case_type,contact_id) values('{case_id}','{ORG}','PM-T-9','open','normal','client','breakdown','{contact}')")
        run("set session_replication_role=replica;"
            f"insert into motorist_case_handoffs(organization_id,case_id,recipient_name,recipient_phone,published,token_hash,expires_at,operation_id) values('{ORG}','{case_id}','Pristavovač','+421900000001','{{}}','{'b' * 64}',now()+interval '1 day','{legacy}');"
            "set session_replication_role=origin")
        check('a legacy-delivery operation issues no secret', denied(tracker_sql(P, legacy, 'issue', secret()), 'PT409', 'Not tracking'))
        check('a secret from before the legacy link stops the phone', track(early, [reading()]) == {'stored': 0, 'active': False} and stored(legacy) == 0)

        # Lock order: a command holds the operation row and then wants its execution
        # while the phone sends or asks for a secret. The phone must wait without
        # holding the execution, so neither side is aborted as a deadlock.
        racy = op_cmd(OFFICE, 'create', payload={'kind': 'transfer', 'from': 'Sklad 4', 'to': 'Servis 4'})['operation']['id']
        step(OFFICE, 'assign', racy, {'assigneeId': P})
        step(P, 'accept', racy)
        racy_token = secret(); issue(P, racy, racy_token)
        def psql_session():
            return subprocess.Popen(['psql', '-X', '-q', '-h', str(sock), '-p', '56513', '-d', 'postgres', '-At'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, env=env, text=True)
        def without_deadlock(phone_sql, marker):
            command = psql_session()
            command.stdin.write(f"begin;\nselect 1 from motorist_operations where id='{racy}' for update;\n"); command.stdin.flush()
            assert command.stdout.readline().strip() == '1'
            phone = psql_session()
            phone.stdin.write(phone_sql + ";\n"); phone.stdin.flush()
            for _ in range(100):
                if value(f"select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%{marker}%' and pid<>pg_backend_pid()") == '1': break
                subprocess.run(['sleep', '0.1'])
            else: raise AssertionError('the phone call did not wait for the operation row')
            _, command_err = command.communicate(f"select 1 from motorist_logistics_executions where operation_id='{racy}' for update;\nselect pg_sleep(1.5);\ncommit;\n", timeout=30)
            phone_out, phone_err = phone.communicate(timeout=30)
            lines = phone_out.strip().splitlines()
            return 'deadlock' not in command_err + phone_err and not command_err.strip() and not phone_err.strip(), lines[-1] if lines else '{}'
        ok, out = without_deadlock(track_sql(racy_token, [reading()]), 'motorist_operation_track(')
        check('background sending waits for a running operation command without a deadlock', ok and json.loads(out) == {'stored': 1, 'active': True})
        ok, out = without_deadlock(tracker_sql(P, racy, 'issue', secret()), 'motorist_operation_tracker(')
        check('issuing a secret waits for a running operation command without a deadlock', ok and 'expiresAt' in json.loads(out))

        # Lost access ends the secret.
        run(f"update motorist_towing_memberships set active=false,membership_version=membership_version+1 where id='{Q}'")
        check('a deactivated member is told to stop', track(newer, [reading(30)]) == {'stored': 0, 'active': False} and revoked(newer))
        check('a deactivated member gets no secret', denied(tracker_sql(Q, moved, 'issue', secret())))

        # Retention through the existing hourly upkeep RPC.
        run(f"update motorist_operation_trackers set revoked_at=now()-interval '31 days' where token_hash='{first}'")
        pruned = int(value("select public.motorist_handoff_positions_prune()"))
        check('prune removes secrets spent more than 30 days ago', value(f"select count(*) from motorist_operation_trackers where token_hash='{first}'") == '0')
        check('prune keeps recently spent secrets', value(f"select count(*) from motorist_operation_trackers where token_hash='{second}'") == '1')
        check('prune still counts only positions', pruned == 0)
        print('\n'.join('ok  ' + c for c in checks))
        print(f'{len(checks)} checks passed')
    finally:
        subprocess.run(['pg_ctl', '-D', str(data), '-m', 'immediate', 'stop'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
