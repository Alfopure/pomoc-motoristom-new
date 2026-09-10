"""Task CAS and chat races in a separate disposable loopback database."""
from pathlib import Path
import threading
import time
import psycopg
ROOT = Path(__file__).resolve().parents[2]
CONFIG = dict(host="127.0.0.1", port=55432, user="postgres")
ORG = "10000000-0000-0000-0000-000000000001"
A = "20000000-0000-0000-0000-000000000001"
USER_A = "30000000-0000-0000-0000-000000000001"

def sql(path):
    return "\n".join(sql(path.parent / line[4:]) if line.startswith("\\ir ") else line for line in path.read_text().splitlines())

with psycopg.connect(dbname="postgres", autocommit=True, **CONFIG) as admin:
    admin.execute("drop database if exists task_workspace_race")
    admin.execute("create database task_workspace_race")
with psycopg.connect(dbname="task_workspace_race", autocommit=True, **CONFIG) as setup:
    setup.execute(sql(ROOT / "tests/postgres/task-workspace-fixture.sql"))
    setup.execute(sql(ROOT / "supabase/migrations/20260929120000_task_workspace.sql"))
    setup.execute("update motorist_task_workspace_settings set enabled=true,writer_inventory_verified_at=now(),writer_inventory_note='Isolated test only'")

def actor():
    conn = psycopg.connect(dbname="task_workspace_race", **CONFIG)
    conn.execute("set role authenticated")
    conn.execute("select set_config('request.jwt.claim.sub', %s, false)", (USER_A,))
    conn.commit()
    return conn

def rpc(conn, action, task_id=None, data=None):
    import json
    return conn.execute("select public.motorist_task_workspace(%s,%s,%s,%s,%s::jsonb)", (ORG,A,action,task_id,json.dumps(data or {}))).fetchone()[0]

def wait_for_lock(pid):
    deadline = time.monotonic() + 5
    with psycopg.connect(dbname="task_workspace_race", autocommit=True, **CONFIG) as observer:
        while time.monotonic() < deadline:
            row = observer.execute("select wait_event_type from pg_stat_activity where pid=%s", (pid,)).fetchone()
            if row and row[0] == "Lock": return
            time.sleep(.01)
    raise AssertionError("No observed task row lock")

def pending(conn, action, task_id, data, results):
    try:
        results.append(rpc(conn,action,task_id,data)); conn.commit()
    except psycopg.Error as error:
        results.append(error.sqlstate); conn.rollback()

with actor() as first, actor() as second:
    task = rpc(first,"create",data={"title":"Team", "caseIds":[]}); first.commit()
    changed = rpc(first,"update",task["id"],{"title":"First", "expectedRevision":task["revision"]})
    results = []
    thread = threading.Thread(target=pending,args=(second,"update",task["id"],{"title":"Stale", "expectedRevision":task["revision"]},results))
    thread.start(); wait_for_lock(second.info.backend_pid); first.commit(); thread.join(5)
    assert not thread.is_alive() and results == ["40001"],results
    assert rpc(first,"get",task["id"])["title"] == "First"; first.commit()
    print("PASS: task stale writer waits then conflicts without partial state")
    data = {"body":"One message", "clientMessageId":"80000000-0000-0000-0000-000000000001"}
    message = rpc(first,"send_message",task["id"],data)
    results = []
    thread = threading.Thread(target=pending,args=(second,"send_message",task["id"],data,results))
    thread.start(); wait_for_lock(second.info.backend_pid); first.commit(); thread.join(5)
    assert not thread.is_alive() and results[0]["id"] == message["id"],results
    assert len(rpc(first,"messages",task["id"])["messages"]) == 1; first.commit()
    print("PASS: concurrent same client message ID produces one canonical message")
    rpc(first,"delete",task["id"],{"expectedRevision":changed["revision"]})
    results = []
    thread = threading.Thread(target=pending,args=(second,"update",task["id"],{"title":"After delete", "expectedRevision":changed["revision"]},results))
    thread.start(); wait_for_lock(second.info.backend_pid); first.commit(); thread.join(5)
    assert not thread.is_alive() and results == ["P0002"],results
    print("PASS: update waiting behind full task deletion cannot resurrect task/chat")
