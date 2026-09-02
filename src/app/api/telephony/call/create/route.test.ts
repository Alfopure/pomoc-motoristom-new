import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  claim: vi.fn(),
  readReport: vi.fn(),
  reconcileInvite: vi.fn(),
  recordUnsentInvite: vi.fn(),
  requestSnapshot: vi.fn(),
  requireSnapshotExtension: vi.fn(),
  requireActor: vi.fn(),
  requireLease: vi.fn(),
  resolveOwned: vi.fn(),
}));

vi.mock("server-only", () => ({}));
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
  resolveOwnedTelephonyExtension: mocks.resolveOwned,
}));
vi.mock("@/server/telephony/assignment-interlock", () => ({ claimOwnedExtensionAction: mocks.claim }));
vi.mock("@/server/telephony/telephony-commands", () => ({
  beginSerializedOutboundCall: mocks.begin,
  readBrowserSipReconciliationReport: mocks.readReport,
  reconcileBrowserSipInvite: mocks.reconcileInvite,
  recordUnsentBrowserSipInvite: mocks.recordUnsentInvite,
}));
vi.mock("@/server/telephony/provider-snapshot-bridge", () => ({
  requestViptelProviderSnapshot: mocks.requestSnapshot,
  requirePersonalExtensionInSnapshot: mocks.requireSnapshotExtension,
}));

import { PATCH, POST } from "./route";

describe("outbound call route caller identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue({ organizationId: "org-1", profileId: "profile-1" });
    mocks.resolveOwned.mockResolvedValue({ id: "extension-id-20", extension: "20" });
    mocks.claim.mockResolvedValue({
      id: "extension-id-20",
      extension: "20",
      assignmentGuard: { claimId: "claim-20" },
    });
    mocks.requestSnapshot.mockResolvedValue({ personalExtensions: ["20"], extensions: [{ extension: "20", isRegistered: true }] });
    mocks.begin.mockResolvedValue({ id: "command-1", idempotencyKey: "request-1" });
    mocks.readReport.mockImplementation((report) => report);
    mocks.reconcileInvite.mockResolvedValue({
      deliveryUncertain: false,
      id: "22222222-2222-4222-8222-222222222222",
      status: "failed",
    });
    mocks.recordUnsentInvite.mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222", status: "failed" });
  });

  it("rejects a client-supplied callerId before extension claim or command creation", async () => {
    const response = await POST(new Request("https://app.test/api/telephony/call/create", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.test" },
      body: JSON.stringify({
        callerId: "0412289241",
        fromExtension: "20",
        mode: "browser_sip",
        toNumber: "0900111222",
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("controlled by the server"),
    });
    expect(mocks.resolveOwned).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", value: undefined },
    { label: "empty", value: "" },
    { label: "Unicode digits", value: "１２３４" },
    { label: "an injected separator", value: "12;DROP TABLE calls" },
    { label: "more than 18 digits", value: "1".repeat(19) },
  ])("rejects a $label destination before any command or extension claim", async ({ value }) => {
    const response = await POST(jsonRequest({ fromExtension: "20", toNumber: value }));

    expect(response.status).toBe(400);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
  });

  it("allows a direct browser SIP intent after a fresh personal snapshot even when provider flags lag", async () => {
    const providerOfflineSnapshot = {
      personalExtensions: ["20"],
      extensions: [{ extension: "20", isViptelPhoneActive: false, isRegistered: true }],
    };
    mocks.requestSnapshot.mockResolvedValueOnce(providerOfflineSnapshot);
    const response = await POST(jsonRequest({
      fromExtension: "20",
      mode: "browser_sip",
      toNumber: "23",
    }));

    expect(response.status).toBe(202);
    expect(mocks.requestSnapshot).toHaveBeenCalledWith("org-1", "profile-1", {
      maxAgeMs: 2_000,
      requireNewCapture: true,
    });
    expect(mocks.requireSnapshotExtension).toHaveBeenCalledWith(
      providerOfflineSnapshot,
      "20",
      { allowInactiveForBrowserSipIntent: true, requireRegistered: true },
    );
    expect(mocks.requestSnapshot.mock.invocationCallOrder[0]).toBeLessThan(mocks.claim.mock.invocationCallOrder[0]);
    expect(mocks.requireSnapshotExtension.mock.invocationCallOrder[0]).toBeLessThan(mocks.claim.mock.invocationCallOrder[0]);
    expect(mocks.begin).toHaveBeenCalledOnce();
  });

  it("does not claim an extension or create an intent when the personal snapshot rejects browser SIP", async () => {
    const { MutationError } = await import("@/server/motorist-mutations");
    mocks.requireSnapshotExtension.mockImplementationOnce(() => {
      throw new MutationError(
        "Klapka 20 nie je povolená v aktuálnej VIPTel konfigurácii.",
        409,
      );
    });

    const response = await POST(jsonRequest({
      fromExtension: "20",
      mode: "browser_sip",
      toNumber: "23",
    }));

    expect(response.status).toBe(409);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "legacy webphone",
      mode: "webphone",
      snapshotOptions: { maxAgeMs: 2_000, requireNewCapture: true },
      extensionOptions: { requireRegistered: true },
    },
    {
      label: "extension callback",
      mode: "extension_callback",
      snapshotOptions: { maxAgeMs: 2_000 },
      extensionOptions: { requireRegistered: false },
    },
  ])("keeps provider registration requirements unchanged for $label", async ({
    extensionOptions,
    mode,
    snapshotOptions,
  }) => {
    const response = await POST(jsonRequest({ fromExtension: "20", mode, toNumber: "23" }));

    expect(response.status).toBe(202);
    expect(mocks.requestSnapshot).toHaveBeenCalledWith("org-1", "profile-1", snapshotOptions);
    expect(mocks.requireSnapshotExtension).toHaveBeenCalledWith(
      { personalExtensions: ["20"], extensions: [{ extension: "20", isRegistered: true }] },
      "20",
      extensionOptions,
    );
    expect(mocks.begin).toHaveBeenCalledOnce();
  });

  it("does not create a durable call command when the listener handshake fails", async () => {
    mocks.requestSnapshot.mockRejectedValueOnce(new (await import("@/server/motorist-mutations")).MutationError(
      "VIPTel listener neodpovedá.",
      504,
    ));

    const response = await POST(jsonRequest({ fromExtension: "20", toNumber: "23" }));

    expect(response.status).toBe(504);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("rejects an old browser lease before provider or command work", async () => {
    const { MutationError } = await import("@/server/motorist-mutations");
    mocks.requireLease.mockRejectedValueOnce(new MutationError("Relácia bola prevzatá.", 409, "lease_lost"));
    const response = await POST(jsonRequest({
      fromExtension: "20",
      toNumber: "23",
      leaseId: "11111111-1111-4111-8111-111111111111",
      assignmentGeneration: "22222222-2222-4222-8222-222222222222",
      browserInstanceId: "33333333-3333-4333-8333-333333333333",
      leaderEpoch: 1,
      leaseVersion: 1,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "lease_lost" });
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("does not authorize browser SIP when a pre-existing snapshot request occupies the fresh slot", async () => {
    mocks.requestSnapshot.mockRejectedValueOnce(new (await import("@/server/motorist-mutations")).MutationError(
      "Čerstvý VIPTel snapshot čaká na staršiu požiadavku.",
      409,
    ));

    const response = await POST(jsonRequest({
      fromExtension: "20",
      mode: "browser_sip",
      toNumber: "23",
    }));

    expect(response.status).toBe(409);
    expect(mocks.requestSnapshot).toHaveBeenCalledWith("org-1", "profile-1", {
      maxAgeMs: 2_000,
      requireNewCapture: true,
    });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and an oversized mode before ownership or command work", async () => {
    const malformed = await POST(rawRequest("{broken"));
    expect(malformed.status).toBe(400);
    expect(mocks.resolveOwned).not.toHaveBeenCalled();

    const oversizedMode = await POST(jsonRequest({
      fromExtension: "20",
      mode: `webphone${"x".repeat(4096)}`,
      toNumber: "23",
    }));
    expect(oversizedMode.status).toBe(400);
    expect(mocks.resolveOwned).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("keeps dry-run read-only and fixes outbound CID to the neutral server value", async () => {
    const response = await POST(jsonRequest({
      dryRun: true,
      fromExtension: "20",
      toNumber: "+421 900 111 222",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      dryRun: true,
      request: {
        caller: "20",
        destination: "0900111222",
        requestedCallerId: "0412289240",
      },
    });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("records only the authenticated actor's pre-send browser INVITE failure", async () => {
    const response = await PATCH(jsonRequest({
      commandId: "22222222-2222-4222-8222-222222222222",
    }, "PATCH"));

    expect(response.status).toBe(200);
    expect(mocks.requireActor).toHaveBeenCalledOnce();
    expect(mocks.recordUnsentInvite).toHaveBeenCalledWith({
      commandId: "22222222-2222-4222-8222-222222222222",
      organizationId: "org-1",
      requestedBy: "profile-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      command: { status: "failed" },
    });
  });

  it("does not accept malformed browser INVITE failure reports", async () => {
    const response = await PATCH(rawRequest("null", "PATCH"));

    expect(response.status).toBe(400);
    expect(mocks.recordUnsentInvite).not.toHaveBeenCalled();
  });

  it("reconciles an unconfirmed browser SIP attempt against a new provider snapshot", async () => {
    const providerSnapshot = {
      activeCalls: [],
      capturedAt: "2026-08-06T13:30:00.000Z",
      extensions: [{ extension: "20", isRegistered: true }],
      personalExtensions: ["20"],
    };
    mocks.requestSnapshot.mockResolvedValueOnce(providerSnapshot);
    const browserReport = { outcome: "rejected", statusCode: 486 };
    const response = await PATCH(jsonRequest({
      browserReport,
      commandId: "22222222-2222-4222-8222-222222222222",
      outcome: "reconcile",
    }, "PATCH"));

    expect(response.status).toBe(200);
    expect(mocks.requestSnapshot).toHaveBeenCalledWith("org-1", "profile-1", {
      maxAgeMs: 2_000,
      requireNewCapture: true,
    });
    expect(mocks.reconcileInvite).toHaveBeenCalledWith({
      browserReport,
      commandId: "22222222-2222-4222-8222-222222222222",
      organizationId: "org-1",
      providerActiveCalls: [],
      providerCapturedAt: providerSnapshot.capturedAt,
      requestedBy: "profile-1",
    });
    expect(mocks.recordUnsentInvite).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      command: { deliveryUncertain: false, status: "failed" },
    });
  });

  it("rejects an unknown reconciliation outcome before provider access", async () => {
    const response = await PATCH(jsonRequest({
      commandId: "22222222-2222-4222-8222-222222222222",
      outcome: "force_retry",
    }, "PATCH"));

    expect(response.status).toBe(400);
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(mocks.reconcileInvite).not.toHaveBeenCalled();
    expect(mocks.recordUnsentInvite).not.toHaveBeenCalled();
  });

  it("rejects a timeout-only reconciliation report before requesting provider state", async () => {
    const { MutationError } = await import("@/server/motorist-mutations");
    mocks.readReport.mockImplementationOnce(() => {
      throw new MutationError("Výsledok SIP hovoru nie je platný.", 400);
    });

    const response = await PATCH(jsonRequest({
      browserReport: { outcome: "confirmation_timeout" },
      commandId: "22222222-2222-4222-8222-222222222222",
      outcome: "reconcile",
    }, "PATCH"));

    expect(response.status).toBe(400);
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(mocks.reconcileInvite).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: Record<string, unknown>, method = "POST") {
  return rawRequest(JSON.stringify(body), method);
}

function rawRequest(body: string, method = "POST") {
  return new Request("https://app.test/api/telephony/call/create", {
    method,
    headers: { "content-type": "application/json", origin: "https://app.test" },
    body,
  });
}
