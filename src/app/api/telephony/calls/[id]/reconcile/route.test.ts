import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";
import { SessionEventDeferredError } from "@/server/telephony/service-errors";

const { requireActor, sameOrigin, reconcile, createDeps } = vi.hoisted(() => ({
  requireActor: vi.fn(), sameOrigin: vi.fn(), reconcile: vi.fn(), createDeps: vi.fn(),
}));
const maintenance = vi.hoisted(() => ({ after: vi.fn(), replay: vi.fn() }));
vi.mock("next/server", async importOriginal => ({
  ...await importOriginal<typeof import("next/server")>(), after: maintenance.after,
}));
vi.mock("@/server/telephony/telnyx/event-processor", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/telephony/telnyx/event-processor")>(), replayDeferredSessionEvents: maintenance.replay,
}));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: requireActor, assertSameOriginRequest: sameOrigin }));
vi.mock("@/server/telephony/call-reconciliation", () => ({ reconcileBrowserCall: reconcile }));
vi.mock("@/server/telephony/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/telephony/runtime")>(), createTelephonyDeps: createDeps,
}));

import { POST } from "./route";

const ACTOR = { profileId: "profile-1", organizationId: "org-1", role: "dispatcher", displayName: "Jana" };
const context = { params: Promise.resolve({ id: "sess-1" }) };
const request = () => new Request("https://app.test/api/telephony/calls/sess-1/reconcile", {
  method: "POST", headers: { "content-type": "application/json", "x-pm-phone-kind": "mobile" }, body: JSON.stringify({ callControlId: "browser-leg" }),
});

beforeEach(() => {
  vi.stubEnv("TELNYX_API_KEY", "KEYtest");
  requireActor.mockReset().mockResolvedValue(ACTOR);
  sameOrigin.mockReset();
  reconcile.mockReset().mockResolvedValue({ sessionId: "sess-1", state: "waiting", reconciled: true });
  createDeps.mockReset().mockResolvedValue({ marker: "deps" });
  maintenance.after.mockReset();
  maintenance.replay.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/telephony/calls/[id]/reconcile", () => {
  it("passes the authenticated mobile actor and exact browser leg to reconciliation", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, state: "waiting", reconciled: true });
    expect(createDeps).toHaveBeenCalledWith({ organizationId: "org-1", deviceKind: "mobile" });
    expect(reconcile).toHaveBeenCalledWith({ marker: "deps" }, { profileId: "profile-1", role: "dispatcher", displayName: "Jana" }, "sess-1", "browser-leg");
  });

  it("rejects a cross-origin request before authentication or reconciliation", async () => {
    sameOrigin.mockImplementation(() => { throw new MutationError("Neplatný pôvod.", 403); });
    expect((await POST(request(), context)).status).toBe(403);
    expect(requireActor).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("returns a retry hint without claiming that a busy call was reconciled", async () => {
    reconcile.mockResolvedValue({ sessionId: "sess-1", state: "talking", reconciled: false, reason: "session_busy", retryAfterMs: 1_000 });
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true, sessionId: "sess-1", state: "talking", reconciled: false, reason: "session_busy", retryAfterMs: 1_000,
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(maintenance.after).not.toHaveBeenCalled();
  });

  it("schedules the deferred-event replay only when reconciliation applied a transition", async () => {
    expect((await POST(request(), context)).status).toBe(200);
    expect(maintenance.after).toHaveBeenCalledTimes(1);
    expect(maintenance.replay).not.toHaveBeenCalled();
    await maintenance.after.mock.calls[0][0]();
    expect(maintenance.replay).toHaveBeenCalledExactlyOnceWith({ marker: "deps" }, "sess-1");

    for (const outcome of [{ reconciled: false, reason: "session_busy", retryAfterMs: 1_000 }, { reconciled: false, reason: "alive" }]) {
      maintenance.after.mockClear();
      reconcile.mockResolvedValue({ sessionId: "sess-1", state: "talking", ...outcome });
      expect((await POST(request(), context)).status).toBe(200);
      expect(maintenance.after).not.toHaveBeenCalled();
    }
  });

  it("does not turn an ownership database failure into an internal error or a successful reconciliation", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reconcile.mockRejectedValue(new SessionEventDeferredError("Session ownership lookup failed: internal details"));
      const response = await POST(request(), context);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "Stav hovoru sa nepodarilo overiť.", code: "session_event_deferred" });
    } finally { consoleError.mockRestore(); }
  });

  it("requires an authenticated session", async () => {
    requireActor.mockRejectedValue(new MutationError("Prihláste sa.", 401));
    expect((await POST(request(), context)).status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
