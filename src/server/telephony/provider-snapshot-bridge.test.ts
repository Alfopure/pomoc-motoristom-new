import { afterEach, describe, expect, it, vi } from "vitest";

import type { Json } from "@/lib/supabase/database.types";
import { MutationError } from "@/server/motorist-mutations";
import {
  captureViptelProviderSnapshot,
  parseViptelProviderSnapshotWire,
  readLatestConfirmedViptelProviderSnapshot,
  requestViptelProviderSnapshot,
  requirePersonalExtensionInSnapshot,
  signViptelProviderSnapshotResponse,
  type ViptelProviderSnapshotWire,
  viptelProviderSnapshotBridgeGateStatus,
} from "./provider-snapshot-bridge";

const ORGANIZATION_A = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_B = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const COMMAND = "44444444-4444-4444-8444-444444444444";
const FRESH_COMMAND = "55555555-5555-4555-8555-555555555555";
const ENABLED_ENV = {
  VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED: "true",
  VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN: "snapshot-authority-token-at-least-32-characters",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("VIPTel provider snapshot bridge", () => {
  it("timestamps a provider snapshot only after every VIPTel read has completed", async () => {
    vi.stubEnv("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED", "true");
    vi.stubEnv("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN", ENABLED_ENV.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN);
    vi.stubEnv("VIPTEL_PERSONAL_EXTENSIONS", "20,21,22,23");
    vi.stubEnv("VERCEL_ENV", "production");
    const wire = validWire();
    const extensionRead = deferred<typeof wire.extensions>();
    const activeCallRead = deferred<typeof wire.activeCalls>();
    const queueReads = new Map(wire.queueStatuses.map((status) => [status.queue, deferred<typeof status>()]));
    const clock = vi.fn(() => new Date("2026-08-05T12:00:03.250Z"));

    const capture = captureViptelProviderSnapshot({
      listExtensions: () => extensionRead.promise as never,
      listActiveCalls: () => activeCallRead.promise as never,
      getQueueStatus: (queue) => queueReads.get(queue)!.promise as never,
    }, clock);

    expect(clock).not.toHaveBeenCalled();
    extensionRead.resolve(wire.extensions);
    activeCallRead.resolve(wire.activeCalls);
    for (const [queue, read] of queueReads) read.resolve(wire.queueStatuses.find((status) => status.queue === queue)!);

    await expect(capture).resolves.toMatchObject({ capturedAt: "2026-08-05T12:00:03.250Z" });
    expect(clock).toHaveBeenCalledOnce();
  });

  it("has a separate authority gate and always blocks Vercel Preview", () => {
    expect(viptelProviderSnapshotBridgeGateStatus(ENABLED_ENV)).toEqual({ enabled: true, reason: "enabled" });
    expect(viptelProviderSnapshotBridgeGateStatus({
      ...ENABLED_ENV,
      VIPTEL_LIVE_MUTATIONS_ENABLED: "false",
    })).toEqual({ enabled: true, reason: "enabled" });
    expect(viptelProviderSnapshotBridgeGateStatus({ ...ENABLED_ENV, VERCEL_ENV: "preview" })).toEqual({
      enabled: false,
      reason: "preview_blocked",
    });
  });

  it("returns only a fresh confirmed listener payload and scopes the read to one organization", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const harness = sequencedClient([confirmedRow(validWire(now.toISOString()))]);

    const snapshot = await requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => now,
      maxAgeMs: 2_000,
    });

    expect(snapshot.capturedAt).toBe(now.toISOString());
    expect(snapshot.extensions.every((extension) => Object.keys(extension.raw).length === 0)).toBe(true);
    expect(harness.filters).toContainEqual(["eq", "organization_id", ORGANIZATION_A]);
    expect(harness.filters).not.toContainEqual(["eq", "organization_id", ORGANIZATION_B]);
  });

  it("reads a fresh signed snapshot without inserting or waiting for a provider command", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const harness = sequencedClient([confirmedRow(validWire("2026-08-05T11:59:45.000Z"))]);

    const snapshot = await readLatestConfirmedViptelProviderSnapshot(ORGANIZATION_A, {
      client: harness.client as never,
      env: ENABLED_ENV,
      maxAgeMs: 30_000,
      now: () => now,
    });

    expect(snapshot?.capturedAt).toBe("2026-08-05T11:59:45.000Z");
    expect(harness.client.from).toHaveBeenCalledOnce();
    expect(harness.inserts).toHaveLength(0);
    expect(harness.updates).toHaveLength(0);
    expect(harness.filters).toContainEqual(["eq", "organization_id", ORGANIZATION_A]);
    expect(harness.filters).toContainEqual(["eq", "status", "confirmed_by_event"]);
  });

  it("returns no cached snapshot when none exists, it is too old, or Preview isolation is active", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const absent = sequencedClient([null]);
    const stale = sequencedClient([confirmedRow(validWire("2026-08-05T11:59:29.999Z"))]);
    const preview = sequencedClient([confirmedRow(validWire(now.toISOString()))]);

    await expect(readLatestConfirmedViptelProviderSnapshot(ORGANIZATION_A, {
      client: absent.client as never,
      env: ENABLED_ENV,
      maxAgeMs: 30_000,
      now: () => now,
    })).resolves.toBeNull();
    await expect(readLatestConfirmedViptelProviderSnapshot(ORGANIZATION_A, {
      client: stale.client as never,
      env: ENABLED_ENV,
      maxAgeMs: 30_000,
      now: () => now,
    })).resolves.toBeNull();
    await expect(readLatestConfirmedViptelProviderSnapshot(ORGANIZATION_A, {
      client: preview.client as never,
      env: { ...ENABLED_ENV, VERCEL_ENV: "preview" },
      maxAgeMs: 30_000,
      now: () => now,
    })).resolves.toBeNull();

    expect(absent.inserts).toHaveLength(0);
    expect(stale.inserts).toHaveLength(0);
    expect(preview.client.from).not.toHaveBeenCalled();
  });

  it("rejects an unbounded read-only cache age before accessing storage", async () => {
    const harness = sequencedClient([confirmedRow(validWire())]);

    await expect(readLatestConfirmedViptelProviderSnapshot(ORGANIZATION_A, {
      client: harness.client as never,
      env: ENABLED_ENV,
      maxAgeMs: 30_001,
    })).rejects.toMatchObject({ status: 500 });

    expect(harness.client.from).not.toHaveBeenCalled();
    expect(harness.inserts).toHaveLength(0);
  });

  it("fails closed when the read-only cached snapshot has the wrong authority or a future capture time", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const wrongOrganization = sequencedClient([
      confirmedRow(validWire(now.toISOString()), ORGANIZATION_B),
    ]);
    const tamperedRow = confirmedRow(validWire(now.toISOString()));
    (tamperedRow.provider_response.snapshot as ViptelProviderSnapshotWire).extensions[0].name = "Tampered";
    const tampered = sequencedClient([tamperedRow]);
    const future = sequencedClient([
      confirmedRow(validWire("2026-08-05T12:00:06.000Z")),
    ]);

    for (const harness of [wrongOrganization, tampered, future]) {
      await expect(readLatestConfirmedViptelProviderSnapshot(ORGANIZATION_A, {
        client: harness.client as never,
        env: ENABLED_ENV,
        maxAgeMs: 30_000,
        now: () => now,
      })).rejects.toMatchObject({ status: 502 });
      expect(harness.inserts).toHaveLength(0);
    }
  });

  it("rejects a response signed for another organization or changed after listener confirmation", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const otherOrganization = confirmedRow(validWire(now.toISOString()), ORGANIZATION_B);
    await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: sequencedClient([otherOrganization]).client as never,
      env: ENABLED_ENV,
      now: () => now,
    })).rejects.toMatchObject({ status: 502 });

    const tampered = confirmedRow(validWire(now.toISOString()));
    (tampered.provider_response.snapshot as ViptelProviderSnapshotWire).extensions[0].name = "Tampered";
    await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: sequencedClient([tampered]).client as never,
      env: ENABLED_ENV,
      now: () => now,
    })).rejects.toMatchObject({ status: 502 });
  });

  it("rejects a future confirmed snapshot", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const harness = sequencedClient([confirmedRow(validWire("2026-08-05T12:00:06.000Z"))]);

    await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => now,
    })).rejects.toMatchObject({ status: 502 });
  });

  it("does not return a stale cache and accepts only a newly confirmed pending command", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const pending = queuedRow("sent");
    const harness = sequencedClient([
      confirmedRow(validWire("2026-08-05T11:59:30.000Z")),
      pending,
      confirmedRow(validWire(now.toISOString())),
    ]);

    const snapshot = await requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => now,
      sleep: async () => undefined,
      maxAgeMs: 2_000,
    });
    expect(snapshot.capturedAt).toBe(now.toISOString());
  });

  it("accepts the exact bounded pre-read timestamp emitted by the legacy listener", async () => {
    const capturedAt = "2026-08-05T12:00:00.000Z";
    const confirmedAt = "2026-08-05T12:00:02.250Z";
    const now = new Date("2026-08-05T12:00:03.000Z");
    const row = confirmedRow(validWire(capturedAt));
    row.sent_at = "2026-08-05T12:00:00+00:00";
    row.confirmed_at = "2026-08-05T12:00:02.250+00:00";
    row.provider_response.confirmedAt = confirmedAt;
    const harness = sequencedClient([
      queuedRow("sent"),
      row,
    ]);

    await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => now,
      sleep: async () => undefined,
      maxAgeMs: 2_000,
      requireNewCapture: true,
    })).resolves.toMatchObject({ capturedAt });
  });

  it("keeps legacy pre-read compatibility bounded and exact", async () => {
    const capturedAt = "2026-08-05T12:00:00.000Z";
    const overlong = confirmedRow(validWire(capturedAt));
    overlong.sent_at = capturedAt;
    overlong.confirmed_at = "2026-08-05T12:00:08.001Z";
    overlong.provider_response.confirmedAt = overlong.confirmed_at;
    const mismatched = confirmedRow(validWire(capturedAt));
    mismatched.sent_at = "2026-08-05T12:00:00.001Z";
    mismatched.confirmed_at = "2026-08-05T12:00:02.250Z";
    mismatched.provider_response.confirmedAt = mismatched.confirmed_at;
    const confirmationMismatch = confirmedRow(validWire(capturedAt));
    confirmationMismatch.sent_at = capturedAt;
    confirmationMismatch.confirmed_at = "2026-08-05T12:00:02.250Z";
    confirmationMismatch.provider_response.confirmedAt = "2026-08-05T12:00:02.249Z";

    for (const [row, now] of [
      [overlong, new Date("2026-08-05T12:00:09.000Z")],
      [mismatched, new Date("2026-08-05T12:00:03.000Z")],
      [confirmationMismatch, new Date("2026-08-05T12:00:03.000Z")],
    ] as const) {
      const harness = sequencedClient([
        queuedRow("sent"),
        row,
      ]);
      await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
        client: harness.client as never,
        env: ENABLED_ENV,
        now: () => now,
        sleep: async () => undefined,
        waitMs: 1_000,
        maxAgeMs: 2_000,
        requireNewCapture: true,
      })).rejects.toMatchObject({ status: 502 });
    }
  });

  it("never applies legacy completion freshness to the read-only cache", async () => {
    const capturedAt = "2026-08-05T12:00:00.000Z";
    const confirmedAt = "2026-08-05T12:00:02.250Z";
    const row = confirmedRow(validWire(capturedAt));
    row.sent_at = capturedAt;
    row.confirmed_at = confirmedAt;
    row.provider_response.confirmedAt = confirmedAt;
    const harness = sequencedClient([row]);

    await expect(readLatestConfirmedViptelProviderSnapshot(ORGANIZATION_A, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => new Date("2026-08-05T12:00:03.000Z"),
      maxAgeMs: 2_000,
    })).resolves.toBeNull();
  });

  it("rejects a legacy listener response confirmed after its signed deadline", async () => {
    const capturedAt = "2026-08-05T12:00:08.000Z";
    const confirmedAt = "2026-08-05T12:00:15.001Z";
    const row = confirmedRow(validWire(capturedAt));
    row.sent_at = capturedAt;
    row.confirmed_at = confirmedAt;
    row.provider_response.confirmedAt = confirmedAt;
    const harness = sequencedClient([
      queuedRow("sent"),
      row,
    ]);
    let clockReads = 0;

    await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => new Date(clockReads++ === 0 ? capturedAt : "2026-08-05T12:00:15.500Z"),
      sleep: async () => undefined,
      maxAgeMs: 2_000,
      requireNewCapture: true,
    })).rejects.toMatchObject({ status: 502 });
  });

  it("requireNewCapture skips the confirmed cache and returns only an exact pending command", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const freshWire = validWire(now.toISOString());
    freshWire.extensions[0].name = "Fresh operator";
    const harness = sequencedClient([
      null,
      queuedRow("queued", FRESH_COMMAND),
      confirmedRow(freshWire, ORGANIZATION_A, FRESH_COMMAND),
    ]);

    const snapshot = await requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => now,
      sleep: async () => undefined,
      maxAgeMs: 2_000,
      randomId: () => FRESH_COMMAND,
      requireNewCapture: true,
    });

    expect(snapshot.extensions[0].name).toBe("Fresh operator");
    expect(harness.inserts).toHaveLength(1);
    expect(harness.filters).not.toContainEqual(["eq", "status", "confirmed_by_event"]);
    expect(harness.filters).toContainEqual(["eq", "id", FRESH_COMMAND]);
  });

  it.each(["queued", "sent"] as const)(
    "requireNewCapture shares a pre-existing signed %s request captured in its window",
    async (status) => {
      const now = new Date("2026-08-05T12:00:00.000Z");
      const pending = queuedRow(status);
      const harness = sequencedClient([
        pending,
        confirmedRow(validWire(now.toISOString())),
      ]);

      await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
        client: harness.client as never,
        env: ENABLED_ENV,
        sleep: async () => undefined,
        now: () => now,
        maxAgeMs: 2_000,
        randomId: () => FRESH_COMMAND,
        requireNewCapture: true,
      })).resolves.toMatchObject({ capturedAt: now.toISOString() });

      expect(harness.inserts).toHaveLength(0);
      expect(harness.filters).not.toContainEqual(["eq", "status", "confirmed_by_event"]);
    },
  );

  it("requireNewCapture accepts its own bounded response captured after the request", async () => {
    const startedAt = Date.parse("2026-08-05T12:00:00.000Z");
    const capturedAt = new Date(startedAt + 500).toISOString();
    const readAt = startedAt + 1_000;
    let clockReads = 0;
    const harness = sequencedClient([
      null,
      queuedRow("queued", FRESH_COMMAND),
      confirmedRow(validWire(capturedAt), ORGANIZATION_A, FRESH_COMMAND),
    ]);

    const snapshot = await requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => new Date(clockReads++ === 0 ? startedAt : readAt),
      sleep: async () => undefined,
      maxAgeMs: 2_000,
      randomId: () => FRESH_COMMAND,
      requireNewCapture: true,
    });

    expect(snapshot.capturedAt).toBe(capturedAt);
  });

  it("strictly rejects a response older than maxAge even when it belongs to this request", async () => {
    const startedAt = Date.parse("2026-08-05T12:00:00.000Z");
    const capturedAt = new Date(startedAt + 2_500).toISOString();
    const readAt = startedAt + 5_000;
    let clockReads = 0;
    const harness = sequencedClient([
      null,
      queuedRow("queued", FRESH_COMMAND),
      confirmedRow(validWire(capturedAt), ORGANIZATION_A, FRESH_COMMAND),
    ]);

    await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => new Date(clockReads++ === 0 ? startedAt : readAt),
      sleep: async () => undefined,
      maxAgeMs: 2_000,
      randomId: () => FRESH_COMMAND,
      requireNewCapture: true,
    })).rejects.toMatchObject({ status: 502 });
  });

  it("rejects a response captured just before the request after it becomes stale", async () => {
    const startedAt = Date.parse("2026-08-05T12:00:00.000Z");
    const capturedAt = new Date(startedAt - 1_999).toISOString();
    const readAt = startedAt + 8_000;
    let clockReads = 0;
    const harness = sequencedClient([
      null,
      queuedRow("queued", FRESH_COMMAND),
      confirmedRow(validWire(capturedAt), ORGANIZATION_A, FRESH_COMMAND),
    ]);

    await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => new Date(clockReads++ === 0 ? startedAt : readAt),
      sleep: async () => undefined,
      maxAgeMs: 2_000,
      randomId: () => FRESH_COMMAND,
      requireNewCapture: true,
    })).rejects.toMatchObject({ status: 502 });
  });

  it("accepts exactly maxAge and rejects maxAge plus one millisecond", async () => {
    const startedAt = Date.parse("2026-08-05T12:00:00.000Z");
    for (const [age, expected] of [[2_000, "resolves"], [2_001, "rejects"]] as const) {
      let clockReads = 0;
      const capturedAt = new Date(startedAt + 500).toISOString();
      const harness = sequencedClient([
        null,
        queuedRow("queued", FRESH_COMMAND),
        confirmedRow(validWire(capturedAt), ORGANIZATION_A, FRESH_COMMAND),
      ]);
      const result = requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
        client: harness.client as never,
        env: ENABLED_ENV,
        now: () => new Date(clockReads++ === 0 ? startedAt : startedAt + 500 + age),
        sleep: async () => undefined,
        maxAgeMs: 2_000,
        randomId: () => FRESH_COMMAND,
        requireNewCapture: true,
      });
      if (expected === "resolves") await expect(result).resolves.toMatchObject({ capturedAt });
      else await expect(result).rejects.toMatchObject({ status: 502 });
    }
  });

  it("selects the oldest pending command deterministically for automatic readers", async () => {
    const now = new Date("2026-08-05T12:00:01.000Z");
    const older = queuedRow("sent", COMMAND);
    const harness = sequencedClient([
      null,
      older,
      confirmedRow(validWire(now.toISOString()), ORGANIZATION_A, COMMAND),
    ]);

    await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => now,
      sleep: async () => undefined,
      maxAgeMs: 2_000,
    })).resolves.toMatchObject({ capturedAt: now.toISOString() });

    expect(harness.inserts).toHaveLength(0);
    expect(harness.filters).toContainEqual(["eq", "id", COMMAND]);
    expect(harness.filters).toContainEqual(["order", "created_at", { ascending: true }]);
    expect(harness.filters).toContainEqual(["order", "id", { ascending: true }]);
    expect(harness.filters).toContainEqual(["limit", 1]);
  });

  it("selects the true newest pending command for an exact capture even with a larger backlog", async () => {
    const now = new Date("2026-08-05T12:00:01.000Z");
    const newer = queuedRow("sent", FRESH_COMMAND);
    const harness = sequencedClient([
      newer,
      confirmedRow(validWire(now.toISOString()), ORGANIZATION_A, FRESH_COMMAND),
    ]);

    await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => now,
      sleep: async () => undefined,
      maxAgeMs: 2_000,
      requireNewCapture: true,
    })).resolves.toMatchObject({ capturedAt: now.toISOString() });

    expect(harness.inserts).toHaveLength(0);
    expect(harness.filters).toContainEqual(["eq", "id", FRESH_COMMAND]);
    expect(harness.filters).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(harness.filters).toContainEqual(["order", "id", { ascending: false }]);
    expect(harness.filters).toContainEqual(["limit", 1]);
  });

  it("requireNewCapture follows an exact raced command and validates its capture window", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const raced = queuedRow("queued", COMMAND);
    const harness = sequencedClient([
      null,
      scriptedResult(null, { code: "23505", message: "duplicate key value violates unique constraint" }),
      raced,
      confirmedRow(validWire(now.toISOString()), ORGANIZATION_A, COMMAND),
    ]);

    await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      sleep: async () => undefined,
      now: () => now,
      maxAgeMs: 2_000,
      randomId: () => FRESH_COMMAND,
      requireNewCapture: true,
    })).resolves.toMatchObject({ capturedAt: now.toISOString() });

    expect(harness.inserts).toHaveLength(1);
    expect(harness.filters).toContainEqual(["eq", "idempotency_key", expect.any(String)]);
  });

  it("allows concurrent exact readers across an idempotency-bucket boundary without a multi-pending 409", async () => {
    const startedA = new Date("2026-08-05T12:00:01.999Z");
    const startedB = new Date("2026-08-05T12:00:02.001Z");
    const harnessA = sequencedClient([
      null,
      queuedRow("queued", COMMAND),
      confirmedRow(validWire(startedA.toISOString()), ORGANIZATION_A, COMMAND),
    ]);
    const harnessB = sequencedClient([
      null,
      queuedRow("queued", FRESH_COMMAND),
      confirmedRow(validWire(startedB.toISOString()), ORGANIZATION_A, FRESH_COMMAND),
    ]);

    const [snapshotA, snapshotB] = await Promise.all([
      requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
        client: harnessA.client as never,
        env: ENABLED_ENV,
        now: () => startedA,
        sleep: async () => undefined,
        maxAgeMs: 2_000,
        randomId: () => COMMAND,
        requireNewCapture: true,
      }),
      requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
        client: harnessB.client as never,
        env: ENABLED_ENV,
        now: () => startedB,
        sleep: async () => undefined,
        maxAgeMs: 2_000,
        randomId: () => FRESH_COMMAND,
        requireNewCapture: true,
      }),
    ]);

    expect(snapshotA.capturedAt).toBe(startedA.toISOString());
    expect(snapshotB.capturedAt).toBe(startedB.toISOString());
    const insertA = harnessA.inserts[0] as Record<string, unknown>;
    const insertB = harnessB.inserts[0] as Record<string, unknown>;
    expect(insertA.idempotency_key).not.toBe(insertB.idempotency_key);
    expect(harnessA.filters).toContainEqual(["eq", "id", COMMAND]);
    expect(harnessB.filters).toContainEqual(["eq", "id", FRESH_COMMAND]);
  });

  it("times out a sent request without changing it unless the queued-state CAS still matches", async () => {
    let currentMs = Date.parse("2026-08-05T12:00:00.000Z");
    const sent = queuedRow("sent");
    const harness = sequencedClient([null, sent, sent, null]);

    await expect(requestViptelProviderSnapshot(ORGANIZATION_A, ACTOR, {
      client: harness.client as never,
      env: ENABLED_ENV,
      now: () => new Date(currentMs),
      sleep: async () => { currentMs += 2_000; },
      waitMs: 1_000,
    })).rejects.toMatchObject({ status: 504 });

    expect(harness.filters).toContainEqual(["eq", "status", "queued"]);
    expect(harness.filters).toContainEqual(["eq", "organization_id", ORGANIZATION_A]);
  });

  it("rejects missing extensions, forbidden keys, and oversized normalized payloads", () => {
    const missing = validWire();
    missing.extensions = missing.extensions.filter((extension) => extension.extension !== "23");
    expect(() => parseViptelProviderSnapshotWire(missing)).toThrow("exactly one row for every personal extension");

    expect(() => parseViptelProviderSnapshotWire({ ...validWire(), authorization: "Basic secret" })).toThrow("forbidden");

    const oversized = validWire();
    oversized.activeCalls = Array.from({ length: 100 }, (_, index) => ({
      providerCallId: `call-${index}`,
      viptelUniqueId: `${index}`.padEnd(128, "v"),
      direction: "inbound" as const,
      status: "answered" as const,
      callerNumber: "x".repeat(128),
      callerName: "x".repeat(256),
      calledNumber: "x".repeat(128),
      receivedNumber: "x".repeat(128),
      destinationNumber: "x".repeat(128),
      callerExtension: "x".repeat(128),
      receivedExtension: "x".repeat(128),
      destinationExtension: "x".repeat(128),
      queueNumber: "6".repeat(32),
      queueLabel: "x".repeat(256),
      operatorName: "x".repeat(256),
      startedAt: "2026-08-05T12:00:00.000Z",
      answeredAt: "2026-08-05T12:00:01.000Z",
      endedAt: "2026-08-05T12:00:02.000Z",
      waitSeconds: index,
      durationSeconds: index,
    }));
    oversized.extensions = oversized.extensions.map((extension) => ({
      ...extension,
      name: "x".repeat(256),
      outboundCid: "9".repeat(80),
      callForwarding: "8".repeat(128),
      allowedChanges: Array.from({ length: 24 }, (_, index) => `change-${index}`.padEnd(80, "x")),
    }));
    oversized.queueStatuses = oversized.queueStatuses.map((status) => ({
      ...status,
      members: Array.from({ length: 100 }, (_, index) => ({
        extension: String(1_000_000 + index),
        paused: false,
        inUse: false,
        dynamic: true,
        callsTaken: index,
      })),
    }));
    expect(() => parseViptelProviderSnapshotWire(oversized)).toThrow("maximum response size");
  });

  it("allows the inactive browser flag only while preserving call registration checks", () => {
    const snapshot = parseViptelProviderSnapshotWire(validWire());
    snapshot.extensions[0].isViptelPhoneActive = false;
    snapshot.extensions[0].isRegistered = false;
    expect(() => requirePersonalExtensionInSnapshot(snapshot, "20")).toThrow(MutationError);

    expect(requirePersonalExtensionInSnapshot(snapshot, "20", {
      allowInactiveForRegistration: true,
    })).toMatchObject({ extension: "20", isViptelPhoneActive: false });

    expect(() => requirePersonalExtensionInSnapshot(snapshot, "20", {
      allowInactiveForBrowserSipIntent: true,
    })).toThrow("requires a registered provider endpoint");

    expect(() => requirePersonalExtensionInSnapshot(snapshot, "20", {
      allowInactiveForBrowserSipIntent: true,
      requireRegistered: true,
    })).toThrow("nie je zaregistrovaná");

    snapshot.extensions[0].isRegistered = true;
    expect(requirePersonalExtensionInSnapshot(snapshot, "20", {
      allowInactiveForBrowserSipIntent: true,
      requireRegistered: true,
    })).toMatchObject({ extension: "20", isRegistered: true, isViptelPhoneActive: false });

    const withoutAllowlistEntry = {
      ...snapshot,
      personalExtensions: snapshot.personalExtensions.filter((extension) => extension !== "20"),
    };
    expect(() => requirePersonalExtensionInSnapshot(withoutAllowlistEntry, "20", {
      allowInactiveForBrowserSipIntent: true,
      requireRegistered: true,
    })).toThrow("nie je povolená");

    const withoutExtension = {
      ...snapshot,
      extensions: snapshot.extensions.filter((extension) => extension.extension !== "20"),
    };
    expect(() => requirePersonalExtensionInSnapshot(withoutExtension, "20", {
      allowInactiveForBrowserSipIntent: true,
      requireRegistered: true,
    })).toThrow("chýba v čerstvom stave");
  });
});

function validWire(capturedAt = "2026-08-05T12:00:00.000Z"): ViptelProviderSnapshotWire {
  return {
    schemaVersion: 1 as const,
    capturedAt,
    personalExtensions: ["20", "21", "22", "23"],
    extensions: ["20", "21", "22", "23"].map((extension) => ({
      extension,
      name: `Operator ${extension}`,
      outboundCid: "0412289240",
      callForwarding: false,
      isRegistered: true,
      isViptelPhoneActive: true,
      allowedChanges: [],
    })),
    activeCalls: [],
    queues: ["601", "602", "603"].map((id) => ({ id, name: `Rad ${id}` })),
    queueStatuses: ["601", "602", "603"].map((queue) => ({ queue, waitingCalls: 0, members: [] })),
  };
}

function queuedRow(status: "queued" | "sent", id = COMMAND) {
  return {
    id,
    status,
    created_at: "2026-08-05T12:00:00.000Z",
    sent_at: status === "sent" ? "2026-08-05T12:00:00.000Z" : null,
    confirmed_at: null,
    request_payload: {
      schemaVersion: 1,
      requestedAt: "2026-08-05T12:00:00.000Z",
      deadlineAt: "2026-08-05T12:00:15.000Z",
    },
    provider_response: {},
  };
}

function confirmedRow(snapshot: ReturnType<typeof validWire>, organizationId = ORGANIZATION_A, id = COMMAND) {
  const command = queuedRow("sent", id);
  return {
    ...command,
    status: "confirmed_by_event",
    confirmed_at: snapshot.capturedAt,
    provider_response: {
      schemaVersion: 1,
      delivery: "listener_rest_read",
      confirmedAt: snapshot.capturedAt,
      responseHmac: signViptelProviderSnapshotResponse(command, organizationId, snapshot, ENABLED_ENV),
      snapshot,
    },
  };
}

type ScriptedQueryResult = {
  __scriptedQueryResult: true;
  data: unknown;
  error: unknown;
};
type SequencedResult = unknown | ((queryFilters: unknown[][]) => unknown) | ScriptedQueryResult;

function sequencedClient(results: SequencedResult[]) {
  let index = 0;
  const filters: unknown[][] = [];
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  const client = {
    from: vi.fn(() => queryResult(results[index++] ?? null, filters, inserts, updates)),
  };
  return { client, filters, inserts, updates };
}

function queryResult(resultSource: SequencedResult, filters: unknown[][], inserts: unknown[], updates: unknown[]) {
  const queryFilters: unknown[][] = [];
  const result = () => isScriptedQueryResult(resultSource)
    ? { data: resultSource.data, error: resultSource.error }
    : {
        data: typeof resultSource === "function" ? resultSource(queryFilters) : resultSource,
        error: null,
      };
  const query = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        if (["eq", "in", "lt", "order", "limit"].includes(String(property))) {
          const filter = [String(property), ...args];
          filters.push(filter);
          queryFilters.push(filter);
        }
        if (property === "insert") inserts.push(args[0] as Json);
        if (property === "update") updates.push(args[0] as Json);
        if (property === "maybeSingle" || property === "single") return Promise.resolve(result());
        return query;
      };
    },
  });
  return query;
}

function scriptedResult(data: unknown, error: unknown): ScriptedQueryResult {
  return { __scriptedQueryResult: true, data, error };
}

function isScriptedQueryResult(value: unknown): value is ScriptedQueryResult {
  return Boolean(value && typeof value === "object" && (value as ScriptedQueryResult).__scriptedQueryResult === true);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
