import { describe, expect, it } from "vitest";

import type { MotoristActor } from "@/server/api-auth";
import {
  assertWorkplaceTakeoverReservation,
  getWorkplaceTakeoverSnapshot,
  requestWorkplaceTakeover,
  respondToWorkplaceTakeover,
} from "@/server/telephony/workplace-takeover-service";

const ids = {
  organization: "11111111-1111-4111-8111-111111111111",
  owner: "22222222-2222-4222-8222-222222222222",
  requester: "33333333-3333-4333-8333-333333333333",
  third: "44444444-4444-4444-8444-444444444444",
  extension: "55555555-5555-4555-8555-555555555555",
  lease: "66666666-6666-4666-8666-666666666666",
  request: "77777777-7777-4777-8777-777777777777",
  generation: "88888888-8888-4888-8888-888888888888",
  browser: "99999999-9999-4999-8999-999999999999",
} as const;

const checkedAt = "2026-08-08T12:00:00.000Z";

describe("workplace takeover consent", () => {
  it("auto-accepts an unanswered request after 30 seconds without changing ownership directly", async () => {
    const client = fakeClient({
      motorist_notifications: [notification({
        decision: "pending",
        expiresAt: "2026-08-08T11:59:59.000Z",
      })],
      motorist_telephony_extensions: [extension()],
    });

    const ownerSnapshot = await getWorkplaceTakeoverSnapshot(actor(ids.owner), {
      client: client as never,
      databaseNow: async () => checkedAt,
    });
    const requesterSnapshot = await getWorkplaceTakeoverSnapshot(actor(ids.requester), {
      client: client as never,
      databaseNow: async () => checkedAt,
    });

    expect(ownerSnapshot.incoming).toMatchObject({
      status: "accepted",
      acceptedBy: "timeout",
      extension: "20",
      handoffExpiresAt: "2026-08-08T12:04:59.000Z",
    });
    expect(requesterSnapshot.outgoing).toMatchObject({ status: "accepted", acceptedBy: "timeout", extension: "20" });
    expect(client.rows("motorist_telephony_extensions")[0]).toMatchObject({ profile_id: ids.owner });
  });

  it("reserves an accepted handoff for its requester but still lets the owner reclaim before release", async () => {
    const client = fakeClient({
      motorist_notifications: [notification({
        decision: "accepted",
        expiresAt: "2026-08-08T12:00:30.000Z",
        handoffExpiresAt: "2026-08-08T12:01:30.000Z",
        respondedAt: checkedAt,
        status: "read",
      })],
      motorist_telephony_extensions: [extension()],
    });

    await expect(assertWorkplaceTakeoverReservation(actor(ids.third), "20", {
      client: client as never,
      databaseNow: async () => checkedAt,
    })).rejects.toMatchObject({ code: "workplace_takeover_reserved", status: 409 });

    await expect(assertWorkplaceTakeoverReservation(actor(ids.requester), "20", {
      client: client as never,
      databaseNow: async () => checkedAt,
    })).resolves.toBeUndefined();

    await expect(assertWorkplaceTakeoverReservation(actor(ids.owner), "20", {
      client: client as never,
      databaseNow: async () => checkedAt,
    })).resolves.toBeUndefined();
  });

  it("records refusal with a compare-and-swap and leaves the live lease untouched", async () => {
    const client = fakeClient({
      motorist_notifications: [notification()],
      motorist_profiles: [{
        id: ids.owner,
        organization_id: ids.organization,
        active: true,
        display_name: "Owner Operator",
      }],
      motorist_telephony_extensions: [extension()],
      motorist_workplace_leases: [lease()],
    });

    const response = await respondToWorkplaceTakeover(
      actor(ids.owner),
      ids.request,
      "decline",
      { client: client as never, databaseNow: async () => checkedAt },
    );

    expect(response.snapshot.incoming).toBeUndefined();
    expect(response.snapshot.cooldowns).toEqual([{
      extension: "20",
      until: "2026-08-08T12:05:00.000Z",
    }]);
    expect(client.rows("motorist_notifications")[0]).toMatchObject({
      status: "archived",
      archived_at: checkedAt,
      payload: expect.objectContaining({ decision: "declined", respondedAt: checkedAt }),
    });
    expect(client.rows("motorist_workplace_leases")[0]).toMatchObject({
      id: ids.lease,
      profile_id: ids.owner,
      state: "active",
    });

    await expect(requestWorkplaceTakeover(actor(ids.requester), "20", {
      client: client as never,
      databaseNow: async () => "2026-08-08T12:00:30.000Z",
    })).rejects.toMatchObject({ code: "workplace_takeover_cooldown", status: 429 });
  });

  it("does not even create a consent request while the target is ringing or in a call", async () => {
    const client = fakeClient({
      motorist_notifications: [],
      motorist_profiles: [{
        id: ids.owner,
        organization_id: ids.organization,
        active: true,
        display_name: "Owner Operator",
      }],
      motorist_telephony_extensions: [extension()],
      motorist_telephony_queues: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        organization_id: ids.organization,
        provider: "viptel",
        external_id: "601",
        active: true,
        line_id: null,
        metadata: {
          dispatchRouting: {
            revision: 1,
            currentPlan: { "601": "20", "602": null, "603": null },
          },
        },
      }],
      motorist_workplace_leases: [lease()],
    });

    await expect(requestWorkplaceTakeover(actor(ids.requester), "20", {
      client: client as never,
      databaseNow: async () => checkedAt,
      requestProviderSnapshot: async () => ({
        activeCalls: [{
          direction: "inbound",
          status: "ringing_agent",
          destinationExtension: "20",
          raw: {},
        }],
        extensions: [{ extension: "20", isRegistered: true, allowedChanges: [], raw: {} }],
        queueStatuses: [
          { queue: "601", waitingCalls: 1, members: [{ extension: "20", paused: false, inUse: true, dynamic: true, callsTaken: 0 }] },
          { queue: "602", waitingCalls: 0, members: [] },
          { queue: "603", waitingCalls: 0, members: [] },
        ],
      }),
    })).rejects.toThrow("práve prebieha alebo zvoní hovor");

    expect(client.rows("motorist_notifications")).toEqual([]);
    expect(client.rows("motorist_workplace_leases")[0]).toMatchObject({ state: "active", profile_id: ids.owner });
  });

  it("fails closed when two browser windows answer the same request", async () => {
    const client = fakeClient({
      motorist_notifications: [notification()],
      motorist_telephony_extensions: [extension()],
      motorist_workplace_leases: [lease()],
    }, { loseNextUpdate: true });

    await expect(respondToWorkplaceTakeover(
      actor(ids.owner),
      ids.request,
      "decline",
      { client: client as never, databaseNow: async () => checkedAt },
    )).rejects.toMatchObject({ code: "workplace_takeover_response_race", status: 409 });

    expect(client.rows("motorist_workplace_leases")[0]).toMatchObject({ state: "active", profile_id: ids.owner });
  });
});

function actor(profileId: string): MotoristActor {
  return {
    userId: `${profileId}-user`,
    profileId,
    organizationId: ids.organization,
    displayName: profileId === ids.owner ? "Owner Operator" : "Requesting Operator",
    role: "dispatcher",
  };
}

function extension() {
  return {
    id: ids.extension,
    organization_id: ids.organization,
    provider: "viptel",
    extension: "20",
    profile_id: ids.owner,
    active: true,
  };
}

function lease() {
  return {
    id: ids.lease,
    organization_id: ids.organization,
    extension_id: ids.extension,
    profile_id: ids.owner,
    assignment_generation: ids.generation,
    browser_instance_id: ids.browser,
    lease_version: 1,
    leader_epoch: 1,
    resume_secret_hash: "a".repeat(64),
    resume_requested_at: null,
    heartbeat_suspended_at: null,
    heartbeat_suspension_operation_id: null,
    state: "active",
    claimed_at: "2026-08-08T11:59:30.000Z",
    heartbeat_at: "2026-08-08T11:59:50.000Z",
    expires_at: "2026-08-08T12:00:50.000Z",
    ended_at: null,
    ended_reason: null,
    revoked_by: null,
    created_at: "2026-08-08T11:59:30.000Z",
    updated_at: "2026-08-08T11:59:50.000Z",
  };
}

function notification(overrides: {
  decision?: string;
  expiresAt?: string;
  handoffExpiresAt?: string;
  respondedAt?: string;
  status?: string;
} = {}) {
  return {
    id: ids.request,
    organization_id: ids.organization,
    recipient_profile_id: ids.owner,
    kind: "system",
    severity: "warning",
    visibility: "private",
    title: "Workplace handoff",
    body: null,
    status: overrides.status ?? "unread",
    delivery_status: "in_app",
    dedupe_key: `workplace-takeover:${ids.lease}`,
    read_at: null,
    archived_at: null,
    payload: {
      type: "workplace_takeover_request",
      schemaVersion: 1,
      decision: overrides.decision ?? "pending",
      extension: "20",
      extensionId: ids.extension,
      leaseId: ids.lease,
      ownerProfileId: ids.owner,
      ownerName: "Owner Operator",
      requesterProfileId: ids.requester,
      requesterName: "Requesting Operator",
      requestedAt: "2026-08-08T11:59:45.000Z",
      expiresAt: overrides.expiresAt ?? "2026-08-08T12:00:15.000Z",
      ...(overrides.respondedAt ? { respondedAt: overrides.respondedAt } : {}),
      ...(overrides.handoffExpiresAt ? { handoffExpiresAt: overrides.handoffExpiresAt } : {}),
    },
    created_at: "2026-08-08T11:59:45.000Z",
    updated_at: "2026-08-08T11:59:45.000Z",
  };
}

type Row = Record<string, unknown>;

function fakeClient(
  initial: Record<string, Row[]>,
  options: { loseNextUpdate?: boolean } = {},
) {
  const tables = new Map(Object.entries(initial).map(([name, rows]) => [name, rows.map((row) => structuredClone(row))]));
  let loseNextUpdate = options.loseNextUpdate ?? false;

  class Query implements PromiseLike<{ data: Row[]; error: null }> {
    private filters: Array<(row: Row) => boolean> = [];
    private maximum?: number;
    private mutation?: { kind: "insert" | "update"; values: Row };

    constructor(private readonly table: string) {}

    select() { return this; }
    order() { return this; }
    limit(value: number) { this.maximum = value; return this; }
    eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this; }
    is(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this; }
    in(key: string, values: unknown[]) { this.filters.push((row) => values.includes(row[key])); return this; }
    like(key: string, pattern: string) {
      const prefix = pattern.endsWith("%") ? pattern.slice(0, -1) : pattern;
      this.filters.push((row) => typeof row[key] === "string" && String(row[key]).startsWith(prefix));
      return this;
    }
    insert(values: Row) { this.mutation = { kind: "insert", values }; return this; }
    update(values: Row) { this.mutation = { kind: "update", values }; return this; }

    async maybeSingle() {
      const result = this.execute();
      return { data: result.data.length === 1 ? result.data[0] : null, error: null };
    }

    then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
      onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
    }

    private execute() {
      const rows = tables.get(this.table) ?? [];
      if (this.mutation?.kind === "insert") {
        const stored = structuredClone(this.mutation.values);
        rows.push(stored);
        tables.set(this.table, rows);
        return { data: [stored], error: null };
      }
      const matching = rows.filter((row) => this.filters.every((filter) => filter(row)));
      if (this.mutation?.kind === "update") {
        if (loseNextUpdate) {
          loseNextUpdate = false;
          return { data: [], error: null };
        }
        for (const row of matching) Object.assign(row, structuredClone(this.mutation.values));
      }
      return { data: (this.maximum ? matching.slice(0, this.maximum) : matching).map((row) => structuredClone(row)), error: null };
    }
  }

  return {
    from(table: string) { return new Query(table); },
    rows(table: string) { return tables.get(table) ?? []; },
  };
}
