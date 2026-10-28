"""Isolated PostgreSQL contract test for the work push outbox (upozornenia).

Creates a disposable local cluster on a unix socket, applies every repository
migration over minimal auth/storage/realtime stubs and exercises the branch
RPCs. Never reads PG* variables or remote DSNs.
Run: python3 tests/postgres/mobile-work-push.py
"""
import concurrent.futures, json, os, pathlib, subprocess, tempfile, time
ROOT = pathlib.Path(__file__).resolve().parents[2]
M = ROOT / 'supabase/migrations'
ORG = '00000000-0000-4000-8000-000000000001'
def uid(n): return f'72000000-0000-4000-8000-{n:012d}'
CENTRAL, MANAGER, L1, L2, LB, P, T, OUT, LT = (uid(n) for n in (10, 11, 12, 13, 14, 15, 16, 17, 18))
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

with tempfile.TemporaryDirectory(prefix='pm-push-pg-') as temp:
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
        for who, email in [(CENTRAL, 'c'), (MANAGER, 'm'), (L1, 'l1'), (L2, 'l2'), (LB, 'lb'), (P, 'p'), (T, 't'), (OUT, 'out'), (LT, 'lt')]:
            run(f"insert into auth.users(id,email) values('{who}','{email}@example.invalid')")
        run(f"insert into motorist_profiles(organization_id,user_id,display_name,role,active,access_status) values('{ORG}','{CENTRAL}','Centrála','dispatcher',true,'active'),('{ORG}','{MANAGER}','Vedúci','manager',true,'active')")
        for who, name, roles in [(L1, 'Lokálny 1', ['branch']), (L2, 'Lokálny 2', ['branch', 'delivery']), (LB, 'Lokálny B', ['branch']), (P, 'Pristavovač', ['delivery']), (T, 'Odťahovkár', ['driver', 'delivery']), (OUT, 'Bez pobočky', ['delivery']), (LT, 'Odťahová kancelária', ['branch', 'dispatch'])]:
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
        def outbox(where='true'): return json.loads(value(f"select coalesce(json_agg(json_build_object('member',member_id,'profile',profile_id,'event',event,'status',status,'title',title,'subject',subject_id) order by created_at),'[]') from motorist_push_outbox where {where}"))
        def claim(limit=50): return j(f"select public.motorist_push_outbox_claim('{ORG}',{limit})")
        def finish(results): return int(value("select public.motorist_push_outbox_finish('%s','%s'::jsonb)" % (ORG, json.dumps(results))))
        run(f"insert into motorist_contacts(id,organization_id,name,phone,role) values('{uid(41)}','{ORG}','Syntetický klient','+421900000000','client');"
            f"insert into motorist_cases(id,organization_id,case_number,status,priority,source_type,case_type,contact_id) values('{uid(40)}','{ORG}','PM-P-1','open','normal','client','breakdown','{uid(41)}')")
        r1 = cmd(CENTRAL, 'create', {'groupId': ga, 'kind': 'delivery', 'caseId': uid(40), 'pickup': 'A', 'destination': 'B'}, rev=0)['request']
        rows = outbox(f"subject_id='{r1['id']}'")
        check('new branch work notifies only receiving leads of that branch', sorted(x['member'] for x in rows) == sorted([L1, L2]) and all(x['event'] == 'branch_new' for x in rows))
        check('notice text carries no customer data', all('Syntetický' not in x['title'] and '+421' not in x['title'] for x in rows))
        first = claim()
        check('claim hands out due rows once under a lease', len(first) == 2 and claim() == [])
        check('claimed rows carry the tap target', all(x['target'] == {'kind': 'branch-request', 'id': r1['id']} for x in first))
        finish([{'id': first[0]['id'], 'outcome': 'sent'}, {'id': first[1]['id'], 'outcome': 'failed'}])
        check('failed row returns to the queue, sent row is final', sorted(x['status'] for x in outbox(f"subject_id='{r1['id']}'")) == ['pending', 'sent'])
        cmd(L1, 'claim', request=r1['id'], rev=req_rev(r1['id']))
        claim()
        check('claimed request drops the still-pending branch notice', 'dropped' in [x['status'] for x in outbox(f"subject_id='{r1['id']}'")])
        m = cmd(L1, 'materialize', {'assigneeId': P}, request=r1['id'], rev=req_rev(r1['id']))['request']
        op = m['execution']['operationId']
        check('assignment notifies exactly the executor', [(x['member'], x['event']) for x in outbox(f"subject_id='{op}'")] == [(P, 'work_assigned')])
        rv = lambda: int(value(f"select revision from motorist_logistics_executions where operation_id='{op}'"))
        cmd(L1, 'operate', {'command': {'action': 'assign', 'expectedRevision': rv(), 'payload': {'assigneeId': L2}}}, request=r1['id'], rev=req_rev(r1['id']))
        evs = [(x['member'], x['event']) for x in outbox(f"subject_id='{op}'")]
        check('reassignment tells the old executor and the new one', (P, 'work_unassigned') in evs and (L2, 'work_assigned') in evs)
        cmd(L1, 'operate', {'command': {'action': 'reschedule', 'expectedRevision': rv(), 'payload': {'scheduledAt': '2030-01-01T10:00:00Z'}}}, request=r1['id'], rev=req_rev(r1['id']))
        check('new term notifies the current executor', (L2, 'work_changed') in [(x['member'], x['event']) for x in outbox(f"subject_id='{op}'")])
        pending = claim()
        check('stale assignment notice for the removed executor is dropped', all(not (x['memberId'] == P and x['event'] == 'work_assigned') for x in pending)
              and 'dropped' in [x['status'] for x in outbox(f"subject_id='{op}' and member_id='{P}' and event='work_assigned'")])
        finish([{'id': x['id'], 'outcome': 'sent'} for x in pending])
        run(f"insert into motorist_operation_evidence(operation_id,stage,author_user_id,observed_at,source,note,missing_reason,damage_status) values('{op}','damage','{L2}',now(),'observed','Škrabanec','Bez fotky','open')")
        check('damage report reaches the lead who assigned the work', [(x['member'], x['event']) for x in outbox(f"subject_id='{op}' and event='work_problem'")] == [(L1, 'work_problem')])
        cmd(L1, 'operate', {'command': {'action': 'cancel', 'expectedRevision': rv(), 'payload': {'reason': 'Klient zrušil'}}}, request=r1['id'], rev=req_rev(r1['id']))
        check('cancellation notifies the executor', (L2, 'work_cancelled') in [(x['member'], x['event']) for x in outbox(f"subject_id='{op}'")])
        # Escalation: waiting longer than the branch setting.
        r2 = cmd(CENTRAL, 'create', {'groupId': gb, 'kind': 'transfer'}, rev=0)['request']
        check('settings need manage permission', denied("select public.motorist_branch_group_settings('%s','%s','%s',%s,15,true)" % (CENTRAL, ORG, gb, value(f"select revision from motorist_work_groups where id='{gb}'"))))
        check('settings are bounded', denied("select public.motorist_branch_group_settings('%s','%s','%s',%s,2,true)" % (MANAGER, ORG, gb, value(f"select revision from motorist_work_groups where id='{gb}'")), '22023'))
        j("select public.motorist_branch_group_settings('%s','%s','%s',%s,15,true)" % (MANAGER, ORG, gb, value(f"select revision from motorist_work_groups where id='{gb}'")))
        check('fresh work does not escalate', int(value(f"select public.motorist_branch_escalate('{ORG}')")) == 0)
        run(f"update motorist_work_requests set routed_at=now()-interval '20 minutes' where id='{r2['id']}'")
        n = int(value(f"select public.motorist_branch_escalate('{ORG}')"))
        esc = outbox(f"subject_id='{r2['id']}' and event='branch_waiting'")
        check('waiting work reminds the branch lead and central leaders once', n == 2 and sorted((x['member'] or x['profile']) for x in esc) == sorted([LB, value(f"select id from motorist_profiles where user_id='{MANAGER}'")])
              and int(value(f"select public.motorist_branch_escalate('{ORG}')")) == 0)
        # Towing: driver assignment through the towing engine.
        r3 = cmd(CENTRAL, 'create', {'groupId': ga, 'kind': 'tow', 'pickup': 'D1', 'destination': 'Servis'}, rev=0)['request']
        cmd(MANAGER, 'group_member', {'groupId': ga, 'memberId': LT, 'role': 'lead'})
        cmd(LT, 'claim', request=r3['id'], rev=req_rev(r3['id']))
        tow = cmd(LT, 'materialize', {}, request=r3['id'], rev=req_rev(r3['id']))['request']['execution']
        run(f"update motorist_towing_orders set fields=fields||'{{\"contact\":\"Fixture\"}}'::jsonb where id='{tow['ownerId']}'")
        trev = int(value(f"select revision from motorist_towing_orders where id='{tow['ownerId']}'"))
        lt_version = value(f"select membership_version from motorist_towing_memberships where id='{LT}'")
        j("select public.motorist_towing_command('%s','%s',%s,'%s'::jsonb)" % (LT, ORG, lt_version, json.dumps({'commandId': uid(970), 'targetId': tow['ownerId'], 'type': 'assign', 'expectedRevision': trev, 'payload': {'driverId': T}})))
        check('tow driver assignment notifies the driver', [(x['member'], x['event']) for x in outbox(f"subject_id='{tow['ownerId']}'")] == [(T, 'tow_assigned')])
        # Revocation before sending drops the notice.
        run(f"update motorist_towing_memberships set active=false where id='{T}'")
        claim()
        check('deactivated recipient never gets a queued notice', outbox(f"subject_id='{tow['ownerId']}'")[0]['status'] == 'dropped')
        # Attempts cap: a notice failing five times is given up.
        r4 = cmd(CENTRAL, 'create', {'groupId': gb, 'kind': 'delivery'}, rev=0)['request']
        for _ in range(5):
            run(f"update motorist_push_outbox set lease_until=null,status='pending' where subject_id='{r4['id']}' and status='sending'")
            got = [x for x in claim() if x['target']['id'] == r4['id']]
            finish([{'id': x['id'], 'outcome': 'failed'} for x in got])
        check('five failed attempts end as failed', [x['status'] for x in outbox(f"subject_id='{r4['id']}'")] == ['failed'])
        for role in ['anon', 'authenticated']:
            check(f'{role} cannot claim or read the outbox', denied(f"set role {role};select public.motorist_push_outbox_claim('{ORG}',1)") and denied(f"set role {role};select * from motorist_push_outbox"))
        print(json.dumps({'passed': len(checks), 'checks': checks}, ensure_ascii=False, indent=1))
    finally:
        subprocess.run(['pg_ctl', '-D', str(data), '-m', 'immediate', 'stop'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
