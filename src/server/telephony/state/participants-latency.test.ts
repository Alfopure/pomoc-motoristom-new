import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeOperation, type FakeRow, type FakeSupabase } from "@/test/fake-supabase";
import { observeParticipants } from "./participants";
import type { SessionRow } from "./types";

const TABLE = "motorist_call_participant_intervals";
const START = "2026-10-07T10:00:00.000Z";
const AT = "2026-10-07T10:00:30.000Z";
const FUTURE = "2026-10-07T10:01:00.000Z";
const session = {
  id: "session", organization_id: "org", state: "talking", conference_id: "conference", ended_at: null,
  metadata: { recording: { epoch: 2, policy: { enabled: true, channelMappingVerified: true },
    recorders: [{ id: "recorder", epoch: 2, startedAt: START }] } },
} as unknown as SessionRow;

function fixture(participants = 2) {
  const fake = createFakeSupabase({ uniqueKeys: { [TABLE]: [["id"], ["organization_id", "source_event_id", "leg_id", "reason"]] } });
  fake.db.insert("motorist_calls", { id: "call", organization_id: "org", session_id: "session" });
  for (let index = 0; index < participants; index++) fake.db.insert("motorist_call_legs", {
    id: `leg-${index}`, organization_id: "org", session_id: "session", role: index === 0 ? "customer" : "operator",
    profile_id: index === 0 ? null : `profile-${index}`, state: "answered", answered_at: START, ended_at: null,
  });
  return fake;
}

function interval(index: number, values: FakeRow = {}): FakeRow {
  return { id: `interval-${index}`, organization_id: "org", session_id: "session", call_id: "call", leg_id: `leg-${index}`,
    profile_id: index === 0 ? null : `profile-${index}`, role: index === 0 ? "customer" : "operator", started_at: START,
    ended_at: null, audible_to_customer: true, reason: "customer_conference", channel: index === 0 ? 0 : 1,
    verified: true, topology_epoch: 1, source_event_id: `old-${index}`, ...values };
}

type Request = { table: string; operation: FakeOperation; payload?: FakeRow | FakeRow[] };

/** Delay the database boundary itself, including requests that reject before a response. */
function intercept(fake: FakeSupabase, before: (request: Request) => Promise<void>) {
  const from = fake.client.from.bind(fake.client);
  return vi.spyOn(fake.client, "from").mockImplementation(table => {
    const query = from(table);
    const request: Request = { table, operation: "select" };
    const insert = query.insert.bind(query), update = query.update.bind(query), then = query.then.bind(query);
    query.insert = values => { request.operation = "insert"; request.payload = values; return insert(values); };
    query.update = values => { request.operation = "update"; request.payload = values; return update(values); };
    query.then = (fulfilled, rejected) => Promise.resolve().then(() => before(request)).then(() => then()).then(fulfilled, rejected);
    return query;
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("participant observation request waves", () => {
  it.each([false, true])("opens both sides in two request waves, with scoped identity resolver = %s", async cached => {
    vi.useFakeTimers();
    const fake = fixture(), began = Date.now();
    const requests: Array<Request & { at: number }> = [];
    intercept(fake, async request => {
      requests.push({ ...request, at: Date.now() - began });
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    const resolver = vi.fn(async () => "call");
    const observing = observeParticipants(fake.admin, session, "joined", AT, true, cached ? resolver : undefined);
    await vi.runAllTimersAsync();
    await observing;

    expect(Date.now() - began).toBe(50); // Previously 4 serial 25 ms waves, even for two participants.
    expect(requests.filter(request => request.operation === "select")).toHaveLength(cached ? 2 : 3);
    expect(requests.filter(request => request.operation === "select").every(request => request.at === 0)).toBe(true);
    expect(requests.filter(request => request.operation === "insert").map(request => request.at)).toEqual([25, 25]);
    expect(resolver).toHaveBeenCalledTimes(cached ? 1 : 0);
    expect(fake.db.rows(TABLE)).toEqual([
      expect.objectContaining({ leg_id: "leg-0", profile_id: null, channel: 0, verified: true, started_at: AT, topology_epoch: 2, source_event_id: "joined" }),
      expect.objectContaining({ leg_id: "leg-1", profile_id: "profile-1", channel: 1, verified: true, started_at: AT, topology_epoch: 2, source_event_id: "joined" }),
    ]);
  });

  it("closes a shared old epoch in one scoped write before opening either new interval", async () => {
    vi.useFakeTimers();
    const fake = fixture(), began = Date.now();
    fake.db.insert(TABLE, [interval(0), interval(1)]);
    const requests: Array<Request & { at: number }> = [];
    intercept(fake, async request => {
      requests.push({ ...request, at: Date.now() - began });
      if (request.operation === "insert") expect(fake.db.rows(TABLE).every(row => row.ended_at === AT)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    const observing = observeParticipants(fake.admin, session, "new-epoch", AT, false);
    await vi.runAllTimersAsync();
    await observing;

    expect(Date.now() - began).toBe(75); // Previously lookup + reads + 2 closes + 2 inserts = 150 ms.
    expect(requests.filter(request => request.operation === "update")).toHaveLength(1);
    expect(fake.db.log.find(request => request.operation === "update")?.filters).toEqual(["eq(organization_id)", "eq(session_id)", "in(id)", "is(ended_at)"]);
    expect(fake.db.rows(TABLE).map(row => [row.leg_id, row.started_at, row.ended_at, row.topology_epoch, row.channel, row.verified])).toEqual([
      ["leg-0", START, AT, 1, 0, true], ["leg-1", START, AT, 1, 1, true],
      ["leg-0", AT, null, 2, 0, true], ["leg-1", AT, null, 2, 1, true],
    ]);
    vi.restoreAllMocks();
    await observeParticipants(fake.admin, session, "new-epoch", AT, false);
    expect(fake.db.rows(TABLE)).toHaveLength(4);
  });

  it("keeps different close clamps and channel confirmation timestamps intact", async () => {
    const fake = fixture();
    fake.db.insert(TABLE, [interval(0), interval(1, { started_at: FUTURE })]);
    await observeParticipants(fake.admin, { ...session, state: "held" }, "hold", AT, true);
    expect(fake.db.rows(TABLE).map(row => row.ended_at)).toEqual([AT, FUTURE]);

    fake.db.insert(TABLE, [interval(0, { id: "current-0", topology_epoch: 2, verified: false, source_event_id: "current-0" }),
      interval(1, { id: "current-1", topology_epoch: 2, verified: false, started_at: FUTURE, source_event_id: "current-1" })]);
    await observeParticipants(fake.admin, session, "confirmed", AT, true);
    expect(fake.db.rows(TABLE).filter(row => !row.ended_at)).toEqual([
      expect.objectContaining({ leg_id: "leg-0", started_at: START, channel: 0, verified: true }),
      expect.objectContaining({ leg_id: "leg-1", started_at: AT, channel: 1, verified: true }),
    ]);
  });

  it("does not let one closed replay duplicate suppress another participant's missing insert", async () => {
    const fake = fixture();
    fake.db.insert(TABLE, interval(0, { source_event_id: "replayed", ended_at: AT, topology_epoch: 2 }));
    await observeParticipants(fake.admin, session, "replayed", AT, true);
    expect(fake.db.rows(TABLE)).toEqual([
      expect.objectContaining({ leg_id: "leg-0", ended_at: AT }),
      expect.objectContaining({ leg_id: "leg-1", source_event_id: "replayed", ended_at: null }),
    ]);
    expect(fake.db.log.filter(request => request.operation === "insert").every(request => !Array.isArray(request.payload))).toBe(true);
    await observeParticipants(fake.admin, session, "replayed", AT, true);
    expect(fake.db.rows(TABLE)).toHaveLength(2);
  });

  it("drains sibling reads before rejecting a failed identity lookup", async () => {
    const fake = fixture(), pendingRead = deferred();
    let returned = false;
    intercept(fake, async request => { if (request.table === TABLE) await pendingRead.promise; });
    const observing = observeParticipants(fake.admin, session, "joined", AT, true, async () => { throw new Error("network unavailable"); })
      .catch(error => { returned = true; return error; });
    await flush();
    expect(returned).toBe(false);
    expect(fake.db.rows(TABLE)).toEqual([]);
    pendingRead.resolve();
    expect(await observing).toMatchObject({ message: "participant call lookup failed" });
  });

  it("still ignores failed observation reads when the call identity is absent, after draining them", async () => {
    const fake = fixture(), pendingRead = deferred();
    fake.db.delete("motorist_calls", () => true);
    let returned = false;
    intercept(fake, async request => {
      if (request.table === TABLE) await pendingRead.promise;
      if (request.table === "motorist_call_legs") throw new Error("network unavailable");
    });
    const observing = observeParticipants(fake.admin, session, "joined", AT, true).then(() => { returned = true; });
    await flush();
    expect(returned).toBe(false);
    pendingRead.resolve();
    await observing;
    expect(returned).toBe(true);
    expect(fake.db.rows(TABLE)).toEqual([]);
  });

  it("drains close failures before returning, never opens a new epoch on partial close, and retries safely", async () => {
    const fake = fixture(), pendingClose = deferred();
    fake.db.insert(TABLE, [interval(0), interval(1, { started_at: FUTURE })]);
    let returned = false, updates = 0;
    const intercepted = intercept(fake, async request => {
      if (request.operation !== "update") return;
      updates++;
      if (updates === 1) throw new Error("close failed");
      await pendingClose.promise;
    });
    const observing = observeParticipants(fake.admin, session, "new-epoch", AT, true).catch(error => { returned = true; return error; });
    await flush();
    expect(updates).toBe(2);
    expect(returned).toBe(false);
    pendingClose.resolve();
    expect(await observing).toMatchObject({ message: "close failed" });
    expect(fake.db.rows(TABLE)).toHaveLength(2);
    expect(fake.db.rows(TABLE).map(row => row.ended_at)).toEqual([null, FUTURE]);
    intercepted.mockRestore();

    await observeParticipants(fake.admin, session, "new-epoch", AT, true);
    expect(fake.db.rows(TABLE)).toHaveLength(4);
    expect(fake.db.rows(TABLE).filter(row => row.ended_at === null)).toHaveLength(2);
    expect(fake.db.rows(TABLE).filter(row => row.topology_epoch === 1).map(row => row.ended_at)).toEqual([AT, FUTURE]);
  });

  it("bounds inserts at four, drains partial failures, then fills only missing evidence on replay", async () => {
    const fake = fixture(6), pendingInsert = deferred();
    let returned = false, inserts = 0;
    const intercepted = intercept(fake, async request => {
      if (request.operation !== "insert") return;
      inserts++;
      if (inserts === 1) throw new Error("insert failed");
      if (inserts === 2) await pendingInsert.promise;
    });
    const observing = observeParticipants(fake.admin, session, "joined", AT, true).catch(error => { returned = true; return error; });
    await flush();
    expect(inserts).toBe(4);
    expect(returned).toBe(false);
    pendingInsert.resolve();
    expect(await observing).toMatchObject({ message: "insert failed" });
    expect(inserts).toBe(4);
    expect(fake.db.rows(TABLE)).toHaveLength(3);
    intercepted.mockRestore();

    await observeParticipants(fake.admin, session, "joined", AT, true);
    expect(fake.db.rows(TABLE)).toHaveLength(6);
    expect(new Set(fake.db.rows(TABLE).map(row => row.leg_id)).size).toBe(6);
    expect(fake.db.rows(TABLE).every(row => row.channel === null)).toBe(true);
  });
});
