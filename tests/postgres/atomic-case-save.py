"""Run only against disposable local PostgreSQL, never using application credentials.
Usage: python3 tests/postgres/atomic-case-save.py
Requires local PostgreSQL at 127.0.0.1:55432 and psycopg 3.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from uuid import uuid4
import re
import unittest
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host="127.0.0.1", port=55432, user="postgres", autocommit=True)
ORG = "10000000-0000-0000-0000-000000000001"
ACTOR = "20000000-0000-0000-0000-000000000001"
CASE = "40000000-0000-0000-0000-000000000001"
CONTACT = "50000000-0000-0000-0000-000000000001"
VEHICLE = "60000000-0000-0000-0000-000000000001"
LOCATION = "70000000-0000-0000-0000-000000000001"
TABLES = ["motorist_contacts", "motorist_vehicles", "motorist_locations", "motorist_cases", "motorist_case_events", "motorist_audit_log"]

class AtomicCaseContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dbname = "atomic_case_contract_" + uuid4().hex[:10]
        with psycopg.connect(dbname="postgres", **LOCAL) as admin:
            admin.execute('create database ' + cls.dbname)
        cls.db = psycopg.connect(dbname=cls.dbname, **LOCAL)
        cls.db.execute((ROOT / "tests/postgres/notebook-fixture.sql").read_text())
        foundation = (ROOT / "supabase/migrations/20260520192000_foundation_schema.sql").read_text()
        for table in TABLES:
            cls.db.execute(re.search(r"create table public\." + table + r" \(.*?\n\);", foundation, re.S).group())
        cls.db.execute("alter table motorist_cases add column selected_asset_id uuid")
        cls.db.execute((ROOT / "supabase/migrations/20260601133000_extended_case_card.sql").read_text())
        cls.db.execute("alter table motorist_cases alter column source_type drop not null, alter column case_type drop not null")
        cls.db.execute(re.search(r"create or replace function public\.motorist_set_updated_at\(\).*?\$\$;", foundation, re.S).group())
        for table in ["motorist_contacts", "motorist_vehicles", "motorist_locations", "motorist_cases"]:
            cls.db.execute(f"create trigger original_updated_at before update on {table} for each row execute function motorist_set_updated_at()")
        cls.db.execute((ROOT / "supabase/migrations/20260929110000_atomic_case_save.sql").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        with psycopg.connect(dbname="postgres", **LOCAL) as admin:
            admin.execute('drop database ' + cls.dbname)

    def setUp(self):
        self.db.execute("truncate motorist_contacts, motorist_vehicles, motorist_locations, motorist_cases, motorist_case_events, motorist_audit_log cascade")
        self.db.execute("insert into motorist_contacts(id,organization_id,name,role) values(%s,%s,'Original','client')", (CONTACT, ORG))
        self.db.execute("insert into motorist_vehicles(id,organization_id,license_plate) values(%s,%s,'ORIGINAL')", (VEHICLE, ORG))
        self.db.execute("insert into motorist_locations(id,organization_id,label,address,lat,lng) values(%s,%s,'Original','Original',48,18)", (LOCATION, ORG))
        self.db.execute("insert into motorist_cases(id,organization_id,case_number,status,priority,contact_id,vehicle_id,pickup_location_id) values(%s,%s,'TEST','open','normal',%s,%s,%s)", (CASE, ORG, CONTACT, VEHICLE, LOCATION))
        self.token = self.db.execute("select updated_at from motorist_cases where id=%s", (CASE,)).fetchone()[0]
        self.patch = {"priority": "high", "contact_id": CONTACT, "vehicle_id": VEHICLE, "pickup_location_id": LOCATION, "destination_location_id": None, "customer_details": {"note": "updated"}}
        self.related = [
            {"table": "motorist_contacts", "id": CONTACT, "insert": False, "patch": {"name": "Updated"}},
            {"table": "motorist_vehicles", "id": VEHICLE, "insert": False, "patch": {"license_plate": "UPDATED"}},
            {"table": "motorist_locations", "id": LOCATION, "insert": False, "patch": {"address": "Updated", "lat": 49, "lng": 19}},
        ]

    def save(self, db=None, patch=None, related=None, token=None, actor=ACTOR):
        return (db or self.db).execute("select motorist_save_case_atomic(%s,%s,%s,%s,%s,%s,%s)", (ORG, actor, CASE, token or self.token, Jsonb(self.patch if patch is None else patch), Jsonb(self.related if related is None else related), Jsonb({"priorityLabels": {"high": "Vysoká"}}))).fetchone()[0]

    def snapshot(self):
        return {table: self.db.execute('select coalesce(jsonb_agg(to_jsonb(row) order by id),\'[]\') from ' + table + ' row').fetchone()[0] for table in TABLES}

    def test_success_related_case_activity_and_audit_share_commit(self):
        saved = self.save()
        self.assertNotEqual(saved["updated_at"], self.token.isoformat())
        self.assertEqual(self.db.execute("select name from motorist_contacts").fetchone()[0], "Updated")
        self.assertEqual(self.db.execute("select license_plate from motorist_vehicles").fetchone()[0], "UPDATED")
        self.assertEqual(self.db.execute("select address from motorist_locations").fetchone()[0], "Updated")
        self.assertEqual(self.db.execute("select count(*) from motorist_case_events where actor_profile_id=%s", (ACTOR,)).fetchone()[0], 2)
        self.assertEqual(self.db.execute("select count(*) from motorist_audit_log").fetchone()[0], 1)

    def test_insert_plan_is_atomic_and_keeps_new_relations(self):
        self.db.execute("update motorist_cases set contact_id=null,vehicle_id=null,pickup_location_id=null")
        self.token = self.db.execute("select updated_at from motorist_cases").fetchone()[0]
        ids = [str(uuid4()) for _ in range(3)]
        related = [
            {"table": "motorist_contacts", "id": ids[0], "insert": True, "patch": {"name": "New", "role": "client"}},
            {"table": "motorist_vehicles", "id": ids[1], "insert": True, "patch": {"license_plate": "NEW"}},
            {"table": "motorist_locations", "id": ids[2], "insert": True, "patch": {"label": "New", "address": "New", "lat": 48, "lng": 18}},
        ]
        patch = {**self.patch, "contact_id": ids[0], "vehicle_id": ids[1], "pickup_location_id": ids[2]}
        before = self.snapshot()
        with self.assertRaises(psycopg.errors.CheckViolation): self.save(patch={**patch,"status":"invalid"}, related=related)
        self.assertEqual(self.snapshot(), before)
        saved = self.save(patch=patch, related=related)
        self.assertEqual(saved["contact_id"], ids[0])
        for table in TABLES[:3]: self.assertEqual(self.db.execute(f"select count(*) from {table}").fetchone()[0], 2)

    def test_stale_related_revision_rejects_without_changing_case(self):
        old = self.db.execute("select updated_at from motorist_contacts").fetchone()[0]
        self.db.execute("update motorist_contacts set name='Someone else'")
        before = self.snapshot()
        related = [{**self.related[0], "expectedUpdatedAt": old.isoformat()}, *self.related[1:]]
        with self.assertRaises(psycopg.errors.SerializationFailure): self.save(related=related)
        self.assertEqual(self.snapshot(), before)

    def test_stale_token_writes_nothing(self):
        self.db.execute("update motorist_cases set priority='low' where id=%s", (CASE,))
        before = self.snapshot()
        with self.assertRaises(psycopg.errors.SerializationFailure): self.save()
        self.assertEqual(self.snapshot(), before)

    def test_final_audit_failure_rolls_back_all_relations_case_and_events(self):
        self.db.execute("create function test_fail_audit() returns trigger language plpgsql as $$ begin raise exception 'injected final write failure'; end $$")
        self.db.execute("create trigger test_fail before insert on motorist_audit_log for each row execute function test_fail_audit()")
        before = self.snapshot()
        try:
            with self.assertRaises(psycopg.errors.RaiseException): self.save()
            self.assertEqual(self.snapshot(), before)
        finally:
            self.db.execute("drop trigger test_fail on motorist_audit_log; drop function test_fail_audit()")

    def test_bad_case_value_rolls_back_earlier_related_updates(self):
        before = self.snapshot()
        with self.assertRaises(psycopg.errors.CheckViolation): self.save(patch={**self.patch, "status": "invalid"})
        self.assertEqual(self.snapshot(), before)

    def test_race_allows_only_one_writer_for_same_token(self):
        barrier = Barrier(2)
        def writer(priority):
            with psycopg.connect(dbname=self.dbname, **LOCAL) as db:
                barrier.wait()
                try:
                    self.save(db=db, patch={**self.patch, "priority": priority})
                    return "saved"
                except psycopg.errors.SerializationFailure:
                    return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(list(pool.map(writer, ["high", "urgent"])), ["saved", "conflict"])
        self.assertEqual(self.db.execute("select count(*) from motorist_audit_log").fetchone()[0], 1)

    def test_missing_token_and_wrong_actor_are_rejected(self):
        before = self.snapshot()
        with self.assertRaises(psycopg.errors.SerializationFailure):
            self.db.execute("select motorist_save_case_atomic(%s,%s,%s,null,'{}','[]','{}')", (ORG, ACTOR, CASE))
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.save(actor="20000000-0000-0000-0000-000000000004")
        self.assertEqual(self.snapshot(), before)

    def test_authenticated_role_cannot_call_service_role_rpc(self):
        self.db.execute("set role authenticated")
        try:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): self.save()
        finally: self.db.execute("reset role")

    def test_complete_then_reopen_clears_closure_timestamp(self):
        completed = self.save(patch={"status":"completed_assisted"}, related=[])
        self.assertIsNotNone(completed["closed_at"])
        self.assertIn("closedAt", completed["closure_details"])
        reopened = self.save(patch={"status":"open"}, related=[], token=completed["updated_at"])
        self.assertIsNone(reopened["closed_at"])
        self.assertNotIn("closedAt", reopened["closure_details"])

    def test_noop_does_not_advance_revision_or_add_activity(self):
        saved = self.save(patch={"priority": "normal"}, related=[])
        self.assertEqual(self.db.execute("select updated_at from motorist_cases").fetchone()[0], self.token)
        self.assertEqual(self.db.execute("select count(*) from motorist_case_events").fetchone()[0], 0)
        self.assertEqual(saved["priority"], "normal")

if __name__ == "__main__": unittest.main(verbosity=2)
