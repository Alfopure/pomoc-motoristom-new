"""Pristavovač in the mobile app: field-member handoffs on a disposable loopback DB.

Builds the same minimal fixture as external-case-handoff.py, adds the real field
membership table and helpers from the towing migration, the push devices
migration and the new delivery migration, then checks permissions, the steps of
a delivery, positions and retention. No remote connection or application secret.
"""
from pathlib import Path
import hashlib
import json
import unittest
import uuid
import psycopg

ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host="127.0.0.1", hostaddr="127.0.0.1", port=55432, user="postgres", connect_timeout=5)
ORG = "10000000-0000-0000-0000-000000000001"
OTHER_ORG = "10000000-0000-0000-0000-000000000002"
A, B, C, OTHER = [f"20000000-0000-0000-0000-{i:012d}" for i in range(1, 5)]
TOWING = (ROOT / "supabase/migrations/20261013120000_towing_work_orders.sql").read_text()


def sql(path):
    return "\n".join(sql(path.parent / line[4:]) if line.startswith("\\ir ") else line for line in path.read_text().splitlines() if not line.startswith("\\set "))


def statement(start, end=None):
    """One statement of the towing migration, verbatim."""
    begin = TOWING.index(start)
    finish = TOWING.index(end, begin) + len(end) if end else TOWING.index(";\n", begin) + 1
    return TOWING[begin:finish]


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class DeliveryHandoffContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name = "delivery_handoff_" + uuid.uuid4().hex[:12]
        with psycopg.connect(dbname="postgres", autocommit=True, **LOCAL) as admin:
            admin.execute("create database " + cls.name)
        cls.db = psycopg.connect(dbname=cls.name, autocommit=True, **LOCAL)
        cls.db.execute(sql(ROOT / "tests/postgres/task-workspace-fixture.sql"))
        cls.db.execute("alter table motorist_profiles add column access_status text not null default 'active', add column kind text not null default 'human'; drop table motorist_task_reminders")
        cls.db.execute("""create function app_private.motorist_is_org_member(org uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
        select exists(select 1 from motorist_profiles p where p.organization_id=org and p.user_id=auth.uid() and p.active) $$;
        create function public.motorist_set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;""")
        for name in ["20260609110000_task_reminders_notifications.sql", "20260929120000_task_workspace.sql", "20260929130000_task_notification_privacy.sql"]:
            cls.db.execute(sql(ROOT / "supabase/migrations" / name))
        current = (ROOT / "supabase/migrations/20260929170000_domain_conflict_sqlstate.sql").read_text()
        cls.db.execute(current[current.index("CREATE OR REPLACE FUNCTION public.motorist_task_workspace("):current.rindex("commit;")])
        cls.db.execute(sql(ROOT / "supabase/migrations/20261001100000_task_review_workflow.sql"))
        cls.db.execute("""
        create table motorist_contacts(id uuid primary key,organization_id uuid,name text,phone text,email text,private_details jsonb);
        create table motorist_vehicles(id uuid primary key,organization_id uuid,make text,model text,license_plate text,vin text,private_details jsonb);
        create table motorist_locations(id uuid primary key,organization_id uuid,address text,lat numeric,lng numeric,notes text);
        alter table motorist_cases add column case_type text, add column contact_id uuid, add column vehicle_id uuid,
          add column pickup_location_id uuid, add column destination_location_id uuid,
          add column internal_note text, add column prices jsonb, add column attachments jsonb, add column transcript text,
          add column location_details jsonb;
        """)
        cls.db.execute(sql(ROOT / "supabase/migrations/20261001110000_external_case_handoff.sql"))
        cls.db.execute("""
        alter table motorist_cases add column created_at timestamptz default now(), add column assistance_reference text,
          add column customer_details jsonb, add column vehicle_details jsonb, add column incident_details jsonb,
          add column replacement_vehicle_details jsonb, add column selected_asset_id uuid;
        alter table motorist_vehicles add column color text, add column is_driveable boolean;
        create table motorist_fleet_assets(id uuid primary key,organization_id uuid,kind text,make text,model text,license_plate text,occupancy_case_id uuid,notes text);
        create table motorist_calls(id uuid primary key,organization_id uuid,case_id uuid,direction text,started_at timestamptz,transcript text);
        create table motorist_fleet_current_positions(id uuid primary key default gen_random_uuid(),organization_id uuid,fleet_asset_id uuid,gps_time timestamptz,lat numeric,lng numeric);
        """)
        cls.db.execute(sql(ROOT / "supabase/migrations/20261009100000_external_case_handoff_expansion.sql"))
        # Field memberships exactly as the towing migration defines them.
        cls.db.execute("create table auth.users(id uuid primary key)")
        cls.db.execute(statement("create table public.motorist_towing_memberships ("))
        cls.db.execute(statement("create or replace function app_private.towing_capabilities(", "\n$$;"))
        cls.db.execute(statement("create or replace function app_private.towing_authorize(", "end $$;"))
        cls.db.execute(sql(ROOT / "supabase/migrations/20261020210000_mobile_push_devices.sql"))
        cls.db.execute(sql(ROOT / "supabase/migrations/20261022100000_mobile_delivery_handoffs.sql"))
        cls.db.execute(sql(ROOT / "supabase/migrations/20261022180000_mobile_delivery_background.sql"))
        cls.members = {}
        for key, roles, org in [("pavol", ["delivery"], ORG), ("peter", ["delivery", "driver"], ORG), ("vodic", ["driver"], ORG), ("cudzi", ["delivery"], OTHER_ORG)]:
            user, member = str(uuid.uuid4()), str(uuid.uuid4())
            cls.db.execute("insert into auth.users values(%s)", (user,))
            cls.db.execute("""insert into motorist_towing_memberships(id,organization_id,auth_user_id,display_name,email,roles,capabilities)
              values(%s,%s,%s,%s,%s,%s,app_private.towing_capabilities(%s))""", (member, org, user, key.capitalize(), key + "@example.test", roles, roles))
            cls.members[key] = {"id": member, "user": user, "org": org}
        # A dispatcher who also delivers (one app with both modules), and one whose
        # linked office profile is disabled (not offered).
        for key, status in [("dvojity", "active"), ("kancelaria", "disabled")]:
            user, member, profile = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
            cls.db.execute("insert into auth.users values(%s)", (user,))
            cls.db.execute("insert into motorist_profiles(id,organization_id,user_id,role,display_name,access_status) values(%s,%s,%s,%s,%s,%s)",
                           (profile, ORG, user, "dispatcher" if key == "dvojity" else "viewer", key.capitalize(), status))
            cls.db.execute("""insert into motorist_towing_memberships(id,organization_id,auth_user_id,display_name,email,roles,capabilities,office_profile_id)
              values(%s,%s,%s,%s,%s,array['delivery'],app_private.towing_capabilities(array['delivery']),%s)""", (member, ORG, user, key.capitalize(), key + "@example.test", profile))
            cls.members[key] = {"id": member, "user": user, "org": ORG}

    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        with psycopg.connect(dbname="postgres", autocommit=True, **LOCAL) as admin:
            admin.execute("drop database " + cls.name)

    def client(self, role="authenticated", actor=A):
        conn = psycopg.connect(dbname=self.name, autocommit=True, **LOCAL)
        conn.execute("set role " + role)
        if role == "authenticated":
            conn.execute("select set_config('request.jwt.claim.sub',%s,false)", (actor.replace("20000000-", "30000000-"),))
        return conn

    def new_case(self, org=ORG):
        case, contact, vehicle, pickup, destination = [str(uuid.uuid4()) for _ in range(5)]
        self.db.execute("insert into motorist_contacts values(%s,%s,'Client','+421900000000','PRIVATE_EMAIL','{}')", (contact, org))
        self.db.execute("insert into motorist_vehicles(id,organization_id,make,model,license_plate,vin,private_details) values(%s,%s,'Skoda','Octavia','TEST001','PRIVATE_VIN','{}')", (vehicle, org))
        self.db.execute("insert into motorist_locations values(%s,%s,'Pickup address',48.1,17.1,'PRIVATE'),(%s,%s,'Destination address',48.2,17.2,'PRIVATE')", (pickup, org, destination, org))
        self.db.execute("""insert into motorist_cases(id,organization_id,case_number,status,case_type,contact_id,vehicle_id,pickup_location_id,destination_location_id,replacement_vehicle_details)
        values(%s,%s,'PM-2026-0042','open','Pristavenie náhradného vozidla',%s,%s,%s,%s,'{"needed":true,"deliveryPlace":"Hlavná 1, Žilina"}')""", (case, org, contact, vehicle, pickup, destination))
        return case

    def internal(self, case, action, data=None, actor=A, org=ORG):
        with self.client(actor=actor) as client:
            return client.execute("select motorist_case_handoff(%s,%s,%s,%s,%s::jsonb)", (org, actor, case, action, json.dumps(data or {}))).fetchone()[0]

    def app(self, case, action, data=None, actor=A, org=ORG, conn=None):
        args = (org, actor, case, action, json.dumps(data or {}))
        if conn:
            return conn.execute("select motorist_case_handoff_app(%s,%s,%s,%s,%s::jsonb)", args).fetchone()[0]
        with self.client(actor=actor) as client:
            return client.execute("select motorist_case_handoff_app(%s,%s,%s,%s,%s::jsonb)", args).fetchone()[0]

    def member(self, key, action, data=None, version=None, conn=None):
        m = self.members[key]
        version = version if version is not None else self.db.execute("select membership_version from motorist_towing_memberships where id=%s", (m["id"],)).fetchone()[0]
        args = (m["user"], m["org"], version, action, json.dumps(data or {}))
        if conn:
            return conn.execute("select motorist_member_handoff(%s,%s,%s,%s,%s::jsonb)", args).fetchone()[0]
        with self.client("service_role") as client:
            return client.execute("select motorist_member_handoff(%s,%s,%s,%s,%s::jsonb)", args).fetchone()[0]

    def issue(self, case=None):
        case = case or self.new_case()
        context = self.internal(case, "context")
        command = {"commandId": str(uuid.uuid4()), "previewVersion": context["previewVersion"], "recipientName": "Pavol", "recipientPhone": "+421900000111",
                   "instructions": "Kľúče sú na vrátnici", "hours": 24, "tokenHash": digest("grant-" + uuid.uuid4().hex)}
        return case, self.internal(case, "issue", command)["handoff"]

    def sent(self, key="pavol"):
        case, handoff = self.issue()
        result = self.app(case, "assign", {"handoffId": handoff["id"], "memberId": self.members[key]["id"], "commandId": str(uuid.uuid4())})
        return case, result["handoff"]

    def step(self, key, handoff, action, **fields):
        command = {"handoffId": handoff["id"], "action": action, "commandId": str(uuid.uuid4()), "expectedRevision": handoff["revision"], "publishedVersion": handoff["publishedVersion"], **fields}
        return self.member(key, "command", command)

    def rejected(self, code, fn):
        with self.assertRaises(psycopg.Error) as error:
            fn()
        self.assertEqual(error.exception.sqlstate, code)

    def test_01_delivery_role_and_capability(self):
        self.assertEqual(self.db.execute("select capabilities from motorist_towing_memberships where id=%s", (self.members["pavol"]["id"],)).fetchone()[0], ["deliver"])
        self.assertEqual(sorted(self.db.execute("select capabilities from motorist_towing_memberships where id=%s", (self.members["peter"]["id"],)).fetchone()[0]), ["deliver", "drive"])
        self.rejected("23514", lambda: self.db.execute("insert into motorist_towing_memberships(id,organization_id,auth_user_id,display_name,roles,capabilities) values(gen_random_uuid(),%s,%s,'X',array['courier'],'{}')", (ORG, self.members["pavol"]["user"])))

    def test_02_dispatcher_lists_delivery_members_of_own_organization(self):
        members = self.app(self.new_case(), "members")["members"]
        # Without the delivery role, from another organization or with a disabled office profile: not offered.
        # A dispatcher who also delivers is offered: the one app shows them both modules.
        self.assertEqual([m["displayName"] for m in members], ["Dvojity", "Pavol", "Peter"])
        self.assertTrue(all(set(m) == {"id", "displayName", "lastPhone"} for m in members))
        self.sent("pavol")
        last = {m["displayName"]: m["lastPhone"] for m in self.app(self.new_case(), "members")["members"]}
        self.assertEqual(last["Pavol"], "+421900000111")

    def test_03_assign_is_idempotent_and_limited(self):
        case, handoff = self.issue()
        command = {"handoffId": handoff["id"], "memberId": self.members["pavol"]["id"], "commandId": str(uuid.uuid4())}
        self.rejected("PT409", lambda: self.app(case, "assign", {**command, "expectedRevision": 7}))
        first = self.app(case, "assign", {**command, "expectedRevision": 1})
        self.assertTrue(first["assigned"])
        self.assertNotIn("recipientMemberId", first["handoff"])
        self.assertEqual(self.app(case, "app")["handoffs"], [{"handoffId": handoff["id"], "memberId": self.members["pavol"]["id"], "position": None}])
        self.assertFalse(self.app(case, "assign", command)["assigned"])
        self.rejected("PT409", lambda: self.app(case, "assign", {**command, "memberId": self.members["peter"]["id"]}))
        # The same pristavovač again after they accepted: nothing changes, no error.
        self.step("pavol", first["handoff"], "accept")
        self.assertFalse(self.app(case, "assign", command)["assigned"])
        other_case, other = self.issue()
        self.rejected("22023", lambda: self.app(other_case, "assign", {"handoffId": other["id"], "memberId": self.members["vodic"]["id"], "commandId": str(uuid.uuid4())}))
        self.rejected("22023", lambda: self.app(other_case, "assign", {"handoffId": other["id"], "memberId": self.members["cudzi"]["id"], "commandId": str(uuid.uuid4())}))
        self.rejected("22023", lambda: self.app(other_case, "assign", {"handoffId": other["id"], "memberId": self.members["kancelaria"]["id"], "commandId": str(uuid.uuid4())}))
        self.assertTrue(self.app(other_case, "assign", {"handoffId": other["id"], "memberId": self.members["dvojity"]["id"], "commandId": str(uuid.uuid4())})["assigned"])
        self.rejected("P0002", lambda: self.app(self.new_case(), "assign", {"handoffId": other["id"], "memberId": self.members["pavol"]["id"], "commandId": str(uuid.uuid4())}))
        # Recorded as an ordinary update without the name: the link holder reads it too.
        events = self.db.execute("select action,comment,actor_profile_id from motorist_handoff_events where handoff_id=%s and actor_profile_id is not null and action<>'issue'", (handoff["id"],)).fetchall()
        self.assertEqual(events, [("update", "Odoslané do aplikácie pristavovača", uuid.UUID(A))])

    def test_04_only_dispatchers_may_use_the_dispatch_side(self):
        case, handoff = self.issue()
        with self.client(actor=OTHER) as client:
            self.rejected("42501", lambda: self.app(case, "members", actor=OTHER, conn=client))
        with self.client("authenticated", actor=A) as client:
            client.execute("select set_config('request.jwt.claim.sub',%s,false)", (self.members["pavol"]["user"],))
            self.rejected("42501", lambda: self.app(case, "members", conn=client))
            self.rejected("42501", lambda: client.execute("select motorist_member_handoff(%s,%s,1,'list','{}')", (self.members["pavol"]["user"], ORG)))
            self.rejected("42501", lambda: client.execute("select * from motorist_handoff_positions"))
        with self.client("anon") as client:
            self.rejected("42501", lambda: client.execute("select motorist_case_handoff_app(%s,%s,%s,'members','{}')", (ORG, A, case)))
        with self.client("service_role") as client:
            self.rejected("42501", lambda: client.execute("select * from motorist_handoff_positions"))

    def test_05_member_sees_only_own_deliveries(self):
        case, handoff = self.sent("pavol")
        ids = [h["id"] for h in self.member("pavol", "list")["handoffs"]]
        self.assertIn(handoff["id"], ids)
        self.assertNotIn(handoff["id"], [h["id"] for h in self.member("peter", "list")["handoffs"]])
        self.rejected("P0002", lambda: self.member("peter", "read", {"handoffId": handoff["id"]}))
        self.rejected("42501", lambda: self.member("vodic", "list"))
        self.rejected("42501", lambda: self.member("pavol", "list", version=999))
        self.db.execute("update motorist_towing_memberships set active=false where id=%s", (self.members["peter"]["id"],))
        try:
            self.rejected("42501", lambda: self.member("peter", "list"))
        finally:
            self.db.execute("update motorist_towing_memberships set active=true where id=%s", (self.members["peter"]["id"],))

    def test_06_reading_opens_and_shows_the_card_without_private_data(self):
        case, handoff = self.sent("pavol")
        view = self.member("pavol", "read", {"handoffId": handoff["id"]})["handoff"]
        self.assertEqual(view["caseNumber"], "PM-2026-0042")
        self.assertIsNotNone(view["openedAt"])
        self.assertEqual(view["published"]["replacement"]["deliveryPlace"], "Hlavná 1, Žilina")
        self.assertEqual(view["published"]["instructions"], "Kľúče sú na vrátnici")
        self.assertNotIn("recipientPhone", view)
        self.assertNotIn("PRIVATE", json.dumps(view))
        self.assertIsNone(view["replacementPosition"])
        self.assertFalse(view["tracking"])

    def test_07_assigned_replacement_car_position_while_open(self):
        case = self.new_case()
        car = str(uuid.uuid4())
        self.db.execute("insert into motorist_fleet_assets values(%s,%s,'replacement_car','VW','Golf','ZA123AB',%s,'')", (car, ORG, case))
        self.db.execute("insert into motorist_fleet_current_positions(organization_id,fleet_asset_id,gps_time,lat,lng) values(%s,%s,now()-interval '5 minutes',49.2,18.7)", (ORG, car))
        _, handoff = self.issue(case)
        handoff = self.app(case, "assign", {"handoffId": handoff["id"], "memberId": self.members["pavol"]["id"], "commandId": str(uuid.uuid4())})["handoff"]
        view = self.member("pavol", "read", {"handoffId": handoff["id"]})["handoff"]
        self.assertEqual((float(view["replacementPosition"]["lat"]), float(view["replacementPosition"]["lng"])), (49.2, 18.7))
        self.assertEqual(view["published"]["replacement"]["vehicle"]["plate"], "ZA123AB")
        # Two candidate cars are ambiguous: no position is guessed.
        self.db.execute("insert into motorist_fleet_assets values(%s,%s,'replacement_car','VW','Polo','ZA999ZZ',%s,'')", (str(uuid.uuid4()), ORG, case))
        self.assertIsNone(self.member("pavol", "read", {"handoffId": handoff["id"]})["handoff"]["replacementPosition"])

    def test_08_delivery_steps_receipts_and_dispatcher_notice(self):
        case, handoff = self.sent("pavol")
        accepted = self.step("pavol", handoff, "accept")
        self.assertEqual(accepted["handoff"]["status"], "accepted")
        command = {"handoffId": handoff["id"], "action": "accept", "commandId": accepted["commandId"], "expectedRevision": handoff["revision"], "publishedVersion": handoff["publishedVersion"]}
        self.assertEqual(self.member("pavol", "command", command)["committedRevision"], accepted["committedRevision"])
        self.rejected("PT409", lambda: self.member("pavol", "command", {**command, "action": "reject", "comment": "x"}))
        self.rejected("PT409", lambda: self.step("pavol", handoff, "en_route"))
        state = accepted["handoff"]
        for action, expected in [("en_route", "en_route"), ("arrived", "arrived"), ("complete", "completed")]:
            state = self.step("pavol", state, action)["handoff"]
            self.assertEqual(state["status"], expected)
        self.assertIsNone(state["published"])
        internal = self.internal(case, "context")["handoffs"][0]
        self.assertEqual([e["actor"] for e in internal["events"] if e["action"] in ("accept", "complete")], ["Pristavovač", "Pristavovač"])
        notices = self.db.execute("select title,body from motorist_notifications where case_id=%s and payload->>'source'='case_handoff' order by created_at", (case,)).fetchall()
        self.assertEqual(notices[0], ("Pristavenie v aplikácii", "Pavol: prijaté"))
        self.assertEqual(len(notices), 4)
        listed = {h["id"]: h for h in self.member("pavol", "list")["handoffs"]}
        self.assertEqual(listed[handoff["id"]]["caseNumber"], "PM-2026-0042")

    def test_09_reject_needs_a_reason(self):
        _, handoff = self.sent("pavol")
        self.rejected("22023", lambda: self.step("pavol", handoff, "reject", comment=""))
        self.assertEqual(self.step("pavol", handoff, "reject", comment="Nemám auto")["handoff"]["status"], "rejected")

    def test_10_positions_only_during_the_delivery_throttled_and_kept_30_days(self):
        case, handoff = self.sent("pavol")
        now = self.db.execute("select now()").fetchone()[0]
        ping = lambda when, lat=49.0, lng=18.0, **extra: self.member("pavol", "position", {"handoffId": handoff["id"], "lat": lat, "lng": lng, "accuracy": 12, "recordedAt": when.isoformat(), **extra})
        self.assertEqual(ping(now), {"stored": False, "active": False})
        state = self.step("pavol", handoff, "accept")["handoff"]
        self.assertTrue(state["tracking"])
        self.assertEqual(ping(now), {"stored": True, "active": True})
        self.assertEqual(ping(now), {"stored": False, "active": True})
        self.assertEqual(ping(now.replace(year=now.year - 1)), {"stored": False, "active": True})
        self.rejected("22023", lambda: ping(now, lat=95))
        self.db.execute("update motorist_handoff_positions set recorded_at=recorded_at-interval '1 minute' where handoff_id=%s", (handoff["id"],))
        self.assertTrue(ping(now, lat=49.5)["stored"])
        entries = self.app(case, "app")["handoffs"]
        self.assertEqual([(e["handoffId"], round(e["position"]["lat"], 1), e["position"]["accuracy"]) for e in entries], [(handoff["id"], 49.5, 12)])
        for action in ["en_route", "arrived", "complete"]:
            state = self.step("pavol", state, action)["handoff"]
        # After the delivery the phone is told to stop and the dispatcher no longer sees a position.
        self.assertEqual(ping(now.replace(microsecond=0)), {"stored": False, "active": False})
        self.assertIsNone(self.app(case, "app")["handoffs"][0]["position"])
        self.db.execute("update motorist_handoff_positions set received_at=now()-interval '31 days' where handoff_id=%s and lat<49.2", (handoff["id"],))
        with self.client("service_role") as client:
            self.assertEqual(client.execute("select motorist_handoff_positions_prune()").fetchone()[0], 1)
        self.assertEqual(self.db.execute("select count(*) from motorist_handoff_positions where handoff_id=%s", (handoff["id"],)).fetchone()[0], 1)

    def test_11_push_devices_belong_to_a_person(self):
        member = self.members["pavol"]
        self.db.execute("""insert into motorist_mobile_push_devices(organization_id,member_id,environment,installation_id,expo_push_token,platform)
          values(%s,%s,'test',gen_random_uuid(),'ExponentPushToken[pavolpavolpavol]','ios')""", (ORG, member["id"]))
        self.rejected("23514", lambda: self.db.execute("""insert into motorist_mobile_push_devices(organization_id,environment,installation_id,expo_push_token,platform)
          values(%s,'test',gen_random_uuid(),'ExponentPushToken[nobodynobodynob]','ios')""", (ORG,)))

    def test_13_closed_deliveries_keep_no_customer_data(self):
        case, handoff = self.sent("pavol")
        accepted = self.step("pavol", handoff, "accept")["handoff"]
        self.step("pavol", accepted, "blocked", comment="Klient nedvíha")
        self.internal(case, "revoke", {"commandId": str(uuid.uuid4()), "handoffId": handoff["id"], "expectedRevision": accepted["revision"] + 1, "comment": "Klient PRIVATE zrušil"})
        view = self.member("pavol", "read", {"handoffId": handoff["id"]})["handoff"]
        self.assertEqual(view["status"], "cancelled")
        self.assertIsNone(view["published"])
        self.assertIsNone(view["replacementPosition"])
        self.assertFalse(view["tracking"])
        self.assertNotIn("PRIVATE", json.dumps(view))
        self.assertIn("Klient nedvíha", [e["comment"] for e in view["events"]])
        listed = {h["id"]: h for h in self.member("pavol", "list")["handoffs"]}
        self.assertIsNone(listed[handoff["id"]]["published"])
        # Expired by time: the same, though the link would also refuse it.
        case2, other = self.sent("pavol")
        self.db.execute("update motorist_case_handoffs set expires_at=now()-interval '1 minute' where id=%s", (other["id"],))
        expired = self.member("pavol", "read", {"handoffId": other["id"]})["handoff"]
        self.assertEqual((expired["status"], expired["published"]), ("expired", None))
        # A day after closing it is gone from the list and cannot be opened.
        self.db.execute("update motorist_case_handoffs set updated_at=now()-interval '25 hours' where id=%s", (handoff["id"],))
        self.db.execute("update motorist_case_handoffs set expires_at=now()-interval '25 hours' where id=%s", (other["id"],))
        self.rejected("P0002", lambda: self.member("pavol", "read", {"handoffId": handoff["id"]}))
        self.rejected("P0002", lambda: self.member("pavol", "read", {"handoffId": other["id"]}))
        ids = [h["id"] for h in self.member("pavol", "list")["handoffs"]]
        self.assertNotIn(handoff["id"], ids)
        self.assertNotIn(other["id"], ids)

    def test_16_an_old_expired_delivery_does_not_come_back(self):
        case, handoff = self.sent("pavol")
        self.db.execute("update motorist_case_handoffs set expires_at=now()-interval '3 days' where id=%s", (handoff["id"],))
        # A new handoff on the same case marks the old one expired now; its day still counts from the expiry.
        self.issue(case)
        status = self.db.execute("select status,updated_at>now()-interval '1 minute' from motorist_case_handoffs where id=%s", (handoff["id"],)).fetchone()
        self.assertEqual(status, ("expired", True))
        self.assertNotIn(handoff["id"], [h["id"] for h in self.member("pavol", "list")["handoffs"]])
        self.rejected("P0002", lambda: self.member("pavol", "read", {"handoffId": handoff["id"]}))

    def test_17_background_secret_sends_batches_until_the_delivery_ends(self):
        case, handoff = self.sent("pavol")
        secret = lambda: digest("tracker-" + uuid.uuid4().hex)
        first = secret()
        self.rejected("PT409", lambda: self.member("pavol", "tracker", {"handoffId": handoff["id"], "tokenHash": first}))
        state = self.step("pavol", handoff, "accept")["handoff"]
        self.rejected("22023", lambda: self.member("pavol", "tracker", {"handoffId": handoff["id"], "tokenHash": "x"}))
        self.assertIn("expiresAt", self.member("pavol", "tracker", {"handoffId": handoff["id"], "tokenHash": first}))
        now = self.db.execute("select now()").fetchone()[0]
        reading = lambda when, lat=49.0: {"lat": lat, "lng": 18.0, "accuracy": 20, "recordedAt": when.isoformat()}
        track = lambda token, batch: self.db.execute("select motorist_handoff_track(%s,%s::jsonb)", (token, json.dumps(batch))).fetchone()[0]
        from datetime import timedelta
        # Kept while offline: two readings 15 s apart are stored, one from before the step is not.
        batch = [reading(now - timedelta(minutes=30)), reading(now + timedelta(seconds=1), 49.1), reading(now + timedelta(seconds=16), 49.2)]
        self.assertEqual(track(first, batch), {"stored": 2, "active": True})
        self.assertEqual(track(first, [reading(now + timedelta(seconds=20))]), {"stored": 0, "active": True})
        self.rejected("22023", lambda: track(first, []))
        self.rejected("22023", lambda: track(first, [{**reading(now), "lat": 91}]))
        self.assertEqual(track(digest("unknown"), [reading(now)]), {"stored": 0, "active": False})
        # A new secret replaces the old one; logout revokes it.
        second = secret()
        self.member("pavol", "tracker", {"handoffId": handoff["id"], "tokenHash": second})
        self.assertEqual(track(first, [reading(now + timedelta(seconds=40))]), {"stored": 0, "active": False})
        self.assertEqual(track(second, [reading(now + timedelta(seconds=40))])["active"], True)
        self.assertEqual(self.member("pavol", "untrack", {"handoffId": handoff["id"]}), {"revoked": True})
        self.assertEqual(track(second, [reading(now + timedelta(seconds=60))])["active"], False)
        # The end of the delivery stops the phone and revokes the secret.
        third = secret()
        self.member("pavol", "tracker", {"handoffId": handoff["id"], "tokenHash": third})
        for action in ["en_route", "arrived", "complete"]:
            state = self.step("pavol", state, action)["handoff"]
        self.assertEqual(track(third, [reading(now + timedelta(seconds=80))]), {"stored": 0, "active": False})
        self.assertIsNotNone(self.db.execute("select revoked_at from motorist_handoff_trackers where token_hash=%s", (third,)).fetchone()[0])
        # Only the server may call it.
        with self.client() as client:
            self.rejected("42501", lambda: client.execute("select motorist_handoff_track(%s,'[]'::jsonb)", (third,)))
            self.rejected("42501", lambda: client.execute("select * from motorist_handoff_trackers"))

    def test_20_an_extended_delivery_keeps_its_background_secret(self):
        case, handoff = self.sent("pavol")
        self.step("pavol", handoff, "accept")
        # About to expire when the secret is issued; the dispatcher then extends it.
        self.db.execute("update motorist_case_handoffs set expires_at=now()+interval '2 minutes' where id=%s", (handoff["id"],))
        token = digest("tracker-" + uuid.uuid4().hex)
        self.member("pavol", "tracker", {"handoffId": handoff["id"], "tokenHash": token})
        self.db.execute("update motorist_case_handoffs set expires_at=now()+interval '2 days' where id=%s", (handoff["id"],))
        expires = self.db.execute("select expires_at>now()+interval '7 days' from motorist_handoff_trackers where token_hash=%s", (token,)).fetchone()[0]
        self.assertTrue(expires)
        now = self.db.execute("select now()").fetchone()[0]
        result = self.db.execute("select motorist_handoff_track(%s,%s::jsonb)", (token, json.dumps([{"lat": 49, "lng": 18, "accuracy": None, "recordedAt": now.isoformat()}]))).fetchone()[0]
        self.assertEqual(result, {"stored": 1, "active": True})

    def test_18_lost_access_stops_the_background_secret(self):
        case, handoff = self.sent("peter")
        self.step("peter", handoff, "accept")
        token = digest("tracker-" + uuid.uuid4().hex)
        self.member("peter", "tracker", {"handoffId": handoff["id"], "tokenHash": token})
        now = self.db.execute("select now()").fetchone()[0]
        self.db.execute("update motorist_towing_memberships set active=false where id=%s", (self.members["peter"]["id"],))
        try:
            result = self.db.execute("select motorist_handoff_track(%s,%s::jsonb)", (token, json.dumps([{"lat": 49, "lng": 18, "accuracy": None, "recordedAt": now.isoformat()}]))).fetchone()[0]
            self.assertEqual(result, {"stored": 0, "active": False})
        finally:
            self.db.execute("update motorist_towing_memberships set active=true where id=%s", (self.members["peter"]["id"],))

    def test_19_one_phone_may_belong_to_both_roles_and_old_secrets_go(self):
        member = self.members["dvojity"]
        profile = self.db.execute("select office_profile_id from motorist_towing_memberships where id=%s", (member["id"],)).fetchone()[0]
        self.db.execute("""insert into motorist_mobile_push_devices(organization_id,profile_id,member_id,environment,installation_id,expo_push_token,platform)
          values(%s,%s,%s,'test',gen_random_uuid(),'ExponentPushToken[bothrolesphone]','ios')""", (ORG, profile, member["id"]))
        self.rejected("23514", lambda: self.db.execute("""insert into motorist_mobile_push_devices(organization_id,environment,installation_id,expo_push_token,platform)
          values(%s,'test',gen_random_uuid(),'ExponentPushToken[nobodyatallxx]','ios')""", (ORG,)))
        case, handoff = self.sent("pavol")
        self.step("pavol", handoff, "accept")
        token = digest("old-" + uuid.uuid4().hex)
        self.member("pavol", "tracker", {"handoffId": handoff["id"], "tokenHash": token})
        self.db.execute("update motorist_handoff_trackers set revoked_at=now()-interval '31 days' where token_hash=%s", (token,))
        with self.client("service_role") as client:
            client.execute("select motorist_handoff_positions_prune()")
        self.assertIsNone(self.db.execute("select id from motorist_handoff_trackers where token_hash=%s", (token,)).fetchone())

    def test_14_position_only_from_the_pristavovac_who_took_a_step(self):
        case, handoff = self.sent("pavol")
        token = self.db.execute("select token_hash from motorist_case_handoffs where id=%s", (handoff["id"],)).fetchone()[0]
        with self.client("service_role") as client:
            session = digest("session-" + uuid.uuid4().hex)
            opened = client.execute("select motorist_public_handoff('session',%s,%s::jsonb)", (token, json.dumps({"sessionHash": session}))).fetchone()[0]["handoff"]
            accept = {"handoffId": handoff["id"], "commandId": str(uuid.uuid4()), "action": "accept", "expectedRevision": opened["revision"], "publishedVersion": opened["publishedVersion"]}
            client.execute("select motorist_public_handoff('command',%s,%s::jsonb)", (session, json.dumps(accept)))
        now = self.db.execute("select now()").fetchone()[0]
        ping = lambda: self.member("pavol", "position", {"handoffId": handoff["id"], "lat": 49.0, "lng": 18.0, "accuracy": None, "recordedAt": now.isoformat()})
        view = self.member("pavol", "read", {"handoffId": handoff["id"]})["handoff"]
        # Accepted through the link: the app does not share this pristavovač's position.
        self.assertEqual((view["status"], view["tracking"]), ("accepted", False))
        self.assertEqual(ping(), {"stored": False, "active": False})
        state = self.step("pavol", view, "en_route")["handoff"]
        self.assertTrue(state["tracking"])
        self.assertEqual(ping(), {"stored": True, "active": True})
        # Another member never shares a position for it.
        self.rejected("P0002", lambda: self.member("peter", "position", {"handoffId": handoff["id"], "lat": 49.0, "lng": 18.0, "accuracy": None, "recordedAt": now.isoformat()}))

    def test_15_dispatch_view_keeps_its_fields(self):
        case, handoff = self.sent("pavol")
        self.step("pavol", handoff, "accept")
        grant = self.internal(case, "context")["handoffs"][0]
        self.assertEqual(set(grant), {"id", "status", "revision", "publishedVersion", "recipientName", "expiresAt", "createdAt", "openedAt", "eta", "createdBy",
                                      "publishedAt", "published", "events", "recipientPhone", "canRenew", "tokenGeneration", "recoverable"})
        self.assertTrue(set(e["action"] for e in grant["events"]) <= {"issue", "update", "accept"})

    def test_12_public_link_still_works_beside_the_app(self):
        case, handoff = self.sent("pavol")
        token = self.db.execute("select token_hash from motorist_case_handoffs where id=%s", (handoff["id"],)).fetchone()[0]
        with self.client("service_role") as client:
            session = digest("session-" + uuid.uuid4().hex)
            opened = client.execute("select motorist_public_handoff('session',%s,%s::jsonb)", (token, json.dumps({"sessionHash": session}))).fetchone()[0]["handoff"]
        self.assertEqual(opened["status"], "offered")
        self.assertEqual(self.step("pavol", opened, "accept")["handoff"]["status"], "accepted")


if __name__ == "__main__":
    unittest.main(verbosity=2)
