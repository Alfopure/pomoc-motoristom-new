import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeMocks = vi.hoisted(() => ({ requestSnapshot: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/server/telephony/provider-snapshot-bridge", () => ({
  requestViptelProviderSnapshot: bridgeMocks.requestSnapshot,
}));

import type { ViptelActiveCall, ViptelExtension, ViptelQueueStatus } from "@/lib/integrations/viptel/client";
import type { Json } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { dispatchRoutingCommittedPlanDigest } from "./telephony/dispatch-routing";
import { authorizeWorkplacePriorityDraft } from "./telephony/workplace-draft-authority";
import {
  assertLiveAssignmentSafety,
  assertProviderAssignmentSafety,
  claimSelfServiceTelephonyExtension,
  dispatchRoutingReferencesExtension,
  hasBlockingExtensionCommand,
  releaseSelfServiceTelephonyExtension,
  setTelephonyExtensionAssignment,
  synchronizeViptelExtensions,
} from "./telephony-extensions";
import {
  configuredPersonalExtensions,
  isLegacySeededProfileExtension,
} from "./telephony/personal-extension-config";

const actor: MotoristActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  profileId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
  displayName: "Manager",
  role: "manager",
};
const extensionId = "44444444-4444-4444-8444-444444444444";
const operatorId = "55555555-5555-4555-8555-555555555555";
const currentOwnerId = "66666666-6666-4666-8666-666666666666";
const rotationReference = "VIPTEL-2026-08-04-20";
const timestamp = "2026-08-04T16:00:00.000Z";
const transitionId = "77777777-7777-4777-8777-777777777777";
const assignmentGeneration = "88888888-8888-4888-8888-888888888888";
const recoveryTransitionId = "99999999-9999-4999-8999-999999999999";
const recoveryGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  bridgeMocks.requestSnapshot.mockReset();
  delete process.env.VIPTEL_DISPATCH_PERSONAL_EXTENSIONS;
  delete process.env.VIPTEL_LIVE_MUTATIONS_ENABLED;
  delete process.env.VIPTEL_LIVE_MUTATION_TOKEN;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_MODE;
  delete process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS;
});

describe("personal extension allowlist", () => {
  it("defaults exactly to personal extensions 20-23 and accepts an explicit valid allowlist", () => {
    expect(configuredPersonalExtensions()).toEqual(["20", "21", "22", "23"]);
    process.env.VIPTEL_DISPATCH_PERSONAL_EXTENSIONS = "31, 32,31";
    expect(configuredPersonalExtensions()).toEqual(["31", "32"]);
  });

  it("fails closed for an explicitly malformed allowlist", () => {
    process.env.VIPTEL_DISPATCH_PERSONAL_EXTENSIONS = "20,not-an-extension";
    expect(() => configuredPersonalExtensions()).toThrow("invalid personal extension allowlist");
  });

  it("recognizes only the original demo seats as replaceable legacy profile values", () => {
    expect(isLegacySeededProfileExtension("102")).toBe(true);
    expect(isLegacySeededProfileExtension("20")).toBe(false);
    expect(isLegacySeededProfileExtension("999")).toBe(false);

    process.env.VIPTEL_DISPATCH_PERSONAL_EXTENSIONS = "20,21,22,23,102";
    expect(isLegacySeededProfileExtension("102")).toBe(false);
  });

  it("rejects assignment of an extension outside the allowlist before provider access", async () => {
    const lookup = queryResult({ data: extensionRow({ extension: "99" }), error: null });
    const client = sequentialClient([lookup]);
    const viptel = safeProvider();

    await expect(assign(client, viptel)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("povolenými") });
    expect(viptel.listExtensions).not.toHaveBeenCalled();
  });
});

describe("live VIPTel assignment safety", () => {
  it("requires one exact provider extension with isRegistered=false", () => {
    expect(() => assertProviderAssignmentSafety("20", live({ registered: true }))).toThrow("odregistrovaná");
    expect(() => assertProviderAssignmentSafety("20", live({ omitExtension: true }))).toThrow("odregistrovaná");
    expect(() => assertProviderAssignmentSafety("20", live({ duplicateExtension: true }))).toThrow("odregistrovaná");
  });

  it("blocks an exact active-call endpoint without suffix matching", () => {
    expect(() => assertProviderAssignmentSafety("20", live({ callEndpoint: "20" }))).toThrow("aktívny hovor");
    expect(() => assertProviderAssignmentSafety("20", live({ callEndpoint: "120" }))).not.toThrow();
  });

  it("blocks any membership in queues 601-603", () => {
    expect(() => assertProviderAssignmentSafety("20", live({ memberQueue: "602" }))).toThrow("stále členom");
  });

  it("fails closed when the provider omits one of queues 601-603", () => {
    expect(() => assertProviderAssignmentSafety("20", live({ omitQueue: "603" }))).toThrow("všetkých radov");
  });
});

describe("shared workplace claim", () => {
  it("rejects an occupied target before releasing the actor's current seat or reading VIPTel", async () => {
    process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "true";
    process.env.VIPTEL_LIVE_MUTATION_TOKEN = "x".repeat(32);
    const occupied = queryResult({
      data: extensionRow({ extension: "21", profile_id: currentOwnerId }),
      error: null,
    });
    const client = sequentialClient([occupied]);
    const viptel = safeProvider();

    await expect(claimSelfServiceTelephonyExtension(actor, "21", {
      client: client as never,
      viptel,
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("iný operátor") });

    expect(client.from).toHaveBeenCalledTimes(1);
    expect(viptel.listExtensions).not.toHaveBeenCalled();
    expect(viptel.listActiveCalls).not.toHaveBeenCalled();
  });

  it("cannot claim another seat while an administrative takeover has cleared only the source reservation", async () => {
    enableLiveMutations();
    const lifecycle = workplaceLifecycle();
    const sourceInHandoff = extensionRow({
      profile_id: actor.profileId,
      metadata: {
        assignmentLifecycle: lifecycle,
        assignmentTransition: {
          active: true,
          kind: "workplace_takeover",
          phase: "source_released",
        },
      },
    });
    const target = queryResult({
      data: extensionRow({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", extension: "21" }),
      error: null,
    });
    const ownedBeforeClaim = queryResult({ data: [{ id: extensionId, extension: "20" }], error: null });
    const ownedBeforeRelease = queryResult({ data: [sourceInHandoff], error: null });
    const immutableAudit = queryResult({
      data: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        action: "telephony.extension.assign",
        after_payload: { assignment_lifecycle: lifecycle },
        created_at: timestamp,
      },
      error: null,
    });
    const clearedSourceProfile = queryResult({
      data: { id: actor.profileId, phone_extension: null },
      error: null,
    });
    const client = sequentialClient([
      target,
      ownedBeforeClaim,
      ownedBeforeRelease,
      immutableAudit,
      clearedSourceProfile,
    ]);
    const viptel = safeProvider();

    await expect(claimSelfServiceTelephonyExtension(actor, "21", {
      client: client as never,
      viptel,
    })).rejects.toMatchObject({ status: 409 });

    expect(client.from).toHaveBeenCalledTimes(5);
    expect(viptel.listExtensions).not.toHaveBeenCalled();
  });

  it("claims historical ext20 through workplace_claim without a fake rotation attestation", async () => {
    enableLiveMutations();
    const historicalMetadata = {
      assignmentQuarantine: {
        active: false,
        extension: "20",
        previousProfileId: currentOwnerId,
        requiresSipCredentialRotation: true,
      },
    };
    const queries = workplaceClaimQueries(historicalMetadata);
    const client = sequentialClient(queries);

    await expect(claimSelfServiceTelephonyExtension(actor, "20", {
      client: client as never,
      now: () => timestamp,
      randomId: deterministicTransitionId,
      viptel: safeProvider(),
    })).resolves.toMatchObject({ extension: "20", profile_id: actor.profileId });

    const extensionWrite = queries[9].calls.find((call) => call.method === "update")?.args[0] as Record<string, unknown>;
    expect(extensionWrite).toMatchObject({
      profile_id: actor.profileId,
      metadata: {
        assignmentAttestation: { mode: "workplace_claim" },
        assignmentLifecycle: {
          assignmentMode: "workplace_claim",
          profileId: actor.profileId,
          state: "assigned",
        },
      },
    });
    const auditPayload = queries[10].calls.find((call) => call.method === "insert")?.args[0] as Record<string, unknown>;
    expect(auditPayload).toMatchObject({
      action: "telephony.extension.assign",
      after_payload: {
        credential_attestation: { mode: "workplace_claim" },
        assignment_lifecycle: { assignmentMode: "workplace_claim" },
      },
    });
    expect(JSON.stringify(auditPayload)).not.toContain("rotationAttested");
    expect(JSON.stringify(auditPayload)).not.toContain("rotationReference");
  });

  it("loses a concurrent target CAS without creating a second owner", async () => {
    enableLiveMutations();
    const queries = workplaceClaimQueries({});
    queries[9] = queryResult({ data: null, error: null });
    const rollback = queryResult({ data: { id: actor.profileId }, error: null });
    const transitionRelease = releasedTransition();
    queries.splice(10, 1, rollback, transitionRelease);
    const client = sequentialClient(queries);

    await expect(claimSelfServiceTelephonyExtension(actor, "20", {
      client: client as never,
      now: () => timestamp,
      randomId: deterministicTransitionId,
      viptel: safeProvider(),
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("medzitým zmenila") });

    expect(queries[9].calls).toContainEqual({ method: "is", args: ["profile_id", null] });
    expect(rollback.calls).toContainEqual({ method: "update", args: [{ phone_extension: null }] });
    expect(transitionRelease.calls).toContainEqual({ method: "is", args: ["profile_id", null] });
    expect(client.from).toHaveBeenCalledTimes(12);
  });

  it("releases a shared seat with an unassigned lifecycle and no active rotation quarantine", async () => {
    enableLiveMutations();
    const lifecycle = workplaceLifecycle();
    const metadata = { assignmentLifecycle: lifecycle };
    const owned = queryResult({ data: [extensionRow({ profile_id: actor.profileId, metadata })], error: null });
    const immutableAudit = queryResult({
      data: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        action: "telephony.extension.assign",
        after_payload: { assignment_lifecycle: lifecycle },
        created_at: timestamp,
      },
      error: null,
    });
    const immutableProfile = queryResult({
      data: { id: actor.profileId, phone_extension: "20" },
      error: null,
    });
    const profile = queryResult({
      data: { id: actor.profileId, phone_extension: "20", updated_at: "profile-v1" },
      error: null,
    });
    const lock = lockedTransition(actor.profileId, metadata, null);
    const refresh = lockedTransition(actor.profileId, metadata, null);
    const extensionUpdate = queryResult({ data: { id: extensionId, extension: "20", profile_id: null }, error: null });
    const profileRelease = queryResult({ data: { id: actor.profileId }, error: null });
    const audit = queryResult({ data: null, error: null });
    const client = sequentialClient([
      owned,
      immutableAudit,
      immutableProfile,
      profile,
      lock,
      queryResult({ data: routingRoot(), error: null }),
      routingHeadNone(),
      queryResult({ data: [], error: null }),
      refresh,
      extensionUpdate,
      profileRelease,
      audit,
    ]);

    await expect(releaseSelfServiceTelephonyExtension(actor, {
      client: client as never,
      now: () => timestamp,
      randomId: deterministicTransitionId,
      viptel: safeProvider(),
    })).resolves.toMatchObject({ extension: "20", profile_id: null });

    const extensionWrite = extensionUpdate.calls.find((call) => call.method === "update")?.args[0] as Record<string, unknown>;
    expect(extensionWrite).toMatchObject({
      profile_id: null,
      metadata: {
        assignmentLifecycle: {
          assignmentMode: "workplace_claim",
          profileId: null,
          state: "unassigned",
        },
        assignmentQuarantine: {
          active: false,
          sharingMode: "workplace_claim",
        },
      },
    });
    expect(extensionWrite).not.toMatchObject({ metadata: { assignmentQuarantine: { active: true } } });
    expect(audit.calls.find((call) => call.method === "insert")?.args[0]).toMatchObject({
      action: "telephony.extension.unassign",
      after_payload: {
        sharing_mode: "workplace_claim",
        assignment_lifecycle: { state: "unassigned", assignmentMode: "workplace_claim" },
      },
    });
  });
});

describe("routing and command references", () => {
  it("blocks current, previous, target and in-flight operation references", () => {
    const base = routingState();
    expect(dispatchRoutingReferencesExtension({ ...base, currentPlan: { ...base.currentPlan, "601": "20" } }, "20")).toBe(true);
    expect(dispatchRoutingReferencesExtension({ ...base, operation: operation({ previous: "20" }) }, "20")).toBe(true);
    expect(dispatchRoutingReferencesExtension({ ...base, operation: operation({ target: "20" }) }, "20")).toBe(true);
    expect(dispatchRoutingReferencesExtension({ ...base, operation: operation({ step: "20" }) }, "20")).toBe(true);
    expect(dispatchRoutingReferencesExtension(base, "20")).toBe(false);
  });

  it("finds nonterminal commands by extension row or exact nested payload", () => {
    expect(hasBlockingExtensionCommand([{ extension_id: extensionId, request_payload: {} }], extensionId, "20")).toBe(true);
    expect(hasBlockingExtensionCommand([{ extension_id: null, request_payload: { destination: "20" } }], extensionId, "20")).toBe(true);
    expect(hasBlockingExtensionCommand([{ extension_id: null, request_payload: { destination: "120" } }], extensionId, "20")).toBe(false);
    expect(hasBlockingExtensionCommand([{
      command_type: "provider.snapshot",
      extension_id: null,
      request_payload: { personalExtensions: ["20", "21", "22", "23"] },
    }], extensionId, "20")).toBe(false);
  });

  it("ignores a stale workplace draft on seat release but blocks an applicable draft", async () => {
    const staleCatalog = routingRoot({ current: "21" });
    addWorkplaceDraft(staleCatalog, 0, "20");
    const staleClient = sequentialClient([
      queryResult({ data: staleCatalog, error: null }),
      routingCommittedHead(staleCatalog),
      routingCommittedHead(staleCatalog),
      queryResult({ data: [], error: null }),
    ]);

    await expect(assertLiveAssignmentSafety(
      staleClient as never,
      actor.organizationId,
      actor.profileId,
      { id: extensionId, extension: "20" },
      safeProvider(),
    )).resolves.toBeUndefined();

    const applicableCatalog = routingRoot({ current: "21" });
    process.env.SUPABASE_SECRET_KEY = "test-workplace-authority-secret-at-least-32-characters";
    const applicableAuthority = addWorkplaceDraft(applicableCatalog, 1, "20", true);
    const applicableClient = sequentialClient([
      queryResult({ data: applicableCatalog, error: null }),
      routingCommittedHead(applicableCatalog),
      routingCommittedHead(applicableCatalog),
      queryResult({ data: [workplaceDraftAuditRow(applicableCatalog, applicableAuthority)], error: null }),
    ]);

    await expect(assertLiveAssignmentSafety(
      applicableClient as never,
      actor.organizationId,
      actor.profileId,
      { id: extensionId, extension: "20" },
      safeProvider(),
    )).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("rozpracovaných prioritách"),
    });
  });
});

describe("extension assignment mutation", () => {
  it.each([
    ["valid pilot mode", {
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "trusted_test",
      VIPTEL_WORKPLACE_DEPLOYMENT_STAGE: "controlled_test",
      VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS: actor.profileId,
    }],
    ["invalid requested mode", {
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "broken",
    }],
  ])("blocks the legacy admin mutation for a canonical seat in %s", async (_label, environment) => {
    Object.assign(process.env, environment);
    const lookup = queryResult({ data: extensionRow(), error: null });
    const client = sequentialClient([lookup]);
    const viptel = safeProvider();

    await expect(setTelephonyExtensionAssignment(
      actor,
      extensionId,
      operatorId,
      rotationReference,
      true,
      undefined,
      { client: client as never, viptel },
    )).rejects.toMatchObject({
      code: "hotdesk_legacy_assignment_blocked",
      status: 409,
    });
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(viptel.listExtensions).not.toHaveBeenCalled();
  });

  it("does not mistake the historical pre-migration seat-20 lifecycle for an installed hot-desk runtime", async () => {
    const lifecycle = {
      schemaVersion: 1,
      epoch: assignmentGeneration,
      state: "assigned",
      extensionId,
      extension: "20",
      profileId: currentOwnerId,
      assignmentMode: "workplace_claim",
      assignedAt: timestamp,
      assignedBy: actor.profileId,
    };
    const lookup = queryResult({
      data: extensionRow({
        profile_id: currentOwnerId,
        metadata: { assignmentLifecycle: lifecycle },
      }),
      error: null,
    });
    const markerMissing = queryResult({
      data: null,
      error: {
        code: "PGRST204",
        message: "Could not find the 'workplace_seat_generation' column in the schema cache",
      },
    });
    const client = sequentialClient([lookup, markerMissing]);
    const viptel = safeProvider();

    await expect(assign(client, viptel)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("otoč SIP heslo"),
    });
    expect(client.from).toHaveBeenCalledTimes(2);
    expect(viptel.listExtensions).not.toHaveBeenCalled();
  });

  it("requires explicit rotation attestation before any new owner lookup or provider read", async () => {
    const lookup = queryResult({ data: extensionRow(), error: null });
    const client = sequentialClient([lookup, assignmentHistory("20")]);
    const viptel = safeProvider();

    await expect(
      setTelephonyExtensionAssignment(actor, extensionId, operatorId, undefined, false, undefined, {
        client: client as never,
        viptel,
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("odkaz na vykonanú rotáciu") });
    expect(client.from).toHaveBeenCalledTimes(2);
    expect(viptel.listExtensions).not.toHaveBeenCalled();
  });

  it("keeps direct owner-to-owner handoff blocked before provider access", async () => {
    const lookup = queryResult({ data: extensionRow({ profile_id: currentOwnerId }), error: null });
    const client = sequentialClient([lookup]);
    const viptel = safeProvider();

    await expect(assign(client, viptel)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("otoč SIP heslo") });
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(viptel.listExtensions).not.toHaveBeenCalled();
  });

  it("blocks a live provider registration before routing or CAS access", async () => {
    const queries = assignmentPreflightQueries();
    queries.push(releasedTransition());
    const client = sequentialClient(queries);
    const viptel = safeProvider({ registered: true });

    await expect(assign(client, viptel)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("odregistrovaná") });
    expect(client.from).toHaveBeenCalledTimes(6);
  });

  it("requires a newly captured bridge snapshot for ownership handoff and rejects its live registration", async () => {
    const queries = assignmentPreflightQueries();
    queries.push(releasedTransition());
    const client = sequentialClient(queries);
    bridgeMocks.requestSnapshot.mockResolvedValueOnce({
      capturedAt: timestamp,
      ...live({ registered: true }),
    });

    await expect(setTelephonyExtensionAssignment(
      actor,
      extensionId,
      operatorId,
      rotationReference,
      true,
      undefined,
      { client: client as never, now: () => timestamp, randomId: deterministicTransitionId },
    )).rejects.toMatchObject({ status: 409, message: expect.stringContaining("odregistrovaná") });

    expect(bridgeMocks.requestSnapshot).toHaveBeenCalledWith(actor.organizationId, actor.profileId, {
      maxAgeMs: 2_000,
      requireNewCapture: true,
    });
    expect(client.from).toHaveBeenCalledTimes(6);
  });

  it("blocks a priority-plan reference before command or CAS access", async () => {
    const queries = assignmentPreflightQueries();
    const catalog = routingRoot({ current: "20" });
    queries.push(
      queryResult({ data: catalog, error: null }),
      routingCommittedHead(catalog),
      routingCommittedHead(catalog),
    );
    queries.push(releasedTransition());
    const client = sequentialClient(queries);

    await expect(assign(client, safeProvider())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("pláne priorít") });
    expect(client.from).toHaveBeenCalledTimes(9);
  });

  it("blocks assignment until the complete 601-603 database catalog is bootstrapped", async () => {
    const queries = assignmentPreflightQueries();
    queries.push(queryResult({ data: routingRoot().slice(0, 2), error: null }));
    queries.push(releasedTransition());
    const client = sequentialClient(queries);

    await expect(assign(client, safeProvider())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("katalóg") });
    expect(client.from).toHaveBeenCalledTimes(7);
  });

  it("blocks a pending telephony command before reservation", async () => {
    const queries = assignmentPreflightQueries();
    queries.push(
      queryResult({ data: routingRoot(), error: null }),
      routingHeadNone(),
      queryResult({ data: [{ id: "pending", extension_id: extensionId, request_payload: {} }], error: null }),
      releasedTransition(),
    );
    const client = sequentialClient(queries);

    await expect(assign(client, safeProvider())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("rozpracovaný") });
    expect(client.from).toHaveBeenCalledTimes(9);
  });

  it("serializes profile reservation and extension ownership with both CAS predicates", async () => {
    const queries = happyAssignmentQueries();
    const client = sequentialClient(queries);

    await expect(assign(client, safeProvider())).resolves.toMatchObject({ profile_id: operatorId });

    const refresh = queries[8];
    expect(refresh.calls).toContainEqual({ method: "eq", args: ["id", extensionId] });
    const reservation = queries[9];
    expect(reservation.calls).toContainEqual({ method: "update", args: [{ phone_extension: "20" }] });
    expect(reservation.calls).toContainEqual({ method: "eq", args: ["updated_at", "profile-v1"] });
    expect(reservation.calls).toContainEqual({ method: "is", args: ["phone_extension", null] });
    const extensionUpdate = queries[10];
    expect(extensionUpdate.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-lock-v2"] });
    expect(extensionUpdate.calls).toContainEqual({ method: "is", args: ["profile_id", null] });
    const auditPayload = queries[11].calls.find((call) => call.method === "insert")?.args[0] as Record<string, unknown>;
    expect(auditPayload).toMatchObject({ action: "telephony.extension.assign", actor_profile_id: actor.profileId });
    expect(auditPayload.after_payload).toMatchObject({
      credential_attestation: { rotationAttested: true, rotationReference },
    });
  });

  it("atomically replaces Mango's inactive legacy extension 102 when assigning personal extension 21", async () => {
    const targetExtension = "21";
    const profile = queryResult({
      data: { id: operatorId, phone_extension: "102", updated_at: "profile-v1" },
      error: null,
    });
    const existingAssignment = queryResult({ data: null, error: null });
    const reservation = queryResult({ data: reservedProfile(targetExtension), error: null });
    const extensionUpdate = queryResult({
      data: { id: extensionId, extension: targetExtension, profile_id: operatorId },
      error: null,
    });
    const audit = queryResult({ data: null, error: null });
    const client = sequentialClient([
      queryResult({ data: extensionRow({ extension: targetExtension }), error: null }),
      queryResult({ data: [], error: null }),
      profile,
      existingAssignment,
      lockedTransition(null, {}, operatorId, targetExtension),
      queryResult({ data: routingRoot(), error: null }),
      routingHeadNone(),
      queryResult({ data: [], error: null }),
      lockedTransition(null, {}, operatorId, targetExtension),
      reservation,
      extensionUpdate,
      audit,
    ]);

    await expect(assignInitial(client, safeProvider({ extension: targetExtension }))).resolves.toMatchObject({
      extension: targetExtension,
      profile_id: operatorId,
    });

    expect(existingAssignment.calls).toContainEqual({ method: "eq", args: ["active", true] });
    expect(reservation.calls).toContainEqual({ method: "update", args: [{ phone_extension: targetExtension }] });
    expect(reservation.calls).toContainEqual({ method: "eq", args: ["updated_at", "profile-v1"] });
    expect(reservation.calls).toContainEqual({ method: "eq", args: ["phone_extension", "102"] });
    expect(reservation.calls.some((call) => call.method === "is" && call.args[0] === "phone_extension")).toBe(false);
    expect(audit.calls.find((call) => call.method === "insert")?.args[0]).toMatchObject({
      action: "telephony.extension.assign",
      after_payload: { legacy_profile_extension_replaced: "102" },
      before_payload: { extension: targetExtension, profile_id: null, profile_phone_extension: "102" },
    });
  });

  it.each(["102", "22"]) (
    "does not replace a legacy profile pointer when the operator owns active extension %s",
    async (ownedExtension) => {
    const client = sequentialClient([
      queryResult({ data: extensionRow({ extension: "21" }), error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: { id: operatorId, phone_extension: "102", updated_at: "profile-v1" }, error: null }),
      queryResult({ data: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", extension: ownedExtension }, error: null }),
    ]);
    const viptel = safeProvider({ extension: "21" });

    await expect(assignInitial(client, viptel)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`už vlastní klapku ${ownedExtension}`),
    });
    expect(client.from).toHaveBeenCalledTimes(4);
    expect(viptel.listExtensions).not.toHaveBeenCalled();
    },
  );

  it("restores legacy extension 102 when the personal-extension ownership CAS loses", async () => {
    const targetExtension = "21";
    const reservation = queryResult({ data: reservedProfile(targetExtension), error: null });
    const extensionUpdate = queryResult({ data: null, error: null });
    const rollback = queryResult({ data: { id: operatorId }, error: null });
    const client = sequentialClient([
      queryResult({ data: extensionRow({ extension: targetExtension }), error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: { id: operatorId, phone_extension: "102", updated_at: "profile-v1" }, error: null }),
      queryResult({ data: null, error: null }),
      lockedTransition(null, {}, operatorId, targetExtension),
      queryResult({ data: routingRoot(), error: null }),
      routingHeadNone(),
      queryResult({ data: [], error: null }),
      lockedTransition(null, {}, operatorId, targetExtension),
      reservation,
      extensionUpdate,
      rollback,
      releasedTransition(),
    ]);

    await expect(assignInitial(client, safeProvider({ extension: targetExtension }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("bezpečne vrátená"),
    });

    expect(rollback.calls).toContainEqual({ method: "update", args: [{ phone_extension: "102" }] });
    expect(rollback.calls).toContainEqual({ method: "eq", args: ["updated_at", "profile-v2"] });
    expect(rollback.calls).toContainEqual({ method: "eq", args: ["phone_extension", targetExtension] });
  });

  it.each(["22", "777"]) (
    "keeps non-legacy profile extension %s fail closed",
    async (profileExtension) => {
      const client = sequentialClient([
        queryResult({ data: extensionRow({ extension: "21" }), error: null }),
        queryResult({ data: [], error: null }),
        queryResult({
          data: { id: operatorId, phone_extension: profileExtension, updated_at: "profile-v1" },
          error: null,
        }),
      ]);
      const viptel = safeProvider({ extension: "21" });

      await expect(assignInitial(client, viptel)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(`rezervovanú klapku ${profileExtension}`),
      });
      expect(client.from).toHaveBeenCalledTimes(3);
      expect(viptel.listExtensions).not.toHaveBeenCalled();
    },
  );

  it("does not migrate legacy extension 102 while it has a live call", async () => {
    const targetExtension = "21";
    const client = sequentialClient([
      queryResult({ data: extensionRow({ extension: targetExtension }), error: null }),
      queryResult({ data: [], error: null }),
      queryResult({ data: { id: operatorId, phone_extension: "102", updated_at: "profile-v1" }, error: null }),
      queryResult({ data: null, error: null }),
      lockedTransition(null, {}, operatorId, targetExtension),
      releasedTransition(),
    ]);

    await expect(assignInitial(client, safeProvider({
      callEndpoint: "102",
      extension: targetExtension,
    }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Pôvodná klapka 102"),
    });
    expect(client.from).toHaveBeenCalledTimes(6);
  });

  it("fails closed when a concurrent profile reservation wins", async () => {
    const queries = assignmentPreflightQueries();
    queries.push(
      queryResult({ data: routingRoot(), error: null }),
      routingHeadNone(),
      queryResult({ data: [], error: null }),
      lockedTransition(null),
      queryResult({ data: null, error: null }),
      releasedTransition(),
    );
    const client = sequentialClient(queries);

    await expect(assign(client, safeProvider())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("medzitým zmenila") });
    expect(client.from).toHaveBeenCalledTimes(11);
  });

  it("rolls back the exact profile reservation after an extension CAS race", async () => {
    const queries = assignmentPreflightQueries();
    queries.push(
      queryResult({ data: routingRoot(), error: null }),
      routingHeadNone(),
      queryResult({ data: [], error: null }),
      lockedTransition(null),
      queryResult({ data: reservedProfile(), error: null }),
      queryResult({ data: null, error: null }),
      queryResult({ data: { id: operatorId }, error: null }),
      releasedTransition(),
    );
    const client = sequentialClient(queries);

    await expect(assign(client, safeProvider())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("bezpečne vrátená") });
    const rollback = queries[11];
    expect(rollback.calls).toContainEqual({ method: "update", args: [{ phone_extension: null }] });
    expect(rollback.calls).toContainEqual({ method: "eq", args: ["updated_at", "profile-v2"] });
    expect(rollback.calls).toContainEqual({ method: "eq", args: ["phone_extension", "20"] });
  });

  it("keeps the assignment transition durable when profile reservation rollback is unconfirmed", async () => {
    const rollback = queryResult({ data: null, error: { message: "rollback unavailable" } });
    const stuckAudit = queryResult({ data: null, error: null });
    const queries = [
      ...assignmentPreflightQueries(),
      queryResult({ data: routingRoot(), error: null }),
      routingHeadNone(),
      queryResult({ data: [], error: null }),
      lockedTransition(null),
      queryResult({ data: reservedProfile(), error: null }),
      queryResult({ data: null, error: null }),
      rollback,
      stuckAudit,
    ];
    const client = sequentialClient(queries);

    await expect(assign(client, safeProvider())).rejects.toMatchObject({
      code: "ASSIGNMENT_RESERVATION_RECOVERY_REQUIRED",
      status: 409,
      message: expect.stringContaining("profilová rezervácia mohla zostať"),
    });

    expect(client.from).toHaveBeenCalledTimes(13);
    expect(rollback.calls).toContainEqual({ method: "eq", args: ["updated_at", "profile-v2"] });
    expect(stuckAudit.calls.find((call) => call.method === "insert")?.args[0]).toMatchObject({
      action: "telephony.extension.assign.reservation_stuck",
    });
  });

  it("surfaces an audit failure without claiming the stored change was atomic", async () => {
    const queries = happyAssignmentQueries();
    queries[11] = queryResult({ data: null, error: { message: "audit unavailable" } });
    queries.push(
      queryResult({ data: null, error: null }),
      queryResult({ data: { metadata: { assignmentGeneration } }, error: null }),
    );
    const client = sequentialClient(queries);

    await expect(assign(client, safeProvider())).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("Zmena priradenia sa uložila, ale audit"),
    });
  });

  it("unassigns with quarantine metadata, releases the exact profile reservation, and audits", async () => {
    const lookup = queryResult({ data: extensionRow({ profile_id: currentOwnerId, metadata: { preserved: true } }), error: null });
    const profile = queryResult({
      data: { id: currentOwnerId, phone_extension: "20", updated_at: "profile-v1" },
      error: null,
    });
    const root = queryResult({ data: routingRoot(), error: null });
    const commands = queryResult({ data: [], error: null });
    const extensionUpdate = queryResult({ data: { id: extensionId, extension: "20", profile_id: null }, error: null });
    const release = queryResult({ data: { id: currentOwnerId }, error: null });
    const audit = queryResult({ data: null, error: null });
    const lock = lockedTransition(currentOwnerId, { preserved: true });
    const refresh = lockedTransition(currentOwnerId, { preserved: true });
    const client = sequentialClient([lookup, profile, lock, root, routingHeadNone(), commands, refresh, extensionUpdate, release, audit]);

    await expect(
      setTelephonyExtensionAssignment(actor, extensionId, null, undefined, undefined, undefined, {
        client: client as never,
        now: () => timestamp,
        randomId: deterministicTransitionId,
        viptel: safeProvider(),
      }),
    ).resolves.toMatchObject({ profile_id: null });

    const write = extensionUpdate.calls.find((call) => call.method === "update")?.args[0] as Record<string, unknown>;
    expect(write).toMatchObject({
      profile_id: null,
      metadata: {
        preserved: true,
        assignmentQuarantine: {
          active: true,
          requiresSipCredentialRotation: true,
          unassignedAt: timestamp,
          previousProfileId: currentOwnerId,
        },
      },
    });
    expect(extensionUpdate.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-lock-v2"] });
    expect(extensionUpdate.calls).toContainEqual({ method: "eq", args: ["profile_id", currentOwnerId] });
    expect(release.calls).toContainEqual({ method: "eq", args: ["phone_extension", "20"] });
    expect(audit.calls.find((call) => call.method === "insert")?.args[0]).toMatchObject({
      action: "telephony.extension.unassign",
    });
  });

  it("recovers an orphaned profile reservation after a crash following the unassign extension CAS", async () => {
    const quarantine = assignmentQuarantine();
    const lookup = queryResult({
      data: extensionRow({ profile_id: null, metadata: { assignmentQuarantine: quarantine } }),
      error: null,
    });
    const previousProfile = queryResult({
      data: { id: currentOwnerId, phone_extension: "20", updated_at: "profile-v1" },
      error: null,
    });
    const lock = lockedTransition(null, { assignmentQuarantine: quarantine }, null);
    const root = queryResult({ data: routingRoot(), error: null });
    const commands = queryResult({ data: [], error: null });
    const refresh = lockedTransition(null, { assignmentQuarantine: quarantine }, null);
    const reservationRelease = queryResult({ data: { id: currentOwnerId }, error: null });
    const transitionRelease = releasedTransition();
    const audit = queryResult({ data: null, error: null });
    const client = sequentialClient([
      lookup,
      previousProfile,
      lock,
      root,
      routingHeadNone(),
      commands,
      refresh,
      reservationRelease,
      transitionRelease,
      audit,
    ]);
    const viptel = safeProvider();

    await expect(
      setTelephonyExtensionAssignment(actor, extensionId, null, undefined, undefined, undefined, {
        client: client as never,
        now: () => timestamp,
        randomId: deterministicTransitionId,
        viptel,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Osirelá profilová rezervácia"),
    });

    expect(viptel.listExtensions).toHaveBeenCalledOnce();
    expect(viptel.listActiveCalls).toHaveBeenCalledOnce();
    expect(viptel.getQueueStatus).toHaveBeenCalledTimes(3);
    expect(reservationRelease.calls).toContainEqual({ method: "update", args: [{ phone_extension: null }] });
    expect(reservationRelease.calls).toContainEqual({ method: "eq", args: ["id", currentOwnerId] });
    expect(reservationRelease.calls).toContainEqual({ method: "eq", args: ["updated_at", "profile-v1"] });
    expect(reservationRelease.calls).toContainEqual({ method: "eq", args: ["phone_extension", "20"] });
    expect(transitionRelease.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-lock-v2"] });
    expect(audit.calls.find((call) => call.method === "insert")?.args[0]).toMatchObject({
      action: "telephony.extension.unassign.reservation_recover",
      after_payload: { profile_reservation_released: true },
    });
  });

  it("assigns quarantined extension 20 to B without modifying previous profile A's legitimate extension 21", async () => {
    const quarantine = assignmentQuarantine();
    const previousProfile = queryResult({
      data: { id: currentOwnerId, phone_extension: "21", updated_at: "profile-v3" },
      error: null,
    });
    const targetProfile = queryResult({
      data: { id: operatorId, phone_extension: null, updated_at: "profile-v1" },
      error: null,
    });
    const reservation = queryResult({ data: reservedProfile(), error: null });
    const extensionUpdate = queryResult({ data: { id: extensionId, extension: "20", profile_id: operatorId }, error: null });
    const audit = queryResult({ data: null, error: null });
    const client = sequentialClient([
      queryResult({ data: extensionRow({ profile_id: null, metadata: { assignmentQuarantine: quarantine } }), error: null }),
      previousProfile,
      targetProfile,
      queryResult({ data: null, error: null }),
      lockedTransition(null, { assignmentQuarantine: quarantine }),
      queryResult({ data: routingRoot(), error: null }),
      routingHeadNone(),
      queryResult({ data: [], error: null }),
      lockedTransition(null, { assignmentQuarantine: quarantine }),
      reservation,
      extensionUpdate,
      audit,
    ]);
    const viptel = safeProvider();

    await expect(assign(client, viptel)).resolves.toMatchObject({ extension: "20", profile_id: operatorId });

    expect(client.from).toHaveBeenCalledTimes(12);
    expect(previousProfile.calls.some((call) => call.method === "update")).toBe(false);
    expect(reservation.calls).toContainEqual({ method: "update", args: [{ phone_extension: "20" }] });
    expect(extensionUpdate.calls).toContainEqual({ method: "is", args: ["profile_id", null] });
    expect(audit.calls.find((call) => call.method === "insert")?.args[0]).toMatchObject({
      action: "telephony.extension.assign",
      before_payload: { extension: "20", profile_id: null },
    });
    expect(viptel.listExtensions).toHaveBeenCalledOnce();
  });

  it("keeps an expired transition active when the target reservation needs audited reconciliation", async () => {
    const lookup = queryResult({ data: extensionRow({ metadata: staleTransitionMetadata() }), error: null });
    const recoveryClaim = recoveryLockedTransition();
    const root = queryResult({ data: routingRoot(), error: null });
    const commands = queryResult({ data: [], error: null });
    const targetProfile = queryResult({ data: reservedProfile(), error: null });
    const client = sequentialClient([
      lookup,
      recoveryClaim,
      root,
      routingHeadNone(),
      commands,
      targetProfile,
    ]);
    const viptel = safeProvider();

    await expect(assign(client, viptel, deterministicRecoveryId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("ručné zosúladenie"),
    });

    expect(viptel.listExtensions).toHaveBeenCalledOnce();
    expect(viptel.listActiveCalls).toHaveBeenCalledOnce();
    expect(viptel.getQueueStatus).toHaveBeenCalledTimes(3);
    expect(targetProfile.calls.some((call) => call.method === "update")).toBe(false);
    expect(recoveryClaim.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v1"] });
    expect(recoveryClaim.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: {
        assignmentGeneration: recoveryGeneration,
        assignmentTransition: {
          recoveryOfTransitionId: transitionId,
          transitionId: recoveryTransitionId,
        },
      },
    });
    expect(client.from).toHaveBeenCalledTimes(6);
  });

  it("keeps recovery fail closed after a crash between legacy 102 and personal 21", async () => {
    const targetExtension = "21";
    const lookup = queryResult({
      data: extensionRow({
        extension: targetExtension,
        metadata: staleTransitionMetadata("2026-08-04T15:00:00.000Z", "102"),
      }),
      error: null,
    });
    const recoveryClaim = recoveryLockedTransition({
      extension: targetExtension,
      profileReservationPreviousExtension: "102",
    });
    const reservedTargetProfile = queryResult({ data: reservedProfile(targetExtension), error: null });
    const client = sequentialClient([
      lookup,
      recoveryClaim,
      queryResult({ data: routingRoot(), error: null }),
      routingHeadNone(),
      queryResult({ data: [], error: null }),
      reservedTargetProfile,
    ]);

    await expect(setTelephonyExtensionAssignment(
      actor,
      extensionId,
      operatorId,
      undefined,
      undefined,
      true,
      {
        client: client as never,
        now: () => timestamp,
        randomId: deterministicRecoveryId,
        viptel: safeProvider({ extension: targetExtension }),
      },
    )).rejects.toMatchObject({ status: 409, message: expect.stringContaining("ručné zosúladenie") });

    expect(reservedTargetProfile.calls.some((call) => call.method === "update")).toBe(false);
    expect(client.from).toHaveBeenCalledTimes(6);
    expect(recoveryClaim.calls.find((call) => call.method === "update")?.args[0]).toMatchObject({
      metadata: {
        assignmentTransition: { profileReservationPreviousExtension: "102" },
      },
    });
  });

  it("releases a crashed legacy transition when profile reservation never changed from 102", async () => {
    const targetExtension = "21";
    const profile = queryResult({
      data: { id: operatorId, phone_extension: "102", updated_at: "profile-v1" },
      error: null,
    });
    const transitionRelease = releasedTransition();
    const audit = queryResult({ data: null, error: null });
    const client = sequentialClient([
      queryResult({
        data: extensionRow({
          extension: targetExtension,
          metadata: staleTransitionMetadata("2026-08-04T15:00:00.000Z", "102"),
        }),
        error: null,
      }),
      recoveryLockedTransition({
        extension: targetExtension,
        profileReservationPreviousExtension: "102",
      }),
      queryResult({ data: routingRoot(), error: null }),
      routingHeadNone(),
      queryResult({ data: [], error: null }),
      profile,
      transitionRelease,
      audit,
    ]);

    await expect(setTelephonyExtensionAssignment(
      actor,
      extensionId,
      operatorId,
      undefined,
      undefined,
      true,
      {
        client: client as never,
        now: () => timestamp,
        randomId: deterministicRecoveryId,
        viptel: safeProvider({ extension: targetExtension }),
      },
    )).rejects.toMatchObject({ status: 409, message: expect.stringContaining("bezpečne uvoľnený") });

    expect(profile.calls.some((call) => call.method === "update")).toBe(false);
    expect(transitionRelease.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-recovery-v2"] });
    expect(audit.calls.find((call) => call.method === "insert")?.args[0]).toMatchObject({
      after_payload: { profile_reservation_rolled_back: false },
    });
  });

  it("fails closed on an arbitrary previous profile extension in transition metadata", async () => {
    const client = sequentialClient([
      queryResult({
        data: extensionRow({
          extension: "21",
          metadata: staleTransitionMetadata("2026-08-04T15:00:00.000Z", "999"),
        }),
        error: null,
      }),
    ]);
    const viptel = safeProvider({ extension: "21" });

    await expect(assignInitial(client, viptel)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("neplatné recovery údaje"),
    });
    expect(client.from).toHaveBeenCalledOnce();
    expect(viptel.listExtensions).not.toHaveBeenCalled();
  });

  it("does not trust a missing previous-extension value to clear a personal reservation", async () => {
    const targetExtension = "21";
    const targetProfile = queryResult({ data: reservedProfile(targetExtension), error: null });
    const client = sequentialClient([
      queryResult({
        data: extensionRow({ extension: targetExtension, metadata: staleTransitionMetadata() }),
        error: null,
      }),
      recoveryLockedTransition({ extension: targetExtension }),
      queryResult({ data: routingRoot(), error: null }),
      routingHeadNone(),
      queryResult({ data: [], error: null }),
      targetProfile,
    ]);

    await expect(setTelephonyExtensionAssignment(
      actor,
      extensionId,
      operatorId,
      undefined,
      undefined,
      true,
      {
        client: client as never,
        now: () => timestamp,
        randomId: deterministicRecoveryId,
        viptel: safeProvider({ extension: targetExtension }),
      },
    )).rejects.toMatchObject({ status: 409, message: expect.stringContaining("ručné zosúladenie") });

    expect(targetProfile.calls.some((call) => call.method === "update")).toBe(false);
    expect(client.from).toHaveBeenCalledTimes(6);
  });

  it("does not recover a transition before its bounded lease expires", async () => {
    const client = sequentialClient([
      queryResult({ data: extensionRow({ metadata: staleTransitionMetadata("2026-08-04T15:59:00.000Z") }), error: null }),
    ]);
    const viptel = safeProvider();

    await expect(assign(client, viptel)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("ešte prebieha") });
    expect(client.from).toHaveBeenCalledOnce();
    expect(viptel.listExtensions).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed active transition before provider access", async () => {
    const client = sequentialClient([
      queryResult({ data: extensionRow({ metadata: { assignmentTransition: { active: true } } }), error: null }),
    ]);
    const viptel = safeProvider();

    await expect(assign(client, viptel)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("neplatné recovery údaje"),
    });
    expect(client.from).toHaveBeenCalledOnce();
    expect(viptel.listExtensions).not.toHaveBeenCalled();
  });
});

describe("VIPTel extension synchronization interlock", () => {
  it("does not mutate a row carrying even a malformed active assignment transition", async () => {
    const existing = synchronizedExtensionRow({
      metadata: { assignmentTransition: { active: true } },
    });
    const client = sequentialClient([queryResult({ data: [existing], error: null })]);

    await expect(
      synchronizeViptelExtensions(actor.organizationId, [providerExtension(false)], timestamp, client as never),
    ).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledOnce();
  });

  it("does not let an older incoming snapshot overwrite newer stored provider telemetry", async () => {
    const lookup = queryResult({
      data: [synchronizedExtensionRow({
        is_registered: true,
        last_synced_at: "2026-08-04T16:01:00.000Z",
      })],
      error: null,
    });
    const client = sequentialClient([lookup]);

    await expect(
      synchronizeViptelExtensions(actor.organizationId, [providerExtension(false)], timestamp, client as never),
    ).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledOnce();
  });

  it("does not write matching provider telemetry again at an equal snapshot timestamp", async () => {
    const lookup = queryResult({
      data: [synchronizedExtensionRow({ is_registered: false, last_synced_at: timestamp })],
      error: null,
    });
    const client = sequentialClient([lookup]);

    await expect(
      synchronizeViptelExtensions(actor.organizationId, [providerExtension(false)], timestamp, client as never),
    ).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledOnce();
  });

  it("does not let an older provider list deactivate a row synchronized by a newer snapshot", async () => {
    const newerMissingRow = synchronizedExtensionRow({
      extension: "20",
      last_synced_at: "2026-08-04T16:01:00.000Z",
    });
    const listedRow = synchronizedExtensionRow({
      external_id: "21",
      extension: "21",
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      last_synced_at: timestamp,
    });
    const lookup = queryResult({ data: [newerMissingRow, listedRow], error: null });
    const client = sequentialClient([lookup]);

    await expect(
      synchronizeViptelExtensions(actor.organizationId, [providerExtension(false, "21")], timestamp, client as never),
    ).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledOnce();
  });

  it("uses insert and never overwrites a concurrently created extension with a baseline-free snapshot", async () => {
    const lookup = queryResult({ data: [], error: null });
    const concurrentInsert = queryResult({ data: null, error: { code: "23505" } });
    const client = sequentialClient([lookup, concurrentInsert]);

    await expect(
      synchronizeViptelExtensions(actor.organizationId, [providerExtension(false)], timestamp, client as never),
    ).resolves.toBeUndefined();
    expect(concurrentInsert.calls.some((call) => call.method === "insert")).toBe(true);
    expect(concurrentInsert.calls.some((call) => call.method === "upsert")).toBe(false);
    expect(client.from).toHaveBeenCalledTimes(2);
  });

  it("repairs inconsistent provider telemetry even when the stored sync timestamp matches the snapshot", async () => {
    const lookup = queryResult({
      data: [synchronizedExtensionRow({ is_registered: true, last_synced_at: timestamp })],
      error: null,
    });
    const synchronized = queryResult({ data: { id: extensionId }, error: null });
    const client = sequentialClient([lookup, synchronized]);

    await expect(
      synchronizeViptelExtensions(actor.organizationId, [providerExtension(false)], timestamp, client as never),
    ).resolves.toBeUndefined();
    expect(synchronized.calls).toContainEqual({
      method: "update",
      args: [expect.objectContaining({ is_registered: false, last_synced_at: timestamp })],
    });
  });

  it("uses updated_at CAS and stops when a concurrent assignment transition becomes active", async () => {
    const lookup = queryResult({
      data: [synchronizedExtensionRow({ display_name: "old", last_synced_at: "2026-08-04T15:00:00.000Z" })],
      error: null,
    });
    const racedUpdate = queryResult({ data: null, error: null });
    const transitionWon = queryResult({
      data: synchronizedExtensionRow({
        display_name: "old",
        last_synced_at: "2026-08-04T15:00:00.000Z",
        metadata: { assignmentTransition: { active: true } },
        updated_at: "extension-v2",
      }),
      error: null,
    });
    const client = sequentialClient([lookup, racedUpdate, transitionWon]);

    await expect(
      synchronizeViptelExtensions(actor.organizationId, [{ ...providerExtension(false), name: "new" }], timestamp, client as never),
    ).resolves.toBeUndefined();
    expect(racedUpdate.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v1"] });
    expect(client.from).toHaveBeenCalledTimes(3);
  });

  it("retries provider telemetry after an unrelated provider-only row version change", async () => {
    const stableAssignment = {
      metadata: {
        assignmentGeneration,
        assignmentLifecycle: { epoch: assignmentGeneration, state: "assigned" },
      },
      profile_id: currentOwnerId,
      workplace_seat_generation: assignmentGeneration,
    };
    const lookup = queryResult({
      data: [synchronizedExtensionRow({
        ...stableAssignment,
        is_registered: true,
        last_synced_at: "2026-08-04T15:00:00.000Z",
      })],
      error: null,
    });
    const racedUpdate = queryResult({ data: null, error: null });
    const providerOnlyRace = queryResult({
      data: synchronizedExtensionRow({
        ...stableAssignment,
        display_name: "Provider refresh won the first CAS",
        is_registered: true,
        last_synced_at: "2026-08-04T15:00:00.000Z",
        updated_at: "extension-v2",
      }),
      error: null,
    });
    const retriedUpdate = queryResult({ data: { id: extensionId }, error: null });
    const client = sequentialClient([lookup, racedUpdate, providerOnlyRace, retriedUpdate]);

    await expect(
      synchronizeViptelExtensions(actor.organizationId, [providerExtension(false)], timestamp, client as never),
    ).resolves.toBeUndefined();

    expect(retriedUpdate.calls).toContainEqual({ method: "eq", args: ["updated_at", "extension-v2"] });
    expect(retriedUpdate.calls).toContainEqual({
      method: "update",
      args: [expect.objectContaining({ is_registered: false, last_synced_at: timestamp })],
    });
    const retryPayload = retriedUpdate.calls.find((call) => call.method === "update")?.args[0] as Record<string, unknown>;
    expect(retryPayload).not.toHaveProperty("metadata");
    expect(retryPayload).not.toHaveProperty("profile_id");
    expect(retryPayload).not.toHaveProperty("workplace_seat_generation");
  });

  it("treats a completed concurrent workplace claim as a safe no-op for the stale snapshot", async () => {
    const lookup = queryResult({
      data: [synchronizedExtensionRow({
        is_registered: true,
        last_synced_at: "2026-08-04T15:00:00.000Z",
        metadata: {
          assignmentGeneration,
          assignmentLifecycle: { epoch: assignmentGeneration, profileId: null, state: "unassigned" },
        },
        profile_id: null,
        workplace_seat_generation: assignmentGeneration,
      })],
      error: null,
    });
    const racedUpdate = queryResult({ data: null, error: null });
    const concurrentClaim = queryResult({
      data: synchronizedExtensionRow({
        is_registered: true,
        last_synced_at: "2026-08-04T15:00:00.000Z",
        metadata: {
          assignmentGeneration: recoveryGeneration,
          assignmentLifecycle: { epoch: recoveryGeneration, profileId: actor.profileId, state: "assigned" },
        },
        profile_id: actor.profileId,
        updated_at: "extension-v2",
        workplace_seat_generation: recoveryGeneration,
      }),
      error: null,
    });
    const client = sequentialClient([lookup, racedUpdate, concurrentClaim]);

    await expect(
      synchronizeViptelExtensions(actor.organizationId, [providerExtension(false)], timestamp, client as never),
    ).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledTimes(3);
  });

  it("does not regress telemetry when a newer provider synchronization won the CAS", async () => {
    const lookup = queryResult({
      data: [synchronizedExtensionRow({ is_registered: true, last_synced_at: "2026-08-04T15:00:00.000Z" })],
      error: null,
    });
    const racedUpdate = queryResult({ data: null, error: null });
    const newerSync = queryResult({
      data: synchronizedExtensionRow({
        is_registered: true,
        last_synced_at: "2026-08-04T16:01:00.000Z",
        updated_at: "extension-v2",
      }),
      error: null,
    });
    const client = sequentialClient([lookup, racedUpdate, newerSync]);

    await expect(
      synchronizeViptelExtensions(actor.organizationId, [providerExtension(false)], timestamp, client as never),
    ).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledTimes(3);
  });

  it("fails closed after repeated semantic CAS conflicts instead of reporting a false synchronization", async () => {
    const staleRow = (updatedAt: string) => queryResult({
      data: synchronizedExtensionRow({
        is_registered: true,
        last_synced_at: "2026-08-04T15:00:00.000Z",
        updated_at: updatedAt,
      }),
      error: null,
    });
    const client = sequentialClient([
      queryResult({ data: [synchronizedExtensionRow({ is_registered: true, last_synced_at: "2026-08-04T15:00:00.000Z" })], error: null }),
      queryResult({ data: null, error: null }),
      staleRow("extension-v2"),
      queryResult({ data: null, error: null }),
      staleRow("extension-v3"),
      queryResult({ data: null, error: null }),
      staleRow("extension-v4"),
    ]);

    await expect(
      synchronizeViptelExtensions(actor.organizationId, [providerExtension(false)], timestamp, client as never),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("opakovanú súbežnú zmenu") });
    expect(client.from).toHaveBeenCalledTimes(7);
  });
});

function assign(
  client: ReturnType<typeof sequentialClient>,
  viptel: ReturnType<typeof safeProvider>,
  randomId: () => string = deterministicTransitionId,
) {
  return setTelephonyExtensionAssignment(actor, extensionId, operatorId, rotationReference, true, undefined, {
    client: client as never,
    now: () => timestamp,
    randomId,
    viptel,
  });
}

function assignInitial(
  client: ReturnType<typeof sequentialClient>,
  viptel: ReturnType<typeof safeProvider>,
) {
  return setTelephonyExtensionAssignment(actor, extensionId, operatorId, undefined, undefined, true, {
    client: client as never,
    now: () => timestamp,
    randomId: deterministicTransitionId,
    viptel,
  });
}

function assignmentPreflightQueries() {
  return [
    queryResult({ data: extensionRow(), error: null }),
    assignmentHistory("20"),
    queryResult({ data: { id: operatorId, phone_extension: null, updated_at: "profile-v1" }, error: null }),
    queryResult({ data: null, error: null }),
    lockedTransition(null),
  ];
}

function assignmentHistory(extension: string) {
  return queryResult({
    data: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      entity_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      action: "telephony.extension.assign",
      before_payload: { extension },
      after_payload: { extension },
    }],
    error: null,
  });
}

function happyAssignmentQueries() {
  return [
    ...assignmentPreflightQueries(),
    queryResult({ data: routingRoot(), error: null }),
    routingHeadNone(),
    queryResult({ data: [], error: null }),
    lockedTransition(null),
    queryResult({ data: reservedProfile(), error: null }),
    queryResult({ data: { id: extensionId, extension: "20", profile_id: operatorId }, error: null }),
    queryResult({ data: null, error: null }),
  ];
}

function workplaceClaimQueries(metadata: Record<string, unknown>) {
  return [
    queryResult({ data: extensionRow({ metadata }), error: null }),
    queryResult({ data: [], error: null }),
    queryResult({ data: { id: actor.profileId, phone_extension: null, updated_at: "profile-v1" }, error: null }),
    lockedTransition(null, metadata, actor.profileId),
    queryResult({ data: routingRoot(), error: null }),
    routingHeadNone(),
    queryResult({ data: [], error: null }),
    lockedTransition(null, metadata, actor.profileId),
    queryResult({ data: { id: actor.profileId, phone_extension: "20", updated_at: "profile-v2" }, error: null }),
    queryResult({ data: { id: extensionId, extension: "20", profile_id: actor.profileId }, error: null }),
    queryResult({ data: null, error: null }),
  ];
}

function workplaceLifecycle() {
  return {
    schemaVersion: 1,
    epoch: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    state: "assigned",
    extensionId,
    extension: "20",
    profileId: actor.profileId,
    assignmentMode: "workplace_claim",
    assignedAt: timestamp,
    assignedBy: actor.profileId,
  } as const;
}

function enableLiveMutations() {
  process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "true";
  process.env.VIPTEL_LIVE_MUTATION_TOKEN = "x".repeat(32);
}

function extensionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: extensionId,
    extension: "20",
    metadata: {},
    profile_id: null,
    updated_at: "extension-v1",
    ...overrides,
  };
}

function lockedTransition(
  profileId: string | null,
  metadata: Record<string, unknown> = {},
  toProfileId: string | null = profileId ? null : operatorId,
  extension = "20",
) {
  return queryResult({
    data: {
      ...extensionRow({
        active: true,
        extension,
        profile_id: profileId,
        updated_at: "extension-lock-v2",
        metadata: {
          ...metadata,
          assignmentGeneration,
          assignmentTransition: {
            active: true,
            fromProfileId: profileId,
            generation: assignmentGeneration,
            initiatedBy: actor.profileId,
            startedAt: timestamp,
            toProfileId,
            transitionId,
          },
        },
      }),
    },
    error: null,
  });
}

function assignmentQuarantine() {
  return {
    active: true,
    extension: "20",
    previousProfileId: currentOwnerId,
    requiresSipCredentialRotation: true,
    unassignedAt: timestamp,
    unassignedBy: actor.profileId,
  };
}

function staleTransitionMetadata(
  startedAt = "2026-08-04T15:00:00.000Z",
  profileReservationPreviousExtension?: string,
) {
  return {
    assignmentGeneration,
    assignmentTransition: {
      active: true,
      fromProfileId: null,
      generation: assignmentGeneration,
      initiatedBy: actor.profileId,
      ...(profileReservationPreviousExtension
        ? { profileReservationPreviousExtension }
        : {}),
      startedAt,
      toProfileId: operatorId,
      transitionId,
    },
  };
}

function recoveryLockedTransition(options: {
  extension?: string;
  profileReservationPreviousExtension?: string;
} = {}) {
  return queryResult({
    data: extensionRow({
      extension: options.extension ?? "20",
      active: true,
      updated_at: "extension-recovery-v2",
      metadata: {
        assignmentGeneration: recoveryGeneration,
        assignmentTransition: {
          active: true,
          fromProfileId: null,
          generation: recoveryGeneration,
          initiatedBy: actor.profileId,
          ...(options.profileReservationPreviousExtension
            ? { profileReservationPreviousExtension: options.profileReservationPreviousExtension }
            : {}),
          recoveredBy: actor.profileId,
          recoveryOfTransitionId: transitionId,
          startedAt: timestamp,
          toProfileId: operatorId,
          transitionId: recoveryTransitionId,
        },
      },
    }),
    error: null,
  });
}

function synchronizedExtensionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: extensionId,
    organization_id: actor.organizationId,
    provider: "viptel",
    external_id: "20",
    extension: "20",
    active: true,
    profile_id: null,
    metadata: {},
    display_name: null,
    outbound_cid: null,
    call_forwarding: null,
    is_registered: false,
    is_viptel_phone_active: null,
    allowed_changes: [],
    last_synced_at: timestamp,
    workplace_seat_generation: null,
    updated_at: "extension-v1",
    ...overrides,
  };
}

function releasedTransition() {
  return queryResult({ data: { id: extensionId }, error: null });
}

function deterministicTransitionId() {
  deterministicTransitionId.index = (deterministicTransitionId.index + 1) % 2;
  return deterministicTransitionId.index === 1 ? transitionId : assignmentGeneration;
}
deterministicTransitionId.index = 0;

function deterministicRecoveryId() {
  deterministicRecoveryId.index = (deterministicRecoveryId.index + 1) % 2;
  return deterministicRecoveryId.index === 1 ? recoveryTransitionId : recoveryGeneration;
}
deterministicRecoveryId.index = 0;

function reservedProfile(extension = "20") {
  return { id: operatorId, phone_extension: extension, updated_at: "profile-v2" };
}

function routingRoot(options: { current?: string } = {}) {
  return [
    {
      id: "queue-601",
      external_id: "601",
      line_id: null,
      updated_at: "routing-v1",
      metadata: {
        dispatchRouting: {
          revision: options.current ? 1 : 0,
          currentPlan: { "601": options.current ?? null, "602": null, "603": null },
        },
      } as Json,
    },
    { id: "queue-602", external_id: "602", line_id: null, updated_at: "routing-v1", metadata: {} as Json },
    { id: "queue-603", external_id: "603", line_id: null, updated_at: "routing-v1", metadata: {} as Json },
  ];
}

function addWorkplaceDraft(
  catalog: ReturnType<typeof routingRoot>,
  baseRevision: number,
  selectedExtension: string,
  signed = false,
) {
  const metadata = catalog[0].metadata as Record<string, unknown>;
  const draft = {
    schemaVersion: 1,
    baseRevision,
    selections: { "601": selectedExtension, "602": null, "603": null },
    selectedBy: { "601": operatorId, "602": null, "603": null },
    updatedAt: timestamp,
  };
  const authorized = signed
    ? authorizeWorkplacePriorityDraft(
        draft,
        { organizationId: actor.organizationId, rootQueueId: catalog[0].id },
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        { SUPABASE_SECRET_KEY: "test-workplace-authority-secret-at-least-32-characters" },
      )
    : undefined;
  metadata.workplacePriorityDraft = authorized?.draft ?? draft;
  return authorized;
}

function workplaceDraftAuditRow(
  catalog: ReturnType<typeof routingRoot>,
  authorized: ReturnType<typeof authorizeWorkplacePriorityDraft> | undefined,
) {
  if (!authorized) throw new Error("Expected an authorized workplace draft.");
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    action: "telephony.workplace.priority.draft",
    entity_id: catalog[0].id,
    after_payload: authorized.auditPayload,
    created_at: timestamp,
  };
}

function routingHeadNone() {
  return queryResult({ data: [], error: null });
}

function routingCommittedHead(catalog: ReturnType<typeof routingRoot>) {
  const root = catalog[0];
  const state = (root.metadata as { dispatchRouting: { revision: number; currentPlan: Record<string, string | null> } }).dispatchRouting;
  return queryResult({
    data: [{
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      action: "telephony.routing.plan.committed",
      entity_id: root.id,
      created_at: "2026-08-04T15:00:00.000Z",
      after_payload: {
        routing_plan_commit: {
          schemaVersion: 1,
          organizationId: actor.organizationId,
          rootId: root.id,
          operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          revision: state.revision,
          currentPlan: state.currentPlan,
          digest: dispatchRoutingCommittedPlanDigest(actor.organizationId, root.id, state as never),
        },
      },
    }],
    error: null,
  });
}

function routingState() {
  return { revision: 1, currentPlan: { "601": null, "602": null, "603": null } } as const;
}

function operation(options: { previous?: string; step?: string; target?: string }) {
  const stepExtension = options.step ?? "21";
  return {
    operationId: "operation",
    status: "applying" as const,
    baseRevision: 1,
    targetRevision: 2,
    previousPlan: { "601": options.previous ?? null, "602": null, "603": null },
    targetPlan: { "601": options.target ?? null, "602": null, "603": null },
    steps: [
      {
        stepIndex: 0,
        commandId: "command",
        idempotencyKey: "key",
        commandType: "queue.add" as const,
        action: "add" as const,
        queue: "601" as const,
        queueId: "queue-row",
        extension: stepExtension,
        extensionId,
        status: "pending" as const,
      },
    ],
    currentStep: 0,
    fallback: { queue: "603" as const, extension: "23", queueId: "queue-603", extensionId: "extension-23" },
    affectedExtensions: [stepExtension],
    assignmentGuards: [{
      claimId: "99999999-9999-4999-8999-999999999999",
      extension: stepExtension,
      extensionId,
      generation: assignmentGeneration,
      lifecycleEpoch: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      profileId: currentOwnerId,
    }],
    actorProfileId: actor.profileId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function live(options: {
  callEndpoint?: string;
  duplicateExtension?: boolean;
  extension?: string;
  memberQueue?: string;
  omitExtension?: boolean;
  omitQueue?: string;
  registered?: boolean;
} = {}) {
  const extension = options.extension ?? "20";
  const extensions: ViptelExtension[] = options.omitExtension
    ? []
    : [
        providerExtension(options.registered ?? false, extension),
        ...(options.duplicateExtension ? [providerExtension(false, extension)] : []),
      ];
  const activeCalls: ViptelActiveCall[] = options.callEndpoint
    ? [{
        direction: "internal",
        status: "answered",
        callerExtension: options.callEndpoint,
        raw: {},
      }]
    : [];
  const queueStatuses: ViptelQueueStatus[] = ["601", "602", "603"].filter((queue) => queue !== options.omitQueue).map((queue) => ({
    queue,
    waitingCalls: 0,
    members: options.memberQueue === queue
      ? [{ extension, paused: false, inUse: false, dynamic: true, callsTaken: 0 }]
      : [],
  }));
  return { activeCalls, extensions, queueStatuses };
}

function safeProvider(options: Parameters<typeof live>[0] = {}) {
  const snapshot = live(options);
  return {
    getQueueStatus: vi.fn(async (queue: string) => snapshot.queueStatuses.find((status) => status.queue === queue) as ViptelQueueStatus),
    listActiveCalls: vi.fn(async () => snapshot.activeCalls),
    listExtensions: vi.fn(async () => snapshot.extensions),
  };
}

function providerExtension(isRegistered: boolean, extension = "20"): ViptelExtension {
  return { extension, isRegistered, allowedChanges: [], raw: {} };
}

function sequentialClient(results: Array<ReturnType<typeof queryResult>>) {
  let index = 0;
  return {
    from: vi.fn(() => {
      const result = results[index++];
      if (!result) throw new Error(`Unexpected database query at index ${index - 1}.`);
      return result.query;
    }),
  };
}

function queryResult(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const query = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          calls.push({ method: String(property), args });
          if (property === "maybeSingle" || property === "single") return Promise.resolve(result);
          return query;
        };
      },
    },
  );
  return { calls, query };
}
