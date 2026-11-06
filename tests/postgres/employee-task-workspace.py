"""Employee tasks and inherited legacy contracts in a disposable local database."""
from pathlib import Path
import importlib.util
import json
import threading
import unittest
import uuid
import psycopg

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("task_review_contract", Path(__file__).with_name("task-review-workflow.py"))
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
ORG, OTHER_ORG = legacy.ORG, legacy.OTHER_ORG
A, B, C = [f"30000000-0000-0000-0000-{i:012d}" for i in range(1, 4)]
DRIVER, LEAD, SECOND_LEAD, OUTSIDER = [f"31000000-0000-0000-0000-{i:012d}" for i in range(1, 5)]
GROUP = "41000000-0000-0000-0000-000000000001"
MEMBER, LEAD_MEMBER, SECOND_MEMBER = [f"21000000-0000-0000-0000-{i:012d}" for i in range(1, 4)]
MIGRATION = ROOT / "supabase/migrations/20261106135621_employee_task_workspace.sql"


class EmployeeTaskContract(legacy.TaskReviewContract):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.db.execute("""create table auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);
            insert into auth.users(id)select user_id from motorist_profiles;
            alter table motorist_profiles add column kind text not null default 'human';
            create table motorist_towing_memberships(id uuid primary key,organization_id uuid not null,
                auth_user_id uuid not null,display_name text not null,active boolean not null default true,
                office_profile_id uuid,unique(organization_id,id),unique(organization_id,auth_user_id));
            create table motorist_work_groups(id uuid primary key,organization_id uuid not null,name text not null,
                active boolean not null default true,unique(organization_id,id));
            create table motorist_work_group_members(organization_id uuid,group_id uuid,member_id uuid,role text,
                receives_new boolean default false,primary key(group_id,member_id));""")
        for uid, mid, name in [(DRIVER, MEMBER, "Vodič"), (LEAD, LEAD_MEMBER, "Vedúci"), (SECOND_LEAD, SECOND_MEMBER, "Druhý vedúci")]:
            cls.db.execute("insert into auth.users(id)values(%s)", (uid,))
            cls.db.execute("insert into motorist_towing_memberships(id,organization_id,auth_user_id,display_name)values(%s,%s,%s,%s)", (mid, ORG, uid, name))
        cls.db.execute("insert into motorist_towing_memberships(id,organization_id,auth_user_id,display_name,office_profile_id)values(gen_random_uuid(),%s,%s,'A terén',%s)", (ORG, A, legacy.A))
        cls.db.execute("insert into auth.users(id)values(%s)", (OUTSIDER,))
        cls.db.execute("insert into motorist_towing_memberships(id,organization_id,auth_user_id,display_name)values(gen_random_uuid(),%s,%s,'Cudzí')", (OTHER_ORG, OUTSIDER))
        cls.db.execute("insert into motorist_work_groups(id,organization_id,name)values(%s,%s,'Žilina')", (GROUP, ORG))
        for mid in (LEAD_MEMBER, SECOND_MEMBER):
            cls.db.execute("insert into motorist_work_group_members(organization_id,group_id,member_id,role)values(%s,%s,%s,'lead')", (ORG, GROUP, mid))
        cls.db.execute(MIGRATION.read_text())

    def employee(self, action, data=None, task=None, user=DRIVER, org=ORG, conn=None):
        args = (user, org, action, task, json.dumps(data or {}))
        if conn:
            return conn.execute("select motorist_employee_tasks(%s,%s,%s,%s,%s::jsonb)", args).fetchone()[0]
        with psycopg.connect(dbname=self.name, autocommit=True, **legacy.LOCAL) as client:
            client.execute("set role service_role")
            return client.execute("select motorist_employee_tasks(%s,%s,%s,%s,%s::jsonb)", args).fetchone()[0]

    def employee_create(self, user=DRIVER, target=None, **fields):
        return self.employee("create", {"commandId": str(uuid.uuid4()), "title": "Pripraviť vozidlo", "target": target or {"kind": "person", "userId": user}, **fields}, user=user)["task"]

    def employee_command(self, task, action, user=DRIVER, **fields):
        return self.employee("command", {"commandId": str(uuid.uuid4()), "expectedRevision": task["revision"], "action": action, **fields}, task=task["id"], user=user)["task"]

    def test_employee_01_field_create_assign_work_and_no_dispatch_profile(self):
        task = self.employee_create(target={"kind": "person", "userId": LEAD}, dueAt="2030-01-01T15:00:00Z", description="Dotankovať")
        self.assertEqual(task["createdBy"]["userId"], DRIVER)
        self.assertEqual(task["assignee"]["userId"], LEAD)
        self.assertEqual(task["description"], "Dotankovať")
        self.assertEqual(task["caseLinks"], [])
        self.assertEqual(self.db.execute("select count(*) from motorist_profiles where user_id in (%s,%s)", (DRIVER, LEAD)).fetchone()[0], 0)
        compatibility = self.workspace("get", task["id"])
        self.assertEqual(compatibility["assignedTo"], "unassigned")
        self.assertEqual(compatibility["assignedUserId"], LEAD)
        self.assertEqual(compatibility["assignedUserName"], "Vedúci")
        self.assertIn(task["id"], [t["id"] for t in self.employee("list", {"view": "mine"}, user=LEAD)["tasks"]])
        task = self.employee_command(task, "start", user=LEAD)
        task = self.employee_command(task, "complete", user=LEAD)
        self.assertEqual(task["state"], "done")
        self.assertEqual(self.db.execute("select completed_by_user_id,completed_by from motorist_case_tasks where id=%s", (task["id"],)).fetchone(), (uuid.UUID(LEAD), None))

    def test_employee_02_revocation_cross_org_and_unrelated_field_read(self):
        task = self.employee_create()
        self.rejected("42501", lambda: self.employee("get", task=task["id"], user=OUTSIDER))
        self.rejected("P0002", lambda: self.employee("get", task=task["id"], user=SECOND_LEAD))
        self.rejected("22023", lambda: self.employee_create(target={"kind": "person", "userId": OUTSIDER}))
        self.db.execute("update motorist_towing_memberships set active=false where id=%s", (MEMBER,))
        try:
            self.rejected("42501", lambda: self.employee("list"))
        finally:
            self.db.execute("update motorist_towing_memberships set active=true where id=%s", (MEMBER,))

    def test_employee_03_create_retry_is_idempotent_payload_change_conflicts(self):
        payload = {"commandId": str(uuid.uuid4()), "title": "Iba raz", "target": {"kind": "person", "userId": DRIVER}}
        first = self.employee("create", payload)
        self.assertEqual(first, self.employee("create", payload))
        self.rejected("PT409", lambda: self.employee("create", {**payload, "title": "Iný obsah"}))
        self.assertEqual(self.db.execute("select count(*) from motorist_case_tasks where id=%s", (first["task"]["id"],)).fetchone()[0], 1)

    def test_employee_04_group_lead_claim_or_delegate(self):
        task = self.employee_create(target={"kind": "group", "groupId": GROUP})
        self.assertIsNone(task["assignee"])
        self.assertEqual(self.workspace("get", task["id"])["assignedGroupName"], "Žilina")
        self.rejected("42501", lambda: self.employee_command(task, "claim"))
        branch = self.employee("list", {"view": "branch"}, user=LEAD)
        self.assertIn(task["id"], [x["id"] for x in branch["tasks"]])
        claimed = self.employee_command(task, "claim", user=LEAD)
        self.assertEqual(claimed["assignee"]["userId"], LEAD)
        assigned = self.employee_command(claimed, "assign", user=LEAD, target={"kind": "person", "userId": DRIVER})
        self.assertEqual(assigned["group"]["id"], GROUP)
        self.assertEqual(assigned["assignee"]["userId"], DRIVER)
        self.assertFalse(assigned["permissions"]["claim"])

    def test_employee_05_two_leads_one_claim_wins(self):
        task = self.employee_create(target={"kind": "group", "groupId": GROUP})
        barrier = threading.Barrier(2)
        results = []
        def run(user):
            try:
                barrier.wait(timeout=5)
                self.employee_command(task, "claim", user=user)
                results.append("ok")
            except psycopg.Error as error:
                results.append(error.sqlstate)
        threads = [threading.Thread(target=run, args=(u,)) for u in (LEAD, SECOND_LEAD)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=10)
        self.assertCountEqual(results, ["ok", "PT409"])

    def test_employee_06_field_messages_keep_legacy_shape_and_retry(self):
        task = self.employee_create(user=A, target={"kind": "person", "userId": DRIVER})
        payload = {"commandId": str(uuid.uuid4()), "expectedRevision": task["revision"], "action": "comment", "body": "Auto pripravené"}
        first = self.employee("command", payload, task["id"])
        self.assertEqual(first, self.employee("command", payload, task["id"]))
        detail = self.employee("get", task=task["id"])
        self.assertEqual(detail["activity"][0]["author"]["userId"], DRIVER)
        old = self.workspace("messages", task["id"])
        self.assertEqual(old["messages"][0]["authorProfileId"], DRIVER)
        self.assertEqual(old["messages"][0]["authorName"], "Vodič")

    def test_employee_07_required_review_is_not_bypassed_for_field_assignee(self):
        task = self.employee_create(user=A, target={"kind": "person", "userId": DRIVER})
        task = self.employee_command(task, "submit_review", reviewerUserId=B, comment="Prosím skontrolovať")
        self.assertEqual(task["state"], "in_review")
        self.assertFalse(task["permissions"]["complete"])
        self.rejected("42501", lambda: self.employee_command(task, "approve", user=C))
        self.rejected("22023", lambda: self.workspace("update", task["id"], {"status": "done", "expectedRevision": task["revision"]}))
        task = self.employee_command(task, "return", user=B, comment="Chýba podpis")
        self.rejected("42501", lambda: self.employee_command(task, "complete"))
        task = self.employee_command(task, "submit_review", reviewerUserId=B, comment="Podpis doplnený")
        task = self.employee_command(task, "approve", user=B)
        self.assertEqual(task["state"], "done")

    def test_employee_08_due_field_or_group_never_fans_out_office_reminders(self):
        for target in ({"kind": "person", "userId": DRIVER}, {"kind": "group", "groupId": GROUP}):
            task = self.employee_create(target=target, dueAt="2030-01-01T15:00:00Z")
            self.assertEqual(self.db.execute("select count(*) from motorist_task_reminders where task_id=%s", (task["id"],)).fetchone()[0], 0)
            self.assertEqual(self.db.execute("select count(*) from motorist_notifications where task_id=%s and visibility='team'", (task["id"],)).fetchone()[0], 0)
        office = self.employee_create(target={"kind": "person", "userId": A}, dueAt="2030-01-01T15:00:00Z")
        self.assertEqual(self.db.execute("select distinct recipient_profile_id from motorist_task_reminders where task_id=%s", (office["id"],)).fetchall(), [(uuid.UUID(legacy.A),)])

    def test_employee_09_legacy_reassign_and_explicit_null_clear_canonical_target(self):
        task = self.employee_create(user=A, target={"kind": "person", "userId": DRIVER})
        old = self.workspace("update", task["id"], {"assignedTo": None, "expectedRevision": task["revision"]})
        self.assertIsNone(self.employee("get", task=task["id"], user=A)["task"]["assignee"])
        self.assertIsNone(self.db.execute("select assigned_user_id from motorist_case_tasks where id=%s", (task["id"],)).fetchone()[0])
        self.workspace("update", task["id"], {"assignedTo": legacy.B, "expectedRevision": old["revision"]})
        self.assertEqual(self.employee("get", task=task["id"], user=A)["task"]["assignee"]["userId"], B)

    def test_employee_10_standalone_cursor_is_scope_bound_and_case_links_private(self):
        for number in range(3): self.employee_create(title=f"Stránka {number}")
        first = self.employee("list", {"view": "mine", "q": "Stránka", "limit": 2})
        self.assertEqual(len(first["tasks"]), 2)
        self.assertIsNotNone(first["nextCursor"])
        second = self.employee("list", {"view": "mine", "q": "Stránka", "limit": 2, "cursor": first["nextCursor"]})
        self.assertEqual(len(second["tasks"]), 1)
        self.assertNotEqual(first["tasks"][0]["id"], second["tasks"][0]["id"])
        self.rejected("22023", lambda: self.employee("list", {"view": "created", "q": "Stránka", "cursor": first["nextCursor"]}))
        self.rejected("42501", lambda: self.employee_create(caseId=legacy.CASE))
        task = self.employee_create(user=A, target={"kind": "person", "userId": DRIVER}, caseId=legacy.CASE)
        self.assertEqual(len(task["caseLinks"]), 1)
        self.assertEqual(self.employee("get", task=task["id"])["task"]["caseLinks"], [])

    def test_employee_11_unprivileged_rpc_and_direct_task_reads_stay_blocked(self):
        with self.actor() as client:
            self.rejected("42501", lambda: client.execute("select motorist_employee_tasks(%s,%s,'directory')", (DRIVER, ORG)))
        with psycopg.connect(dbname=self.name, autocommit=True, **legacy.LOCAL) as client:
            client.execute("set role authenticated")
            client.execute("select set_config('request.jwt.claim.sub',%s,false)", (DRIVER,))
            self.assertEqual(client.execute("select count(*) from motorist_case_tasks").fetchone()[0], 0)
        directory = self.employee("directory")
        self.assertIn(DRIVER, [p["userId"] for p in directory["people"]])
        self.assertNotIn(OUTSIDER, [p["userId"] for p in directory["people"]])
        self.assertFalse(directory["canLinkCases"])

    def test_employee_12_linked_office_revocation_banned_users_and_inactive_group(self):
        self.db.execute("update motorist_profiles set access_status='disabled' where id=%s", (legacy.A,))
        try:
            self.rejected("42501", lambda: self.employee("directory", user=A))
        finally:
            self.db.execute("update motorist_profiles set access_status='active' where id=%s", (legacy.A,))
        self.db.execute("update auth.users set banned_until=now()+interval '1 hour' where id=%s", (DRIVER,))
        try:
            self.rejected("42501", lambda: self.employee("directory"))
        finally:
            self.db.execute("update auth.users set banned_until=null where id=%s", (DRIVER,))
        self.db.execute("update motorist_work_groups set active=false where id=%s", (GROUP,))
        try:
            self.rejected("22023", lambda: self.employee_create(target={"kind": "group", "groupId": GROUP}))
        finally:
            self.db.execute("update motorist_work_groups set active=true where id=%s", (GROUP,))

    def test_employee_13_activity_pages_and_assignment_generations(self):
        task = self.employee_create(user=A, target={"kind": "person", "userId": B}, dueAt="2030-01-01T15:00:00Z")
        generation = self.db.execute("select assignment_generation,reminder_generation from motorist_case_tasks where id=%s", (task["id"],)).fetchone()
        task = self.employee_command(task, "assign", user=A, target={"kind": "person", "userId": DRIVER})
        new_generation = self.db.execute("select assignment_generation,reminder_generation from motorist_case_tasks where id=%s", (task["id"],)).fetchone()
        self.assertEqual(new_generation, (generation[0] + 1, generation[1] + 1))
        self.assertEqual(self.db.execute("select count(*) from motorist_task_assignment_deliveries where task_id=%s and status in ('pending','processing')", (task["id"],)).fetchone()[0], 0)
        self.assertEqual(self.db.execute("select count(*) from motorist_task_reminders where task_id=%s and status in ('pending','processing')", (task["id"],)).fetchone()[0], 0)
        for i in range(52):
            task = self.employee_command(task, "comment", body=f"Poznámka {i}")
        first = self.employee("get", task=task["id"])
        self.assertEqual(len(first["activity"]), 50)
        self.assertIsNotNone(first["nextActivityCursor"])
        rest = self.employee("get", {"cursor": first["nextActivityCursor"]}, task=task["id"])
        self.assertEqual(len(rest["activity"]), 4)
        self.assertEqual(len({x["id"] for x in first["activity"] + rest["activity"]}), 54)
        self.rejected("22023", lambda: self.employee("get", {"cursor": first["nextActivityCursor"]}, task=task["id"], user=A))

    def test_employee_14_deleted_create_receipt_never_resurrects_the_task(self):
        command = str(uuid.uuid4())
        payload = {"commandId": command, "title": "Nevzkriesiť po vymazaní", "target": {"kind": "person", "userId": DRIVER}}
        receipt = self.employee("create", payload, user=A)
        task = receipt["task"]
        self.workspace("delete", task["id"], {"expectedRevision": task["revision"]})
        self.assertEqual(self.db.execute("select count(*) from motorist_task_employee_commands where command_id=%s", (command,)).fetchone()[0], 1)
        self.rejected("P0002", lambda: self.employee("create", payload, user=A))
        self.rejected("PT409", lambda: self.employee("create", {**payload, "title": "Iný obsah"}, user=A))
        self.assertEqual(self.db.execute("select count(*) from motorist_case_tasks where title=%s", (payload["title"],)).fetchone()[0], 0)

    def test_employee_15_unclaimed_branch_creator_cannot_bypass_lead_ownership(self):
        task = self.employee_create(target={"kind": "group", "groupId": GROUP})
        self.assertFalse(task["permissions"]["claim"])
        self.assertFalse(task["permissions"]["assign"])
        self.rejected("42501", lambda: self.employee_command(task, "claim"))
        for target in ({"kind": "person", "userId": DRIVER}, {"kind": "person", "userId": SECOND_LEAD}):
            self.rejected("42501", lambda: self.employee_command(task, "assign", target=target))
        self.assertIsNone(self.employee("get", task=task["id"])["task"]["assignee"])
        delegated = self.employee_command(task, "assign", user=LEAD, target={"kind": "person", "userId": DRIVER})
        self.assertEqual(delegated["assignee"]["userId"], DRIVER)
        # Explicitly retain existing administrative oversight; this is distinct
        # from an ordinary field employee's ownership of their created task.
        admin_task = self.employee_create(target={"kind": "group", "groupId": GROUP})
        self.assertTrue(self.employee("get", task=admin_task["id"], user=C)["task"]["permissions"]["assign"])
        admin_task = self.employee_command(admin_task, "assign", user=C, target={"kind": "person", "userId": DRIVER})
        self.assertEqual(admin_task["assignee"]["userId"], DRIVER)

    def test_employee_16_unclaimable_groups_are_neither_listed_nor_routable(self):
        group = str(uuid.uuid4())
        self.db.execute("insert into motorist_work_groups(id,organization_id,name)values(%s,%s,'Bez aktívneho vedúceho')", (group, ORG))
        def unavailable():
            self.assertNotIn(group, [g["id"] for g in self.employee("directory", user=C)["groups"]])
            self.rejected("22023", lambda: self.employee_create(user=C, target={"kind": "group", "groupId": group}))
        unavailable()
        self.db.execute("insert into motorist_work_group_members(organization_id,group_id,member_id,role)values(%s,%s,%s,'lead')", (ORG, group, MEMBER))
        self.assertIn(group, [g["id"] for g in self.employee("directory", user=C)["groups"]])
        self.db.execute("update motorist_towing_memberships set active=false where id=%s", (MEMBER,))
        try:
            unavailable()
        finally:
            self.db.execute("update motorist_towing_memberships set active=true where id=%s", (MEMBER,))
        self.db.execute("update auth.users set banned_until=now()+interval '1 hour' where id=%s", (DRIVER,))
        try:
            unavailable()
        finally:
            self.db.execute("update auth.users set banned_until=null where id=%s", (DRIVER,))
        # This lead's field membership is linked to its real office profile.
        office_member = self.db.execute("select id from motorist_towing_memberships where auth_user_id=%s", (A,)).fetchone()[0]
        self.db.execute("update motorist_work_group_members set role='member' where group_id=%s and member_id=%s", (group, MEMBER))
        self.db.execute("insert into motorist_work_group_members(organization_id,group_id,member_id,role)values(%s,%s,%s,'lead')", (ORG, group, office_member))
        self.assertIn(group, [g["id"] for g in self.employee("directory", user=C)["groups"]])
        self.db.execute("update motorist_profiles set access_status='disabled' where id=%s", (legacy.A,))
        try:
            unavailable()
        finally:
            self.db.execute("update motorist_profiles set access_status='active' where id=%s", (legacy.A,))
        self.assertIn(group, [g["id"] for g in self.employee("directory", user=C)["groups"]])

    def test_employee_17_office_review_outcome_notices_are_private_and_idempotent(self):
        task = self.employee_create(user=A)
        task = self.employee_command(task, "submit_review", user=A, reviewerUserId=B, comment="Na kontrolu")
        task = self.employee_command(task, "return", user=B, comment="Doplniť podpis")
        rows = self.db.execute("select recipient_profile_id,visibility,payload->>'review_generation',body from motorist_notifications where task_id=%s and payload->>'source'='task_review_return'", (task["id"],)).fetchall()
        self.assertEqual(rows, [(uuid.UUID(legacy.A), "private", "1", task["title"] + "\nDoplniť podpis")])
        self.assertEqual(self.db.execute("select status from motorist_notifications where task_id=%s and payload->>'source'='task_review_requested'", (task["id"],)).fetchall(), [("archived",)])
        task = self.employee_command(task, "submit_review", user=A, reviewerUserId=B, comment="Podpis doplnený")
        command = {"commandId": str(uuid.uuid4()), "expectedRevision": task["revision"], "action": "approve"}
        first = self.employee("command", command, task=task["id"], user=B)
        self.assertEqual(first, self.employee("command", command, task=task["id"], user=B))
        self.assertEqual(self.db.execute("select recipient_profile_id,visibility,payload->>'review_generation' from motorist_notifications where task_id=%s and payload->>'source'='task_review_approve'", (task["id"],)).fetchall(), [(uuid.UUID(legacy.A), "private", "2")])
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications where task_id=%s and payload->>'source'='task_review_requested' and status='unread'", (task["id"],)).fetchone()[0], 0)
        # Existing unassigned office tasks retain the requestor fallback.
        unassigned = self.submit(self.create(assignedTo=None), reviewer=legacy.B)
        task = self.employee("get", task=unassigned["id"], user=B)["task"]
        self.employee_command(task, "return", user=B, comment="Vrátené zadávateľovi")
        self.assertEqual(self.db.execute("select recipient_profile_id,visibility from motorist_notifications where task_id=%s and payload->>'source'='task_review_return'", (task["id"],)).fetchall(), [(uuid.UUID(legacy.A), "private")])

    def test_employee_18_field_review_outcome_never_notifies_office_creator(self):
        task = self.employee_create(user=A, target={"kind": "person", "userId": DRIVER})
        task = self.employee_command(task, "submit_review", reviewerUserId=B, comment="Overiť výkon")
        task = self.employee_command(task, "return", user=B, comment="Doplniť fotografiu")
        task = self.employee_command(task, "submit_review", reviewerUserId=B, comment="Fotografia doplnená")
        self.employee_command(task, "approve", user=B)
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications where task_id=%s and payload->>'source' in ('task_review_return','task_review_approve')", (task["id"],)).fetchone()[0], 0)
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications where task_id=%s and (recipient_profile_id=%s or visibility='team')", (task["id"], legacy.A)).fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
