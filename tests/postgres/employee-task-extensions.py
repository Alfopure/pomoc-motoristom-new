"""Real PostgreSQL contracts for optional employee task tools; loopback only."""
from pathlib import Path
import importlib.util
import json
import threading
import unittest
import uuid
import psycopg

ROOT = Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location("employee_task_base",Path(__file__).with_name("employee-task-workspace.py"))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
ORG,OTHER_ORG=base.ORG,base.OTHER_ORG
A,B,C=base.A,base.B,base.C
DRIVER,LEAD,SECOND_LEAD,OUTSIDER=base.DRIVER,base.LEAD,base.SECOND_LEAD,base.OUTSIDER
MIGRATION=ROOT/"supabase/migrations/20261106173407_employee_task_extensions.sql"

class EmployeeTaskExtensions(base.EmployeeTaskContract):
 @classmethod
 def setUpClass(cls):
  super().setUpClass()
  cls.db.execute("""create table public.motorist_organization_profiles(organization_id uuid primary key,timezone text not null);
   insert into public.motorist_organization_profiles values('10000000-0000-0000-0000-000000000001','Europe/Bratislava');
   create schema storage;
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
   alter table storage.objects enable row level security;
   grant usage on schema storage to anon,authenticated;
   grant select,insert,update,delete on storage.objects to anon,authenticated;
   create policy fixture_broad_legacy_access on storage.objects for all to anon,authenticated using(true)with check(true);
   create table public.motorist_logistics_executions(operation_id uuid,assignee_id uuid,status text,assignment_generation bigint);
   create table public.motorist_towing_orders(id uuid,driver_id uuid,work_status text,assignment_generation bigint);
   create table public.motorist_work_requests(id uuid,organization_id uuid,operation_id uuid,status text,group_id uuid);
   create function app_private.branch_lead(org uuid,member uuid,grp uuid)returns boolean language sql as $$select false$$;
  """)
  source=(ROOT/"supabase/migrations/20261028130000_mobile_work_push.sql").read_text()
  tables=source[source.index("create table public.motorist_push_outbox ("):source.index("-- Notice texts never carry customer data.")]
  cls.db.execute(tables)
  start=source.index("create function app_private.push_still_valid(")
  end=source.index("-- Only the current lease holder",start)
  cls.db.execute(source[start:end])
  cls.db.execute(MIGRATION.read_text())

 def employee_command(self,task,action,user=DRIVER,**fields):
  if action=="recurrence"and task.get("recurrence")and"expectedSeriesRevision"not in fields:
   fields["expectedSeriesRevision"]=task["recurrence"]["revision"]
  return super().employee_command(task,action,user=user,**fields)

 def checklist(self,done=False):
  return [{"id":str(uuid.uuid4()),"title":"Skontrolovať doklady","done":done}]

 def outbox(self,task,event=None):
  return self.db.execute("select recipient_user_id,type,event,status,ref_generation from motorist_push_outbox where subject_id=%s"+(" and event=%s" if event else "")+" order by recipient_user_id",(task["id"],event)if event else(task["id"],)).fetchall()

 def claim(self):
  with psycopg.connect(dbname=self.name,autocommit=True,**base.legacy.LOCAL)as conn:
   conn.execute("set role service_role")
   return conn.execute("select motorist_push_outbox_claim(%s,100)",(ORG,)).fetchone()[0]

 def tick(self,limit=50):
  with psycopg.connect(dbname=self.name,autocommit=True,**base.legacy.LOCAL)as conn:
   conn.execute("set role service_role")
   return conn.execute("select motorist_employee_tasks_tick(%s,%s)",(ORG,limit)).fetchone()[0]

 def test_employee_08_due_field_or_group_never_fans_out_office_reminders(self):
  for target in({"kind":"person","userId":DRIVER},{"kind":"group","groupId":base.GROUP},{"kind":"person","userId":A}):
   task=self.employee_create(target=target,dueAt="2030-01-01T15:00:00Z")
   self.assertEqual(self.db.execute("select count(*)from motorist_task_reminders where task_id=%s",(task["id"],)).fetchone()[0],0)
   self.assertEqual(self.db.execute("select count(*)from motorist_task_assignment_deliveries where task_id=%s",(task["id"],)).fetchone()[0],0)
  legacy=self.create()
  self.assertGreater(self.db.execute("select count(*)from motorist_task_reminders where task_id=%s",(legacy["id"],)).fetchone()[0],0)

 def test_extension_01_checklist_revision_retry_and_completion_confirmation(self):
  items=self.checklist();task=self.employee_create(checklist=items)
  self.assertEqual(task["checklist"],items)
  self.rejected("PT409",lambda:self.employee_command(task,"complete"))
  task=self.employee_command(task,"complete",allowIncompleteChecklist=True)
  self.assertEqual(task["state"],"done")
  task=self.employee_command(task,"reopen")
  command={"commandId":str(uuid.uuid4()),"expectedRevision":task["revision"],"action":"checklist","items":[{**items[0],"done":True}]}
  first=self.employee("command",command,task["id"])
  self.assertEqual(first,self.employee("command",command,task["id"]))
  self.rejected("PT409",lambda:self.employee_command(task,"checklist",items=[]))
  task=self.employee_command(first["task"],"complete")
  self.assertEqual(task["state"],"done")

 def test_extension_02_checklist_access_limits_and_legacy_details(self):
  task=self.employee_create(target={"kind":"person","userId":LEAD},checklist=self.checklist())
  self.assertTrue(task["permissions"]["editChecklist"])
  self.rejected("P0002",lambda:self.employee_command(task,"checklist",user=SECOND_LEAD,items=[]))
  self.rejected("22023",lambda:self.employee_create(checklist=[{"id":str(uuid.uuid4()),"title":"","done":False}]))
  item=self.checklist()[0]
  self.rejected("22023",lambda:self.employee_create(checklist=[item,item]))
  self.rejected("22023",lambda:self.employee_create(checklist=[{**item,"id":str(uuid.uuid4())}for _ in range(51)]))
  current=self.employee("get",task=task["id"],user=LEAD)["task"]
  self.assertEqual(current["checklist"],task["checklist"])

 def test_extension_03_today_overdue_server_paging_and_scope(self):
  local_today=self.db.execute("select (clock_timestamp()at time zone 'Europe/Bratislava')::date").fetchone()[0]
  for i in range(4):self.employee_create(title="Filter EXT "+str(i),dueAt=str(local_today)+"T23:30:00+01:00")
  self.employee_create(title="Filter EXT future",dueAt="2099-01-01T13:00:00Z")
  self.employee_create(title="Filter EXT none")
  one=self.employee("list",{"dueFilter":"today","q":"Filter EXT","limit":2})
  two=self.employee("list",{"dueFilter":"today","q":"Filter EXT","limit":2,"cursor":one["nextCursor"]})
  self.assertEqual(len(one["tasks"]+two["tasks"]),4)
  self.assertEqual(one["timeZone"],"Europe/Bratislava")
  self.rejected("22023",lambda:self.employee("list",{"dueFilter":"overdue","q":"Filter EXT","cursor":one["nextCursor"]}))
  self.rejected("22023",lambda:self.employee("list",{"dueFilter":"all","q":"Filter EXT","cursor":one["nextCursor"]}))
  overdue=self.employee_create(title="Overdue EXT",dueAt="2000-01-01T12:00:00Z")
  self.assertIn(overdue["id"],[t["id"]for t in self.employee("list",{"dueFilter":"overdue","q":"Overdue EXT"})["tasks"]])
  self.employee_command(overdue,"complete")
  self.assertEqual(self.employee("list",{"dueFilter":"overdue","q":"Overdue EXT"})["tasks"],[])

 def test_extension_04_assignment_comments_recipients_and_retry(self):
  payload={"commandId":str(uuid.uuid4()),"title":"Push EXT","target":{"kind":"person","userId":LEAD}}
  task=self.employee("create",payload)["task"]
  self.employee("create",payload)
  self.assertEqual([r[0]for r in self.outbox(task,"employee_task_assigned")],[uuid.UUID(LEAD)])
  task=self.employee_command(task,"comment",body="Komentár")
  self.assertEqual([r[0]for r in self.outbox(task,"employee_task_comment")],[uuid.UUID(LEAD)])
  task=self.employee_command(task,"comment",user=LEAD,body="Odpoveď")
  self.assertEqual({r[0]for r in self.outbox(task,"employee_task_comment")},{uuid.UUID(DRIVER),uuid.UUID(LEAD)})
  self.assertEqual(self.db.execute("select count(*)from motorist_notifications where task_id=%s and visibility='team'",(task["id"],)).fetchone()[0],0)

 def test_extension_05_branch_lead_revalidation_and_claim_target(self):
  task=self.employee_create(target={"kind":"group","groupId":base.GROUP})
  self.assertEqual({r[0]for r in self.outbox(task,"employee_task_assigned")},{uuid.UUID(LEAD),uuid.UUID(SECOND_LEAD)})
  task=self.employee_command(task,"claim",user=LEAD)
  claims=[r for r in self.claim()if r["target"].get("id")==task["id"]]
  self.assertEqual(claims,[])
  self.assertTrue(all(r[3]=="dropped"for r in self.outbox(task)))
  task=self.employee_command(task,"assign",user=LEAD,target={"kind":"person","userId":DRIVER})
  claims=[r for r in self.claim()if r["target"].get("id")==task["id"]]
  self.assertEqual(len(claims),1)
  self.assertEqual(claims[0]["userId"],DRIVER)
  self.assertEqual(claims[0]["target"],{"kind":"employee-task","id":task["id"]})

 def test_extension_06_revoked_recipient_dropped(self):
  task=self.employee_create(target={"kind":"person","userId":LEAD})
  self.db.execute("update motorist_towing_memberships set active=false where id=%s",(base.LEAD_MEMBER,))
  try:self.assertFalse(any(r["target"].get("id")==task["id"]for r in self.claim()))
  finally:self.db.execute("update motorist_towing_memberships set active=true where id=%s",(base.LEAD_MEMBER,))
  self.assertEqual(self.outbox(task)[0][3],"dropped")

 def test_extension_07_reminders_one_pipeline_once_and_due_change(self):
  task=self.employee_create(target={"kind":"person","userId":A},dueAt="2000-01-01T12:00:00Z")
  self.tick();self.tick()
  self.assertEqual(len(self.outbox(task,"employee_task_due")),1)
  self.assertEqual(self.db.execute("select count(*)from motorist_task_reminders where task_id=%s",(task["id"],)).fetchone()[0],0)
  self.employee_command(task,"complete",user=A)
  self.assertFalse(any(r["target"].get("id")==task["id"]for r in self.claim()))

 def test_extension_08_photo_prepare_retry_visibility_limits_and_remove(self):
  task=self.employee_create();aid=str(uuid.uuid4())
  payload={"commandId":str(uuid.uuid4()),"expectedRevision":task["revision"],"action":"attachment_prepare","attachmentId":aid,"fileName":"fotka.jpg","mimeType":"image/jpeg","sizeBytes":321}
  first=self.employee("command",payload,task["id"]);self.assertEqual(first,self.employee("command",payload,task["id"]))
  self.assertEqual(first["task"]["attachments"],[])
  self.assertEqual(first["attachmentUpload"]["path"],ORG+"/"+task["id"]+"/"+aid+".jpg")
  self.assertEqual(self.employee("attachment",{"attachmentId":aid},task=task["id"])["attachment"]["status"],"pending")
  self.rejected("P0002",lambda:self.employee("attachment",{"attachmentId":aid},task=task["id"],user=A))
  ready=self.employee_command(first["task"],"attachment_finish",attachmentId=aid)
  self.assertEqual(ready["attachments"][0]["id"],aid)
  self.assertTrue(ready["attachments"][0]["canRemove"])
  self.rejected("42501",lambda:self.employee_command(ready,"attachment_remove",user=A,attachmentId=aid))
  removed=self.employee_command(ready,"attachment_remove",attachmentId=aid)
  self.assertEqual(removed["attachments"],[])
  self.rejected("P0002",lambda:self.employee("attachment",{"attachmentId":aid},task=task["id"]))

 def test_extension_09_photo_bad_types_cross_org_and_delete_cleanup_tombstone(self):
  task=self.employee_create(user=A)
  for mime,size in[("text/html",10),("image/jpeg",8388609)]:
   self.rejected("22023",lambda:self.employee_command(task,"attachment_prepare",user=A,attachmentId=str(uuid.uuid4()),fileName="x",mimeType=mime,sizeBytes=size))
  aid=str(uuid.uuid4());prepared=self.employee("command",{"commandId":str(uuid.uuid4()),"expectedRevision":task["revision"],"action":"attachment_prepare","attachmentId":aid,"fileName":"x.png","mimeType":"image/png","sizeBytes":20},task["id"],user=A)
  self.rejected("42501",lambda:self.employee("attachment",{"attachmentId":aid},task=task["id"],user=OUTSIDER,org=ORG))
  self.workspace("delete",task["id"],{"expectedRevision":prepared["task"]["revision"]})
  cleanup=self.db.execute("select motorist_employee_tasks_cleanup(%s,50)",(ORG,)).fetchone()[0]
  self.assertIn(aid,[a["id"]for a in cleanup])
  self.assertEqual(self.db.execute("select status from motorist_task_attachments where id=%s",(aid,)).fetchone()[0],"removed")
  self.assertEqual(self.db.execute("select motorist_employee_tasks_cleanup_finish(%s,%s::uuid[])",(ORG,[aid])).fetchone()[0],1)

 def test_extension_10_recurrence_create_pause_resume_and_permission(self):
  task=self.employee_create(target={"kind":"person","userId":LEAD},recurrence={"frequency":"weekly","time":"08:30","weekday":1})
  self.assertEqual(task["recurrence"]["state"],"active")
  self.assertEqual(task["recurrence"]["weekday"],1)
  self.assertFalse(self.employee("get",task=task["id"],user=LEAD)["task"]["permissions"]["manageRecurrence"])
  self.rejected("42501",lambda:self.employee_command(task,"recurrence",user=LEAD,schedule=None))
  task=self.employee_command(task,"recurrence",schedule=None)
  self.assertEqual(task["recurrence"]["state"],"paused")
  task=self.employee_command(task,"recurrence",schedule={"frequency":"daily","time":"09:00"})
  self.assertEqual(task["recurrence"]["state"],"active")
  self.assertIsNone(task["recurrence"]["weekday"])

 def test_extension_11_recurrence_tick_once_no_historical_flood(self):
  task=self.employee_create(checklist=self.checklist(True),recurrence={"frequency":"daily","time":"00:01"})
  series=task["recurrence"]["id"]
  # Initial occurrence belongs to its original creation day. Move it back to
  # make the simulated missed-day case independent of the time of test execution.
  self.db.execute("select set_config('app.task_workspace_write','v1',false)")
  self.db.execute("update motorist_case_tasks set recurrence_local_date=current_date-10 where id=%s",(task["id"],))
  self.db.execute("update motorist_task_recurrences set next_at=clock_timestamp()-interval '8 days'where id=%s",(series,))
  before=self.db.execute("select count(*)from motorist_case_tasks where recurrence_id=%s",(series,)).fetchone()[0]
  result=self.tick();self.assertGreaterEqual(result["recurrences"],1)
  after=self.db.execute("select count(*)from motorist_case_tasks where recurrence_id=%s",(series,)).fetchone()[0]
  self.assertEqual(after,before+1)
  self.tick();self.assertEqual(self.db.execute("select count(*)from motorist_case_tasks where recurrence_id=%s",(series,)).fetchone()[0],after)
  generated=self.db.execute("select checklist from motorist_case_tasks where recurrence_id=%s and id<>%s",(series,task["id"])).fetchone()[0]
  self.assertFalse(generated[0]["done"])

 def test_extension_12_recurrence_invalid_recipient_needs_attention(self):
  task=self.employee_create(target={"kind":"person","userId":LEAD},recurrence={"frequency":"daily","time":"08:00"})
  self.db.execute("update motorist_task_recurrences set next_at=clock_timestamp()-interval '1 day'where id=%s",(task["recurrence"]["id"],))
  self.db.execute("update motorist_towing_memberships set active=false where id=%s",(base.LEAD_MEMBER,))
  try:self.tick()
  finally:self.db.execute("update motorist_towing_memberships set active=true where id=%s",(base.LEAD_MEMBER,))
  state=self.db.execute("select state,next_at from motorist_task_recurrences where id=%s",(task["recurrence"]["id"],)).fetchone()
  self.assertEqual(state,("needs_attention",None))

 def test_extension_13_dst_and_weekday_occurrence_identity(self):
  def at(f,time,weekday,anchor,next=True):
   return str(self.db.execute("select app_private.employee_task_recurrence_at(%s,%s::time,%s,'Europe/Bratislava',%s::timestamptz,%s)",(f,time,weekday,anchor,next)).fetchone()[0])
  self.assertEqual(at("daily","02:30",None,"2026-03-28T22:00:00Z"),"2026-03-29 01:30:00+00:00")
  self.assertEqual(at("daily","02:30",None,"2026-10-24T22:00:00Z"),"2026-10-25 01:30:00+00:00")
  self.assertEqual(at("weekly","08:00",1,"2026-11-06T10:00:00Z"),"2026-11-09 07:00:00+00:00")

 def test_extension_14_private_tables_and_privileged_rpcs(self):
  for table in["motorist_task_recurrences","motorist_task_attachments","motorist_task_employee_reminder_runs"]:
   self.assertTrue(self.db.execute("select relrowsecurity from pg_class where oid=%s::regclass",(table,)).fetchone()[0])
   self.assertFalse(self.db.execute("select has_table_privilege('authenticated',%s,'select')",(table,)).fetchone()[0])
  for signature in["app_private.motorist_schedule_task_generation(uuid,text[],uuid)","app_private.motorist_ensure_assignment_event(uuid)","app_private.employee_task_notify(motorist_case_tasks,uuid,text,bigint,boolean,text)"]:
   self.assertFalse(self.db.execute("select has_function_privilege('authenticated',%s,'execute')",(signature,)).fetchone()[0])
  with self.actor()as client:
   self.rejected("42501",lambda:client.execute("select motorist_employee_tasks_tick(%s)",(ORG,)))
   self.rejected("42501",lambda:client.execute("select motorist_employee_tasks_cleanup(%s)",(ORG,)))
  self.assertEqual(self.db.execute("select public,file_size_limit,allowed_mime_types from storage.buckets where id='motorist-task-photos'").fetchone(),(False,8388608,["image/jpeg","image/png"]))

 def test_extension_15_legacy_completion_cannot_bypass_checklist_confirmation(self):
  task=self.employee_create(user=A,checklist=self.checklist())
  self.rejected("PT409",lambda:self.workspace("update",task["id"],{"status":"done","expectedRevision":task["revision"]}))
  updated=self.employee_command(task,"complete",user=A,allowIncompleteChecklist=True)
  self.assertEqual(updated["state"],"done")
  self.assertNotEqual(self.db.execute("select current_setting('app.employee_task_checklist_override',true)").fetchone()[0],"v1")

 def test_extension_16_photo_upload_reserve_blocks_resign_and_late_cleanup(self):
  task=self.employee_create();aid=str(uuid.uuid4())
  payload={"commandId":str(uuid.uuid4()),"expectedRevision":task["revision"],"action":"attachment_prepare","attachmentId":aid,"fileName":"x.jpg","mimeType":"image/jpeg","sizeBytes":20}
  receipt=self.employee("command",payload,task["id"])
  grant=self.employee("attachment_upload",{"attachmentId":aid},task=task["id"])
  self.assertEqual(grant["attachmentUpload"]["id"],aid)
  self.assertTrue(self.db.execute("select upload_valid_until>clock_timestamp()+interval '2 hours'from motorist_task_attachments where id=%s",(aid,)).fetchone()[0])
  removed=self.employee_command(receipt["task"],"attachment_remove",attachmentId=aid)
  self.rejected("P0002",lambda:self.employee("command",payload,task["id"]))
  self.rejected("P0002",lambda:self.employee("attachment_upload",{"attachmentId":aid},task=task["id"]))
  self.assertNotIn(aid,[a["id"]for a in self.db.execute("select motorist_employee_tasks_cleanup(%s)",(ORG,)).fetchone()[0]])
  self.assertEqual(self.db.execute("select motorist_employee_tasks_cleanup_finish(%s,%s::uuid[])",(ORG,[aid])).fetchone()[0],0)
  self.db.execute("update motorist_task_attachments set upload_valid_until=clock_timestamp()-interval '1 second'where id=%s",(aid,))
  self.assertIn(aid,[a["id"]for a in self.db.execute("select motorist_employee_tasks_cleanup(%s)",(ORG,)).fetchone()[0]])
  self.assertEqual(self.db.execute("select motorist_employee_tasks_cleanup_finish(%s,%s::uuid[])",(ORG,[aid])).fetchone()[0],1)

 def test_extension_17_checklist_two_writers_one_revision_wins(self):
  task=self.employee_create(checklist=self.checklist());barrier=threading.Barrier(2);results=[]
  def run(title):
   try:
    barrier.wait(timeout=5);self.employee_command(task,"checklist",items=[{**task["checklist"][0],"title":title}]);results.append("ok")
   except psycopg.Error as error:results.append(error.sqlstate)
  threads=[threading.Thread(target=run,args=(t,))for t in("Prvý","Druhý")]
  for thread in threads:thread.start()
  for thread in threads:thread.join(timeout=10)
  self.assertCountEqual(results,["ok","PT409"])

 def test_extension_18_photo_pending_count_limit_and_expiration(self):
  task=self.employee_create()
  for _ in range(10):task=self.employee_command(task,"attachment_prepare",attachmentId=str(uuid.uuid4()),fileName="x.png",mimeType="image/png",sizeBytes=20)
  self.rejected("22023",lambda:self.employee_command(task,"attachment_prepare",attachmentId=str(uuid.uuid4()),fileName="x.png",mimeType="image/png",sizeBytes=20))
  aid=self.db.execute("select id from motorist_task_attachments where task_id=%s limit 1",(task["id"],)).fetchone()[0]
  self.db.execute("update motorist_task_attachments set created_at=clock_timestamp()-interval '25 hours'where id=%s",(aid,))
  self.rejected("P0002",lambda:self.employee("attachment_upload",{"attachmentId":str(aid)},task=task["id"]))
  task=self.employee_command(task,"attachment_prepare",attachmentId=str(uuid.uuid4()),fileName="x.png",mimeType="image/png",sizeBytes=20)
  self.assertEqual(task["attachments"],[])

 def test_extension_19_recurrence_concurrent_tick_creates_one(self):
  task=self.employee_create(recurrence={"frequency":"daily","time":"00:01"});series=task["recurrence"]["id"]
  self.db.execute("select set_config('app.task_workspace_write','v1',false)")
  self.db.execute("update motorist_case_tasks set recurrence_local_date=current_date-10 where id=%s",(task["id"],))
  self.db.execute("update motorist_task_recurrences set next_at=clock_timestamp()-interval '8 days'where id=%s",(series,))
  before=self.db.execute("select count(*)from motorist_case_tasks where recurrence_id=%s",(series,)).fetchone()[0]
  barrier=threading.Barrier(2);errors=[]
  def run():
   try:barrier.wait(timeout=5);self.tick()
   except Exception as error:errors.append(str(error))
  threads=[threading.Thread(target=run)for _ in range(2)]
  for thread in threads:thread.start()
  for thread in threads:thread.join(timeout=15)
  self.assertEqual(errors,[])
  self.assertEqual(self.db.execute("select count(*)from motorist_case_tasks where recurrence_id=%s",(series,)).fetchone()[0],before+1)

 def test_extension_20_reminder_30min_or_due_short_notice(self):
  in_10=self.db.execute("select clock_timestamp()+interval '10 minutes'").fetchone()[0]
  task=self.employee_create(dueAt=in_10.isoformat())
  self.tick();self.assertEqual(self.outbox(task,"employee_task_due"),[])
  # Existing task older than the lead time gets its single before-term reminder.
  self.db.execute("select set_config('app.task_workspace_write','v1',false)")
  self.db.execute("update motorist_case_tasks set created_at=clock_timestamp()-interval '1 day'where id=%s",(task["id"],))
  self.tick();self.assertEqual(len(self.outbox(task,"employee_task_due")),1)
  self.tick();self.assertEqual(len(self.outbox(task,"employee_task_due")),1)

 def test_extension_21_legacy_web_assignment_and_message_use_canonical_outbox(self):
  task=self.employee_create(user=A,target={"kind":"person","userId":B})
  self.assertEqual(len(self.outbox(task,"employee_task_assigned")),1)
  old=self.workspace("update",task["id"],{"assignedTo":base.legacy.A,"expectedRevision":task["revision"]})
  self.assertEqual(len(self.outbox(task,"employee_task_assigned")),1) # A reassigned to self: no own notice
  old=self.workspace("update",task["id"],{"assignedTo":base.legacy.B,"expectedRevision":old["revision"]})
  self.assertEqual(len(self.outbox(task,"employee_task_assigned")),2)
  self.workspace("send_message",task["id"],{"body":"Správa z webu","clientMessageId":str(uuid.uuid4())},actor=base.legacy.B)
  self.assertEqual([r[0]for r in self.outbox(task,"employee_task_comment")],[uuid.UUID(A)])
  self.assertEqual(self.db.execute("select count(*)from motorist_task_assignment_deliveries where task_id=%s",(task["id"],)).fetchone()[0],0)

 def test_extension_22_source_day_and_resume_skip_existing_occurrence(self):
  task=self.employee_create(recurrence={"frequency":"daily","time":"23:59"})
  series=task["recurrence"]["id"]
  day=self.db.execute("select recurrence_local_date from motorist_case_tasks where id=%s",(task["id"],)).fetchone()[0]
  next_day=self.db.execute("select(next_at at time zone time_zone)::date from motorist_task_recurrences where id=%s",(series,)).fetchone()[0]
  self.assertGreater(next_day,day)
  task=self.employee_command(task,"recurrence",schedule=None)
  task=self.employee_command(task,"recurrence",schedule={"frequency":"daily","time":"23:59"})
  next_day=self.db.execute("select(next_at at time zone time_zone)::date from motorist_task_recurrences where id=%s",(series,)).fetchone()[0]
  self.assertGreater(next_day,day)
  self.db.execute("update motorist_task_recurrences set next_at=clock_timestamp()-interval '1 day'where id=%s",(series,))
  self.tick()
  self.assertEqual(self.db.execute("select state from motorist_task_recurrences where id=%s",(series,)).fetchone()[0],"active")

 def test_extension_23_due_change_invalidates_old_queued_reminder(self):
  task=self.employee_create(user=A,dueAt="2000-01-01T12:00:00Z")
  self.tick();self.assertEqual(len(self.outbox(task,"employee_task_due")),1)
  self.workspace("update",task["id"],{"dueAt":"2099-01-01T12:00:00Z","expectedRevision":task["revision"]})
  self.assertFalse(any(r["target"].get("id")==task["id"]for r in self.claim()))
  self.assertEqual(self.outbox(task,"employee_task_due")[0][3],"dropped")

 def test_extension_24_claim_never_sends_invalid_beyond_stale_sweep_limit(self):
  task=self.employee_create(target={"kind":"person","userId":LEAD})
  self.db.execute("""insert into motorist_push_outbox(organization_id,member_id,type,event,subject_type,subject_id,ref_generation,dedupe_key,title,body,recipient_user_id)
   select organization_id,member_id,type,event,subject_type,subject_id,ref_generation,dedupe_key||':'||g,'Nová úloha','Úloha čaká.',recipient_user_id
   from motorist_push_outbox cross join generate_series(1,501)g where subject_id=%s""",(task["id"],))
  self.db.execute("update motorist_towing_memberships set active=false where id=%s",(base.LEAD_MEMBER,))
  try:self.assertFalse(any(r["target"].get("id")==task["id"]for r in self.claim()))
  finally:self.db.execute("update motorist_towing_memberships set active=true where id=%s",(base.LEAD_MEMBER,))

 def test_extension_25_storage_restrictive_policy_beats_broad_legacy_grant(self):
  private_id=str(uuid.uuid4());other_id=str(uuid.uuid4())
  self.db.execute("insert into storage.objects(id,bucket_id,name)values(%s,'motorist-task-photos','secret.jpg'),(%s,'other-bucket','other.jpg')",(private_id,other_id))
  with self.actor()as client:
   self.assertEqual(client.execute("select id from storage.objects where id=%s",(private_id,)).fetchall(),[])
   self.assertEqual(len(client.execute("select id from storage.objects where id=%s",(other_id,)).fetchall()),1)
   self.rejected("42501",lambda:client.execute("insert into storage.objects(bucket_id,name)values('motorist-task-photos','forbidden.jpg')"))
   self.assertEqual(client.execute("delete from storage.objects where id=%s returning id",(private_id,)).fetchall(),[])
   self.rejected("42501",lambda:client.execute("update storage.objects set bucket_id='motorist-task-photos'where id=%s",(other_id,)))
  with psycopg.connect(dbname=self.name,autocommit=True,**base.legacy.LOCAL)as client:
   client.execute("set role anon")
   self.assertEqual(client.execute("select id from storage.objects where id=%s",(private_id,)).fetchall(),[])

 def test_extension_26_shared_series_revision_two_occurrences_one_winner(self):
  task=self.employee_create(recurrence={"frequency":"daily","time":"00:01"});series=task["recurrence"]["id"]
  self.db.execute("select set_config('app.task_workspace_write','v1',false)")
  self.db.execute("update motorist_case_tasks set recurrence_local_date=current_date-10 where id=%s",(task["id"],))
  self.db.execute("update motorist_task_recurrences set next_at=clock_timestamp()-interval '8 days'where id=%s",(series,));self.tick()
  second_id=str(self.db.execute("select id from motorist_case_tasks where recurrence_id=%s and id<>%s",(series,task["id"])).fetchone()[0])
  first=self.employee("get",task=task["id"])["task"];second=self.employee("get",task=second_id)["task"]
  self.assertEqual(first["recurrence"]["revision"],1) # cron advancement is operational, not a schedule edit
  barrier=threading.Barrier(2);results=[]
  def run(current):
   try:barrier.wait(timeout=5);self.employee_command(current,"recurrence",schedule=None);results.append("ok")
   except psycopg.Error as error:results.append(error.sqlstate)
  threads=[threading.Thread(target=run,args=(current,))for current in(first,second)]
  for thread in threads:thread.start()
  for thread in threads:thread.join(timeout=10)
  self.assertCountEqual(results,["ok","PT409"])
  self.assertEqual(self.db.execute("select state,revision from motorist_task_recurrences where id=%s",(series,)).fetchone(),("paused",2))
  self.rejected("22023",lambda:self.employee("command",{"commandId":str(uuid.uuid4()),"expectedRevision":self.employee("get",task=task["id"])["task"]["revision"],"action":"recurrence","schedule":None},task["id"]))

 def test_extension_27_inactive_owner_rejects_manager_resume_without_mutation(self):
  task=self.employee_create(recurrence={"frequency":"daily","time":"08:00"})
  task=self.employee_command(task,"recurrence",schedule=None)
  before=self.db.execute("select state,revision,next_at,template from motorist_task_recurrences where id=%s",(task["recurrence"]["id"],)).fetchone()
  self.db.execute("update motorist_towing_memberships set active=false where id=%s",(base.MEMBER,))
  try:
   with self.assertRaises(psycopg.Error)as caught:self.employee_command(task,"recurrence",user=C,schedule={"frequency":"daily","time":"09:00"})
   self.assertEqual(caught.exception.sqlstate,"22023");self.assertEqual(caught.exception.diag.message_primary,"Task recurrence owner inactive")
   self.assertEqual(self.db.execute("select state,revision,next_at,template from motorist_task_recurrences where id=%s",(task["recurrence"]["id"],)).fetchone(),before)
   task=self.employee_command(task,"recurrence",user=C,schedule=None)
   self.assertEqual(task["recurrence"]["state"],"paused")
  finally:self.db.execute("update motorist_towing_memberships set active=true where id=%s",(base.MEMBER,))

 def test_extension_28_template_preserved_and_unavailable_target_rejected(self):
  task=self.employee_create(checklist=self.checklist(),target={"kind":"person","userId":LEAD},recurrence={"frequency":"daily","time":"08:00"})
  series=task["recurrence"]["id"];template=self.db.execute("select template from motorist_task_recurrences where id=%s",(series,)).fetchone()[0]
  task=self.employee_command(task,"assign",target={"kind":"person","userId":DRIVER})
  task=self.employee_command(task,"checklist",items=[])
  task=self.employee_command(task,"recurrence",schedule={"frequency":"weekly","time":"09:00","weekday":2})
  self.assertEqual(self.db.execute("select template from motorist_task_recurrences where id=%s",(series,)).fetchone()[0],template)
  self.db.execute("update motorist_towing_memberships set active=false where id=%s",(base.LEAD_MEMBER,))
  try:
   before=self.db.execute("select state,revision,next_at,template from motorist_task_recurrences where id=%s",(series,)).fetchone()
   with self.assertRaises(psycopg.Error)as caught:self.employee_command(task,"recurrence",schedule={"frequency":"daily","time":"10:00"})
   self.assertEqual(caught.exception.sqlstate,"22023");self.assertEqual(caught.exception.diag.message_primary,"Task recurrence recipient inactive")
   self.assertEqual(self.db.execute("select state,revision,next_at,template from motorist_task_recurrences where id=%s",(series,)).fetchone(),before)
  finally:self.db.execute("update motorist_towing_memberships set active=true where id=%s",(base.LEAD_MEMBER,))

 def test_extension_29_review_push_field_outcomes_and_dedup(self):
  task=self.employee_create(user=A,target={"kind":"person","userId":DRIVER})
  task=self.employee_command(task,"submit_review",reviewerUserId=B,comment="Na kontrolu")
  self.assertEqual([r[0]for r in self.outbox(task,"employee_task_review_requested")],[uuid.UUID(B)])
  task=self.employee_command(task,"return",user=B,comment="Doplniť")
  self.assertEqual([r[0]for r in self.outbox(task,"employee_task_review_returned")],[uuid.UUID(DRIVER)])
  task=self.employee_command(task,"submit_review",reviewerUserId=B,comment="Doplnené")
  command={"commandId":str(uuid.uuid4()),"expectedRevision":task["revision"],"action":"approve"}
  first=self.employee("command",command,task["id"],user=B);self.assertEqual(first,self.employee("command",command,task["id"],user=B))
  self.assertEqual([r[0]for r in self.outbox(task,"employee_task_review_approved")],[uuid.UUID(DRIVER)])
  valid=[r for r in self.claim()if r["target"].get("id")==task["id"]and r["event"].startswith("employee_task_review_")]
  self.assertEqual([(r["event"],r["userId"])for r in valid],[("employee_task_review_approved",DRIVER)])

 def test_extension_30_review_legacy_paths_new_tasks_and_stale_recipient(self):
  task=self.employee_create(user=A,target={"kind":"person","userId":A})
  old=self.workspace("get",task["id"])
  old=self.submit(old,reviewer=base.legacy.B)
  self.assertEqual([r[0]for r in self.outbox(task,"employee_task_review_requested")],[uuid.UUID(B)])
  old=self.transition(old,self.command(old,"return",comment="Vrátené"),actor=base.legacy.B)["task"]
  self.assertEqual([r[0]for r in self.outbox(task,"employee_task_review_returned")],[uuid.UUID(A)])
  # Workflow-generated message must not add a second generic comment notice.
  self.assertEqual(self.outbox(task,"employee_task_comment"),[])
  self.db.execute("update motorist_profiles set access_status='disabled'where id=%s",(base.legacy.A,))
  try:self.assertFalse(any(r["target"].get("id")==task["id"]for r in self.claim()))
  finally:self.db.execute("update motorist_profiles set access_status='active'where id=%s",(base.legacy.A,))

 def test_extension_31_tick_attention_issue_does_not_change_semantic_revision(self):
  for inactive,issue in[(DRIVER,"creator_inactive"),(LEAD,"recipient_unavailable")]:
   task=self.employee_create(target={"kind":"person","userId":LEAD},recurrence={"frequency":"daily","time":"00:01"})
   self.db.execute("update motorist_task_recurrences set next_at=clock_timestamp()-interval '1 day'where id=%s",(task["recurrence"]["id"],))
   member=base.MEMBER if inactive==DRIVER else base.LEAD_MEMBER
   self.db.execute("update motorist_towing_memberships set active=false where id=%s",(member,))
   try:self.tick()
   finally:self.db.execute("update motorist_towing_memberships set active=true where id=%s",(member,))
   r=self.employee("get",task=task["id"])["task"]["recurrence"]
   self.assertEqual((r["state"],r["revision"],r["issue"]),("needs_attention",1,issue))

 def test_extension_32_old_field_task_web_outcomes_use_current_canonical_recipient(self):
  task=self.employee_create(user=A,target={"kind":"person","userId":DRIVER})
  self.db.execute("select set_config('app.task_workspace_write','v1',false)")
  self.db.execute("update motorist_case_tasks set employee_extensions=false where id=%s",(task["id"],))
  task=self.employee("get",task=task["id"])["task"]
  task=self.employee_command(task,"submit_review",reviewerUserId=B,comment="Na kontrolu")
  old=self.workspace("get",task["id"])
  self.transition(old,self.command(old,"return",comment="Doplniť"),actor=base.legacy.B)
  task=self.employee("get",task=task["id"])["task"]
  self.assertEqual([r[0]for r in self.outbox(task,"employee_task_review_returned")],[uuid.UUID(DRIVER)])
  task=self.employee_command(task,"submit_review",reviewerUserId=B,comment="Doplnené")
  old=self.workspace("get",task["id"])
  self.transition(old,self.command(old,"approve"),actor=base.legacy.B)
  self.assertEqual([r[0]for r in self.outbox(task,"employee_task_review_approved")],[uuid.UUID(DRIVER)])
  self.assertEqual(self.db.execute("select count(*)from motorist_notifications where task_id=%s and payload->>'source'in('task_review_return','task_review_approve')",(task["id"],)).fetchone()[0],0)
  valid=[r for r in self.claim()if r["target"].get("id")==task["id"]and r["event"].startswith("employee_task_review_")]
  self.assertEqual([(r["event"],r["userId"])for r in valid],[("employee_task_review_approved",DRIVER)])

if __name__=="__main__":unittest.main(verbosity=2)
