"""Real isolated PostgreSQL contract for partner case follow-ups. Never reads PG* credentials or remote DSNs.

Applies every repository migration in order to a disposable local cluster on stubbed Supabase
auth/storage/realtime schemas. Run: python3 tests/postgres/partner-case-followups.py
"""
import json, os, pathlib, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
M=ROOT/'supabase/migrations'
# Known local-only failure: a seed row references a ring plan that only exists remotely.
TOLERATED={'20260926100000_assistance_line_labels.sql'}
PORT='56602'
checks=[]
def uid(n):return f'72000000-0000-4000-8000-{n:012d}'
org='00000000-0000-4000-8000-000000000001'; otherorg=uid(2)
office=uid(10); foreign=uid(11); usera=uid(12); userb=uid(13)
partnera=uid(20); partnerb=uid(21); membera=uid(22); memberb=uid(23)
casea1=uid(30); casea2=uid(31); caseb1=uid(32); casex=uid(33); casea3=uid(34)
serial=1000
PRELUDE="""
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role supabase_auth_admin nologin; create role authenticator nologin;
create schema extensions; create schema auth; create schema storage; create schema realtime; create schema cron; create schema vault; create schema net;
create extension pgcrypto with schema extensions; create extension citext with schema extensions;
alter database postgres set search_path to "$user", public, extensions;
create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', created_at timestamptz default now(), last_sign_in_at timestamptz, banned_until timestamptz, deleted_at timestamptz, encrypted_password text, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[], owner uuid, created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql as $$select string_to_array(name,'/')$$;
create table realtime.messages(id bigserial, topic text, extension text, payload jsonb, event text, private boolean);
create publication supabase_realtime;
create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;
"""
ALLOWED={'caseId','caseNumber','createdAt','caseType','workStatus','vehicle','insuranceEvent','insuranceLabel','insuranceMarkedAt','status','revision','takenAt','takenBy','contactedAt','contactedBy','customer','notes'}
with tempfile.TemporaryDirectory(prefix='pm-partner-followups-pg-') as temp:
 base=pathlib.Path(temp);data=base/'data';sock=base/'socket';sock.mkdir()
 env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
 subprocess.run(['initdb','-D',str(data),'--auth=trust','--no-locale','--encoding=UTF8'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
 subprocess.run(['pg_ctl','-D',str(data),'-l',str(base/'server.log'),'-o',f"-k {sock} -h '' -p {PORT}",'-w','start'],env=env,stdout=subprocess.DEVNULL,check=True)
 def psql(args,sql):return subprocess.run(['psql','-X','-h',str(sock),'-p',PORT,'-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At',*args],input=sql,env=env,capture_output=True,text=True)
 def run(sql,ok=True):
  r=psql([],sql)
  if ok and r.returncode:raise AssertionError(r.stderr+'\nSQL:'+sql[:2000])
  return r
 def value(sql):return run(sql).stdout.strip().splitlines()[-1]
 def check(name,condition=True):
  assert condition,name
  checks.append(name)
 def denied(sql,code='42501'):r=run(sql,False);return r.returncode!=0 and code in r.stderr
 def q(v):return "'"+json.dumps(v).replace("'","''")+"'::jsonb"
 def next_id():
  global serial
  serial+=1;return uid(serial)
 def office_sql(case,flag,rev,label=None,who=office,command=None,organization=org):
  return f"select public.motorist_partner_followup_office_command('{who}','{organization}','{command or next_id()}',{rev},'set_insurance',{q({'caseId':case,'insuranceEvent':flag,'label':label})})"
 def partner_sql(action,case,rev=0,who=usera,command=None,version=1,body=None):
  payload={'caseId':case,**({'body':body} if body is not None else {})}
  return f"select public.motorist_partner_followup_command('{who}','{org}',{version},'{command or next_id()}',{rev},'{action}',{q(payload)})"
 def portal(who=usera,version=1,start='2026-01-01',end='2027-01-01'):return json.loads(value(f"select public.motorist_partner_portal_cases('{who}','{org}',{version},'{start}','{end}')"))
 def office_read(case=None,who=office,start='2026-01-01',end='2027-01-01'):return json.loads(value(f"select public.motorist_partner_followup_office_read('{who}','{org}','{start}','{end}',{'null' if case is None else chr(39)+case+chr(39)})"))
 try:
  run(PRELUDE)
  for f in sorted(M.glob('*.sql')):
   r=psql(['-q','-f',str(f)],'')
   if r.returncode and f.name not in TOLERATED:raise AssertionError(f'{f.name}: {r.stderr[-1500:]}')
   if f.name.endswith('foundation_schema.sql'):run(f"insert into public.motorist_organizations(id,slug,name,active) values('{org}','pomoc','Pomoc',true)")
  check('all migrations including follow-ups apply to a fresh local cluster')
  run(f"""insert into motorist_organizations(id,slug,name,active) values('{otherorg}','other','Other',true);
insert into auth.users(id) values('{office}'),('{foreign}'),('{usera}'),('{userb}');
insert into motorist_profiles(id,user_id,organization_id,display_name,role,active) values('{office}','{office}','{org}','Fixture dispatcher','dispatcher',true),('{foreign}','{foreign}','{otherorg}','Foreign manager','manager',true);
insert into motorist_partner_directory(id,organization_id,kind,name,active) values('{partnera}','{org}','company','Final CD',true),('{partnerb}','{org}','company','Second partner',true);
insert into motorist_partner_memberships(id,organization_id,partner_id,auth_user_id,email,display_name,status) values('{membera}','{org}','{partnera}','{usera}','finalcd@example.invalid','Final CD','active'),('{memberb}','{org}','{partnerb}','{userb}','second@example.invalid','Second partner','active');
insert into motorist_vehicles(id,organization_id,make,model,license_plate,vin,notes) values('{uid(40)}','{org}','Škoda','Octavia','BA123AA','VIN-SECRET','VEHICLE SECRET');
insert into motorist_contacts(id,organization_id,name,phone,email,role,notes) values('{uid(41)}','{org}','Ján Klient','+421900111222','klient@example.invalid','client','CONTACT SECRET');
insert into motorist_cases(id,organization_id,case_number,status,priority,source_type,case_type,vehicle_id,contact_id,summary,main_note,customer_details,created_at) values
 ('{casea1}','{org}','PM-2026-0001','dispatched','normal','partner','Odťah','{uid(40)}','{uid(41)}','SUMMARY SECRET','INTERNAL SECRET','{{"companyIdNumber":"ICO SECRET","note":"NOTE SECRET"}}','2026-10-01T10:00:00Z'),
 ('{casea2}','{org}','PM-2026-0002','completed_assisted','normal','partner','Konzultácia',null,null,'SUMMARY SECRET','INTERNAL SECRET','{{"firstName":"Mária","lastName":"Druhá","contacts":[{{"phone":"+421900333444","isPrimary":true}}]}}','2026-10-02T10:00:00Z'),
 ('{casea3}','{org}','PM-2026-0005','new','normal','partner','Asistencia',null,null,null,null,'{{"firstName":"Peter","lastName":"Tretí","contacts":[{{"phone":"+421900000001"}},{{"phone":"+421900000002","isPrimary":true}}]}}','2025-12-01T10:00:00Z'),
 ('{caseb1}','{org}','PM-2026-0003','new','normal','partner','Odťah',null,null,'B SECRET','B SECRET','{{"firstName":"Bčko","contacts":[{{"phone":"+421900999999"}}]}}','2026-10-03T10:00:00Z'),
 ('{casex}','{org}','PM-2026-0004','new','normal','client','Odťah',null,null,'X SECRET','X SECRET','{{}}','2026-10-04T10:00:00Z');
""")
  settlement={'payer':'SETTLEMENT SECRET','reference':'REF SECRET','agreement':'','agreementVersion':'','billable':False,'approvedCents':None,'currency':'EUR','recommendation':'','serviceAccepted':False,'acceptanceEvidence':''}
  for case,partner in [(casea1,partnera),(casea2,partnera),(casea3,partnera),(caseb1,partnerb)]:
   run(f"select public.motorist_partner_command('{office}','{org}','{next_id()}',0,'set_context',{q({'caseId':case,'partnerId':partner,'settlement':settlement})})")
  fixed=lambda:value(f"select md5(string_agg(to_jsonb(c)::text||coalesce(to_jsonb(x)::text,''),'|' order by c.id)) from motorist_cases c left join motorist_partner_case_contexts x on x.case_id=c.id")
  before=fixed()

  # Grants: browser roles cannot reach anything; service role only executes the four RPCs.
  rpcs=["motorist_partner_portal_cases(uuid,uuid,bigint,timestamptz,timestamptz)","motorist_partner_followup_command(uuid,uuid,bigint,uuid,bigint,text,jsonb)","motorist_partner_followup_office_command(uuid,uuid,uuid,bigint,text,jsonb)","motorist_partner_followup_office_read(uuid,uuid,timestamptz,timestamptz,uuid)"]
  helpers=["motorist_partner_followup_member(uuid,uuid,bigint)","motorist_partner_followup_office(uuid,uuid)","motorist_partner_followup_projection(uuid,uuid,boolean)","motorist_partner_followup_stats(uuid,uuid,timestamptz,timestamptz)"]
  for role in ['anon','authenticated']:
   check(f'{role} has no execute on follow-up RPCs',all(value(f"select has_function_privilege('{role}','public.{f}','EXECUTE')")=='f' for f in rpcs+helpers))
   check(f'{role} call is denied',denied(f"set role {role};"+partner_sql('take',casea1)) and denied(f"set role {role};select public.motorist_partner_portal_cases('{usera}','{org}',1,'2026-01-01','2027-01-01')") and denied(f"set role {role};"+office_sql(casea1,True,0)))
   check(f'{role} cannot read follow-up tables',all(denied(f"set role {role};select * from public.{t}") for t in ['motorist_partner_case_followups','motorist_partner_case_notes','motorist_partner_followup_commands']))
  check('service role executes the four RPCs only',all(value(f"select has_function_privilege('service_role','public.{f}','EXECUTE')")=='t' for f in rpcs) and all(value(f"select has_function_privilege('service_role','public.{f}','EXECUTE')")=='f' for f in helpers))
  check('service role cannot write follow-up tables directly',denied(f"set role service_role;insert into public.motorist_partner_case_notes(id,organization_id,case_id,partner_id,membership_id,author_label,body) values('{uid(900)}','{org}','{casea1}','{partnera}','{membera}','x','x')") and denied(f"set role service_role;update public.motorist_partner_case_followups set status='contacted'"))
  check('service role can invoke the portal read',json.loads(value(f"set role service_role;select public.motorist_partner_portal_cases('{usera}','{org}',1,'2026-01-01','2027-01-01')"))['account']=='Final CD')

  # Office marks the insurance event, with optimistic revision and idempotent receipts.
  mark=next_id();sql=office_sql(casea1,True,0,'Kasko',command=mark)
  first=json.loads(value(sql))
  check('office marks insurance event at revision 1',first['insuranceEvent'] is True and first['revision']==1)
  check('identical office replay returns the receipt',json.loads(value(sql))==first and value(f"select count(*) from motorist_audit_log where action='partner.followup.set_insurance' and entity_id='{casea1}'")=='1')
  check('office command id reused with other content conflicts',denied(office_sql(casea1,False,0,command=mark),'40001'))
  check('stale office revision conflicts',denied(office_sql(casea1,True,0),'40001'))
  check('foreign organization office cannot mark',denied(office_sql(casea1,True,1,who=foreign)) and denied(office_sql(casea1,True,1,who=foreign,organization=otherorg)))
  check('partner account is not an office actor',denied(office_sql(casea1,True,1,who=usera)) and denied(f"select public.motorist_partner_followup_office_read('{usera}','{org}','2026-01-01','2027-01-01',null)"))
  check('case without partner context cannot be marked',denied(office_sql(casex,True,0)))
  json.loads(value(office_sql(caseb1,True,0)))
  json.loads(value(office_sql(casea3,True,0)))

  # Partner A: own allowlisted cases only.
  a=portal()
  ids=[c['caseId'] for c in a['cases']]
  check('partner A lists own still-new insurance events first, then own period cases',ids==[casea1,casea3,casea2])
  check('partner A rows contain only allowlisted fields',all(set(c)==ALLOWED for c in a['cases']) and all(set(c['vehicle'])=={'make','model','plate'} for c in a['cases']))
  check('no internal note, settlement, other partner or unrelated case leaks',not any(s in json.dumps(a,ensure_ascii=False) for s in ['SECRET','Bčko','+421900999999',caseb1,casex,'klient@example.invalid']))
  row=lambda p,case:next(c for c in p['cases'] if c['caseId']==case)
  a1=row(a,casea1)
  check('insurance row carries vehicle, coarse status and customer contact',a1['vehicle']=={'make':'Škoda','model':'Octavia','plate':'BA123AA'} and a1['workStatus']=='in_progress' and a1['customer']=={'name':'Ján Klient','phone':'+421900111222'} and a1['insuranceLabel']=='Kasko')
  check('customer contact only on insurance events',row(a,casea2)['customer'] is None and row(a,casea2)['insuranceEvent'] is False and row(a,casea2)['workStatus']=='completed')
  check('contact falls back to the primary stored case contact',row(a,casea3)['customer']=={'name':'Peter Tretí','phone':'+421900000002'})
  check('new insurance badge counts own new events only',a['newInsurance']==2 and portal(userb)['newInsurance']==1)

  # Partner B is isolated from A.
  b=portal(userb)
  check('partner B sees only its own case',[c['caseId'] for c in b['cases']]==[caseb1] and 'Final CD' not in json.dumps(b) and b['stats']['cases']==1)
  check('partner B cannot take, contact or annotate A cases',denied(partner_sql('take',casea1,1,who=userb)) and denied(partner_sql('contacted',casea1,1,who=userb)) and denied(partner_sql('note',casea1,who=userb,body='cudzia')))

  # Take/contacted with revision conflicts and idempotent replay.
  take=next_id();sql=partner_sql('take',casea1,1,command=take)
  t1=json.loads(value(sql))
  check('partner A takes insurance event',t1=={'ok':True,'caseId':casea1,'status':'taken','revision':2})
  check('identical take replay is stable without a second audit row',json.loads(value(sql))==t1 and value(f"select count(*) from motorist_audit_log where action='partner.followup.take' and entity_id='{casea1}'")=='1')
  check('take command id replayed by partner B is denied',denied(partner_sql('take',casea1,1,who=userb,command=take)))
  check('take command id with changed content conflicts',denied(partner_sql('take',casea1,2,command=take),'40001'))
  check('second take with the stale revision conflicts',denied(partner_sql('take',casea1,1),'40001'))
  check('second take at current revision conflicts as already taken',denied(partner_sql('take',casea1,2),'40001'))
  check('contacted before take is rejected',denied(partner_sql('contacted',casea3,1),'40001'))
  check('take on a non-insurance case is rejected',denied(partner_sql('take',casea2,0),'22023'))
  c1=json.loads(value(partner_sql('contacted',casea1,2)))
  check('partner A records client contact',c1['status']=='contacted' and c1['revision']==3)
  audit=json.loads(value(f"select after_payload||jsonb_build_object('profile',actor_profile_id) from motorist_audit_log where action='partner.followup.contacted' and entity_id='{casea1}'"))
  check('shared account audit records the account, not a person',audit['profile'] is None and audit['actorKind']=='partner_account' and audit['account']=='Final CD' and audit['membershipId']==membera)

  # Partner-owned append-only notes.
  note=next_id();nsql=partner_sql('note',casea1,command=note,body='Klient volal späť')
  value(nsql);value(nsql)
  check('note replay creates one note',value(f"select count(*) from motorist_partner_case_notes where case_id='{casea1}'")=='1')
  check('empty note rejected',denied(partner_sql('note',casea1,body='  '),'22023'))
  a=portal();a1=row(a,casea1)
  check('own note visible with account author',[(n['body'],n['author']) for n in a1['notes']]==[('Klient volal späť','Final CD')])
  check('partner B does not see A notes',not any('Klient volal' in json.dumps(c,ensure_ascii=False) for c in portal(userb)['cases']))
  check('notes and receipts are append-only even for the owner',denied(f"update motorist_partner_case_notes set body='x' where id='{note}'") and denied(f"delete from motorist_partner_followup_commands where command_id='{note}'"))
  check('follow-up never changed the case or partner settlement',fixed()==before)

  # Stats: defined denominators, unknown remains unknown.
  s=a['stats']
  check('stats count own cases, insurance, taken, contacted with sample',(s['cases'],s['insuranceEvents'],s['taken'],s['contacted'],s['contactSample'],s['contactPending'],s['contactUnknown'])==(2,1,1,1,1,0,0) and s['contactMedianMinutes'] is not None)
  empty=portal(start='2025-11-01',end='2025-12-31')['stats']
  check('uncontacted insurance event is pending with unknown time, never zero minutes',(empty['cases'],empty['insuranceEvents'],empty['contactSample'],empty['contactPending'],empty['contactUnknown'])==(1,1,0,1,0) and empty['contactMedianMinutes'] is None)
  check('invalid or excessive period rejected',denied(f"select public.motorist_partner_portal_cases('{usera}','{org}',1,'2027-01-01','2026-01-01')",'22023') and denied(f"select public.motorist_partner_portal_cases('{usera}','{org}',1,'2020-01-01','2027-01-01')",'22023'))

  # Office overview and detail.
  o=office_read(casea1)
  check('office case detail skips the all-partner overview',o['partners']==[])
  names={p['partnerName']:p for p in office_read()['partners']}
  check('office overview lists each partner separately',set(names)=={'Final CD','Second partner'} and names['Final CD']['stats']['cases']==2 and names['Second partner']['newInsurance']==1)
  check('office case detail shows follow-up state and partner notes',o['case']['status']=='contacted' and o['case']['contactedBy']=='Final CD' and len(o['case']['notes'])==1 and o['case']['customer'] is None)

  # More than 200 period cases: an older still-new insurance event stays listed with the badge.
  run(f"""insert into motorist_cases(id,organization_id,case_number,status,priority,source_type,case_type,created_at)
 select ('73000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,'{org}','PM-2026-'||(1000+g),'new','normal','partner','Odťah',timestamptz '2026-10-05T10:00:00Z'+g*interval '1 minute' from generate_series(1,205) g;
insert into motorist_partner_case_contexts(case_id,organization_id,partner_id,partner_name,updated_by)
 select ('73000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,'{org}','{partnera}','Final CD','{office}' from generate_series(1,205) g;""")
  big=portal()
  check('bounded list keeps still-new insurance events beyond the bound and period',len(big['cases'])==200 and big['cases'][0]['caseId']==casea3 and big['newInsurance']==1 and big['stats']['cases']==207)
  # Unmarking hides the contact again; membership version and disable are re-checked.
  value(office_sql(casea1,False,3))
  check('unmarked insurance hides customer contact',row(portal(start='2026-10-01',end='2026-10-03'),casea1)['customer'] is None)
  kept=portal(start='2026-10-01',end='2026-10-03')
  check('unmarking keeps the follow-up history but taken/contacted count only insurance events',row(kept,casea1)['status']=='contacted' and (kept['stats']['insuranceEvents'],kept['stats']['taken'],kept['stats']['contacted'])==(0,0,0))
  check('stale membership version denied',denied(f"select public.motorist_partner_portal_cases('{usera}','{org}',2,'2026-01-01','2027-01-01')") and denied(partner_sql('note',casea1,version=2,body='x')))
  run(f"update motorist_partner_memberships set status='disabled',membership_version=2 where id='{membera}'")
  check('disabled shared account denied on read and write',denied(f"select public.motorist_partner_portal_cases('{usera}','{org}',2,'2026-01-01','2027-01-01')") and denied(partner_sql('note',casea1,version=2,body='x')))
  check('disabled account cannot replay its earlier receipt',denied(nsql))
  print('\n'.join('PASS '+c for c in checks));print(f'{len(checks)} checks passed')
 finally:
  subprocess.run(['pg_ctl','-D',str(data),'-m','immediate','stop'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
