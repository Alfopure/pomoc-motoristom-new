import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, CASE_ID, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { resolveCallbackRequest } from "./telephony/callbacks";
import { persistTransition } from "./telephony/state/effects";
import { emptyTransition, type SessionRow } from "./telephony/state/types";
beforeEach(() => vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false"));
afterEach(() => vi.unstubAllEnvs());
function setup() {
  const h = createTelephonyHarness();
  h.db.seed("motorist_task_workspace_settings", [{ organization_id: h.deps.organizationId, enabled: true, writer_inventory_verified_at: "2026-09-10", writer_inventory_note: "isolated compatible writer" }]);
  return h;
}
describe("active task workspace routes existing callback workflows before legacy effects", () => {
  it("resolves a legacy-shaped callback through the exact RPC without broad task closure", async () => {
    const h = setup();
    const [request] = h.db.insert("motorist_callback_requests", { organization_id: h.deps.organizationId, caller_number: NUMBERS.customer, source: "missed", status: "open", case_id: CASE_ID, metadata: {} });
    h.db.insert("motorist_case_tasks", { organization_id: h.deps.organizationId, case_id: CASE_ID, kind: "callback", title: "Unrelated callback", status: "open" });
    let called = false;
    h.db.registerRpc("motorist_resolve_callback_v1", args => {
      called = true; expect(args).toMatchObject({ p_request_id: request.id, p_actor_id: PROFILES.o1 });
      expect(h.db.find("motorist_callback_requests", row => row.id === request.id)?.status).toBe("open");
      return { ...request, status: "done", resolved_at: h.now().toISOString() };
    });
    const result = await resolveCallbackRequest({ ...h.deps, organizationId: h.deps.organizationId }, { profileId: PROFILES.o1, role: "dispatcher" }, String(request.id), { status: "done" });
    expect(called).toBe(true); expect(result.request.status).toBe("done"); expect(h.db.rows("motorist_case_tasks")[0].status).toBe("open");
  });
  it("does not resolve callbacks or touch tasks if the system gate cannot be read", async () => {
    const h = setup();
    const [request] = h.db.insert("motorist_callback_requests", { organization_id: h.deps.organizationId, caller_number: NUMBERS.customer, source: "missed", status: "open", metadata: {} });
    h.db.failNext("motorist_task_workspace_settings", "select", "unavailable");
    await expect(resolveCallbackRequest({ ...h.deps, organizationId: h.deps.organizationId }, { profileId: PROFILES.o1, role: "dispatcher" }, String(request.id), { status: "done" })).rejects.toThrow("overiť");
    expect(h.db.find("motorist_callback_requests", row => row.id === request.id)?.status).toBe("open");
  });
  it("creates obligations through the proven RPC even when the older telephony flag is off", async () => {
    const h = setup(); const call = await h.inbound({ to: NUMBERS.neutral });
    const session = h.session(call.sessionId) as unknown as SessionRow;
    let called = false;
    h.db.registerRpc("motorist_create_callback_obligation_v1", () => {
      called = true; expect(h.db.rows("motorist_callback_requests")).toHaveLength(0);
      return { id: "test-request", organization_id: h.deps.organizationId, session_id: session.id, caller_number: session.caller_number, metadata: {} };
    });
    const transition = emptyTransition(); transition.callbacks.push({ source: "missed", createTask: true, callerNumber: session.caller_number! });
    await persistTransition({ ...h.deps, mediaBaseUrl: "https://audio.test", now: () => new Date("2026-09-10T00:00:00Z") }, { session, transition, expectedVersion: null, event: null });
    expect(called).toBe(true); expect(h.db.rows("motorist_case_tasks")).toHaveLength(0); expect(h.db.rows("motorist_callback_requests")).toHaveLength(0);
  });
});
