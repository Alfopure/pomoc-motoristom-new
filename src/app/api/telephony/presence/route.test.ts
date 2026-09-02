import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  listAssignments: vi.fn(),
  latestSnapshot: vi.fn(),
  loadRouting: vi.fn(),
  resolveRouting: vi.fn(),
  refresh: vi.fn(),
  requireActor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/integrations/viptel/client", () => ({
  serializeViptelError: (error: unknown) => ({
    message: error instanceof Error ? error.message : "provider error",
    providerStatus: undefined,
    status: 500,
  }),
}));
vi.mock("@/server/telephony-access", () => ({
  requireTelephonyActor: mocks.requireActor,
}));
vi.mock("@/server/telephony-extensions", () => ({
  listTelephonyExtensionAssignments: mocks.listAssignments,
  refreshTelephonyPresence: mocks.refresh,
}));
vi.mock("@/server/telephony/dispatch-routing", () => ({
  getStoredDispatchRoutingOverview: mocks.loadRouting,
  resolvePlannedDispatchQueue: mocks.resolveRouting,
}));
vi.mock("@/server/telephony/live-mutation-gate", () => ({
  assertTelephonyLiveMutationEnabled: mocks.gate,
}));
vi.mock("@/server/telephony/provider-snapshot-bridge", () => ({
  readLatestConfirmedViptelProviderSnapshot: mocks.latestSnapshot,
}));

import { MutationError } from "@/server/motorist-mutations";
import { GET, POST } from "./route";

const actor = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  profileId: "00000000-0000-4000-8000-000000000002",
  role: "dispatcher",
};

describe("telephony presence route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.latestSnapshot.mockResolvedValue(null);
    mocks.listAssignments.mockResolvedValue([
      {
        id: "extension-20",
        extension: "20",
        active: true,
        profileId: actor.profileId,
        registered: true,
        allowedChanges: [],
        lastSyncedAt: "2026-08-04T10:00:00.000Z",
      },
    ]);
    mocks.loadRouting.mockResolvedValue({
      catalog: {
        queues: [
          { queue: "601", label: "Prvá priorita", id: "queue-row-601", action: "noop" },
          { queue: "602", label: "Druhá priorita", id: undefined, action: "insert" },
        ],
      },
      actualMemberships: [
        {
          queue: "601",
          extension: "20",
          paused: false,
          inUse: false,
          lastSyncedAt: "2026-08-04T10:00:10.000Z",
        },
      ],
      waitingCalls: [
        { queue: "601", count: 1, capturedAt: "2026-08-04T10:00:20.000Z" },
        { queue: "602", count: 0, capturedAt: undefined },
      ],
    });
    mocks.refresh.mockResolvedValue({
      checkedAt: "2026-08-04T10:01:00.000Z",
      extensions: [{
        id: "extension-20",
        extension: "20",
        active: true,
        profileId: actor.profileId,
        registered: true,
        allowedChanges: [],
      }],
    });
    mocks.resolveRouting.mockResolvedValue({ queue: "601", revision: 7 });
  });

  it("falls back to stored presence without gate, provider refresh, or synchronization", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      source: "stored",
      actorRouting: { queue: "601", revision: 7 },
      routingDiagnostic: null,
      snapshot: {
        checkedAt: "1970-01-01T00:00:00.000Z",
        queues: [{ id: "601", name: "Prvá priorita" }],
        queueStatuses: [{
          queue: "601",
          members: [{ extension: "20", paused: false, inUse: false }],
          waitingCalls: 1,
        }],
      },
    });
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.latestSnapshot).toHaveBeenCalledWith(actor.organizationId, { maxAgeMs: 30_000 });
    expect(mocks.resolveRouting).toHaveBeenCalledWith(actor.organizationId, "20");
  });

  it("uses a fresh signed cached snapshot for coherent queue state while preserving stored assignment identity", async () => {
    mocks.listAssignments.mockResolvedValueOnce([
      {
        id: "extension-20",
        extension: "20",
        active: true,
        assignmentEligible: true,
        assignmentRequirement: "initial_provisioning",
        profileId: actor.profileId,
        displayName: "Starý technický názov",
        outboundCid: "0410000000",
        callForwarding: "old",
        registered: false,
        viptelPhoneActive: false,
        allowedChanges: ["old"],
        lastSyncedAt: "2026-08-04T10:00:00.000Z",
      },
    ]);
    mocks.latestSnapshot.mockResolvedValueOnce({
      schemaVersion: 1,
      capturedAt: "2026-08-05T12:00:00.000Z",
      personalExtensions: ["20", "21", "22", "23"],
      activeCalls: [],
      extensions: [
        {
          extension: "20",
          name: "Aktuálny názov VIPTel",
          outboundCid: "0412289240",
          callForwarding: false,
          isRegistered: true,
          isViptelPhoneActive: true,
          allowedChanges: ["forward"],
          raw: {},
        },
      ],
      queues: [
        { id: "601", name: "Rad 601" },
        { id: "602", name: "Druhá priorita" },
        { id: "603", name: "Tretia priorita" },
      ],
      queueStatuses: [
        {
          queue: "601",
          waitingCalls: 2,
          members: [{ extension: "20", paused: false, inUse: true, dynamic: true, callsTaken: 4 }],
        },
        { queue: "602", waitingCalls: 0, members: [] },
        { queue: "603", waitingCalls: 1, members: [] },
      ],
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      source: "stored",
      snapshot: {
        checkedAt: "2026-08-05T12:00:00.000Z",
        extensions: [{
          id: "extension-20",
          profileId: actor.profileId,
          active: true,
          assignmentEligible: true,
          assignmentRequirement: "initial_provisioning",
          displayName: "Aktuálny názov VIPTel",
          outboundCid: "0412289240",
          callForwarding: "false",
          registered: true,
          viptelPhoneActive: true,
          allowedChanges: ["forward"],
          lastSyncedAt: "2026-08-05T12:00:00.000Z",
        }],
        queues: [
          { id: "601", name: "Prvá priorita" },
          { id: "602", name: "Druhá priorita" },
          { id: "603", name: "Tretia priorita" },
        ],
        queueStatuses: [{
          queue: "601",
          waitingCalls: 2,
          members: [{ extension: "20", paused: false, inUse: true, dynamic: true, callsTaken: 4 }],
        }, {
          queue: "602",
          waitingCalls: 0,
          members: [],
        }, {
          queue: "603",
          waitingCalls: 1,
          members: [],
        }],
      },
    });
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.resolveRouting).toHaveBeenCalledWith(actor.organizationId, "20");
  });

  it("fails closed instead of trusting stored fallback when a confirmed snapshot is invalid", async () => {
    mocks.latestSnapshot.mockRejectedValueOnce(new MutationError("VIPTel snapshot response je poškodený.", 502));

    const response = await GET();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "VIPTel snapshot response je poškodený.",
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("never invents an assignment identity from a provider-only extension", async () => {
    mocks.listAssignments.mockResolvedValueOnce([]);
    mocks.latestSnapshot.mockResolvedValueOnce({
      schemaVersion: 1,
      capturedAt: "2026-08-05T12:00:00.000Z",
      personalExtensions: ["20", "21", "22", "23"],
      activeCalls: [],
      extensions: [{
        extension: "20",
        name: "Provider-only extension",
        isRegistered: true,
        allowedChanges: [],
        raw: {},
      }],
      queues: [
        { id: "601", name: "Rad 601" },
        { id: "602", name: "Rad 602" },
        { id: "603", name: "Rad 603" },
      ],
      queueStatuses: [
        { queue: "601", waitingCalls: 0, members: [] },
        { queue: "602", waitingCalls: 0, members: [] },
        { queue: "603", waitingCalls: 0, members: [] },
      ],
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      actorRouting: null,
      routingDiagnostic: "Prihlásený operátor nemá priradenú aktívnu osobnú klapku.",
      snapshot: {
        checkedAt: "2026-08-05T12:00:00.000Z",
        extensions: [],
      },
    });
    expect(mocks.resolveRouting).not.toHaveBeenCalled();
  });

  it("authenticates and checks same-origin before rejecting a gated provider refresh", async () => {
    mocks.gate.mockImplementationOnce(() => {
      throw new MutationError("Telekomunikačné zásahy nie sú povolené.", 503);
    });
    const request = jsonRequest();

    const response = await POST(request);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireActor).toHaveBeenCalledWith(request);
    expect(mocks.requireActor.mock.invocationCallOrder[0]).toBeLessThan(mocks.gate.mock.invocationCallOrder[0]);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("refreshes provider presence only after the live gate succeeds", async () => {
    const response = await POST(jsonRequest());

    expect(response.status).toBe(200);
    expect(mocks.gate).toHaveBeenCalledWith("presence.sync");
    expect(mocks.refresh).toHaveBeenCalledWith(actor);
    expect(mocks.resolveRouting).toHaveBeenCalledWith(actor.organizationId, "20");
  });

  it("requests a new provider capture when SIP registration needs exact verification", async () => {
    const response = await POST(jsonRequest("?fresh=1"));

    expect(response.status).toBe(200);
    expect(mocks.refresh).toHaveBeenCalledWith(actor, { requireNewCapture: true });
  });

  it("keeps stored presence readable but locks availability when the actor is not in the plan", async () => {
    mocks.resolveRouting.mockRejectedValueOnce(new MutationError("Klapka nie je v pláne 601–603.", 403));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      actorRouting: null,
      routingDiagnostic: "Klapka nie je v pláne 601–603.",
      ok: true,
    });
  });
});

function jsonRequest(search = "") {
  return new Request(`https://app.test/api/telephony/presence${search}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.test" },
  });
}
