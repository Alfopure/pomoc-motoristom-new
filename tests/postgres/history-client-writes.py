"""B2 permissions, real case-save and broadcast trigger contracts.

Run against a disposable loopback PostgreSQL at 127.0.0.1:55432 as postgres:
    python3 tests/postgres/history-client-writes.py
Requires psycopg 3. Never reads application credentials or a remote DSN.
Creates and removes its own database; provider/network effects are not tested.
"""
from contextlib import contextmanager
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from uuid import uuid4
import re
import unittest

import psycopg

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("atomic_case", Path(__file__).with_name("atomic-case-save.py"))
atomic = module_from_spec(spec)
spec.loader.exec_module(atomic)
MIGRATION = ROOT / "supabase/migrations/20261006093143_restrict_history_client_writes.sql"
TABLES = ("motorist_case_events", "motorist_call_events")
OTHER_ORG = "10000000-0000-0000-0000-000000000002"
FOREIGN_CASE = "40000000-0000-0000-0000-000000000002"
USERS = {
    "dispatcher": "30000000-0000-0000-0000-000000000001",
    "admin": "30000000-0000-0000-0000-000000000003",
    "foreign": "30000000-0000-0000-0000-000000000004",
    "senior_dispatcher": "30000000-0000-0000-0000-000000000005",
    "manager": "30000000-0000-0000-0000-000000000006",
    "inactive": "30000000-0000-0000-0000-000000000007",
    "unknown": "30000000-0000-0000-0000-000000000008",
}


def declaration(source, name):
    pattern = r"create\s+(?:or\s+replace\s+)?function\s+" + re.escape(name) + r"\s*\(.*?\bas\s+(\$[^$]*\$).*?\1\s*;"
    return re.search(pattern, source, re.I | re.S).group()


class HistoryClientWrites(atomic.AtomicCaseContract):
    # Inherit the eleven real atomic-save tests, including concurrent CAS,
    # rollback after an audit failure, membership and service-only RPC access.
    conflict_sqlstate = "PT409"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        foundation = (ROOT / "supabase/migrations/20260520192000_foundation_schema.sql").read_text()
        collaboration = (ROOT / "supabase/migrations/20261006120000_case_collaboration.sql").read_text()
        # The parent supplies exact foundation case/event tables and case-save
        # dependencies. Calls here are only the FK target; no call runtime stub
        # is used as evidence of provider or session-state behavior.
        cls.db.execute("create table public.motorist_calls(id uuid primary key)")
        cls.db.execute(re.search(r"create table public\.motorist_call_events \(.*?\n\);", foundation, re.S).group())
        cls.db.execute("alter table public.motorist_call_events add column provider_timestamp timestamptz")
        cls.db.execute(declaration(foundation, "public.motorist_is_org_member").replace(
            "function public.motorist_is_org_member", "function app_private.motorist_is_org_member", 1))
        cls.db.execute("grant usage on schema auth,app_private to anon,authenticated,service_role")
        cls.db.execute("grant execute on function auth.uid(),app_private.motorist_is_org_member(uuid) to anon,authenticated,service_role")
        # Supabase's service_role bypasses RLS. This is an isolated local role.
        cls.db.execute("alter role service_role bypassrls")
        for table in TABLES:
            cls.db.execute(f"alter table {table} enable row level security")
            cls.db.execute(f"grant all on {table} to anon,authenticated,service_role")
            cls.db.execute(f"create policy {table}_organization_access on {table} for all to public "
                           "using(app_private.motorist_is_org_member(organization_id)) "
                           "with check(app_private.motorist_is_org_member(organization_id))")

        # Install the current RPC definition and the exact deployed event trigger.
        current = (ROOT / "supabase/migrations/20260929170000_domain_conflict_sqlstate.sql").read_text()
        cls.db.execute(declaration(current, "public.motorist_save_case_atomic"))
        cls.db.execute(re.search(r"create table public\.motorist_case_live_versions \(.*?\n\);", collaboration, re.S).group())
        cls.db.execute(declaration(collaboration, "app_private.motorist_case_live_change"))
        cls.db.execute("create trigger motorist_case_live_change after insert or update or delete "
                       "on public.motorist_case_events for each row execute function app_private.motorist_case_live_change()")

        cls.db.execute("insert into motorist_cases(id,organization_id,case_number,status,priority) "
                       "values(%s,%s,'PREEXISTING','open','normal')", (atomic.CASE, atomic.ORG))
        cls.db.execute("insert into motorist_case_events(organization_id,case_id,event_type,title,body,payload) "
                       "values(%s,%s,'note_added','Existing note','Keep this body','{\"source\":\"existing\"}')",
                       (atomic.ORG, atomic.CASE))
        cls.db.execute("insert into motorist_call_events(organization_id,event_type,event_fingerprint,normalized_payload) "
                       "values(%s,'call.answered','preexisting','{\"commands\":[]}')", (atomic.ORG,))

        # Reproduce the reported unauthorized write with the original live ACL.
        with cls.db.transaction():
            cls.db.execute("set local role authenticated")
            cls.db.execute("select set_config('request.jwt.claim.sub',%s,true)", (USERS["dispatcher"],))
            cls.db.execute("insert into motorist_call_events(organization_id,event_type,event_fingerprint) "
                           "values(%s,'fixture.forged','before-hardening')", (atomic.ORG,))
            cls.baseline_write_reproduced = cls.db.execute(
                "delete from motorist_call_events where event_fingerprint='before-hardening'").rowcount == 1

        cls.before = cls.catalog()
        cls.rows_before = cls.history_rows()
        cls.db.execute(MIGRATION.read_text())
        cls.after = cls.catalog()
        cls.rows_after = cls.history_rows()
        for role, number in (("senior_dispatcher", 5), ("manager", 6), ("inactive", 7)):
            cls.db.execute("insert into motorist_profiles(id,organization_id,user_id,role,display_name,active) "
                           "values(%s,%s,%s,%s,'Local role fixture',%s)",
                           (f"20000000-0000-0000-0000-{number:012}", atomic.ORG, USERS[role],
                            role if role != "inactive" else "dispatcher", role != "inactive"))
        print("Local engine:", cls.db.execute("select version()").fetchone()[0], flush=True)

    @classmethod
    def history_rows(cls):
        return {table: cls.db.execute(f"select to_jsonb(e) from {table} e order by id").fetchall() for table in TABLES}

    @classmethod
    def catalog(cls):
        return {
            "functions": cls.db.execute("select n.nspname,p.proname,pg_get_functiondef(p.oid),p.proacl "
                "from pg_proc p join pg_namespace n on n.oid=p.pronamespace "
                "where n.nspname in ('public','app_private','realtime') order by n.nspname,p.proname").fetchall(),
            "triggers": cls.db.execute("select tgrelid::regclass::text,pg_get_triggerdef(oid) from pg_trigger "
                "where not tgisinternal order by tgrelid::regclass::text,tgname").fetchall(),
            "indexes": cls.db.execute("select tablename,indexname,indexdef from pg_indexes where schemaname='public' "
                "order by tablename,indexname").fetchall(),
            "publications": cls.db.execute("select pubname,schemaname,tablename from pg_publication_tables "
                "order by pubname,schemaname,tablename").fetchall(),
            "service_grants": cls.db.execute("select table_name,privilege_type from information_schema.table_privileges "
                "where grantee='service_role' order by table_name,privilege_type").fetchall(),
        }

    def setUp(self):
        super().setUp()
        self.db.execute("truncate motorist_call_events,realtime.test_invalidations")

    @contextmanager
    def as_role(self, role="authenticated", user=USERS["dispatcher"]):
        with self.db.transaction():
            self.db.execute(f"set local role {role}")
            self.db.execute("select set_config('request.jwt.claim.sub',%s,true)", (user or "",))
            yield
            # A nested transaction is a savepoint: releasing it does not restore
            # SET LOCAL ROLE. Reset on success; an error rolls its savepoint back.
            self.db.execute("reset role")

    def seed_history(self):
        self.db.execute("insert into motorist_cases(id,organization_id,case_number,status,priority) "
                        "values(%s,%s,'FOREIGN','open','normal')", (FOREIGN_CASE, OTHER_ORG))
        for org, case in ((atomic.ORG, atomic.CASE), (OTHER_ORG, FOREIGN_CASE)):
            self.db.execute("insert into motorist_case_events(organization_id,case_id,event_type,title,body) "
                            "values(%s,%s,'note_added','Private title','Private body')", (org, case))
            self.db.execute("insert into motorist_call_events(organization_id,event_type,event_fingerprint) "
                            "values(%s,'call.answered',%s)", (org, str(uuid4())))

    def insert(self, table):
        if table == "motorist_case_events":
            return self.db.execute("insert into motorist_case_events(organization_id,case_id,event_type,title) "
                                   "values(%s,%s,'note_added','Authorized note') returning id", (atomic.ORG, atomic.CASE))
        return self.db.execute("insert into motorist_call_events(organization_id,event_type,event_fingerprint,provider_timestamp) "
                               "values(%s,'call.answered',%s,clock_timestamp()) returning id", (atomic.ORG, str(uuid4())))

    def test_original_direct_write_is_reproduced_and_catalog_is_preserved(self):
        self.assertTrue(self.baseline_write_reproduced)
        self.assertEqual(self.before, self.after)

    def test_existing_history_contents_are_unchanged_by_migration(self):
        self.assertTrue(all(self.rows_before.values()))
        self.assertEqual(self.rows_before, self.rows_after)

    def test_read_only_hosted_verification_script(self):
        self.seed_history()
        cursor = self.db.execute((ROOT / "supabase/verification/history-client-writes.sql").read_text())
        results = []
        while True:
            if cursor.description:
                results.extend(cursor.fetchall())
            if not cursor.nextset(): break
        self.assertEqual(len(results), 1)
        self.assertEqual(len(results[0][0]), 18)

    def test_client_grants_are_select_only(self):
        for table in TABLES:
            for role in ("anon", "authenticated"):
                for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
                    with self.subTest(table=table, role=role, privilege=privilege):
                        actual = self.db.execute("select has_table_privilege(%s,%s,%s)", (role, table, privilege)).fetchone()[0]
                        self.assertEqual(actual, privilege == "SELECT")

    def test_active_roles_keep_scoped_reads(self):
        self.seed_history()
        for role in ("dispatcher", "senior_dispatcher", "manager", "admin"):
            for table in TABLES:
                with self.subTest(role=role, table=table), self.as_role(user=USERS[role]):
                    rows = self.db.execute(f"select organization_id from {table}").fetchall()
                    self.assertEqual([str(row[0]) for row in rows], [atomic.ORG])

    def test_foreign_member_sees_only_foreign_history(self):
        self.seed_history()
        for table in TABLES:
            with self.subTest(table=table), self.as_role(user=USERS["foreign"]):
                rows = self.db.execute(f"select organization_id from {table}").fetchall()
                self.assertEqual([str(row[0]) for row in rows], [OTHER_ORG])

    def test_inactive_unknown_and_anon_see_no_history(self):
        self.seed_history()
        for role, user in (("authenticated", USERS["inactive"]), ("authenticated", USERS["unknown"]), ("anon", None)):
            for table in TABLES:
                with self.subTest(role=role, user=user, table=table), self.as_role(role, user):
                    self.assertEqual(self.db.execute(f"select count(*) from {table}").fetchone()[0], 0)

    def test_direct_client_mutations_fail_for_every_application_role(self):
        self.seed_history()
        for user in (USERS[role] for role in ("dispatcher", "senior_dispatcher", "manager", "admin")):
            for table in TABLES:
                for operation in ("insert", "update", "delete", "truncate"):
                    with self.subTest(user=user, table=table, operation=operation):
                        with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.as_role(user=user):
                            if operation == "insert": self.insert(table)
                            elif operation == "update": self.db.execute(f"update {table} set event_type='forged'")
                            elif operation == "delete": self.db.execute(f"delete from {table}")
                            else: self.db.execute(f"truncate {table}")

    def test_anon_cannot_write_even_with_a_forged_member_claim(self):
        for table in TABLES:
            with self.subTest(table=table):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.as_role("anon", USERS["admin"]):
                    self.insert(table)

    def test_service_role_keeps_real_crud(self):
        for table in TABLES:
            with self.subTest(table=table), self.as_role("service_role", None):
                row_id = self.insert(table).fetchone()[0]
                self.assertEqual(self.db.execute(f"select event_type from {table} where id=%s", (row_id,)).fetchone()[0],
                                 "note_added" if table == "motorist_case_events" else "call.answered")
                self.assertEqual(self.db.execute(f"update {table} set event_type='corrected' where id=%s", (row_id,)).rowcount, 1)
                self.assertEqual(self.db.execute(f"delete from {table} where id=%s", (row_id,)).rowcount, 1)

    def test_service_event_retry_preserves_unique_fingerprint(self):
        with self.as_role("service_role", None):
            sql = "insert into motorist_call_events(organization_id,event_type,event_fingerprint) values(%s,'call.answered','retry') on conflict (organization_id,provider,event_fingerprint) do nothing"
            self.assertEqual(self.db.execute(sql, (atomic.ORG,)).rowcount, 1)
            self.assertEqual(self.db.execute(sql, (atomic.ORG,)).rowcount, 0)
            self.assertEqual(self.db.execute("select count(*) from motorist_call_events").fetchone()[0], 1)

    def test_service_case_save_writes_history_and_broadcast_revision(self):
        with self.as_role("service_role", None):
            self.save(patch={"priority": "high"}, related=[])
        self.assertEqual(self.db.execute("select count(*) from motorist_case_events where event_type='priority_changed'").fetchone()[0], 1)
        self.assertGreater(self.db.execute("select revision from motorist_case_live_versions where case_id=%s", (atomic.CASE,)).fetchone()[0], 0)
        self.assertEqual(self.db.execute("select payload,event,topic,private from realtime.test_invalidations").fetchall(),
                         [({}, "invalidate", "cases:" + atomic.ORG, True)])

    def test_direct_service_event_notifies_other_client_and_rollback_notifies_nobody(self):
        with self.as_role("service_role", None):
            row_id = self.insert("motorist_case_events").fetchone()[0]
        with psycopg.connect(dbname=self.dbname, **atomic.LOCAL) as second_client:
            with second_client.transaction():
                second_client.execute("set local role authenticated")
                second_client.execute("select set_config('request.jwt.claim.sub',%s,true)", (USERS["admin"],))
                self.assertEqual(second_client.execute("select id from motorist_case_events").fetchone()[0], row_id)
        before = self.db.execute("select count(*) from realtime.test_invalidations").fetchone()[0]
        with self.assertRaises(RuntimeError):
            with self.as_role("service_role", None):
                self.insert("motorist_case_events")
                raise RuntimeError("rollback")
        self.assertEqual(self.db.execute("select count(*) from realtime.test_invalidations").fetchone()[0], before)
        self.assertEqual(self.db.execute("select count(*) from motorist_case_events").fetchone()[0], 1)

    def test_rls_survives_accidental_later_client_dml_grant(self):
        self.seed_history()
        # Deliberate fault injection is rolled back with the transaction.
        with self.db.transaction(force_rollback=True):
            for table in TABLES:
                self.db.execute(f"grant insert,update,delete on {table} to authenticated")
                with self.as_role():
                    self.assertEqual(self.db.execute(f"update {table} set event_type='forged'").rowcount, 0)
                    self.assertEqual(self.db.execute(f"delete from {table}").rowcount, 0)
                with self.assertRaises(psycopg.errors.InsufficientPrivilege), self.as_role():
                    self.insert(table)


if __name__ == "__main__":
    unittest.main(verbosity=2)
