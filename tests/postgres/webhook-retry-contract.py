"""Real P1 SQL concurrency and legacy-writer contract; disposable loopback only."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from uuid import uuid4
import re
import unittest
import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host="127.0.0.1", hostaddr="127.0.0.1", port=55432, user="postgres", autocommit=True, row_factory=dict_row)
ORG = "10000000-0000-0000-0000-000000000001"


class WebhookRetryContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name = "webhook_retry_" + uuid4().hex[:10]
        with psycopg.connect(dbname="postgres", **LOCAL) as db:
            db.execute("create database " + cls.name)
        cls.db = psycopg.connect(dbname=cls.name, **LOCAL)
        cls.db.execute("create table public.motorist_organizations(id uuid primary key)")
        cls.db.execute("insert into motorist_organizations values(%s)", (ORG,))
        cls.db.execute("""do $$ begin
          if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
          if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
          if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
        end $$""")
        foundation = (ROOT / "supabase/migrations/20260903100000_telnyx_telephony_foundation.sql").read_text()
        cls.db.execute(re.search(r"create table if not exists public\.motorist_telnyx_webhook_events \(.*?\n\);", foundation, re.S).group())
        legacy = (ROOT / "supabase/migrations/20260916100000_telnyx_fixes_round1.sql").read_text()
        cls.db.execute(re.search(r"create or replace function public\.motorist_telnyx_claim_webhook_event\(.*?\$\$;", legacy, re.S).group())
        cls.db.execute("grant select,insert,update,delete on motorist_telnyx_webhook_events to service_role")
        cls.db.execute((ROOT / "supabase/migrations/20260929190000_webhook_retry_contract.sql").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        with psycopg.connect(dbname="postgres", **LOCAL) as db:
            db.execute("drop database " + cls.name)

    def setUp(self):
        self.db.execute("truncate motorist_telnyx_webhook_events")

    def claim(self, event="event", db=None, delivery=True, correlation=False):
        return (db or self.db).execute("select * from motorist_telnyx_claim_webhook_event_v2(%s,'call.answered','{}',%s,'provider-session','leg','control','allowed',now(),30000,%s,%s)", (event, ORG, delivery, correlation)).fetchone()

    def finish(self, claim, result, event="event"):
        return self.db.execute("select motorist_telnyx_finish_webhook_event_v2(%s,%s,%s,'test result') as owned", (event, claim["event_claimed_at"], result)).fetchone()["owned"]

    def row(self):
        return self.db.execute("select * from motorist_telnyx_webhook_events").fetchone()

    def make_due(self, stale=False):
        # Test-only clock advancement using superuser fixture state, no external DB.
        with self.db.transaction():
            self.db.execute("select set_config('app.webhook_writer_contract','2',true)")
            self.db.execute("update motorist_telnyx_webhook_events set next_attempt_at=now()-interval '1 second'" + (",claimed_at=now()-interval '1 minute'" if stale else ""))

    def test_two_concurrent_deliveries_have_one_owner(self):
        barrier = Barrier(2)
        def writer(_):
            with psycopg.connect(dbname=self.name, **LOCAL) as db:
                barrier.wait()
                return self.claim(db=db)["outcome"]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(list(pool.map(writer, range(2))), ["claimed", "busy"])
        self.assertEqual(self.row()["attempts"], 1)
        self.assertEqual(self.row()["delivery_count"], 2)

    def test_deferrals_never_exhaust_effect_budget_and_replay_is_not_delivery(self):
        for _ in range(8):
            claim = self.claim()
            self.assertEqual(claim["outcome"], "claimed")
            self.assertTrue(self.finish(claim, "deferred"))
            self.assertEqual(self.claim(delivery=False)["outcome"], "busy")
            self.make_due()
        self.assertEqual(self.claim(delivery=False)["outcome"], "claimed")
        row = self.row()
        self.assertEqual((row["delivery_count"], row["deferral_count"], row["effect_failure_count"], row["attempts"]), (8, 8, 0, 9))

    def test_old_claim_stamp_cannot_finish_replacement_or_reverse_terminal(self):
        old = self.claim()
        self.make_due(stale=True)
        new = self.claim()
        self.assertNotEqual(old["event_claimed_at"], new["event_claimed_at"])
        self.assertFalse(self.finish(old, "failed"))
        self.assertTrue(self.finish(new, "processed"))
        self.assertFalse(self.finish(new, "failed"))
        self.assertEqual(self.claim()["outcome"], "duplicate")
        self.assertEqual(self.row()["effect_failure_count"], 0)

    def test_actual_failures_terminalize_at_five(self):
        for _ in range(5):
            self.assertTrue(self.finish(self.claim(), "failed"))
            self.make_due()
        self.assertEqual(self.claim()["outcome"], "terminal")
        row = self.row()
        self.assertEqual((row["retry_state"], row["terminal_reason"], row["effect_failure_count"]), ("dead_letter", "effect_failure_limit", 5))

    def test_unknown_correlation_expires_from_first_receipt_and_credential_stays_event_only(self):
        self.db.execute("insert into motorist_telnyx_webhook_events(event_id,organization_id,event_type,call_control_id,connection_id,received_at) values('event',%s,'call.answered','control','allowed',now()-interval '61 seconds')", (ORG,))
        claim = self.claim()
        received = self.row()["received_at"]
        self.assertTrue(self.finish(claim, "awaiting_correlation"))
        self.assertEqual(self.claim(correlation=True)["outcome"], "terminal")
        self.assertEqual(self.row()["received_at"], received)
        self.assertEqual(self.row()["terminal_reason"], "awaiting_correlation_expired")

    def test_correlation_can_bypass_backoff_but_cannot_steal_live_owner(self):
        first = self.claim()
        self.assertEqual(self.claim(correlation=True)["outcome"], "busy")
        self.finish(first, "awaiting_correlation")
        self.assertEqual(self.claim()["outcome"], "busy")
        self.assertEqual(self.claim(delivery=False, correlation=True)["outcome"], "claimed")

    def test_legacy_claim_drains_then_legacy_writers_are_fenced_on_adoption(self):
        old = self.db.execute("select * from motorist_telnyx_claim_webhook_event('event','call.answered','{}',%s,'provider-session','leg','control','allowed')", (ORG,)).fetchone()
        self.assertEqual(self.row()["contract_version"], 1)
        self.assertEqual(self.claim()["outcome"], "busy")
        # The in-flight original client can still finish its owned legacy row.
        self.db.execute("update motorist_telnyx_webhook_events set status='failed' where claimed_at=%s", (old["event_claimed_at"],))
        self.make_due(stale=True)
        new = self.claim()
        self.assertEqual(new["outcome"], "claimed")
        self.db.execute("set role service_role")
        try:
            with self.assertRaises(psycopg.Error) as error:
                self.db.execute("update motorist_telnyx_webhook_events set status='processed',claimed_at=null")
            self.assertEqual(error.exception.sqlstate, "PT409")
            # Existing direct legacy claims cannot regain a contract-2 event even after expiry.
        finally:
            self.db.execute("reset role")
        self.make_due(stale=True)
        with self.assertRaises(psycopg.Error) as error:
            self.db.execute("select * from motorist_telnyx_claim_webhook_event('event','call.answered','{}',%s,'provider-session','leg','control','allowed')", (ORG,))
        self.assertEqual(error.exception.sqlstate, "PT409")

    def test_client_roles_cannot_claim_or_finish(self):
        self.db.execute("set role authenticated")
        try:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                self.claim()
        finally:
            self.db.execute("reset role")


if __name__ == "__main__":
    unittest.main(verbosity=2)
