import { describe, expect, it } from "vitest";
import { sessionOwnership, type Ownership } from "@/server/telephony/ownership";
import { journalRequest, prepareProviderRequest, recordProviderResponse } from "@/server/telephony/provider-journal";
import { createFakeSupabase, type FakeRow } from "./fake-supabase";
import { registerContractTwoRpcs } from "./fake-stability";

function harness() {
  let now = Date.now();
  const { db, admin } = createFakeSupabase({ now: () => new Date(now) });
  registerContractTwoRpcs(db);
  db.seed("motorist_call_sessions", [{ id: "session", organization_id: "org", writer_contract: 2,
    state: "talking", lease_token: "owner", lease_generation: 1, lease_until: new Date(now + 15_000).toISOString() }]);
  const owner: Ownership = { admin, sessionId: "session", organizationId: "org", token: "owner",
    generation: 1, contract: 2, acquiredAt: now, deadline: now + 24_000 };
  const request = sessionOwnership.run(owner, () => journalRequest("POST", "/calls/customer/actions/hangup", "hangup",
    JSON.stringify({ command_id: "hangup", client_state: "state" }))!);
  const row = () => db.rows("motorist_provider_commands")[0];
  const run = <T>(work: () => Promise<T>) => sessionOwnership.run(owner, work);
  const prepare = () => run(() => prepareProviderRequest(request));
  const result = (overrides: FakeRow = {}) => db.rpcHandlers.get("motorist_provider_command_result_v2")!({
    p_session_id: owner.sessionId, p_command_id: request.commandId, p_fingerprint: request.fingerprint,
    p_generation: 1, p_token: "owner", p_status: 200, p_result: { data: { result: "ok" } }, ...overrides,
  }, db);
  return { db, owner, request, row, run, prepare, result, advance: (ms: number) => { now += ms; } };
}

describe("workflow journal adapter mirrors the fenced SQL contract", () => {
  it("records immutable dispatch identity and refuses a result for any different tuple", async () => {
    const h = harness();
    expect(await h.prepare()).toEqual({ dispatch: true });
    const original = h.row();
    expect(original).toMatchObject({ outcome: "unknown", dispatch_generation: 1, dispatch_token: "owner",
      first_dispatched_at: h.db.nowIso(), http_status: null, result: null, termination_cleanup_at: null });
    for (const mismatch of [{ p_session_id: "other" }, { p_command_id: "other" }, { p_fingerprint: "other" },
      { p_generation: 2 }, { p_token: "other" }]) {
      expect(await h.result(mismatch)).toBe(false);
      expect(h.row()).toEqual(original);
    }
    expect(await h.prepare()).toMatchObject({ dispatch: false, outcome: "unknown" });
    expect(h.db.rows("motorist_provider_commands")).toHaveLength(1);
  });

  it("accepts original provider evidence after ownership changes but never overwrites final acceptance", async () => {
    const h = harness();
    await h.prepare();
    h.db.update("motorist_call_sessions", { lease_token: "successor", lease_generation: 2 }, row => row.id === "session");
    await recordProviderResponse(h.request, 200, { data: { result: "ok" } });
    expect(h.row()).toMatchObject({ outcome: "accepted", dispatch_generation: 1, dispatch_token: "owner", http_status: 200 });
    const accepted = h.row();
    expect(await h.result({ p_status: 500 })).toBe(false);
    expect(h.row()).toEqual(accepted);
  });

  it.each([[408, "unknown"], [500, "unknown"], [504, "unknown"], [422, "rejected"], [200, "accepted"]])(
    "classifies HTTP %i as %s", async (status, outcome) => {
      const h = harness();
      await h.prepare();
      await recordProviderResponse(h.request, Number(status), { status });
      expect(h.row()).toMatchObject({ http_status: status, outcome, next_attempt_at: null });
    });

  it("waits out a 429 and fences a redispatch under its new owner without replacing the first-send time", async () => {
    const h = harness();
    await h.prepare();
    const firstAt = h.row().first_dispatched_at;
    await recordProviderResponse(h.request, 429, { errors: ["rate limited"] }, 1000);
    h.advance(999);
    expect(await h.prepare()).toMatchObject({ dispatch: false, outcome: "rate_limited" });
    h.advance(1);
    h.owner.token = "successor";
    h.owner.generation = 2;
    h.db.update("motorist_call_sessions", { lease_token: h.owner.token, lease_generation: 2 }, row => row.id === "session");
    expect(await h.prepare()).toEqual({ dispatch: true });
    expect(h.row()).toMatchObject({ first_dispatched_at: firstAt, outcome: "unknown", next_attempt_at: null,
      dispatch_generation: 2, dispatch_token: "successor", http_status: 429 });
    expect(await h.result()).toBe(false);
    expect(await h.result({ p_generation: 2, p_token: "successor" })).toBe(true);
    expect(h.row().outcome).toBe("accepted");
  });

  it("allows exact teardown paths after termination but rejects a path that merely ends in hangup", async () => {
    const h = harness();
    h.db.update("motorist_call_sessions", { termination_requested_at: h.db.nowIso() }, row => row.id === "session");
    expect(await h.prepare()).toEqual({ dispatch: true });
    await h.run(async () => {
      const invalid = journalRequest("POST", "/arbitrary/hangup", "not-teardown", "{}")!;
      await expect(prepareProviderRequest(invalid)).rejects.toThrow("termination blocks");
    });
    expect(h.db.rows("motorist_provider_commands")).toHaveLength(1);
  });
});
