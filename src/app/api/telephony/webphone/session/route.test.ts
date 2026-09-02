import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  claimExtension: vi.fn(),
  getSession: vi.fn(),
  requestSnapshot: vi.fn(),
  requireSnapshotExtension: vi.fn(),
  requireActor: vi.fn(),
  requireLease: vi.fn(),
  releaseExtension: vi.fn(),
  resolveExtension: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/telephony/webphone", () => ({
  getViptelWebphoneSession: mocks.getSession,
  ViptelWebphoneSessionError: class ViptelWebphoneSessionError extends Error {
    status = 500;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn(() => ({ test: true })) }));
vi.mock("@/server/telephony-access", () => ({
  readWorkplaceLeaseFence: (value: Record<string, unknown>) => ({
    leaseId: value.leaseId,
    assignmentGeneration: value.assignmentGeneration,
    browserInstanceId: value.browserInstanceId,
    leaderEpoch: value.leaderEpoch,
    leaseVersion: value.leaseVersion,
  }),
  requireActiveWorkplaceLease: mocks.requireLease,
  requireTelephonyActor: mocks.requireActor,
  resolveOwnedTelephonyExtension: mocks.resolveExtension,
}));
vi.mock("@/server/telephony/live-mutation-gate", () => ({
  assertTelephonyLiveMutationEnabled: mocks.gate,
}));
vi.mock("@/server/telephony/assignment-interlock", () => ({
  claimOwnedExtensionAction: mocks.claimExtension,
  releaseExtensionAssignmentGuard: mocks.releaseExtension,
}));
vi.mock("@/server/telephony/provider-snapshot-bridge", () => ({
  requestViptelProviderSnapshot: mocks.requestSnapshot,
  requirePersonalExtensionInSnapshot: mocks.requireSnapshotExtension,
}));

import { MutationError } from "@/server/motorist-mutations";
import { POST } from "./route";

const actor = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  profileId: "00000000-0000-4000-8000-000000000002",
};

describe("webphone session route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.resolveExtension.mockResolvedValue({ id: "extension-id", extension: "20" });
    mocks.claimExtension.mockResolvedValue({
      id: "extension-id",
      extension: "20",
      assignmentGuard: {},
      releaseAssignmentGuard: true,
    });
    mocks.requestSnapshot.mockResolvedValue({ personalExtensions: ["20"], extensions: [{ extension: "20" }] });
    mocks.getSession.mockReturnValue({ extension: "20", password: "server-secret" });
  });

  it("fails closed after auth and same-origin, before ownership lookup or credential issuance", async () => {
    mocks.gate.mockImplementationOnce(() => {
      throw new MutationError("Telekomunikačné zásahy nie sú povolené.", 503);
    });
    const request = jsonRequest({ extension: "20" });

    const response = await POST(request);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireActor).toHaveBeenCalledWith(request);
    expect(mocks.requireActor.mock.invocationCallOrder[0]).toBeLessThan(mocks.gate.mock.invocationCallOrder[0]);
    expect(mocks.resolveExtension).not.toHaveBeenCalled();
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(mocks.claimExtension).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("issues only the authenticated actor's owned extension after the gate succeeds", async () => {
    const response = await POST(jsonRequest({ extension: "20" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.gate).toHaveBeenCalledWith("webphone.session.issue");
    expect(mocks.resolveExtension).toHaveBeenCalledWith(actor, "20");
    expect(mocks.requireLease).toHaveBeenCalledWith(actor, { id: "extension-id", extension: "20" }, undefined, {
      requireFence: true,
    });
    expect(mocks.requestSnapshot).toHaveBeenCalledWith(actor.organizationId, actor.profileId, { maxAgeMs: 2_000 });
    expect(mocks.requireSnapshotExtension).toHaveBeenCalledWith(
      { personalExtensions: ["20"], extensions: [{ extension: "20" }] },
      "20",
      { allowInactiveForRegistration: true },
    );
    expect(mocks.requestSnapshot.mock.invocationCallOrder[0]).toBeLessThan(mocks.claimExtension.mock.invocationCallOrder[0]);
    expect(mocks.claimExtension).toHaveBeenCalledWith(actor, "extension-id", "webphone.session.issue", {
      allowExactRoutingWebphoneSession: true,
      client: { test: true },
      leaseFence: undefined,
    });
    expect(mocks.getSession).toHaveBeenCalledWith(process.env, "20");
    expect(mocks.releaseExtension).toHaveBeenCalledWith({ test: true }, actor.organizationId, {});
  });

  it("never releases a routing guard borrowed only for exact webphone issuance", async () => {
    mocks.claimExtension.mockResolvedValueOnce({
      id: "extension-id",
      extension: "20",
      assignmentGuard: { routingOperationId: "routing-operation" },
      releaseAssignmentGuard: false,
    });

    const response = await POST(jsonRequest({ extension: "20" }));

    expect(response.status).toBe(200);
    expect(mocks.getSession).toHaveBeenCalledWith(process.env, "20");
    expect(mocks.releaseExtension).not.toHaveBeenCalled();
  });

  it("clears the exact issuance claim when credential derivation fails", async () => {
    mocks.getSession.mockImplementationOnce(() => {
      throw new Error("invalid credential config");
    });
    const response = await POST(jsonRequest({ extension: "20" }));
    expect(response.status).toBe(500);
    expect(mocks.releaseExtension).toHaveBeenCalledWith({ test: true }, actor.organizationId, {});
  });

  it("validates the exact browser lease fence before exposing SIP credentials", async () => {
    const fence = {
      leaseId: "11111111-1111-4111-8111-111111111111",
      assignmentGeneration: "22222222-2222-4222-8222-222222222222",
      browserInstanceId: "33333333-3333-4333-8333-333333333333",
      leaderEpoch: 2,
      leaseVersion: 4,
    };
    const response = await POST(jsonRequest({ extension: "20", ...fence }));

    expect(response.status).toBe(200);
    expect(mocks.requireLease).toHaveBeenCalledWith(actor, { id: "extension-id", extension: "20" }, fence, {
      requireFence: true,
    });
    expect(mocks.requireLease.mock.invocationCallOrder[0]).toBeLessThan(mocks.getSession.mock.invocationCallOrder[0]);
  });

  it("never exposes credentials after lease fencing rejects a stale browser", async () => {
    mocks.requireLease.mockRejectedValueOnce(new MutationError("Relácia bola prevzatá.", 409, "lease_lost"));
    const response = await POST(jsonRequest({ extension: "20" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "lease_lost" });
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(mocks.claimExtension).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("never claims the extension or exposes SIP credentials when the listener bridge is unavailable", async () => {
    mocks.requestSnapshot.mockRejectedValueOnce(new MutationError("VIPTel listener neodpovedá.", 504));

    const response = await POST(jsonRequest({ extension: "20" }));

    expect(response.status).toBe(504);
    expect(mocks.claimExtension).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("does not expose unexpected server details in a 500 response", async () => {
    mocks.requestSnapshot.mockRejectedValueOnce(new Error("database host and internal secret"));

    const response = await POST(jsonRequest({ extension: "20" }));
    const result = await response.json();

    expect(response.status).toBe(500);
    expect(result).toEqual({ ok: false, error: "Pripojenie telefónu v prehliadači sa nepodarilo." });
    expect(JSON.stringify(result)).not.toContain("internal secret");
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("does not expose SIP credentials when the assignment CAS interlock loses a race", async () => {
    mocks.claimExtension.mockRejectedValueOnce(new MutationError("Priradenie klapky sa súbežne zmenilo.", 409));

    const response = await POST(jsonRequest({ extension: "20" }));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("returns every authentication error with no-store and never evaluates the gate", async () => {
    mocks.requireActor.mockRejectedValueOnce(new MutationError("Prihlásenie je povinné.", 401));

    const response = await POST(jsonRequest({ extension: "20" }));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it.each([
    { label: "an empty body", body: "" },
    { label: "malformed JSON", body: "{not-json" },
    { label: "a JSON array", body: "[]" },
    { label: "a JSON scalar", body: JSON.stringify("20") },
  ])("rejects $label without resolving an extension or issuing credentials", async ({ body }) => {
    const response = await POST(rawRequest(body));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.resolveExtension).not.toHaveBeenCalled();
    expect(mocks.claimExtension).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("https://app.test/api/telephony/webphone/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.test" },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string) {
  return new Request("https://app.test/api/telephony/webphone/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.test" },
    body,
  });
}
