import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelephonyHarness } from "@/test/telephony-harness";

import { envLatencyFlags } from "./latency-flags";
import { decodeClientState } from "./telnyx/client-state";
import { sessionSipDomain, telnyxSipUsername } from "./state/types";

/** The expected address, spelled out independently of the builder under test. */
const expected = (user: string, domain: "com" | "eu") => `sip:${user}@sip.telnyx.${domain}`;

/**
 * The start, colleague, mobile, hold, conference, transfer, consult,
 * supervision and termination journeys again with `api_region: "eu"` and
 * `sip_domain: "eu"` on a TEST deployment (call-speed S5 SIP-domain spike;
 * only `test` may freeze it, and only for a session frozen to `eu`). Every
 * outbound and colleague session these suites create freezes
 * `start_mode.sipDomain = "eu"`, while an inbound call stays on `com`.
 *
 * After each test, every SIP-credential destination the application sent to
 * Telnyx (a dial or a transfer) and every operator leg it recorded is checked
 * against the domain frozen into its session: a URI built on the other domain
 * fails the test it happened in. The suites' own assertions then prove that
 * the matchers (mobile offers, native hold, browser offer status, mirrors)
 * accept the `eu` address.
 */
const ON = { api_region: "eu", sip_domain: "eu" };
beforeEach(() => {
  vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify(ON));
  vi.stubEnv("MOTORIST_APP_ENV", "test");
});

const seen = vi.hoisted(() => ({ harnesses: [] as TelephonyHarness[], eu: new Map<string, number>(), com: 0, euSessions: new Set<string>(),
  inbound: 0, legs: 0 }));
vi.mock("@/test/telephony-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/test/telephony-harness")>();
  return { ...actual, createTelephonyHarness: (...args: Parameters<typeof actual.createTelephonyHarness>) => {
    const h = actual.createTelephonyHarness(...args);
    seen.harnesses.push(h);
    return h;
  } };
});

afterEach(() => {
  for (const h of seen.harnesses.splice(0)) {
    const sessions = new Map(h.rows("motorist_call_sessions").map(row => [String(row.id), row]));
    for (const row of sessions.values()) {
      const startMode = (row.metadata as { start_mode?: { apiRegion?: string; sipDomain?: string } } | null)?.start_mode;
      if (!startMode) continue;
      // Telnyx created an inbound call (`us`); only a session frozen to `eu` may dial `sip.telnyx.eu`.
      if (row.direction === "inbound") { expect(startMode).not.toHaveProperty("sipDomain"); seen.inbound += 1; }
      if (startMode.sipDomain !== undefined) expect([startMode.apiRegion, startMode.sipDomain]).toEqual(["eu", "eu"]);
    }
    // What the application sent: the dial's or the transfer's own client state names its session.
    for (const { method, params } of h.telnyx.calls) {
      if (method !== "dial" && method !== "transfer") continue;
      const username = telnyxSipUsername(params.to);
      if (!username) continue;
      const state = decodeClientState(method === "dial" ? params.clientState : params.targetLegClientState);
      const row = state ? sessions.get(state.sid) : undefined;
      if (!row) continue;
      const domain = sessionSipDomain(row.metadata);
      expect(`${method} ${state!.intent ?? state!.role} → ${String(params.to)}`).toBe(`${method} ${state!.intent ?? state!.role} → ${expected(username, domain)}`);
      if (domain === "eu") {
        const kind = `${method}:${state!.intent ?? state!.role}`;
        seen.eu.set(kind, (seen.eu.get(kind) ?? 0) + 1);
        seen.euSessions.add(row.id as string);
      } else seen.com += 1;
    }
    // What it recorded: every operator and supervisor leg to a credential carries its session's domain.
    for (const leg of h.rows("motorist_call_legs")) {
      const username = telnyxSipUsername(leg.to_number);
      const row = sessions.get(String(leg.session_id));
      if (!username || !row) continue;
      expect(leg.to_number, `leg ${String(leg.telnyx_call_control_id)}`).toBe(expected(username, sessionSipDomain(row.metadata)));
      seen.legs += 1;
    }
  }
});

describe("SIP-domain switch", () => {
  it("is on for every suite below", () => {
    expect(envLatencyFlags(process.env)).toMatchObject(ON);
  });
});

afterAll(() => {
  // The suites below really dialled `sip.telnyx.eu` in `eu` sessions: own legs, colleague endpoints and
  // pickups (their transfers, consults, parties and supervisors run on inbound calls; `sip-domain.test.ts`
  // dials those in an `eu` session).
  const kinds = Object.fromEntries([...seen.eu].sort());
  for (const kind of ["dial:outbound", "dial:internal_caller", "dial:internal", "dial:pickup"]) {
    expect(kinds[kind] ?? 0, `${kind} in ${JSON.stringify(kinds)}`).toBeGreaterThan(0);
  }
  expect(seen.euSessions.size).toBeGreaterThan(30);
  // ...inbound calls among them stayed on `com`.
  expect(seen.inbound).toBeGreaterThan(20);
  expect(seen.com).toBeGreaterThan(20);
  expect(seen.legs).toBeGreaterThan(100);
});

// Suites whose assertions do not spell `sip.telnyx.com` themselves (those
// pin today's default and keep running in the ordinary pass).
await import("./state/outbound-direct.test");
await import("./hangup-acceptance.test");
await import("./session-contention.test");
await import("./callbacks-v1.test");
await import("./state/dispatch-pause-boundaries.test");
await import("./own-leg-request-header.test");
await import("./mobile-calling.test");
await import("./call-setup-latency.test");
await import("./internal-lean-path.test");
await import("./lean-answer-context.test");
await import("./bridged-observation.test");
await import("./conference-departure.test");
await import("./state/transfer-music.test");
await import("./park-control-progress.test");
await import("./termination.test");
await import("./termination-priority.test");
await import("./call-reconciliation.test");
await import("./outbound-pickup-context.test");
await import("./transfer-to-mobile.test");
await import("./consult-mobile-presence.test");
