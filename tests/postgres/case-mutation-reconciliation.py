"""Disposable local PostgreSQL contracts for saved mutation receipts; no application credentials."""
import importlib.util
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4
import unittest
import psycopg
from psycopg.types.json import Jsonb
from pathlib import Path
spec = importlib.util.spec_from_file_location("atomic", Path(__file__).with_name("atomic-case-save.py"))
atomic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(atomic)

class MutationReceipts(atomic.AtomicCaseContract):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.db.execute((atomic.ROOT / "supabase/migrations/20260929180000_case_mutation_reconciliation.sql").read_text())

    def setUp(self):
        super().setUp()
        self.db.execute("truncate motorist_case_mutation_results")
        self.key = str(uuid4())
        self.fingerprint = "a" * 64

    def reconcile_save(self, db=None, fingerprint=None, patch=None):
        return (db or self.db).execute("select motorist_save_case_atomic(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (atomic.ORG, atomic.ACTOR, atomic.CASE, self.token, Jsonb(self.patch if patch is None else patch), Jsonb(self.related), Jsonb({}), self.key, fingerprint or self.fingerprint)).fetchone()[0]

    def receipt(self, actor=atomic.ACTOR, case=atomic.CASE, fingerprint=None):
        return self.db.execute("select motorist_case_mutation_result(%s,%s,%s,%s,%s)",
            (atomic.ORG, actor, case, self.key, fingerprint or self.fingerprint)).fetchone()[0]

    def test_lost_response_replays_exact_result_after_a_later_foreign_edit(self):
        saved = self.reconcile_save()
        self.db.execute("update motorist_cases set priority='urgent'")
        before = self.snapshot()
        self.assertEqual(self.reconcile_save(), saved)
        self.assertEqual(self.receipt(), saved)
        self.assertEqual(self.snapshot(), before)

    def test_same_key_different_payload_or_case_is_terminal(self):
        self.reconcile_save()
        before = self.snapshot()
        for run in [lambda: self.reconcile_save(fingerprint="b"*64), lambda: self.receipt(case=str(uuid4()))]:
            with self.assertRaises(psycopg.Error) as caught: run()
            self.assertEqual(caught.exception.sqlstate, "PT422")
        self.assertEqual(self.snapshot(), before)

    def test_concurrent_duplicate_commits_once_and_returns_identical_receipts(self):
        barrier = Barrier(2)
        def writer(_):
            with psycopg.connect(dbname=self.dbname, **atomic.LOCAL) as db:
                barrier.wait()
                return self.reconcile_save(db)
        with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(writer, [1, 2]))
        self.assertEqual(results[0], results[1])
        self.assertEqual(self.db.execute("select count(*) from motorist_audit_log").fetchone()[0], 1)
        self.assertEqual(self.db.execute("select count(*) from motorist_case_mutation_results").fetchone()[0], 1)

    def test_failed_save_leaves_no_receipt_and_can_be_retried(self):
        with self.assertRaises(psycopg.errors.CheckViolation): self.reconcile_save(patch={**self.patch,"status":"invalid"})
        self.assertIsNone(self.receipt())
        self.assertIsNotNone(self.reconcile_save())

    def test_receipt_failure_rolls_back_the_entire_case_transaction(self):
        before = self.snapshot()
        self.db.execute("create function reject_receipt() returns trigger language plpgsql as $$ begin raise exception 'receipt failure'; end $$")
        self.db.execute("create trigger reject_receipt before insert on motorist_case_mutation_results for each row execute function reject_receipt()")
        try:
            with self.assertRaises(psycopg.errors.RaiseException): self.reconcile_save()
            self.assertEqual(self.snapshot(), before)
            self.assertIsNone(self.receipt())
        finally:
            self.db.execute("drop trigger reject_receipt on motorist_case_mutation_results; drop function reject_receipt()")

    def test_replay_requires_current_membership(self):
        self.reconcile_save()
        self.db.execute("update motorist_profiles set active=false where id=%s", (atomic.ACTOR,))
        try:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): self.receipt()
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): self.reconcile_save()
        finally: self.db.execute("update motorist_profiles set active=true where id=%s", (atomic.ACTOR,))

    def test_authenticated_cannot_read_receipts_or_call_overload(self):
        self.reconcile_save()
        self.db.execute("set role authenticated")
        try:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): self.receipt()
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): self.reconcile_save()
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): self.db.execute("select * from motorist_case_mutation_results")
        finally: self.db.execute("reset role")

if __name__ == "__main__": unittest.main(verbosity=2)
