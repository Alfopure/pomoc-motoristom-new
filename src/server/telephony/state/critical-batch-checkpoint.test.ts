import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { runPendingEffectRecovery } from "../cron-jobs";
import { readPendingEffects } from "./continuation";
import { readMeta, toJson, type SessionRow } from "./types";

afterEach(() => vi.unstubAllEnvs());

/** Contract 2 is what production runs; only there do continuations checkpoint at all. */
function durableHarness() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  return createTelephonyHarness({ sweepAfterEvent: false });
}

const recover = (h: TelephonyHarness) => runPendingEffectRecovery(h.deps);

describe("critical batch checkpoint", () => {
  it("writes one checkpoint for the whole critical batch instead of one per effect", async () => {
    const h = durableHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const before = h.db.log.length;

    await h.legEvent(winner, "call.answered");

    // The answer writes the winner leg, three attempts and two loser presence
    // rows. Those used to cost six fenced session UPDATEs; now the batch is
    // retired once, before the first provider command runs.
    const sessionWrites = h.db.log.slice(before).filter(row => row.table === "motorist_call_sessions" && row.operation === "update");
    expect(sessionWrites.length).toBeLessThanOrEqual(9);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("bridge")).toHaveLength(1);
  });

  it("keeps the answer inside its measured request budget", async () => {
    const h = durableHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const before = h.db.log.length;

    await h.legEvent(winner, "call.answered");

    // Measured on this harness: 80 requests before the read deduplication and
    // the batched checkpoint, 69 after. The bound is a regression guard, not a
    // target — lower it when the next stage actually lowers the count.
    expect(h.db.log.length - before).toBeLessThanOrEqual(72);
  });

  it("replays the whole batch idempotently when the checkpoint never lands", async () => {
    const h = durableHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const telnyxBefore = h.telnyx.calls.length;
    // The batch runs, then the single checkpoint that retires it is lost: the
    // exact window the batching introduces. Commands come after it, so nothing
    // reached the provider.
    h.db.failNext("motorist_call_sessions", "update", "checkpoint unavailable");

    await expect(h.legEvent(winner, "call.answered")).resolves.toMatchObject({ outcome: "failed" });
    expect(h.telnyx.calls.slice(telnyxBefore)).toHaveLength(0);
    const stalled = readPendingEffects(h.session(call.sessionId) as SessionRow).entries;
    expect(stalled).toHaveLength(1);
    // Rewind the cursor to the start of the batch: this is exactly the window
    // batching opens — every effect ran, the one checkpoint that retires them
    // did not. The replay must repeat all six without a duplicate.
    expect(stalled[0].databaseCursor).toBeGreaterThan(0);
    h.db.update("motorist_call_sessions",
      { pending_effects: toJson({ version: 1, entries: stalled.map(entry => ({ ...entry, databaseCursor: 0 })) }) },
      row => row.id === call.sessionId);

    h.advance(31_000);
    const recovered = await recover(h);
    expect(recovered.status).not.toBe("failed");

    // Idempotent replay: the same rows, and every loser released exactly once.
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.legs(call.sessionId).filter(leg => leg.telnyx_call_control_id === winner)).toHaveLength(1);
    expect(h.attempts(call.sessionId).filter(a => a.result === "answered")).toHaveLength(1);
    for (const loser of [PROFILES.o2, PROFILES.o5]) {
      const history = h.rows("motorist_operator_statuses").filter(row => row.profile_id === loser && row.status === "available");
      expect(history).toHaveLength(1);
    }
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(readMeta(h.session(call.sessionId) as SessionRow).ring?.active_step ?? null).toBeNull();
  });
});
