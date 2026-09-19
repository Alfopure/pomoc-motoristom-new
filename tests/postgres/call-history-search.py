"""Read-only history RPC against disposable loopback PostgreSQL; never loads app env."""
from pathlib import Path
from uuid import UUID
from time import perf_counter
from concurrent.futures import ThreadPoolExecutor
import psycopg
ROOT=Path(__file__).resolve().parents[2]
DSN='host=127.0.0.1 hostaddr=127.0.0.1 port=55432 user=postgres connect_timeout=5'
ORG='00000000-0000-4000-8000-000000000001'
OTHER='00000000-0000-4000-8000-000000000002'
ACTOR='00000000-0000-4000-8000-000000000011'
CASE='00000000-0000-4000-8000-000000000021'
with psycopg.connect(DSN+' dbname=postgres',autocommit=True) as c:
    c.execute('drop database if exists history_contract with (force)')
    c.execute('create database history_contract')
with psycopg.connect(DSN+' dbname=history_contract',autocommit=True) as c:
    c.execute('''do $$ begin
      if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;
    create table motorist_organizations(id uuid primary key,active boolean);
    create table motorist_profiles(id uuid primary key,organization_id uuid,active boolean,access_status text,role text);
    create table motorist_contacts(id uuid primary key,organization_id uuid,name text);
    create table motorist_vehicles(id uuid primary key,organization_id uuid,license_plate text);
    create table motorist_cases(id uuid primary key,organization_id uuid,case_number text,contact_id uuid,vehicle_id uuid,customer_details jsonb,vehicle_details jsonb);
    create table motorist_calls(id uuid primary key,organization_id uuid,case_id uuid,started_at timestamptz,
      direction text,status text,operator_id uuid,line_id uuid,caller_name text,caller_number text,called_number text,
      received_number text,destination_number text,raw_latest_payload jsonb,answered_at timestamptz);
    ''')
    c.execute((ROOT/'supabase/migrations/20261006100000_call_history_search.sql').read_text())
    c.execute('insert into motorist_organizations values(%s,true),(%s,true)',(ORG,OTHER))
    c.execute("insert into motorist_profiles values(%s,%s,true,'active','dispatcher')",(ACTOR,ORG))
    c.execute('''insert into motorist_cases(id,organization_id,case_number,customer_details,vehicle_details)
      values(%s,%s,'PM-2026-0001','{"firstName":"Ľudovít","lastName":"Šťastný","companyName":"Žltý motor"}','{"licensePlate":"BA123XY"}')''',(CASE,ORG))
    c.execute('''insert into motorist_calls(id,organization_id,started_at,direction,status,caller_number)
      select md5(i::text)::uuid,%s,'2026-09-19 12:00:00+00'::timestamptz-(i/2)*interval '1 second','inbound','ended','+421 900 123 456'
      from generate_series(1,10000) i''',(ORG,))
    c.execute("update motorist_calls set case_id=%s,caller_name='Čeněk Šťastný' where id=md5('9999')::uuid",(CASE,))
    c.execute("update motorist_calls set started_at=null where id in(md5('3')::uuid,md5('4')::uuid)")
    c.execute("insert into motorist_calls values(md5('foreign')::uuid,%s,%s,now(),'inbound','ended',null,null,'Foreign','999',null,null,null,null,null)",(OTHER,CASE))
    c.execute("update motorist_calls set answered_at=started_at where id=md5('9999')::uuid")
    c.execute('analyze')
    def search(q='',limit=101,at=None,id=None,actor=ACTOR):
        return c.execute('select id,started_at from motorist_search_call_history(%s,%s,%s,null,null,null,null,null,null,%s,%s,%s)',(ORG,actor,q,at,id,limit)).fetchall()
    c.execute('set role service_role')
    answered=c.execute("select count(*) from motorist_search_call_history(%s,%s,'',null,null,null,'answered')",(ORG,ACTOR)).fetchone()[0]
    assert answered==1, 'ended answered calls must remain in Prijaté filter'
    for q in ['Cenek Stastny','Ludovit Stastny','Zlty motor','PM-2026-0001','BA123XY']:
        assert len(search(q))==1,q
    for phone in ['421900123456','0900 123 456','00421 900 123456','900123']:
        assert len(search(phone))==101,phone
    assert len(search('Foreign'))==0
    assert len(search("%' OR true --"))==0
    ids=[];at=None;id=None
    while True:
        rows=search(limit=100,at=at,id=id)
        if not rows: break
        ids.extend(str(r[0]) for r in rows);id,at=rows[-1]
    assert len(ids)==10000 and len(set(ids))==10000
    print('PASS search before limit: old caller/customer/company/case/plate/normalized phone, organization isolation, literal query, tied and null cursors (10,000 rows)')
    for actor in [str(UUID(int=999)),None]:
        try: search(actor=actor);raise AssertionError('actor admitted')
        except psycopg.errors.InsufficientPrivilege: pass
    c.execute('reset role')
    for role in ['anon','authenticated']:
        c.execute('set role '+role)
        try: search();raise AssertionError('untrusted RPC admitted')
        except psycopg.errors.InsufficientPrivilege: pass
        c.execute('reset role')
    c.execute('update motorist_profiles set active=false where id=%s',(ACTOR,))
    try: search();raise AssertionError('revoked actor admitted')
    except psycopg.errors.InsufficientPrivilege: pass
    c.execute('update motorist_profiles set active=true where id=%s',(ACTOR,))
    print('PASS server-only execution, active membership and revocation')

def timed(_):
    with psycopg.connect(DSN+' dbname=history_contract') as c:
        start=perf_counter()
        c.execute('select id from motorist_search_call_history(%s,%s,%s)',(ORG,ACTOR,'Stastny')).fetchall()
        return (perf_counter()-start)*1000
with ThreadPoolExecutor(max_workers=20) as pool: times=list(pool.map(timed,range(100)))
times.sort();p95=times[94]
print(f'MEASURE local SQL 20 concurrent clients, 10k rows, 100 searches p95={p95:.1f}ms; excludes HTTP/network/auth (not production capacity)')
assert p95<800,p95
