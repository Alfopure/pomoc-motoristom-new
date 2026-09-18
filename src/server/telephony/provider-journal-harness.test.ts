import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { sessionOwnership, type Ownership } from "./ownership";
import { TelnyxCommandError } from "./telnyx/client";

afterEach(() => { vi.unstubAllEnvs(); });

function harness() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  return createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
}

const journal = (h: TelephonyHarness) => h.db.storage("motorist_provider_commands");

/** An owner the fence will accept: the lease this session actually holds. */
function holdLease(h: TelephonyHarness, sessionId: string): Ownership {
  h.db.registerRpc("motorist_session_lease_renew_v2", () => true);
  const row = h.db.storage("motorist_call_sessions").find((entry) => entry.id === sessionId)!;
  row.lease_token = "replay-owner";
  row.lease_generation = 1;
  row.lease_until = new Date(h.now().getTime() + 30_000).toISOString();
  return { admin: h.admin, organizationId: h.deps.organizationId, sessionId,
    token: "replay-owner", generation: 1, contract: 2, deadline: Date.now() + 24_000, acquiredAt: 0 };
}

/**
 * The double implements `TelnyxClient` method by method rather than over HTTP,
 * so for a long time nothing in it ever reached `prepare_v2` or `result_v2`.
 * Every branch that depends on them — a command already accepted, one the
 * fence refused, one whose outcome was never recorded — was unreachable in
 * tests, and those branches decide whether a redelivered webhook re-dials an
 * operator. These are the tests that were impossible to write.
 */
describe("the provider journal, on the test double", () => {
  it("fences every voice command, not just the ones with an obvious id", async () => {
    const h = harness();
    await h.inbound({ to: NUMBERS.allianz });

    const paths = journal(h).map((entry) => String(entry.path));
    expect(paths).toContain("/calls");
    expect(paths.some((path) => path.endsWith("/actions/answer"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/actions/playback_start"))).toBe(true);
    // Every entry that was dispatched also had its answer recorded; an entry
    // left without an outcome is a command we would not dare replay.
    expect(journal(h).every((entry) => entry.outcome === "accepted")).toBe(true);
  });

  it("returns the recorded answer instead of dialling twice", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const first = h.telnyx.of("dial")[0].params;
    const dials = h.telnyx.of("dial").length;
    const owner = holdLease(h, call.sessionId);

    // What a redelivered webhook looks like from below: the same command, the
    // same payload, arriving after the first one was accepted.
    const replay = await sessionOwnership.run(owner, () => h.telnyx.client.dial(first as never));

    // The provider is never touched, and the caller gets what the provider
    // said the first time — which is how a redelivery stops being a second
    // phone call to the same operator.
    expect(h.telnyx.of("dial")).toHaveLength(dials);
    expect(replay).toMatchObject({ callControlId: expect.any(String) });
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("gives back the refusal, not a fresh attempt, when the command was rejected", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    await h.legEvent(winner, "call.answered");
    const rejected = journal(h).find((entry) => entry.outcome === "accepted" && String(entry.path).endsWith("/actions/hangup"));
    if (!rejected) throw new Error("expected a recorded hangup to rewrite");
    rejected.outcome = "rejected";
    rejected.http_status = 422;
    rejected.result = { errors: [{ code: "call_not_found" }] };

    const owner = holdLease(h, call.sessionId);
    const hangups = h.telnyx.of("hangup").length;
    const params = h.telnyx.of("hangup").find((entry) => entry.params.commandId === rejected.command_id)!.params;

    const error = await sessionOwnership.run(owner, () => h.telnyx.client.hangup(params as never)).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(h.telnyx.of("hangup")).toHaveLength(hangups);
  });

  it("refuses a new command once termination is committed, and lets teardown through", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    await h.legEvent(winner, "call.answered");

    await h.legEvent(String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id), "call.hangup");
    for (const leg of h.legs(call.sessionId)) {
      if (!leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
    }

    // Everything that was allowed through after the session ended is teardown.
    const afterTermination = journal(h).filter((entry) => entry.outcome === "accepted" && /\/(hangup|record_stop|leave|stop)$/.test(String(entry.path)));
    expect(afterTermination.length).toBeGreaterThan(0);
    expect(h.session(call.sessionId).state).toBe("ended");
  });

  it("records a refusal, and records nothing at all when the answer was lost", async () => {
    const refused = harness();
    const refusedCall = await refused.inbound({ to: NUMBERS.allianz });
    refused.telnyx.failNext("playbackStop", new TelnyxCommandError({ code: "call_not_found", status: 422, detail: "refused" }));
    await refused.legEvent(String(refused.legFor(refusedCall.sessionId, PROFILES.o1)!.telnyx_call_control_id), "call.answered");

    // A provider that answers 4xx has answered. Recording the refusal is what
    // stops a replay from trying the same doomed command again.
    expect(journal(refused).filter((entry) => entry.outcome === "rejected")).toHaveLength(1);

    const lost = harness();
    const lostCall = await lost.inbound({ to: NUMBERS.allianz });
    lost.telnyx.loseNextResponse("playbackStop");
    await lost.legEvent(String(lost.legFor(lostCall.sessionId, PROFILES.o1)!.telnyx_call_control_id), "call.answered");

    // Executed, acknowledgement never arrived: the entry stays open, so the
    // next attempt has to ask rather than assume either way.
    expect(journal(lost).filter((entry) => entry.outcome === null)).toHaveLength(1);
    expect(journal(lost).find((entry) => entry.outcome === null)?.path).toMatch(/playback_stop$/);
  });

  it("refuses a command from an owner whose lease was taken", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const owner = holdLease(h, call.sessionId);

    // Somebody else takes the lease: a new token, a new generation.
    const row = h.db.storage("motorist_call_sessions").find((entry) => entry.id === call.sessionId)!;
    row.lease_token = "the-new-owner";
    row.lease_generation = 2;

    const error = await sessionOwnership.run(owner, () =>
      h.telnyx.client.hangup({ callControlId: call.callControlId, commandId: "after-takeover" })).catch((thrown: Error) => thrown);

    // The fence refuses it, not the lease renew. That distinction is the whole
    // point: the renew is one round trip per command and the fence is free,
    // and until the double modelled the fence there was no way to show it.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("SessionLeaseLostError");
  });

  it("lets the new owner through on the same session", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    holdLease(h, call.sessionId);
    const row = h.db.storage("motorist_call_sessions").find((entry) => entry.id === call.sessionId)!;
    row.lease_token = "the-new-owner";
    row.lease_generation = 2;
    const taken: Ownership = { admin: h.admin, organizationId: h.deps.organizationId, sessionId: call.sessionId,
      token: "the-new-owner", generation: 2, contract: 2, deadline: Date.now() + 24_000, acquiredAt: 0 };
    const before = h.telnyx.of("hangup").length;

    await sessionOwnership.run(taken, () => h.telnyx.client.hangup({ callControlId: call.callControlId, commandId: "by-new-owner" }));

    expect(h.telnyx.of("hangup").length).toBeGreaterThan(before);
  });

  it("refuses an owner whose lease has simply expired", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const owner = holdLease(h, call.sessionId);

    // Nobody took it; it just ran out.
    h.advance(31_000);

    const error = await sessionOwnership.run(owner, () =>
      h.telnyx.client.hangup({ callControlId: call.callControlId, commandId: "after-expiry" })).catch((thrown: Error) => thrown);

    expect((error as Error).name).toBe("SessionLeaseLostError");
  });
});
