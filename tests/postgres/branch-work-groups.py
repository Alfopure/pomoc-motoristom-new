"""Isolated PostgreSQL contract test for branch work groups (Pobočky).

Creates a disposable local cluster on a unix socket, applies every repository
migration over minimal auth/storage/realtime stubs and exercises the branch
RPCs. Never reads PG* variables or remote DSNs.
Run: python3 tests/postgres/branch-work-groups.py
"""
import concurrent.futures, json, os, pathlib, subprocess, tempfile, time
ROOT = pathlib.Path(__file__).resolve().parents[2]
M = ROOT / 'supabase/migrations'
ORG = '00000000-0000-4000-8000-000000000001'
def uid(n): return f'72000000-0000-4000-8000-{n:012d}'
CENTRAL, MANAGER, L1, L2, LB, P, T, OUT = (uid(n) for n in (10, 11, 12, 13, 14, 15, 16, 17))
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

with tempfile.TemporaryDirectory(prefix='pm-branch-pg-') as temp:
    base = pathlib.Path(temp); data = base / 'data'; sock = base / 'sock'; sock.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    subprocess.run(['initdb', '-D', str(data), '--auth=trust', '--no-locale', '--encoding=UTF8'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    subprocess.run(['pg_ctl', '-D', str(data), '-l', str(base / 'server.log'), '-o', f"-k {sock} -h '' -p 56511", '-w', 'start'], env=env, stdout=subprocess.DEVNULL, check=True)
    def psql(args, sql=None, ok=True):
        r = subprocess.run(['psql', '-X', '-h', str(sock), '-p', '56511', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', *args], input=sql, env=env, capture_output=True, text=True)
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
    serial = [1000]
    def command(who, action, payload=None, request=None, rev=None, cid=None):
        serial[0] += 1
        c = {'commandId': cid or uid(serial[0]), 'action': action, 'payload': payload or {}}
        if request: c['requestId'] = request
        if rev is not None: c['expectedRevision'] = rev
        return "select public.motorist_branch_command('%s','%s','%s'::jsonb)" % (who, ORG, json.dumps(c).replace("'", "''"))
    def cmd(*a, **k): return j(command(*a, **k))
    def ws(who, filters=None): return j("select public.motorist_branch_workspace('%s','%s','%s'::jsonb)" % (who, ORG, json.dumps(filters or {})))
    def req_rev(r): return int(value(f"select revision from motorist_work_requests where id='{r}'"))
    try:
        run(STUBS)
        for f in sorted(M.glob('*.sql')):
            r = psql(['-q', '-f', str(f)], ok=False)
            if r.returncode and f.name not in KNOWN_FIXTURE_GAPS: raise AssertionError(f'{f.name}: {r.stderr[-1500:]}')
            if f.name.endswith('foundation_schema.sql'):
                run(f"insert into motorist_organizations(id,slug,name,active) values('{ORG}','fixture','Fixture',true)")
        check('all migrations apply over the stubbed platform schemas')
        branch_a, branch_b = uid(30), uid(31)
        run(f"insert into motorist_branches(id,organization_id,name,address) values('{branch_a}','{ORG}','Pobočka Žilina','Fixture 1'),('{branch_b}','{ORG}','Pobočka Košice','Fixture 2')")
        for who, email in [(CENTRAL, 'c'), (MANAGER, 'm'), (L1, 'l1'), (L2, 'l2'), (LB, 'lb'), (P, 'p'), (T, 't'), (OUT, 'out')]:
            run(f"insert into auth.users(id,email) values('{who}','{email}@example.invalid')")
        run(f"insert into motorist_profiles(organization_id,user_id,display_name,role,active,access_status) values('{ORG}','{CENTRAL}','Centrála','dispatcher',true,'active'),('{ORG}','{MANAGER}','Vedúci','manager',true,'active')")
        for who, name, roles in [(L1, 'Lokálny 1', ['branch']), (L2, 'Lokálny 2', ['branch', 'delivery']), (LB, 'Lokálny B', ['branch']), (P, 'Pristavovač', ['delivery']), (T, 'Odťahovkár', ['driver', 'delivery']), (OUT, 'Bez pobočky', ['delivery'])]:
            arr = 'array[' + ','.join(f"'{x}'" for x in roles) + ']'
            run(f"insert into motorist_towing_memberships(id,organization_id,auth_user_id,display_name,roles,capabilities) values('{who}','{ORG}','{who}','{name}',{arr},app_private.towing_capabilities({arr}))")
        check('branch role is accepted without towing capabilities', value(f"select cardinality(capabilities) from motorist_towing_memberships where id='{L1}'") == '0')
        check('central without manage cannot create groups', denied(command(CENTRAL, 'group_save', {'name': 'X', 'serviceKinds': ['delivery']})))
        ga = cmd(MANAGER, 'group_save', {'name': 'Žilina – pristavenia', 'branchId': branch_a, 'serviceKinds': ['delivery', 'collection', 'transfer', 'tow']})['group']['id']
        gb = cmd(MANAGER, 'group_save', {'name': 'Košice', 'branchId': branch_b, 'serviceKinds': ['delivery', 'transfer']})['group']['id']
        for member, role in [(L1, 'lead'), (L2, 'lead'), (P, 'member'), (T, 'member')]:
            cmd(MANAGER, 'group_member', {'groupId': ga, 'memberId': member, 'role': role, 'receivesNew': role == 'lead'})
        cmd(MANAGER, 'group_member', {'groupId': gb, 'memberId': LB, 'role': 'lead', 'receivesNew': True})
        check('executor without a lead seat has no branch module', denied(f"select public.motorist_branch_workspace('{P}','{ORG}','{{}}')"))
        check('lead sees only own groups', [g['id'] for g in ws(L1)['groups']] == [ga])
        check('central sees every group', {g['id'] for g in ws(CENTRAL)['groups']} == {ga, gb})
        case_id = uid(40)
        run(f"insert into motorist_contacts(id,organization_id,name,phone,role) values('{uid(41)}','{ORG}','Syntetický klient','+421900000000','client');"
            f"insert into motorist_cases(id,organization_id,case_number,status,priority,source_type,case_type,contact_id,main_note) values('{case_id}','{ORG}','PM-T-1','open','normal','client','breakdown','{uid(41)}','INTERNAL SECRET NOTE')")
        check('lead cannot create a central request', denied(command(L1, 'create', {'groupId': ga, 'kind': 'delivery'}, rev=0)))
        check('group refuses a service it does not handle', denied(command(CENTRAL, 'create', {'groupId': gb, 'kind': 'tow'}, rev=0), '22023'))
        r1 = cmd(CENTRAL, 'create', {'groupId': ga, 'kind': 'delivery', 'caseId': case_id, 'pickup': 'Parkovisko A', 'destination': 'Klient B', 'note': 'Bez auta pri príjme'}, rev=0)['request']
        check('request without a vehicle is queued', r1['status'] == 'queued' and r1['fleetAssetId'] is None)
        check('projection is allowlisted', r1['customer']['name'] == 'Syntetický klient' and 'INTERNAL SECRET NOTE' not in json.dumps(r1))
        check('lead of other group cannot see the request', ws(LB)['requests'] == [] and denied(command(LB, 'claim', request=r1['id'], rev=req_rev(r1['id'])), 'P0002'))
        check('foreign group filter is rejected', denied(f"select public.motorist_branch_workspace('{LB}','{ORG}','{{\"groupId\":\"{ga}\"}}')"))
        # Two local leads race for the same revision: one owner, one conflict.
        rev = req_rev(r1['id'])
        first = command(L1, 'claim', request=r1['id'], rev=rev); second = command(L2, 'claim', request=r1['id'], rev=rev)
        with concurrent.futures.ThreadPoolExecutor() as pool:
            a = pool.submit(run, "begin;" + first + ";select pg_sleep(0.4);commit;", False)
            time.sleep(0.1)
            b = pool.submit(run, "\\set VERBOSITY verbose\n" + second, False)
            ra, rb = a.result(), b.result()
        check('concurrent claim yields exactly one owner', ra.returncode == 0 and rb.returncode != 0 and 'PT409' in rb.stderr)
        check('claimer recorded', value(f"select claimed_by from motorist_work_requests where id='{r1['id']}'") == L1)
        check('second lead cannot materialize a foreign claim', denied(command(L2, 'materialize', {'assigneeId': P}, request=r1['id'], rev=req_rev(r1['id'])), 'PT409'))
        check('assignee outside the group rejected', denied(command(L1, 'materialize', {'assigneeId': OUT}, request=r1['id'], rev=req_rev(r1['id'])), '22023'))
        mat_cmd = command(L1, 'materialize', {'assigneeId': P}, request=r1['id'], rev=req_rev(r1['id']), cid=uid(900))
        m1 = j(mat_cmd)['request']
        check('materialize creates one assigned logistics execution', m1['status'] == 'assigned' and m1['execution']['status'] == 'assigned' and m1['execution']['assigneeId'] == P)
        check('identical materialize replay is stable', j(mat_cmd)['request']['execution']['operationId'] == m1['execution']['operationId'] and value("select count(*) from motorist_operations") == '1')
        check('lead outside a scoped command is not operations office', denied(f"select public.motorist_operations_workspace('{L1}','{ORG}','{{}}')"))
        check('executor sees the job in own operations', [o['id'] for o in j(f"select public.motorist_operations_workspace('{P}','{ORG}','{{\"mine\":true}}')")['operations']] == [m1['execution']['operationId']])
        op_rev = m1['execution']['revision']
        re = cmd(L1, 'operate', {'command': {'action': 'assign', 'expectedRevision': op_rev, 'payload': {'assigneeId': L2}}}, request=r1['id'], rev=req_rev(r1['id']))['request']
        check('lead reassigns to a self-delivering lead of the group', re['execution']['assigneeId'] == L2)
        same_tx = run("begin;" + command(L1, 'operate', {'command': {'action': 'reschedule', 'expectedRevision': re['execution']['revision'], 'payload': {'scheduledAt': '2030-01-01T10:00:00Z'}}}, request=r1['id'], rev=req_rev(r1['id'])) + ";select 'scope=' || coalesce(current_setting('motorist.operation_scope',true),'');" + f"select public.motorist_operations_workspace('{L1}','{ORG}','{{}}');commit;", False)
        lines = same_tx.stdout.strip().splitlines()
        check('scope is cleared inside the same transaction after the command', 'scope=' in lines and same_tx.returncode != 0 and 'Forbidden' in same_tx.stderr)
        check('lead cannot reassign outside the group', denied(command(L1, 'operate', {'command': {'action': 'assign', 'expectedRevision': re['execution']['revision'], 'payload': {'assigneeId': OUT}}}, request=r1['id'], rev=req_rev(r1['id'])), '22023'))
        check('lead cannot run executor-only or evidence actions', denied(command(L1, 'operate', {'command': {'action': 'complete', 'expectedRevision': re['execution']['revision'], 'payload': {}}}, request=r1['id'], rev=req_rev(r1['id'])), '22023'))
        # Routing history: request moved A -> B keeps A's receipt in reports.
        r2 = cmd(CENTRAL, 'create', {'groupId': ga, 'kind': 'transfer', 'pickup': 'X', 'destination': 'Y'}, rev=0)['request']
        cmd(CENTRAL, 'route', {'groupId': gb, 'reason': 'Bližšie'}, request=r2['id'], rev=req_rev(r2['id']))
        check('moved request leaves the old group view', r2['id'] not in [x['id'] for x in ws(L1)['requests']] and r2['id'] in [x['id'] for x in ws(LB)['requests']])
        cmd(LB, 'claim', request=r2['id'], rev=req_rev(r2['id']))
        r3 = cmd(CENTRAL, 'create', {'groupId': ga, 'kind': 'delivery'}, rev=0)['request']
        r4 = cmd(CENTRAL, 'create', {'groupId': ga, 'kind': 'tow', 'caseId': case_id, 'pickup': 'D1'}, rev=0)['request']
        cmd(L1, 'claim', request=r4['id'], rev=req_rev(r4['id']))
        check('towing materialization needs towing office capability', denied(command(L1, 'materialize', {}, request=r4['id'], rev=req_rev(r4['id']))))
        cmd(L1, 'cancel', {'reason': 'Duplicitné'}, request=r3['id'], rev=req_rev(r3['id']))
        check('cancel without reason refused', denied(command(L1, 'cancel', {}, request=r4['id'], rev=req_rev(r4['id'])), '22023'))
        report = lambda who, f=None: j("select public.motorist_branch_report('%s','%s',now()-interval '1 day',now()+interval '1 day','%s'::jsonb)" % (who, ORG, json.dumps(f or {})))
        rows = {g['groupId']: g for g in report(CENTRAL)['groups']}
        a, b = rows[ga], rows[gb]
        check('received counts routing episodes per group', a['received'] == 4 and b['received'] == 1)
        check('unique cases differ from requests', a['uniqueRequests'] == 4 and a['uniqueCases'] == 1 and a['withoutCase'] == 2)
        check('reaction uses only claimed episodes and reports unknowns', a['reaction']['samples'] == 2 and a['reaction']['unclaimed'] == 2 and a['reaction']['avgSeconds'] is not None)
        check('moved request claim is attributed to the new group', b['reaction']['samples'] == 1)
        check('assignment time only from materialized episodes', a['assignment']['samples'] == 1 and b['assignment']['samples'] == 0)
        check('in-progress counts current executions', a['inProgressNow'] == 1 and a['completed'] == 0)
        check('workload per executor', [w['memberId'] for w in report(CENTRAL)['workload']] == [L2])
        check('local report is limited to own groups', [g['groupId'] for g in report(LB)['groups']] == [gb])
        check('foreign group report rejected', denied("select public.motorist_branch_report('%s','%s',now()-interval '1 day',now(),'{\"groupId\":\"%s\"}')" % (LB, ORG, ga)))
        check('report period bounded', denied("select public.motorist_branch_report('%s','%s',now()-interval '400 days',now(),'{}')" % (CENTRAL, ORG), '22023'))
        # Revocation: removing the lead seat removes access immediately.
        cmd(MANAGER, 'group_member', {'groupId': ga, 'memberId': L1, 'role': 'none'})
        check('revoked lead loses the module', denied(f"select public.motorist_branch_workspace('{L1}','{ORG}','{{}}')"))
        for role in ['anon', 'authenticated']:
            check(f'{role} cannot execute branch RPCs', denied(f"set role {role};select public.motorist_branch_workspace('{CENTRAL}','{ORG}','{{}}')"))
            check(f'{role} cannot read branch tables', denied(f"set role {role};select * from public.motorist_work_requests"))
        print(json.dumps({'passed': len(checks), 'checks': checks}, ensure_ascii=False, indent=1))
    finally:
        subprocess.run(['pg_ctl', '-D', str(data), '-m', 'immediate', 'stop'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
