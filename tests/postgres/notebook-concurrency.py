"""Exact notebook RPC races on a disposable loopback database; never reads env URLs."""
from pathlib import Path
import threading
import time
import psycopg

ROOT = Path(__file__).resolve().parents[2]
CONFIG = dict(host="127.0.0.1", port=55432, user="postgres")
ORG = "10000000-0000-0000-0000-000000000001"
A = "20000000-0000-0000-0000-000000000001"
B = "20000000-0000-0000-0000-000000000002"
USER_A = "30000000-0000-0000-0000-000000000001"
USER_B = "30000000-0000-0000-0000-000000000002"

with psycopg.connect(dbname="postgres", autocommit=True, **CONFIG) as admin:
    admin.execute("drop database if exists notebook_race")
    admin.execute("create database notebook_race")
with psycopg.connect(dbname="notebook_race", autocommit=True, **CONFIG) as setup:
    setup.execute((ROOT / "tests/postgres/notebook-fixture.sql").read_text())
    setup.execute((ROOT / "supabase/migrations/20260929100000_personal_notes.sql").read_text())


def actor(user):
    conn = psycopg.connect(dbname="notebook_race", **CONFIG)
    conn.execute("set role authenticated")
    conn.execute("select set_config('request.jwt.claim.sub', %s, false)", (user,))
    conn.commit()
    return conn


def rpc(conn, profile, action, note_id=None, revision=None, recipients=None):
    return conn.execute("select public.motorist_notebook(%s,%s,%s,%s,%s,%s,%s,%s::uuid[])",
                        (ORG, profile, action, note_id, revision, "Title", "PRIVATE_BODY", recipients or [])).fetchone()[0]


def wait_for_lock(pid):
    deadline = time.monotonic() + 5
    with psycopg.connect(dbname="notebook_race", autocommit=True, **CONFIG) as observer:
        while time.monotonic() < deadline:
            row = observer.execute("select wait_event_type from pg_stat_activity where pid=%s", (pid,)).fetchone()
            if row and row[0] == "Lock":
                return
            time.sleep(.01)
    raise AssertionError("Second transaction did not wait on note lock")


def blocked_call(conn, profile, action, note_id, revision, results):
    try:
        results.append(rpc(conn, profile, action, note_id, revision))
        conn.commit()
    except psycopg.Error as error:
        conn.rollback()
        results.append(error.sqlstate)


with actor(USER_A) as first, actor(USER_A) as second:
    note = rpc(first, A, "create")
    first.commit()
    assert rpc(first, A, "save", note["id"], 1)["revision"] == 2
    results = []
    thread = threading.Thread(target=blocked_call, args=(second, A, "save", note["id"], 1, results))
    thread.start()
    wait_for_lock(second.info.backend_pid)
    first.commit()
    thread.join(5)
    assert not thread.is_alive() and results == ["40001"], results
    assert rpc(first, A, "get", note["id"])["revision"] == 2
    first.commit()
    print("PASS: concurrent saves serialize and stale writer conflicts")

with actor(USER_A) as owner, actor(USER_B) as recipient:
    note = rpc(owner, A, "create", recipients=[B])
    owner.commit()
    assert rpc(recipient, B, "get", note["id"])["body"] == "PRIVATE_BODY"
    recipient.commit()
    rpc(owner, A, "save", note["id"], 1, [])  # revocation remains uncommitted
    results = []
    thread = threading.Thread(target=blocked_call, args=(recipient, B, "get", note["id"], None, results))
    thread.start()
    wait_for_lock(recipient.info.backend_pid)
    owner.commit()
    thread.join(5)
    assert not thread.is_alive() and results == ["P0002"], results
    assert recipient.execute("select count(*) from public.motorist_notes where id=%s", (note["id"],)).fetchone()[0] == 0
    print("PASS: read waiting behind share revocation rechecks current ACL")
