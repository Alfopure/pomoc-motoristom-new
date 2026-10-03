"""Exact endpoint migration and concurrent admission on disposable loopback PostgreSQL.

Requires PostgreSQL with btree_gist at 127.0.0.1:55432 and psycopg[binary].
Creates/drops only parallel_ring_endpoints; never reads application credentials.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import time

import psycopg

ROOT = Path(__file__).resolve().parents[2]
LOOPBACK_DSN = "host=127.0.0.1 hostaddr=127.0.0.1 port=55432 user=postgres connect_timeout=5"
DSN = f"{LOOPBACK_DSN} dbname=parallel_ring_endpoints"
ORG = "00000000-0000-4000-8000-000000000001"
OWNER = "00000000-0000-4000-8000-000000000011"
OTHER = "00000000-0000-4000-8000-000000000012"
SESSION = "00000000-0000-4000-8000-000000000021"
SESSION2 = "00000000-0000-4000-8000-000000000022"
MOBILE = "+421900000001"
MOBILE2 = "+421900000002"


def connect():
    return psycopg.connect(DSN, autocommit=True)


def attempt(c, kind="operator", owner=OWNER, session=SESSION, number=None, step=0, result="offered"):
    return c.execute("""insert into motorist_ring_attempts
        (organization_id, session_id, step_index, member_kind, profile_id, external_number, result)
        values (%s,%s,%s,%s,%s,%s,%s) returning id""",
        (ORG, session, step, kind, owner, number, result)).fetchone()[0]


def rejected(action, code):
    try:
        action()
    except psycopg.Error as error:
        assert error.sqlstate == code, (error.sqlstate, str(error))
    else:
        raise AssertionError(f"expected SQLSTATE {code}")


def presence(c, action, session=SESSION, token=None, status=None):
    return c.execute("""select motorist_presence_transition_v1(
        %s,%s,%s,%s,p_expected_token => %s,p_status => %s)""",
        (ORG, OWNER, action, session, token, status)).fetchone()[0]


def wait_for_lock(c, pid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if c.execute("select wait_event_type from pg_stat_activity where pid=%s", (pid,)).fetchone() == ("Lock",):
            return
        time.sleep(0.01)
    raise AssertionError("competing insert did not wait on the held transaction")


with psycopg.connect(f"{LOOPBACK_DSN} dbname=postgres", autocommit=True) as setup:
    setup.execute("drop database if exists parallel_ring_endpoints with (force)")
    setup.execute("create database parallel_ring_endpoints template template0 encoding 'UTF8'")

with connect() as c:
    # Use the exact original attempt table/index definitions. Other tables are
    # minimal FK/presence fixtures, not a complete Supabase schema reset.
    c.execute((ROOT / "tests/postgres/presence-fixture.sql").read_text())
    c.execute("""drop table motorist_ring_attempts;
        create table motorist_organizations(id uuid primary key);
        create table motorist_ring_groups(id uuid primary key);
        create table motorist_call_legs(id uuid primary key);
    """)
    foundation = (ROOT / "supabase/migrations/20260903100000_telnyx_telephony_foundation.sql").read_text()
    c.execute(foundation[foundation.index("create table if not exists public.motorist_ring_attempts ("):
        foundation.index("-- 9. Operator presence")].rsplit("-- ---------------------------------------------------------------------------", 1)[0])
    mobile = (ROOT / "supabase/migrations/20260928130000_personal_mobile_ownership.sql").read_text()
    c.execute(mobile[mobile.index("alter table public.motorist_ring_attempts drop constraint"):
        mobile.index("-- Keep the existing replace transaction")])
    c.execute((ROOT / "supabase/migrations/20260928100000_atomic_presence_contract.sql").read_text())
    c.execute("insert into motorist_organizations values(%s)", (ORG,))
    c.execute("insert into motorist_profiles values(%s,%s),(%s,%s)", (OWNER, ORG, OTHER, ORG))
    c.execute("insert into motorist_call_sessions(id,organization_id) values(%s,%s),(%s,%s)", (SESSION, ORG, SESSION2, ORG))
    c.execute("insert into motorist_operator_presence(organization_id,profile_id,status) values(%s,%s,'available')", (ORG, OWNER))
    legacy = attempt(c)
    before = c.execute("select to_jsonb(a) from motorist_ring_attempts a").fetchone()[0]
    c.execute((ROOT / "supabase/migrations/20261008130300_parallel_operator_ring_endpoints.sql").read_text())
    assert c.execute("select to_jsonb(a) from motorist_ring_attempts a").fetchone()[0] == before
    print("PASS exact migration preserves historical attempt data", flush=True)

    mobile_id = attempt(c, kind="external_number", number=MOBILE)
    assert c.execute("select count(*) from motorist_ring_attempts").fetchone()[0] == 2
    rejected(lambda: attempt(c), "23505")
    rejected(lambda: attempt(c, kind="external_number", number=MOBILE), "23505")
    rejected(lambda: attempt(c, step=1), "23505")
    rejected(lambda: attempt(c, kind="external_number", number=MOBILE, step=1), "23505")
    print("PASS web and mobile coexist; exact endpoint cannot duplicate within/across steps", flush=True)

    rejected(lambda: attempt(c, kind="external_number", session=SESSION2, number=MOBILE2), "23P01")
    rejected(lambda: c.execute("update motorist_ring_attempts set session_id=%s where id=%s", (SESSION2, mobile_id)), "23P01")
    assert str(c.execute("select session_id from motorist_ring_attempts where id=%s", (mobile_id,)).fetchone()[0]) == SESSION
    pending = attempt(c, kind="external_number", session=SESSION2, number=MOBILE2, result="pending")
    rejected(lambda: c.execute("update motorist_ring_attempts set result='offered' where id=%s", (pending,)), "23P01")
    print("PASS cross-session insert, session change and pending promotion rejected atomically", flush=True)

    c.execute("update motorist_ring_attempts set result='failed' where id=%s", (legacy,))
    rejected(lambda: attempt(c, session=SESSION2), "23P01")
    c.execute("update motorist_ring_attempts set result='cancelled' where id=%s", (mobile_id,))
    attempt(c, session=SESSION2)
    attempt(c, kind="external_number", owner=OTHER, number=MOBILE2)
    attempt(c, kind="external_number", owner=None, number=MOBILE, step=1)
    attempt(c, kind="external_number", owner=None, session=SESSION2, number=MOBILE, step=1)
    print("PASS remaining sibling blocks another caller; closing all releases admission; unowned numbers stay independent", flush=True)

    c.execute("truncate motorist_ring_attempts")
    first = presence(c, "dispatch")
    sibling = presence(c, "dispatch")
    assert first["applied"] and sibling["applied"] and sibling["reused"]
    assert first["offerToken"] == sibling["offerToken"]
    assert not presence(c, "dispatch", session=SESSION2)["applied"]
    sip_id = attempt(c)
    mobile_id = attempt(c, kind="external_number", number=MOBILE)
    paused = presence(c, "manual", session=None, status="paused")
    assert paused["applied"]
    assert c.execute("select count(*) from motorist_ring_attempts where result='cancelled'").fetchone()[0] == 2
    assert not presence(c, "answer", token=first["offerToken"])["applied"]
    print("PASS existing presence RPC shares one token, excludes other session and cancels both endpoints on pause", flush=True)

    # The second transaction is verified waiting on an actual PostgreSQL lock.
    # It must reject after the first commits, and succeed if the first rolls back.
    for commit in (True, False):
        c.execute("truncate motorist_ring_attempts")
        with connect() as held, connect() as competing, ThreadPoolExecutor(max_workers=1) as pool:
            held.execute("begin")
            attempt(held)
            competing_pid = competing.info.backend_pid

            def competing_insert():
                try:
                    attempt(competing, kind="external_number", session=SESSION2, number=MOBILE)
                    return "accepted"
                except psycopg.Error as error:
                    return error.sqlstate

            future = pool.submit(competing_insert)
            try:
                wait_for_lock(c, competing_pid)
            finally:
                held.execute("commit" if commit else "rollback")
            assert future.result(timeout=5) == ("23P01" if commit else "accepted")
    print("PASS concurrent other-session offer waits, rejects committed owner and proceeds after rollback", flush=True)

    c.execute("truncate motorist_ring_attempts")
    with connect() as held, connect() as sibling, ThreadPoolExecutor(max_workers=1) as pool:
        held.execute("begin")
        attempt(held)
        future = pool.submit(attempt, sibling, "external_number", OWNER, SESSION, MOBILE)
        try:
            assert future.result(timeout=5)
        finally:
            held.execute("commit")
    assert c.execute("select count(*) from motorist_ring_attempts where result='offered'").fetchone()[0] == 2
    print("PASS concurrent same-session endpoints both succeed without waiting for sibling commit", flush=True)

    print(c.execute("select version()").fetchone()[0], flush=True)
