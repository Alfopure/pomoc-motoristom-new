"""Real trigger/PostgREST regression. Disposable loopback database only.

POSTGREST_BIN=.context/telephony-execution/bin/postgrest python3 tests/postgres/private-reminder-conflict-sqlstate.py
No application credentials, shared project or external notification delivery.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
import unittest

import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host="127.0.0.1", port=55432, user="postgres", autocommit=True)
MIGRATION = ROOT / "supabase/migrations/20260929210000_private_reminder_conflict_sqlstate.sql"
SOURCE = ROOT / "supabase/migrations/20260929130000_task_notification_privacy.sql"
ORG, TASK, REMINDER, PROFILE = [str(uuid4()) for _ in range(4)]
SIGNATURE = "app_private.motorist_validate_reminder_delivery()"


class PrivateReminderConflict(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        binary = os.environ.get("POSTGREST_BIN") or shutil.which("postgrest")
        if not binary:
            raise RuntimeError("POSTGREST_BIN is required; no HTTP regression may be skipped")
        cls.dbname = "reminder_conflict_" + uuid4().hex[:12]
        with psycopg.connect(dbname="postgres", **LOCAL) as admin:
            admin.execute("create database " + cls.dbname)
        cls.db = psycopg.connect(dbname=cls.dbname, **LOCAL)
        cls.addClassCleanup(cls.cleanup)
        cls.db.execute("""
          create schema app_private;
          create table motorist_case_tasks(id uuid primary key, organization_id uuid, status text,
            reminder_generation integer, reminder_at timestamptz, due_at timestamptz, assigned_to uuid);
          create table motorist_task_reminders(id uuid primary key, organization_id uuid, task_id uuid,
            status text, generation integer, payload jsonb, scheduled_for timestamptz,
            visibility text, recipient_profile_id uuid);
          create table motorist_profiles(id uuid primary key, organization_id uuid, active boolean, role text);
          create table motorist_notifications(id bigint generated always as identity primary key,
            organization_id uuid, task_id uuid, reminder_id uuid, recipient_profile_id uuid,
            visibility text, payload jsonb);
          alter table motorist_notifications enable row level security;
          create policy fixture_private_read on motorist_notifications for select to authenticated using (false);
          grant select on motorist_notifications to authenticated;
          grant select,insert on motorist_notifications to service_role;
          grant usage,select on sequence motorist_notifications_id_seq to service_role;
          create sequence test_reminder_http_attempts;
          create function test_reminder_http_attempt() returns void language sql security definer
            set search_path=public as $$ select nextval('test_reminder_http_attempts') $$;
        """)
        cls.original_sql = re.search(
            r"create or replace function app_private\.motorist_validate_reminder_delivery\(\).*?\$\$;",
            SOURCE.read_text(), re.S).group()
        cls.db.execute(cls.original_sql)
        cls.db.execute("revoke all on function " + SIGNATURE + " from public,anon,authenticated,service_role")
        cls.trigger_sql = "create trigger motorist_validate_reminder_delivery before insert on motorist_notifications for each row execute function " + SIGNATURE
        cls.db.execute(cls.trigger_sql)
        cls.original = cls.definition()
        cls.original_metadata = cls.metadata()
        assert cls.db.execute("select md5(pg_get_functiondef(%s::regprocedure))", (SIGNATURE,)).fetchone()[0] == "2e89c224a761d506da56da04f32896f8"
        cls.db.execute(MIGRATION.read_text())
        print("Local PostgreSQL:", cls.db.execute("show server_version").fetchone()[0], flush=True)
        print("Local HTTP:", subprocess.check_output([binary, "--version"], text=True).strip(), flush=True)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        cls.http_url = f"http://127.0.0.1:{port}"
        cls.temp = tempfile.TemporaryDirectory(prefix="reminder-postgrest-")
        config = Path(cls.temp.name) / "postgrest.conf"
        config.write_text(f'''db-uri = "postgresql://postgres@127.0.0.1:55432/{cls.dbname}"
db-schemas = "public"
db-anon-role = "service_role"
db-config = false
db-channel-enabled = false
db-pool = 2
db-pre-request = "public.test_reminder_http_attempt"
server-host = "127.0.0.1"
server-port = {port}
log-level = "crit"
''')
        cls.log = open(Path(cls.temp.name) / "postgrest.log", "w+")
        cls.process = subprocess.Popen([binary, str(config)], env={"PATH": os.environ.get("PATH", "")}, stdout=cls.log, stderr=cls.log)
        deadline = time.monotonic() + 15
        last_error = "No response"
        while time.monotonic() < deadline:
            try:
                probe = Request(cls.http_url + "/rpc/test_reminder_http_attempt", data=b"{}", headers={"Content-Type": "application/json"})
                with urlopen(probe, timeout=1) as response:
                    if response.status == 204:
                        return
            except (URLError, TimeoutError) as error:
                last_error = error.read().decode() if isinstance(error, HTTPError) else str(error)
                time.sleep(.05)
        cls.log.seek(0)
        raise RuntimeError("Local PostgREST readiness deadline exceeded: " + last_error + "\n" + cls.log.read())

    @classmethod
    def cleanup(cls):
        if hasattr(cls, "process"):
            cls.process.terminate()
            cls.process.wait(timeout=10)
        if hasattr(cls, "log"):
            cls.log.close()
        if hasattr(cls, "temp"):
            cls.temp.cleanup()
        cls.db.close()
        with psycopg.connect(dbname="postgres", **LOCAL) as admin:
            admin.execute("drop database " + cls.dbname)

    @classmethod
    def definition(cls):
        return cls.db.execute("select pg_get_functiondef(%s::regprocedure)", (SIGNATURE,)).fetchone()[0]

    @classmethod
    def metadata(cls):
        return cls.db.execute("""select p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig,
          t.oid,t.tgenabled,pg_get_triggerdef(t.oid),c.relrowsecurity,c.relacl,
          (select jsonb_agg(to_jsonb(policy)) from pg_policy policy where polrelid=c.oid)
          from pg_proc p join pg_trigger t on t.tgfoid=p.oid join pg_class c on c.oid=t.tgrelid
          where p.oid=%s::regprocedure""", (SIGNATURE,)).fetchone()

    def setUp(self):
        self.db.execute("truncate motorist_notifications,motorist_task_reminders,motorist_case_tasks,motorist_profiles restart identity")
        self.db.execute("insert into motorist_profiles values(%s,%s,true,'dispatcher')", (PROFILE, ORG))
        self.db.execute("insert into motorist_case_tasks values(%s,%s,'open',1,null,'2026-09-11T12:00:00Z',%s)", (TASK, ORG, PROFILE))
        self.db.execute("insert into motorist_task_reminders values(%s,%s,%s,'processing',1,'{\"source\":\"task_default_reminder\"}','2026-09-11T12:00:00Z','private',%s)", (REMINDER, ORG, TASK, PROFILE))
        self.payload = dict(organization_id=ORG, task_id=TASK, reminder_id=REMINDER,
                            recipient_profile_id=PROFILE, visibility="private", payload={"source": "task_reminder_runner"})

    def insert(self, db=None, **overrides):
        payload = self.payload | overrides
        return (db or self.db).execute("insert into motorist_notifications(organization_id,task_id,reminder_id,recipient_profile_id,visibility,payload) values(%s,%s,%s,%s,%s,%s)",
            (*[payload[key] for key in ("organization_id", "task_id", "reminder_id", "recipient_profile_id", "visibility")], Jsonb(payload["payload"])))

    def test_only_two_error_literals_change_and_all_authority_metadata_is_preserved(self):
        self.assertEqual(self.definition(), self.original.replace("'40001'", "'PT409'"))
        self.assertEqual(self.metadata(), self.original_metadata)
        self.db.execute(MIGRATION.read_text())
        self.assertEqual(self.metadata(), self.original_metadata)

    def test_missing_task_is_pt409_and_inserts_nothing(self):
        with self.assertRaises(psycopg.Error) as caught:
            self.insert(task_id=str(uuid4()))
        self.assertEqual(caught.exception.sqlstate, "PT409")
        self.assertIn("Stale reminder task", str(caught.exception))
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications").fetchone()[0], 0)

    def test_stale_generation_or_recipient_is_pt409_and_inserts_nothing(self):
        for change in [{"reminder_id": str(uuid4())}, {"recipient_profile_id": str(uuid4())}, {"visibility": "team"}]:
            with self.subTest(change=change), self.assertRaises(psycopg.Error) as caught:
                self.insert(**change)
            self.assertEqual(caught.exception.sqlstate, "PT409")
            self.assertIn("Stale reminder generation or recipient", str(caught.exception))
        self.db.execute("update motorist_case_tasks set reminder_generation=2")
        with self.assertRaises(psycopg.Error) as caught:
            self.insert()
        self.assertEqual(caught.exception.sqlstate, "PT409")
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications").fetchone()[0], 0)

    def test_current_reminder_and_unrelated_notifications_still_insert(self):
        self.insert()
        self.insert(task_id=str(uuid4()), reminder_id=None)
        self.insert(task_id=str(uuid4()), payload={"source": "unrelated"})
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications").fetchone()[0], 3)
        with self.db.transaction():
            self.db.execute("set local role authenticated")
            self.assertEqual(self.db.execute("select count(*) from motorist_notifications").fetchone()[0], 0)

    def test_completed_reassignment_before_shared_lock_rejects_stale_insert(self):
        with psycopg.connect(dbname=self.dbname, **LOCAL) as writer, psycopg.connect(dbname=self.dbname, **LOCAL) as reader:
            reader.execute("set statement_timeout='5s'")
            reader_pid = reader.execute("select pg_backend_pid()").fetchone()[0]
            with ThreadPoolExecutor(max_workers=1) as pool:
                with writer.transaction():
                    writer.execute("update motorist_case_tasks set reminder_generation=2")
                    future = pool.submit(self.insert, reader)
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if self.db.execute("select cardinality(pg_blocking_pids(%s))", (reader_pid,)).fetchone()[0]:
                            break
                        time.sleep(.02)
                    else:
                        self.fail("Insert did not retain the task row lock")
                with self.assertRaises(psycopg.Error) as caught:
                    future.result(timeout=5)
                self.assertEqual(caught.exception.sqlstate, "PT409")
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications").fetchone()[0], 0)

    def test_http_conflicts_finish_once_with_409_and_success_is_201(self):
        for changes, expected in [({"task_id": str(uuid4())}, 409), ({"reminder_id": str(uuid4())}, 409), ({}, 201)]:
            before = self.db.execute("select case when is_called then last_value else 0 end from test_reminder_http_attempts").fetchone()[0]
            request = Request(self.http_url + "/motorist_notifications", data=json.dumps(self.payload | changes).encode(),
                              headers={"Content-Type": "application/json", "Prefer": "return=representation"})
            try:
                with urlopen(request, timeout=5) as response:
                    status, body = response.status, json.load(response)
            except HTTPError as error:
                status, body = error.code, json.load(error)
            self.assertEqual(status, expected)
            if expected == 409:
                self.assertEqual(body["code"], "PT409")
            after = self.db.execute("select last_value from test_reminder_http_attempts").fetchone()[0]
            self.assertEqual(after - before, 1, "PostgREST must not retry a deterministic trigger conflict")
        self.assertEqual(self.db.execute("select count(*) from motorist_notifications").fetchone()[0], 1)

    def test_definition_drift_is_rejected_without_overwriting_it(self):
        drifted = self.definition().replace("'Stale reminder task'", "'Drifted reminder task'")
        try:
            self.db.execute(drifted)
            with self.assertRaises(psycopg.Error):
                self.db.execute(MIGRATION.read_text())
            self.db.execute("rollback")
            self.assertEqual(self.definition(), drifted)
        finally:
            self.db.execute(self.original.replace("'40001'", "'PT409'"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
