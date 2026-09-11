import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";

const { requireActor, sameOrigin, reconcile, createDeps } = vi.hoisted(() => ({
  requireActor: vi.fn(), sameOrigin: vi.fn(), reconcile: vi.fn(), createDeps: vi.fn(),
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

  it("requires an authenticated session", async () => {
    requireActor.mockRejectedValue(new MutationError("Prihláste sa.", 401));
    expect((await POST(request(), context)).status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
