import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { MotoristActor } from "@/server/api-auth";
import { claimOwnedExtensionAction } from "./assignment-interlock";
import { dispatchRoutingCommittedPlanDigest, type DispatchPriorityPlan } from "./dispatch-routing";
import { authorizeWorkplacePriorityDraft } from "./workplace-draft-authority";
import {
  releaseOccupiedWorkplace,
  takeOverOccupiedWorkplace,
  type WorkplaceAdminActionDependencies,
} from "./workplace-admin-actions";

const ids = {
  admin: "11111111-1111-4111-8111-111111111111",
  owner: "22222222-2222-4222-8222-222222222222",
  organization: "33333333-3333-4333-8333-333333333333",
  extension: "44444444-4444-4444-8444-444444444444",
  root: "55555555-5555-4555-8555-555555555555",
  queue602: "66666666-6666-4666-8666-666666666666",
  queue603: "77777777-7777-4777-8777-777777777777",
  lifecycle: "88888888-8888-4888-8888-888888888888",
};
const actor: MotoristActor = {
  userId: "99999999-9999-4999-8999-999999999999",
  profileId: ids.admin,
  organizationId: ids.organization,
  displayName: "Tester admin",
  role: "admin",
};
const previousOwnerActor: MotoristActor = {
  userId: "aaaaaaaa-1111-4111-8111-111111111111",
  profileId: ids.owner,
  organizationId: ids.organization,
  displayName: "Pôvodný operátor",
  role: "dispatcher",
};

beforeEach(() => {
  process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "true";
  process.env.VIPTEL_LIVE_MUTATION_TOKEN = "test-live-mutation-authority-token-at-least-32-characters";
  process.env.VIPTEL_WORKPLACE_ADMIN_TAKEOVER_ENABLED = "true";
  process.env.SUPABASE_SECRET_KEY = "test-workplace-draft-signing-secret-at-least-32-characters";
});

afterEach(() => {
  delete process.env.VIPTEL_LIVE_MUTATIONS_ENABLED;
  delete process.env.VIPTEL_LIVE_MUTATION_TOKEN;
  delete process.env.VIPTEL_WORKPLACE_ADMIN_TAKEOVER_ENABLED;
  delete process.env.SUPABASE_SECRET_KEY;
});

describe("administrative workplace handoff saga", () => {
  it("rejects non-manager roles and the dedicated disabled flag before changing state", async () => {
    const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
    await expect(takeOverOccupiedWorkplace({ ...actor, role: "dispatcher" }, "20", harness.dependencies()))
      .rejects.toMatchObject({ status: 403 });

    delete process.env.VIPTEL_WORKPLACE_ADMIN_TAKEOVER_ENABLED;
    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies()))
      .rejects.toMatchObject({ status: 503 });
    expect(harness.extension().profile_id).toBe(ids.owner);
    expect(harness.hasExtensionLock()).toBe(false);
    expect(harness.hasRootLock()).toBe(false);
  });

  it("fails closed on pending extension commands, unsigned draft drift and release of an in-plan seat", async () => {
    const pending = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
    pending.addPendingCommand();
    await expect(takeOverOccupiedWorkplace(actor, "20", pending.dependencies())).rejects.toThrow("rozpracovaný");
    expect(pending.hasExtensionLock()).toBe(false);

    const draft = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
    draft.setUnsignedDraft({ "601": null, "602": null, "603": null });
    await expect(takeOverOccupiedWorkplace(actor, "20", draft.dependencies())).rejects.toMatchObject({ status: 409 });
    expect(draft.hasExtensionLock()).toBe(false);

    const inPlanRelease = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
    await expect(releaseOccupiedWorkplace(actor, "20", inPlanRelease.dependencies())).rejects.toThrow(
      "súčasťou poradia",
    );
  });

  it("rejects an inactive source and a source deactivated after both locks are acquired", async () => {
    const inactive = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
    inactive.setOwnerActive(false);
    await expect(takeOverOccupiedWorkplace(actor, "20", inactive.dependencies())).rejects.toMatchObject({ status: 409 });
    expect(inactive.hasExtensionLock()).toBe(false);

    const raced = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
    raced.deactivateOwnerAfterRootLock();
    await expect(takeOverOccupiedWorkplace(actor, "20", raced.dependencies())).rejects.toMatchObject({ status: 404 });
    expect(raced.extension().profile_id).toBe(ids.owner);
    expect(raced.hasRootLock()).toBe(false);
    expect(raced.hasExtensionLock()).toBe(false);
  });

  it("takes over the sole priority-601 workplace without changing queue membership", async () => {
    const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });

    const result = await takeOverOccupiedWorkplace(actor, "20", harness.dependencies());

    expect(result).toMatchObject({ extension: "20", profile_id: ids.admin, preservedQueue: "601" });
    expect(harness.extension().profile_id).toBe(ids.admin);
    expect(harness.profile(ids.owner).phone_extension).toBeNull();
    expect(harness.profile(ids.admin).phone_extension).toBe("20");
    expect(harness.rootPlan()).toEqual({ "601": "20", "602": null, "603": null });
    expect(harness.commandWrites).toBe(0);
    expect(harness.hasExtensionLock()).toBe(false);
    expect(harness.hasRootLock()).toBe(false);
    expect(harness.terminalAudit("telephony.extension.assign")?.after_payload).toMatchObject({
      previous_profile_id: ids.owner,
      profile_id: ids.admin,
      preserved_queue: "601",
    });
    await expect(claimOwnedExtensionAction(
      previousOwnerActor,
      ids.extension,
      "webphone.session.issue",
      { client: harness.dependencies().client },
    )).rejects.toMatchObject({ status: 403 });

    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).resolves.toMatchObject({
      noOp: true,
      preservedQueue: "601",
    });
  });

  it("releases an idle occupied workplace only when it is outside the committed plan", async () => {
    const harness = serviceHarness({ extension: "22", plan: { "601": "20", "602": null, "603": null } });

    await expect(releaseOccupiedWorkplace(actor, "22", harness.dependencies())).resolves.toMatchObject({
      extension: "22",
      profile_id: null,
      preservedQueue: null,
    });
    expect(harness.extension().profile_id).toBeNull();
    expect(harness.profile(ids.owner).phone_extension).toBeNull();
    expect(harness.hasExtensionLock()).toBe(false);
    expect(harness.hasRootLock()).toBe(false);
    expect(harness.terminalAudit("telephony.extension.unassign")?.after_payload).toMatchObject({
      profile_id: null,
      sharing_mode: "workplace_claim",
    });
  });

  it("rolls both profile reservations back before owner_switched and unlocks root before extension", async () => {
    const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
    harness.failWhile((write) =>
      write.table === "motorist_telephony_extensions" &&
      write.operation === "update" &&
      write.values.profile_id === ids.admin,
    );

    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toThrow(
      "Vlastníka pracoviska sa nepodarilo",
    );

    expect(harness.extension().profile_id).toBe(ids.owner);
    expect(harness.profile(ids.owner).phone_extension).toBe("20");
    expect(harness.profile(ids.admin).phone_extension).toBeNull();
    expect(harness.hasRootLock()).toBe(false);
    expect(harness.hasExtensionLock()).toBe(false);
    expect(harness.writeOrder.slice(-2)).toEqual(["root_unlock", "extension_unlock"]);
  });

  it("keeps both locks after terminal audit failure, then stale recovery rolls forward idempotently", async () => {
    const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
    harness.failWhile((write) =>
      write.table === "motorist_audit_log" &&
      write.operation === "insert" &&
      write.values.action === "telephony.extension.assign",
    );

    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toMatchObject({
      code: "WORKPLACE_TRANSITION_RECOVERY_REQUIRED",
    });
    expect(harness.extension().profile_id).toBe(ids.admin);
    expect(harness.hasRootLock()).toBe(true);
    expect(harness.hasExtensionLock()).toBe(true);

    harness.clearFailure();
    harness.advanceMinutes(6);
    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toThrow("bezpečne obnovená");
    expect(harness.hasRootLock()).toBe(false);
    expect(harness.hasExtensionLock()).toBe(false);
    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).resolves.toMatchObject({ noOp: true });
  });

  it("allows only recovery of an existing transition after the dedicated takeover flag is disabled", async () => {
    const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
    harness.failWhile((write) => write.tag === "terminal_takeover_audit");
    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toMatchObject({
      code: "WORKPLACE_TRANSITION_RECOVERY_REQUIRED",
    });

    harness.clearFailure();
    harness.advanceMinutes(6);
    delete process.env.VIPTEL_WORKPLACE_ADMIN_TAKEOVER_ENABLED;
    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toThrow("bezpečne obnovená");

    expect(harness.extension().profile_id).toBe(ids.admin);
    expect(harness.terminalAudit("telephony.extension.assign")).toBeDefined();
    expect(harness.hasRootLock()).toBe(false);
    expect(harness.hasExtensionLock()).toBe(false);

    await expect(releaseOccupiedWorkplace(actor, "22", serviceHarness({
      extension: "22",
      plan: { "601": "20", "602": null, "603": null },
    }).dependencies())).rejects.toMatchObject({ status: 503 });
  });

  it("recovers a crash after root unlock but before extension unlock", async () => {
    const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
    harness.failWhile((write) => write.tag === "extension_unlock");

    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toMatchObject({
      code: "WORKPLACE_TRANSITION_RECOVERY_REQUIRED",
    });
    expect(harness.extension().profile_id).toBe(ids.admin);
    expect(harness.hasRootLock()).toBe(false);
    expect(harness.hasExtensionLock()).toBe(true);

    harness.clearFailure();
    harness.advanceMinutes(6);
    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toThrow("bezpečne obnovená");
    expect(harness.hasExtensionLock()).toBe(false);
  });

  it("survives two recovery crashes between extension and root recovery CAS", async () => {
    const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
    harness.failWhile((write) =>
      write.table === "motorist_audit_log" && write.operation === "insert" &&
      write.values.action === "telephony.extension.assign",
    );
    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toBeDefined();
    harness.clearFailure();

    harness.advanceMinutes(6);
    harness.failWhile((write) => write.tag === "root_recovery");
    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toBeDefined();
    const firstRecoveryTransition = harness.extensionTransitionId();
    const unchangedRootTransition = harness.rootTransitionId();

    harness.advanceMinutes(6);
    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toBeDefined();
    expect(harness.extensionTransitionId()).not.toBe(firstRecoveryTransition);
    expect(harness.rootTransitionId()).toBe(unchangedRootTransition);

    harness.clearFailure();
    harness.advanceMinutes(6);
    await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toThrow("bezpečne obnovená");
    expect(harness.hasRootLock()).toBe(false);
    expect(harness.hasExtensionLock()).toBe(false);
  });

  describe("fault injection at every takeover write boundary", () => {
    const preCommitBoundaries = [
      { completedWrite: "extension_lock", failAt: "root_lock" },
      { completedWrite: "root_lock", failAt: "source_profile_clear" },
      { completedWrite: "source_profile_clear", failAt: "phase_source_released" },
      { completedWrite: "phase_source_released", failAt: "target_profile_reserve" },
      { completedWrite: "target_profile_reserve", failAt: "phase_target_reserved" },
      { completedWrite: "phase_target_reserved", failAt: "owner_switched" },
    ] as const;

    it.each(preCommitBoundaries)(
      "restores the original owner after $completedWrite and before $failAt",
      async ({ failAt }) => {
        const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
        harness.failWhile((write) => write.tag === failAt);

        await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toBeDefined();

        expect(harness.extension().profile_id).toBe(ids.owner);
        expect(harness.profile(ids.owner).phone_extension).toBe("20");
        expect(harness.profile(ids.admin).phone_extension).toBeNull();
        expect(harness.hasRootLock()).toBe(false);
        expect(harness.hasExtensionLock()).toBe(false);
      },
    );

    const committedBoundaries = [
      { completedWrite: "owner_switched", failAt: "terminal_takeover_audit" },
      { completedWrite: "terminal_takeover_audit", failAt: "phase_audit_committed" },
      { completedWrite: "phase_audit_committed", failAt: "root_unlock" },
      { completedWrite: "root_unlock", failAt: "extension_unlock" },
    ] as const;

    it.each(committedBoundaries)(
      "rolls forward after $completedWrite and before $failAt",
      async ({ failAt }) => {
        const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
        harness.failWhile((write) => write.tag === failAt);

        await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toBeDefined();
        expect(harness.extension().profile_id).toBe(ids.admin);

        harness.clearFailure();
        if (harness.hasExtensionLock()) {
          harness.advanceMinutes(6);
          await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toThrow(
            "bezpečne obnovená",
          );
        }

        expect(harness.extension().profile_id).toBe(ids.admin);
        expect(harness.profile(ids.owner).phone_extension).toBeNull();
        expect(harness.profile(ids.admin).phone_extension).toBe("20");
        expect(harness.terminalAudit("telephony.extension.assign")).toBeDefined();
        expect(harness.hasRootLock()).toBe(false);
        expect(harness.hasExtensionLock()).toBe(false);
      },
    );
  });

  describe("fault injection at every administrative-release write boundary", () => {
    const preCommitBoundaries = [
      { completedWrite: "extension_lock", failAt: "root_lock" },
      { completedWrite: "root_lock", failAt: "source_profile_clear" },
      { completedWrite: "source_profile_clear", failAt: "phase_source_released" },
      { completedWrite: "phase_source_released", failAt: "owner_cleared" },
    ] as const;

    it.each(preCommitBoundaries)(
      "restores the occupied seat after $completedWrite and before $failAt",
      async ({ failAt }) => {
        const harness = serviceHarness({ extension: "22", plan: { "601": "20", "602": null, "603": null } });
        harness.failWhile((write) => write.tag === failAt);

        await expect(releaseOccupiedWorkplace(actor, "22", harness.dependencies())).rejects.toBeDefined();

        expect(harness.extension().profile_id).toBe(ids.owner);
        expect(harness.profile(ids.owner).phone_extension).toBe("22");
        expect(harness.profile(ids.admin).phone_extension).toBeNull();
        expect(harness.hasRootLock()).toBe(false);
        expect(harness.hasExtensionLock()).toBe(false);
      },
    );

    const committedBoundaries = [
      { completedWrite: "owner_cleared", failAt: "terminal_release_audit" },
      { completedWrite: "terminal_release_audit", failAt: "phase_audit_committed" },
      { completedWrite: "phase_audit_committed", failAt: "root_unlock" },
      { completedWrite: "root_unlock", failAt: "extension_unlock" },
    ] as const;

    it.each(committedBoundaries)(
      "finishes the release after $completedWrite and before $failAt",
      async ({ failAt }) => {
        const harness = serviceHarness({ extension: "22", plan: { "601": "20", "602": null, "603": null } });
        harness.failWhile((write) => write.tag === failAt);

        await expect(releaseOccupiedWorkplace(actor, "22", harness.dependencies())).rejects.toBeDefined();
        expect(harness.extension().profile_id).toBeNull();

        harness.clearFailure();
        if (harness.hasExtensionLock()) {
          harness.advanceMinutes(6);
          await expect(releaseOccupiedWorkplace(actor, "22", harness.dependencies())).rejects.toThrow(
            "bezpečne obnovená",
          );
        }

        expect(harness.extension().profile_id).toBeNull();
        expect(harness.profile(ids.owner).phone_extension).toBeNull();
        expect(harness.terminalAudit("telephony.extension.unassign")).toBeDefined();
        expect(harness.hasRootLock()).toBe(false);
        expect(harness.hasExtensionLock()).toBe(false);
      },
    );
  });

  describe("signed redundant-draft cleanup fault windows", () => {
    it.each([
      { faultAt: "priority_cleanup_audit", draftRemains: true },
      { faultAt: "draft_cleanup", draftRemains: true },
      { faultAt: "source_profile_clear", draftRemains: false },
    ] as const)("keeps ownership safe when $faultAt fails", async ({ faultAt, draftRemains }) => {
      const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
      harness.setSignedRedundantDraft();
      harness.failWhile((write) => write.tag === faultAt);

      await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toBeDefined();

      expect(harness.extension().profile_id).toBe(ids.owner);
      expect(harness.profile(ids.owner).phone_extension).toBe("20");
      expect(harness.profile(ids.admin).phone_extension).toBeNull();
      expect(harness.hasDraft()).toBe(draftRemains);
      expect(harness.hasRootLock()).toBe(false);
      expect(harness.hasExtensionLock()).toBe(false);
    });

    it.each(["priority_cleanup_audit", "draft_cleanup"])(
      "proves an applied-but-error $0 write by exact readback",
      async (tag) => {
        const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
        harness.setSignedRedundantDraft();
        harness.failAppliedOnce(tag);

        await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).resolves.toMatchObject({
          profile_id: ids.admin,
          preservedQueue: "601",
        });
        expect(harness.hasDraft()).toBe(false);
        expect(harness.hasRootLock()).toBe(false);
        expect(harness.hasExtensionLock()).toBe(false);
      },
    );
  });

  describe("ambiguous applied-but-error responses", () => {
    it("recovers an extension-lock response lost after the CAS applied", async () => {
      const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
      harness.failAppliedOnce("extension_lock");

      await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toBeDefined();
      expect(harness.hasExtensionLock()).toBe(true);
      harness.advanceMinutes(6);
      await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toThrow("bezpečne obnovená");

      expect(harness.extension().profile_id).toBe(ids.owner);
      expect(harness.profile(ids.owner).phone_extension).toBe("20");
      expect(harness.profile(ids.admin).phone_extension).toBeNull();
      expect(harness.hasRootLock()).toBe(false);
      expect(harness.hasExtensionLock()).toBe(false);
    });

    it.each([
      { tag: "root_lock", committed: true },
      { tag: "source_profile_clear", committed: false },
      { tag: "phase_source_released", committed: false },
      { tag: "target_profile_reserve", committed: false },
      { tag: "phase_target_reserved", committed: false },
      { tag: "owner_switched", committed: true },
      { tag: "terminal_takeover_audit", committed: true },
      { tag: "phase_audit_committed", committed: true },
      { tag: "root_unlock", committed: true },
      { tag: "extension_unlock", committed: true },
    ] as const)("resolves takeover ambiguity at $tag", async ({ tag, committed }) => {
      const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
      harness.failAppliedOnce(tag);

      const attempt = takeOverOccupiedWorkplace(actor, "20", harness.dependencies());
      if (committed) await expect(attempt).resolves.toMatchObject({ profile_id: ids.admin });
      else await expect(attempt).rejects.toBeDefined();

      expect(harness.extension().profile_id).toBe(committed ? ids.admin : ids.owner);
      expect(harness.profile(ids.owner).phone_extension).toBe(committed ? null : "20");
      expect(harness.profile(ids.admin).phone_extension).toBe(committed ? "20" : null);
      expect(harness.hasRootLock()).toBe(false);
      expect(harness.hasExtensionLock()).toBe(false);
    });

    it.each([
      { tag: "source_profile_clear", committed: false },
      { tag: "phase_source_released", committed: false },
      { tag: "owner_cleared", committed: true },
      { tag: "terminal_release_audit", committed: true },
      { tag: "phase_audit_committed", committed: true },
      { tag: "root_unlock", committed: true },
      { tag: "extension_unlock", committed: true },
    ] as const)("resolves administrative release ambiguity at $tag", async ({ tag, committed }) => {
      const harness = serviceHarness({ extension: "22", plan: { "601": "20", "602": null, "603": null } });
      harness.failAppliedOnce(tag);

      const attempt = releaseOccupiedWorkplace(actor, "22", harness.dependencies());
      if (committed) await expect(attempt).resolves.toMatchObject({ profile_id: null });
      else await expect(attempt).rejects.toBeDefined();

      expect(harness.extension().profile_id).toBe(committed ? null : ids.owner);
      expect(harness.profile(ids.owner).phone_extension).toBe(committed ? null : "22");
      expect(harness.hasRootLock()).toBe(false);
      expect(harness.hasExtensionLock()).toBe(false);
    });
  });

  describe("rollback restore-write fault recovery", () => {
    const restoreBoundaries = [
      { forwardFault: "phase_source_released", restoreTag: "source_profile_restore" },
      { forwardFault: "owner_switched", restoreTag: "target_profile_restore" },
    ] as const;

    it.each(restoreBoundaries)(
      "recovers when $restoreTag is initially prevented",
      async ({ forwardFault, restoreTag }) => {
        const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
        harness.failWhile((write) => write.tag === forwardFault || write.tag === restoreTag);

        await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toBeDefined();
        expect(harness.hasRootLock()).toBe(true);
        expect(harness.hasExtensionLock()).toBe(true);

        harness.clearFailure();
        harness.advanceMinutes(6);
        await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toThrow(
          "bezpečne obnovená",
        );

        expect(harness.extension().profile_id).toBe(ids.owner);
        expect(harness.profile(ids.owner).phone_extension).toBe("20");
        expect(harness.profile(ids.admin).phone_extension).toBeNull();
        expect(harness.hasRootLock()).toBe(false);
        expect(harness.hasExtensionLock()).toBe(false);
      },
    );

    it.each(restoreBoundaries)(
      "recovers an applied-but-error response from $restoreTag",
      async ({ forwardFault, restoreTag }) => {
        const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
        harness.failWhile((write) => write.tag === forwardFault);
        harness.failAppliedOnce(restoreTag);

        await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toBeDefined();
        expect(harness.hasRootLock()).toBe(true);
        expect(harness.hasExtensionLock()).toBe(true);

        harness.clearFailure();
        harness.advanceMinutes(6);
        await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toThrow(
          "bezpečne obnovená",
        );

        expect(harness.extension().profile_id).toBe(ids.owner);
        expect(harness.profile(ids.owner).phone_extension).toBe("20");
        expect(harness.profile(ids.admin).phone_extension).toBeNull();
        expect(harness.hasRootLock()).toBe(false);
        expect(harness.hasExtensionLock()).toBe(false);
      },
    );
  });

  describe("recovery-CAS fault recovery", () => {
    it.each([
      { mode: "prevented", recoveryTag: "extension_recovery" },
      { mode: "prevented", recoveryTag: "root_recovery" },
      { mode: "applied-but-error", recoveryTag: "extension_recovery" },
      { mode: "applied-but-error", recoveryTag: "root_recovery" },
    ] as const)("retries a $mode $recoveryTag response", async ({ mode, recoveryTag }) => {
      const harness = serviceHarness({ extension: "20", plan: { "601": "20", "602": null, "603": null } });
      harness.failWhile((write) => write.tag === "terminal_takeover_audit");
      await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toBeDefined();

      harness.clearFailure();
      harness.advanceMinutes(6);
      if (mode === "prevented") harness.failWhile((write) => write.tag === recoveryTag);
      else harness.failAppliedOnce(recoveryTag);
      await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toBeDefined();
      expect(harness.hasRootLock()).toBe(true);
      expect(harness.hasExtensionLock()).toBe(true);

      harness.clearFailure();
      harness.advanceMinutes(6);
      await expect(takeOverOccupiedWorkplace(actor, "20", harness.dependencies())).rejects.toThrow(
        "bezpečne obnovená",
      );

      expect(harness.extension().profile_id).toBe(ids.admin);
      expect(harness.profile(ids.owner).phone_extension).toBeNull();
      expect(harness.profile(ids.admin).phone_extension).toBe("20");
      expect(harness.terminalAudit("telephony.extension.assign")).toBeDefined();
      expect(harness.hasRootLock()).toBe(false);
      expect(harness.hasExtensionLock()).toBe(false);
    });
  });
});

// The fake intentionally stores rows from several unrelated Supabase tables.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type TableName =
  | "motorist_audit_log"
  | "motorist_profiles"
  | "motorist_telephony_commands"
  | "motorist_telephony_extensions"
  | "motorist_telephony_queues";
type Write = {
  operation: "insert" | "update";
  table: TableName;
  tag?: string;
  values: Row;
};

function serviceHarness(input: { extension: string; plan: DispatchPriorityPlan }) {
  const initialNow = new Date("2026-08-06T14:00:00.000Z");
  let clock = initialNow.getTime();
  let sequence = 1;
  let failure: ((write: Write) => boolean) | undefined;
  let appliedButErrored: ((write: Write) => boolean) | undefined;
  let afterWrite: ((write: Write) => void) | undefined;
  const lifecycle = {
    schemaVersion: 1,
    epoch: ids.lifecycle,
    state: "assigned",
    extensionId: ids.extension,
    extension: input.extension,
    profileId: ids.owner,
    assignmentMode: "workplace_claim",
    assignedAt: "2026-08-06T12:00:00.000Z",
    assignedBy: ids.owner,
  };
  const rootState = { revision: 1, currentPlan: input.plan };
  const routingDigest = dispatchRoutingCommittedPlanDigest(ids.organization, ids.root, rootState);
  const tables: Record<TableName, Row[]> = {
    motorist_profiles: [
      profileRow(ids.owner, input.extension),
      profileRow(ids.admin, null),
    ],
    motorist_telephony_extensions: [{
      id: ids.extension,
      organization_id: ids.organization,
      provider: "viptel",
      extension: input.extension,
      profile_id: ids.owner,
      active: true,
      metadata: { assignmentGeneration: ids.lifecycle, assignmentLifecycle: lifecycle },
      is_registered: false,
      updated_at: "2026-08-06T12:00:00.000Z",
    }],
    motorist_telephony_queues: [
      queueRow(ids.root, "601", { dispatchRouting: rootState }),
      queueRow(ids.queue602, "602", {}),
      queueRow(ids.queue603, "603", {}),
    ],
    motorist_telephony_commands: [],
    motorist_audit_log: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        organization_id: ids.organization,
        actor_profile_id: ids.owner,
        action: "telephony.extension.assign",
        entity_type: "motorist_telephony_extensions",
        entity_id: ids.extension,
        before_payload: { extension: input.extension, profile_id: null },
        after_payload: { extension: input.extension, profile_id: ids.owner, assignment_lifecycle: lifecycle },
        created_at: "2026-08-06T12:00:01.000Z",
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        organization_id: ids.organization,
        actor_profile_id: ids.owner,
        action: "telephony.routing.plan.committed",
        entity_type: "motorist_telephony_queues",
        entity_id: ids.root,
        before_payload: null,
        after_payload: {
          routing_plan_commit: {
            schemaVersion: 1,
            organizationId: ids.organization,
            rootId: ids.root,
            revision: 1,
            currentPlan: input.plan,
            digest: routingDigest,
          },
        },
        created_at: "2026-08-06T12:00:02.000Z",
      },
    ],
  };
  const writeOrder: string[] = [];
  let commandWrites = 0;

  const db = {
    from(table: TableName) {
      return new FakeQuery(table, tables, {
        fail(write) {
          return failure?.(write) ?? false;
        },
        appliedButErrored(write) {
          return appliedButErrored?.(write) ?? false;
        },
        nextTimestamp() {
          sequence += 1;
          return new Date(clock + sequence * 10).toISOString();
        },
        record(write) {
          if (write.table === "motorist_telephony_commands") commandWrites += 1;
          if (write.tag) writeOrder.push(write.tag);
          afterWrite?.(write);
        },
      });
    },
  };
  let uuidCounter = 100;
  const randomId = () => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
  };
  const expectedQueue = (Object.entries(input.plan).find(([, extension]) => extension === input.extension)?.[0] ?? null) as
    | "601"
    | "602"
    | "603"
    | null;
  const dependencies = (): WorkplaceAdminActionDependencies => ({
    client: db as never,
    now: () => new Date(clock).toISOString(),
    randomId,
    requestProviderSnapshot: async () => providerSnapshot(input.extension, expectedQueue),
  });

  return {
    dependencies,
    writeOrder,
    get commandWrites() {
      return commandWrites;
    },
    advanceMinutes(minutes: number) {
      clock += minutes * 60_000;
    },
    clearFailure() {
      failure = undefined;
      appliedButErrored = undefined;
    },
    addPendingCommand() {
      tables.motorist_telephony_commands.push({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        organization_id: ids.organization,
        provider: "viptel",
        command_type: "call.create",
        extension_id: ids.extension,
        request_payload: { extension: input.extension },
        status: "queued",
        created_at: new Date(clock).toISOString(),
      });
    },
    setUnsignedDraft(plan: DispatchPriorityPlan) {
      tables.motorist_telephony_queues[0].metadata.workplacePriorityDraft = {
        schemaVersion: 1,
        baseRevision: 1,
        selections: plan,
        selectedBy: { "601": null, "602": null, "603": null },
        updatedAt: new Date(clock).toISOString(),
      };
    },
    setSignedRedundantDraft() {
      const auditId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const selectedBy = Object.fromEntries(Object.entries(input.plan).map(([queue, extension]) => [
        queue,
        extension === null ? null : ids.owner,
      ])) as Record<"601" | "602" | "603", string | null>;
      const authorized = authorizeWorkplacePriorityDraft({
        schemaVersion: 1,
        baseRevision: 1,
        selections: input.plan,
        selectedBy,
        updatedAt: new Date(clock).toISOString(),
      }, {
        organizationId: ids.organization,
        rootQueueId: ids.root,
      }, auditId);
      tables.motorist_telephony_queues[0].metadata.workplacePriorityDraft = authorized.draft;
      tables.motorist_audit_log.push({
        id: auditId,
        organization_id: ids.organization,
        actor_profile_id: ids.owner,
        action: "telephony.workplace.priority.draft",
        entity_type: "motorist_telephony_queues",
        entity_id: ids.root,
        before_payload: null,
        after_payload: authorized.auditPayload,
        created_at: new Date(clock + 30).toISOString(),
      });
    },
    failWhile(predicate: (write: Write) => boolean) {
      failure = predicate;
    },
    failAppliedOnce(tag: string) {
      appliedButErrored = (write) => {
        if (write.tag !== tag) return false;
        appliedButErrored = undefined;
        return true;
      };
    },
    deactivateOwnerAfterRootLock() {
      afterWrite = (write) => {
        if (write.tag !== "root_lock") return;
        const owner = tables.motorist_profiles.find((profile) => profile.id === ids.owner) as Row;
        owner.active = false;
        owner.updated_at = new Date(clock + 5).toISOString();
        afterWrite = undefined;
      };
    },
    setOwnerActive(active: boolean) {
      (tables.motorist_profiles.find((profile) => profile.id === ids.owner) as Row).active = active;
    },
    extension() {
      return tables.motorist_telephony_extensions[0];
    },
    profile(id: string) {
      return tables.motorist_profiles.find((profile) => profile.id === id) as Row;
    },
    hasExtensionLock() {
      return tables.motorist_telephony_extensions[0].metadata?.assignmentTransition?.active === true;
    },
    hasRootLock() {
      return tables.motorist_telephony_queues[0].metadata?.workplaceOwnerTransition?.active === true;
    },
    extensionTransitionId() {
      return tables.motorist_telephony_extensions[0].metadata?.assignmentTransition?.transitionId;
    },
    rootTransitionId() {
      return tables.motorist_telephony_queues[0].metadata?.workplaceOwnerTransition?.transitionId;
    },
    rootPlan() {
      return tables.motorist_telephony_queues[0].metadata.dispatchRouting.currentPlan;
    },
    terminalAudit(action: string) {
      return [...tables.motorist_audit_log].reverse().find((audit) => audit.action === action);
    },
    hasDraft() {
      return Boolean(tables.motorist_telephony_queues[0].metadata.workplacePriorityDraft);
    },
  };
}

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private limitValue: number | undefined;
  private operation: "insert" | "select" | "update" = "select";
  private orderings: Array<{ ascending: boolean; column: string }> = [];
  private values: Row = {};

  constructor(
    private readonly table: TableName,
    private readonly tables: Record<TableName, Row[]>,
    private readonly hooks: {
      appliedButErrored: (write: Write) => boolean;
      fail: (write: Write) => boolean;
      nextTimestamp: () => string;
      record: (write: Write) => void;
    },
  ) {}

  select(columns?: string) {
    void columns;
    return this;
  }

  insert(values: Row) {
    this.operation = "insert";
    this.values = clone(values);
    return this;
  }

  update(values: Row) {
    this.operation = "update";
    this.values = clone(values);
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: readonly unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.orderings.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(value: number) {
    this.limitValue = value;
    return this;
  }

  maybeSingle() {
    return Promise.resolve(this.execute(true));
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.execute(false)).then(onfulfilled, onrejected);
  }

  private execute(single: boolean) {
    if (this.operation === "insert") return this.executeInsert();
    if (this.operation === "update") return this.executeUpdate(single);
    let rows = this.tables[this.table].filter((row) => this.filters.every((filter) => filter(row)));
    for (const ordering of [...this.orderings].reverse()) {
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[ordering.column] ?? "").localeCompare(String(right[ordering.column] ?? ""));
        return ordering.ascending ? comparison : -comparison;
      });
    }
    if (this.limitValue !== undefined) rows = rows.slice(0, this.limitValue);
    return { data: single ? clone(rows[0] ?? null) : clone(rows), error: null };
  }

  private executeInsert() {
    const tag = classifyWrite(this.table, undefined, this.values, "insert");
    const write: Write = { operation: "insert", table: this.table, tag, values: clone(this.values) };
    if (this.hooks.fail(write)) return { data: null, error: { message: "fault injection" } };
    if (
      this.table === "motorist_audit_log" &&
      typeof this.values.id === "string" &&
      this.tables[this.table].some((row) => row.id === this.values.id)
    ) {
      return { data: null, error: { message: "duplicate key" } };
    }
    const row = {
      ...clone(this.values),
      id: this.values.id ?? `00000000-0000-4000-8000-${String(this.tables[this.table].length + 900).padStart(12, "0")}`,
      created_at: this.values.created_at ?? this.hooks.nextTimestamp(),
    };
    this.tables[this.table].push(row);
    this.hooks.record(write);
    return this.hooks.appliedButErrored(write)
      ? { data: null, error: { message: "ambiguous response after applied insert" } }
      : { data: null, error: null };
  }

  private executeUpdate(single: boolean) {
    const rows = this.tables[this.table].filter((row) => this.filters.every((filter) => filter(row)));
    const current = rows[0];
    const tag = classifyWrite(this.table, current, this.values);
    const write: Write = { operation: "update", table: this.table, tag, values: clone(this.values) };
    if (this.hooks.fail(write)) return { data: null, error: { message: "fault injection" } };
    for (const row of rows) {
      Object.assign(row, clone(this.values), { updated_at: this.hooks.nextTimestamp() });
    }
    this.hooks.record(write);
    if (this.hooks.appliedButErrored(write)) {
      return { data: null, error: { message: "ambiguous response after applied update" } };
    }
    const data = rows.map(clone);
    return { data: single ? data[0] ?? null : data, error: null };
  }
}

function classifyWrite(
  table: TableName,
  current: Row | undefined,
  values: Row,
  operation: "insert" | "update" = "update",
) {
  if (operation === "insert" && table === "motorist_audit_log") {
    if (values.action === "telephony.extension.assign") return "terminal_takeover_audit";
    if (values.action === "telephony.extension.unassign") return "terminal_release_audit";
    if (values.action === "telephony.workplace.priority.draft.cleanup") return "priority_cleanup_audit";
  }
  if (table === "motorist_profiles") {
    if (current?.id === ids.owner && values.phone_extension === null) return "source_profile_clear";
    if (current?.id === ids.owner && typeof values.phone_extension === "string") return "source_profile_restore";
    if (current?.id === ids.admin && typeof values.phone_extension === "string") return "target_profile_reserve";
    if (current?.id === ids.admin && values.phone_extension === null) return "target_profile_restore";
  }
  if (
    table === "motorist_telephony_queues" &&
    current?.metadata?.workplaceOwnerTransition?.active !== true &&
    values.metadata?.workplaceOwnerTransition?.active === true
  ) return "root_lock";
  if (table === "motorist_telephony_queues" && current?.metadata?.workplaceOwnerTransition?.active === true) {
    if (!values.metadata?.workplaceOwnerTransition) return "root_unlock";
    if (values.metadata.workplaceOwnerTransition.recoveredBy) return "root_recovery";
    if (current.metadata.workplacePriorityDraft && !values.metadata.workplacePriorityDraft) return "draft_cleanup";
  }
  if (table === "motorist_telephony_extensions" && current?.metadata?.assignmentTransition?.active === true) {
    if (!values.metadata?.assignmentTransition) return "extension_unlock";
    if (values.metadata.assignmentTransition.recoveredBy) return "extension_recovery";
    if (values.metadata.assignmentTransition.phase === "source_released") return "phase_source_released";
    if (values.metadata.assignmentTransition.phase === "target_reserved") return "phase_target_reserved";
    if (values.metadata.assignmentTransition.phase === "owner_switched") return "owner_switched";
    if (values.metadata.assignmentTransition.phase === "owner_cleared") return "owner_cleared";
    if (values.metadata.assignmentTransition.phase === "audit_committed") return "phase_audit_committed";
  }
  if (
    table === "motorist_telephony_extensions" &&
    current?.metadata?.assignmentTransition?.active !== true &&
    values.metadata?.assignmentTransition?.active === true
  ) return "extension_lock";
  return undefined;
}

function profileRow(id: string, extension: string | null) {
  return {
    id,
    organization_id: ids.organization,
    phone_extension: extension,
    active: true,
    updated_at: "2026-08-06T12:00:00.000Z",
  };
}

function queueRow(id: string, externalId: string, metadata: Row) {
  return {
    id,
    organization_id: ids.organization,
    provider: "viptel",
    external_id: externalId,
    line_id: null,
    active: true,
    metadata,
    updated_at: "2026-08-06T12:00:00.000Z",
  };
}

function providerSnapshot(extension: string, queue: "601" | "602" | "603" | null) {
  return {
    extensions: [{ extension, isRegistered: false, allowedChanges: [], raw: {} }],
    activeCalls: [],
    queueStatuses: ["601", "602", "603"].map((number) => ({
      queue: number,
      waitingCalls: 0,
      members: number === queue
        ? [{ extension, paused: false, inUse: false, dynamic: true, callsTaken: 0 }]
        : [],
    })),
  };
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
