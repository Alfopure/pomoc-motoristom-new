import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkplaceDocumentLeader,
  classifyWorkplaceMutationResponse,
  classifyWorkplacePresenceResponse,
  clearWorkplacePendingMutation,
  clearWorkplacePendingResume,
  clearWorkplaceResumeCredential,
  normalizeWorkplaceLease,
  readWorkplacePendingMutation,
  readWorkplacePendingResume,
  readWorkplaceResumeCredential,
  startWorkplaceHeartbeatLoop,
  storeWorkplacePendingMutation,
  storeWorkplacePendingResume,
  storeWorkplaceResumeCredential,
  type WorkplaceDocumentLeaderRuntime,
} from "./workplace-lease-client";

describe("workplace lease client", () => {
  afterEach(() => {
    clearWorkplacePendingMutation();
    clearWorkplacePendingResume();
    clearWorkplaceResumeCredential("lease-storage-denied");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("normalizes the canonical lease and accepts generation during a compatibility rollout", () => {
    expect(normalizeWorkplaceLease({
      assignmentGeneration: "generation-1",
      extension: "20",
      expiresAt: "2026-08-07T12:00:00.000Z",
      heartbeatIntervalMs: 15_000,
      leaderEpoch: 3,
      leaseId: "lease-20",
      leaseVersion: 4,
      seatId: "seat-20",
    })).toEqual({
      assignmentGeneration: "generation-1",
      extension: "20",
      expiresAt: "2026-08-07T12:00:00.000Z",
      heartbeatIntervalMs: 15_000,
      leaderEpoch: 3,
      leaseId: "lease-20",
      leaseVersion: 4,
      seatId: "seat-20",
    });

    expect(normalizeWorkplaceLease({
      generation: "legacy-generation",
      extension: "23",
      expiresAt: "2026-08-07T12:00:00.000Z",
      leaseId: "lease-23",
    })).toMatchObject({
      assignmentGeneration: "legacy-generation",
      extension: "23",
      heartbeatIntervalMs: 15_000,
      leaderEpoch: 0,
      leaseVersion: 1,
      seatId: "23",
    });
  });

  it("fails closed for malformed leases", () => {
    expect(normalizeWorkplaceLease(null)).toBeNull();
    expect(normalizeWorkplaceLease({ extension: "20", leaseId: "lease-20" })).toBeNull();
    expect(normalizeWorkplaceLease({
      assignmentGeneration: "generation-1",
      extension: "",
      expiresAt: "2026-08-07T12:00:00.000Z",
      leaseId: "lease-20",
    })).toBeNull();
  });

  it("distinguishes a retryable transition from terminal lease loss", () => {
    expect(classifyWorkplacePresenceResponse(423, {
      code: "lease_transitioning",
      error: "Presun sa dokončuje.",
    })).toEqual({ kind: "transitioning", message: "Presun sa dokončuje." });

    expect(classifyWorkplacePresenceResponse(410, {
      code: "lease_lost",
      error: "Miesto prevzal kolega.",
    })).toEqual({ kind: "lease_lost", message: "Miesto prevzal kolega." });

    expect(classifyWorkplacePresenceResponse(503, { error: "Krátky výpadok" })).toEqual({
      kind: "retryable",
      message: "Krátky výpadok",
    });
  });

  it("never treats a deterministic lease loss or known 409 as a lost response", () => {
    expect(classifyWorkplaceMutationResponse(409, {
      ok: false,
      code: "lease_lost",
      error: "Relácia patrí inému oknu.",
    })).toEqual({
      kind: "terminal",
      code: "lease_lost",
      message: "Relácia patrí inému oknu.",
    });
    expect(classifyWorkplaceMutationResponse(409, {
      ok: false,
      code: "workplace_precommit_aborted",
      error: "Zmena bola zrušená.",
    })).toMatchObject({ kind: "terminal", code: "workplace_precommit_aborted" });
  });

  it("treats a definite abort or snapshot refusal as terminal even on a 5xx", () => {
    // The leave that aborted on a VIPTel snapshot timeout answered 504. By
    // status alone that classified as a possibly-committed lost response, so
    // the client armed the exact-replay journal for a request the server had
    // already rolled back -- and every other workplace action was refused
    // while it spun. The operator could neither leave nor go available.
    expect(classifyWorkplaceMutationResponse(504, {
      ok: false,
      code: "provider_snapshot_unavailable",
      error: "Hetzner listener nevrátil VIPTel snapshot v bezpečnom časovom limite.",
    })).toMatchObject({ kind: "terminal", code: "provider_snapshot_unavailable" });
    expect(classifyWorkplaceMutationResponse(500, {
      ok: false,
      code: "workplace_precommit_aborted",
      error: "Zmena pracoviska sa bezpečne zrušila a pôvodný stav zostal zachovaný.",
    })).toMatchObject({ kind: "terminal", code: "workplace_precommit_aborted" });
    // A codeless 5xx stays ambiguous: the server may have committed before
    // failing, and only the exact-replay journal can find out safely.
    expect(classifyWorkplaceMutationResponse(504, {
      ok: false,
      error: "Odpoveď sa stratila.",
    })).toMatchObject({ kind: "transport_ambiguous" });
  });

  it("preserves exact replay only for genuinely ambiguous mutation responses", () => {
    expect(classifyWorkplaceMutationResponse(423, {
      ok: false,
      code: "workplace_source_unregister_pending",
      error: "VIPTel ešte dokončuje odpojenie.",
    })).toEqual({
      kind: "convergence_pending",
      code: "workplace_source_unregister_pending",
      message: "VIPTel ešte dokončuje odpojenie.",
    });
    expect(classifyWorkplaceMutationResponse(409, {
      ok: false,
      error: "Konflikt bez serverového kódu.",
    })).toMatchObject({ kind: "terminal", message: "Konflikt bez serverového kódu." });
    expect(classifyWorkplaceMutationResponse(503, {
      ok: false,
      error: "Server odpoveď nepotvrdil.",
    })).toMatchObject({ kind: "transport_ambiguous" });
    expect(classifyWorkplaceMutationResponse(503, {
      ok: false,
      code: "workplace_recovery_required",
      error: "Výsledok nemožno potvrdiť.",
    })).toMatchObject({ kind: "transport_ambiguous" });
    expect(classifyWorkplaceMutationResponse(200, { ok: true })).toEqual({ kind: "confirmed" });
  });

  it("lets only the document holding the Web Lock become leader", async () => {
    const leader = new WorkplaceDocumentLeader(
      { browserInstanceId: "browser-a", leaseId: "lease-20" },
      runtime({
        requestLock: async (_name, hold) => {
          void hold();
          return "acquired";
        },
      }),
    );
    const follower = new WorkplaceDocumentLeader(
      { browserInstanceId: "browser-b", leaseId: "lease-20" },
      runtime({ requestLock: async () => "unavailable" }),
    );
    const leaderStates: string[] = [];
    const followerStates: string[] = [];
    leader.subscribe((state) => leaderStates.push(state));
    follower.subscribe((state) => followerStates.push(state));

    leader.start();
    follower.start();
    await vi.waitFor(() => expect(leader.currentState).toBe("leader"));
    await vi.waitFor(() => expect(follower.currentState).toBe("follower"));

    expect(leaderStates).toContain("leader");
    expect(followerStates).not.toContain("leader");
    leader.stop();
    follower.stop();
  });

  it("broadcasts lease loss so a second document stays read-only", async () => {
    const channels = createChannelHub();
    const first = new WorkplaceDocumentLeader(
      { browserInstanceId: "browser-a", leaseId: "lease-20" },
      runtime({ createChannel: channels.createChannel, requestLock: async () => "unavailable" }),
    );
    const second = new WorkplaceDocumentLeader(
      { browserInstanceId: "browser-b", leaseId: "lease-20" },
      runtime({ createChannel: channels.createChannel, requestLock: async () => "unavailable" }),
    );

    first.start();
    second.start();
    await vi.waitFor(() => expect(second.currentState).toBe("follower"));
    first.announceLeaseLost();
    await vi.waitFor(() => expect(second.currentState).toBe("follower"));

    first.stop();
    second.stop();
  });

  it("udrží 15-sekundový heartbeat ohraničený aj keď každý pulz zmení lease verziu", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let leaseVersion = 1;
    const stop = startWorkplaceHeartbeatLoop({
      intervalMs: 15_000,
      pulse: () => {
        calls += 1;
        leaseVersion += 1;
      },
    });

    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(5);
    expect(leaseVersion).toBe(6);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(5);
  });

  it("uses a worker clock so a background tab keeps renewing its workplace lease", () => {
    const messages: unknown[] = [];
    let terminated = false;
    let fallbackScheduled = false;
    let calls = 0;
    const worker = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      postMessage: (message: unknown) => messages.push(message),
      terminate: () => {
        terminated = true;
      },
    };
    const stop = startWorkplaceHeartbeatLoop({
      intervalMs: 15_000,
      pulse: () => {
        calls += 1;
      },
      createWorker: () => worker,
      setInterval: () => {
        fallbackScheduled = true;
        return 1 as unknown as ReturnType<typeof globalThis.setInterval>;
      },
    });

    expect(messages).toEqual([{ intervalMs: 15_000, kind: "start" }]);
    expect(fallbackScheduled).toBe(false);
    worker.onmessage?.({ data: { kind: "pulse" } } as MessageEvent<unknown>);
    expect(calls).toBe(1);

    stop();
    expect(messages).toEqual([
      { intervalMs: 15_000, kind: "start" },
      { kind: "stop" },
    ]);
    expect(terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
  });

  it("keeps the current resume credential in memory when session storage denies the write", () => {
    const storage = memoryStorage({ throwOnSetPrefix: "motorist.workplace.resume.v1" });
    vi.stubGlobal("sessionStorage", storage);

    expect(storeWorkplaceResumeCredential(
      "lease-storage-denied",
      "browser-storage-denied",
      "resume-secret-storage-denied",
    )).toBe(false);
    expect(readWorkplaceResumeCredential("lease-storage-denied")).toEqual({
      browserInstanceId: "browser-storage-denied",
      leaseId: "lease-storage-denied",
      resumeSecret: "resume-secret-storage-denied",
    });
  });

  it("persists the exact pending selection request without changing its identity", () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const pending = {
      action: "confirm_seat_change" as const,
      actorProfileId: "profile-a",
      attempts: 2,
      browserDisconnectOutcome: "accepted" as const,
      browserInstanceId: "11111111-1111-4111-8111-111111111111",
      createdAt: Date.now(),
      expectedVersion: "seat-version-21",
      extension: "21",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      kind: "select" as const,
      operationId: "22222222-2222-4222-8222-222222222222",
      phase: "finalize" as const,
    };

    expect(storeWorkplacePendingMutation(pending)).toBe(true);
    expect(readWorkplacePendingMutation()).toEqual(pending);
  });

  it("persists the old resume fence and exact target before rotating the secret", () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const pending = {
      actorProfileId: "profile-a",
      assignmentGeneration: "33333333-3333-4333-8333-333333333333",
      attempts: 1,
      browserInstanceId: "44444444-4444-4444-8444-444444444444",
      createdAt: Date.now(),
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      leaderEpoch: 3,
      leaseId: "55555555-5555-4555-8555-555555555555",
      leaseVersion: 7,
      resumeSecret: "old-resume-secret-that-must-be-replayed",
    };

    expect(storeWorkplacePendingResume(pending)).toBe(true);
    expect(readWorkplacePendingResume()).toEqual(pending);
  });
});

function runtime(overrides: WorkplaceDocumentLeaderRuntime = {}): WorkplaceDocumentLeaderRuntime {
  return {
    createChannel: () => null,
    ...overrides,
  };
}

function createChannelHub() {
  const channels = new Set<{
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
  }>();
  return {
    createChannel: () => {
      const channel = {
        onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
        close: () => channels.delete(channel),
        postMessage: (message: unknown) => {
          for (const peer of channels) {
            if (peer !== channel) peer.onmessage?.({ data: message } as MessageEvent<unknown>);
          }
        },
      };
      channels.add(channel);
      return channel;
    },
  };
}

function memoryStorage(options: { throwOnSetPrefix?: string } = {}): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      if (options.throwOnSetPrefix && key.startsWith(options.throwOnSetPrefix)) {
        throw new DOMException("Storage denied", "SecurityError");
      }
      values.set(key, value);
    },
  };
}
