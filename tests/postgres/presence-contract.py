"""Local PostgreSQL evidence. Requires psycopg[binary], localhost:55432 only.
Creates/drops ONLY the isolated presence_contract test database.
Run: python3 tests/postgres/presence-contract.py
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from psycopg.types.json import Jsonb
import json
import psycopg

ROOT = Path(__file__).resolve().parents[2]
DSN = "host=127.0.0.1 port=55432 user=postgres dbname=presence_contract"
ORG = "00000000-0000-4000-8000-000000000001"
OTHER = "00000000-0000-4000-8000-000000000002"
PROFILE = "00000000-0000-4000-8000-000000000011"
PROFILE2 = "00000000-0000-4000-8000-000000000012"
SESSION = "00000000-0000-4000-8000-000000000021"
SESSION2 = "00000000-0000-4000-8000-000000000022"
REASON = "00000000-0000-4000-8000-000000000031"

def conn():
    return psycopg.connect(DSN, autocommit=True)

def rpc(c, action, session=None, revision=None, token=None, status=None, reason=None, until=None, org=ORG, profile=PROFILE, source="telephony"):
    return c.execute("select motorist_presence_transition_v1(%s,%s,%s,%s,%s,%s,%s,%s,%s,p_source => %s)",
        (org, profile, action, session, revision, token, status, reason, until, source)).fetchone()[0]

def row(c):
    return c.execute("select to_jsonb(p) from motorist_operator_presence p where profile_id=%s",(PROFILE,)).fetchone()[0]

def reset(c,status="available"):
    c.execute("truncate motorist_operator_statuses,motorist_ring_attempts,motorist_operator_presence,motorist_call_sessions,motorist_pause_reasons,motorist_profiles cascade")
    c.execute("insert into motorist_profiles values (%s,%s),(%s,%s)",(PROFILE,ORG,PROFILE2,ORG))
    c.execute("insert into motorist_pause_reasons values (%s,%s,'Lunch',true)",(REASON,ORG))
    c.execute("insert into motorist_call_sessions(id,organization_id) values(%s,%s),(%s,%s)",(SESSION,ORG,SESSION2,ORG))
    c.execute("insert into motorist_operator_presence(organization_id,profile_id,status,pause_reason_id) values(%s,%s,%s,%s),(%s,%s,'available',null)",(ORG,PROFILE,status,REASON if status=='paused' else None,ORG,PROFILE2))

results=[]
def passed(name):
    results.append(name)
    print("PASS",name,flush=True)

with psycopg.connect("host=127.0.0.1 port=55432 user=postgres dbname=postgres",autocommit=True) as setup:
    setup.execute("drop database if exists presence_contract with (force)")
    setup.execute("create database presence_contract")
with conn() as c:
    c.execute((ROOT/"tests/postgres/presence-fixture.sql").read_text())
    c.execute((ROOT/"supabase/migrations/20260928100000_atomic_presence_contract.sql").read_text())
    c.execute((ROOT/"supabase/migrations/20260928110000_durable_transition_effects.sql").read_text())
    for role in ("anon","authenticated"):
        c.execute("set role "+role)
        try:
            rpc(c,"manual",status="paused")
            raise AssertionError("untrusted role executed RPC")
        except psycopg.errors.InsufficientPrivilege:
            pass
        finally:
            c.execute("reset role")
    passed("service-role-only permissions")
    reset(c)
    c.execute("set role service_role")
    assert rpc(c,"manual",status="paused")["applied"]
    c.execute("reset role")
    try:
        rpc(c,"manual",status="paused",org=OTHER)
        raise AssertionError("cross organization accepted")
    except psycopg.errors.InsufficientPrivilege:
        pass
    passed("service actor and organization boundary")

    # Separate clients, deterministic blocking: first transaction holds session
    # and presence while the second has entered its RPC. Commit decides order.
    for winner in ("manual","answer"):
        reset(c)
        offer=rpc(c,"dispatch",SESSION)
        with conn() as first, conn() as second, ThreadPoolExecutor() as pool:
            first.execute("begin")
            a=rpc(first,winner,SESSION if winner=="answer" else None,token=offer["offerToken"],status="paused")
            entered=Event()
            def loser():
                entered.set()
                return rpc(second,"answer" if winner=="manual" else "manual",SESSION if winner=="manual" else None,
                    token=offer["offerToken"],status="paused")
            future=pool.submit(loser)
            assert entered.wait(5)
            # pg_stat_activity proves the other backend is waiting on the lock,
            # rather than using an arbitrary scheduling sleep.
            for _ in range(10000):
                wait=c.execute("select wait_event_type from pg_stat_activity where pid=%s",(second.info.backend_pid,)).fetchone()
                if wait and wait[0]=="Lock": break
            else: raise AssertionError("second client did not reach lock barrier")
            first.execute("commit")
            b=future.result(timeout=5)
        assert a["applied"] and not b["applied"]
        assert row(c)["status"]==("paused" if winner=="manual" else "on_call")
        passed("PA-05 two clients "+winner+" wins")

    for action, initial in (("dispatch", "available"), ("pickup", "paused")):
        reset(c, initial)
        with conn() as first, conn() as second, ThreadPoolExecutor() as pool:
            first.execute("begin")
            a = rpc(first, action, SESSION)
            entered = Event()
            def competing_session():
                entered.set()
                return rpc(second, action, SESSION2)
            future = pool.submit(competing_session)
            assert entered.wait(5)
            for _ in range(10000):
                wait = c.execute("select wait_event_type from pg_stat_activity where pid=%s", (second.info.backend_pid,)).fetchone()
                if wait and wait[0] == "Lock": break
            else: raise AssertionError("presence lock barrier not reached")
            first.execute("commit")
            b = future.result(timeout=5)
        assert a["applied"] and not b["applied"]
        assert c.execute("select presence_pickup from motorist_call_sessions where id=%s", (SESSION2,)).fetchone()[0] is None
        passed("two clients one operator two sessions " + action)

    reset(c, "paused")
    with conn() as first, conn() as second, ThreadPoolExecutor() as pool:
        first.execute("begin")
        a = rpc(first, "pickup", SESSION)
        entered = Event()
        def competing_actor():
            entered.set()
            return rpc(second, "pickup", SESSION, profile=PROFILE2)
        future = pool.submit(competing_actor)
        assert entered.wait(5)
        for _ in range(10000):
            wait = c.execute("select wait_event_type from pg_stat_activity where pid=%s", (second.info.backend_pid,)).fetchone()
            if wait and wait[0] == "Lock": break
        else: raise AssertionError("pickup session barrier not reached")
        first.execute("commit")
        b = future.result(timeout=5)
    assert a["applied"] and not b["applied"]
    assert c.execute("select current_session_id from motorist_operator_presence where profile_id=%s", (PROFILE2,)).fetchone()[0] is None
    passed("two clients two pickup actors one session no stranded loser")

    reset(c)
    assert rpc(c,"manual",status="paused")["applied"]
    assert not rpc(c,"dispatch",SESSION)["applied"]
    passed("PA-03 pause before dispatch")
    reset(c)
    offer=rpc(c,"dispatch",SESSION)
    c.execute("insert into motorist_ring_attempts(session_id,profile_id,result) values(%s,%s,'offered')",(SESSION,PROFILE))
    rpc(c,"manual",revision=offer["revision"],status="paused",reason=REASON)
    cancellations=c.execute("select presence_cancellations from motorist_call_sessions where id=%s",(SESSION,)).fetchone()[0]
    assert offer["offerToken"] in cancellations
    assert c.execute("select result from motorist_ring_attempts").fetchone()[0]=="cancelled"
    before=row(c)
    assert not rpc(c,"release",SESSION,offer["revision"],offer["offerToken"],"available")["applied"]
    assert before==row(c)
    passed("PA-02/04 durable cancellation and PA-06 strict stale release")

    reset(c,"paused")
    pickup=rpc(c,"pickup",SESSION)
    assert pickup["applied"] and pickup["presence"]["pause_return"]["pauseReasonId"]==REASON
    assert rpc(c,"pickup",SESSION)["reused"]
    assert not rpc(c,"pickup",SESSION2)["applied"]
    assert not rpc(c,"pickup",SESSION,profile=PROFILE2)["applied"]
    assert not rpc(c,"dispatch",SESSION2)["applied"]
    rpc(c,"answer",SESSION,token=pickup["offerToken"])
    released=rpc(c,"release",SESSION,token=pickup["offerToken"],status="after_call_work",until="2999-01-01T00:00:00Z")
    assert released["presence"]["current_session_id"] is None and released["presence"]["pause_return"]
    c.execute("update motorist_operator_presence set wrap_up_until=now()-interval '1 second' where profile_id=%s",(PROFILE,))
    assert not rpc(c,"dispatch",SESSION2)["applied"]
    ended=rpc(c,"end_wrap_up",revision=row(c)["presence_revision"],token=pickup["offerToken"])
    assert ended["presence"]["status"]=="paused" and ended["presence"]["pause_reason_id"]==REASON
    passed("PU-01/03/04/06 one pickup owner and expired return blocks dispatch")
    reset(c, "paused")
    pickup = rpc(c, "pickup", SESSION)
    rpc(c, "answer", SESSION, token=pickup["offerToken"])
    rpc(c, "release", SESSION, token=pickup["offerToken"], status="after_call_work", until="2999-01-01T00:00:00Z")
    assert not rpc(c, "end_wrap_up", token=pickup["offerToken"], source="cron")["applied"]
    c.execute("update motorist_operator_presence set wrap_up_until=now()-interval '2 minutes' where profile_id=%s", (PROFILE,))
    expired = row(c)
    restored = rpc(c, "end_wrap_up", revision=expired["presence_revision"], token=pickup["offerToken"], source="cron")
    assert restored["presence"]["status"] == "paused"
    assert restored["presence"]["status_since"] == expired["wrap_up_until"]
    assert c.execute("select to_jsonb(started_at) from motorist_operator_statuses where profile_id=%s and ended_at is null", (PROFILE,)).fetchone()[0] == expired["wrap_up_until"]
    passed("PU-06/08 cron materializes paused segment at expiry; early cron cannot end active wrap-up")
    for status in ("available","after_call_work"):
        reset(c,"paused")
        pickup=rpc(c,"pickup",SESSION)
        released=rpc(c,"release",SESSION,token=pickup["offerToken"],status=status)
        assert released["presence"]["status"]=="paused" and released["presence"]["pause_reason_id"]==REASON
    cancellations = c.execute("select presence_cancellations from motorist_call_sessions where id=%s",(SESSION,)).fetchone()[0]
    assert pickup["offerToken"] in cancellations
    assert not rpc(c,"answer",SESSION,token=pickup["offerToken"])["applied"]
    passed("PU-05/06 failure and zero wrap-up restore original pause")
    reset(c)
    old=row(c)["presence_revision"]
    rpc(c,"manual",status="paused")
    rpc(c,"manual",status="available")
    assert not rpc(c,"manual",revision=old,status="paused")["applied"]
    passed("revision ABA across same status and null session")
    original = row(c)["presence_revision"]
    c.execute("update motorist_operator_presence set pause_reason_id=%s where profile_id=%s", (REASON, PROFILE))
    assert row(c)["presence_revision"] == original + 1
    c.execute("update motorist_operator_presence set presence_revision=0 where profile_id=%s", (PROFILE,))
    assert row(c)["presence_revision"] == original + 1
    c.execute("update motorist_operator_presence set current_session_id=%s where profile_id=%s", (SESSION, PROFILE))
    assert row(c)["presence_revision"] == original + 2
    passed("legacy reason and owner writers bump revision; direct revision decrement rejected")
    reset(c)
    c.execute("create function fail_history() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$")
    c.execute("create trigger fail_history before insert on motorist_operator_statuses for each row execute function fail_history()")
    before=row(c)
    try:
        rpc(c,"pickup",SESSION)
        raise AssertionError("injected transaction failure not raised")
    except psycopg.errors.RaiseException:
        pass
    assert row(c)==before
    assert c.execute("select presence_pickup from motorist_call_sessions where id=%s",(SESSION,)).fetchone()[0] is None
    c.execute("drop trigger fail_history on motorist_operator_statuses")
    passed("transaction rollback includes history presence session ownership")
    assert c.execute("select motorist_reserve_operator(%s,%s)",(PROFILE,SESSION)).fetchone()[0]
    assert c.execute("select motorist_reserve_operator(%s,%s)",(PROFILE,SESSION)).fetchone()[0]
    passed("legacy RPC signature available admission and idempotent answer")

    reset(c)
    c.execute("create function fail_acquire_answer() returns trigger language plpgsql as $$ begin if new.status='on_call' then raise exception 'injected acquire answer'; end if; return new; end $$")
    c.execute("create trigger fail_acquire_answer before insert on motorist_operator_statuses for each row execute function fail_acquire_answer()")
    before = row(c)
    try:
        rpc(c, "acquire", SESSION)
        raise AssertionError("second acquisition effect did not fail")
    except psycopg.errors.RaiseException: pass
    assert row(c) == before
    assert c.execute("select count(*) from motorist_operator_statuses").fetchone()[0] == 0
    c.execute("drop trigger fail_acquire_answer on motorist_operator_statuses")
    first = rpc(c, "acquire", SESSION)
    assert first["presence"]["status"] == "on_call" and first["offerToken"]
    rpc(c, "release", SESSION, first["revision"], first["offerToken"], "available")
    newer = rpc(c, "acquire", SESSION)
    assert newer["offerToken"] != first["offerToken"]
    assert not rpc(c, "release", SESSION, first["revision"], first["offerToken"], "available")["applied"]
    assert row(c)["offer_token"] == newer["offerToken"]
    passed("atomic acquire returns original owner; second-write rollback and same-session compensation ABA")

    def stage(client, version, entry_id, token=None, org=ORG, guard_answer=False):
        main = {"sessionPatch": {"state": "talking", "answered_by_profile_id": PROFILE}, "entry": {"id": entry_id, "effects": ["bridge"]}}
        rejected = {"sessionPatch": {"state": "waiting"}, "entry": {"id": entry_id, "branch": "rejected", "effects": ["cancel_loser"]}}
        guard = {"profileId": PROFILE, "offerToken": token} if token or guard_answer else None
        return client.execute("select motorist_stage_transition_v1(%s,%s,%s,%s,%s,%s)",
            (org, SESSION, version, Jsonb(main), Jsonb(rejected), Jsonb(guard))).fetchone()[0]

    for role in ("anon", "authenticated"):
        c.execute("set role " + role)
        try:
            stage(c, 0, "denied")
            raise AssertionError("stage callable by untrusted role")
        except psycopg.errors.InsufficientPrivilege: pass
        finally: c.execute("reset role")
    passed("stage RPC service-role-only permissions")
    reset(c)
    offer = rpc(c, "dispatch", SESSION)
    c.execute("set role service_role")
    won = stage(c, 0, "answer-1", offer["offerToken"])
    c.execute("reset role")
    assert won["applied"] and won["session"]["state"] == "talking"
    assert row(c)["status"] == "on_call"
    assert won["session"]["pending_effects"]["entries"][0]["id"] == "answer-1"
    assert stage(c, 0, "answer-1", offer["offerToken"])["applied"]
    assert len(c.execute("select pending_effects->'entries' from motorist_call_sessions where id=%s", (SESSION,)).fetchone()[0]) == 1
    assert not stage(c, 0, "stale-2", offer["offerToken"])["applied"]
    assert not stage(c, None, "null-version", offer["offerToken"])["applied"]
    second = stage(c, 1, "answer-2", offer["offerToken"])
    assert [e["id"] for e in second["session"]["pending_effects"]["entries"]] == ["answer-1", "answer-2"]
    passed("stage atomically claims answer journals patch; CAS idempotency retains prior obligations")
    try:
        stage(c, 2, "wrong-org", offer["offerToken"], org=OTHER)
        raise AssertionError("cross-org stage admitted")
    except psycopg.errors.RaiseException: pass
    passed("stage organization isolation")
    reset(c)
    rpc(c, "manual", status="paused", reason=REASON)
    pickup = rpc(c, "pickup", SESSION)
    before = row(c)
    tokenless = stage(c, 0, "legacy-answer-without-token", None, guard_answer=True)
    assert tokenless["session"]["pending_effects"]["entries"][0]["branch"] == "rejected"
    assert row(c) == before
    passed("tokenless legacy answer cannot claim a newer same-session paused pickup")
    reset(c)
    offer = rpc(c, "dispatch", SESSION)
    rpc(c, "manual", status="paused", reason=REASON)
    rejected = stage(c, 0, "lost-answer", offer["offerToken"])
    assert rejected["session"]["state"] == "waiting" and row(c)["status"] == "paused"
    assert rejected["session"]["pending_effects"]["entries"][0]["branch"] == "rejected"
    assert stage(c, 0, "lost-answer", offer["offerToken"])["applied"]
    assert len(c.execute("select pending_effects->'entries' from motorist_call_sessions where id=%s", (SESSION,)).fetchone()[0]) == 1
    passed("stage rejected answer journals loser cleanup without changing pause")
    reset(c)
    offer = rpc(c, "dispatch", SESSION)
    before = row(c)
    history_before = c.execute("select count(*) from motorist_operator_statuses").fetchone()[0]
    c.execute("create function fail_session_update() returns trigger language plpgsql as $$ begin if new.state='talking' then raise exception 'injected session update'; end if; return new; end $$")
    c.execute("create trigger fail_session_update before update on motorist_call_sessions for each row execute function fail_session_update()")
    try:
        stage(c, 0, "rollback", offer["offerToken"])
        raise AssertionError("session failure not raised")
    except psycopg.errors.RaiseException: pass
    assert row(c) == before
    assert c.execute("select count(*) from motorist_operator_statuses").fetchone()[0] == history_before
    persisted = c.execute("select state,pending_effects,version from motorist_call_sessions where id=%s", (SESSION,)).fetchone()
    assert persisted == ("ringing", None, 0)
    c.execute("drop trigger fail_session_update on motorist_call_sessions")
    passed("stage rollback undoes answer history session patch and journal together")

print(json.dumps({"postgres":"local 15","fixture":"minimal, not full Supabase reset","passed":results},indent=2))
