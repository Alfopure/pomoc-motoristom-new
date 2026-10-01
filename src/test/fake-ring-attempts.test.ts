import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "./fake-supabase";

const sip = { session_id: "caller-1", profile_id: "operator-1", step_index: 0, member_kind: "operator", external_number: null, result: "offered" };
const mobile = { ...sip, member_kind: "external_number", external_number: "+421900000001" };

describe("parallel ring endpoint database contract in the workflow fake", () => {
  it("admits separate web and mobile attempts while preserving endpoint uniqueness", async () => {
    const { client } = createFakeSupabase();
    expect((await client.from("motorist_ring_attempts").insert(sip)).error).toBeNull();
    expect((await client.from("motorist_ring_attempts").insert(mobile)).error).toBeNull();
    expect((await client.from("motorist_ring_attempts").insert(sip)).error?.code).toBe("23505");
    expect((await client.from("motorist_ring_attempts").insert(mobile)).error?.code).toBe("23505");
    expect((await client.from("motorist_ring_attempts").insert({ ...sip, step_index: 1 })).error?.code).toBe("23505");
    expect((await client.from("motorist_ring_attempts").insert({ ...mobile, step_index: 1 })).error?.code).toBe("23505");
  });

  it("rejects another caller while either endpoint remains offered", async () => {
    const { client } = createFakeSupabase();
    await client.from("motorist_ring_attempts").insert(sip);
    await client.from("motorist_ring_attempts").insert(mobile);
    await client.from("motorist_ring_attempts").update({ result: "failed" }).eq("member_kind", "operator");
    const other = { ...sip, session_id: "caller-2" };
    expect((await client.from("motorist_ring_attempts").insert(other)).error?.code).toBe("23P01");
    await client.from("motorist_ring_attempts").update({ result: "cancelled" }).eq("member_kind", "external_number");
    expect((await client.from("motorist_ring_attempts").insert(other)).error).toBeNull();
  });

  it("rolls back a pending offer promotion that conflicts with another session", async () => {
    const { client, db } = createFakeSupabase();
    await client.from("motorist_ring_attempts").insert(sip);
    const pending = { ...mobile, id: "pending-mobile", session_id: "caller-2", result: "pending" };
    await client.from("motorist_ring_attempts").insert(pending);
    const result = await client.from("motorist_ring_attempts").update({ result: "offered" }).eq("id", pending.id);
    expect(result.error?.code).toBe("23P01");
    expect(db.rows("motorist_ring_attempts").find(row => row.id === pending.id)).toMatchObject(pending);
  });

  it("keeps unowned external numbers independent between sessions", async () => {
    const { client } = createFakeSupabase();
    const external = { ...mobile, profile_id: null };
    expect((await client.from("motorist_ring_attempts").insert(external)).error).toBeNull();
    expect((await client.from("motorist_ring_attempts").insert({ ...external, session_id: "caller-2" })).error).toBeNull();
  });
});
