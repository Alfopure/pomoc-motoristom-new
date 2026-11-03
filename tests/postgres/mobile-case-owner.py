"""Isolated PostgreSQL fixture. Never uses PG* environment or a remote DSN."""
import concurrent.futures, hashlib, json, os, pathlib, subprocess, tempfile, time
ROOT = pathlib.Path(__file__).resolve().parents[2]
M = ROOT / 'supabase/migrations'
checks=[]
def uid(n): return f'40000000-0000-4000-8000-{n:012d}'
org, actor, target, case, command = map(uid, [1,2,3,4,5])
rev='2026-10-12T18:00:00.000001Z'
fingerprint=hashlib.sha256(b'ownerfixture').hexdigest()
with tempfile.TemporaryDirectory(prefix='pm-owner-pg-') as temp:
    base=pathlib.Path(temp); data=base/'data'; sock=base/'socket';sock.mkdir()
    env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
    subprocess.run(['initdb','-D',str(data),'--auth=trust','--no-locale','--encoding=UTF8'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
    subprocess.run(['pg_ctl','-D',str(data),'-l',str(base/'server.log'),'-o',f"-k {sock} -h '' -p 56438",'-w','start'],env=env,stdout=subprocess.DEVNULL,check=True)
    def run(sql,ok=True):
        p=subprocess.run(['psql','-X','-h',str(sock),'-p','56438','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At','-c',sql],env=env,capture_output=True,text=True)
        if ok and p.returncode: raise AssertionError(p.stderr)
        return p
    def check(name,condition=True):
        assert condition,name
        checks.append(name)
    def call(owner=target,mutation=command,revision=rev,fp=fingerprint,who=actor,organization=org,cid=case):
        return f"select public.motorist_assign_case_owner('{organization}','{who}','{uid(int(who[-12:])+1000)}','{cid}','{owner}','{revision}','{mutation}','{fp}')"
    def reset(owner='NULL',status='open'):
        run('truncate motorist_case_mutation_results,motorist_case_events,motorist_audit_log;')
        run(f"alter table motorist_cases disable trigger user; update motorist_cases set owner_id={owner},status='{status}',updated_at='{rev}' where id='{case}'; alter table motorist_cases enable trigger user;")
    def count(table): return int(run(f'select count(*) from {table}').stdout.strip())
    def race(first,second):
        # Wait until first transaction holds its owner/receipt changes, then
        # deliberately run second before first commits. No timing-only race.
        with concurrent.futures.ThreadPoolExecutor() as pool:
            a=pool.submit(run,"begin; set local application_name='owner-fixture-first'; "+first+"; select pg_sleep(0.7); commit;")
            for _ in range(200):
                if run("select count(*) from pg_stat_activity where application_name='owner-fixture-first' and wait_event='PgSleep'").stdout.strip()=='1':break
                time.sleep(.01)
            else:raise AssertionError('first transaction did not reach held commit fence')
            b=pool.submit(run,second,False)
            return a.result(),b.result()
    try:
        run("create role anon;create role authenticated;create role service_role;create schema auth;create function auth.uid() returns uuid language sql as $$select null::uuid$$;")
        # Exact foundation except optional pgcrypto extension: gen_random_uuid is
        # native PostgreSQL15; no application behavior depends on extension here.
        run((M/'20260520192000_foundation_schema.sql').read_text().replace('create extension if not exists pgcrypto;',''))
        run((M/'20260601133000_extended_case_card.sql').read_text())
        run("alter table motorist_profiles add access_status text not null default 'active';alter table motorist_profiles add kind text not null default 'human';")
        run((M/'20260929110000_atomic_case_save.sql').read_text())
        # Use actual latest case-only function body; the larger migration also
        # patches unrelated provider/task RPCs absent from this local fixture.
        text=(M/'20260929170000_domain_conflict_sqlstate.sql').read_text()
        start=text.index('CREATE OR REPLACE FUNCTION public.motorist_save_case_atomic(')
        end=text.index('$function$;',start)+len('$function$;')
        run(text[start:end])
        run((M/'20260929180000_case_mutation_reconciliation.sql').read_text())
        v1_before=run("select md5(string_agg(pg_get_functiondef(oid),E'\\n' order by oid)) from pg_proc where proname in ('motorist_save_case_atomic','motorist_case_mutation_result','motorist_case_monotonic_revision')").stdout
        run((M/'20261012183000_case_owner_assignment.sql').read_text())
        check('V1 functions byte-identical after owner migration',v1_before==run("select md5(string_agg(pg_get_functiondef(oid),E'\\n' order by oid)) from pg_proc where proname in ('motorist_save_case_atomic','motorist_case_mutation_result','motorist_case_monotonic_revision')").stdout)
        check('prepared migration compiles against actual foundation/editor/receipt SQL')
        run(f"insert into motorist_organizations(id,slug,name) values('{org}','test','Fixture'),('{uid(10)}','other','Other');")
        for n,role in [(2,'dispatcher'),(3,'dispatcher'),(6,'senior_dispatcher'),(7,'manager'),(8,'admin')]:
            run(f"insert into motorist_profiles(id,user_id,organization_id,display_name,role) values('{uid(n)}','{uid(n+1000)}','{org}','Fixture{n}','{role}');")
        run(f"insert into motorist_cases(id,organization_id,case_number,status,priority,source_type,case_type,updated_at) values('{case}','{org}','FIXTURE','open','normal','internal','other','{rev}');")
        run(f"insert into motorist_cases(id,organization_id,case_number,status,priority,source_type,case_type,updated_at) values('{uid(90)}','{uid(10)}','FOREIGN','open','normal','internal','other','{rev}')")
        for roleid in [2,6,7,8]:
            reset();run(call(who=uid(roleid)));check(f'role {roleid} may assign colleague')
        reset(); first=json.loads(run(call()).stdout)
        check('owner, event, audit, receipt commit together',count('motorist_case_events')==count('motorist_audit_log')==count('motorist_case_mutation_results')==1)
        check('revision advances beyond exact microsecond',first['committedRevision']!=rev)
        run(f"update motorist_profiles set active=false where id='{target}'; update motorist_cases set summary='later' where id='{case}';")
        check('original replay precedes changed revision and deactivated target',json.loads(run(call()).stdout)==first)
        run(f"update motorist_profiles set active=true where id='{target}';")
        check('same mutation UUID cannot replay for another case','PT422' in run(call(cid=uid(90)),False).stderr)
        check('different identity payload rejected PT422','PT422' in run(call(fp='0'*64),False).stderr)
        run(f"update motorist_profiles set active=false where id='{actor}';")
        check('revoked actor cannot replay','42501' in run(call(),False).stderr)
        run(f"update motorist_profiles set active=true where id='{actor}';")
        reset(owner=f"'{target}'"); noop=json.loads(run(call()).stdout)
        check('same-owner no-op preserves exact revision and creates only receipt',run(f"select updated_at='{rev}'::timestamptz from motorist_cases where id='{case}'").stdout.strip()=='t' and count('motorist_case_events')==count('motorist_audit_log')==0 and count('motorist_case_mutation_results')==1)
        check('same-owner replay stable',json.loads(run(call()).stdout)==noop)
        for column,value in [('user_id','NULL'),('active','false'),('access_status',"'disabled'"),('kind',"'ai'"),('organization_id',f"'{uid(10)}'")]:
            reset();run(f'update motorist_profiles set {column}={value} where id=\'{target}\';')
            check(f'target {column} ineligible no side effects','22023' in run(call(),False).stderr and count('motorist_case_mutation_results')==count('motorist_case_events')==0)
            run(f"update motorist_profiles set user_id='{uid(1003)}',active=true,access_status='active',kind='human',organization_id='{org}' where id='{target}';")
        reset(status='cancelled');check('closed unassigned cannot be claimed','22023' in run(call(),False).stderr)
        reset(owner=f"'{actor}'",status='cancelled');run(call());check('assigned closed correction permitted')
        reset();check('foreign org/case denied','P0002' in run(call(cid=uid(90)),False).stderr)
        check('stale revision rejects before effects','PT409' in run(call(revision='2026-10-12T18:00:00.000000Z'),False).stderr and count('motorist_case_events')==0)
        run("create function fixture_reject_audit() returns trigger language plpgsql as $$ begin raise exception 'fixture audit failed';end$$;create trigger fixture_audit_failure before insert on motorist_audit_log for each row execute function fixture_reject_audit();")
        check('audit failure rolls back owner event revision and receipt',run(call(),False).returncode!=0 and count('motorist_case_events')==count('motorist_case_mutation_results')==0 and run(f"select owner_id is null and updated_at='{rev}'::timestamptz from motorist_cases where id='{case}'").stdout.strip()=='t')
        run('drop trigger fixture_audit_failure on motorist_audit_log;')
        reset(); a,b=race(call(),call());check('identical concurrent command waits and returns original receipt',b.returncode==0 and json.loads(b.stdout)==json.loads(a.stdout.splitlines()[2]) and count('motorist_case_events')==count('motorist_case_mutation_results')==1)
        reset();a,b=race(call(),call(owner=actor,mutation=uid(60),fp='1'*64));check('different concurrent commands one winner and PT409 loser','PT409' in b.stderr and count('motorist_case_events')==count('motorist_case_mutation_results')==1)
        reset();a,b=race(f"update motorist_profiles set active=false where id='{target}'",call())
        check('target deactivation concurrent with assignment is rechecked after row-lock wait','22023' in b.stderr and count('motorist_case_events')==count('motorist_case_mutation_results')==0)
        run(f"update motorist_profiles set active=true where id='{target}';")
        reset();a,b=race(f"update motorist_profiles set active=false where id='{actor}'",call())
        check('actor deactivation concurrent with command cannot cross authorization lock','42501' in b.stderr and count('motorist_case_mutation_results')==0)
        run(f"update motorist_profiles set active=true where id='{actor}';")
        reset();run("create trigger fixture_receipt_failure before insert on motorist_case_mutation_results for each row execute function fixture_reject_audit();")
        check('receipt insertion failure rolls back owner event audit and revision',run(call(),False).returncode!=0 and count('motorist_case_events')==count('motorist_audit_log')==0 and run(f"select owner_id is null and updated_at='{rev}'::timestamptz from motorist_cases where id='{case}'").stdout.strip()=='t')
        run('drop trigger fixture_receipt_failure on motorist_case_mutation_results;')
        for column,value in [('access_status',"'disabled'"),('kind',"'ai'"),('organization_id',f"'{uid(10)}'")]:
            reset();run(f"update motorist_profiles set {column}={value} where id='{actor}'")
            check(f'actor {column} cannot authorize command','42501' in run(call(),False).stderr and count('motorist_case_mutation_results')==0)
            run(f"update motorist_profiles set access_status='active',kind='human',organization_id='{org}' where id='{actor}'")
        reset();run(f"update motorist_profiles set user_id='{uid(2002)}' where id='{actor}'")
        check('actor login rebound after JWT resolution cannot mutate','42501' in run(call(),False).stderr and count('motorist_case_mutation_results')==0)
        run(f"update motorist_profiles set user_id='{uid(1002)}' where id='{actor}'")
        run(call());run(f"update motorist_profiles set user_id=null where id='{actor}'")
        check('actor login removed cannot replay existing receipt','42501' in run(call(),False).stderr)
        run(f"update motorist_profiles set user_id='{uid(1002)}' where id='{actor}'")
        reset();run(f"update motorist_organizations set active=false where id='{org}'")
        check('disabled organization cannot assign','42501' in run(call(),False).stderr)
        run(f"update motorist_organizations set active=true where id='{org}'")
        check('null owner cannot clear assignment','22023' in run(call().replace(f"'{target}'",'NULL'),False).stderr)
        reset(); v1=f"select motorist_save_case_atomic('{org}','{actor}','{case}','{rev}','{{\"summary\":\"V1 saved\"}}','[]','{{}}','{command}','{'a'*64}')"
        original=json.loads(run(v1).stdout);check('V1 original edit and receipt still work',original['summary']=='V1 saved' and json.loads(run(v1).stdout)==original)
        check('cross-domain UUID reuse rejects instead of overwriting V1 receipt','PT422' in run(call(),False).stderr)
        check('service role can invoke exact version and replay contract',run('set role service_role;select motorist_case_owner_version()').stdout.strip().endswith('1'))
        reset();run('set role service_role;'+call());check('service-role-only owner transaction executes with private receipts',count('motorist_case_mutation_results')==1)
        check('authenticated cannot invoke owner/version RPC','42501' in run('set role authenticated;select motorist_case_owner_version()',False).stderr and '42501' in run('set role authenticated;'+call(),False).stderr)
        report={'ok':True,'engine':run('select version()').stdout.strip(),'tests':len(checks),'checks':checks,'scope':'isolated Unix-socket PostgreSQL, fixture only; no remote SQL','migrationSha256':hashlib.sha256((M/'20261012183000_case_owner_assignment.sql').read_bytes()).hexdigest()}
        (ROOT/'.context/mobile-phase8-owner-sql-receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
    finally:
        subprocess.run(['pg_ctl','-D',str(data),'-m','immediate','-w','stop'],env=env,stdout=subprocess.DEVNULL,check=True)
