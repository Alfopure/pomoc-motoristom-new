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
import { enqueueHangupCommand, enqueueRedirectCommand, listAvailableTransferTargets } from "./call-commands";

const ids = {
  call: "11111111-1111-4111-8111-111111111111",
  organization: "22222222-2222-4222-8222-222222222222",
  sourceExtension: "33333333-3333-4333-8333-333333333333",
  sourceProfile: "44444444-4444-4444-8444-444444444444",
  targetExtension: "55555555-5555-4555-8555-555555555555",
  targetProfile: "66666666-6666-4666-8666-666666666666",
};
const actor = { organizationId: ids.organization, profileId: ids.sourceProfile } as never;
const source = { id: ids.sourceExtension, extension: "20", profile_id: ids.sourceProfile };
const target = { id: ids.targetExtension, extension: "21", profile_id: ids.targetProfile };

describe("ringing inbound transfer authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDatabaseRows();
    mocks.listOwned.mockResolvedValue([source]);
    mocks.lifecycle.mockImplementation(async (_client, _organizationId, extension) => ({
      epoch: `epoch-${extension.extension}`,
    }));
    mocks.claimAction.mockResolvedValue({
      id: ids.sourceExtension,
      assignmentGuard: { extensionId: ids.sourceExtension },
    });
    mocks.beginCommand.mockResolvedValue({ id: "77777777-7777-4777-8777-777777777777" });
  });

  it("lists another available workplace while VIPTel keeps only the queue parent live", async () => {
    mocks.requestSnapshot.mockResolvedValue(ringingSnapshot());

    await expect(listAvailableTransferTargets(actor, ids.call)).resolves.toEqual([{
      extension: "21",
      extensionId: ids.targetExtension,
      lifecycleEpoch: "epoch-21",
      operatorName: "Operátor 21",
      profileId: ids.targetProfile,
    }]);
  });

  it("redirects the ringing queue parent and preserves both provider ids for confirmation", async () => {
    mocks.requestSnapshot.mockResolvedValue(ringingSnapshot());

    await enqueueRedirectCommand(actor, ids.call, { destinationProfileId: ids.targetProfile });

    expect(mocks.requestSnapshot).toHaveBeenCalledWith(ids.organization, ids.sourceProfile, {
      maxAgeMs: 10_000,
      requireNewCapture: true,
    });
    expect(mocks.beginCommand).toHaveBeenCalledWith(expect.objectContaining({
      callId: ids.call,
      commandType: "call.redirect",
      extensionId: ids.sourceExtension,
      requestPayload: expect.objectContaining({
        confirmationUniqueIds: expect.arrayContaining(["agent-leg-20", "queue-parent"]),
        destinationExtension: "21",
        sourceExtension: "20",
        uniqueId: "queue-parent",
      }),
    }));
  });

  it("does not let the previous workplace steal a call that is already ringing elsewhere", async () => {
    mocks.requestSnapshot.mockResolvedValue(ringingSnapshot([
      inboundCall("ringing_agent", "agent-leg-21", "21", "queue-parent"),
    ]));

    await expect(listAvailableTransferTargets(actor, ids.call)).rejects.toMatchObject({
      message: "Aktuálny VIPTel leg už patrí inému pracovnému miestu.",
      status: 403,
    });
    // The rejection is retried once against a forced-fresh capture; the fence
    // holds when the fresh view says the same thing.
    expect(mocks.requestSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.requestSnapshot).toHaveBeenLastCalledWith(ids.organization, ids.sourceProfile, {
      maxAgeMs: 10_000,
      requireNewCapture: true,
    });
    expect(mocks.beginCommand).not.toHaveBeenCalled();
  });

  it("retries a stale correlation against a fresh capture instead of failing the first click", async () => {
    // The rotation replaces the live agent leg every few seconds. The transfer
    // picker accepted a snapshot up to ten seconds old, so it regularly
    // described the previous leg at the previous workstation and rejected the
    // operator who genuinely holds the call now -- and the second click
    // worked, because it saw newer data. The second look happens server-side
    // now: a stale-looking rejection re-resolves once against a forced-fresh
    // capture.
    mocks.requestSnapshot
      .mockResolvedValueOnce(ringingSnapshot([
        inboundCall("ringing_agent", "agent-leg-21", "21", "queue-parent"),
      ]))
      // The fresh capture, and every later read the picker itself makes.
      .mockResolvedValue(ringingSnapshot([
        inboundCall("ringing_agent", "agent-leg-20b", "20", "queue-parent"),
      ]));

    await expect(listAvailableTransferTargets(actor, ids.call)).resolves.toEqual([
      expect.objectContaining({ extension: "21" }),
    ]);
    expect(mocks.requestSnapshot).toHaveBeenNthCalledWith(1, ids.organization, ids.sourceProfile, {
      maxAgeMs: 10_000,
      requireNewCapture: false,
    });
    expect(mocks.requestSnapshot).toHaveBeenNthCalledWith(2, ids.organization, ids.sourceProfile, {
      maxAgeMs: 10_000,
      requireNewCapture: true,
    });
  });

  it("does not confuse an unrelated call from the same phone number with this queue parent", async () => {
    mocks.requestSnapshot.mockResolvedValue(ringingSnapshot([
      inboundCall("ringing_agent", "unrelated-agent-leg-21", "21", "another-queue-parent"),
    ]));

    await enqueueHangupCommand(actor, ids.call, undefined, { incomingQueueDecline: true });

    expect(mocks.beginCommand).toHaveBeenCalledWith(expect.objectContaining({
      callId: ids.call,
      commandType: "call.hangup",
      extensionId: ids.sourceExtension,
      requestPayload: expect.objectContaining({
        sourceExtension: "20",
        uniqueId: "queue-parent",
      }),
    }));
  });

  it("declines one ringing queue call when VIPTel exposes duplicate agent legs at its workstation", async () => {
    mocks.requestSnapshot.mockResolvedValue(ringingSnapshot([
      inboundCall("ringing_agent", "agent-leg-20-a", "20", "queue-parent"),
      inboundCall("ringing_agent", "agent-leg-20-b", "20", "queue-parent"),
    ]));

    await enqueueHangupCommand(actor, ids.call, undefined, { incomingQueueDecline: true });

    expect(mocks.beginCommand).toHaveBeenCalledWith(expect.objectContaining({
      callId: ids.call,
      commandType: "call.hangup",
      extensionId: ids.sourceExtension,
      requestPayload: expect.objectContaining({
        confirmationUniqueIds: expect.arrayContaining([
          "agent-leg-20-a",
          "agent-leg-20-b",
          "queue-parent",
        ]),
        sourceExtension: "20",
        uniqueId: "queue-parent",
      }),
    }));
  });

  it("declines the live queue parent during the short stored queue-left handoff", async () => {
    installDatabaseRows({
      status: "abandoned_queue",
      ended_at: null,
      answered_at: null,
      updated_at: new Date().toISOString(),
    });
    mocks.requestSnapshot.mockResolvedValue(ringingSnapshot());

    await enqueueHangupCommand(actor, ids.call, undefined, { incomingQueueDecline: true });

    expect(mocks.beginCommand).toHaveBeenCalledWith(expect.objectContaining({
      callId: ids.call,
      commandType: "call.hangup",
      requestPayload: expect.objectContaining({
        uniqueId: "queue-parent",
      }),
    }));
  });

  it("keeps the existing answered-call transfer bound to the exact operator leg", async () => {
    installDatabaseRows({ status: "answered" });
    mocks.requestSnapshot.mockResolvedValue(answeredSnapshot());

    await enqueueRedirectCommand(actor, ids.call, { destinationProfileId: ids.targetProfile });

    expect(mocks.beginCommand).toHaveBeenCalledWith(expect.objectContaining({
      requestPayload: expect.objectContaining({ uniqueId: "agent-leg-20" }),
    }));
  });
});

function installDatabaseRows(overrides: Record<string, unknown> = {}) {
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
        extension_id: ids.sourceExtension,
        operator_id: ids.sourceProfile,
        received_extension: null,
        destination_extension: "20",
        updated_at: new Date().toISOString(),
        ...overrides,
      },
      error: null,
    },
    motorist_call_events: { data: [], error: null },
    motorist_profiles: {
      data: [
        { id: ids.sourceProfile, display_name: "Operátor 20" },
        { id: ids.targetProfile, display_name: "Operátor 21" },
      ],
      error: null,
    },
    motorist_telephony_extensions: {
      data: [
        { ...source, metadata: {} },
        { ...target, metadata: {} },
      ],
      error: null,
    },
  };
  const client = {
    from: vi.fn((table: string) => queryResult(rows[table] ?? { data: [], error: null })),
  };
  mocks.admin.mockReturnValue(client);
}

function ringingSnapshot(extraCalls: ViptelActiveCall[] = []) {
  return snapshot([
    inboundCall("missed", "agent-leg-20", "20", "queue-parent"),
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
  ]);
}

function answeredSnapshot() {
  return snapshot([
    inboundCall("answered", "agent-leg-20", "20", "queue-parent"),
  ]);
}

function snapshot(activeCalls: ViptelActiveCall[]) {
  return {
    activeCalls,
    extensions: [providerExtension("20"), providerExtension("21")],
    personalExtensions: ["20", "21"],
    queueStatuses: [{
      queue: "601",
      waitingCalls: 1,
      members: [queueMember("20", true), queueMember("21", false)],
    }],
  };
}

function inboundCall(
  status: ViptelActiveCall["status"],
  viptelUniqueId: string,
  extension: string,
  fromQueueUniqueId: string,
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

function queueMember(extension: string, inUse: boolean) {
  return { extension, paused: false, inUse, dynamic: true, callsTaken: 0 };
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
