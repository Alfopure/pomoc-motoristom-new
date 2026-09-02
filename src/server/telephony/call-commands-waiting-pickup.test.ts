import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  beginCommand: vi.fn(),
  claimAction: vi.fn(),
  lifecycle: vi.fn(),
  listOwned: vi.fn(),
  releaseGuard: vi.fn(),
  requestSnapshot: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/telephony-access", () => ({ listOwnedTelephonyExtensions: mocks.listOwned }));
vi.mock("./assignment-interlock", () => ({
  claimOwnedExtensionAction: mocks.claimAction,
  releaseExtensionAssignmentGuard: mocks.releaseGuard,
}));
vi.mock("./assignment-lifecycle", () => ({ requireImmutableAssignmentLifecycle: mocks.lifecycle }));
vi.mock("./provider-snapshot-bridge", () => ({ requestViptelProviderSnapshot: mocks.requestSnapshot }));
vi.mock("./telephony-commands", () => ({
  beginBrowserDtmfTransferIntent: vi.fn(),
  beginBrowserSipReferTransferIntent: vi.fn(),
  beginTelephonyCommand: mocks.beginCommand,
}));

import type { ViptelActiveCall } from "@/lib/integrations/viptel/client";
import { enqueueWaitingCallPickupCommand } from "./call-commands";

const ids = {
  call: "11111111-1111-4111-8111-111111111111",
  organization: "22222222-2222-4222-8222-222222222222",
  targetExtension: "33333333-3333-4333-8333-333333333333",
  targetProfile: "44444444-4444-4444-8444-444444444444",
};
const actor = { organizationId: ids.organization, profileId: ids.targetProfile } as never;
const target = { id: ids.targetExtension, extension: "21", profile_id: ids.targetProfile };

describe("waiting room pickup command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDatabaseRows();
    mocks.listOwned.mockResolvedValue([target]);
    mocks.lifecycle.mockResolvedValue({ epoch: "55555555-5555-4555-8555-555555555555" });
    mocks.claimAction.mockResolvedValue({
      id: ids.targetExtension,
      assignmentGuard: { extensionId: ids.targetExtension },
    });
    mocks.beginCommand.mockResolvedValue({ id: "66666666-6666-4666-8666-666666666666" });
    mocks.requestSnapshot.mockResolvedValue(snapshot());
  });

  it("claims a call ringing elsewhere and redirects its queue parent to my registered workplace", async () => {
    await enqueueWaitingCallPickupCommand(actor, ids.call, "21");

    expect(mocks.claimAction).toHaveBeenCalledWith(actor, ids.targetExtension, "call.redirect", { leaseFence: undefined });
    expect(mocks.beginCommand).toHaveBeenCalledWith(expect.objectContaining({
      callId: ids.call,
      commandType: "call.redirect",
      extensionId: ids.targetExtension,
      requestedBy: ids.targetProfile,
      requestPayload: expect.objectContaining({
        destinationExtension: "21",
        destinationProfileId: ids.targetProfile,
        uniqueId: "queue-parent",
        waitingRoomPickup: true,
      }),
      uniqueConflictMessage: expect.stringContaining("už preberá"),
    }));
  });

  it("accepts a PBX-answered queue parent while no dispatcher agent has answered it", async () => {
    installDatabaseRows({
      status: "answered",
      answered_at: "2026-09-01T12:00:01.000Z",
      queue_number: "601",
    });

    await enqueueWaitingCallPickupCommand(actor, ids.call, "21");

    expect(mocks.beginCommand).toHaveBeenCalledWith(expect.objectContaining({
      callId: ids.call,
      requestPayload: expect.objectContaining({ uniqueId: "queue-parent", waitingRoomPickup: true }),
    }));
  });

  it("does not replace another live call already using my browser workplace", async () => {
    mocks.requestSnapshot.mockResolvedValue(snapshot([
      providerCall("answered", "other-call", "21"),
    ]));

    await expect(enqueueWaitingCallPickupCommand(actor, ids.call, "21")).rejects.toMatchObject({
      message: "Na tomto pracovnom mieste už zvoní alebo prebieha iný hovor.",
      status: 409,
    });
    expect(mocks.claimAction).not.toHaveBeenCalled();
    expect(mocks.beginCommand).not.toHaveBeenCalled();
  });
});

function installDatabaseRows(callOverrides: Record<string, unknown> = {}) {
  const rows: Record<string, { data: unknown; error: null }> = {
    motorist_calls: {
      data: {
        id: ids.call,
        organization_id: ids.organization,
        provider: "viptel",
        direction: "inbound",
        status: "ringing_agent",
        viptel_unique_id: "agent-leg-20",
        from_queue_unique_id: "queue-parent",
        queue_number: "601",
        answered_at: null,
        ended_at: null,
        ...callOverrides,
      },
      error: null,
    },
    motorist_call_events: { data: [], error: null },
    motorist_telephony_extensions: {
      data: { ...target, active: true, metadata: {} },
      error: null,
    },
  };
  mocks.admin.mockReturnValue({
    from: vi.fn((table: string) => queryResult(rows[table] ?? { data: [], error: null })),
  });
}

function snapshot(extraCalls: ViptelActiveCall[] = []) {
  return {
    activeCalls: [
      providerCall("ringing_agent", "agent-leg-20", "20", "queue-parent"),
      {
        direction: "inbound" as const,
        status: "answered" as const,
        viptelUniqueId: "queue-parent",
        callerNumber: "+421900111222",
        calledNumber: "+421220001111",
        destinationNumber: "+421220001111",
        raw: {},
      },
      ...extraCalls,
    ],
    extensions: [providerExtension("20"), providerExtension("21")],
    personalExtensions: ["20", "21"],
    queueStatuses: [],
  };
}

function providerCall(
  status: ViptelActiveCall["status"],
  viptelUniqueId: string,
  extension: string,
  fromQueueUniqueId?: string,
): ViptelActiveCall {
  return {
    direction: "inbound",
    status,
    viptelUniqueId,
    fromQueueUniqueId,
    callerNumber: "+421900111222",
    calledNumber: extension,
    destinationNumber: extension,
    raw: {},
  };
}

function providerExtension(extension: string) {
  return { extension, isRegistered: true, allowedChanges: [], raw: {} };
}

function queryResult(result: { data: unknown; error: unknown }) {
  const query = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      return () => property === "maybeSingle" ? Promise.resolve(result) : query;
    },
  });
  return query;
}
