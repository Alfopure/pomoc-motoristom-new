"""Offline regression checks for the production-read-only TEST refill utility.

Run: python3 tests/copy-test-data.test.py
No credentials, database, SDK or network access is required.
"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "copy_test_data", Path(__file__).resolve().parents[1] / "scripts" / "copy-test-data.py"
)
copy_db = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(copy_db)


def column(name="id", generated="", default=None):
    return {"name": name, "type": "uuid", "not_null": True,
            "generated": generated, "identity": "", "default": default, "ordinal": 1}


def catalog():
    return {
        name: {"columns": [column()], "constraints": [], "triggers": []}
        for name in ("auth.users", "auth.identities", "public.motorist_cases")
    }


class CopySafetyTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.here = patch.object(copy_db, "HERE", Path(self.workspace.name))
        self.here.start()
        self.addCleanup(self.here.stop)

    def test_production_and_unrelated_targets_cannot_receive_writes(self):
        with patch.object(copy_db, "api") as api:
            for ref in (copy_db.SOURCE, copy_db.FORBIDDEN, "a" * 20):
                with self.assertRaises(copy_db.CopyError):
                    copy_db.query(ref, "DELETE FROM public.motorist_cases", write=True)
            api.assert_not_called()

    def test_unrelated_targets_cannot_even_be_read(self):
        with patch.object(copy_db, "api") as api:
            for ref in (copy_db.FORBIDDEN, "a" * 20):
                with self.assertRaises(copy_db.CopyError):
                    copy_db.query(ref, "SELECT 1")
            api.assert_not_called()

    def test_production_reads_have_api_and_sql_read_only_guards(self):
        with patch.object(copy_db, "api") as api:
            copy_db.query(copy_db.SOURCE, "SELECT 1")
        method, path, body = api.call_args.args
        self.assertEqual(method, "POST")
        self.assertEqual(path, f"/projects/{copy_db.SOURCE}/database/query")
        self.assertIs(body["read_only"], True)
        self.assertIn("REPEATABLE READ READ ONLY", body["query"])
        self.assertIn("statement_timeout='5s'", body["query"])
        self.assertIn("jit=off", body["query"])

    def test_keyset_pages_are_small_and_detect_count_changes(self):
        table = {"constraints": [{"type": "p", "definition": "PRIMARY KEY (id)"}]}
        responses = [[{"stats": {"count": 3}}], [{"rows": [{"id": "a"}, {"id": "b"}]}],
                     [{"rows": [{"id": "c"}]}], [{"stats": {"count": 3}}]]
        with patch.object(copy_db, "PAGE_SIZE", 2), patch.object(copy_db, "query", side_effect=responses) as query:
            rows, window = copy_db.read_table(copy_db.SOURCE, "public.motorist_cases", table)
        self.assertEqual(len(rows), 3)
        self.assertEqual(window["pages"], 2)
        statements = [call.args[1] for call in query.call_args_list]
        self.assertTrue(all("UNION" not in statement for statement in statements))
        self.assertIn("LIMIT 2", statements[1])
        self.assertIn('ROW(t."id") > ROW(boundary."id")', statements[2])
        changing = [[{"stats": {"count": 1}}], [{"rows": [{"id": "a"}]}], [{"stats": {"count": 2}}]]
        with patch.object(copy_db, "query", side_effect=changing):
            with self.assertRaisesRegex(copy_db.CopyError, "Row count changed"):
                copy_db.read_table(copy_db.SOURCE, "public.motorist_cases", table)

    def test_local_state_cannot_retarget_test(self):
        copy_db.private_json(Path(self.workspace.name) / "state.json", {"test_ref": copy_db.SOURCE})
        with self.assertRaises(copy_db.CopyError):
            copy_db.target_ref()

    def test_target_project_organization_must_match(self):
        with patch.object(copy_db, "api", return_value={
            "id": copy_db.TEST_REF, "organization_id": copy_db.SOURCE_ORG, "status": "ACTIVE_HEALTHY"
        }):
            with self.assertRaises(copy_db.CopyError):
                copy_db.assert_project(copy_db.TEST_REF, writing=True)

    def test_snapshot_input_is_not_mutated_and_password_hash_is_preserved(self):
        source = {
            "public.motorist_telephony_settings": [{"live_calls_enabled": True, "sms_live_sends": True}],
            "public.motorist_job_controls": [{"enabled": True}],
            "auth.users": [{"id": "example-user", "encrypted_password": "example-hash",
                            "recovery_token": "example-reset-token", "email_change_confirm_status": 2}],
            "public.motorist_call_sessions": [{"state": "talking", "ended_at": None,
                "pending_effects": {"entries": ["dial"]}, "lease_token": "example-lease"}],
        }
        rows, differences = copy_db.transform_rows(source, "2026-09-21T20:00:00Z")
        self.assertIs(source["public.motorist_telephony_settings"][0]["live_calls_enabled"], True)
        self.assertEqual(rows["public.motorist_telephony_settings"][0],
                         {"live_calls_enabled": False, "sms_live_sends": False})
        self.assertFalse(rows["public.motorist_job_controls"][0]["enabled"])
        self.assertEqual(rows["auth.users"][0]["encrypted_password"], "example-hash")
        self.assertEqual(rows["auth.users"][0]["recovery_token"], "")
        self.assertIsNone(rows["public.motorist_call_sessions"][0]["pending_effects"])
        self.assertEqual(rows["public.motorist_call_sessions"][0]["state"], "ended")
        self.assertIn("auth.users", differences)

    def test_generated_columns_are_omitted_and_public_schema_drift_rejected(self):
        source, target = catalog(), catalog()
        source["auth.users"]["columns"].append(column("confirmed_at", generated="s"))
        target["auth.users"]["columns"].append(column("confirmed_at", generated="s"))
        writable, _ = copy_db.compatible_columns(source, target)
        self.assertNotIn("confirmed_at", writable["auth.users"])
        target["public.motorist_cases"]["columns"].append(column("unexpected"))
        with self.assertRaises(copy_db.CopyError):
            copy_db.compatible_columns(source, target)

    def test_unreviewed_auth_hooks_abort_preparation(self):
        source, target = catalog(), catalog()
        target["auth.users"]["triggers"] = [{"name": "unreviewed_signup_hook", "enabled": "O"}]
        snapshot = {"source_ref": copy_db.SOURCE, "catalog": source}
        with self.assertRaisesRegex(copy_db.CopyError, "auth user triggers"):
            copy_db.prepared_data(snapshot, target)

    def test_import_restores_and_validates_foreign_keys_before_commit(self):
        target = catalog()
        target["public.motorist_cases"]["constraints"] = [{"name": "example_fk", "type": "f",
            "definition": "FOREIGN KEY (id) REFERENCES auth.users(id)", "validated": True}]
        target["public.motorist_cases"]["triggers"] = [{"name": "touch_case", "enabled": "O"}]
        prepared = {"target_catalog": target, "tables": {}, "columns": {},
                    "expected_counts": {name: 0 for name in target}}
        sql = copy_db.build_import_sql(prepared)
        self.assertTrue(sql.startswith("BEGIN;"))
        self.assertIn("DISABLE TRIGGER USER", sql)
        self.assertIn('DROP CONSTRAINT "example_fk"', sql)
        self.assertIn('ADD CONSTRAINT "example_fk" FOREIGN KEY', sql)
        self.assertLess(sql.index('ADD CONSTRAINT "example_fk"'), sql.index("COMMIT;"))
        self.assertLess(sql.index('ENABLE TRIGGER "touch_case"'), sql.index("COMMIT;"))
        self.assertNotIn("CASCADE", sql)
        self.assertNotIn("session_replication_role", sql)
        self.assertNotIn(copy_db.SOURCE, sql)

    def test_staging_is_test_only_and_final_transaction_does_not_inline_data(self):
        with patch.object(copy_db, "api") as api:
            for ref in (copy_db.SOURCE, copy_db.FORBIDDEN, "a" * 20):
                with self.assertRaises(copy_db.CopyError):
                    copy_db.stage_data(ref, {})
            api.assert_not_called()
        target = catalog()
        prepared = {"target_catalog": target, "tables": {"auth.users": [{"id": "DO_NOT_INLINE_PRIVATE_ROW"}]},
                    "columns": {"auth.users": ["id"]},
                    "expected_counts": {name: int(name == "auth.users") for name in target}}
        batch = "00000000-0000-0000-0000-000000000123"
        sql = copy_db.build_import_sql(prepared, stage_batch_id=batch)
        self.assertNotIn("DO_NOT_INLINE_PRIVATE_ROW", sql)
        self.assertIn("CROSS JOIN LATERAL", sql)
        self.assertIn("staged.payload", sql)
        self.assertIn("DELETE FROM test_copy_stage.pages WHERE batch_id=", sql)
        self.assertLess(sql.index("DELETE FROM test_copy_stage.pages"), sql.index("COMMIT;"))
        self.assertIn(batch, sql)

    def test_staging_pages_bound_encoded_http_size_and_row_count(self):
        # Unicode JSON escaping is included in the actual transport size.
        prepared = {"tables": {"public.motorist_cases": [
            {"id": str(index), "note": "č" * 1500} for index in range(130)
        ]}}
        pages = copy_db.staging_pages(prepared, "00000000-0000-0000-0000-000000000123")
        self.assertGreater(len(pages), 1)
        self.assertEqual(sum(page["rows"] for page in pages), 130)
        self.assertTrue(all(page["rows"] <= 100 for page in pages))
        self.assertTrue(all(page["request_bytes"] <= 512 * 1024 for page in pages))
        with self.assertRaises(copy_db.CopyError):
            copy_db.staging_pages({"tables": {"public.motorist_fleet_position_samples": []}},
                                 "00000000-0000-0000-0000-000000000123")

    def test_identifiers_reject_sql_and_literals_escape_quotes_and_backslashes(self):
        with self.assertRaises(copy_db.CopyError):
            copy_db.ident('name"; DELETE FROM public.motorist_cases; --')
        self.assertEqual(copy_db.literal("quote'back\\slash"), "E'quote''back\\\\slash'")


if __name__ == "__main__":
    unittest.main()
