import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelephonyHarness } from "@/test/telephony-harness";

import { envLatencyFlags, sessionApiRegion } from "./latency-flags";

/**
 * The start, recovery, hangup, pause and callback contracts, and the hold,
 * conference, supervision, transfer, termination, reconcile and recording
 * journeys, again with `api_region: "eu"` on a TEST deployment (call-speed
 * S5; only `test` may freeze `eu` until spike S5.0 passes). Every session
 * these suites create through the application freezes `.eu`, so the state
 * machine runs against the EU base URL, while an inbound call stays `us`.
 *
 * After each test:
 * - every provider request made under a session's ownership, and every
 *   unowned provider read of a known leg or conference, is checked against the
 *   region frozen into that session's row: a command that left its session's
 *   region fails the test it happened in;
 * - every session the application created keeps exactly the `start_mode` it
 *   was created with, whatever metadata patches ran (the region is read from
 *   it for the rest of the call).
 */
const ON = { api_region: "eu" };
beforeEach(() => {
  vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify(ON));
  vi.stubEnv("MOTORIST_APP_ENV", "test");
});

type Created = { id: string; startMode: unknown };
const seen = vi.hoisted(() => ({ harnesses: [] as Array<{ h: TelephonyHarness; created: Created[] }>,
  eu: 0, us: 0, euSessions: new Set<string>(), inbound: 0, unownedReads: 0, preserved: 0 }));
vi.mock("@/test/telephony-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/test/telephony-harness")>();
  return { ...actual, createTelephonyHarness: (...args: Parameters<typeof actual.createTelephonyHarness>) => {
    const h = actual.createTelephonyHarness(...args);
    // Sessions really inserted with a start mode (a lost insert race throws and records nothing).
    const created: Created[] = [];
    const insert = h.db.insert.bind(h.db);
    h.db.insert = (table, rows) => {
      const inserted = insert(table, rows);
      if (table === "motorist_call_sessions") {
        for (const row of inserted) {
          const startMode = (row.metadata as { start_mode?: unknown } | null)?.start_mode;
          if (startMode !== undefined) created.push({ id: String(row.id), startMode: structuredClone(startMode) });
        }
      }
      return inserted;
    };
    seen.harnesses.push({ h, created });
    return h;
  } };
});

afterEach(() => {
  for (const { h, created } of seen.harnesses.splice(0)) {
    const sessions = new Map(h.rows("motorist_call_sessions").map(row => [String(row.id), row]));
    for (const row of sessions.values()) {
      const startMode = (row.metadata as { start_mode?: { apiRegion?: string } } | null)?.start_mode;
      if (!startMode) continue;
      // Telnyx created an inbound call; only sessions we create follow the flag.
      if (row.direction === "inbound") { expect(startMode.apiRegion).toBe("us"); seen.inbound += 1; }
    }
    // Every session keeps exactly the start mode it was created with.
    for (const { id, startMode } of created) {
      const row = sessions.get(id);
      if (!row) continue;
      expect((row.metadata as { start_mode?: unknown } | null)?.start_mode, `start_mode of session ${id}`).toEqual(startMode);
      seen.preserved += 1;
    }
    const legs = h.rows("motorist_call_legs");
    // An unowned provider read (reconcile, the TEST guard) names its session
    // only through the leg or conference it asks about. Sessions without a
    // writer contract (older suites' rows; production always has one) run
    // their reducer work unowned too, so only their owned requests are checked.
    const unownedRead = (path: string) => {
      const [, kind, id] = /^\/(calls|conferences)\/([^/]+)/.exec(path) ?? [];
      const key = id ? decodeURIComponent(id) : null;
      if (kind === "calls") return sessions.get(String(legs.find(leg => leg.telnyx_call_control_id === key)?.session_id));
      return kind === "conferences" ? [...sessions.values()].find(row => row.conference_id === key) : undefined;
    };
    for (const route of h.telnyx.routes) {
      const row = route.sessionId ? sessions.get(route.sessionId) : route.method === "GET" ? unownedRead(route.path) : undefined;
      if (!row || !route.sessionId && row.writer_contract === undefined) continue;
      if (!route.sessionId) seen.unownedReads += 1;
      expect(`${route.method} ${route.path} ${route.region}`).toBe(`${route.method} ${route.path} ${sessionApiRegion(row.metadata)}`);
      if (route.region === "eu") { seen.eu += 1; seen.euSessions.add(String(row.id)); expect(route.baseUrl).toBe("https://api.telnyx.eu/v2"); }
      else seen.us += 1;
    }
  }
});

describe("API region switch", () => {
  it("is on for every suite below", () => {
    expect(envLatencyFlags(process.env)).toMatchObject(ON);
  });
});

afterAll(() => {
  // The suites below really ran sessions in .eu, command by command...
  // (105 sessions, 811 commands and 444 checked start modes when written;
  // the margins absorb edits to those suites.)
  expect(seen.euSessions.size).toBeGreaterThan(60);
  expect(seen.unownedReads).toBeGreaterThan(0);
  expect(seen.eu).toBeGreaterThan(500);
  // ...inbound calls among them stayed `us`, and no patch dropped a start mode.
  expect(seen.inbound).toBeGreaterThan(100);
  expect(seen.preserved).toBeGreaterThan(250);
});

// Their only root-level setup is an `afterEach` that restores the environment
// this file's `beforeEach` sets again for the next test. The start contracts
// (as `start-flags-on.test.ts`); the contract-2 outbound and colleague
// journeys, whose commands run under each session's ownership; then hold,
// conference, supervision, transfer, termination, reconcile and recording.
await import("./initial-call-operation.test");
await import("./colleague-call.test");
await import("./state/outbound-direct.test");
await import("./hangup-acceptance.test");
await import("./session-contention.test");
await import("./callbacks-v1.test");
await import("./state/dispatch-pause-boundaries.test");
await import("./own-leg-request-header.test");
await import("./mobile-calling.test");
await import("./call-setup-latency.test");
await import("./start-fast-path.test");
await import("./internal-lean-path.test");
await import("./lean-answer-context.test");
await import("./bridged-observation.test");
await import("./state/colleague-application-endpoints.test");
await import("./hold-latency.test");
await import("./conference-actions.test");
await import("./conference-departure.test");
await import("./state/transfer-music.test");
await import("./park-control-progress.test");
await import("./termination.test");
await import("./termination-priority.test");
await import("./call-reconciliation.test");
await import("./state/recording-connection.test");
await import("./recording-webhook-replay.test");
await import("./outbound-pickup-context.test");
