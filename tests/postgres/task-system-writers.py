"""Exact existing callback RPCs + task-source bridges on disposable loopback PG."""
from pathlib import Path
import json
import psycopg
ROOT = Path(__file__).resolve().parents[2]
CONFIG = dict(host="127.0.0.1",port=55432,user="postgres")
ORG="10000000-0000-0000-0000-000000000001"
A="20000000-0000-0000-0000-000000000001"
CASE="40000000-0000-0000-0000-000000000003"
SESSION="90000000-0000-0000-0000-000000000001"

def sql(path):
    return "\n".join(sql(path.parent/line[4:]) if line.startswith("\\ir ") else line for line in path.read_text().splitlines())
with psycopg.connect(dbname="postgres",autocommit=True,**CONFIG) as admin:
    admin.execute("drop database if exists task_system_contract")
    admin.execute("create database task_system_contract")
with psycopg.connect(dbname="task_system_contract",autocommit=True,**CONFIG) as admin:
    admin.execute(sql(ROOT/"tests/postgres/task-workspace-fixture.sql"))
    admin.execute("""
      alter table motorist_callback_requests add column caller_number text default '+421900000001',add column caller_name text,
       add column source text default 'missed',add column session_id uuid,add column line_id uuid,add column due_at timestamptz,
       add column notes text,add column claimed_by uuid,add column claimed_at timestamptz,add column created_at timestamptz default now(),add column updated_at timestamptz default now();
      create table motorist_call_sessions(id uuid primary key,organization_id uuid,case_id uuid,line_id uuid,state text default 'ended',direction text default 'inbound',caller_number text,called_number text,metadata jsonb default '{}',started_at timestamptz,answered_by_profile_id uuid);
      create table motorist_calls(id uuid primary key,organization_id uuid,session_id uuid,case_id uuid,line_id uuid,direction text,caller_number text,called_number text,destination_number text);
      grant select,insert,update on motorist_call_sessions,motorist_calls,motorist_location_share_links,motorist_location_submissions to service_role;
    """)
    # Apply the exact installed callback contract, not a behavioral stub.
    admin.execute(sql(ROOT/"supabase/migrations/20260928120000_callback_contact_fulfillment.sql"))
    admin.execute(sql(ROOT/"supabase/migrations/20260929120000_task_workspace.sql"))
    admin.execute("update motorist_task_workspace_settings set enabled=true,writer_inventory_verified_at=now(),writer_inventory_note='Local exact system-writer test only'")
    admin.execute("insert into motorist_call_sessions(id,organization_id,case_id,caller_number,started_at) values(%s,%s,%s,'+421900000011','2026-09-10T10:00:00Z')",(SESSION,ORG,CASE))

with psycopg.connect(dbname="task_system_contract",autocommit=True,**CONFIG) as system, psycopg.connect(dbname="task_system_contract",autocommit=True,**CONFIG) as user:
    system.execute("set role service_role")
    user.execute("set role authenticated")
    user.execute("select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false)")
    def task(action,task_id=None,data=None):
        return user.execute("select motorist_task_workspace(%s,%s,%s,%s,%s::jsonb)",(ORG,A,action,task_id,json.dumps(data or {}))).fetchone()[0]
    def complete(source,source_id):
        return system.execute("select motorist_complete_task_source_v1(%s,%s,%s,%s)",(ORG,source,source_id,A)).fetchone()[0]
    def rejected(statement,args,code):
        try: system.execute(statement,args)
        except psycopg.Error as error:
            assert error.sqlstate==code,(error.sqlstate,str(error)); return
        raise AssertionError("Expected rejection")
    plan=json.dumps({"callerNumber":"+421900000011","source":"missed","createTask":True})
    callback=system.execute("select motorist_create_callback_obligation_v1(%s,%s,%s::jsonb,'2026-09-10T10:01:00Z')",(ORG,SESSION,plan)).fetchone()[0]
    linked=task("get",callback["metadata"]["task_id"])
    assert linked["provenance"]=="proven" and linked["originLocked"]
    task("update",linked["id"],{"expectedRevision":linked["revision"],"kind":"other"})
    system.execute("select motorist_resolve_callback_v1(%s,%s,%s,'done')",(ORG,callback["id"],A))
    assert task("get",linked["id"])["status"]=="done"
    retry=system.execute("select motorist_create_callback_obligation_v1(%s,%s,%s::jsonb,'2026-09-10T10:01:00Z')",(ORG,SESSION,plan)).fetchone()[0]
    assert retry["id"]==callback["id"] and retry["metadata"]["task_id"]==linked["id"]
    rejected("update motorist_case_tasks set title='No leaked context' where id=%s",(linked["id"],),"55000")
    print("PASS: exact callback creator/resolver preserve proof, retry and immutable origin despite edited kind; write context does not leak")
    call_id="91000000-0000-0000-0000-000000000001"
    system.execute("insert into motorist_calls(id,organization_id,case_id,direction,caller_number) values(%s,%s,%s,'inbound','+421900000012')",(call_id,ORG,CASE))
    scheduled=system.execute("select motorist_schedule_callback_v1(%s,%s,%s,'92000000-0000-0000-0000-000000000001','2026-09-10T11:00:00Z')",(ORG,call_id,A)).fetchone()[0]
    assert task("get",scheduled["metadata"]["task_id"])["provenance"]=="proven"
    retried=system.execute("select motorist_schedule_callback_v1(%s,%s,%s,'92000000-0000-0000-0000-000000000001','2026-09-10T11:00:00Z')",(ORG,call_id,A)).fetchone()[0]
    assert retried["metadata"]["task_id"]==scheduled["metadata"]["task_id"]
    print("PASS: exact manual scheduling contract creates one proven task and retries without duplication")
    sms_task=task("create",data={"title":"ETA","caseIds":[CASE]})
    sms_id=system.execute("insert into motorist_sms_messages(organization_id,case_id,template_key,raw_payload) values(%s,%s,'eta_update',%s::jsonb) returning id",(ORG,CASE,json.dumps({"source":"sms_composer","task_association":"explicit","task_id":sms_task["id"]}))).fetchone()[0]
    assert complete("sms",sms_id)=={"completed":False}
    system.execute("update motorist_sms_messages set status='sent',provider_message_id='accepted-test-provider-id' where id=%s",(sms_id,))
    assert complete("sms",sms_id)["completed"] and task("get",sms_task["id"])["status"]=="done"
    rejected("update motorist_sms_messages set raw_payload='{}' where id=%s",(sms_id,),"42501")
    print("PASS: ETA completion requires durable accepted SMS proof and exact source mapping")
    location_task=task("create",data={"title":"Location","caseIds":[CASE]})
    link_id=system.execute("insert into motorist_location_share_links(organization_id,case_id,expires_at,metadata) values(%s,%s,'2026-09-11T10:00:00Z',%s::jsonb) returning id",(ORG,CASE,json.dumps({"source":"sms_location_request","task_association":"explicit","task_id":location_task["id"]}))).fetchone()[0]
    submission_id=system.execute("insert into motorist_location_submissions(organization_id,case_id,link_id,accepted,submitted_at) values(%s,%s,%s,true,'2026-09-10T12:00:00Z') returning id",(ORG,CASE,link_id)).fetchone()[0]
    assert complete("location",submission_id)=={"completed":False}
    system.execute("update motorist_location_share_links set status='used' where id=%s",(link_id,))
    assert complete("location",submission_id)["completed"] and task("get",location_task["id"])["status"]=="done"
    print("PASS: location completion requires accepted same-scope submission and used link; no broad title fallback")
