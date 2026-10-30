import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { callColleague, createRateLimiter, startOutboundCall, type CallActionDeps, type CallActor } from "./call-actions";
import { defaultLatencyFlags } from "./latency-flags";

/**
 * Call-speed S3, server half: with `own_leg_request_header` the own-leg dial of
 * a start request carries that request's id as `X-PM-Request`, next to
 * `X-PM-Auto-Answer`, so the waiting browser tab can answer it before the
 * response. No other leg — customer, colleague — ever carries it, and with the
 * switch off every dial is exactly as before.
 */

const jana: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };
const AUTO_ANSWER = { name: "X-PM-Auto-Answer", value: "1" };

const MODES = [
  { name: "legacy", stability: false },
  { name: "contract 2", stability: true, writerContract: 2 as const },
];

afterEach(() => vi.unstubAllEnvs());

describe.each(MODES)("own-leg request header ($name)", ({ stability, writerContract }) => {
  function world(): TelephonyHarness {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", stability ? "true" : "false");
    return createTelephonyHarness(writerContract ? { writerContract } : {});
  }
  function deps(h: TelephonyHarness, headerOn: boolean): CallActionDeps {
    return { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }),
      latencyFlags: { ...defaultLatencyFlags(), own_leg_request_header: headerOn } };
  }
  const headersOf = (h: TelephonyHarness, index: number) => h.telnyx.of("dial")[index]?.params.customHeaders;
  const carriesRequest = (h: TelephonyHarness) => h.telnyx.of("dial").filter((dial) =>
    (dial.params.customHeaders as Array<{ name: string }> | undefined)?.some((header) => header.name === "X-PM-Request"));

  it("puts the start request id on the outbound own leg only", async () => {
    const h = world();
    const requestId = randomUUID();
    const call = await startOutboundCall(deps(h, true), jana, { to: NUMBERS.customer, requestId });
    expect(headersOf(h, 0)).toEqual([AUTO_ANSWER, { name: "X-PM-Request", value: requestId }]);

    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    await completeCallAnnouncements(h, call.sessionId);
    const customer = h.telnyx.of("dial").find((dial) => dial.params.to === NUMBERS.customer);
    expect(customer).toBeDefined();
    expect(carriesRequest(h)).toHaveLength(1);
  });

  it("puts it on the caller's own leg of a colleague call, never on the colleague's", async () => {
    const h = world();
    const requestId = randomUUID();
    const call = await callColleague(deps(h, true), jana, { targetProfileId: PROFILES.o2, requestId });
    expect(headersOf(h, 0)).toEqual([AUTO_ANSWER, { name: "X-PM-Request", value: requestId }]);

    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    await completeCallAnnouncements(h, call.sessionId);
    const callee = h.openLegFor(call.sessionId, PROFILES.o2);
    expect(callee).toBeTruthy();
    const colleagueDial = h.telnyx.of("dial").find((dial) => dial.params.to !== h.telnyx.of("dial")[0].params.to);
    expect(colleagueDial?.params.customHeaders).toEqual([{ name: "X-PM-Colleague-Call", value: "1" }]);
    expect(carriesRequest(h)).toHaveLength(1);
  });

  it("dials exactly as before with the switch off", async () => {
    const outbound = world();
    await startOutboundCall(deps(outbound, false), jana, { to: NUMBERS.customer, requestId: randomUUID() });
    expect(headersOf(outbound, 0)).toEqual([AUTO_ANSWER]);
    const internal = world();
    const call = await callColleague(deps(internal, false), jana, { targetProfileId: PROFILES.o2, requestId: randomUUID() });
    await internal.legEvent(call.operatorLegCallControlId, "call.answered");
    await completeCallAnnouncements(internal, call.sessionId);
    expect(headersOf(internal, 0)).toEqual([AUTO_ANSWER]);
    expect(internal.telnyx.of("dial").length).toBeGreaterThan(1);
    expect(carriesRequest(outbound)).toHaveLength(0);
    expect(carriesRequest(internal)).toHaveLength(0);
  });
});

it("sends no request header for a start without a request id (legacy writer)", async () => {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
  const h = createTelephonyHarness();
  await startOutboundCall({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }),
    latencyFlags: { ...defaultLatencyFlags(), own_leg_request_header: true } }, jana, { to: NUMBERS.customer });
  expect(h.telnyx.of("dial")[0].params.customHeaders).toEqual([AUTO_ANSWER]);
});
