"""Trusted source completion plus employee checklist regressions; loopback only."""
from pathlib import Path
import importlib.util
import json
import unittest
import uuid
import psycopg

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('employee_extensions_contract',Path(__file__).with_name('employee-task-extensions.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
ORG,A,B,C=base.ORG,base.A,base.B,base.C
MIGRATION=ROOT/'supabase/migrations/20261106180708_employee_task_source_checklist_completion.sql'

class SourceChecklistContract(base.EmployeeTaskExtensions):
 @classmethod
 def setUpClass(cls):
  super().setUpClass()
  cls.db.execute("alter table motorist_callback_requests add claimed_by uuid,add claimed_at timestamptz,add notes text,add updated_at timestamptz default now()")
  # Load the real callback resolver and its real immutable-origin wrapper; the
  # smaller inherited fixture deliberately does not install telephony tables.
  source=(ROOT/'supabase/migrations/20260928120000_callback_contact_fulfillment.sql').read_text()
  start=source.index('create or replace function public.motorist_resolve_callback_v1(')
  end=source.index('create or replace function public.motorist_reconcile_callback_contact_v1',start)
  cls.db.execute(source[start:end])
  cls.db.execute('revoke all on function public.motorist_resolve_callback_v1(uuid,uuid,uuid,text,jsonb,text)from public,anon,authenticated;grant execute on function public.motorist_resolve_callback_v1(uuid,uuid,uuid,text,jsonb,text)to service_role')
  workspace=(ROOT/'supabase/migrations/20260929120000_task_workspace.sql').read_text()
  start=workspace.index('do $$ declare v_name text;');end=workspace.index('end $$;',start)+len('end $$;')
  cls.db.execute(workspace[start:end])
  cls.db.execute(MIGRATION.read_text())

 def service(self):
  client=psycopg.connect(dbname=self.name,autocommit=True,**base.base.legacy.LOCAL)
  client.execute('set role service_role');return client

 def source_task(self,kind='sms',proof=True,source_case=None):
  case=base.base.legacy.CASE
  task=self.employee_create(user=A,caseId=case,checklist=self.checklist())
  source=str(uuid.uuid4());source_case=source_case or case
  metadata=json.dumps({'source':'sms_composer','task_association':'explicit','task_id':task['id']})
  if kind=='sms':
   self.db.execute("insert into motorist_sms_messages(id,organization_id,case_id,template_key,direction,status,provider_message_id,raw_payload)values(%s,%s,%s,'eta_update','outbound','sent',%s,%s::jsonb)",(source,ORG,source_case,'local-provider-proof'if proof else None,metadata))
  else:
   self.db.execute("insert into motorist_callback_requests(id,organization_id,case_id,status,metadata)values(%s,%s,%s,'open',%s::jsonb)",(source,ORG,source_case,json.dumps({'task_id':task['id']})))
  return self.employee('get',task=task['id'],user=A)['task'],source

 def source_complete(self,client,source,org=ORG):
  return client.execute("select motorist_complete_task_source_v1(%s,'sms',%s,null)",(org,source)).fetchone()[0]

 def test_source_01_verified_sms_completes_with_unfinished_checklist(self):
  task,source=self.source_task()
  self.assertTrue(self.db.execute('select origin_locked from motorist_case_tasks where id=%s',(task['id'],)).fetchone()[0])
  with self.service()as client:
   self.assertEqual(self.source_complete(client,source),{'completed':True,'taskId':task['id']})
   self.assertEqual(self.source_complete(client,source),{'completed':True,'taskId':task['id']})
  loaded=self.employee('get',task=task['id'],user=A)['task']
  self.assertEqual(loaded['state'],'done');self.assertFalse(loaded['checklist'][0]['done'])

 def test_source_02_callback_resolves_and_keeps_immutable_origin_mapping(self):
  task,source=self.source_task('callback')
  with self.service()as client:
   result=client.execute("select motorist_resolve_callback_v1(%s,%s,null,'done',null,null)",(ORG,source)).fetchone()[0]
   self.assertEqual(result['status'],'done')
  self.assertEqual(self.employee('get',task=task['id'],user=A)['task']['state'],'done')
  # A source claiming a task from another origin case never completes it.
  mismatched,wrong_source=self.source_task('callback',source_case='40000000-0000-0000-0000-000000000003')
  with self.service()as client:client.execute("select motorist_resolve_callback_v1(%s,%s,null,'done',null,null)",(ORG,wrong_source))
  self.assertEqual(self.employee('get',task=mismatched['id'],user=A)['task']['state'],'todo')

 def test_source_03_invalid_provider_evidence_org_and_humans_remain_blocked(self):
  task,source=self.source_task(proof=False)
  with self.service()as client:
   self.assertEqual(self.source_complete(client,source),{'completed':False})
   self.assertEqual(self.source_complete(client,source,base.OTHER_ORG),{'completed':False})
  self.rejected('PT409',lambda:self.employee_command(task,'complete',user=A))
  self.rejected('PT409',lambda:self.workspace('update',task['id'],{'status':'done','expectedRevision':task['revision']}))
  with self.actor()as client:
   self.rejected('42501',lambda:self.source_complete(client,source))
   self.rejected('42501',lambda:client.execute("select motorist_resolve_callback_v1(%s,%s,null,'done',null,null)",(ORG,str(uuid.uuid4()))))

 def test_source_04_source_and_callback_cannot_approve_pending_review(self):
  for kind in('sms','callback'):
   task,source=self.source_task(kind)
   task=self.employee_command(task,'submit_review',user=A,reviewerUserId=B,comment='Vyžaduje kontrolu')
   with self.service()as client:
    if kind=='sms':self.assertEqual(self.source_complete(client,source),{'completed':False,'reviewPending':True,'taskId':task['id']})
    else:client.execute("select motorist_resolve_callback_v1(%s,%s,null,'done',null,null)",(ORG,source))
   loaded=self.employee('get',task=task['id'],user=A)['task']
   self.assertEqual(loaded['state'],'in_review');self.assertFalse(loaded['checklist'][0]['done'])

 def test_source_05_override_restored_normal_exception_and_nested_scope(self):
  task,source=self.source_task()
  with self.service()as client:
   for previous in('','outer','v1'):
    client.execute("select set_config('app.employee_task_checklist_override',%s,false)",(previous,))
    self.source_complete(client,source)
    self.assertEqual(client.execute("select current_setting('app.employee_task_checklist_override',true)").fetchone()[0],previous)
    self.rejected('22023',lambda:client.execute("select motorist_complete_task_source_v1(%s,'unknown',%s,null)",(ORG,str(uuid.uuid4()))))
    self.assertEqual(client.execute("select current_setting('app.employee_task_checklist_override',true)").fetchone()[0],previous)
    self.rejected('P0001',lambda:client.execute("select motorist_resolve_callback_v1(%s,%s,null,'done',null,null)",(ORG,str(uuid.uuid4()))))
    self.assertEqual(client.execute("select current_setting('app.employee_task_checklist_override',true)").fetchone()[0],previous)
   client.execute("select set_config('app.employee_task_checklist_override','',false)")
   ordinary=self.employee_create(user=A,checklist=self.checklist())
   command={'commandId':str(uuid.uuid4()),'expectedRevision':ordinary['revision'],'action':'complete'}
   self.rejected('PT409',lambda:client.execute("select motorist_employee_tasks(%s,%s,'command',%s,%s::jsonb)",(A,ORG,ordinary['id'],json.dumps(command))))

 def test_source_06_acl_and_callback_claim_validation_preserved(self):
  signatures=['public.motorist_complete_task_source_v1(uuid,text,uuid,uuid)','public.motorist_resolve_callback_v1(uuid,uuid,uuid,text,jsonb,text)']
  for signature in signatures:
   self.assertTrue(self.db.execute("select has_function_privilege('service_role',%s,'execute')",(signature,)).fetchone()[0])
   for role in('anon','authenticated'):
    self.assertFalse(self.db.execute('select has_function_privilege(%s,%s,\'execute\')',(role,signature)).fetchone()[0])
  for signature in['app_private.motorist_complete_task_source_before_checklists(uuid,text,uuid,uuid)','app_private.motorist_resolve_callback_before_checklists(uuid,uuid,uuid,text,jsonb,text)']:
   for role in('anon','authenticated','service_role'):
    self.assertFalse(self.db.execute('select has_function_privilege(%s,%s,\'execute\')',(role,signature)).fetchone()[0])
  task,source=self.source_task('callback')
  self.db.execute('update motorist_callback_requests set claimed_by=%s where id=%s',(base.base.legacy.B,source))
  with self.service()as client:
   self.rejected('P0001',lambda:client.execute("select motorist_resolve_callback_v1(%s,%s,%s,'done',null,null)",(ORG,source,base.base.legacy.A)))
  self.assertEqual(self.db.execute('select status from motorist_callback_requests where id=%s',(source,)).fetchone()[0],'open')
  self.assertEqual(self.employee('get',task=task['id'],user=A)['task']['state'],'todo')

if __name__=='__main__':unittest.main(verbosity=2)
