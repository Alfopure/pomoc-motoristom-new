import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  beginIntent: vi.fn(),
  claimAction: vi.fn(),
  listOwned: vi.fn(),
  requestSnapshot: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/telephony-access", () => ({ listOwnedTelephonyExtensions: mocks.listOwned }));
vi.mock("./assignment-interlock", () => ({ claimOwnedExtensionAction: mocks.claimAction }));
vi.mock("./provider-snapshot-bridge", () => ({ requestViptelProviderSnapshot: mocks.requestSnapshot }));
vi.mock("./telephony-commands", () => ({
  beginBrowserDtmfTransferIntent: mocks.beginIntent,
  beginTelephonyCommand: vi.fn(),
}));

import type { ViptelActiveCall } from "@/lib/integrations/viptel/client";
import { enqueueBrowserDtmfTransferCommand } from "./call-commands";

const ids = {
  call: "11111111-1111-4111-8111-111111111111",
  extension: "22222222-2222-4222-8222-222222222222",
  organization: "33333333-3333-4333-8333-333333333333",
  profile: "44444444-4444-4444-8444-444444444444",
};
const actor = { organizationId: ids.organization, profileId: ids.profile } as never;
const guard = {
  claimId: "55555555-5555-4555-8555-555555555555",
  extension: "20",
  extensionId: ids.extension,
  generation: "66666666-6666-4666-8666-666666666666",
  lifecycleEpoch: "77777777-7777-4777-8777-777777777777",
  profileId: ids.profile,
};
const fence = {
  assignmentGeneration: "99999999-9999-4999-8999-999999999991",
  browserInstanceId: "99999999-9999-4999-8999-999999999992",
  leaderEpoch: 2,
  leaseId: "99999999-9999-4999-8999-999999999993",
  leaseVersion: 3,
};

describe("browser DTMF live provider leg authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDatabaseRows();
    mocks.listOwned.mockResolvedValue([{
      id: ids.extension,
      extension: "20",
      profile_id: ids.profile,
    }]);
    mocks.claimAction.mockResolvedValue({ id: ids.extension, assignmentGuard: guard });
    mocks.beginIntent.mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      authorizedViptelUniqueId: "expected-live",
      tonePlan: ["#", "#", "2", "3"],
    });
  });

  it("authorizes exactly one live source leg, binds its unique id and bypasses cached snapshots", async () => {
    mocks.requestSnapshot.mockResolvedValue(snapshot([
      providerCall("answered", "expected-live"),
    ]));

    await expect(enqueueBrowserDtmfTransferCommand(actor, ids.call, "blind", "23", fence))
      .resolves.toMatchObject({ authorizedViptelUniqueId: "expected-live" });

    expect(mocks.requestSnapshot).toHaveBeenCalledWith(ids.organization, ids.profile, {
      maxAgeMs: 10_000,
      requireNewCapture: true,
    });
    expect(mocks.beginIntent).toHaveBeenCalledWith(expect.objectContaining({
      authorizedViptelUniqueId: "expected-live",
      callId: ids.call,
      extensionId: ids.extension,
    }));
    expect(mocks.claimAction).toHaveBeenCalledWith(actor, ids.extension, "call.transfer.dtmf", {
      leaseFence: fence,
    });
  });

  it("ignores an additional terminal row for the source extension", async () => {
    mocks.requestSnapshot.mockResolvedValue(snapshot([
      providerCall("ended", "old-terminal"),
      providerCall("answered", "expected-live"),
    ]));

    await expect(enqueueBrowserDtmfTransferCommand(actor, ids.call, "blind", "23"))
      .resolves.toBeDefined();
    expect(mocks.beginIntent).toHaveBeenCalledOnce();
  });

  it("rejects terminal-only rows before creating a DTMF intent", async () => {
    mocks.requestSnapshot.mockResolvedValue(snapshot([
      providerCall("ended", "expected-live"),
      providerCall("failed", "expected-live"),
      providerCall("missed", "expected-live"),
      providerCall("abandoned_queue", "expected-live"),
    ]));

    await expect(enqueueBrowserDtmfTransferCommand(actor, ids.call, "blind", "23"))
      .rejects.toMatchObject({ status: 409 });
    expect(mocks.beginIntent).not.toHaveBeenCalled();
  });

  it("rejects call-waiting or any other second live leg on the source extension", async () => {
    mocks.requestSnapshot.mockResolvedValue(snapshot([
      providerCall("answered", "expected-live"),
      providerCall("ringing_agent", "waiting-live"),
    ]));

    await expect(enqueueBrowserDtmfTransferCommand(actor, ids.call, "blind", "23"))
      .rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("viac než jeden aktívny hovor"),
      });
    expect(mocks.beginIntent).not.toHaveBeenCalled();
  });

  it("rejects a freshly observed replacement leg whose unique id does not match the app call", async () => {
    mocks.requestSnapshot.mockResolvedValue(snapshot([
      providerCall("ended", "expected-live"),
      providerCall("answered", "new-live"),
    ]));

    await expect(enqueueBrowserDtmfTransferCommand(actor, ids.call, "blind", "23"))
      .rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("nezodpovedá bezpečnej identite"),
      });
    expect(mocks.requestSnapshot).toHaveBeenCalledWith(ids.organization, ids.profile, {
      maxAgeMs: 10_000,
      requireNewCapture: true,
    });
    expect(mocks.beginIntent).not.toHaveBeenCalled();
  });
});

function installDatabaseRows() {
  const call = queryResult({
    data: {
      id: ids.call,
      organization_id: ids.organization,
      provider: "viptel",
      status: "answered",
      viptel_unique_id: "expected-live",
      from_queue_unique_id: null,
      extension_id: ids.extension,
      caller_extension: "20",
      received_extension: null,
      destination_extension: null,
    },
    error: null,
  });
  const aliases = queryResult({ data: [], error: null });
  const client = {
    from: vi.fn((table: string) => table === "motorist_calls" ? call.query : aliases.query),
  };
  mocks.admin.mockReturnValue(client);
}

function snapshot(activeCalls: ViptelActiveCall[]) {
  return { activeCalls };
}

function providerCall(status: ViptelActiveCall["status"], viptelUniqueId: string): ViptelActiveCall {
  return {
    direction: "outbound",
    status,
    viptelUniqueId,
    callerExtension: "20",
    raw: {},
  };
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
  return { query };
}
