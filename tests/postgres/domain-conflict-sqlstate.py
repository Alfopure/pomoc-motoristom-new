"""P0 migration and real HTTP regression, disposable loopback PostgreSQL only.

Requires PostgreSQL 17 at 127.0.0.1:55432, psycopg 3 and POSTGREST_BIN.
Run: POSTGREST_BIN=/path/to/postgrest python3 tests/postgres/domain-conflict-sqlstate.py
No application credentials, remote databases or provider APIs are used.
"""
from concurrent.futures import ThreadPoolExecutor
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from threading import Barrier
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
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

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("atomic_case", Path(__file__).with_name("atomic-case-save.py"))
atomic = module_from_spec(spec)
spec.loader.exec_module(atomic)
MIGRATION = ROOT / "supabase/migrations/20260929170000_domain_conflict_sqlstate.sql"
FUNCTIONS = {
    "motorist_approve_callback_target": ("20260929160000_verified_callback_targets.sql", 1),
    "motorist_call_quality_approve": ("20260925100000_call_recording_processing.sql", 2),
    "motorist_call_transcript_correct": ("20260925100000_call_recording_processing.sql", 1),
    "motorist_contact_callback_policy": ("20260929160000_verified_callback_targets.sql", 1),
    "motorist_notebook": ("20260929100000_personal_notes.sql", 1),
    "motorist_recording_delete_call": ("20260925101000_call_quality_services.sql", 2),
    "motorist_recording_policy_save": ("20260925101000_call_quality_services.sql", 1),
    "motorist_recording_retry_call": ("20260925101000_call_quality_services.sql", 2),
    "motorist_save_case_atomic": ("20260929110000_atomic_case_save.sql", 2),
    "motorist_task_workspace": ("20260929120000_task_workspace.sql", 2),
}


def definitions(db):
    return db.execute("""
        select p.proname, pg_get_functiondef(p.oid), p.oid::regprocedure::text,
               p.proowner, p.proacl, p.prosecdef, p.proconfig
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=any(%s) order by p.proname
    """, (list(FUNCTIONS),)).fetchall()


class DomainConflictContract(atomic.AtomicCaseContract):
    conflict_sqlstate = "PT409"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Other RPCs need no business rows for catalog/DDL checks. Their exact historical
        # declarations are compiled lazily; the real case-save schema is fully present.
        cls.db.execute("set check_function_bodies=off")
        for name, (source, count) in FUNCTIONS.items():
            historical = (ROOT / "supabase/migrations" / source).read_text()
            pattern = r"create\s+(?:or\s+replace\s+)?function\s+public\." + name + r"\s*\(.*?\bas\s+(\$[^$]*\$).*?\1\s*;"
            declaration = re.search(pattern, historical, re.I | re.S).group()
            assert declaration.count("'40001'") == count, name
            # Earlier CREATE FUNCTION declarations become replaceable fixture installs.
            declaration = re.sub(r"^create function", "create or replace function", declaration, flags=re.I)
            cls.db.execute(declaration)
        # Reproduce the distinct live ACL classes; replacement must retain both exactly.
        for name, _, signature, *_ in definitions(cls.db):
            cls.db.execute(f"revoke all on function {signature} from public, anon, authenticated, service_role")
            role = "authenticated" if name in ("motorist_notebook", "motorist_task_workspace") else "service_role"
            cls.db.execute(f"grant execute on function {signature} to {role}")
        cls.original = definitions(cls.db)
        cls.db.execute(MIGRATION.read_text())
        cls.migrated = definitions(cls.db)

        binary = os.environ.get("POSTGREST_BIN") or shutil.which("postgrest")
        if not binary:
            raise RuntimeError("POSTGREST_BIN must point to a locally installed PostgREST binary")
        cls.http_version = subprocess.check_output([binary, "--version"], text=True).strip()
        print("Isolated engine:", cls.db.execute("select version()").fetchone()[0], flush=True)
        print("Isolated HTTP engine:", cls.http_version, flush=True)
        cls.db.execute("""
            create sequence public.test_http_attempts;
            create function public.test_http_attempt() returns void language sql security definer
              set search_path=public as $$ select nextval('public.test_http_attempts') $$;
        """)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            cls.port = reservation.getsockname()[1]
        cls.http_url = f"http://127.0.0.1:{cls.port}"
        cls.temp = tempfile.TemporaryDirectory(prefix="domain-conflict-postgrest-")
        config = Path(cls.temp.name) / "postgrest.conf"
        config.write_text(f'''db-uri = "postgresql://postgres@127.0.0.1:55432/{cls.dbname}"
db-schemas = "public"
db-anon-role = "service_role"
db-config = false
db-channel-enabled = false
db-pool = 2
db-pre-request = "public.test_http_attempt"
server-host = "127.0.0.1"
server-port = {cls.port}
log-level = "crit"
''')
        cls.http_log = open(Path(cls.temp.name) / "postgrest.log", "w+")
        # Do not inherit PGRST_* or application secrets into the disposable server.
        cls.http_process = subprocess.Popen([binary, str(config)], env={"PATH": os.environ.get("PATH", "")}, stdout=cls.http_log, stderr=cls.http_log)
        deadline = time.monotonic() + 15
        last_error = "No response"
        while time.monotonic() < deadline:
            try:
                probe = Request(cls.http_url + "/rpc/test_http_attempt", data=b"{}", headers={"Content-Type": "application/json"})
                with urlopen(probe, timeout=1) as response:
                    if response.status == 204:
                        break
            except (URLError, TimeoutError) as error:
                last_error = error.read().decode() if isinstance(error, HTTPError) else str(error)
                time.sleep(0.1)
        else:
            cls.http_log.seek(0)
            cls.http_process.terminate()
            cls.http_process.wait(timeout=10)
            raise RuntimeError("Local PostgREST failed to start: " + last_error + "\n" + cls.http_log.read())

    @classmethod
    def tearDownClass(cls):
        cls.http_process.terminate()
        cls.http_process.wait(timeout=10)
        cls.http_log.close()
        cls.temp.cleanup()
        super().tearDownClass()

    def http_save(self, patch=None, related=None, token=None):
        payload = {
            "p_organization_id": atomic.ORG, "p_actor_id": atomic.ACTOR, "p_case_id": atomic.CASE,
            "p_expected_updated_at": token or self.token.isoformat(),
            "p_case_patch": self.patch if patch is None else patch,
            "p_related": self.related if related is None else related, "p_field_labels": {},
        }
        request = Request(self.http_url + "/rpc/motorist_save_case_atomic", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        started = time.monotonic()
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            result = (response.status, json.load(response), time.monotonic() - started)
        self.assertLess(result[2], 2, "RPC must finish without retry loops")
        return result

    def attempts(self):
        return self.db.execute("select case when is_called then last_value else 0 end from test_http_attempts").fetchone()[0]

    def test_exact_definitions_and_privileges_survive_migration(self):
        self.assertEqual(len(self.original), 10)
        self.assertEqual(sum(row[1].count("'40001'") for row in self.original), 15)
        for before, after in zip(self.original, self.migrated):
            self.assertEqual(after[1], before[1].replace("'40001'", "'PT409'"), before[0])
            self.assertEqual(after[2:], before[2:], before[0])
        self.assertEqual(sum(row[1].count("'PT409'") for row in self.migrated), 15)

    def test_migration_is_idempotent_and_rejects_body_or_security_drift(self):
        self.db.execute(MIGRATION.read_text())
        self.assertEqual(definitions(self.db), self.migrated)
        original = next(row for row in self.migrated if row[0] == "motorist_task_workspace")
        for drifted in [original[1].replace("$function$\n", "$function$\n-- unreviewed drift\n", 1), original[1].replace("SECURITY DEFINER", "SECURITY INVOKER")]:
            self.db.execute(drifted)
            drift_snapshot = definitions(self.db)
            try:
                with self.assertRaises(psycopg.errors.RaiseException) as raised:
                    self.db.execute(MIGRATION.read_text())
                self.assertIn("definition drift", str(raised.exception))
                self.db.execute("rollback")
                self.assertEqual(definitions(self.db), drift_snapshot)
            finally:
                self.db.execute("rollback")
                self.db.execute(original[1])

    def test_http_race_is_one_commit_and_one_409_with_one_attempt_each(self):
        barrier = Barrier(2)
        attempts = self.attempts()
        def writer(priority):
            barrier.wait()
            return self.http_save(patch={**self.patch, "priority": priority})
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(writer, ["high", "urgent"]))
        self.assertCountEqual([result[0] for result in results], [200, 409])
        conflict = next(result for result in results if result[0] == 409)
        self.assertEqual(conflict[1]["code"], "PT409")
        self.assertEqual(conflict[1]["message"], "Case revision conflict")
        self.assertEqual(self.attempts() - attempts, 2)
        self.assertEqual(self.db.execute("select count(*) from motorist_audit_log").fetchone()[0], 1)
        print("HTTP race:", [(r[0], round(r[2] * 1000, 2)) for r in results], "ms; 2 transaction attempts", flush=True)

    def test_http_repeated_stale_writes_do_not_retry_or_partially_save(self):
        self.save()
        snapshot = self.snapshot()
        attempts = self.attempts()
        results = [self.http_save(patch={**self.patch, "priority": "urgent"}) for _ in range(10)]
        self.assertEqual([result[0] for result in results], [409] * 10)
        self.assertTrue(all(result[1]["code"] == "PT409" for result in results))
        self.assertEqual(self.attempts() - attempts, 10)
        self.assertEqual(self.snapshot(), snapshot)
        print("10 stale HTTP writes: max", round(max(r[2] for r in results) * 1000, 2), "ms; 10 transaction attempts", flush=True)

    def test_http_late_related_conflict_rolls_back_earlier_related_update(self):
        old = self.db.execute("select updated_at from motorist_vehicles").fetchone()[0]
        self.db.execute("update motorist_vehicles set license_plate='SOMEONE ELSE'")
        snapshot = self.snapshot()
        related = [self.related[0], {**self.related[1], "expectedUpdatedAt": old.isoformat()}, self.related[2]]
        attempts = self.attempts()
        status, body, _ = self.http_save(related=related)
        self.assertEqual(status, 409)
        self.assertEqual(body["code"], "PT409")
        self.assertEqual(body["message"], "Related row revision conflict")
        self.assertEqual(self.attempts() - attempts, 1)
        self.assertEqual(self.snapshot(), snapshot)

    def test_real_serialization_failure_remains_40001(self):
        with psycopg.connect(dbname=self.dbname, **atomic.LOCAL) as first, psycopg.connect(dbname=self.dbname, **atomic.LOCAL) as second:
            first.execute("begin isolation level serializable")
            second.execute("begin isolation level serializable")
            first.execute("select * from motorist_cases where id=%s", (atomic.CASE,))
            second.execute("select * from motorist_cases where id=%s", (atomic.CASE,))
            first.execute("update motorist_cases set priority='high' where id=%s", (atomic.CASE,))
            first.execute("commit")
            with self.assertRaises(psycopg.errors.SerializationFailure) as raised:
                second.execute("update motorist_cases set priority='urgent' where id=%s", (atomic.CASE,))
            self.assertEqual(raised.exception.sqlstate, "40001")
            second.execute("rollback")


if __name__ == "__main__":
    unittest.main(verbosity=2)
