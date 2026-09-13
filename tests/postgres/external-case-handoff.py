"""Independent limited-handoff security contracts on unique disposable loopback DBs."""
from pathlib import Path
import hashlib
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


def sql(path):
    return "\n".join(sql(path.parent / line[4:]) if line.startswith("\\ir ") else line for line in path.read_text().splitlines() if not line.startswith("\\set "))


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class ExternalHandoffContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name = "external_handoff_" + uuid.uuid4().hex[:12]
        with psycopg.connect(dbname="postgres", autocommit=True, **LOCAL) as admin:
            admin.execute("create database " + cls.name)
        cls.db = psycopg.connect(dbname=cls.name, autocommit=True, **LOCAL)
        cls.db.execute(sql(ROOT / "tests/postgres/task-workspace-fixture.sql"))
        cls.db.execute("alter table motorist_profiles add column access_status text not null default 'active'; drop table motorist_task_reminders")
        cls.db.execute("""create function app_private.motorist_is_org_member(org uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
        select exists(select 1 from motorist_profiles p where p.organization_id=org and p.user_id=auth.uid() and p.active) $$;
        create function public.motorist_set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;""")
        for name in ["20260609110000_task_reminders_notifications.sql", "20260929120000_task_workspace.sql", "20260929130000_task_notification_privacy.sql"]:
            cls.db.execute(sql(ROOT / "supabase/migrations" / name))
        current = (ROOT / "supabase/migrations/20260929170000_domain_conflict_sqlstate.sql").read_text()
        cls.db.execute(current[current.index("CREATE OR REPLACE FUNCTION public.motorist_task_workspace("):current.rindex("commit;")])
        cls.db.execute(sql(ROOT / "supabase/migrations/20261001100000_task_review_workflow.sql"))
        cls.db.execute("""
        create table motorist_contacts(id uuid primary key,organization_id uuid,name text,phone text,email text,private_details jsonb);
        create table motorist_vehicles(id uuid primary key,organization_id uuid,make text,model text,license_plate text,vin text,private_details jsonb);
        create table motorist_locations(id uuid primary key,organization_id uuid,address text,lat numeric,lng numeric,notes text);
        alter table motorist_cases add column case_type text, add column contact_id uuid, add column vehicle_id uuid,
          add column pickup_location_id uuid, add column destination_location_id uuid,
          add column internal_note text, add column prices jsonb, add column attachments jsonb, add column transcript text,
          add column location_details jsonb;
        """)
        cls.db.execute(sql(ROOT / "supabase/migrations/20261001110000_external_case_handoff.sql"))

    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        with psycopg.connect(dbname="postgres", autocommit=True, **LOCAL) as admin:
            admin.execute("drop database " + cls.name)

    def client(self, role="authenticated", actor=A, autocommit=True):
        conn = psycopg.connect(dbname=self.name, autocommit=autocommit, **LOCAL)
        conn.execute("set role " + role)
        if role == "authenticated":
            conn.execute("select set_config('request.jwt.claim.sub',%s,false)", (actor.replace("20000000-", "30000000-"),))
        if not autocommit:
            conn.commit()
        return conn

    def new_case(self, org=ORG):
        case, contact, vehicle, pickup, destination = [str(uuid.uuid4()) for _ in range(5)]
        self.db.execute("insert into motorist_contacts values(%s,%s,'Client','+421900000000','PRIVATE_EMAIL',%s::jsonb)", (contact, org, json.dumps({"secret": "PRIVATE_CONTACT_DETAILS"})))
        self.db.execute("insert into motorist_vehicles values(%s,%s,'Skoda','Octavia','TEST001','PRIVATE_VIN',%s::jsonb)", (vehicle, org, json.dumps({"secret": "PRIVATE_VEHICLE_DETAILS"})))
        self.db.execute("insert into motorist_locations values(%s,%s,'Pickup address',48.1,17.1,'PRIVATE_PICKUP_NOTE'),(%s,%s,'Destination address',48.2,17.2,'PRIVATE_DESTINATION_NOTE')", (pickup, org, destination, org))
        self.db.execute("""insert into motorist_cases(id,organization_id,case_number,status,case_type,contact_id,vehicle_id,pickup_location_id,destination_location_id,internal_note,prices,attachments,transcript)
        values(%s,%s,'TEST-CASE','open','Tow service',%s,%s,%s,%s,'PRIVATE_CASE_NOTE','{"price":"PRIVATE_PRICE"}','{"file":"PRIVATE_ATTACHMENT"}','PRIVATE_TRANSCRIPT')""", (case, org, contact, vehicle, pickup, destination))
        return case

    def internal(self, case, action, data=None, actor=A, org=ORG, conn=None):
        args = (org, actor, case, action, json.dumps(data or {}))
        if conn:
            return conn.execute("select motorist_case_handoff(%s,%s,%s,%s,%s::jsonb)", args).fetchone()[0]
        with self.client(actor=actor) as client:
            return client.execute("select motorist_case_handoff(%s,%s,%s,%s,%s::jsonb)", args).fetchone()[0]

    def public(self, action, token_hash, data=None, conn=None):
        args = (action, token_hash, json.dumps(data or {}))
        if conn:
            return conn.execute("select motorist_public_handoff(%s,%s,%s::jsonb)", args).fetchone()[0]
        with self.client("service_role") as client:
            return client.execute("select motorist_public_handoff(%s,%s,%s::jsonb)", args).fetchone()[0]

    def issue(self, case=None, **fields):
        case = case or self.new_case()
        token = digest("grant-" + uuid.uuid4().hex)
        context = self.internal(case, "context")
        command = {"commandId": str(uuid.uuid4()), "previewVersion": context["previewVersion"], "recipientName": "Partner centre", "recipientPhone": "+421900000111", "instructions": "Meet by the entrance", "hours": 24, "tokenHash": token, **fields}
        receipt = self.internal(case, "issue", command)
        return case, token, receipt["handoff"], command

    def session(self, token):
        session = digest("session-" + uuid.uuid4().hex)
        return session, self.public("session", token, {"sessionHash": session})["handoff"]

    def command(self, handoff, action, **fields):
        return {"handoffId": handoff["id"], "action": action, "commandId": str(uuid.uuid4()), "expectedRevision": handoff["revision"], "publishedVersion": handoff["publishedVersion"], **fields}

    def private_command(self, handoff, **fields):
        return {"handoffId": handoff["id"], "commandId": str(uuid.uuid4()), "expectedRevision": handoff["revision"], **fields}

    def rejected(self, code, fn):
        with self.assertRaises(psycopg.Error) as error:
            fn()
        self.assertEqual(error.exception.sqlstate, code)

    def test_01_actor_org_permissions_and_private_tables(self):
        case = self.new_case()
        self.rejected("P0002", lambda: self.internal(case, "context", actor=OTHER, org=OTHER_ORG))
        with self.client(actor=A) as client:
            self.rejected("42501", lambda: self.internal(case, "context", actor=B, conn=client))
            for table in ["motorist_case_handoffs", "motorist_handoff_sessions", "motorist_handoff_events", "motorist_handoff_receipts"]:
                self.rejected("42501", lambda: client.execute("select * from " + table))
            self.rejected("42501", lambda: client.execute("select motorist_public_handoff('read',%s,'{}')", (digest("none"),)))
        with self.client("anon") as client:
            self.rejected("42501", lambda: self.internal(case, "context", conn=client))
            self.rejected("42501", lambda: self.public("read", digest("none"), conn=client))

    def test_02_public_dto_has_only_explicit_published_fields_and_no_private_source_data(self):
        case, token, handoff, _ = self.issue()
        session, opened = self.session(token)
        public = self.public("read", session, {"handoffId": handoff["id"]})["handoff"]
        self.assertEqual(set(public), {"id", "status", "revision", "publishedVersion", "recipientName", "expiresAt", "createdAt", "openedAt", "eta", "published", "events"})
        self.assertEqual(set(public["published"]), {"caseNumber", "action", "contact", "vehicle", "pickup", "destination", "instructions", "scheduledAt"})
        self.assertEqual(set(public["published"]["contact"]), {"name", "phone"})
        self.assertEqual(set(public["published"]["vehicle"]), {"make", "model", "plate"})
        self.assertNotIn("PRIVATE_", json.dumps(public))
        self.assertNotIn("recipientPhone", public)
        self.assertNotIn("token", json.dumps(public).lower())
        self.assertEqual(opened["status"], "offered")
        self.assertEqual(opened["revision"], 1)
        self.assertIsNotNone(opened["openedAt"])
        self.assertEqual(self.db.execute("select status from motorist_cases where id=%s", (case,)).fetchone()[0], "open")

    def test_03_issue_retry_does_not_rotate_secret_or_create_second_grant(self):
        case, token, handoff, command = self.issue()
        retry = self.internal(case, "issue", {**command, "tokenHash": digest("unused-new-token")})
        self.assertFalse(retry["tokenAccepted"])
        self.assertEqual(retry["handoff"]["id"], handoff["id"])
        self.assertEqual(self.db.execute("select count(*) from motorist_case_handoffs where case_id=%s", (case,)).fetchone()[0], 1)
        self.session(token)
        self.rejected("P0002", lambda: self.session(digest("unused-new-token")))
        receipt = self.db.execute("select payload from motorist_handoff_receipts where handoff_id=%s", (handoff["id"],)).fetchone()[0]
        self.assertNotIn("tokenHash", json.dumps(receipt))

    def test_04_snapshot_change_requires_new_preview_confirmation(self):
        case = self.new_case()
        preview = self.internal(case, "context")
        self.db.execute("update motorist_locations set address='Changed pickup' where id=(select pickup_location_id from motorist_cases where id=%s)", (case,))
        self.rejected("PT409", lambda: self.internal(case, "issue", {"commandId": str(uuid.uuid4()), "tokenHash": digest("new"), "recipientName": "Centre", "recipientPhone": "+421900000111", "previewVersion": preview["previewVersion"]}))
        self.assertEqual(self.db.execute("select count(*) from motorist_case_handoffs where case_id=%s", (case,)).fetchone()[0], 0)

    def test_05_internal_edits_do_not_publish_until_explicit_publish_and_old_accept_conflicts(self):
        case, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        self.db.execute("update motorist_locations set address='New public pickup' where id=(select pickup_location_id from motorist_cases where id=%s)", (case,))
        unchanged = self.public("read", session, {"handoffId": handoff["id"]})["handoff"]
        self.assertEqual(unchanged["published"]["pickup"]["address"], "Pickup address")
        context = self.internal(case, "context")
        updated = self.internal(case, "publish", self.private_command(handoff, previewVersion=context["previewVersion"], instructions="Updated instructions"))["handoff"]
        self.assertEqual(updated["publishedVersion"], 2)
        self.rejected("PT409", lambda: self.public("command", session, self.command(handoff, "accept")))
        self.assertEqual(self.public("read", session, {"handoffId": handoff["id"]})["handoff"]["published"]["pickup"]["address"], "New public pickup")

    def test_06_accept_and_retry_create_one_private_dispatcher_notice(self):
        case, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        command = self.command(handoff, "accept")
        first = self.public("command", session, command)
        retry = self.public("command", session, command)
        self.assertEqual(first, retry)
        self.assertEqual(first["handoff"]["status"], "accepted")
        rows = self.db.execute("select recipient_profile_id,visibility from motorist_notifications where case_id=%s and payload->>'source'='case_handoff'", (case,)).fetchall()
        self.assertEqual(rows, [(uuid.UUID(A), "private")])
        with self.client(actor=B) as client:
            self.assertEqual(client.execute("select count(*) from motorist_notifications where case_id=%s", (case,)).fetchone()[0], 0)
        self.rejected("PT409", lambda: self.public("command", session, {**command, "action": "reject", "comment": "Different intention"}))

    def test_07_reject_requires_reason_and_terminal_reply_redacts_case_details(self):
        _, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        self.rejected("22023", lambda: self.public("command", session, self.command(handoff, "reject", comment="")))
        result = self.public("command", session, self.command(handoff, "reject", comment="No available vehicle"))["handoff"]
        self.assertEqual(result["status"], "rejected")
        self.assertIsNone(result["published"])
        self.assertEqual(result["events"], [])
        self.rejected("PT409", lambda: self.public("command", session, self.command(result, "accept")))

    def test_08_only_whitelisted_progress_and_eta_never_modify_internal_case(self):
        case, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        handoff = self.public("command", session, self.command(handoff, "accept"))["handoff"]
        self.rejected("PT409", lambda: self.public("command", session, self.command(handoff, "complete")))
        self.rejected("22023", lambda: self.public("command", session, self.command(handoff, "update", eta="2000-01-01T00:00:00Z")))
        for action in ["en_route", "arrived", "complete"]:
            handoff = self.public("command", session, self.command(handoff, action, internalStatus="completed", arbitraryCasePatch={"price": 0}))["handoff"]
        self.assertEqual(handoff["status"], "completed")
        self.assertIsNone(handoff["published"])
        self.assertEqual(self.db.execute("select status,internal_note from motorist_cases where id=%s", (case,)).fetchone(), ("open", "PRIVATE_CASE_NOTE"))

    def test_09_renew_invalidates_old_token_and_all_old_sessions_without_resetting_progress(self):
        case, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        handoff = self.public("command", session, self.command(handoff, "accept"))["handoff"]
        replacement = digest("renew-" + uuid.uuid4().hex)
        renewed = self.internal(case, "renew", self.private_command(handoff, tokenHash=replacement, hours=12))["handoff"]
        self.assertEqual(renewed["status"], "accepted")
        self.rejected("P0002", lambda: self.session(token))
        self.rejected("P0002", lambda: self.public("read", session, {"handoffId": handoff["id"]}))
        self.assertEqual(self.session(replacement)[1]["status"], "accepted")

    def test_10_revoke_invalidates_every_public_read_and_command(self):
        case, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        self.internal(case, "revoke", self.private_command(handoff, comment="Changed partner"))
        self.rejected("P0002", lambda: self.session(token))
        self.rejected("P0002", lambda: self.public("read", session, {"handoffId": handoff["id"]}))
        self.rejected("P0002", lambda: self.public("command", session, self.command(handoff, "accept")))

    def test_11_expired_grant_session_or_inactive_org_denies_case_data(self):
        _, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        self.db.execute("update motorist_handoff_sessions set expires_at=clock_timestamp()-interval '1 second' where token_hash=%s", (session,))
        self.rejected("P0002", lambda: self.public("read", session, {"handoffId": handoff["id"]}))
        session, _ = self.session(token)
        self.db.execute("update motorist_organizations set active=false where id=%s", (ORG,))
        try:
            self.rejected("P0002", lambda: self.public("read", session, {"handoffId": handoff["id"]}))
            self.rejected("P0002", lambda: self.session(token))
        finally:
            self.db.execute("update motorist_organizations set active=true where id=%s", (ORG,))
        self.db.execute("update motorist_case_handoffs set expires_at=clock_timestamp()-interval '1 second' where id=%s", (handoff["id"],))
        self.rejected("P0002", lambda: self.public("read", session, {"handoffId": handoff["id"]}))

    def test_12_substituted_cross_tab_session_cannot_accept_another_displayed_case(self):
        _, token_a, a, _ = self.issue()
        _, token_b, b, _ = self.issue()
        _, a = self.session(token_a)
        session_b, b = self.session(token_b)
        self.assertEqual((a["revision"], a["publishedVersion"]), (b["revision"], b["publishedVersion"]))
        self.rejected("P0002", lambda: self.public("command", session_b, self.command(a, "accept")))
        self.assertEqual(self.public("read", session_b, {"handoffId": b["id"]})["handoff"]["status"], "offered")

    def test_13_current_read_does_not_silently_substitute_second_tab_case(self):
        _, token_a, a, _ = self.issue()
        _, token_b, b, _ = self.issue()
        session_b, b = self.session(token_b)
        self.rejected("P0002", lambda: self.public("read", session_b, {"handoffId": a["id"]}))

    def test_14_concurrent_accept_reject_has_one_decision_and_one_notice(self):
        case, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        with self.client("service_role", autocommit=False) as first, self.client("service_role", autocommit=False) as second:
            first_result = self.public("command", session, self.command(handoff, "accept"), conn=first)
            results = []
            command = self.command(handoff, "reject", comment="No vehicle")
            thread = threading.Thread(target=self.run_public, args=(second, "command", session, command, results))
            thread.start(); self.wait_for_lock(second.info.backend_pid); first.commit(); thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(results, ["PT409"])
            self.assertEqual(first_result["handoff"]["status"], "accepted")
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications where case_id=%s and payload->>'source'='case_handoff'", (case,)).fetchone()[0], 1)

    def test_15_concurrent_same_command_returns_one_receipt(self):
        _, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        command = self.command(handoff, "accept")
        with self.client("service_role", autocommit=False) as first, self.client("service_role", autocommit=False) as second:
            receipt = self.public("command", session, command, conn=first)
            results = []
            thread = threading.Thread(target=self.run_public, args=(second, "command", session, command, results))
            thread.start(); self.wait_for_lock(second.info.backend_pid); first.commit(); thread.join(5)
            self.assertFalse(thread.is_alive()); self.assertEqual(results, [receipt])

    def test_16_request_waiting_past_session_expiry_is_denied_after_handoff_lock(self):
        _, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        self.db.execute("update motorist_handoff_sessions set expires_at=clock_timestamp()+interval '600 milliseconds' where token_hash=%s", (session,))
        with psycopg.connect(dbname=self.name, **LOCAL) as lock, self.client("service_role", autocommit=False) as pending:
            lock.execute("select id from motorist_case_handoffs where id=%s for update", (handoff["id"],))
            results = []
            thread = threading.Thread(target=self.run_public, args=(pending, "read", session, {"handoffId": handoff["id"]}, results))
            thread.start(); self.wait_for_lock(pending.info.backend_pid)
            self.db.execute("select pg_sleep(0.8)")
            lock.commit(); thread.join(5)
            self.assertFalse(thread.is_alive()); self.assertEqual(results, ["P0002"])

    def test_17_request_waiting_past_grant_expiry_cannot_accept(self):
        _, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        self.db.execute("update motorist_case_handoffs set expires_at=clock_timestamp()+interval '600 milliseconds' where id=%s", (handoff["id"],))
        with psycopg.connect(dbname=self.name, **LOCAL) as lock, self.client("service_role", autocommit=False) as pending:
            lock.execute("select id from motorist_case_handoffs where id=%s for update", (handoff["id"],))
            results = []
            thread = threading.Thread(target=self.run_public, args=(pending, "command", session, self.command(handoff, "accept"), results))
            thread.start(); self.wait_for_lock(pending.info.backend_pid)
            self.db.execute("select pg_sleep(0.8)")
            lock.commit(); thread.join(5)
            self.assertFalse(thread.is_alive()); self.assertEqual(results, ["P0002"])

    def test_18_deleted_case_revokes_grants_sessions_and_receipts(self):
        case, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        self.db.execute("delete from motorist_cases where id=%s", (case,))
        self.rejected("P0002", lambda: self.session(token))
        self.rejected("P0002", lambda: self.public("read", session, {"handoffId": handoff["id"]}))
        self.assertEqual(self.db.execute("select count(*) from motorist_handoff_receipts where handoff_id=%s", (handoff["id"],)).fetchone()[0], 0)

    def test_19_private_foreign_contact_reference_cannot_expand_shared_data(self):
        case = self.new_case()
        other = self.new_case(OTHER_ORG)
        self.db.execute("update motorist_cases set contact_id=(select contact_id from motorist_cases where id=%s) where id=%s", (other, case))
        preview = self.internal(case, "context")["preview"]
        self.assertEqual(preview["contact"], {"name": "", "phone": ""})

    def test_20_secret_hashes_never_enter_public_dto_or_events_and_receipts(self):
        case, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        self.public("command", session, self.command(handoff, "accept"))
        view = json.dumps(self.internal(case, "context"))
        self.assertNotIn(token, view); self.assertNotIn(session, view)
        events = self.db.execute("select coalesce(jsonb_agg(to_jsonb(e)), '[]') from motorist_handoff_events e where handoff_id=%s", (handoff["id"],)).fetchone()[0]
        self.assertNotIn(token, json.dumps(events)); self.assertNotIn(session, json.dumps(events))

    def test_21_reason_with_only_newlines_is_rejected_at_database_boundary(self):
        _, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        self.rejected("22023", lambda: self.public("command", session, self.command(handoff, "reject", comment="\n\t\r")))

    def test_22_accept_waiting_behind_revoke_cannot_resurrect_grant(self):
        case, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        with self.client(autocommit=False) as first, self.client("service_role", autocommit=False) as second:
            self.internal(case, "revoke", self.private_command(handoff, comment="Partner cancelled"), conn=first)
            results = []
            thread = threading.Thread(target=self.run_public, args=(second, "command", session, self.command(handoff, "accept"), results))
            thread.start(); self.wait_for_lock(second.info.backend_pid); first.commit(); thread.join(5)
            self.assertFalse(thread.is_alive()); self.assertEqual(results, ["P0002"])
        self.assertEqual(self.db.execute("select status from motorist_case_handoffs where id=%s", (handoff["id"],)).fetchone()[0], "cancelled")
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications where case_id=%s and payload->>'source'='case_handoff'", (case,)).fetchone()[0], 0)

    def test_23_accept_waiting_behind_new_publication_requires_updated_confirmation(self):
        case, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        context = self.internal(case, "context")
        with self.client(autocommit=False) as first, self.client("service_role", autocommit=False) as second:
            self.internal(case, "publish", self.private_command(handoff, previewVersion=context["previewVersion"], instructions="A different entrance"), conn=first)
            results = []
            thread = threading.Thread(target=self.run_public, args=(second, "command", session, self.command(handoff, "accept"), results))
            thread.start(); self.wait_for_lock(second.info.backend_pid); first.commit(); thread.join(5)
            self.assertFalse(thread.is_alive()); self.assertEqual(results, ["PT409"])
        self.assertEqual(self.db.execute("select status,published_version from motorist_case_handoffs where id=%s", (handoff["id"],)).fetchone(), ("offered", 2))

    def test_24_notification_failure_rolls_back_decision_and_receipt_then_same_command_can_retry(self):
        case, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        command = self.command(handoff, "accept")
        self.db.execute("""create function pg_temp.reject_handoff_notice() returns trigger language plpgsql as $$ begin
        if new.payload->>'source'='case_handoff' then raise exception 'Fixture notification failure'; end if;
        return new; end $$;
        create trigger fixture_reject_handoff before insert on motorist_notifications for each row execute function pg_temp.reject_handoff_notice();""")
        try:
            self.rejected("P0001", lambda: self.public("command", session, command))
        finally:
            self.db.execute("drop trigger fixture_reject_handoff on motorist_notifications")
        loaded = self.public("read", session, {"handoffId": handoff["id"]})["handoff"]
        self.assertEqual((loaded["status"], loaded["revision"]), ("offered", 1))
        self.assertEqual(self.db.execute("select count(*) from motorist_handoff_events where handoff_id=%s and action='accept'", (handoff["id"],)).fetchone()[0], 0)
        result = self.public("command", session, command)
        self.assertEqual(result["handoff"]["status"], "accepted")
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications where case_id=%s and payload->>'source'='case_handoff'", (case,)).fetchone()[0], 1)

    def test_25_later_canonical_receipt_does_not_roll_back_current_progress(self):
        _, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        command = self.command(handoff, "accept")
        first = self.public("command", session, command)
        current = self.public("command", session, self.command(first["handoff"], "en_route"))["handoff"]
        replay = self.public("command", session, command)
        self.assertEqual(replay["handoff"], current)
        self.assertEqual(replay["committedRevision"], first["committedRevision"])

    def test_26_one_active_handoff_slot_and_explicit_new_recipient_after_revocation(self):
        case, token, handoff, _ = self.issue()
        self.rejected("PT409", lambda: self.issue(case))
        self.internal(case, "revoke", self.private_command(handoff, comment="New recipient requested"))
        _, replacement, new_handoff, _ = self.issue(case, recipientName="Other centre")
        self.assertNotEqual(new_handoff["id"], handoff["id"])
        self.rejected("P0002", lambda: self.session(token))
        self.assertEqual(self.session(replacement)[1]["recipientName"], "Other centre")

    def test_27_inactive_or_invited_internal_profile_cannot_issue_or_publish(self):
        case = self.new_case()
        _, _, handoff, issued = self.issue(case)
        for active, access in [(True, "invited"), (False, "active")]:
            self.db.execute("update motorist_profiles set active=%s,access_status=%s where id=%s", (active, access, A))
            try:
                self.rejected("42501", lambda: self.internal(case, "context"))
                self.rejected("42501", lambda: self.internal(case, "issue", {**issued, "commandId": str(uuid.uuid4())}))
                self.rejected("42501", lambda: self.internal(case, "publish", self.private_command(handoff, previewVersion=issued["previewVersion"])))
            finally:
                self.db.execute("update motorist_profiles set active=true,access_status='active' where id=%s", (A,))

    def test_28_comment_only_progress_update_preserves_existing_eta(self):
        _, token, handoff, _ = self.issue()
        session, handoff = self.session(token)
        handoff = self.public("command", session, self.command(handoff, "accept"))["handoff"]
        eta = self.db.execute("select clock_timestamp()+interval '30 minutes'").fetchone()[0].isoformat()
        handoff = self.public("command", session, self.command(handoff, "update", eta=eta))["handoff"]
        previous = handoff["eta"]
        updated = self.public("command", session, self.command(handoff, "update", comment="Vozidlo je pripravené."))["handoff"]
        self.assertEqual(updated["eta"], previous)

    def test_29_manual_addresses_are_shared_without_leaking_other_location_details(self):
        case = self.new_case()
        details = {"manualPickupAddress": "Ručne zadaný príjazd 12", "manualDestinationAddress": "Servis na rohu 24",
                   "internalNote": "PRIVATE_MANUAL_LOCATION_NOTE", "price": "PRIVATE_MANUAL_PRICE",
                   "metadata": {"secret": "PRIVATE_MANUAL_METADATA"}}
        self.db.execute("update motorist_cases set pickup_location_id=null,destination_location_id=null,location_details=%s::jsonb where id=%s", (json.dumps(details), case))
        _, token, handoff, _ = self.issue(case)
        _, public = self.session(token)
        self.assertEqual(public["published"]["pickup"], {"address": details["manualPickupAddress"], "lat": None, "lng": None})
        self.assertEqual(public["published"]["destination"], {"address": details["manualDestinationAddress"], "lat": None, "lng": None})
        self.assertNotIn("PRIVATE_", json.dumps(public))
        self.assertNotIn("location_details", json.dumps(public))

    def run_public(self, conn, action, token, command, results):
        try:
            results.append(self.public(action, token, command, conn=conn)); conn.commit()
        except psycopg.Error as error:
            results.append(error.sqlstate); conn.rollback()

    def wait_for_lock(self, pid):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            row = self.db.execute("select wait_event_type from pg_stat_activity where pid=%s", (pid,)).fetchone()
            if row and row[0] == "Lock":
                return
            time.sleep(.01)
        self.fail("No observed handoff row lock")


if __name__ == "__main__":
    unittest.main(verbosity=2)
