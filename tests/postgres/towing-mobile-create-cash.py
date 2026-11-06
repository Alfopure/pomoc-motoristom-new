"""Real isolated PostgreSQL acceptance fixture. Never reads PG* credentials or remote DSNs."""
import json, os, pathlib, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
M=ROOT/'supabase/migrations'; migration=M/'20261013120000_towing_work_orders.sql'
checks=[]
def uid(n):return f'71000000-0000-4000-8000-{n:012d}'
org=uid(1); otherorg=uid(2); manager=uid(10); driver=uid(11); driver2=uid(12); dispatch=uid(13); billing=uid(14); foreign=uid(15)
serial=1000
with tempfile.TemporaryDirectory(prefix='pm-towing-create-cash-pg-') as temp:
 base=pathlib.Path(temp);data=base/'data';sock=base/'socket';sock.mkdir()
 env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
 subprocess.run(['initdb','-D',str(data),'--auth=trust','--no-locale','--encoding=UTF8'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
 subprocess.run(['pg_ctl','-D',str(data),'-l',str(base/'server.log'),'-o',f"-k {sock} -h '' -p 56517",'-w','start'],env=env,stdout=subprocess.DEVNULL,check=True)
 def run(sql,ok=True):
  r=subprocess.run(['psql','-X','-h',str(sock),'-p','56517','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At','-c',sql],env=env,capture_output=True,text=True)
  if ok and r.returncode:raise AssertionError(r.stderr+'\nSQL:'+sql[:2000])
  return r
 def value(sql):return run(sql).stdout.strip()
 def check(name,condition=True):
  assert condition,name
  checks.append(name)
 def sqlcommand(action,target,payload=None,who=manager,rev=None,generation=None,command=None,organization=org,version=1):
  global serial
  serial+=1
  c={'commandId':command or uid(serial),'type':action,'targetId':target,'payload':payload or {}}
  if rev is not None:c['expectedRevision']=rev
  if generation is not None:c['assignmentGeneration']=generation
  return "select public.motorist_towing_command('%s','%s',%s,'%s'::jsonb)"%(who,organization,version,json.dumps(c).replace("'","''"))
 def cmd(*args,**kwargs):return json.loads(value(sqlcommand(*args,**kwargs)))
 def denied(sql,code='42501'):return code in run(sql,False).stderr
 def revision(order):return int(value(f"select revision from motorist_towing_orders where id='{order}'"))
 def ws(who=manager,view='office',organization=org,version=1):return json.loads(value(f"select motorist_towing_workspace('{who}','{organization}',{version},'{view}')"))
 def make_order(n=100,assigned=True):
  order=uid(n)
  cmd('create_order',order,{'fields':{'serviceType':'tow','subjectType':'vehicle','subjectDescription':'Syntetické vozidlo','pickup':'Test A','destination':'Test B','contact':'Fixture','branchId':uid(20)},'officeNotes':'OFFICE SECRET','authorizedCollectionCents':10000})
  if assigned:cmd('assign',order,{'driverId':driver},rev=revision(order))
  return order
 try:
  run("create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text default 'fixture@example.invalid');create function auth.uid() returns uuid language sql as $$select null::uuid$$;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key,bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;grant all on storage.objects to anon,authenticated;")
  run((M/'20260520192000_foundation_schema.sql').read_text().replace('create extension if not exists pgcrypto;',''))
  run(migration.read_text());check('migration compiles against actual foundation plus auth/storage primitive fixture')
  run(f"insert into motorist_organizations(id,slug,name) values('{org}','towing-fixture','Towing fixture'),('{otherorg}','towing-other','Other fixture');insert into motorist_branches(id,organization_id,name,address) values('{uid(20)}','{org}','Fixture branch','Fixture'),('{uid(21)}','{otherorg}','Other branch','Other');")
  for who,role,organization in [(manager,'manager',org),(driver,'driver',org),(driver2,'driver',org),(dispatch,'dispatch',org),(billing,'billing',org),(foreign,'manager',otherorg)]:
   run(f"insert into auth.users(id) values('{who}');insert into motorist_towing_memberships(id,organization_id,auth_user_id,display_name,roles,capabilities) values('{who}','{organization}','{who}','Fixture {role}',array['{role}'],app_private.towing_capabilities(array['{role}']));")
  # Actual operations schema primitives and original RPC; only actor/DTO are focused fixture stubs.
  operations=(M/'20261026190600_shared_dispatch_operations.sql').read_text()
  run(operations[operations.index('create table public.motorist_vehicle_use_cycles'):operations.index('create unique index motorist_logistics_one_return')])
  run(f"create function app_private.operations_actor(uuid,uuid) returns jsonb language sql as $$select jsonb_build_object('canDispatch',$1='{manager}'::uuid,'memberId',$1)$$")
  run("create function app_private.operation_json(public.motorist_operations) returns jsonb language sql as $$select jsonb_build_object('id',($1).id)$$")
  run((M/'20260522103000_fleet_module.sql').read_text().split('do $$')[0])
  run("create table public.motorist_case_handoffs(operation_id uuid,organization_id uuid,recipient_member_id uuid,published jsonb,expires_at timestamptz,status text)")
  run(operations[operations.index('create function public.motorist_operations_workspace'):operations.index('create function public.motorist_operations_command')])
  # Use the current shared-dispatch towing implementation, including actual start
  # provenance and record-only guards, rather than the earlier legacy command.
  command_start=operations.index('create or replace function public.motorist_towing_command')
  projection_start=operations.index('do $patch$ declare definition text; begin',command_start)
  run(operations[command_start:projection_start])
  run(operations[projection_start:operations.index('end $patch$;',projection_start)+len('end $patch$;')])
  book_migration=M/'20261105200753_towing_book_filters_and_operations_search.sql'
  run(book_migration.read_text());check('complete migration compiles against actual towing RPC and operation workspace shape')

  # Reuse the current real towing fixture bootstrap; only auth/storage and the
  # unrelated operations actor/DTO are primitive fixture surfaces.
  delivery=(M/'20261022100000_mobile_delivery_handoffs.sql').read_text()
  run(delivery[delivery.index('alter table public.motorist_towing_memberships drop constraint'):delivery.index('-- 2. A handoff')])
  for filename in ['20261105201217_towing_realized_items_and_payment_intent.sql','20261105201848_towing_handover_recipient_facts.sql','20261105202104_towing_driver_confirmed_card_receipts.sql']:
   run((M/filename).read_text())
  deliver=uid(16)
  run(f"insert into auth.users(id) values('{deliver}');insert into motorist_towing_memberships(id,organization_id,auth_user_id,display_name,roles,capabilities) values('{deliver}','{org}','{deliver}','Fixture deliver',array['delivery'],app_private.towing_capabilities(array['delivery']));")
  fleet=uid(150)
  run(f"insert into motorist_fleet_assets(id,organization_id,kind,label,license_plate,status) values('{fleet}','{org}','tow_truck','Fixture tow','FIXTURE','available');")
  # Both complete migration files execute in order, not copied function stubs.
  for filename in ['20261106070058_towing_self_creation_and_mobile_office.sql','20261106070113_towing_cash_category_custody.sql']:
   run((M/filename).read_text());check('complete new migration compiles: '+filename)
  fields={'serviceType':'tow','subjectType':'vehicle','subjectDescription':'Fixture created tow','pickup':'Fixture A','destination':'Fixture B','contact':'Fixture contact','branchId':uid(20),'fleetAssetId':fleet,'paymentIntent':'cash_other'}
  order=uid(3000);identity=uid(3001)
  creation={'commandId':identity,'targetId':order,'mode':'self','fields':fields}
  def create_sql(payload,who=driver,organization=org):
   return "select public.motorist_towing_create('%s','%s',1,'%s'::jsonb)"%(who,organization,json.dumps(payload).replace("'","''"))
  own_sql=create_sql(creation);created=json.loads(value(own_sql))
  check('self creation assigns verified driver and no dispatch profile',value(f"select driver_id::text||':'||assignment_generation::text||':'||work_status||':'||creation_origin from motorist_towing_orders where id='{order}'")==driver+':1:assigned:self' and value('select count(*) from motorist_profiles')=='0')
  check('self creation records one active assignment',value(f"select count(*) from motorist_towing_assignments where order_id='{order}' and ended_at is null")=='1')
  check('same creation command replays exact receipt',json.loads(value(own_sql))==created)
  check('same creation replay never duplicates order or assignment',value(f"select count(*) from motorist_towing_orders where id='{order}'")=='1' and value(f"select count(*) from motorist_towing_assignments where order_id='{order}'")=='1')
  check('same identity altered payload rejected',denied(create_sql({**creation,'fields':{**fields,'pickup':'Changed'}}),'PT409'))
  check('delivery-only member cannot create own tow',denied(create_sql({**creation,'commandId':uid(3002),'targetId':uid(3003)},deliver)))
  check('self cannot inject another driver',denied(create_sql({**creation,'commandId':uid(3004),'targetId':uid(3005),'driverId':driver2})))
  check('cross organization actor cannot create',denied(create_sql({**creation,'commandId':uid(3006),'targetId':uid(3007)},foreign)))
  check('self cannot use office path',denied(create_sql({**creation,'commandId':uid(3008),'targetId':uid(3009),'mode':'office'})))
  check('new RPC not executable by public client roles',all(denied('set role '+role+';'+create_sql(creation)) for role in ['anon','authenticated']))
  directory=ws(driver,'driver')
  check('driver reference catalog exposes own branch and towing asset',any(x['id']==uid(20) for x in directory['branches']) and any(x['id']==fleet for x in directory['fleet']))
  check('driver still has no office members or tax rates',directory['members']==[] and directory['taxRates']==[])
  account_id=value(f"select (app_private.towing_account('{org}','{driver}')).id")
  office_id=value(f"select (app_private.towing_account('{org}',null)).id")
  def account_revision(account):return int(value(f"select revision from motorist_towing_cash_accounts where id='{account}'"))
  def balance(account):return int(value(f"select app_private.towing_balance('{account}')"))
  def categories(account):return json.loads(value(f"select app_private.towing_cash_categories('{account}')"))
  receipt=uid(3010)
  cash_sql=sqlcommand('receive_payment',order,{'receiptId':receipt,'amountCents':10000,'method':'cash','cashCategory':'other','accountRevision':account_revision(account_id)},who=driver,generation=1,command=uid(3011))
  payment=json.loads(value(cash_sql))
  check('other receipt is immutable category and credits driver',value(f"select cash_category from motorist_towing_payments where receipt_id='{receipt}'")=='other' and balance(account_id)==10000 and categories(account_id)['other']['balanceCents']==10000)
  check('cash replay credits only once',json.loads(value(cash_sql))==payment and balance(account_id)==10000)
  cmd('update_order',order,{'fields':{'paymentIntent':'partner_invoice'}},who=driver,rev=revision(order),generation=1)
  check('changed current intent cannot recategorize old receipt',categories(account_id)['other']['balanceCents']==10000 and value(f"select cash_category from motorist_towing_payments where receipt_id='{receipt}'")=='other')
  proposal=uid(3012)
  cmd('propose_handover',proposal,{'amountCents':3000,'accountRevision':account_revision(account_id),'cashBreakdown':{'regular':0,'other':3000,'unclassified':0}},who=driver)
  check('pending other transfer reserves but does not debit',balance(account_id)==10000 and categories(account_id)['other']['reservedCents']==3000)
  def collect(target,amount,who=manager,command=None):
   return sqlcommand('collect_cash',target,{'driverId':driver,'amountCents':amount,'accountRevision':account_revision(account_id),'officeRevision':account_revision(office_id),'cashBreakdown':{'regular':0,'other':amount,'unclassified':0}},who=who,command=command)
  check('ordinary towing dispatcher cannot collect without cash capability',denied(collect(uid(3013),1000,dispatch)))
  check('direct collection cannot consume pending reserved cash',denied(collect(uid(3014),8000),'22023'))
  direct_sql=collect(uid(3015),5000,command=uid(3016));direct=json.loads(value(direct_sql))
  check('owner direct collection transfers exact category without new receipt',balance(account_id)==5000 and balance(office_id)==5000 and categories(account_id)['other']['balanceCents']==5000 and categories(office_id)['other']['balanceCents']==5000 and value(f"select count(*) from motorist_towing_payments where order_id='{order}'")=='1')
  check('direct collection replay cannot collect twice',json.loads(value(direct_sql))==direct and balance(account_id)==5000 and balance(office_id)==5000)
  cmd('accept_handover',proposal,{'accountRevision':account_revision(account_id),'officeRevision':account_revision(office_id)},who=manager,rev=1)
  check('accept proposal transfers remaining reserved category once',balance(account_id)==2000 and balance(office_id)==8000 and categories(account_id)['other']['reservedCents']==0 and categories(office_id)['other']['balanceCents']==8000)
  check('category metadata cannot rewrite original receipt',denied(f"update motorist_towing_payments set cash_category='regular' where receipt_id='{receipt}'"))
  completed={**fields,'startedAt':'2026-11-01T10:00:00Z','finishedAt':'2026-11-01T11:00:00Z','handoverException':'Fixture historical handover','photoException':'Fixture historical paper protocol'}
  history={'commandId':uid(3020),'targetId':uid(3021),'mode':'office','driverId':driver2,'completed':True,'fields':completed}
  json.loads(value(create_sql(history,dispatch)))
  check('standalone dispatcher can create historical completed order',value(f"select work_status||':'||creation_origin from motorist_towing_orders where id='{uid(3021)}'")=='submitted:office_history')
  check('historical assignment is ended rather than new active work',value(f"select count(*) from motorist_towing_assignments where order_id='{uid(3021)}' and ended_at is not null")=='1')
  check('historical actual time distinct from current audit time',value(f"select (fields->>'startedAt')::timestamptz<created_at and created_at>now()-interval '1 minute' from motorist_towing_orders where id='{uid(3021)}'")=='t')
  report={'ok':True,'tests':len(checks),'checks':checks,'scope':'Disposable Unix-socket PostgreSQL; synthetic fixtures; no remote SQL.'}
  (ROOT/'.context/towing-mobile-create-cash-postgres-receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
 finally:subprocess.run(['pg_ctl','-D',str(data),'-m','immediate','-w','stop'],env=env,stdout=subprocess.DEVNULL,check=True)
