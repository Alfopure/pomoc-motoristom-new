"""Draft-preview SQL contracts in a unique disposable loopback PostgreSQL database.

Run with: python3 tests/postgres/case-draft-preview.py
Requires psycopg and a local PostgreSQL server at 127.0.0.1:55432. This fixture
never loads application environment files or connects to a hosted database.
"""

import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from queue import Queue
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb


ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host="127.0.0.1", hostaddr="127.0.0.1", port=55432,
             user="postgres", password="local-fixture-only", passfile="/dev/null", connect_timeout=3)
ORG, OTHER_ORG, AUTHOR, READER, OUTSIDER, USER, CASE = (
    str(UUID(int=value)) for value in range(1, 8)
)
PREVIEW = {"version": 1, "fields": {"contacts": "Local fixture customer"}}
RPC_SIGNATURE = "public.motorist_case_draft_preview(uuid,uuid,uuid,text,jsonb)"

# The collaboration migration needs these relations and a tiny Realtime stub.
# Its actual functions, locks, triggers and access checks are always installed.
FIXTURE = """
create schema app_private;
create schema auth;
create schema realtime;
create function auth.uid() returns uuid language sql stable as
  $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table realtime.messages(id bigserial,topic text,extension text default 'broadcast',event text,payload jsonb);
alter table realtime.messages enable row level security;
grant usage on schema realtime,auth,public to authenticated,anon,service_role;
grant select on realtime.messages to authenticated;
create function realtime.topic() returns text language sql stable as
  $$select current_setting('realtime.topic',true)$$;
create function realtime.send(p jsonb,e text,t text,private boolean) returns void language sql as
  $$insert into realtime.messages(topic,event,payload) values(t,e,p)$$;
create table motorist_organizations(id uuid primary key,active boolean default true);
create table motorist_profiles(id uuid primary key,organization_id uuid references motorist_organizations,
  user_id uuid,display_name text,role text,active boolean default true,access_status text default 'active');
grant select on motorist_profiles,motorist_organizations to authenticated;
create table motorist_contacts(id uuid primary key,organization_id uuid,name text);
create table motorist_vehicles(id uuid primary key,organization_id uuid,name text);
create table motorist_locations(id uuid primary key,organization_id uuid,name text);
create table motorist_cases(id uuid primary key,organization_id uuid,owner_id uuid,
  contact_id uuid,vehicle_id uuid,pickup_location_id uuid,destination_location_id uuid);
create table motorist_case_events(id uuid primary key,organization_id uuid,case_id uuid,body text,
  actor_profile_id uuid,created_at timestamptz default now());
create table motorist_location_submissions(id uuid primary key,organization_id uuid,case_id uuid,
  location_id uuid,accepted boolean default true,submitted_at timestamptz default now());
create table motorist_case_tasks(id uuid primary key,organization_id uuid,case_id uuid,title text);
create table motorist_task_messages(id uuid primary key,organization_id uuid,task_id uuid,body text);
create table motorist_task_case_links(id uuid primary key,organization_id uuid,task_id uuid,case_id uuid);
create table motorist_notifications(id uuid primary key,organization_id uuid,recipient_profile_id uuid,
  visibility text,body text);
create table motorist_notes(id uuid primary key,organization_id uuid,owner_profile_id uuid,body text);
create table motorist_note_shares(note_id uuid references motorist_notes on delete cascade,
  organization_id uuid,recipient_profile_id uuid);
"""


class DraftPreviewContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dbname = "draft_preview_contract_" + uuid4().hex
        cls.admin = psycopg.connect(dbname="postgres", autocommit=True, **LOCAL)
        cls.addClassCleanup(cls.admin.close)
        cls.admin.execute(sql.SQL("create database {} encoding 'UTF8' template template0").format(sql.Identifier(cls.dbname)))
        cls.addClassCleanup(lambda: cls.admin.execute(
            sql.SQL("drop database {} with (force)").format(sql.Identifier(cls.dbname))))
        cls.db = psycopg.connect(dbname=cls.dbname, autocommit=True, **LOCAL)
        cls.addClassCleanup(cls.db.close)
        for role in ("anon", "authenticated", "service_role"):
            if not cls.admin.execute("select 1 from pg_roles where rolname=%s", (role,)).fetchone():
                cls.admin.execute(sql.SQL("create role {}").format(sql.Identifier(role)))
        cls.db.execute(FIXTURE)
        for migration in ("20261006120000_case_collaboration.sql", "20261007110000_case_draft_preview.sql"):
            cls.db.execute((ROOT / "supabase/migrations" / migration).read_text())
        cls.db.execute("insert into motorist_organizations(id) values(%s),(%s)", (ORG, OTHER_ORG))
        for profile, organization, name in ((AUTHOR, ORG, "Jana"), (READER, ORG, "Peter"),
                                             (OUTSIDER, OTHER_ORG, "Outsider")):
            cls.db.execute("""insert into motorist_profiles(id,organization_id,user_id,display_name,role)
                              values(%s,%s,%s,%s,'dispatcher')""",
                           (profile, organization, USER if profile == AUTHOR else str(uuid4()), name))
        cls.db.execute("insert into motorist_cases(id,organization_id,owner_id) values(%s,%s,%s)",
                       (CASE, ORG, AUTHOR))

    def setUp(self):
        self.db.execute("reset role")
        self.db.execute("truncate motorist_case_editor_sessions cascade")
        self.db.execute("update motorist_organizations set active=true")
        self.db.execute("update motorist_profiles set active=true,access_status='active',role='dispatcher'")
        self.session = str(uuid4())
        self.collaboration("heartbeat", {"sessionId": self.session})
        self.db.execute("truncate realtime.messages")

    def collaboration(self, action, body, connection=None, actor=AUTHOR, organization=ORG):
        return (connection or self.db).execute(
            "select motorist_case_collaboration(%s,%s,%s,%s)",
            (organization, actor, action, Jsonb(body))).fetchone()[0]

    def preview(self, action="read", body=None, *, connection=None, session=None,
                actor=AUTHOR, organization=ORG):
        return (connection or self.db).execute(
            "select motorist_case_draft_preview(%s,%s,%s,%s,%s)",
            (organization, actor, session or self.session, action,
             Jsonb({} if body is None else body))).fetchone()[0]

    def publish(self, sequence=1, value=None, **kwargs):
        return self.preview("publish", {"sequence": sequence, "preview": PREVIEW if value is None else value}, **kwargs)

    def expect_state(self, state, call):
        with self.assertRaises(psycopg.Error) as raised:
            call()
        self.assertEqual(raised.exception.sqlstate, state)

    def sidecar_count(self, session=None):
        return self.db.execute("select count(*) from motorist_case_draft_previews where session_id=%s",
                               (session or self.session,)).fetchone()[0]

    def expire(self, session=None):
        self.db.execute("""update motorist_case_editor_sessions
                           set expires_at=clock_timestamp()-interval '1 second' where id=%s""",
                        (session or self.session,))

    def test_empty_preview_and_current_author_display_name(self):
        result = self.preview(actor=READER)
        self.assertEqual(set(result), {"available", "preview", "sequence", "updatedAt", "expiresAt", "displayName"})
        self.assertIs(result["available"], True)
        self.assertIsNone(result["preview"])
        self.assertEqual(result["sequence"], 0)
        self.assertIsNone(result["updatedAt"])
        self.assertEqual(result["displayName"], "Jana")
        datetime.fromisoformat(result["expiresAt"].replace("Z", "+00:00"))
        self.db.execute("update motorist_profiles set display_name='Author renamed' where id=%s", (AUTHOR,))
        try:
            self.assertEqual(self.preview(actor=READER)["displayName"], "Author renamed")
        finally:
            self.db.execute("update motorist_profiles set display_name='Jana' where id=%s", (AUTHOR,))

    def test_monotonic_sequences_and_heartbeat_preserve_preview_without_broadcast(self):
        self.publish(2)
        accepted = self.preview(actor=READER)
        self.assertEqual(accepted["preview"], PREVIEW)
        self.assertEqual(accepted["sequence"], 2)
        self.assertIsNotNone(accepted["updatedAt"])
        different = {"version": 1, "fields": {"contacts": "Old request"}}
        for sequence in (1, 2):
            self.publish(sequence, different)
            self.assertEqual(self.preview(actor=READER), accepted)
        self.collaboration("heartbeat", {"sessionId": self.session})
        renewed = self.preview(actor=READER)
        self.assertEqual(renewed["preview"], PREVIEW)
        self.assertEqual(renewed["updatedAt"], accepted["updatedAt"])
        self.publish(3, different)
        self.assertEqual(self.preview(actor=READER)["preview"], different)
        self.assertEqual(self.db.execute("select count(*) from realtime.messages").fetchone()[0], 0)

    def test_only_owner_publishes_and_cross_organization_access_is_rejected(self):
        self.publish()
        self.expect_state("42501", lambda: self.publish(2, actor=READER))
        self.expect_state("42501", lambda: self.preview(actor=OUTSIDER))
        self.expect_state("42501", lambda: self.preview(actor=AUTHOR, organization=OTHER_ORG))
        self.expect_state("42501", lambda: self.preview(actor=OUTSIDER, organization=OTHER_ORG))
        self.expect_state("42501", lambda: self.publish(2, actor=OUTSIDER, organization=OTHER_ORG))
        self.assertEqual(self.preview()["sequence"], 1)

    def test_collaboration_roles_and_current_reader_access_are_enforced(self):
        self.publish()
        for role in ("dispatcher", "senior_dispatcher", "manager", "admin"):
            with self.subTest(role=role):
                self.db.execute("update motorist_profiles set role=%s where id=%s", (role, READER))
                self.assertEqual(self.preview(actor=READER)["preview"], PREVIEW)
        for patch in ("role='driver'", "active=false", "access_status='revoked'"):
            with self.subTest(patch=patch):
                self.db.execute("update motorist_profiles set role='dispatcher',active=true,access_status='active' where id=%s", (READER,))
                self.db.execute("update motorist_profiles set " + patch + " where id=%s", (READER,))
                self.expect_state("42501", lambda: self.preview(actor=READER))
        self.db.execute("update motorist_organizations set active=false where id=%s", (ORG,))
        self.expect_state("42501", lambda: self.preview())
        self.expect_state("42501", lambda: self.publish(2))

    def test_author_revocation_hides_previously_published_content(self):
        self.publish()
        for patch in ("active=false", "access_status='revoked'", "role='driver'"):
            with self.subTest(patch=patch):
                self.db.execute("update motorist_profiles set active=true,access_status='active',role='dispatcher' where id=%s", (AUTHOR,))
                self.db.execute("update motorist_profiles set " + patch + " where id=%s", (AUTHOR,))
                self.expect_state("P0002", lambda: self.preview(actor=READER))
                self.expect_state("42501", lambda: self.publish(2))

    def test_missing_expired_and_case_sessions_have_no_preview(self):
        self.expect_state("P0002", lambda: self.preview(session=str(uuid4())))
        self.expect_state("P0002", lambda: self.publish(session=str(uuid4())))
        self.publish()
        self.expire()
        self.expect_state("P0002", lambda: self.preview(actor=READER))
        self.expect_state("P0002", lambda: self.publish(2))
        case_session = str(uuid4())
        self.collaboration("heartbeat", {"sessionId": case_session, "caseId": CASE})
        self.expect_state("P0002", lambda: self.preview(session=case_session))
        self.expect_state("P0002", lambda: self.publish(session=case_session))

    def test_expired_lease_heartbeat_cannot_revive_old_preview(self):
        self.publish(9)
        self.expire()
        self.collaboration("heartbeat", {"sessionId": self.session})
        result = self.preview(actor=READER)
        self.assertIsNone(result["preview"])
        self.assertEqual(result["sequence"], 0)
        self.assertEqual(self.sidecar_count(), 0)
        self.publish(10)
        self.assertEqual(self.preview()["sequence"], 10)

    def test_leave_commit_and_delete_clear_preview_and_reject_late_writes(self):
        for action in ("leave", "commit"):
            with self.subTest(action=action):
                session = str(uuid4())
                self.collaboration("heartbeat", {"sessionId": session})
                self.publish(session=session)
                body = {"sessionId": session}
                if action == "commit":
                    body["caseId"] = CASE
                self.collaboration(action, body)
                self.assertEqual(self.sidecar_count(session), 0)
                self.expect_state("P0002", lambda: self.preview(session=session))
                self.expect_state("P0002", lambda: self.publish(2, session=session))
                self.assertIs(self.collaboration("heartbeat", {"sessionId": session})["ended"], True)
                self.assertEqual(self.sidecar_count(session), 0)
        self.publish()
        self.db.execute("delete from motorist_case_editor_sessions where id=%s", (self.session,))
        self.assertEqual(self.sidecar_count(), 0)

    def test_service_rpc_permissions_and_authenticated_identity_forgery(self):
        self.publish()
        self.assertTrue(self.db.execute("select relrowsecurity from pg_class where oid='motorist_case_draft_previews'::regclass").fetchone()[0])
        self.assertTrue(self.db.execute("select has_function_privilege('service_role',%s,'execute')", (RPC_SIGNATURE,)).fetchone()[0])
        for role in ("anon", "authenticated"):
            with self.subTest(role=role):
                self.assertFalse(self.db.execute("select has_function_privilege(%s,%s,'execute')", (role, RPC_SIGNATURE)).fetchone()[0])
                self.db.execute(sql.SQL("set role {}").format(sql.Identifier(role)))
                try:
                    self.db.execute("select set_config('request.jwt.claim.sub',%s,false)", (USER,))
                    self.expect_state("42501", lambda: self.preview(actor=AUTHOR))
                    self.expect_state("42501", lambda: self.publish(2, actor=AUTHOR))
                    self.expect_state("42501", lambda: self.db.execute("select * from motorist_case_draft_previews"))
                    self.expect_state("42501", lambda: self.db.execute("delete from motorist_case_draft_previews"))
                    self.expect_state("42501", lambda: self.db.execute("update motorist_case_draft_previews set sequence=999"))
                    self.expect_state("42501", lambda: self.db.execute("insert into motorist_case_draft_previews(session_id,sequence,preview) values(%s,999,%s)", (self.session, Jsonb(PREVIEW))))
                finally:
                    self.db.execute("reset role")
        self.db.execute("set role service_role")
        try:
            self.assertEqual(self.preview(actor=READER)["preview"], PREVIEW)
            self.publish(2)
            self.assertEqual(self.preview()["sequence"], 2)
        finally:
            self.db.execute("reset role")

    def test_invalid_publish_payload_cannot_change_existing_preview(self):
        self.publish()
        before = self.preview()
        for sequence in (0, -1, 1.5, None, "2", True, [], {}, 9007199254740992, 10**100):
            with self.subTest(sequence=sequence):
                self.expect_state("22023", lambda: self.publish(sequence))
        oversized_fields = dict.fromkeys(("jobTypes", "priority", "sourceType", "incidentType", "participants",
                                          "passengers", "note", "customerType", "contacts", "companyName",
                                          "companyIdNumber", "assistance", "customerNote"), "x" * 4000)
        for value in (None, [], {}, {"version": 2, "fields": {}}, {"version": 1, "fields": []},
                      {"version": 1, "fields": {"contacts": None}},
                      {"version": 1, "fields": {"untrustedField": "Hidden property"}},
                      {"version": 1, "fields": {"contacts": "x" * 4001}},
                      {"version": 1, "fields": oversized_fields},
                      {"version": 1, "fields": {}, "unexpected": "Hidden property"}):
            with self.subTest(preview=value):
                self.expect_state("22023", lambda: self.preview("publish", {"sequence": 2, "preview": value}))
        for body in ([], {}, {"sequence": 2, "preview": PREVIEW, "unexpected": True}):
            with self.subTest(body=body):
                self.expect_state("22023", lambda: self.preview("publish", body))
        self.expect_state("22023", lambda: self.preview("delete"))
        self.assertEqual(self.preview(), before)

    def test_preview_publication_rolls_back_with_its_transaction(self):
        self.publish()
        before = self.preview()
        with psycopg.connect(dbname=self.dbname, **LOCAL) as writer:
            writer.execute("set role service_role")
            self.publish(2, {"version": 1, "fields": {"contacts": "Rolled back"}}, connection=writer)
            writer.rollback()
        self.assertEqual(self.preview(actor=READER), before)

    def test_expired_cleanup_is_bounded_and_organization_scoped(self):
        # Expiry is deliberately recent, within collaboration's one-day retention.
        self.db.execute("""insert into motorist_case_editor_sessions(id,organization_id,profile_id,expires_at)
                           select gen_random_uuid(),%s,%s,clock_timestamp()-interval '2 minutes'
                           from generate_series(1,125)""", (ORG, AUTHOR))
        foreign_session = str(uuid4())
        self.db.execute("""insert into motorist_case_editor_sessions(id,organization_id,profile_id,expires_at)
                           values(%s,%s,%s,clock_timestamp()-interval '2 minutes')""",
                        (foreign_session, OTHER_ORG, OUTSIDER))
        self.db.execute("""insert into motorist_case_draft_previews(session_id,sequence,preview)
                           select id,1,%s from motorist_case_editor_sessions where expires_at<clock_timestamp()""",
                        (Jsonb(PREVIEW),))
        self.publish()
        remaining = self.db.execute("""select count(*) from motorist_case_draft_previews p
                                       join motorist_case_editor_sessions s on s.id=p.session_id
                                       where s.organization_id=%s and s.expires_at<clock_timestamp()""", (ORG,)).fetchone()[0]
        self.assertGreater(remaining, 0, "A single RPC must bound expired-row cleanup")
        self.assertLess(remaining, 125, "A successful RPC should clean up expired preview data")
        self.assertEqual(self.sidecar_count(foreign_session), 1)
        for _ in range(5):
            self.preview()
        self.assertEqual(self.db.execute("""select count(*) from motorist_case_draft_previews p
                                          join motorist_case_editor_sessions s on s.id=p.session_id
                                          where s.organization_id=%s and s.expires_at<clock_timestamp()""", (ORG,)).fetchone()[0], 0)
        self.assertEqual(self.sidecar_count(), 1)
        self.assertEqual(self.sidecar_count(foreign_session), 1)

    def wait_for_lock(self, pid):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            row = self.db.execute("select wait_event_type from pg_stat_activity where pid=%s", (pid,)).fetchone()
            if row and row[0] == "Lock":
                return
            time.sleep(0.01)
        self.fail("Competing RPC did not wait on the locked editor session")

    def test_publish_and_commit_serialize_in_both_orders(self):
        for first in ("publish", "commit"):
            with self.subTest(first=first):
                session = str(uuid4())
                self.collaboration("heartbeat", {"sessionId": session})
                self.publish(session=session)
                started = Queue()

                def competing_writer():
                    with psycopg.connect(dbname=self.dbname, **LOCAL) as contender:
                        contender.execute("set role service_role")
                        contender.execute("set statement_timeout='8s'")
                        started.put(contender.info.backend_pid)
                        try:
                            if first == "publish":
                                self.collaboration("commit", {"sessionId": session, "caseId": CASE}, connection=contender)
                            else:
                                self.publish(3, session=session, connection=contender)
                            contender.commit()
                            return "ok"
                        except psycopg.Error as error:
                            contender.rollback()
                            return error.sqlstate

                with psycopg.connect(dbname=self.dbname, **LOCAL) as holder:
                    holder.execute("set role service_role")
                    if first == "publish":
                        self.publish(2, session=session, connection=holder)
                    else:
                        self.collaboration("commit", {"sessionId": session, "caseId": CASE}, connection=holder)
                    with ThreadPoolExecutor(max_workers=1) as pool:
                        pending = pool.submit(competing_writer)
                        try:
                            self.wait_for_lock(started.get(timeout=5))
                        finally:
                            holder.commit()
                        self.assertEqual(pending.result(timeout=10), "ok" if first == "publish" else "P0002")
                self.assertEqual(self.sidecar_count(session), 0)
                self.expect_state("P0002", lambda: self.publish(4, session=session))

    def test_revocation_while_waiting_for_session_lock_denies_final_result(self):
        self.publish()
        for action, revoked in (("read", "viewer"), ("read", "author"),
                                ("read", "organization"), ("publish", "author")):
            with self.subTest(action=action, revoked=revoked):
                self.db.execute("update motorist_profiles set active=true,access_status='active',role='dispatcher'")
                self.db.execute("update motorist_organizations set active=true")
                started = Queue()

                def blocked_request():
                    with psycopg.connect(dbname=self.dbname, **LOCAL) as contender:
                        contender.execute("set role service_role")
                        contender.execute("set statement_timeout='8s'")
                        started.put(contender.info.backend_pid)
                        try:
                            if action == "publish":
                                result = self.publish(2, connection=contender)
                            else:
                                result = self.preview(actor=READER, connection=contender)
                            contender.commit()
                            return result
                        except psycopg.Error as error:
                            contender.rollback()
                            return error.sqlstate

                with psycopg.connect(dbname=self.dbname, **LOCAL) as blocker:
                    blocker.execute("select id from motorist_case_editor_sessions where id=%s for update", (self.session,))
                    with ThreadPoolExecutor(max_workers=1) as pool:
                        pending = pool.submit(blocked_request)
                        try:
                            self.wait_for_lock(started.get(timeout=5))
                            if revoked == "organization":
                                self.db.execute("update motorist_organizations set active=false where id=%s", (ORG,))
                            else:
                                self.db.execute("update motorist_profiles set access_status='revoked' where id=%s",
                                                (READER if revoked == "viewer" else AUTHOR,))
                        finally:
                            blocker.commit()
                        expected = "P0002" if action == "read" and revoked == "author" else "42501"
                        self.assertEqual(pending.result(timeout=10), expected)
                self.assertEqual(self.db.execute("select sequence from motorist_case_draft_previews where session_id=%s",
                                                 (self.session,)).fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
