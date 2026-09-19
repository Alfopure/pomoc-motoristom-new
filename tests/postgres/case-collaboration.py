import json, uuid, time, statistics
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb
DSN='host=127.0.0.1 port=55432 user=postgres dbname=postgres'
with psycopg.connect(DSN,autocommit=True) as admin:
    if not admin.execute("select 1 from pg_database where datname='collaboration_contract'").fetchone(): admin.execute('create database collaboration_contract')
with psycopg.connect(DSN.replace('dbname=postgres','dbname=collaboration_contract'),autocommit=True) as db:
    db.execute('drop schema if exists public cascade; create schema public; drop schema if exists realtime cascade; drop schema if exists auth cascade; drop schema if exists app_private cascade; create schema app_private; create schema auth; create schema realtime')
    for role in ['anon','authenticated','service_role']:
        db.execute("do $$begin create role "+role+"; exception when duplicate_object then null; end$$")
    db.execute("""
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table realtime.messages(id bigserial,topic text,extension text default 'broadcast',event text,payload jsonb);
    alter table realtime.messages enable row level security;
    grant usage on schema realtime,auth,public to authenticated;
    grant select on realtime.messages to authenticated;
    create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;
    create function realtime.send(p jsonb,e text,t text,private boolean) returns void language sql as $$insert into realtime.messages(topic,event,payload) values(t,e,p)$$;
    create table motorist_organizations(id uuid primary key, active boolean default true);
    create table motorist_profiles(id uuid primary key,organization_id uuid references motorist_organizations,user_id uuid,display_name text,role text,active boolean default true,access_status text default 'active');
    grant select on motorist_profiles,motorist_organizations to authenticated;
    create table motorist_contacts(id uuid primary key,organization_id uuid,name text);
    create table motorist_vehicles(id uuid primary key,organization_id uuid,name text);
    create table motorist_locations(id uuid primary key,organization_id uuid,name text);
    create table motorist_cases(id uuid primary key,organization_id uuid,owner_id uuid,contact_id uuid,vehicle_id uuid,pickup_location_id uuid,destination_location_id uuid);
    create table motorist_case_events(id uuid primary key,organization_id uuid,case_id uuid,body text,actor_profile_id uuid,created_at timestamptz default now());
    create table motorist_location_submissions(id uuid primary key,organization_id uuid,case_id uuid,location_id uuid,accepted boolean default true,submitted_at timestamptz default now());
    create table motorist_case_tasks(id uuid primary key,organization_id uuid,case_id uuid,title text);
    create table motorist_task_messages(id uuid primary key,organization_id uuid,task_id uuid,body text);
    create table motorist_task_case_links(id uuid primary key,organization_id uuid,task_id uuid,case_id uuid);
    create table motorist_notifications(id uuid primary key,organization_id uuid,recipient_profile_id uuid,visibility text,body text);
    create table motorist_notes(id uuid primary key,organization_id uuid,owner_profile_id uuid,body text);
    create table motorist_note_shares(note_id uuid references motorist_notes on delete cascade,organization_id uuid,recipient_profile_id uuid);
    """)
    ids=[str(uuid.UUID(int=n)) for n in range(1,30)]
    org,other,actor,colleague,outsider,user,otheruser,case,foreign,contact,session,second,draft=ids[:13]
    db.execute('insert into motorist_organizations(id) values(%s),(%s)',(org,other))
    for profile,organization,uid,name in [(actor,org,user,'Jana'),(colleague,org,otheruser,'Peter'),(outsider,other,ids[20],'Outsider')]:
        db.execute("insert into motorist_profiles(id,organization_id,user_id,display_name,role) values(%s,%s,%s,%s,'dispatcher')",(profile,organization,uid,name))
    db.execute('insert into motorist_contacts values(%s,%s,%s)',(contact,org,'Customer'))
    db.execute('insert into motorist_cases(id,organization_id,owner_id,contact_id) values(%s,%s,%s,%s),(%s,%s,%s,null)',(case,org,actor,contact,foreign,other,outsider))
    db.execute(Path('supabase/migrations/20261006120000_case_collaboration.sql').read_text())
    def rpc(action,body=None,profile=actor,organization=org):
        return db.execute('select motorist_case_collaboration(%s,%s,%s,%s)',(organization,profile,action,Jsonb(body or {}))).fetchone()[0]
    def denied(fn):
        try: fn()
        except psycopg.errors.InsufficientPrivilege: return
        raise AssertionError('Expected 42501')
    def count(): return db.execute('select count(*) from realtime.messages').fetchone()[0]
    rpc('heartbeat',{'sessionId':session,'caseId':case})
    first=rpc('snapshot'); assert len(first['editors'])==1 and first['editors'][0]['displayName']=='Jana'
    assert set(first['editors'][0])=={'sessionId','profileId','displayName','caseId','draftId','expiresAt'}
    before=count();rpc('heartbeat',{'sessionId':session,'caseId':case});assert count()==before,'Heartbeats must not fan out to 20 clients'
    rpc('heartbeat',{'sessionId':second,'caseId':case});assert len(rpc('snapshot')['editors'])==2
    rpc('leave',{'sessionId':session});assert len(rpc('snapshot')['editors'])==1
    assert rpc('heartbeat',{'sessionId':session,'caseId':case})['ended'] is True
    denied(lambda:rpc('heartbeat',{'sessionId':second,'caseId':case},profile=colleague))
    denied(lambda:rpc('heartbeat',{'sessionId':draft,'caseId':foreign}))
    denied(lambda:rpc('snapshot',profile=outsider))
    rpc('heartbeat',{'sessionId':draft,'caseId':None});assert any(e['draftId']==draft for e in rpc('snapshot')['editors'])
    rpc('commit',{'sessionId':draft,'caseId':case});assert not any(e['draftId']==draft for e in rpc('snapshot')['editors'])
    late=ids[14];rpc('leave',{'sessionId':late});assert rpc('heartbeat',{'sessionId':late})['ended'] is True
    db.execute("update motorist_case_editor_sessions set expires_at=clock_timestamp()-interval '1 second' where id=%s",(second,));assert not rpc('snapshot')['editors']
    revision=rpc('snapshot')['versions'][case]
    db.execute('insert into motorist_case_events(id,organization_id,case_id,body) values(%s,%s,%s,%s)',(ids[15],org,case,'Private customer text'))
    assert rpc('snapshot')['versions'][case]>revision
    revision=rpc('snapshot')['versions'][case]
    db.execute('update motorist_contacts set name=%s where id=%s',('Changed customer',contact));assert rpc('snapshot')['versions'][case]>revision
    db.execute('insert into motorist_notifications values(%s,%s,%s,%s,%s)',(ids[16],org,actor,'private','Secret notification'))
    message=db.execute('select topic,payload from realtime.messages order by id desc limit 1').fetchone();assert message==(f'notifications:{org}:{actor}',{})
    before=count();db.execute("update motorist_notifications set recipient_profile_id=%s where id=%s",(colleague,ids[16]));assert count()==before+2
    assert db.execute("select count(*) from realtime.messages where payload<>'{}'::jsonb").fetchone()[0]==0
    # Bulk resources: latest 200 events per card, exact event actor, latest
    # accepted customer location, and no foreign resource despite a bad FK.
    vehicle,pickup,shared,foreign_contact,foreign_location=ids[21:26]
    db.execute('insert into motorist_vehicles values(%s,%s,%s)',(vehicle,org,'Fixture vehicle'))
    db.execute('insert into motorist_locations values(%s,%s,%s),(%s,%s,%s),(%s,%s,%s)',(pickup,org,'Pickup',shared,org,'Shared location',foreign_location,other,'Foreign secret'))
    db.execute('insert into motorist_contacts values(%s,%s,%s)',(foreign_contact,other,'Foreign customer'))
    db.execute('update motorist_cases set vehicle_id=%s,pickup_location_id=%s,destination_location_id=%s where id=%s',(vehicle,pickup,foreign_location,case))
    db.execute("update motorist_case_events set created_at='2026-09-18T10:00:00Z' where case_id=%s",(case,))
    for i in range(205):
        db.execute("insert into motorist_case_events(id,organization_id,case_id,body,actor_profile_id,created_at) values(%s,%s,%s,%s,%s,'2026-09-19T10:00:00Z')",(str(uuid.UUID(int=1000+i)),org,case,'Event '+str(i),colleague))
    db.execute("insert into motorist_location_submissions(id,organization_id,case_id,location_id,accepted,submitted_at) values(%s,%s,%s,%s,true,'2026-09-19T10:00:00Z'),(%s,%s,%s,%s,false,'2026-09-19T11:00:00Z')",(ids[26],org,case,shared,ids[27],org,case,pickup))
    snapshot=rpc('snapshot'); details=snapshot['details']
    events=[e for e in details['events'] if e['case_id']==case]
    assert len(events)==200 and events[0]['id']==str(uuid.UUID(int=1204)) and events[-1]['id']==str(uuid.UUID(int=1005))
    assert details['submissions'][0]['id']==ids[26]
    assert {r['id'] for r in details['locations']}=={pickup,shared}
    assert {r['id'] for r in details['profiles']}=={actor,colleague}
    assert {r['id'] for r in details['contacts']}=={contact}
    unchanged=rpc('snapshot',{'versions':snapshot['versions']});assert unchanged['details']['cases']==[] and unchanged['more'] is False
    # An uncommitted change is wholly invisible; its resource + revision arrive
    # together after commit, with no second detail repository race window.
    with psycopg.connect(DSN.replace('dbname=postgres','dbname=collaboration_contract')) as writer:
        writer.execute('update motorist_contacts set name=%s where id=%s',('Atomic new name',contact))
        before_commit=rpc('snapshot');assert before_commit['versions'][case]==snapshot['versions'][case]
        assert before_commit['details']['contacts'][0]['name']=='Changed customer'
        writer.commit()
    after_commit=rpc('snapshot');assert after_commit['versions'][case]>snapshot['versions'][case]
    assert after_commit['details']['contacts'][0]['name']=='Atomic new name'
    # Fill 100 cases with shared relation resources, check bounded continuation
    # never acknowledges missing cards and deduplicates common resources.
    for i in range(1,100):
        db.execute('insert into motorist_cases(id,organization_id,owner_id,contact_id,vehicle_id,pickup_location_id) values(%s,%s,%s,%s,%s,%s)',(str(uuid.UUID(int=2000+i)),org,actor,contact,vehicle,pickup))
    versions={};seen=set();pages=0
    while True:
        page=rpc('snapshot',{'versions':versions});pages+=1
        assert len(page['details']['cases'])<=40
        assert len(page['details']['contacts'])<=1 and len(page['details']['vehicles'])<=1
        for row in page['details']['cases']:
            assert row['id'] not in seen;seen.add(row['id']);versions[row['id']]=page['versions'][row['id']]
        if not page['more']:break
    assert pages==3 and len(seen)==100 and set(versions)==set(page['versions'])
    assert db.execute("select count(*) from pg_indexes where indexname='motorist_case_events_live_snapshot_idx'").fetchone()[0]==1
    db.execute("set role authenticated");db.execute("select set_config('request.jwt.claim.sub',%s,false)",(user,));db.execute("select set_config('realtime.topic',%s,false)",(f'notifications:{org}:{colleague}',))
    assert db.execute('select count(*) from realtime.messages').fetchone()[0]==0
    denied(lambda:rpc('snapshot'));db.execute('reset role')
    # access_status alone revokes final authorization, writes, RLS and presence.
    rpc('heartbeat',{'sessionId':ids[17],'caseId':case})
    db.execute("update motorist_profiles set access_status='revoked' where id=%s",(actor,))
    for action in ['snapshot','authorize','heartbeat','leave','commit']:
        denied(lambda action=action:rpc(action,{'sessionId':ids[17],'caseId':case}))
    assert not any(e['profileId']==actor for e in rpc('snapshot',profile=colleague)['editors'])
    assert db.execute("select count(*) from realtime.messages where topic=%s and event='revoke'",(f'notifications:{org}:{actor}',)).fetchone()[0]>=1
    db.execute('set role authenticated');db.execute("select set_config('realtime.topic',%s,false)",(f'cases:{org}',))
    assert db.execute('select count(*) from realtime.messages').fetchone()[0]==0
    db.execute('reset role');db.execute("update motorist_profiles set access_status='active' where id=%s",(actor,))
    db.execute('update motorist_profiles set active=false where id=%s',(actor,));denied(lambda:rpc('snapshot'));denied(lambda:rpc('heartbeat',{'sessionId':session,'caseId':case}))
    db.execute('delete from motorist_cases where id=%s',(case,));assert case not in rpc('snapshot',profile=colleague)['versions']
    # Event-dense disposable benchmark: 100 cards, 22k events, 20 clients.
    # Bulk fixture setup alone disables invalidation triggers; tested writers above
    # always ran with the real migration triggers enabled.
    db.execute("update motorist_profiles set active=true where id=%s",(actor,))
    db.execute('insert into motorist_cases(id,organization_id,owner_id,contact_id,vehicle_id,pickup_location_id) values(%s,%s,%s,%s,%s,%s)',(case,org,actor,contact,vehicle,pickup))
    db.execute('alter table motorist_case_events disable trigger user')
    db.execute("insert into motorist_case_events(id,organization_id,case_id,body,actor_profile_id,created_at) select gen_random_uuid(),%s,c.id,'Load fixture',%s,'2026-09-19T12:00:00Z'::timestamptz - make_interval(secs=>n) from motorist_cases c cross join generate_series(1,220) n where c.organization_id=%s",(org,actor,org))
    db.execute('alter table motorist_case_events enable trigger user');db.execute('analyze motorist_case_events')
    plan=db.execute("explain (format json) select * from motorist_case_events where organization_id=%s and case_id=%s order by created_at desc,id desc limit 200",(org,case)).fetchone()[0]
    assert 'motorist_case_events_live_snapshot_idx' in json.dumps(plan)
    def measured_client(index):
        with psycopg.connect(DSN.replace('dbname=postgres','dbname=collaboration_contract'),autocommit=True) as connection:
            known={}; timings=[]; pages=0
            while True:
                start=time.perf_counter()
                page=connection.execute('select motorist_case_collaboration(%s,%s,%s,%s)',(org,actor,'snapshot',Jsonb({'versions':known}))).fetchone()[0]
                timings.append((time.perf_counter()-start)*1000);pages+=1
                assert len(page['details']['cases'])<=40 and len(page['details']['events'])<=8000
                for row in page['details']['cases']:known[row['id']]=page['versions'][row['id']]
                if not page['more']:break
            assert len(known)==100
            return timings,pages
    with ThreadPoolExecutor(max_workers=20) as pool:measurements=list(pool.map(measured_client,range(20)))
    timings=sorted(t for ts,_ in measurements for t in ts)
    workload={'clients':20,'cards':100,'events':db.execute('select count(*) from motorist_case_events where organization_id=%s',(org,)).fetchone()[0], 'snapshotRPCs':sum(p for _,p in measurements),'snapshotRPCp95Ms':round(timings[int(len(timings)*.95)-1],1),'eventIndexUsed':True,'scope':'actual local PostgreSQL RPC including JSON decoding; excludes HTTP/auth/notifications/final-authorize and remote network'}
    Path('.context/collaboration/sql-workload.json').write_text(json.dumps(workload,indent=2)+'\n')
    print(json.dumps({'migration':'20261006120000_case_collaboration.sql','database':'local PostgreSQL17 collaboration_contract','assertions':'passed','checks':['heartbeat identity and case scope','lease expiry','two independent sessions','tombstone prevents late heartbeat','draft commit','case event and contact invalidation','exact notification audiences including reassignment','empty broadcast payloads','RLS denies foreign private topic','authenticated cannot forge RPC identity','revocation including access_status across reads writes presence and RLS','deletion','no broadcast on heartbeat renewal','coherent bulk resources and revisions','latest200 events and accepted location','deduplicated organization scoped resources','bounded40-card continuation','event index used in dense22k fixture']},indent=2))
