import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createTelephonyHarness, PROFILES } from "@/test/telephony-harness";
import { holdCall, parkCall, unholdCall } from "../call-actions";
import { telephonyDatabaseFetch } from "../ownership";
import { readPendingEffects, type EffectContinuation } from "./continuation";
import type { SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

async function talking() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  const call = await h.inbound();
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  await h.legEvent(operator, "call.answered");
  for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) {
    await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  return { h, call };
}

describe("interactive control after a lost staging response", () => {
  it.each(["hold", "unhold", "park"] as const)("finishes the committed %s in the original request without another mutation or user action", async action => {
    const { h, call } = await talking();
    if (action === "unhold") await holdCall(h.deps, actor, call.sessionId);
    h.telnyx.calls.length = 0;
    const stage = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    const lost = vi.fn<typeof stage>(async (args, db) => {
      const result = await stage(args, db);
      const entry = (args.p_main as { entry: EffectContinuation }).entry;
      if (entry.event.kind === "app" && entry.event.type === action) throw new DOMException("staging response timed out", "TimeoutError");
      return result;
    });
    h.db.registerRpc("motorist_stage_transition_v1", lost);
    const result = await { hold: holdCall, unhold: unholdCall, park: parkCall }[action](h.deps, actor, call.sessionId);
    expect(result.state).toBe({ hold: "held", unhold: "talking", park: "parked" }[action]);
    expect(lost.mock.calls.filter(([args]) => (args.p_main as { entry: EffectContinuation }).entry.event.type === action)).toHaveLength(1);
    expect(h.telnyx.of({ hold: "conference:hold", unhold: "conference:unhold", park: "playbackStart" }[action])).toHaveLength(1);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.filter(entry => entry.event.type === action)).toEqual([]);
    expect(h.logs).toContainEqual(expect.objectContaining({ code: "staging_response_recovered", sessionId: call.sessionId }));
  });

  it.each(["not_committed", "different_event", "new_generation", "new_owner", "expired_lease", "termination", "unreadable"] as const)("never dispatches unproven audio when %s", async fault => {
    const { h, call } = await talking();
    h.telnyx.calls.length = 0;
    const stage = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    h.db.registerRpc("motorist_stage_transition_v1", async (args, db) => {
      if (fault !== "not_committed") await stage(args, db);
      const row = db.storage("motorist_call_sessions").find(row => row.id === call.sessionId)!;
      if (fault === "different_event") {
        const pending = structuredClone(readPendingEffects(row as SessionRow));
        pending.entries[0].id = "some-other-event";
        row.pending_effects = pending;
      }
      if (fault === "new_generation") row.ownership_generation = Number(row.ownership_generation) + 1;
      if (fault === "new_owner") row.lease_token = "new-owner";
      if (fault === "expired_lease") row.lease_until = new Date(h.now().getTime() - 1).toISOString();
      if (fault === "termination") row.termination_requested_at = h.now().toISOString();
      if (fault === "unreadable") h.db.failNext("motorist_call_sessions", "select", "read unavailable");
      throw new DOMException("staging response timed out", "TimeoutError");
    });
    await expect(parkCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ code: "transition_staging_unavailable" });
    expect(h.telnyx.calls).toEqual([]);
  });

  it("recovers a committed response lost through the real PostgREST transport, without its hidden retries", async () => {
    const { h, call } = await talking();
    const stage = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      await stage(JSON.parse(String(init?.body)), h.db);
      throw new DOMException("response lost", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetch);
    const transport = createClient<Database>("https://x.supabase.co", "service-key", {
      global: { fetch: telephonyDatabaseFetch }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const rpc = h.client.rpc.bind(h.client);
    vi.spyOn(h.client, "rpc").mockImplementation((...args) => args[0] === "motorist_stage_transition_v1"
      ? transport.rpc("motorist_stage_transition_v1", args[1] as Database["public"]["Functions"]["motorist_stage_transition_v1"]["Args"]) as unknown as ReturnType<typeof rpc>
      : rpc(...args));
    const result = await parkCall(h.deps, actor, call.sessionId);
    expect(result.state).toBe("parked");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ code: "staging_response_recovered" }));
  });

  it("does not reinterpret a permanent SQL refusal as a lost response", async () => {
    const { h, call } = await talking();
    h.telnyx.calls.length = 0;
    h.db.failNext("motorist_stage_transition_v1", "rpc", { code: "42501", message: "permission denied: AbortError", details: null, hint: null });
    await expect(parkCall(h.deps, actor, call.sessionId)).rejects.toThrow("Transition staging failed");
    expect(h.telnyx.calls).toEqual([]);
    expect(h.logs.some(entry => entry.code === "staging_response_recovered")).toBe(false);
  });
});
