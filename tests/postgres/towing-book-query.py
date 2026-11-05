"""Real isolated PostgreSQL acceptance fixture. Never reads PG* credentials or remote DSNs."""
import json, os, pathlib, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
M=ROOT/'supabase/migrations'; migration=M/'20261013120000_towing_work_orders.sql'
checks=[]
def uid(n):return f'71000000-0000-4000-8000-{n:012d}'
org=uid(1); otherorg=uid(2); manager=uid(10); driver=uid(11); driver2=uid(12); dispatch=uid(13); billing=uid(14); foreign=uid(15)
serial=1000
with tempfile.TemporaryDirectory(prefix='pm-book-pg-') as temp:
 base=pathlib.Path(temp);data=base/'data';sock=base/'socket';sock.mkdir()
 env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
 subprocess.run(['initdb','-D',str(data),'--auth=trust','--no-locale','--encoding=UTF8'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
 subprocess.run(['pg_ctl','-D',str(data),'-l',str(base/'server.log'),'-o',f"-k {sock} -h '' -p 56449",'-w','start'],env=env,stdout=subprocess.DEVNULL,check=True)
 def run(sql,ok=True):
  r=subprocess.run(['psql','-X','-h',str(sock),'-p','56449','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At','-c',sql],env=env,capture_output=True,text=True)
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
  run(operations[operations.index('create or replace function public.motorist_towing_command'):operations.index('do $patch$ declare definition text; begin')])
  book_migration=M/'20261105200753_towing_book_filters_and_operations_search.sql'
  run(book_migration.read_text());check('complete migration compiles against actual towing RPC and operation workspace shape')
  # Equal timestamps deliberately exercise the UUID tie breaker across pages.
  for n in range(200,260):
   run(f"insert into motorist_towing_orders(id,organization_id,number,work_status,billing_status,approved_cents,created_at,updated_at,fields) values('{uid(n)}','{org}','BOOK-{n}','submitted','ready',1000,'2026-11-01T12:00:00Z','2026-11-01T12:00:00Z','{{}}')")
  def book(filters,who=manager,view='office',organization=org):
   return json.loads(value(f"select motorist_towing_workspace('{who}','{organization}',1,'{view}','{json.dumps(filters)}'::jsonb)"))
  check('RPC rejects unsupported sort',denied(f"select motorist_towing_workspace('{manager}','{org}',1,'office','{{\"sort\":\"arbitrary\"}}')",'22023'))
  first=book({'limit':50,'sort':'date_asc'});second=book({'limit':50,'offset':50,'sort':'date_asc'})
  check('server-wide count and financial total unaffected by 50-row page',len(first['orders'])==50 and first['totalCount']==60 and first['summary']['approvedCents']==60000)
  check('equal-date pages have no omissions or duplicates',len({o['id'] for o in first['orders']+second['orders']})==60)
  check('RPC itself enforces 50 rows',len(book({'limit':100})['orders'])==50)
  check('driver cannot see other drivers through stage filter',book({'stage':'ready'},driver,'driver')['totalCount']==0)
  check('other organization excluded from totals',book({},foreign,'office',otherorg)['totalCount']==0)
  run(f"update motorist_towing_orders set fields=jsonb_build_object('plannedAt','2026-11-04T10:00:00Z','startedAt','2026-11-02T10:00:00Z','startSource','assignment','requesterType','selfpayer','requesterId','{uid(1103)}') where id='{uid(200)}'")
  selected=book({'dateBasis':'dispatch','dateFrom':'2026-11-04','dateTo':'2026-11-04','requesterType':'selfpayer','requesterId':uid(1103)})
  check('dispatch date ignores assignment and uses plan; dates use inclusive local end',selected['totalCount']==1 and selected['summary']['approvedCents']==1000)
  check('legacy requester remains explicitly unknown',book({'requesterType':'unknown'})['totalCount']==59)
  run(f"update motorist_towing_orders set fields=jsonb_build_object('plannedAt','bad timestamp','startedAt','2026-02-30','startSource','manual') where id='{uid(201)}'")
  check('malformed historical timestamps fall back safely',book({'dateBasis':'dispatch','dateFrom':'2026-11-01','dateTo':'2026-11-01'})['totalCount']==59)
  run(f"update motorist_towing_orders set work_status='assigned',billing_status='invoiced' where id='{uid(202)}';update motorist_towing_orders set work_status='draft',fields=jsonb_build_object('executionOrigin','awp_record_only') where id='{uid(203)}'")
  check('unfinished paid-looking billing remains active',book({'stage':'active'})['orders'][0]['id']==uid(202))
  check('AWP draft goes to review',book({'stage':'review'})['orders'][0]['id']==uid(203))
  # Explicit directory references validate organization and do not recategorize older rows.
  run(f"insert into motorist_contacts(id,organization_id,name,role) values('{uid(1103)}','{org}','Book partner','partner'),('{uid(1104)}','{otherorg}','Other partner','partner')")
  made=make_order(300,False)
  cmd('update_order',made,{'fields':{'requesterType':'selfpayer','requesterId':uid(1103),'dispatchInstructions':'Fixture instruction'}},rev=revision(made))
  check('explicit selfpayer may reference a regular partner',value(f"select fields->>'requesterType' from motorist_towing_orders where id='{made}'")=='selfpayer')
  check('foreign requester rejected',denied(sqlcommand('update_order',made,{'fields':{'requesterId':uid(1104)}},rev=revision(made)),'22023'))
  check('unknown is read-only legacy category',denied(sqlcommand('update_order',made,{'fields':{'requesterType':'unknown'}},rev=revision(made)),'22023'))
  def operations_book(filters,who=manager):
   return json.loads(value("select motorist_operations_workspace('%s','%s','%s'::jsonb)" % (who,org,json.dumps(filters))))
  for n in range(400,460):
   run(f"insert into motorist_operations(id,organization_id,kind) values('{uid(n)}','{org}','transfer');insert into motorist_logistics_executions(operation_id,organization_id,pickup,destination) values('{uid(n)}','{org}','From {n}','To {n}')")
  result=operations_book({'query':'From 459'})
  check('operations search reaches matches beyond a loaded page',result['totalCount']==1 and result['operations'][0]['id']==uid(459))
  result=operations_book({'query':'From','limit':100})
  check('operation search count remains global and RPC caps 50',result['totalCount']==60 and len(result['operations'])==50)
  for role in ['anon','authenticated']:
   check(role+' cannot execute private book helpers',denied(f"set role {role};select app_private.towing_book_timestamp('2026-11-01')"))
  cmd('update_order',made,{'fields':{'assistancePartnerId':uid(1103),'plate':'UNIQUE-TOW-PLATE','vin':'UNIQUE-TOW-VIN'}},rev=revision(made))
  displayed_partner=book({'requester':'Book partner'})
  check('book requester search matches displayed partner without party name',displayed_partner['totalCount']==1 and displayed_partner['orders'][0]['id']==made)
  cmd('update_order',made,{'fields':{'requester':{'name':'Unique tow requester'}}},rev=revision(made))
  check('book requester search still matches party name',book({'requester':'Unique tow requester'})['totalCount']==1)
  vehicle=uid(461);search_case=uid(462);contact=uid(463);partner=uid(464)
  run(f"insert into motorist_fleet_assets(id,organization_id,kind,label,license_plate,vin,status) values('{vehicle}','{org}','replacement_car','Neutral fleet label','UNIQUE-FLEET-PLATE','UNIQUE-FLEET-VIN','available');insert into motorist_contacts(id,organization_id,name,role) values('{contact}','{org}','Unique logistics requester','client'),('{partner}','{org}','Unique assistance partner','assistance');insert into motorist_cases(id,organization_id,case_number,status,priority,source_type,case_type,contact_id,partner_id,assistance_reference) values('{search_case}','{org}','NEUTRAL-CASE','open','normal','assistance','breakdown','{contact}','{partner}','UNIQUE-ASSIST-REFERENCE');update motorist_operations set case_id='{search_case}' where id='{uid(459)}';update motorist_logistics_executions set fleet_asset_id='{vehicle}' where operation_id='{uid(459)}';insert into motorist_operations(id,organization_id,kind,towing_order_id) values('{uid(460)}','{org}','tow','{made}')")
  for term in ['UNIQUE-FLEET-PLATE','UNIQUE-FLEET-VIN','Unique logistics requester','Unique assistance partner','UNIQUE-ASSIST-REFERENCE']:
   found=operations_book({'query':term})
   check('operations server searches authorized scalar '+term,found['totalCount']==1 and found['operations'][0]['id']==uid(459))
  for term in ['UNIQUE-TOW-PLATE','UNIQUE-TOW-VIN','Unique tow requester','Book partner']:
   found=operations_book({'query':term})
   check('operations server searches towing scalar '+term,found['totalCount']==1 and found['operations'][0]['id']==uid(460))
  run(f"update motorist_logistics_executions set assignee_id='{driver}',status='assigned' where operation_id='{uid(459)}'")
  check('own active operation may search its minimal case requester',operations_book({'query':'Unique logistics requester'},driver)['totalCount']==1)
  check('own active operation and office may search exact assistance reference',operations_book({'query':'UNIQUE-ASSIST-REFERENCE'},driver)['totalCount']==1 and operations_book({'query':'UNIQUE-ASSIST-REFERENCE'})['totalCount']==1)
  check('unassigned member cannot search another requester',operations_book({'query':'Unique logistics requester'},driver2)['totalCount']==0)
  run(f"update motorist_logistics_executions set status='completed' where operation_id='{uid(459)}'")
  check('completed driver work does not expose hidden case requester through search',operations_book({'query':'Unique logistics requester'},driver)['totalCount']==0 and operations_book({'query':'Unique logistics requester'})['totalCount']==1)
  check('completed work exact hidden assistance reference cannot be inferred',operations_book({'query':'UNIQUE-ASSIST-REFERENCE'},driver)['totalCount']==0 and operations_book({'query':'UNIQUE-ASSIST-REFERENCE'})['totalCount']==1)
  run(f"update motorist_logistics_executions set status='assigned' where operation_id='{uid(459)}';insert into motorist_case_handoffs(operation_id,organization_id,recipient_member_id,published,expires_at,status) values('{uid(459)}','{org}','{driver}','{{}}',now()-interval '1 minute','offered')")
  check('expired legacy contact grant cannot be inferred through search',operations_book({'query':'Unique logistics requester'},driver)['totalCount']==0)
  check('expired legacy exact hidden assistance reference cannot be inferred',operations_book({'query':'UNIQUE-ASSIST-REFERENCE'},driver)['totalCount']==0 and operations_book({'query':'UNIQUE-ASSIST-REFERENCE'})['totalCount']==1)
  run(f"update motorist_case_handoffs set expires_at=now()+interval '1 hour' where operation_id='{uid(459)}'")
  check('live own legacy contact grant permits requester search',operations_book({'query':'Unique logistics requester'},driver)['totalCount']==1)
  check('live own legacy grant permits exact assistance reference search',operations_book({'query':'UNIQUE-ASSIST-REFERENCE'},driver)['totalCount']==1)
  realized_migration=M/'20261105201217_towing_realized_items_and_payment_intent.sql'
  run(realized_migration.read_text());check('realized item migration compiles')
  item={'id':uid(800),'kind':'storage','description':'Storage','quantity':'1','unit':'day'}
  cmd('update_order',made,{'fields':{'odometer':'123.5','paymentIntent':'card_terminal','realizedItems':[item],'owner':{'name':'Fixture owner','phone':'123','address':'Test address','companyId':'12345678','email':'private@example.invalid','taxId':'private'}}},rev=revision(made))
  check('payment intent records no receipt',value(f"select count(*) from motorist_towing_payments where order_id='{made}'")=='0')
  check('incomplete secondary storage draft saves but assignment fails',denied(sqlcommand('assign',made,{'driverId':driver},rev=revision(made)),'22023'))
  for bad in [{'odometer':'-1'},{'paymentIntent':'paid'},{'realizedItems':[{**item,'unitPrice':'10'}]},{'realizedItems':[item,item]},{'realizedItems':[{**item,'quantity':'-2'}]}]:
   check('invalid operational fact rejected '+str(bad),denied(sqlcommand('update_order',made,{'fields':bad},rev=revision(made)),'22023'))
  parking=uid(810)
  cmd('set_parking',parking,{'name':'Fixture parking','address':'Exact fixture street','active':True,'expectedRevision':0})
  item['parkingId']=parking
  cmd('update_order',made,{'fields':{'realizedItems':[item]}},rev=revision(made))
  check('parking snapshots derived by server',value(f"select fields->'realizedItems'->0->>'parkingName' from motorist_towing_orders where id='{made}'")=='Fixture parking')
  cmd('set_parking',parking,{'name':'Renamed parking','address':'New exact street','active':True,'expectedRevision':1})
  cmd('update_order',made,{'fields':{'driverNotes':'Unrelated edit'}},rev=revision(made))
  check('parking snapshot survives directory rename',value(f"select fields->'realizedItems'->0->>'parkingName' from motorist_towing_orders where id='{made}'")=='Fixture parking')
  cmd('set_parking',parking,{'name':'Closed renamed parking','address':'New exact street','active':False,'expectedRevision':2})
  cmd('update_order',made,{'fields':{'driverNotes':'Historical inactive parking edit'}},rev=revision(made))
  check('historical inactive parking on same item keeps snapshot',value(f"select fields->'realizedItems'->0->>'parkingName' from motorist_towing_orders where id='{made}'")=='Fixture parking')
  check('inactive parking cannot be newly selected under a new item ID',denied(sqlcommand('update_order',made,{'fields':{'realizedItems':[{**item,'id':uid(811)}]}},rev=revision(made)),'22023'))
  extra_parking=uid(812)
  cmd('set_parking',extra_parking,{'name':'Closed unselected parking','address':'Exact closed street','active':False,'expectedRevision':0})
  check('inactive parking cannot replace a different selected site on same item',denied(sqlcommand('update_order',made,{'fields':{'realizedItems':[{**item,'parkingId':extra_parking}]}},rev=revision(made)),'22023'))
  check('new draft cannot select inactive parking',denied(sqlcommand('create_order',uid(813),{'fields':{'realizedItems':[item]}}),'22023'))
  active_parking=uid(814);foreign_parking=uid(815)
  cmd('set_parking',active_parking,{'name':'Active own site','address':'Exact own address','active':True,'expectedRevision':0})
  cmd('set_parking',foreign_parking,{'name':'Foreign active site','address':'Exact foreign address','active':True,'expectedRevision':0},who=foreign,organization=otherorg)
  driver_sites=book({},driver,'driver')['parking']
  check('authorized driver receives only active own parking directory',len(driver_sites)==1 and driver_sites[0]['id']==active_parking and driver_sites[0]['active'] is True)
  check('driver parking directory exposes only operational reference keys',set(driver_sites[0])=={'id','name','address','active','revision'})
  office_sites=book({})['parking']
  check('office directory still includes inactive history but no foreign sites',{site['id'] for site in office_sites}=={parking,extra_parking,active_parking})
  cmd('assign',made,{'driverId':driver},rev=revision(made))
  cmd('update_order',made,{'fields':{'owner':{'name':'Updated owner','address':'New fixture address'},'plate':'TEST','vin':'FIXTURE','odometer':'150','realizedItems':[item],'paymentIntent':'cash_other'}},who=driver,rev=revision(made),generation=1)
  check('driver owner update preserves hidden office fields',value(f"select fields->'owner'->>'taxId' from motorist_towing_orders where id='{made}'")=='private')
  own=next(o for o in book({},driver,'driver')['orders'] if o['id']==made)
  check('own driver projection has operational owner subset only',own['fields']['owner']['address']=='New fixture address' and 'email' not in own['fields']['owner'] and 'taxId' not in own['fields']['owner'])
  for changes in [{'owner':{'name':'x','taxId':'leak'}},{'requesterType':'selfpayer'}]:
   check('driver cannot edit office fact '+str(changes),denied(sqlcommand('update_order',made,{'fields':changes},who=driver,rev=revision(made),generation=1),'42501'))
  check('driver cannot edit priced lines',denied(sqlcommand('set_lines',made,{'lines':[]},who=driver,rev=revision(made),generation=1)))
  check('other driver denied realized edits',denied(sqlcommand('update_order',made,{'fields':{'realizedItems':[item]}},who=driver2,rev=revision(made),generation=1)))
  check('stale assignment generation denied realized edits',denied(sqlcommand('update_order',made,{'fields':{'realizedItems':[item]}},who=driver,rev=revision(made),generation=0)))
  incomplete={**item,'quantity':''}
  check('completion requires realized quantities',denied("select app_private.towing_validate_realized_items('%s'::jsonb,'%s',true,true)" % (json.dumps([incomplete]),org),'22023'))
  check('secondary relocation requires own destination',denied("select app_private.towing_validate_realized_items('%s'::jsonb,'%s',true,true)" % (json.dumps([{**item,'kind':'relocation'}]),org),'22023'))
  handover_migration=M/'20261105201848_towing_handover_recipient_facts.sql'
  run(handover_migration.read_text());check('handover migration compiles')
  for facts in [{'handedOverAt':'2026-11-05T12:00'},{'handoverRecipientName':'x'*301},{'handoverException':'x'*2001}]:
   check('invalid handover facts rejected',denied(sqlcommand('update_order',made,{'fields':facts},who=driver,rev=revision(made),generation=1),'22023'))
  cmd('update_order',made,{'fields':{'startedAt':'2026-11-05T10:00:00Z','finishedAt':'2026-11-05T11:00:00Z','photoException':'Fixture photo exception'}},who=driver,rev=revision(made),generation=1)
  check('legacy draft without new handover facts remains complete',run(f"select app_private.towing_assert_complete(o) from motorist_towing_orders o where id='{made}'").returncode==0)
  cmd('update_order',made,{'fields':{'handoverRecipientName':'Fixture receiver'}},who=driver,rev=revision(made),generation=1)
  check('partial handover requires explicit exception',denied(f"select app_private.towing_assert_complete(o) from motorist_towing_orders o where id='{made}'",'22023'))
  cmd('update_order',made,{'fields':{'handoverException':'Recipient supplied time later'}},who=driver,rev=revision(made),generation=1)
  check('explicit handover exception accepted',run(f"select app_private.towing_assert_complete(o) from motorist_towing_orders o where id='{made}'").returncode==0)
  cmd('update_order',made,{'fields':{'handedOverAt':'2026-11-05T11:00:00+00:00','handoverException':''}},who=driver,rev=revision(made),generation=1)
  check('paired handover facts complete and visible to own driver',run(f"select app_private.towing_assert_complete(o) from motorist_towing_orders o where id='{made}'").returncode==0 and next(o for o in book({},driver,'driver')['orders'] if o['id']==made)['fields']['handoverRecipientName']=='Fixture receiver')
  card_migration=M/'20261105202104_towing_driver_confirmed_card_receipts.sql'
  before_definition=value("select pg_get_functiondef('public.motorist_towing_command(uuid,uuid,bigint,jsonb)'::regprocedure)")
  run(card_migration.read_text())
  after_definition=value("select pg_get_functiondef('public.motorist_towing_command(uuid,uuid,bigint,jsonb)'::regprocedure)")
  check('card migration changes only the driver method guard',after_definition==before_definition.replace("(driver_op and p->>'method'<>'cash')","(driver_op and coalesce(p->>'method','') not in ('cash','card'))"))
  cash_account=value(f"select id from motorist_towing_cash_accounts where organization_id='{org}' and driver_id='{driver}'")
  cash_revision=int(value(f"select revision from motorist_towing_cash_accounts where id='{cash_account}'"))
  card={'receiptId':uid(900),'amountCents':1000,'method':'card','capturedAt':'2026-11-05T11:10:00Z'}
  card_sql=sqlcommand('receive_payment',made,card,who=driver,generation=1,command=uid(901))
  confirmed=json.loads(value(card_sql));replayed=json.loads(value(card_sql))
  check('confirmed own card receipt replays once',confirmed==replayed and value(f"select count(*) from motorist_towing_payments where receipt_id='{uid(900)}'")=='1')
  check('card never changes cash account balance or revision',value(f"select app_private.towing_balance('{cash_account}')")=='0' and int(value(f"select revision from motorist_towing_cash_accounts where id='{cash_account}'"))==cash_revision)
  second=cmd('receive_payment',made,card,who=driver,generation=1)
  check('same receipt with new command does not duplicate payment',second['result']['paymentId']==confirmed['result']['paymentId'])
  check('changed card receipt payload conflicts',denied(sqlcommand('receive_payment',made,{**card,'amountCents':2000},who=driver,generation=1),'PT409'))
  for method in ['bank','other']:
   check('driver cannot record '+method,denied(sqlcommand('receive_payment',made,{**card,'receiptId':uid(910),'method':method},who=driver,generation=1),'22023'))
  check('other driver cannot record card receipt',denied(sqlcommand('receive_payment',made,{**card,'receiptId':uid(911)},who=driver2,generation=1)))
  check('stale generation cannot record card receipt',denied(sqlcommand('receive_payment',made,{**card,'receiptId':uid(911)},who=driver,generation=0)))
  cmd('receive_payment',made,{'receiptId':uid(912),'amountCents':500,'method':'cash','accountRevision':cash_revision},who=driver,generation=1)
  check('cash still credits physical ledger exactly once',value(f"select app_private.towing_balance('{cash_account}')")=='500' and int(value(f"select revision from motorist_towing_cash_accounts where id='{cash_account}'"))==cash_revision+1)
  check('confirmed card replay after cash keeps ledger unchanged',json.loads(value(card_sql))==confirmed and value(f"select app_private.towing_balance('{cash_account}')")=='500')
  cmd('assign',made,{'driverId':driver2},rev=revision(made))
  check('reassignment revokes original card replay authority',denied(card_sql))
  report={'ok':True,'tests':len(checks),'checks':checks,'scope':'Disposable Unix-socket PostgreSQL; synthetic fixtures; no remote SQL.'}
  (ROOT/'.context/book-postgres-receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
 finally:subprocess.run(['pg_ctl','-D',str(data),'-m','immediate','-w','stop'],env=env,stdout=subprocess.DEVNULL,check=True)
