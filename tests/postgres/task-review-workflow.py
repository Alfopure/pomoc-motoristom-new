"""Real PostgreSQL review contracts, on unique disposable loopback fixtures only."""
from pathlib import Path
import json
import threading
import time
import unittest
import uuid
import psycopg

ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host="127.0.0.1", hostaddr="127.0.0.1", port=55432, user="postgres", connect_timeout=5)
ORG = "10000000-0000-0000-0000-000000000001"
OTHER_ORG = "10000000-0000-0000-0000-000000000002"
A, B, C, OTHER = [f"20000000-0000-0000-0000-{i:012d}" for i in range(1, 5)]
CASE = "40000000-0000-0000-0000-000000000001"


def sql(path):
    return "\n".join(sql(path.parent / line[4:]) if line.startswith("\\ir ") else line for line in path.read_text().splitlines() if not line.startswith("\\set "))


class TaskReviewContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name = "task_review_" + uuid.uuid4().hex[:12]
        with psycopg.connect(dbname="postgres", autocommit=True, **LOCAL) as admin:
            admin.execute("create database " + cls.name)
        cls.db = psycopg.connect(dbname=cls.name, autocommit=True, **LOCAL)
        cls.db.execute(sql(ROOT / "tests/postgres/task-workspace-fixture.sql"))
        cls.db.execute("alter table motorist_profiles add column access_status text not null default 'active'")
        cls.db.execute("alter table motorist_case_tasks add check(status in ('open','done','overdue')); drop table motorist_task_reminders")
        cls.db.execute("""create function app_private.motorist_is_org_member(org uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
        select exists(select 1 from motorist_profiles p where p.organization_id=org and p.user_id=auth.uid() and p.active) $$;
        create function public.motorist_set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;""")
        for name in ["20260609110000_task_reminders_notifications.sql", "20260929120000_task_workspace.sql", "20260929130000_task_notification_privacy.sql"]:
            cls.db.execute(sql(ROOT / "supabase/migrations" / name))
        # Use the real latest task RPC body (PT409), without installing unrelated telephony functions.
        current = (ROOT / "supabase/migrations/20260929170000_domain_conflict_sqlstate.sql").read_text()
        cls.db.execute(current[current.index("CREATE OR REPLACE FUNCTION public.motorist_task_workspace("):current.rindex("commit;")])
        cls.before = cls.db.execute("select id,revision,reminder_generation,assignment_generation,status,due_at from motorist_case_tasks order by id").fetchall()
        cls.db.execute(sql(ROOT / "supabase/migrations/20261001100000_task_review_workflow.sql"))
        cls.db.execute("update motorist_task_workspace_settings set enabled=true,writer_inventory_verified_at=now(),writer_inventory_note='Disposable local review tests only'")

    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        with psycopg.connect(dbname="postgres", autocommit=True, **LOCAL) as admin:
            admin.execute("drop database " + cls.name)

    def actor(self, actor=A, autocommit=True):
        conn = psycopg.connect(dbname=self.name, autocommit=autocommit, **LOCAL)
        conn.execute("set role authenticated")
        conn.execute("select set_config('request.jwt.claim.sub',%s,false)", (actor.replace("20000000-", "30000000-"),))
        if not autocommit:
            conn.commit()
        return conn

    def workspace(self, action, task=None, data=None, actor=A, org=ORG, conn=None):
        args = (org, actor, action, task, json.dumps(data or {}))
        if conn:
            return conn.execute("select motorist_task_workspace(%s,%s,%s,%s,%s::jsonb)", args).fetchone()[0]
        with self.actor(actor) as client:
            return client.execute("select motorist_task_workspace(%s,%s,%s,%s,%s::jsonb)", args).fetchone()[0]

    def create(self, **fields):
        return self.workspace("create", data={"title": "Overiť dokumenty", "assignedTo": A, "caseIds": [CASE], "dueAt": "2030-01-02T12:00:00Z", "reminderAt": "2030-01-02T11:30:00Z", **fields})

    def command(self, task, action, **fields):
        return {"action": action, "expectedRevision": task["revision"], "commandId": str(uuid.uuid4()), **fields}

    def transition(self, task, command, actor=A, org=ORG, conn=None):
        args = (org, actor, task["id"], json.dumps(command))
        if conn:
            return conn.execute("select motorist_task_workflow(%s,%s,%s,%s::jsonb)", args).fetchone()[0]
        with self.actor(actor) as client:
            return client.execute("select motorist_task_workflow(%s,%s,%s,%s::jsonb)", args).fetchone()[0]

    def submit(self, task, reviewer=B):
        return self.transition(task, self.command(task, "submit_review", reviewerProfileId=reviewer, comment="Doklady doplnené, prosím overiť."))["task"]

    def rejected(self, code, fn):
        with self.assertRaises(psycopg.Error) as error:
            fn()
        self.assertEqual(error.exception.sqlstate, code)

    def test_01_migration_does_not_rewrite_existing_task_rows(self):
        after = self.db.execute("select id,revision,reminder_generation,assignment_generation,status,due_at from motorist_case_tasks order by id").fetchall()
        self.assertEqual(self.before, after)
        for row in self.before:
            task = self.workspace("get", row[0])
            self.assertEqual(task["workflowState"], "todo")
            self.assertEqual(task["workflowVersion"], 1)

    def test_02_all_stages_preserve_dates_links_assignee_and_reminder_generation(self):
        task = self.create()
        original = {key: task[key] for key in ["dueAt", "reminderAt", "caseIds", "assignedTo", "priority"]}
        task = self.transition(task, self.command(task, "start"))["task"]
        self.assertEqual(task["workflowState"], "in_progress")
        task = self.submit(task)
        self.assertEqual(task["workflowState"], "in_review")
        self.assertEqual(original, {key: task[key] for key in original})
        self.assertEqual(self.db.execute("select reminder_generation from motorist_case_tasks where id=%s", (task["id"],)).fetchone()[0], 0)
        task = self.transition(task, self.command(task, "approve"), actor=B)["task"]
        self.assertEqual((task["workflowState"], task["status"], task["reviewedBy"]), ("done", "done", B))
        self.assertEqual(original, {key: task[key] for key in original})
        self.assertIsNotNone(task["reviewedAt"])

    def test_03_one_private_notice_and_history_entry_for_identical_retries(self):
        task = self.create()
        command = self.command(task, "submit_review", reviewerProfileId=B, comment="Skontrolujte originál")
        first = self.transition(task, command)
        second = self.transition(task, command)
        self.assertEqual(first, second)
        rows = self.db.execute("select recipient_profile_id,visibility from motorist_notifications where task_id=%s and payload->>'source'='task_review_requested'", (task["id"],)).fetchall()
        self.assertEqual(rows, [(uuid.UUID(B), "private")])
        self.assertEqual(self.db.execute("select count(*) from motorist_task_messages where task_id=%s", (task["id"],)).fetchone()[0], 1)
        with self.actor(A) as client:
            self.assertEqual(client.execute("select count(*) from motorist_notifications where task_id=%s and payload->>'source'='task_review_requested'", (task["id"],)).fetchone()[0], 0)
        with self.actor(C) as client:
            self.assertEqual(client.execute("select count(*) from motorist_notifications where task_id=%s and payload->>'source'='task_review_requested'", (task["id"],)).fetchone()[0], 0)
        with self.actor(B) as client:
            self.assertEqual(client.execute("select count(*) from motorist_notifications where task_id=%s and payload->>'source'='task_review_requested'", (task["id"],)).fetchone()[0], 1)

    def test_04_only_designated_reviewer_decides_even_admin_cannot_approve(self):
        task = self.submit(self.create())
        for actor in [A, C]:
            for action in ["approve", "return"]:
                self.rejected("42501", lambda: self.transition(task, self.command(task, action, comment="Doplniť"), actor=actor))
        self.assertEqual(self.workspace("get", task["id"])["revision"], task["revision"])

    def test_05_return_requires_reason_and_keeps_review_required_after_reload(self):
        task = self.submit(self.create())
        self.rejected("22023", lambda: self.transition(task, self.command(task, "return", comment=" "), actor=B))
        self.rejected("22023", lambda: self.transition(task, self.command(task, "return", comment="\n\t\r"), actor=B))
        task = self.transition(task, self.command(task, "return", comment="Chýba podpis klienta"), actor=B)["task"]
        loaded = self.workspace("get", task["id"])
        self.assertEqual((loaded["workflowState"], loaded["reviewReturnReason"], loaded["reviewerProfileId"]), ("in_progress", "Chýba podpis klienta", B))
        self.rejected("22023", lambda: self.transition(task, self.command(task, "complete")))
        self.rejected("22023", lambda: self.workspace("update", task["id"], {"status": "done", "expectedRevision": task["revision"]}))
        task = self.submit(task)
        self.assertEqual(task["reviewGeneration"], 2)

    def test_06_legacy_completion_cannot_bypass_review_and_ordinary_edits_work(self):
        task = self.submit(self.create())
        self.rejected("22023", lambda: self.workspace("update", task["id"], {"status": "done", "expectedRevision": task["revision"]}))
        task = self.workspace("update", task["id"], {"title": "Doplnený názov", "status": "open", "expectedRevision": task["revision"]})
        self.assertEqual(task["workflowState"], "in_review")
        self.assertEqual(task["title"], "Doplnený názov")
        self.rejected("22023", lambda: self.workspace("update", task["id"], {"assignedTo": B, "expectedRevision": task["revision"]}))

    def test_07_simple_tasks_still_complete_and_reopen_from_legacy_or_new_api(self):
        task = self.create()
        task = self.workspace("update", task["id"], {"status": "done", "expectedRevision": task["revision"]})
        self.assertEqual(task["workflowState"], "done")
        task = self.workspace("update", task["id"], {"status": "open", "expectedRevision": task["revision"]})
        self.assertEqual(task["workflowState"], "todo")
        task = self.transition(task, self.command(task, "complete"))["task"]
        task = self.transition(task, self.command(task, "reopen"))["task"]
        self.assertEqual((task["workflowState"], task["status"]), ("todo", "open"))

    def test_08_reviewed_task_reopen_requires_new_review(self):
        task = self.submit(self.create())
        task = self.transition(task, self.command(task, "approve"), actor=B)["task"]
        task = self.workspace("update", task["id"], {"status": "open", "expectedRevision": task["revision"]})
        self.assertIsNone(task["reviewedBy"])
        self.assertIsNone(task["reviewedAt"])
        self.assertEqual(task["reviewerProfileId"], B)
        self.rejected("22023", lambda: self.transition(task, self.command(task, "complete")))

    def test_09_reviewer_must_be_active_same_org_distinct_signed_in_colleague(self):
        task = self.create()
        for reviewer in [A, OTHER, str(uuid.uuid4())]:
            self.rejected("22023", lambda: self.submit(task, reviewer))
        self.db.execute("update motorist_profiles set active=false where id=%s", (B,))
        try:
            self.rejected("22023", lambda: self.submit(task))
        finally:
            self.db.execute("update motorist_profiles set active=true where id=%s", (B,))
        self.db.execute("update motorist_profiles set user_id=null where id=%s", (B,))
        try:
            self.rejected("22023", lambda: self.submit(task))
        finally:
            self.db.execute("update motorist_profiles set user_id=%s where id=%s", (B.replace("20000000-", "30000000-"), B))

    def test_10_disabled_reviewer_can_be_reassigned_without_auto_approval(self):
        task = self.submit(self.create())
        self.db.execute("update motorist_profiles set active=false where id=%s", (B,))
        try:
            self.rejected("42501", lambda: self.transition(task, self.command(task, "approve"), actor=B))
            task = self.submit(task, C)
        finally:
            self.db.execute("update motorist_profiles set active=true where id=%s", (B,))
        self.assertEqual((task["workflowState"], task["reviewerProfileId"], task["reviewGeneration"]), ("in_review", C, 2))
        self.rejected("42501", lambda: self.transition(task, self.command(task, "approve"), actor=B))
        notices = self.db.execute("select recipient_profile_id,status from motorist_notifications where task_id=%s and payload->>'source'='task_review_requested' order by created_at", (task["id"],)).fetchall()
        self.assertEqual(notices, [(uuid.UUID(B), "archived"), (uuid.UUID(C), "unread")])

    def test_11_cross_org_forged_actor_and_direct_dml_are_denied(self):
        task = self.create()
        self.rejected("P0002", lambda: self.transition(task, self.command(task, "start"), actor=OTHER, org=OTHER_ORG))
        with self.actor(A) as client:
            self.rejected("42501", lambda: self.transition(task, self.command(task, "start"), actor=B, conn=client))
            self.rejected("42501", lambda: client.execute("update motorist_case_tasks set workflow_state='done' where id=%s", (task["id"],)))
            self.rejected("42501", lambda: client.execute("select * from motorist_task_workflow_commands"))
            self.rejected("42501", lambda: client.execute("select app_private.motorist_task_workspace_before_review(%s,%s,'update',%s,%s::jsonb)", (ORG, A, task["id"], json.dumps({"status": "done", "expectedRevision": 1}))))

    def test_12_stale_command_and_reused_identity_have_no_extra_effect(self):
        task = self.create()
        command = self.command(task, "start")
        first = self.transition(task, command)
        self.rejected("PT409", lambda: self.transition(task, self.command(task, "complete")))
        self.rejected("PT409", lambda: self.transition(task, {**command, "action": "complete"}))
        current = self.workspace("update", task["id"], {"title": "Novší názov", "expectedRevision": first["task"]["revision"]})
        receipt = self.transition(task, command)
        self.assertEqual(receipt["task"], current)
        self.assertEqual(receipt["committedRevision"], first["committedRevision"])

    def test_13_existing_system_completion_preserves_pending_review_before_lifecycle(self):
        task = self.submit(self.create())
        with self.db.transaction():
            self.db.execute("select set_config('app.task_workspace_write','v1',true)")
            self.db.execute("update motorist_case_tasks set status='done',completed_at=now() where id=%s", (task["id"],))
        loaded = self.workspace("get", task["id"])
        self.assertEqual((loaded["workflowState"], loaded["status"], loaded["completedAt"]), ("in_review", "open", None))
        self.assertEqual(self.db.execute("select reminder_generation from motorist_case_tasks where id=%s", (task["id"],)).fetchone()[0], 0)

    def test_14_real_proven_sms_completion_acknowledges_source_without_approving_task(self):
        task = self.workspace("get", "50000000-0000-0000-0000-000000000004")
        task = self.submit(task)
        self.db.execute("update motorist_sms_messages set template_key='eta_update',provider_message_id='fixture-provider-id',status='sent' where id='70000000-0000-0000-0000-000000000001'")
        with psycopg.connect(dbname=self.name, autocommit=True, **LOCAL) as client:
            client.execute("set role service_role")
            result = client.execute("select motorist_complete_task_source_v1(%s,'sms','70000000-0000-0000-0000-000000000001',null)", (ORG,)).fetchone()[0]
        self.assertEqual(result, {"completed": False, "reviewPending": True, "taskId": task["id"]})
        self.assertEqual(self.workspace("get", task["id"])["revision"], task["revision"])

    def test_15_unassigned_tasks_reviewer_distinct_from_submitter_and_return_notifies_submitter(self):
        task = self.create(assignedTo=None, caseIds=[])
        self.rejected("22023", lambda: self.submit(task, A))
        task = self.submit(task)
        task = self.transition(task, self.command(task, "return", comment="Doplniť kontakt"), actor=B)["task"]
        row = self.db.execute("select recipient_profile_id,visibility from motorist_notifications where task_id=%s and payload->>'source'='task_review_return'", (task["id"],)).fetchone()
        self.assertEqual(row, (uuid.UUID(A), "private"))

    def test_16_invalid_input_rolls_back_everything(self):
        task = self.create()
        for patch in [{"action": "unknown"}, {"expectedRevision": None}, {"expectedRevision": 1.5}, {"expectedRevision": 2147483648}, {"comment": None}]:
            self.rejected("22023", lambda: self.transition(task, {**self.command(task, "start"), **patch}))
        self.assertEqual(self.workspace("get", task["id"])["revision"], task["revision"])
        self.assertEqual(self.db.execute("select count(*) from motorist_task_workflow_commands where task_id=%s", (task["id"],)).fetchone()[0], 0)

    def test_17_concurrent_same_command_commits_one_review(self):
        task = self.create()
        command = self.command(task, "submit_review", reviewerProfileId=B, comment="Overiť originál")
        with self.actor(autocommit=False) as first, self.actor(autocommit=False) as second:
            receipt = self.transition(task, command, conn=first)
            results = []
            def run():
                try:
                    results.append(self.transition(task, command, conn=second))
                    second.commit()
                except Exception as error:
                    results.append(error)
                    second.rollback()
            thread = threading.Thread(target=run)
            thread.start()
            self.wait_for_lock(second.info.backend_pid)
            first.commit()
            thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(results, [receipt])
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications where task_id=%s and payload->>'source'='task_review_requested'", (task["id"],)).fetchone()[0], 1)

    def test_18_reviewer_race_conflicts_after_task_changes(self):
        task = self.submit(self.create())
        with self.actor(autocommit=False) as first, self.actor(B, autocommit=False) as second:
            self.workspace("update", task["id"], {"title": "Nový podklad", "expectedRevision": task["revision"]}, conn=first)
            results = []
            def run():
                try:
                    results.append(self.transition(task, self.command(task, "approve"), actor=B, conn=second))
                    second.commit()
                except psycopg.Error as error:
                    results.append(error.sqlstate)
                    second.rollback()
            thread = threading.Thread(target=run)
            thread.start()
            self.wait_for_lock(second.info.backend_pid)
            first.commit()
            thread.join(5)
            self.assertEqual(results, ["PT409"])
        self.assertEqual(self.workspace("get", task["id"])["workflowState"], "in_review")

    def test_19_deleted_task_cannot_be_replayed_or_resurrected(self):
        task = self.create()
        command = self.command(task, "start")
        task = self.transition(task, command)["task"]
        self.workspace("delete", task["id"], {"expectedRevision": task["revision"]})
        self.rejected("P0002", lambda: self.transition(task, command))
        self.assertEqual(self.db.execute("select count(*) from motorist_task_workflow_commands where task_id=%s", (task["id"],)).fetchone()[0], 0)

    def test_20_capability_denies_disabled_organization_and_inactive_actor(self):
        task = self.create()
        self.db.execute("update motorist_profiles set active=false where id=%s", (A,))
        try:
            self.rejected("42501", lambda: self.transition(task, self.command(task, "start")))
        finally:
            self.db.execute("update motorist_profiles set active=true where id=%s", (A,))
        self.db.execute("update motorist_organizations set active=false where id=%s", (ORG,))
        try:
            self.rejected("42501", lambda: self.transition(task, self.command(task, "start")))
        finally:
            self.db.execute("update motorist_organizations set active=true where id=%s", (ORG,))

    def test_21_invited_profile_with_user_id_is_not_an_eligible_reviewer(self):
        task = self.create()
        self.db.execute("update motorist_profiles set access_status='invited' where id=%s", (B,))
        try:
            self.rejected("22023", lambda: self.submit(task))
        finally:
            self.db.execute("update motorist_profiles set access_status='active' where id=%s", (B,))

    def test_22_moderator_can_reassign_review_but_cannot_decide_for_reviewer(self):
        task = self.submit(self.create())
        # Admin C assigns the review from B to another active non-assignee D.
        colleague = str(uuid.uuid4())
        colleague_user = str(uuid.uuid4())
        self.db.execute("insert into motorist_profiles(id,organization_id,user_id,display_name,role) values(%s,%s,%s,'D','dispatcher')", (colleague, ORG, colleague_user))
        task = self.transition(task, self.command(task, "submit_review", reviewerProfileId=colleague, comment="Zastupovanie neprítomného kolegu"), actor=C)["task"]
        self.assertEqual(task["reviewerProfileId"], colleague)
        self.rejected("42501", lambda: self.transition(task, self.command(task, "approve"), actor=C))

    def test_23_legacy_overdue_is_preserved_as_deadline_metadata_during_stage_moves(self):
        task = self.create(status="overdue")
        task = self.transition(task, self.command(task, "start"))["task"]
        self.assertEqual((task["workflowState"], task["status"]), ("in_progress", "overdue"))
        task = self.transition(task, self.command(task, "to_todo"))["task"]
        self.assertEqual((task["workflowState"], task["status"]), ("todo", "overdue"))

    def test_24_old_client_cannot_bypass_review_with_forged_transaction_flag(self):
        task = self.submit(self.create())
        with self.actor() as client:
            client.execute("select set_config('app.task_workflow_write','v1',false)")
            self.rejected("22023", lambda: self.workspace("update", task["id"], {"status": "done", "expectedRevision": task["revision"]}, conn=client))
        self.assertEqual(self.workspace("get", task["id"])["workflowState"], "in_review")

    def test_25_notification_failure_rolls_back_stage_receipt_audit_and_chat(self):
        task = self.create()
        self.db.execute("""create function pg_temp.reject_review_notice() returns trigger language plpgsql as $$ begin
        if new.payload->>'source'='task_review_requested' then raise exception 'Fixture notification failure'; end if;
        return new; end $$;
        create trigger fixture_reject_review before insert on motorist_notifications for each row execute function pg_temp.reject_review_notice();""")
        try:
            self.rejected("P0001", lambda: self.submit(task))
        finally:
            self.db.execute("drop trigger fixture_reject_review on motorist_notifications")
        self.assertEqual(self.workspace("get", task["id"]), task)
        for table, key in [("motorist_task_workflow_commands", "task_id"), ("motorist_task_messages", "task_id")]:
            self.assertEqual(self.db.execute(f"select count(*) from {table} where {key}=%s", (task["id"],)).fetchone()[0], 0)
        self.assertEqual(self.db.execute("select count(*) from motorist_audit_log where entity_id=%s and action like 'task.workflow.%%'", (task["id"],)).fetchone()[0], 0)

    def test_26_disabled_capability_never_falls_back_to_legacy_stage_writes(self):
        task = self.create()
        self.db.execute("update motorist_task_workspace_settings set enabled=false where organization_id=%s", (ORG,))
        try:
            with self.actor() as client:
                self.assertFalse(client.execute("select motorist_task_workflow_enabled(%s,%s)", (ORG, A)).fetchone()[0])
            self.rejected("55000", lambda: self.transition(task, self.command(task, "start")))
        finally:
            self.db.execute("update motorist_task_workspace_settings set enabled=true where organization_id=%s", (ORG,))
        self.assertEqual(self.workspace("get", task["id"]), task)

    def wait_for_lock(self, pid):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            row = self.db.execute("select wait_event_type from pg_stat_activity where pid=%s", (pid,)).fetchone()
            if row and row[0] == "Lock":
                return
            time.sleep(.01)
        self.fail("No observed task row lock")


if __name__ == "__main__":
    unittest.main(verbosity=2)
