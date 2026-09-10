"""Disposable local PostgreSQL only: session CAS, invitation audit atomicity and default gate."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
import re
import unittest
import psycopg
from psycopg.types.json import Jsonb
ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host="127.0.0.1", port=55432, user="postgres", autocommit=True)
ORG = "10000000-0000-0000-0000-000000000001"
OWNER = "20000000-0000-0000-0000-000000000001"
RECIPIENT = "20000000-0000-0000-0000-000000000002"
SESSION = "40000000-0000-0000-0000-000000000001"
INVITE = "50000000-0000-0000-0000-000000000001"
class MonitorContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name = "monitor_contract_" + uuid4().hex[:10]
        with psycopg.connect(dbname="postgres", **LOCAL) as admin: admin.execute("create database " + cls.name)
        cls.db = psycopg.connect(dbname=cls.name, **LOCAL)
        cls.db.execute((ROOT / "tests/postgres/notebook-fixture.sql").read_text())
        foundation = (ROOT / "supabase/migrations/20260520192000_foundation_schema.sql").read_text()
        cls.db.execute(re.search(r"create table public\.motorist_audit_log \(.*?\n\);", foundation, re.S).group())
        cls.db.execute("create table motorist_telephony_settings(id uuid primary key default gen_random_uuid(),organization_id uuid)")
        cls.db.execute("create table motorist_call_sessions(id uuid primary key,organization_id uuid,version bigint default 0,metadata jsonb default '{}',ended_at timestamptz)")
        cls.db.execute((ROOT / "supabase/migrations/20260930130000_invited_call_monitors.sql").read_text())
    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        with psycopg.connect(dbname="postgres", **LOCAL) as admin: admin.execute("drop database " + cls.name)
    def setUp(self):
        self.db.execute("truncate motorist_call_sessions,motorist_audit_log,motorist_telephony_settings")
        self.db.execute("insert into motorist_call_sessions(id,organization_id) values(%s,%s)",(SESSION,ORG))
        self.item = dict(id=INVITE,sessionId=SESSION,inviterProfileId=OWNER,recipientProfileId=RECIPIENT,createdAt="2026-09-10T12:00:00Z",expiresAt="2026-09-10T12:02:00Z")
    def patch(self, db, item, version):
        return db.execute("update motorist_call_sessions set metadata=%s,version=version+1 where id=%s and version=%s returning version",(Jsonb(dict(monitorInvitations={INVITE:item},monitorInviteRecipients=[RECIPIENT],monitorInviteActors=[OWNER])),SESSION,version)).fetchone()
    def test_default_gate_and_atomic_audit(self):
        self.db.execute("insert into motorist_telephony_settings(organization_id) values(%s)",(ORG,))
        self.assertFalse(self.db.execute("select monitor_invites_enabled from motorist_telephony_settings").fetchone()[0])
        self.patch(self.db,self.item,0)
        self.patch(self.db,{**self.item,"acceptedAt":"2026-09-10T12:01:00Z"},1)
        self.patch(self.db,{**self.item,"acceptedAt":"2026-09-10T12:01:00Z","revokedAt":"2026-09-10T12:01:01Z"},2)
        self.assertEqual({row[0] for row in self.db.execute("select action from motorist_audit_log")},{"telephony.monitor.invite","telephony.monitor.accept","telephony.monitor.revoke"})
        self.assertEqual(self.db.execute("select count(*) from motorist_call_sessions where metadata @> %s",(Jsonb({"monitorInviteRecipients":[RECIPIENT]}),)).fetchone()[0],1)
    def test_audit_failure_rolls_back_acceptance(self):
        self.patch(self.db,self.item,0)
        self.db.execute("alter table motorist_audit_log add constraint injected_audit_failure check(action <> 'telephony.monitor.accept')")
        try:
            with self.assertRaises(psycopg.errors.CheckViolation): self.patch(self.db,{**self.item,"acceptedAt":"2026-09-10T12:01:00Z"},1)
            row=self.db.execute("select version,metadata from motorist_call_sessions").fetchone()
            self.assertEqual(row[0],1);self.assertNotIn("acceptedAt",row[1]["monitorInvitations"][INVITE])
        finally: self.db.execute("alter table motorist_audit_log drop constraint injected_audit_failure")
    def test_concurrent_accept_revoke_has_one_cas_winner_and_one_audit(self):
        self.patch(self.db,self.item,0);barrier=Barrier(2)
        def attempt(field):
            with psycopg.connect(dbname=self.name, **LOCAL) as db:
                barrier.wait();return self.patch(db,{**self.item,field:"2026-09-10T12:01:00Z"},1)
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(attempt,["acceptedAt","revokedAt"]))
        self.assertEqual(sum(result is not None for result in results),1)
        self.assertEqual(self.db.execute("select count(*) from motorist_audit_log").fetchone()[0],2)
    def test_call_end_invalidates_inbox_and_audits(self):
        self.patch(self.db,self.item,0);self.patch(self.db,{**self.item,"acceptedAt":"2026-09-10T12:01:00Z"},1)
        self.db.execute("update motorist_call_sessions set ended_at=now(),version=version+1 where id=%s",(SESSION,))
        self.assertEqual(self.db.execute("select count(*) from motorist_call_sessions where ended_at is null").fetchone()[0],0)
        self.assertEqual(self.db.execute("select count(*) from motorist_audit_log where action='telephony.monitor.call_ended'").fetchone()[0],1)
        self.assertIsNone(self.patch(self.db,{**self.item,"acceptedAt":"2026-09-10T12:01:00Z"},2))
if __name__ == "__main__": unittest.main(verbosity=2)
