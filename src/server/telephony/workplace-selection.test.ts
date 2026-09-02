import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { MotoristActor } from "@/server/api-auth";
import type { DispatchPriorityPlan, DispatchRoutingOperation, DispatchRoutingState } from "./dispatch-routing";
import { authorizeWorkplacePriorityDraft } from "./workplace-draft-authority";
import {
  applyWorkplacePriorityClaim,
  assertDynamicPriorityDisplacementAllowed,
  buildWorkplaceSelectionSnapshot,
  compactCanonicalFreeWorkplacePriorities,
  evaluateWorkplacePriorityRecovery,
  loadWorkplaceSelectionState,
  mutateWorkplaceSelection,
  mutableWorkplacePriorityDraft,
  readWorkplacePriorityDraft,
  startDraftRoutingOperation,
  saveWorkplacePriorityDraft,
  type LoadedWorkplaceState,
  type WorkplacePriorityDraft,
} from "./workplace-selection";

const actor: MotoristActor = {
  userId: "user-1",
  profileId: "profile-20",
  organizationId: "organization-1",
  displayName: "Michal",
  role: "dispatcher",
};
const owners = new Map([
  ["20", "profile-20"],
  ["21", "profile-21"],
  ["22", "profile-22"],
  ["23", "profile-23"],
]);
const authorityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const authorityEnv = { SUPABASE_SECRET_KEY: "test-workplace-authority-secret-at-least-32-characters" };

function trustedHotdeskActor(): MotoristActor {
  return {
    ...actor,
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    organizationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };
}

function enableTrustedHotdesk(profileId: string) {
  process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
  process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
  process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "trusted_test";
  process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "controlled_test";
  process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS = profileId;
}

beforeEach(() => {
  // Vercel injects VERCEL_ENV=production while running the production test
  // gate. These unit scenarios declare their own controlled-test capability
  // and must not inherit deployment identity from the build machine.
  process.env.VERCEL_ENV = "development";
  process.env.SUPABASE_SECRET_KEY = authorityEnv.SUPABASE_SECRET_KEY;
  process.env.VIPTEL_LIVE_MUTATIONS_ENABLED = "true";
  process.env.VIPTEL_LIVE_MUTATION_TOKEN = "test-live-mutation-authority-token-at-least-32-characters";
});

afterEach(() => {
  delete process.env.VERCEL_ENV;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.VIPTEL_LIVE_MUTATIONS_ENABLED;
  delete process.env.VIPTEL_LIVE_MUTATION_TOKEN;
  delete process.env.VIPTEL_WORKPLACE_ADMIN_TAKEOVER_ENABLED;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_MODE;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS;
  delete process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE;
  delete process.env.VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER;
  delete process.env.VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT;
});

describe("self-service workplace priority planning", () => {
  it("keeps an authoritative hot-desk lease when the post-commit snapshot refresh fails", async () => {
    const lease = {
      leaseId: "11111111-1111-4111-8111-111111111111",
      seatId: "22222222-2222-4222-8222-222222222222",
      extension: "20",
      assignmentGeneration: "33333333-3333-4333-8333-333333333333",
      leaderEpoch: 1,
      leaseVersion: 1,
      expiresAt: "2026-08-05T12:02:00.000Z",
      heartbeatIntervalMs: 15_000,
    };
    const response = await mutateWorkplaceSelection(actor, {
      action: "select_seat",
      extension: "20",
      browserInstanceId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    }, {
      client: {} as never,
      assertTakeoverReservation: vi.fn(async () => undefined),
      selectDynamicSeat: vi.fn(async () => ({
        result: { state: "confirmed" as const, message: "Pracovisko je pripravené." },
        lease,
        resumeSecret: "one-time-resume-secret",
      })),
      refreshSelection: vi.fn(async () => {
        throw new Error("simulated unrelated draft invariant failure");
      }),
    });

    expect(response).toMatchObject({
      result: { state: "confirmed" },
      lease,
      resumeSecret: "one-time-resume-secret",
      warning: expect.stringContaining("prehľad"),
    });
    expect(response).not.toHaveProperty("workplace");
  });

  it("synchronizes confirmed provider presence before reading the canonical released seat", async () => {
    const hotdeskActor = trustedHotdeskActor();
    enableTrustedHotdesk(hotdeskActor.profileId);
    const events: string[] = [];
    const canonicalState = canonicalFreePriorityState();
    const releasedSeat = canonicalState.extensions.find((extension) => extension.extension === "21");
    if (!releasedSeat) throw new Error("Released-seat test fixture is incomplete.");
    releasedSeat.is_registered = true;

    const response = await mutateWorkplaceSelection(hotdeskActor, {
      action: "confirm_seat_change",
      browserInstanceId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
      operationId: "55555555-5555-4555-8555-555555555555",
    }, {
      client: {} as never,
      confirmDynamicSeatChange: vi.fn(async () => {
        events.push("confirmed");
        return {
          result: { state: "confirmed" as const, message: "Pracovné miesto je uvoľnené." },
        };
      }),
      refreshPresence: vi.fn(async () => {
        events.push("provider-synchronized");
        releasedSeat.is_registered = false;
        return {
          actorProfileId: hotdeskActor.profileId,
          canManageAssignments: false,
          checkedAt: "2026-08-05T12:02:00.000Z",
          extensions: [],
          queues: [],
          queueStatuses: [],
        };
      }),
      refreshSelection: vi.fn(async () => {
        events.push("canonical-selection-read");
        expect(releasedSeat.is_registered).toBe(false);
        return buildWorkplaceSelectionSnapshot(hotdeskActor, canonicalState, "2026-08-05T12:02:00.000Z");
      }),
    });

    expect(events).toEqual(["confirmed", "provider-synchronized", "canonical-selection-read"]);
    expect(response).not.toHaveProperty("warning");
    expect(response.workplace?.seats.find((seat) => seat.extension === "21")).toMatchObject({
      status: "free",
      registered: false,
      canSelect: true,
    });
  });

  it("retains a confirmed change and warns when post-commit provider convergence fails", async () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    const events: string[] = [];
    const canonicalState = canonicalFreePriorityState();
    const releasedSeat = canonicalState.extensions.find((extension) => extension.extension === "21");
    if (!releasedSeat) throw new Error("Released-seat test fixture is incomplete.");
    releasedSeat.is_registered = true;

    const response = await mutateWorkplaceSelection(actor, {
      action: "confirm_seat_change",
      browserInstanceId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
      operationId: "55555555-5555-4555-8555-555555555555",
    }, {
      client: {} as never,
      confirmDynamicSeatChange: vi.fn(async () => {
        events.push("confirmed");
        return {
          result: { state: "confirmed" as const, message: "Pracovné miesto je uvoľnené." },
        };
      }),
      refreshPresence: vi.fn(async () => {
        events.push("provider-sync-failed");
        throw new Error("simulated provider synchronization failure");
      }),
      refreshSelection: vi.fn(async () => {
        events.push("canonical-selection-read");
        return buildWorkplaceSelectionSnapshot(actor, canonicalState, "2026-08-05T12:02:00.000Z");
      }),
    });

    expect(events).toEqual(["confirmed", "provider-sync-failed", "canonical-selection-read"]);
    expect(response).toMatchObject({
      result: { state: "confirmed", message: "Pracovné miesto je uvoľnené." },
      warning: expect.stringMatching(/potvrdená.*VIPTel.*neopakuj/),
    });
    expect(response.workplace?.seats.find((seat) => seat.extension === "21")).toMatchObject({
      status: "stale",
      registered: true,
    });
  });

  it("merges provider and snapshot recovery warnings without losing the confirmed result", async () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";

    const response = await mutateWorkplaceSelection(actor, {
      action: "confirm_seat_change",
      browserInstanceId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
      operationId: "55555555-5555-4555-8555-555555555555",
    }, {
      client: {} as never,
      confirmDynamicSeatChange: vi.fn(async () => ({
        result: { state: "confirmed" as const, message: "Pracovné miesto je uvoľnené." },
      })),
      refreshPresence: vi.fn(async () => {
        throw new Error("simulated provider synchronization failure");
      }),
      refreshSelection: vi.fn(async () => {
        throw new Error("simulated canonical snapshot failure");
      }),
    });

    expect(response).toMatchObject({
      result: { state: "confirmed", message: "Pracovné miesto je uvoľnené." },
      warning: expect.stringMatching(/VIPTel.*neopakuj.*prehľad/),
    });
    expect(response).not.toHaveProperty("workplace");
  });

  it("does not synchronize provider presence before disconnect confirmation", async () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    const refreshPresence = vi.fn();
    const refreshSelection = vi.fn(async () =>
      buildWorkplaceSelectionSnapshot(actor, canonicalFreePriorityState(), "2026-08-05T12:02:00.000Z"));

    const response = await mutateWorkplaceSelection(actor, {
      action: "leave_seat",
      browserInstanceId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    }, {
      client: {} as never,
      leaveDynamicSeat: vi.fn(async () => ({
        result: {
          state: "disconnect_required" as const,
          operationId: "55555555-5555-4555-8555-555555555555",
          message: "Najprv odpoj telefón.",
        },
      })),
      refreshPresence,
      refreshSelection,
    });

    expect(response.result).toMatchObject({ state: "disconnect_required" });
    expect(refreshPresence).not.toHaveBeenCalled();
    expect(refreshSelection).toHaveBeenCalledOnce();
  });

  it("shows a free seat but disables it for an account outside a controlled-test allowlist", () => {
    const viewer = {
      ...actor,
      profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "trusted_test";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "controlled_test";
    process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    const snapshot = buildWorkplaceSelectionSnapshot(
      viewer,
      canonicalFreePriorityState(),
      "2026-08-05T12:02:00.000Z",
    );
    expect(snapshot.seats.find((seat) => seat.extension === "21")).toMatchObject({
      status: "free",
      canSelect: false,
      reason: "Tento účet nemá povolené obsadzovanie pracovísk.",
    });
  });

  it("lets a newly-created dispatcher select a free seat in the production static pilot without a UUID allowlist", () => {
    const viewer = {
      ...actor,
      profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    process.env.VERCEL_ENV = "production";
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "production_static_pilot";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "production";
    process.env.VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER = "static_viptel";
    process.env.VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT = "I_ACCEPT_NON_REVOCABLE_STATIC_SIP_PILOT";
    delete process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS;

    const snapshot = buildWorkplaceSelectionSnapshot(
      viewer,
      canonicalFreePriorityState(),
      "2026-08-05T12:02:00.000Z",
    );
    expect(snapshot.seats.find((seat) => seat.extension === "21")).toMatchObject({
      status: "free",
      canSelect: true,
    });
  });

  it("lets a dispatcher select an expired seat even when VIPTel still has a stale browser contact", () => {
    const viewer = {
      ...actor,
      profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    process.env.VERCEL_ENV = "production";
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "production_static_pilot";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "production";
    process.env.VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER = "static_viptel";
    process.env.VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT = "I_ACCEPT_NON_REVOCABLE_STATIC_SIP_PILOT";

    const snapshot = buildWorkplaceSelectionSnapshot(
      viewer,
      canonicalExpiredOccupiedState(true),
      "2026-08-05T12:02:00.000Z",
    );
    expect(snapshot.seats.find((seat) => seat.extension === "21")).toMatchObject({
      status: "stale",
      canSelect: true,
      registered: true,
      reasonCode: "seat_offline",
      reason: expect.stringContaining("automaticky vyčistí"),
    });
  });

  it("offers a canonical unowned seat for safe recovery when only a stale registrar contact remains", () => {
    const viewer = {
      ...actor,
      profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    process.env.VERCEL_ENV = "production";
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "production_static_pilot";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "production";
    process.env.VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER = "static_viptel";
    process.env.VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT = "I_ACCEPT_NON_REVOCABLE_STATIC_SIP_PILOT";
    const state = canonicalFreePriorityState();
    const seat = state.extensions.find((extension) => extension.extension === "21");
    if (!seat) throw new Error("Unowned registered-seat fixture is incomplete.");
    seat.is_registered = true;

    const snapshot = buildWorkplaceSelectionSnapshot(viewer, state, "2026-08-05T12:02:00.000Z");

    expect(snapshot.seats.find((candidate) => candidate.extension === "21")).toMatchObject({
      status: "stale",
      canSelect: true,
      registered: true,
      reasonCode: "seat_offline",
      reason: expect.stringContaining("nemá aktívneho vlastníka"),
    });
  });

  it("keeps an expired seat blocked when its registration state is unknown", () => {
    const viewer = {
      ...actor,
      profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "trusted_test";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "controlled_test";
    process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS = viewer.profileId;

    const snapshot = buildWorkplaceSelectionSnapshot(
      viewer,
      canonicalExpiredOccupiedState(null),
      "2026-08-05T12:02:00.000Z",
    );
    expect(snapshot.seats.find((seat) => seat.extension === "21")).toMatchObject({
      status: "unknown",
      canSelect: false,
      reasonCode: "seat_state_unknown",
    });
  });

  it("keeps a seat takeable after the sweeper reaps its lease", () => {
    // The sweeper transitions an expired lease to "ended" and deliberately
    // never touches ownership, and the selection query only loads active and
    // ending leases -- so the seat is left owned with no lease at all. In
    // production that classified as "unknown" with canSelect false, which
    // locked all three occupied workstations out for everyone, their own
    // owners included, one minute after the operators' browsers went away.
    const viewer = {
      ...actor,
      profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "trusted_test";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "controlled_test";
    process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS = viewer.profileId;

    const swept = canonicalExpiredOccupiedState(false);
    swept.leases = new Map();

    const snapshot = buildWorkplaceSelectionSnapshot(viewer, swept, "2026-08-05T12:02:00.000Z");
    expect(snapshot.seats.find((seat) => seat.extension === "21")).toMatchObject({
      status: "stale",
      canSelect: true,
      reasonCode: "seat_offline",
    });
  });

  it("lets the original owner back into their own swept seat", () => {
    const ownerId = "22222222-2222-4222-8222-222222222221";
    const owner = { ...actor, profileId: ownerId, userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "trusted_test";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "controlled_test";
    process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS = ownerId;

    const swept = canonicalExpiredOccupiedState(false);
    swept.leases = new Map();

    const snapshot = buildWorkplaceSelectionSnapshot(owner, swept, "2026-08-05T12:02:00.000Z");
    expect(snapshot.seats.find((seat) => seat.extension === "21")).toMatchObject({ canSelect: true });
  });

  it("still refuses a seat whose lease exists without an owner", () => {
    // The other half of the old condition is genuinely ambiguous and must stay
    // unknown: a lease with nobody owning the seat is a correlation failure,
    // not an operator who walked away.
    const viewer = {
      ...actor,
      profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "trusted_test";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "controlled_test";
    process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS = viewer.profileId;

    const orphaned = canonicalExpiredOccupiedState(false);
    orphaned.extensions = orphaned.extensions.map((extension) => extension.extension === "21"
      ? { ...extension, profile_id: null }
      : extension);

    const snapshot = buildWorkplaceSelectionSnapshot(viewer, orphaned, "2026-08-05T12:02:00.000Z");
    expect(snapshot.seats.find((seat) => seat.extension === "21")).toMatchObject({
      status: "unknown",
      canSelect: false,
    });
  });

  it("derives transition visibility from the durable extension resource claim", () => {
    const viewer = {
      ...actor,
      profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "trusted_test";
    process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "controlled_test";
    process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS = viewer.profileId;
    const state = canonicalFreePriorityState();
    state.transitioningExtensionIds = new Set(["11111111-1111-4111-8111-111111111121"]);

    const snapshot = buildWorkplaceSelectionSnapshot(viewer, state, "2026-08-05T12:02:00.000Z");
    expect(snapshot.seats.find((seat) => seat.extension === "21")).toMatchObject({
      status: "transitioning",
      canSelect: false,
      reasonCode: "seat_transitioning",
    });
  });

  it("does not let a dispatcher displace a foreign active hot-desk priority", () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";

    expect(() => assertDynamicPriorityDisplacementAllowed(
      loadedState({ routing: { revision: 1, currentPlan: { "601": "20", "602": "21", "603": "22" } } }),
      priorityDraft({ "601": "20", "602": "21", "603": "22" }),
      "602",
      "20",
    )).toThrow(expect.objectContaining({ code: "priority_slot_active", status: 409 }));
  });

  it("requires taking over a stale seat instead of silently displacing its priority", () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";

    expect(() => assertDynamicPriorityDisplacementAllowed(
      loadedState({ routing: { revision: 1, currentPlan: { "601": "20", "602": "21", "603": "22" } } }),
      priorityDraft({ "601": "20", "602": "21", "603": "22" }),
      "602",
      "20",
    )).toThrow(expect.objectContaining({ code: "priority_slot_active", status: 409 }));
  });

  it("allows only the operator's own or a genuinely empty priority", () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    expect(() => assertDynamicPriorityDisplacementAllowed(
      loadedState({ routing: { revision: 1, currentPlan: { "601": "20", "602": null, "603": null } } }),
      priorityDraft({ "601": "20", "602": null, "603": null }),
      "601",
      "20",
    )).not.toThrow();
    expect(() => assertDynamicPriorityDisplacementAllowed(
      loadedState({ routing: { revision: 1, currentPlan: { "601": "20", "602": null, "603": null } } }),
      priorityDraft({ "601": "20", "602": null, "603": null }),
      "602",
      "20",
    )).not.toThrow();
  });

  it("replaces a canonically free routed seat without moving it to the actor's old priority", () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    const state = canonicalFreePriorityState();
    const current = priorityDraft({ "601": "20", "602": "21", "603": null });
    current.selectedBy["602"] = null;
    state.draft = current;

    expect(() => assertDynamicPriorityDisplacementAllowed(state, current, "602", "20")).not.toThrow();
    expect(buildWorkplaceSelectionSnapshot(actor, state, "2026-08-05T12:00:00.000Z")
      .priorities.find(({ queue }) => queue === "602"))
      .toMatchObject({ status: "available", selectionEffect: "replace" });
    const { draft, displacedExtension } = applyWorkplacePriorityClaim(current, {
      actorExtension: "20",
      actorProfileId: "profile-20",
      ownerByExtension: state.ownerByExtension,
      queue: "602",
      updatedAt: "2026-08-05T12:01:00.000Z",
    });

    expect(displacedExtension).toBe("21");
    expect(draft.selections).toEqual({ "601": null, "602": "20", "603": null });
    expect(draft.selectedBy).toEqual({ "601": null, "602": "profile-20", "603": null });
  });
  it("swaps two occupied priorities when the actor already holds another priority", () => {
    const { draft, displacedExtension } = applyWorkplacePriorityClaim(
      priorityDraft({ "601": "20", "602": "21", "603": "22" }),
      {
        actorExtension: "20",
        actorProfileId: "profile-20",
        ownerByExtension: owners,
        queue: "602",
        updatedAt: "2026-08-05T12:01:00.000Z",
      },
    );

    expect(displacedExtension).toBe("21");
    expect(draft.selections).toEqual({ "601": "21", "602": "20", "603": "22" });
    expect(draft.selectedBy).toEqual({ "601": "profile-21", "602": "profile-20", "603": "profile-22" });
  });

  it("replaces the selected holder when an out-of-plan actor chooses a full slot", () => {
    const { draft, displacedExtension } = applyWorkplacePriorityClaim(
      priorityDraft({ "601": "21", "602": "22", "603": "23" }),
      {
        actorExtension: "20",
        actorProfileId: "profile-20",
        ownerByExtension: owners,
        queue: "601",
        updatedAt: "2026-08-05T12:01:00.000Z",
      },
    );

    expect(displacedExtension).toBe("21");
    expect(draft.selections).toEqual({ "601": "20", "602": "22", "603": "23" });
    expect(draft.selectedBy["601"]).toBe("profile-20");
  });

  it("treats a revision N draft matching committed revision N+1 as active, not stale", () => {
    const committed = { "601": "20", "602": "21", "603": null } satisfies DispatchPriorityPlan;
    const state = loadedState({
      routing: { revision: 4, currentPlan: committed },
      draft: priorityDraft(committed, 3),
    });

    const snapshot = buildWorkplaceSelectionSnapshot(actor, state, "2026-08-05T12:02:00.000Z");

    expect(snapshot.routingStatus).toMatchObject({ state: "active", selectedCount: 2, capacityCount: 3 });
    expect(snapshot.routingStatus.message).toBe(
      "V uloženom poradí sú obsadené rady 601 a 602. Rad 603 je bez operátora.",
    );
  });

  it("keeps a saved first-operator draft ready for a retry instead of waiting for three choices", () => {
    const desired = { "601": "20", "602": null, "603": null } satisfies DispatchPriorityPlan;
    const snapshot = buildWorkplaceSelectionSnapshot(
      actor,
      loadedState({
        routing: { revision: 0, currentPlan: { "601": null, "602": null, "603": null } },
        draft: priorityDraft(desired, 0),
      }),
      "2026-08-05T12:02:00.000Z",
    );

    expect(snapshot.selection).toEqual({ extension: "20", queue: "601" });
    expect(snapshot.routingStatus).toMatchObject({ state: "ready", selectedCount: 1 });
    expect(snapshot.routingStatus.message).not.toContain("po troch");
    expect(snapshot.priorities.map(({ status }) => status)).toEqual([
      "pending_mine",
      "locked",
      "locked",
    ]);
  });

  it("keeps a committed single operator active without asking that same actor to fill another priority", () => {
    const committed = { "601": "20", "602": null, "603": null } satisfies DispatchPriorityPlan;
    const snapshot = buildWorkplaceSelectionSnapshot(
      actor,
      loadedState({ routing: { revision: 1, currentPlan: committed } }),
      "2026-08-05T12:02:00.000Z",
    );

    expect(snapshot.selection).toEqual({ extension: "20", queue: "601" });
    expect(snapshot.routingStatus).toMatchObject({ state: "active", selectedCount: 1 });
    expect(snapshot.priorities.map(({ status }) => status)).toEqual(["mine", "locked", "locked"]);
  });

  it("marks a terminally failed current command as blocked even while its root operation still says applying", () => {
    const state = selfServicePriorityRecoveryState();

    const snapshot = buildWorkplaceSelectionSnapshot(actor, state, "2026-08-05T12:02:00.000Z");

    expect(snapshot.routingStatus).toMatchObject({
      state: "blocked",
      operationId: priorityRecoveryOperationId,
      canRecover: true,
      message: expect.stringContaining("bezpečne obnoviť"),
    });
  });

  it("marks an already confirmed current command as blocked and recoverable without another provider event", () => {
    const state = selfServicePriorityRecoveryState({ commandStatus: "confirmed_by_event" });

    expect(evaluateWorkplacePriorityRecovery(
      actor,
      state,
      priorityRecoveryExtensionId,
      "20",
      "2026-08-05T12:02:00.000Z",
    )).toMatchObject({
      blocked: true,
      canRecover: true,
      deliveryUncertain: false,
      inProgress: false,
      owned: true,
      reason: expect.stringContaining("krok je potvrdený"),
    });
    expect(buildWorkplaceSelectionSnapshot(actor, state, "2026-08-05T12:02:00.000Z").routingStatus)
      .toMatchObject({
        state: "blocked",
        operationId: priorityRecoveryOperationId,
        canRecover: true,
        message: expect.stringContaining("bezpečne obnoviť"),
      });
  });

  it("never offers self-service recovery for another operator's operation", () => {
    const state = selfServicePriorityRecoveryState();
    const otherActor = { ...actor, profileId: "profile-21", userId: "user-2" };

    expect(evaluateWorkplacePriorityRecovery(
      otherActor,
      state,
      "extension-21",
      "21",
      "2026-08-05T12:02:00.000Z",
    )).toMatchObject({ blocked: true, canRecover: false, owned: false });
  });

  it("resumes only the exact own failed priority operation after an exact lease check", async () => {
    const state = selfServicePriorityRecoveryState();
    const recoverPriority = vi.fn(async () => ({ operation: state.routing.operation }));
    const fence = priorityRecoveryFence();

    const response = await mutateWorkplaceSelection(actor, {
      action: "recover_priority",
      operationId: priorityRecoveryOperationId,
      leaseFence: fence,
    }, {
      client: {} as never,
      verifyPriorityLease: vi.fn(async () => ({ id: priorityRecoveryExtensionId, extension: "20" })),
      loadSelectionState: vi.fn(async () => state),
      loadRoutingCommand: vi.fn(async () => state.currentRoutingCommand ?? null),
      recoverPriority: recoverPriority as never,
      refreshSelection: vi.fn(async () => buildWorkplaceSelectionSnapshot(
        actor,
        state,
        "2026-08-05T12:02:00.000Z",
      )),
      now: () => "2026-08-05T12:02:00.000Z",
    });

    expect(recoverPriority).toHaveBeenCalledWith(actor, "resume");
    expect(response.result).toMatchObject({
      state: "pending",
      operationId: priorityRecoveryOperationId,
    });
  });

  it("resumes a confirmed-but-unadvanced priority step without waiting for a duplicate provider event", async () => {
    const state = selfServicePriorityRecoveryState({ commandStatus: "confirmed_by_event" });
    const recoverPriority = vi.fn(async () => ({ operation: state.routing.operation }));

    const response = await mutateWorkplaceSelection(actor, {
      action: "recover_priority",
      operationId: priorityRecoveryOperationId,
      leaseFence: priorityRecoveryFence(),
    }, {
      client: {} as never,
      verifyPriorityLease: vi.fn(async () => ({ id: priorityRecoveryExtensionId, extension: "20" })),
      loadSelectionState: vi.fn(async () => state),
      loadRoutingCommand: vi.fn(async () => state.currentRoutingCommand ?? null),
      recoverPriority: recoverPriority as never,
      refreshSelection: vi.fn(async () => buildWorkplaceSelectionSnapshot(
        actor,
        state,
        "2026-08-05T12:02:00.000Z",
      )),
      now: () => "2026-08-05T12:02:00.000Z",
    });

    expect(recoverPriority).toHaveBeenCalledOnce();
    expect(recoverPriority).toHaveBeenCalledWith(actor, "resume");
    expect(response.result).toMatchObject({
      state: "pending",
      operationId: priorityRecoveryOperationId,
    });
  });

  it("requires administrative reconciliation instead of replaying an uncertain failed command", async () => {
    const state = selfServicePriorityRecoveryState({ deliveryUncertain: true });
    const recoverPriority = vi.fn();

    await expect(mutateWorkplaceSelection(actor, {
      action: "recover_priority",
      operationId: priorityRecoveryOperationId,
      leaseFence: priorityRecoveryFence(),
    }, {
      client: {} as never,
      verifyPriorityLease: vi.fn(async () => ({ id: priorityRecoveryExtensionId, extension: "20" })),
      loadSelectionState: vi.fn(async () => state),
      loadRoutingCommand: vi.fn(async () => state.currentRoutingCommand ?? null),
      recoverPriority: recoverPriority as never,
      now: () => "2026-08-05T12:02:00.000Z",
    })).rejects.toMatchObject({ code: "priority_recovery_reconcile_required", status: 409 });
    expect(recoverPriority).not.toHaveBeenCalled();
  });

  it("offers the next contiguous priority to a second operator", () => {
    const committed = { "601": "20", "602": null, "603": null } satisfies DispatchPriorityPlan;
    const secondActor = { ...actor, profileId: "profile-21", userId: "user-2", displayName: "Test 1" };
    const snapshot = buildWorkplaceSelectionSnapshot(
      secondActor,
      loadedState({ routing: { revision: 1, currentPlan: committed } }),
      "2026-08-05T12:02:00.000Z",
    );

    expect(snapshot.selection).toEqual({ extension: "21", queue: null });
    expect(snapshot.priorities.map(({ status }) => status)).toEqual(["occupied", "available", "locked"]);
    expect(snapshot.seats.find((seat) => seat.extension === "20")?.management).toBeUndefined();
  });

  it("removes canonical free-chair placeholders and compacts staffed operators", () => {
    const state = canonicalFreePriorityState();
    const draft = mutableWorkplacePriorityDraft(state, "2026-08-05T12:03:00.000Z");

    expect(compactCanonicalFreeWorkplacePriorities(state, draft)).toMatchObject({
      selections: { "601": "20", "602": null, "603": null },
      selectedBy: { "601": "profile-20", "602": null, "603": null },
    });
  });

  it("rejects a direct API attempt to skip the next empty priority", async () => {
    const current = { "601": "20", "602": null, "603": null } satisfies DispatchPriorityPlan;
    const secondActor = { ...actor, profileId: "profile-21", userId: "user-2", displayName: "Test 1" };
    const client = workplaceClient({ leaseProbe: true, routing: { revision: 1, currentPlan: current } });
    const providerApply = vi.fn();

    await expect(mutateWorkplaceSelection(secondActor, { action: "claim_priority", queue: "603" }, {
      client: client as never,
      resolveOwnedExtension: ownedExtensionResolver("21") as never,
      previewPartialApply: providerApply as never,
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("prvé voľné poradie"),
    });
    expect(providerApply).not.toHaveBeenCalled();
  });

  it("rejects releasing the only active operator before persisting a draft or calling the provider", async () => {
    const current = { "601": "20", "602": null, "603": null } satisfies DispatchPriorityPlan;
    const client = workplaceClient({ leaseProbe: true, routing: { revision: 1, currentPlan: current } });
    const providerApply = vi.fn();

    await expect(mutateWorkplaceSelection(actor, { action: "release_priority" }, {
      client: client as never,
      resolveOwnedExtension: ownedExtensionResolver("20") as never,
      previewPartialApply: providerApply as never,
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Posledného operátora"),
    });

    expect(client.from).toHaveBeenCalledTimes(4);
    expect(providerApply).not.toHaveBeenCalled();
  });

  it("rejects replacing the only active operator before persisting a draft or calling the provider", async () => {
    const current = { "601": "20", "602": null, "603": null } satisfies DispatchPriorityPlan;
    const replacementActor = { ...actor, profileId: "profile-21", userId: "user-2", displayName: "Test 1" };
    const client = workplaceClient({ leaseProbe: true, routing: { revision: 1, currentPlan: current } });
    const providerApply = vi.fn();

    await expect(mutateWorkplaceSelection(replacementActor, { action: "claim_priority", queue: "601" }, {
      client: client as never,
      resolveOwnedExtension: ownedExtensionResolver("21") as never,
      previewPartialApply: providerApply as never,
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Posledného operátora"),
    });

    expect(client.from).toHaveBeenCalledTimes(4);
    expect(providerApply).not.toHaveBeenCalled();
  });

  it("fails closed instead of mutating a canonical free chair when the lease runtime is disabled", async () => {
    const client = sequentialClient([queryResult({
      data: [{
        id: "extension-20",
        workplace_seat_generation: "11111111-1111-4111-8111-111111111111",
      }],
      error: null,
    })]);
    const providerApply = vi.fn();

    await expect(mutateWorkplaceSelection(actor, { action: "claim_priority", queue: "601" }, {
      client: client as never,
      resolveOwnedExtension: ownedExtensionResolver("20") as never,
      previewPartialApply: providerApply as never,
      now: () => "2026-08-05T12:01:00.000Z",
    })).rejects.toMatchObject({ code: "hotdesk_runtime_disabled", status: 503 });

    expect(providerApply).not.toHaveBeenCalled();
  });

  it("rejects releasing a non-tail operator that would create a gap before persisting", async () => {
    const current = { "601": "20", "602": "21", "603": "22" } satisfies DispatchPriorityPlan;
    const middleActor = { ...actor, profileId: "profile-21", userId: "user-2", displayName: "Test 1" };
    const client = workplaceClient({ leaseProbe: true, routing: { revision: 3, currentPlan: current } });
    const providerApply = vi.fn();

    await expect(mutateWorkplaceSelection(middleActor, { action: "release_priority" }, {
      client: client as never,
      resolveOwnedExtension: ownedExtensionResolver("21") as never,
      previewPartialApply: providerApply as never,
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("prvé voľné poradie"),
    });

    expect(client.from).toHaveBeenCalledTimes(4);
    expect(providerApply).not.toHaveBeenCalled();
  });

  it("safely releases the tail operator while keeping the first operator as the unchanged fallback", async () => {
    const current = { "601": "20", "602": "21", "603": null } satisfies DispatchPriorityPlan;
    const target = { "601": "20", "602": null, "603": null } satisfies DispatchPriorityPlan;
    const secondActor = { ...actor, profileId: "profile-21", userId: "user-2", displayName: "Test 1" };
    const savedRoot = queryResult({
      data: { id: "queue-601", updated_at: "2026-08-05T12:00:01.000Z" },
      error: null,
    });
    const savedAudit = queryResult({ data: { id: authorityId }, error: null });
    const client = sequentialClient([
      legacyLeaseProbeResult(),
      ...workplaceStateQueryResults({ routing: { revision: 2, currentPlan: current } }),
      savedRoot,
      savedAudit,
      ...workplaceStateQueryResults({ routing: { revision: 3, currentPlan: target } }),
    ]);
    const providerApply = vi.fn()
      .mockResolvedValueOnce({ dryRun: true, previewDigest: "tail-release-digest" })
      .mockResolvedValueOnce({ dryRun: false, previewDigest: "tail-release-digest" });

    const response = await mutateWorkplaceSelection(secondActor, { action: "release_priority" }, {
      client: client as never,
      resolveOwnedExtension: ownedExtensionResolver("21") as never,
      previewPartialApply: providerApply as never,
      now: () => "2026-08-05T12:01:00.000Z",
    });

    expect(response.result).toMatchObject({ state: "pending" });
    expect(response.workplace?.routingStatus).toMatchObject({ state: "active", selectedCount: 1 });
    expect(providerApply).toHaveBeenCalledTimes(2);
    expect(providerApply).toHaveBeenNthCalledWith(1, secondActor, expect.objectContaining({
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: null },
        { queue: "603", extension: null },
      ],
      fallback: { queue: "601", extension: "20" },
      dryRun: true,
    }));
  });

  it("ignores a superseded draft after a manager revision and rebases the next self-service choice", () => {
    const committed = { "601": "21", "602": "22", "603": "23" } satisfies DispatchPriorityPlan;
    const state = loadedState({
      routing: { revision: 5, currentPlan: committed },
      draft: priorityDraft({ "601": "20", "602": "21", "603": "22" }, 3),
    });

    const snapshot = buildWorkplaceSelectionSnapshot(actor, state, "2026-08-05T12:02:00.000Z");
    expect(snapshot.selection).toEqual({ extension: "20", queue: null });
    expect(snapshot.priorities.map((priority) => priority.selectedExtension)).toEqual(["21", "22", "23"]);
    expect(snapshot.routingStatus).toMatchObject({ state: "active", selectedCount: 3 });

    const rebased = mutableWorkplacePriorityDraft(state, "2026-08-05T12:03:00.000Z");
    expect(rebased).toMatchObject({ baseRevision: 5, selections: committed });
    const next = applyWorkplacePriorityClaim(rebased, {
      actorExtension: "20",
      actorProfileId: "profile-20",
      ownerByExtension: owners,
      queue: "602",
      updatedAt: "2026-08-05T12:04:00.000Z",
    }).draft;
    expect(next).toMatchObject({
      baseRevision: 5,
      selections: { "601": "21", "602": "20", "603": "23" },
    });
  });

  it("fails closed when a draft points to a future routing revision", () => {
    const state = loadedState({
      routing: { revision: 4, currentPlan: { "601": "20", "602": "21", "603": "22" } },
      draft: priorityDraft({ "601": "20", "602": "21", "603": "22" }, 5),
    });
    expect(() => mutableWorkplacePriorityDraft(state, "2026-08-05T12:03:00.000Z"))
      .toThrow("budúcu revíziu");
  });

  it("starts provider activation as soon as the first operator claims priority one", async () => {
    const empty = { "601": null, "602": null, "603": null } satisfies DispatchPriorityPlan;
    const active = { "601": "20", "602": null, "603": null } satisfies DispatchPriorityPlan;
    const savedRoot = queryResult({
      data: { id: "queue-601", updated_at: "2026-08-05T12:00:01.000Z" },
      error: null,
    });
    const savedAudit = queryResult({ data: { id: authorityId }, error: null });
    const client = sequentialClient([
      legacyLeaseProbeResult(),
      ...workplaceStateQueryResults({ routing: { revision: 0, currentPlan: empty } }),
      savedRoot,
      savedAudit,
      ...workplaceStateQueryResults({ routing: { revision: 1, currentPlan: active } }),
    ]);
    const previewBootstrap = vi.fn()
      .mockResolvedValueOnce({ dryRun: true, previewDigest: "single-operator-digest" })
      .mockResolvedValueOnce({ dryRun: false, previewDigest: "single-operator-digest" });

    const response = await mutateWorkplaceSelection(actor, { action: "claim_priority", queue: "601" }, {
      client: client as never,
      resolveOwnedExtension: ownedExtensionResolver() as never,
      previewBootstrap: previewBootstrap as never,
      now: () => "2026-08-05T12:01:00.000Z",
    });

    expect(response.result).toMatchObject({ state: "pending" });
    expect(response.workplace?.routingStatus).toMatchObject({ state: "active", selectedCount: 1 });
    expect(previewBootstrap).toHaveBeenCalledTimes(2);
    expect(previewBootstrap).toHaveBeenNthCalledWith(1, actor, expect.objectContaining({
      baseRevision: 0,
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: null },
        { queue: "603", extension: null },
      ],
      dryRun: true,
    }));
    expect(previewBootstrap).toHaveBeenNthCalledWith(2, actor, expect.objectContaining({
      previewDigest: "single-operator-digest",
      dryRun: false,
    }));
  });

  it("rejects a forged valid-looking current draft without authority before any provider operation", async () => {
    const forged = priorityDraft({ "601": "20", "602": "23", "603": "22" }, 2);
    const client = workplaceClient({
      leaseProbe: true,
      draft: forged,
      routing: { revision: 2, currentPlan: { "601": "20", "602": "21", "603": "22" } },
    });
    const providerApply = vi.fn();

    await expect(mutateWorkplaceSelection(actor, { action: "claim_priority", queue: "602" }, {
      client: client as never,
      resolveOwnedExtension: ownedExtensionResolver() as never,
      previewApply: providerApply as never,
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("chýba serverový podpis") });

    expect(providerApply).not.toHaveBeenCalled();
  });

  it("rejects replay of an older legitimately signed current draft when the latest audit belongs to a newer draft", async () => {
    const replayed = authorizedPriorityDraft(
      { "601": "20", "602": "23", "603": "22" },
      2,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const latest = authorizedPriorityDraft(
      { "601": "20", "602": "21", "603": "22" },
      2,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    const client = workplaceClient({
      leaseProbe: true,
      draft: replayed.draft,
      routing: { revision: 2, currentPlan: { "601": "20", "602": "21", "603": "22" } },
      auditRow: workplaceDraftAuditRow(latest, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    });
    const providerApply = vi.fn();

    await expect(mutateWorkplaceSelection(actor, { action: "claim_priority", queue: "602" }, {
      client: client as never,
      resolveOwnedExtension: ownedExtensionResolver() as never,
      previewApply: providerApply as never,
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("najnovšiemu serverovému dôkazu"),
    });

    expect(providerApply).not.toHaveBeenCalled();
  });

  it("accepts the latest valid signed current draft", async () => {
    const authorized = authorizedPriorityDraft(
      { "601": "20", "602": "21", "603": "22" },
      2,
      authorityId,
    );
    const client = workplaceClient({
      draft: authorized.draft,
      routing: { revision: 2, currentPlan: { "601": "20", "602": "21", "603": "22" } },
      auditRow: workplaceDraftAuditRow(authorized, authorityId),
    });

    await expect(loadWorkplaceSelectionState(client as never, actor)).resolves.toMatchObject({
      draft: { baseRevision: 2, authority: { auditId: authorityId } },
    });
  });

  it("ignores a legacy unsigned stale draft without consulting draft authority", async () => {
    const stale = priorityDraft({ "601": "20", "602": "23", "603": "22" }, 1);
    const routing = { revision: 2, currentPlan: { "601": "20", "602": "21", "603": "22" } } satisfies DispatchRoutingState;
    const client = workplaceClient({ draft: stale, routing });
    const state = await loadWorkplaceSelectionState(client as never, actor);
    const snapshot = buildWorkplaceSelectionSnapshot(actor, state, "2026-08-05T12:05:00.000Z");

    expect(snapshot.priorities.map((priority) => priority.selectedExtension)).toEqual(["20", "21", "22"]);
    expect(snapshot.routingStatus.state).toBe("active");
    expect(client.from).toHaveBeenCalledTimes(3);
    expect(client.from).toHaveBeenNthCalledWith(1, "motorist_telephony_extensions");
    expect(client.from).not.toHaveBeenCalledWith("motorist_workplace_leases");
    expect(client.queryResults[0]?.calls).toContainEqual({
      method: "select",
      args: ["id, extension, profile_id, is_registered, metadata"],
    });
    expect(client.queryResults[0]?.calls.some(({ args }) =>
      args.some((value) => typeof value === "string" && value.includes("workplace_seat_generation")))).toBe(false);
  });

  it("rejects a concurrent priority root change before writing an audit", async () => {
    const lostCas = queryResult({ data: null, error: null });
    const client = sequentialClient([lostCas]);

    await expect(saveWorkplacePriorityDraft(
      client as never,
      actor,
      {
        id: "queue-601",
        external_id: "601",
        metadata: {},
        updated_at: "2026-08-05T12:00:00.000Z",
      },
      priorityDraft({ "601": "20", "602": null, "603": null }, 1),
    )).rejects.toMatchObject({ status: 409 });

    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it("rolls the root metadata back when immutable draft audit insertion fails", async () => {
    const previousMetadata = {
      dispatchRouting: {
        revision: 2,
        currentPlan: { "601": "20", "602": "21", "603": "22" },
      },
    };
    const root = {
      id: "queue-601",
      external_id: "601",
      metadata: previousMetadata,
      updated_at: "2026-08-05T12:00:00.000Z",
    };
    const rootWrite = queryResult({ data: { id: root.id, updated_at: "2026-08-05T12:00:01.000Z" }, error: null });
    const failedAudit = queryResult({ data: null, error: { message: "audit unavailable" } });
    const rollback = queryResult({ data: { id: root.id }, error: null });
    const client = sequentialClient([rootWrite, failedAudit, rollback]);

    await expect(saveWorkplacePriorityDraft(
      client as never,
      actor,
      root,
      priorityDraft({ "601": "20", "602": "21", "603": "22" }, 2),
    )).rejects.toThrow("bezpečne vrátená");

    expect(rollback.calls.find((call) => call.method === "update")?.args[0]).toEqual({
      metadata: previousMetadata,
    });
    expect(rollback.calls).toContainEqual({
      method: "eq",
      args: ["updated_at", "2026-08-05T12:00:01.000Z"],
    });
  });

  it("uses the full-plan confirmation text for an active 3-of-3 plan", () => {
    const committed = { "601": "20", "602": "21", "603": "22" } satisfies DispatchPriorityPlan;
    const snapshot = buildWorkplaceSelectionSnapshot(
      actor,
      loadedState({ routing: { revision: 2, currentPlan: committed } }),
      "2026-08-05T12:02:00.000Z",
    );

    expect(snapshot.routingStatus).toMatchObject({ state: "active", selectedCount: 3 });
    expect(snapshot.routingStatus.message).toBe("Poradie 601 → 602 → 603 je potvrdené uloženým provider plánom.");
    expect(snapshot.routingStatus.message).not.toContain("rad  je");
  });

  it("reports lifecycle rollout blockers even while the takeover flag is still off", () => {
    const { admin, state } = adminManagementState(false);
    const snapshot = buildWorkplaceSelectionSnapshot(admin, state, "2026-08-05T12:02:00.000Z");
    expect(snapshot.seats.find((seat) => seat.extension === "21")?.management).toEqual({
      takeover: "blocked",
      release: "blocked",
      reason: expect.stringContaining("bezpečnú prípravu SIP/VIPTel"),
    });
  });

  it("offers takeover only for a disconnected canonical workplace_claim seat", () => {
    const { admin, state } = adminManagementState(true);
    const gated = buildWorkplaceSelectionSnapshot(admin, state, "2026-08-05T12:02:00.000Z");
    expect(gated.seats.find((seat) => seat.extension === "21")?.management?.reason)
      .toContain("zatiaľ nie je");

    process.env.VIPTEL_WORKPLACE_ADMIN_TAKEOVER_ENABLED = "true";
    const enabled = buildWorkplaceSelectionSnapshot(admin, state, "2026-08-05T12:02:01.000Z");
    expect(enabled.seats.find((seat) => seat.extension === "21")?.management).toEqual({
      takeover: "allowed",
      release: "blocked",
      reason: expect.stringContaining("súčasťou poradia"),
    });
  });

  it("runs a partial release through the same preview/digest/apply provider flow", async () => {
    const previewPartial = vi.fn()
      .mockResolvedValueOnce({ dryRun: true, previewDigest: "approved-digest" })
      .mockResolvedValueOnce({ dryRun: false, previewDigest: "approved-digest" });
    const current = { "601": "20", "602": "21", "603": "22" } satisfies DispatchPriorityPlan;
    const target = signedPriorityDraft({ "601": null, "602": "21", "603": "22" }, 7);

    await startDraftRoutingOperation(
      actor,
      { revision: 7, currentPlan: current },
      target,
      { previewPartialApply: previewPartial as never },
      true,
    );

    expect(previewPartial).toHaveBeenCalledTimes(2);
    expect(previewPartial).toHaveBeenNthCalledWith(1, actor, {
      baseRevision: 7,
      slots: [
        { queue: "601", extension: null },
        { queue: "602", extension: "21" },
        { queue: "603", extension: "22" },
      ],
      fallback: { queue: "603", extension: "22" },
      dryRun: true,
      rootMetadataGuard: {
        key: "workplacePriorityDraft",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        authorityId,
      },
    });
    expect(previewPartial).toHaveBeenNthCalledWith(2, actor, expect.objectContaining({
      dryRun: false,
      previewDigest: "approved-digest",
      rootMetadataGuard: {
        key: "workplacePriorityDraft",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        authorityId,
      },
    }));
  });

  it("applies an incomplete choice against an already partial plan instead of leaving a UI-only draft", async () => {
    const previewPartial = vi.fn()
      .mockResolvedValueOnce({ dryRun: true, previewDigest: "partial-digest" })
      .mockResolvedValueOnce({ dryRun: false, previewDigest: "partial-digest" });
    const current = { "601": null, "602": "21", "603": "22" } satisfies DispatchPriorityPlan;
    const target = signedPriorityDraft({ "601": null, "602": "20", "603": "22" }, 8);

    await startDraftRoutingOperation(
      actor,
      { revision: 8, currentPlan: current },
      target,
      { previewPartialApply: previewPartial as never },
      true,
    );

    expect(previewPartial).toHaveBeenNthCalledWith(1, actor, expect.objectContaining({
      baseRevision: 8,
      fallback: { queue: "603", extension: "22" },
      dryRun: true,
      rootMetadataGuard: {
        key: "workplacePriorityDraft",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        authorityId,
      },
    }));
    expect(previewPartial).toHaveBeenNthCalledWith(2, actor, expect.objectContaining({
      previewDigest: "partial-digest",
      dryRun: false,
      rootMetadataGuard: {
        key: "workplacePriorityDraft",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        authorityId,
      },
    }));
  });

  it("adds a second operator to a single-operator plan through the provider-confirmed partial flow", async () => {
    const previewPartial = vi.fn()
      .mockResolvedValueOnce({ dryRun: true, previewDigest: "second-operator-digest" })
      .mockResolvedValueOnce({ dryRun: false, previewDigest: "second-operator-digest" });
    const current = { "601": "20", "602": null, "603": null } satisfies DispatchPriorityPlan;
    const target = signedPriorityDraft({ "601": "20", "602": "21", "603": null }, 1);

    await startDraftRoutingOperation(
      actor,
      { revision: 1, currentPlan: current },
      target,
      { previewPartialApply: previewPartial as never },
      true,
    );

    expect(previewPartial).toHaveBeenCalledTimes(2);
    expect(previewPartial).toHaveBeenNthCalledWith(1, actor, expect.objectContaining({
      baseRevision: 1,
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: "21" },
        { queue: "603", extension: null },
      ],
      fallback: { queue: "601", extension: "20" },
      dryRun: true,
    }));
    expect(previewPartial).toHaveBeenNthCalledWith(2, actor, expect.objectContaining({
      previewDigest: "second-operator-digest",
      dryRun: false,
    }));
  });

  it("adds a third operator to a two-operator plan through the complete provider flow", async () => {
    const previewApply = vi.fn()
      .mockResolvedValueOnce({ dryRun: true, previewDigest: "third-operator-digest" })
      .mockResolvedValueOnce({ dryRun: false, previewDigest: "third-operator-digest" });
    const current = { "601": "20", "602": "21", "603": null } satisfies DispatchPriorityPlan;
    const target = signedPriorityDraft({ "601": "20", "602": "21", "603": "22" }, 2);

    await startDraftRoutingOperation(
      actor,
      { revision: 2, currentPlan: current },
      target,
      { previewApply: previewApply as never },
    );

    expect(previewApply).toHaveBeenCalledTimes(2);
    expect(previewApply).toHaveBeenNthCalledWith(1, actor, expect.objectContaining({
      baseRevision: 2,
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: "21" },
        { queue: "603", extension: "22" },
      ],
      fallback: { queue: "602", extension: "21" },
      dryRun: true,
    }));
    expect(previewApply).toHaveBeenNthCalledWith(2, actor, expect.objectContaining({
      previewDigest: "third-operator-digest",
      dryRun: false,
    }));
  });

  it("rejects a malformed draft instead of trusting incomplete metadata", () => {
    expect(() => readWorkplacePriorityDraft({
      workplacePriorityDraft: {
        schemaVersion: 1,
        baseRevision: 0,
        selections: { "601": "20", "602": null },
        selectedBy: { "601": "profile-20", "602": null },
        updatedAt: "2026-08-05T12:00:00.000Z",
      },
    })).toThrow("presne priority 601, 602 a 603");

    expect(() => readWorkplacePriorityDraft({
      workplacePriorityDraft: {
        schemaVersion: 1,
        baseRevision: 0,
        selections: { "601": "20", "602": "20", "603": null },
        selectedBy: { "601": "profile-20", "602": "profile-20", "603": null },
        updatedAt: "2026-08-05T12:00:00.000Z",
      },
    })).toThrow("duplicitné pracovné miesto");
  });
});

function priorityDraft(plan: DispatchPriorityPlan, baseRevision = 0): WorkplacePriorityDraft {
  return {
    schemaVersion: 1,
    baseRevision,
    selections: { ...plan },
    selectedBy: {
      "601": plan["601"] ? owners.get(plan["601"] as string) ?? null : null,
      "602": plan["602"] ? owners.get(plan["602"] as string) ?? null : null,
      "603": plan["603"] ? owners.get(plan["603"] as string) ?? null : null,
    },
    updatedAt: "2026-08-05T12:00:00.000Z",
  };
}

function signedPriorityDraft(plan: DispatchPriorityPlan, baseRevision: number): WorkplacePriorityDraft {
  return authorizeWorkplacePriorityDraft(
    priorityDraft(plan, baseRevision),
    { organizationId: actor.organizationId, rootQueueId: "queue-601" },
    authorityId,
    authorityEnv,
  ).draft;
}

function authorizedPriorityDraft(plan: DispatchPriorityPlan, baseRevision: number, auditId: string) {
  return authorizeWorkplacePriorityDraft(
    priorityDraft(plan, baseRevision),
    { organizationId: actor.organizationId, rootQueueId: "queue-601" },
    auditId,
    authorityEnv,
  );
}

function workplaceDraftAuditRow(
  authorized: ReturnType<typeof authorizedPriorityDraft>,
  auditId: string,
) {
  return {
    id: auditId,
    action: "telephony.workplace.priority.draft",
    entity_id: "queue-601",
    after_payload: authorized.auditPayload,
    created_at: "2026-08-05T12:00:01.000Z",
  };
}

function workplaceClient(input: {
  auditRow?: ReturnType<typeof workplaceDraftAuditRow>;
  draft?: WorkplacePriorityDraft;
  extensionRows?: LoadedWorkplaceState["extensions"];
  leaseProbe?: boolean;
  routing: DispatchRoutingState;
}) {
  return sequentialClient([
    ...(input.leaseProbe ? [legacyLeaseProbeResult()] : []),
    ...workplaceStateQueryResults(input),
  ]);
}

function legacyLeaseProbeResult() {
  return queryResult({
    data: null,
    error: {
      code: "PGRST204",
      message: "Could not find the 'workplace_seat_generation' column in the schema cache",
    },
  });
}

function workplaceStateQueryResults(input: {
  auditRow?: ReturnType<typeof workplaceDraftAuditRow>;
  draft?: WorkplacePriorityDraft;
  extensionRows?: LoadedWorkplaceState["extensions"];
  routing: DispatchRoutingState;
}) {
  const extensions = queryResult({
    data: input.extensionRows ?? ["20", "21", "22", "23"].map((extension) => ({
      id: `extension-${extension}`,
      extension,
      profile_id: owners.get(extension) ?? null,
      is_registered: false,
    })),
    error: null,
  });
  const queues = queryResult({
    data: ["601", "602", "603"].map((queue) => ({
      id: `queue-${queue}`,
      external_id: queue,
      metadata: queue === "601"
        ? {
            dispatchRouting: input.routing,
            ...(input.draft ? { workplacePriorityDraft: input.draft } : {}),
          }
        : {},
      updated_at: "2026-08-05T12:00:00.000Z",
    })),
    error: null,
  });
  const profiles = queryResult({
    data: [...owners.values()].map((profileId) => ({ id: profileId, display_name: profileId })),
    error: null,
  });
  return [
    extensions,
    queues,
    profiles,
    ...(input.auditRow ? [queryResult({ data: [input.auditRow], error: null })] : []),
  ];
}

function ownedExtensionResolver(extension = "20") {
  return vi.fn(async () => ({
    id: `extension-${extension}`,
    extension,
    display_name: null,
    is_registered: false,
    last_synced_at: "2026-08-05T12:00:00.000Z",
  }));
}

function sequentialClient(results: Array<ReturnType<typeof queryResult>>) {
  let index = 0;
  return {
    from: vi.fn(() => {
      const result = results[index++];
      if (!result) throw new Error(`Unexpected database query at index ${index - 1}.`);
      return result.query;
    }),
    queryResults: results,
  };
}

function queryResult(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const query = new Proxy<Record<string, unknown>>({}, {
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
  });
  return { calls, query };
}

function loadedState(input: {
  routing: DispatchRoutingState;
  draft?: WorkplacePriorityDraft;
}): LoadedWorkplaceState {
  return {
    root: { id: "queue-601", external_id: "601", metadata: {}, updated_at: "2026-08-05T12:00:00.000Z" },
    routing: input.routing,
    draft: input.draft,
    extensions: ["20", "21", "22", "23"].map((extension) => ({
      id: `extension-${extension}`,
      extension,
      profile_id: owners.get(extension) ?? null,
      is_registered: true,
      metadata: {},
    })),
    ownerByExtension: owners,
    profileNames: new Map([
      ["profile-20", "Michal"],
      ["profile-21", "Mango"],
      ["profile-22", "Matej"],
      ["profile-23", "Natália"],
    ]),
  };
}

const priorityRecoveryOperationId = "99999999-9999-4999-8999-999999999999";
const priorityRecoveryExtensionId = "88888888-8888-4888-8888-888888888888";

function priorityRecoveryFence() {
  return {
    assignmentGeneration: "11111111-1111-4111-8111-111111111111",
    browserInstanceId: "22222222-2222-4222-8222-222222222222",
    leaderEpoch: 1,
    leaseId: "33333333-3333-4333-8333-333333333333",
    leaseVersion: 1,
  };
}

function selfServicePriorityRecoveryState(input: {
  commandStatus?: "confirmed_by_event" | "failed";
  deliveryUncertain?: boolean;
} = {}): LoadedWorkplaceState {
  const commandId = "44444444-4444-4444-8444-444444444444";
  const operation: DispatchRoutingOperation = {
    operationId: priorityRecoveryOperationId,
    status: "applying",
    baseRevision: 1,
    targetRevision: 2,
    previousPlan: { "601": "20", "602": null, "603": null },
    targetPlan: { "601": "20", "602": null, "603": null },
    steps: [{
      stepIndex: 0,
      commandId,
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
      commandType: "queue.add",
      action: "add",
      queue: "601",
      queueId: "queue-601",
      extension: "20",
      extensionId: priorityRecoveryExtensionId,
      status: "pending",
    }],
    currentStep: 0,
    fallback: {
      queue: "601",
      extension: "20",
      queueId: "queue-601",
      extensionId: priorityRecoveryExtensionId,
    },
    affectedExtensions: ["20"],
    assignmentGuards: [{
      claimId: "66666666-6666-4666-8666-666666666666",
      extension: "20",
      extensionId: priorityRecoveryExtensionId,
      generation: priorityRecoveryFence().assignmentGeneration,
      lifecycleEpoch: priorityRecoveryFence().assignmentGeneration,
      profileId: actor.profileId,
      routingOperationId: priorityRecoveryOperationId,
      workplaceSeatGeneration: "77777777-7777-4777-8777-777777777777",
    }],
    rootMetadataGuard: {
      key: "workplacePriorityDraft",
      digest: "a".repeat(64),
      authorityId,
    },
    actorProfileId: actor.profileId,
    createdAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:01:00.000Z",
  };
  const state = loadedState({
    routing: {
      revision: 1,
      currentPlan: { "601": "20", "602": null, "603": null },
      operation,
    },
  });
  state.extensions = state.extensions.map((extension) => extension.extension === "20"
    ? { ...extension, id: priorityRecoveryExtensionId }
    : extension);
  state.leases = new Map([[priorityRecoveryExtensionId, {
    id: priorityRecoveryFence().leaseId,
    organizationId: actor.organizationId,
    extensionId: priorityRecoveryExtensionId,
    profileId: actor.profileId,
    assignmentGeneration: priorityRecoveryFence().assignmentGeneration,
    browserInstanceId: priorityRecoveryFence().browserInstanceId,
    leaseVersion: 1,
    leaderEpoch: 1,
    resumeSecretHash: "a".repeat(64),
    resumeRequestedAt: null,
    heartbeatSuspendedAt: null,
    heartbeatSuspensionOperationId: null,
    state: "active",
    claimedAt: "2026-08-05T12:00:00.000Z",
    heartbeatAt: "2026-08-05T12:01:45.000Z",
    expiresAt: "2026-08-05T12:03:45.000Z",
    endedAt: null,
    endedReason: null,
    revokedBy: null,
  }]]);
  state.databaseNow = "2026-08-05T12:02:00.000Z";
  const commandStatus = input.commandStatus ?? "failed";
  state.currentRoutingCommand = {
    id: commandId,
    status: commandStatus,
    command_type: "queue.add",
    request_payload: {
      routingOperation: { operationId: priorityRecoveryOperationId, stepIndex: 0 },
    },
    provider_response: commandStatus === "failed"
      ? {
          error: "VIPTel listener odmietol príkaz.",
          deliveryUncertain: input.deliveryUncertain === true,
        }
      : {
          confirmation: {
            eventFingerprint: "provider-event-already-consumed",
            eventType: "queue.add",
            receivedAt: "2026-08-05T12:01:30.000Z",
          },
        },
  };
  return state;
}

function canonicalFreePriorityState(): LoadedWorkplaceState {
  const state = loadedState({
    routing: { revision: 1, currentPlan: { "601": "20", "602": "21", "603": null } },
  });
  const seatId = "11111111-1111-4111-8111-111111111121";
  state.extensions = state.extensions.map((extension) => extension.extension === "21"
    ? {
        ...extension,
        id: seatId,
        profile_id: null,
        is_registered: false,
        workplace_seat_generation: "22222222-2222-4222-8222-222222222221",
        metadata: {
          assignmentLifecycle: {
            schemaVersion: 1,
            epoch: "33333333-3333-4333-8333-333333333321",
            state: "unassigned",
            extensionId: seatId,
            extension: "21",
            profileId: null,
            assignmentMode: "workplace_claim",
            assignedAt: "2026-08-05T10:00:00.000Z",
            assignedBy: "44444444-4444-4444-8444-444444444421",
            unassignedAt: "2026-08-05T11:00:00.000Z",
            unassignedBy: "44444444-4444-4444-8444-444444444421",
          },
        },
      }
    : extension);
  state.ownerByExtension = new Map(state.ownerByExtension);
  state.ownerByExtension.delete("21");
  state.leases = new Map();
  return state;
}

function canonicalExpiredOccupiedState(registered: boolean | null): LoadedWorkplaceState {
  const state = loadedState({
    routing: { revision: 1, currentPlan: { "601": "20", "602": "21", "603": null } },
  });
  const extensionId = "11111111-1111-4111-8111-111111111121";
  const ownerId = "22222222-2222-4222-8222-222222222221";
  const generation = "33333333-3333-4333-8333-333333333321";
  state.extensions = state.extensions.map((extension) => extension.extension === "21"
    ? {
        ...extension,
        id: extensionId,
        profile_id: ownerId,
        is_registered: registered,
        workplace_seat_generation: "44444444-4444-4444-8444-444444444421",
        metadata: {
          assignmentLifecycle: {
            schemaVersion: 1,
            epoch: generation,
            state: "assigned",
            extensionId,
            extension: "21",
            profileId: ownerId,
            assignmentMode: "workplace_claim",
            assignedAt: "2026-08-05T11:00:00.000Z",
            assignedBy: ownerId,
          },
        },
      }
    : extension);
  state.ownerByExtension = new Map(state.ownerByExtension);
  state.ownerByExtension.set("21", ownerId);
  state.profileNames = new Map(state.profileNames);
  state.profileNames.set(ownerId, "Offline operátor");
  state.leases = new Map([[extensionId, {
    id: "55555555-5555-4555-8555-555555555521",
    organizationId: "66666666-6666-4666-8666-666666666621",
    extensionId,
    profileId: ownerId,
    assignmentGeneration: generation,
    browserInstanceId: "77777777-7777-4777-8777-777777777721",
    leaseVersion: 1,
    leaderEpoch: 1,
    resumeSecretHash: "a".repeat(64),
    resumeRequestedAt: null,
    heartbeatSuspendedAt: null,
    heartbeatSuspensionOperationId: null,
    state: "active",
    claimedAt: "2026-08-05T11:00:00.000Z",
    heartbeatAt: "2026-08-05T12:00:00.000Z",
    expiresAt: "2026-08-05T12:01:00.000Z",
    endedAt: null,
    endedReason: null,
    revokedBy: null,
  }]]);
  return state;
}

function adminManagementState(validLifecycle: boolean) {
  const profileId = "11111111-1111-4111-8111-111111111111";
  const ownerId = "22222222-2222-4222-8222-222222222222";
  const extensionId = "33333333-3333-4333-8333-333333333333";
  const admin: MotoristActor = {
    userId: "44444444-4444-4444-8444-444444444444",
    profileId,
    organizationId: "55555555-5555-4555-8555-555555555555",
    displayName: "Tester admin",
    role: "admin",
  };
  const extensions: LoadedWorkplaceState["extensions"] = ["20", "21", "22", "23"].map((extension) => ({
    id: extension === "21" ? extensionId : `extension-${extension}`,
    extension,
    profile_id: extension === "21" ? ownerId : null,
    is_registered: false,
    metadata: extension === "21" && validLifecycle
      ? {
          assignmentLifecycle: {
            schemaVersion: 1,
            epoch: "66666666-6666-4666-8666-666666666666",
            state: "assigned",
            extensionId,
            extension: "21",
            profileId: ownerId,
            assignmentMode: "workplace_claim",
            assignedAt: "2026-08-05T11:00:00.000Z",
            assignedBy: ownerId,
          },
        }
      : {},
  }));
  const state: LoadedWorkplaceState = {
    root: { id: "queue-601", external_id: "601", metadata: {}, updated_at: "root-v1" },
    routing: { revision: 1, currentPlan: { "601": "21", "602": null, "603": null } },
    extensions,
    ownerByExtension: new Map([["21", ownerId]]),
    profileNames: new Map([[ownerId, "Mango Mango"]]),
  };
  return { admin, state };
}
