import { describe, expect, it } from "vitest";

import { createFakeSupabase } from "./fake-supabase";

const ORG = "00000000-0000-4000-8000-000000000001";
const SESSION = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";

function fixedClock(iso: string) {
  return () => new Date(iso);
}

describe("fake-supabase query builder", () => {
  it("supports insert/select with filters, ordering, limit and projections", async () => {
    const { client, db } = createFakeSupabase({ now: fixedClock("2026-09-03T10:00:00.000Z") });
    db.seed("motorist_ring_attempts", [
      { session_id: SESSION, step_index: 0, profile_id: "a", result: "offered", position: 2 },
      { session_id: SESSION, step_index: 0, profile_id: "b", result: "no_answer", position: 1 },
      { session_id: SESSION, step_index: 1, profile_id: "c", result: "offered", position: 3 },
    ]);

    const { data, error } = await client
      .from("motorist_ring_attempts")
      .select("profile_id, result")
      .eq("session_id", SESSION)
      .in("result", ["offered", "no_answer"])
      .order("position", { ascending: true })
      .limit(2);

    expect(error).toBeNull();
    expect(data).toEqual([
      { profile_id: "b", result: "no_answer" },
      { profile_id: "a", result: "offered" },
    ]);

    const inserted = await client.from("motorist_ring_attempts").insert({ session_id: SESSION, step_index: 2, profile_id: "d" }).select().single();
    expect(inserted.error).toBeNull();
    expect(inserted.data).toMatchObject({ profile_id: "d", created_at: "2026-09-03T10:00:00.000Z" });
    expect(typeof (inserted.data as { id: string }).id).toBe("string");
  });

  it("enforces unique constraints on insert and merges on upsert", async () => {
    const { client } = createFakeSupabase();
    await client.from("motorist_call_legs").insert({ session_id: SESSION, telnyx_call_control_id: "cc-1", state: "ringing" });

    const duplicate = await client.from("motorist_call_legs").insert({ session_id: SESSION, telnyx_call_control_id: "cc-1" });
    expect(duplicate.error?.code).toBe("23505");

    const merged = await client
      .from("motorist_call_legs")
      .upsert({ session_id: SESSION, telnyx_call_control_id: "cc-1", state: "answered" }, { onConflict: "telnyx_call_control_id" })
      .select()
      .single();
    expect(merged.error).toBeNull();
    expect(merged.data).toMatchObject({ telnyx_call_control_id: "cc-1", state: "answered" });

    const all = await client.from("motorist_call_legs").select("*");
    expect(all.data).toHaveLength(1);

    const ignored = await client
      .from("motorist_call_legs")
      .upsert({ telnyx_call_control_id: "cc-1", state: "hangup" }, { onConflict: "telnyx_call_control_id", ignoreDuplicates: true })
      .select();
    expect(ignored.data).toEqual([expect.objectContaining({ state: "answered" })]);
  });

  it("updates and deletes through filters and reports single/maybeSingle errors", async () => {
    const { client } = createFakeSupabase();
    await client.from("motorist_call_sessions").insert([
      { id: SESSION, organization_id: ORG, state: "ringing", current_step: 0, lease_until: null },
      { id: "s2", organization_id: ORG, state: "ended", current_step: 3, lease_until: "2026-01-01T00:00:00.000Z" },
    ]);

    const updated = await client.from("motorist_call_sessions").update({ state: "talking" }).eq("id", SESSION).is("lease_until", null).select();
    expect(updated.data).toEqual([expect.objectContaining({ id: SESSION, state: "talking" })]);

    const none = await client.from("motorist_call_sessions").update({ state: "x" }).eq("id", "missing").select();
    expect(none.data).toEqual([]);

    const single = await client.from("motorist_call_sessions").select("id").eq("organization_id", ORG).single();
    expect(single.error?.code).toBe("PGRST116");

    const maybe = await client.from("motorist_call_sessions").select("id").eq("id", "missing").maybeSingle();
    expect(maybe).toMatchObject({ data: null, error: null });

    const notEnded = await client.from("motorist_call_sessions").select("id").not("state", "in", ["ended", "failed"]);
    expect(notEnded.data).toEqual([{ id: SESSION }]);

    const gte = await client.from("motorist_call_sessions").select("id").gte("current_step", 1);
    expect(gte.data).toEqual([{ id: "s2" }]);
    const or = await client.from("motorist_call_sessions").select("id").or("state.eq.talking,current_step.gte.5");
    expect(or.data).toEqual([{ id: SESSION }]);
    const orNumeric = await client.from("motorist_call_sessions").select("id").or("current_step.gte.3,lease_until.is.null").order("id");
    expect(orNumeric.data).toEqual([{ id: SESSION }, { id: "s2" }]);

    const deleted = await client.from("motorist_call_sessions").delete().eq("state", "ended").select();
    expect(deleted.data).toHaveLength(1);
    const count = await client.from("motorist_call_sessions").select("*", { count: "exact", head: true });
    expect(count.count).toBe(1);
  });

  it("injects failures once and logs operations", async () => {
    const { client, db } = createFakeSupabase();
    db.failNext("motorist_calls", "insert", "boom");
    const failed = await client.from("motorist_calls").insert({ id: "c1" });
    expect(failed.error?.message).toBe("boom");
    const ok = await client.from("motorist_calls").insert({ id: "c1" });
    expect(ok.error).toBeNull();
    expect(db.log.map((entry) => `${entry.kind}:${entry.table}:${entry.operation}`)).toEqual([
      "query:motorist_calls:insert",
      "query:motorist_calls:insert",
    ]);
  });
});

describe("fake-supabase telephony RPCs", () => {
  it("claims, detects duplicates, reports busy and reclaims stale rows", async () => {
    const start = Date.parse("2026-09-03T10:00:00.000Z");
    const { client, db } = createFakeSupabase({ now: () => new Date(start) });
    const args = { p_event_id: "evt-1", p_event_type: "call.initiated", p_payload: { a: 1 } };

    const first = await client.rpc("motorist_telnyx_claim_webhook_event", args).single();
    expect(first.data).toEqual({ outcome: "claimed", event_status: "queued", event_attempts: 1, event_claimed_at: "2026-09-03T10:00:00.000Z" });

    const busy = await client.rpc("motorist_telnyx_claim_webhook_event", args).single();
    expect(busy.data).toMatchObject({ outcome: "busy", event_attempts: 1 });

    db.setNow(new Date(start + 31_000));
    const reclaimed = await client.rpc("motorist_telnyx_claim_webhook_event", args).single();
    expect(reclaimed.data).toEqual({ outcome: "claimed", event_status: "queued", event_attempts: 2, event_claimed_at: "2026-09-03T10:00:31.000Z" });

    await client.from("motorist_telnyx_webhook_events").update({ status: "processed" }).eq("event_id", "evt-1");
    db.setNow(new Date(start + 120_000));
    const duplicate = await client.rpc("motorist_telnyx_claim_webhook_event", args).single();
    expect(duplicate.data).toMatchObject({ outcome: "duplicate", event_status: "processed" });

    const unknown = await client.rpc("motorist_no_such_rpc", {});
    expect(unknown.error?.code).toBe("42883");
  });

  it("implements the session lease with re-entrancy and expiry", async () => {
    const start = Date.parse("2026-09-03T10:00:00.000Z");
    const { client, db } = createFakeSupabase({ now: () => new Date(start) });
    db.seed("motorist_call_sessions", [{ id: SESSION, organization_id: ORG, state: "ringing", current_step: 0, version: 0 }]);

    expect((await client.rpc("motorist_session_lease_acquire", { p_session_id: SESSION, p_token: "t1", p_ttl_ms: 4000 })).data).toBe(true);
    expect((await client.rpc("motorist_session_lease_acquire", { p_session_id: SESSION, p_token: "t2" })).data).toBe(false);
    expect((await client.rpc("motorist_session_lease_acquire", { p_session_id: SESSION, p_token: "t1" })).data).toBe(true);
    expect((await client.rpc("motorist_session_lease_release", { p_session_id: SESSION, p_token: "t2" })).data).toBe(false);
    expect((await client.rpc("motorist_session_lease_release", { p_session_id: SESSION, p_token: "t1" })).data).toBe(true);
    expect((await client.rpc("motorist_session_lease_acquire", { p_session_id: SESSION, p_token: "t2" })).data).toBe(true);

    db.setNow(new Date(start + 5000));
    expect((await client.rpc("motorist_session_lease_acquire", { p_session_id: SESSION, p_token: "t3" })).data).toBe(true);
    expect((await client.rpc("motorist_session_lease_acquire", { p_session_id: "missing", p_token: "t3" })).data).toBe(false);
  });

  it("reserves an operator exactly once", async () => {
    const { client, db } = createFakeSupabase();
    db.seed("motorist_operator_presence", [
      { organization_id: ORG, profile_id: PROFILE, status: "available", current_session_id: null },
      { organization_id: ORG, profile_id: "paused", status: "paused", current_session_id: null },
    ]);

    expect((await client.rpc("motorist_reserve_operator", { p_profile_id: PROFILE, p_session_id: SESSION })).data).toBe(true);
    expect((await client.rpc("motorist_reserve_operator", { p_profile_id: PROFILE, p_session_id: "other" })).data).toBe(false);
    expect((await client.rpc("motorist_reserve_operator", { p_profile_id: "paused", p_session_id: SESSION })).data).toBe(false);
    expect(db.find("motorist_operator_presence", (row) => row.profile_id === PROFILE)).toMatchObject({ status: "on_call", current_session_id: SESSION });
  });

  it("advances the ring step with a compare-and-set", async () => {
    const { client, db } = createFakeSupabase();
    db.seed("motorist_call_sessions", [{ id: SESSION, organization_id: ORG, state: "ringing", current_step: 0, version: 0 }]);

    const [winner, loser] = await Promise.all([
      client.rpc("motorist_advance_ring_step", { p_session_id: SESSION, p_expected_step: 0 }),
      client.rpc("motorist_advance_ring_step", { p_session_id: SESSION, p_expected_step: 0 }),
    ]);
    expect([winner.data, loser.data].sort()).toEqual([false, true]);
    expect(db.find("motorist_call_sessions", (row) => row.id === SESSION)).toMatchObject({ current_step: 1, version: 1 });
  });

  it("lets tests override an RPC and inject RPC errors", async () => {
    const { client, db } = createFakeSupabase();
    db.registerRpc("motorist_reserve_operator", () => true);
    expect((await client.rpc("motorist_reserve_operator", { p_profile_id: "x", p_session_id: "y" })).data).toBe(true);
    db.failNext("motorist_reserve_operator", "rpc", "down");
    const failed = await client.rpc("motorist_reserve_operator", { p_profile_id: "x", p_session_id: "y" });
    expect(failed.error?.message).toBe("down");
  });
});
