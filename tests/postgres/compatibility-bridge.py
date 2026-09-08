"""Loopback-only relational persistence bridge for compatibility callers.
SQL contract migrations are real; the TypeScript query builder still filters
rows in memory. This is deliberately not PostgREST/RLS or a full Supabase reset.
"""
import json, sys, re
from pathlib import Path
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

# Explicit hostaddr prevents inherited PGHOSTADDR from redirecting fixture writes.
LOOPBACK_DSN = "host=127.0.0.1 hostaddr=127.0.0.1 port=55432 user=postgres connect_timeout=5"
ROOT = Path(__file__).resolve().parents[2]
DATABASE = 'stability_compatibility'
DSN = f'{LOOPBACK_DSN} dbname={DATABASE}'
request = json.load(sys.stdin)
if request['op'] == 'setup':
    with psycopg.connect(f'{LOOPBACK_DSN} dbname=postgres', autocommit=True) as c:
        bootstrap_address = c.execute('select host(inet_server_addr())').fetchone()[0]
        assert bootstrap_address == '127.0.0.1'
        c.execute(f'drop database if exists {DATABASE} with (force)')
        c.execute(f'create database {DATABASE}')
with psycopg.connect(DSN, autocommit=True) as c:
    server_address = c.execute('select host(inet_server_addr())').fetchone()[0]
    assert server_address == '127.0.0.1'
    def tables():
        return [r[0] for r in c.execute("select tablename from pg_tables where schemaname='public' and tablename like 'motorist_%'")]
    def snapshot():
        return {t:[r[0] for r in c.execute(sql.SQL('select to_jsonb(t) from {} t').format(sql.Identifier(t)))] for t in tables()}
    def shape(t, rows):
        if not re.fullmatch(r'motorist_[a-z_]+', t): raise ValueError(t)
        c.execute(sql.SQL('create table if not exists {} (id uuid primary key default gen_random_uuid())').format(sql.Identifier(t)))
        columns = {r[0] for r in c.execute('select column_name from information_schema.columns where table_schema=\'public\' and table_name=%s',(t,))}
        for key in {k for row in rows for k in row} - columns:
            values = [r[key] for r in rows if r.get(key) is not None]
            value = values[0] if values else None
            kind = 'jsonb' if isinstance(value,(dict,list)) else 'boolean' if isinstance(value,bool) else 'numeric' if isinstance(value,(int,float)) else 'text'
            if key in ('metadata','client_state','pending_effects','presence_pickup','presence_cancellations','pause_return','raw_payload','raw_latest_payload'): kind='jsonb'
            c.execute(sql.SQL('alter table {} add column {} {}').format(sql.Identifier(t),sql.Identifier(key),sql.SQL(kind)))
    def sync(t, rows):
        shape(t, rows)
        for row in rows:
            keys=list(row)
            ident='event_id' if t=='motorist_telnyx_webhook_events' else 'job_name' if t=='motorist_job_controls' else 'incident_id' if t=='motorist_job_incidents' else 'id'
            if ident not in row: raise ValueError((t, row))
            existing=c.execute(sql.SQL('select 1 from {} where {}::text=%s').format(sql.Identifier(t),sql.Identifier(ident)),(str(row[ident]),)).fetchone()
            cols=sql.SQL(',').join(map(sql.Identifier,keys))
            if existing:
                assignments=sql.SQL(',').join(sql.SQL('{}=r.{}').format(sql.Identifier(k),sql.Identifier(k)) for k in keys)
                c.execute(sql.SQL('update {} t set {} from jsonb_populate_record(null::{},%s) r where t.{}::text=%s').format(sql.Identifier(t),assignments,sql.Identifier(t),sql.Identifier(ident)),(Jsonb(row),str(row[ident])))
            else:
                c.execute(sql.SQL('insert into {} ({}) select {} from jsonb_populate_record(null::{},%s)').format(sql.Identifier(t),cols,cols,sql.Identifier(t)),(Jsonb(row),))
    op=request['op']
    try:
        if op=='setup':
            c.execute((ROOT/'tests/postgres/presence-fixture.sql').read_text())
            c.execute('''alter table motorist_profiles add column active boolean default true,add column role text;
            alter table motorist_call_sessions add column direction text,add column started_at timestamptz;
            create table motorist_calls(id uuid primary key,organization_id uuid,direction text,caller_number text,called_number text,destination_number text,line_id uuid,case_id uuid,session_id uuid);
            create table motorist_callback_requests(id uuid primary key default gen_random_uuid(),organization_id uuid,caller_number text,caller_name text,source text,status text default 'open',session_id uuid,line_id uuid,case_id uuid,claimed_by uuid,claimed_at timestamptz,due_at timestamptz,resolved_at timestamptz,notes text,metadata jsonb default '{}',created_at timestamptz default now(),updated_at timestamptz default now());
            create table motorist_case_tasks(id uuid primary key default gen_random_uuid(),organization_id uuid,case_id uuid,title text,kind text,status text,due_at timestamptz,assigned_to uuid,priority text,completed_at timestamptz,completed_by uuid);
            create table motorist_audit_log(id uuid primary key default gen_random_uuid(),organization_id uuid,actor_profile_id uuid,action text,entity_type text,entity_id uuid,source text,before_payload jsonb,after_payload jsonb);
            create table motorist_ring_group_members(id uuid primary key,owner_profile_id uuid);
            ''')
            for name in ['20260928100000_atomic_presence_contract.sql','20260928110000_durable_transition_effects.sql','20260928120000_callback_contact_fulfillment.sql']:
                c.execute((ROOT/'supabase/migrations'/name).read_text())
            index=ROOT/'supabase/migrations/20260928140000_personal_mobile_owner_index.sql'
            if index.exists(): c.execute(index.read_text())
            result={'database':DATABASE,'rpcMigrations':3,'ownerIndex':index.exists(),
                    'bootstrapServerAddress':bootstrap_address,'serverAddress':server_address}
        elif op=='sync':
            with c.transaction():
                for table,rows in request['tables'].items(): sync(table,rows)
            result=snapshot()
        elif op=='delete':
            c.execute(sql.SQL('delete from {} where id=any(%s::uuid[])').format(sql.Identifier(request['table'])),(request['ids'],))
            result=snapshot()
        elif op=='rpc':
            name=request['name']; args=request['args']
            if not re.fullmatch(r'motorist_[a-z_0-9]+',name): raise ValueError(name)
            signature=c.execute("select proargnames,proargtypes::regtype[]::text from pg_proc where pronamespace='public'::regnamespace and proname=%s",(name,)).fetchone()
            if not signature: raise ValueError('missing SQL RPC '+name)
            # Parse arg types via unnest: array text includes its zero lower bound.
            types=[r[0] for r in c.execute("select unnest(proargtypes)::regtype::text from pg_proc where pronamespace='public'::regnamespace and proname=%s",(name,))]
            params=[]; fragments=[]
            for k,v in args.items():
                typ=types[signature[0].index(k)]
                params.append(Jsonb(v) if typ=='jsonb' else v)
                fragments.append(sql.SQL('{} => %s::{}').format(sql.Identifier(k),sql.SQL(typ)))
            result=c.execute(sql.SQL('select {}({})').format(sql.Identifier(name),sql.SQL(',').join(fragments)),params).fetchone()[0]
            result={'value':result,'tables':snapshot()}
        elif op=='fault':
            if request['enabled']:
                c.execute("create or replace function compat_fail_audit() returns trigger language plpgsql as $$ begin if new.action='telephony.callback.contact_done' then raise exception 'compat injected terminal audit failure'; end if; return new; end $$; create trigger compat_audit before insert on motorist_audit_log for each row execute function compat_fail_audit()")
            else:c.execute('drop trigger if exists compat_audit on motorist_audit_log')
            result=True
        elif op=='snapshot':result=snapshot()
        else:raise ValueError(op)
        print(json.dumps({'data':result},default=str))
    except Exception as e:
        print(json.dumps({'error':{'message':str(e),'code':getattr(e,'sqlstate',None) or 'FIXTURE'}}))
