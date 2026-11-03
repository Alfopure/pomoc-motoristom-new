"""Isolated PostgreSQL contract test for idempotent call-event audit rows.

`recordCallEvent` writes `motorist_call_events` through PostgREST with
`on_conflict=organization_id,provider,event_fingerprint` and
`Prefer: resolution=ignore-duplicates`, i.e. INSERT ... ON CONFLICT (...) DO
NOTHING. That statement fails with 42P10 unless a non-partial unique index on
exactly those columns exists, so this checks the repository's migrations, not
an assumed schema. No migration is needed for the change; this proves why.

Creates a disposable local cluster on a unix socket, applies every repository
migration over minimal auth/storage/realtime stubs. Never reads PG* variables
or remote DSNs.
Run: python3 tests/postgres/telephony-event-idempotency.py
"""
import json, os, pathlib, subprocess, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
M = ROOT / 'supabase/migrations'
ORG = '00000000-0000-4000-8000-000000000001'
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

# The statement PostgREST builds for the upsert in src/server/telephony/state/effects.ts.
UPSERT = """set role service_role;
insert into public.motorist_call_events (organization_id, call_id, provider, provider_session_id, event_type, event_fingerprint,
  payload, raw_payload, normalized_payload, handled_status, provider_timestamp, received_at)
values ('%s', null, 'telnyx', 'v3:fixture', 'call.answered', '%s', '{}', '{}', '%s', 'processed', now(), now())
on conflict (organization_id, provider, event_fingerprint) do nothing
returning id;"""

with tempfile.TemporaryDirectory(prefix='pm-event-idem-pg-') as temp:
    base = pathlib.Path(temp); data = base / 'data'; sock = base / 'sock'; sock.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    subprocess.run(['initdb', '-D', str(data), '--auth=trust', '--no-locale', '--encoding=UTF8'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    subprocess.run(['pg_ctl', '-D', str(data), '-l', str(base / 'server.log'), '-o', f"-k {sock} -h '' -p 56517", '-w', 'start'], env=env, stdout=subprocess.DEVNULL, check=True)
    def psql(args, sql=None, ok=True):
        r = subprocess.run(['psql', '-X', '-h', str(sock), '-p', '56517', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', *args], input=sql, env=env, capture_output=True, text=True)
        if ok and r.returncode: raise AssertionError(r.stderr + '\nSQL:' + (sql or str(args))[:1500])
        return r
    def run(sql, ok=True): return psql([], sql, ok)
    def value(sql):
        out = run(sql).stdout.strip()
        return out.splitlines()[-1] if out else ''
    def check(name, condition=True):
        assert condition, name
        checks.append(name)
    def fails_with(sql, code):
        r = run("\\set VERBOSITY verbose\n" + sql, False)
        return r.returncode != 0 and code in r.stderr
    try:
        run(STUBS)
        for f in sorted(M.glob('*.sql')):
            r = psql(['-q', '-f', str(f)], ok=False)
            if r.returncode and f.name not in KNOWN_FIXTURE_GAPS: raise AssertionError(f'{f.name}: {r.stderr[-1500:]}')
            if f.name.endswith('foundation_schema.sql'):
                run(f"insert into motorist_organizations(id,slug,name,active) values('{ORG}','fixture','Fixture',true)")
        check('all migrations apply over the stubbed platform schemas')
        # Hosted Supabase grants these through platform default privileges (same as telephony-fencing.py).
        run('grant select,insert,update,delete on all tables in schema public to service_role')

        arbiter = value("""select count(*) from pg_index i join pg_class t on t.oid = i.indrelid
          where t.relname = 'motorist_call_events' and t.relnamespace = 'public'::regnamespace and i.indisunique and i.indpred is null
            and (select array_agg(a.attname::text order by a.attname) from unnest(i.indkey) k join pg_attribute a on a.attrelid = t.oid and a.attnum = k)
              = array['event_fingerprint', 'organization_id', 'provider']""")
        check('a non-partial unique index on (organization_id, provider, event_fingerprint) exists after all migrations', arbiter == '1')

        normalized = json.dumps({'session_id': None, 'notes': ['first']}).replace("'", "''")
        first = run(UPSERT % (ORG, 'evt-duplicate-delivery', normalized)).stdout.strip().splitlines()
        check('the first delivery inserts its audit row', len([line for line in first if len(line) == 36]) == 1)
        again = run(UPSERT % (ORG, 'evt-duplicate-delivery', normalized.replace('first', 'second')))
        check('a duplicate delivery is a successful no-op without 23505', again.returncode == 0 and not [line for line in again.stdout.strip().splitlines() if len(line) == 36])
        check('the original audit row is kept unchanged', value("select normalized_payload->'notes'->>0 from motorist_call_events where event_fingerprint='evt-duplicate-delivery'") == 'first')
        check('exactly one row exists for the event', value("select count(*) from motorist_call_events where event_fingerprint='evt-duplicate-delivery'") == '1')
        check('the duplicate leaves no ERROR in the server log', 'duplicate key value' not in (base / 'server.log').read_text())
        check('a plain INSERT of the same event still raises 23505 (the identity is enforced)', fails_with(
            f"insert into motorist_call_events(organization_id, provider, event_type, event_fingerprint) values('{ORG}','telnyx','call.answered','evt-duplicate-delivery')", '23505'))
        check('a different event id is still recorded', len([line for line in run(UPSERT % (ORG, 'evt-other', normalized)).stdout.strip().splitlines() if len(line) == 36]) == 1)
        print(json.dumps({'passed': len(checks), 'checks': checks}, ensure_ascii=False, indent=1))
    finally:
        subprocess.run(['pg_ctl', '-D', str(data), '-m', 'immediate', 'stop'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
