"""Private-record identity contract using historical profile policies; local only."""
from pathlib import Path
from uuid import uuid4
import re
import unittest
import psycopg

ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host="127.0.0.1", port=55432, user="postgres", autocommit=True)
ORG = "10000000-0000-0000-0000-000000000001"
OWNER = "20000000-0000-0000-0000-000000000001"
ADMIN = "20000000-0000-0000-0000-000000000003"
ADMIN_USER = "30000000-0000-0000-0000-000000000003"

class ProfileIdentityContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name = "profile_identity_" + uuid4().hex[:10]
        with psycopg.connect(dbname="postgres", **LOCAL) as admin:
            admin.execute("create database " + cls.name)
        cls.db = psycopg.connect(dbname=cls.name, **LOCAL)
        cls.db.execute((ROOT / "tests/postgres/notebook-fixture.sql").read_text())
        # Model Supabase service_role explicitly, independent of other fixtures.
        cls.db.execute("alter role service_role bypassrls")
        foundation = (ROOT / "supabase/migrations/20260520192000_foundation_schema.sql").read_text()
        for function in ["motorist_is_org_member", "motorist_has_org_role"]:
            cls.db.execute(re.search(r"create or replace function public\." + function + r"\(.*?\$\$;", foundation, re.S).group())
        policy = (ROOT / "supabase/migrations/20260608122637_access_management.sql").read_text()
        cls.db.execute("alter table motorist_profiles enable row level security; grant all on motorist_profiles to authenticated,service_role")
        for name in ["select_member", "manager_insert", "manager_update", "admin_delete"]:
            cls.db.execute(re.search(r"create policy motorist_profiles_" + name + r"\n.*?;", policy, re.S).group())
        cls.db.execute((ROOT / "supabase/migrations/20260608124451_harden_motorist_rls_helpers.sql").read_text())
        cls.db.execute((ROOT / "supabase/migrations/20260929090000_profile_identity_boundary.sql").read_text())
        cls.db.execute((ROOT / "supabase/migrations/20260929100000_personal_notes.sql").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        with psycopg.connect(dbname="postgres", **LOCAL) as admin:
            admin.execute("drop database " + cls.name)

    def test_historical_admin_policy_cannot_change_private_record_identity(self):
        self.db.execute("set role authenticated")
        try:
            self.db.execute("select set_config('request.jwt.claim.sub',%s,false)", (ADMIN_USER,))
            for statement, params in [
                ("update motorist_profiles set user_id=%s where id=%s", (str(uuid4()), OWNER)),
                ("update motorist_profiles set organization_id=%s where id=%s", (str(uuid4()), OWNER)),
                ("update motorist_profiles set role='admin' where id=%s", (OWNER,)),
                ("delete from motorist_profiles where id=%s", (OWNER,)),
                ("insert into motorist_profiles(id,organization_id,user_id,role) values(%s,%s,%s,'admin')", (str(uuid4()), ORG, str(uuid4()))),
            ]:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    self.db.execute(statement, params)
            self.assertGreater(self.db.execute("select count(*) from motorist_profiles").fetchone()[0], 0)
        finally:
            self.db.execute("reset role")

    def test_private_notebook_stays_with_original_owner(self):
        self.db.execute("set role authenticated")
        try:
            self.db.execute("select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false)")
            note = self.db.execute("select motorist_notebook(%s,%s,'create',p_title=>'Owner test',p_body=>'Private fixture')", (ORG,OWNER)).fetchone()[0]
            self.db.execute("select set_config('request.jwt.claim.sub',%s,false)", (ADMIN_USER,))
            self.assertEqual(self.db.execute("select motorist_notebook(%s,%s,'list')", (ORG,ADMIN)).fetchone()[0], [])
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                self.db.execute("update motorist_profiles set user_id=%s where id=%s", (str(uuid4()), OWNER))
            self.assertEqual(self.db.execute("select motorist_notebook(%s,%s,'list')", (ORG,ADMIN)).fetchone()[0], [])
            self.db.execute("select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',false)")
            self.assertEqual(self.db.execute("select motorist_notebook(%s,%s,'get',%s)", (ORG,OWNER,note['id'])).fetchone()[0]['body'], "Private fixture")
        finally:
            self.db.execute("reset role")

    def test_column_grant_cannot_reopen_identity_writes(self):
        self.db.execute("grant update(user_id) on motorist_profiles to authenticated")
        self.db.execute("set role authenticated")
        try:
            self.db.execute("select set_config('request.jwt.claim.sub',%s,false)", (ADMIN_USER,))
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                self.db.execute("update motorist_profiles set user_id=%s where id=%s", (str(uuid4()), OWNER))
        finally:
            self.db.execute("reset role")
            self.db.execute("revoke update(user_id) on motorist_profiles from authenticated")

    def test_authorized_account_service_retains_management(self):
        # The real account API authorizes its actor before using service_role.
        self.db.execute("set role service_role")
        try:
            self.db.execute("update motorist_profiles set display_name='Authorized name' where id=%s", (OWNER,))
        finally:
            self.db.execute("reset role")
        self.assertEqual(self.db.execute("select display_name from motorist_profiles where id=%s", (OWNER,)).fetchone()[0], "Authorized name")

if __name__ == "__main__":
    unittest.main(verbosity=2)
