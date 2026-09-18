import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import type { SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function harness() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  return createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
}

/** Counts how many provider calls of these kinds were in flight at once. */
function watchConcurrency(h: TelephonyHarness, methods: string[]) {
  const state = { inFlight: 0, peak: 0 };
  const client = h.telnyx.client as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  for (const method of methods) {
    const original = client[method].bind(h.telnyx.client);
    client[method] = async (input: unknown) => {
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      // Yield so a caller that awaits sequentially can never reach a peak of
      // two: the peak is real overlap, not scheduling noise.
      try { await Promise.resolve(); return await original(input); } finally { state.inFlight -= 1; }
    };
  }
  return state;
}

async function ringingInbound(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  expect(h.session(call.sessionId).state).toBe("ringing");
  return call;
}

describe("overlapping provider calls", () => {
  it("sends the stop and the losers' hangups together instead of one behind the other", async () => {
    const h = harness();
    const call = await ringingInbound(h);
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const runs: number[] = [];
    const client = h.telnyx.client as unknown as Record<string, (input: never) => Promise<unknown>>;
    const many = client.callActionMany.bind(h.telnyx.client);
    client.callActionMany = async (list: never) => {
      runs.push((list as unknown[]).length);
      return many(list);
    };

    await h.legEvent(winner, "call.answered");

    // One music stop and two losing operators: three best-effort calls that
    // used to queue behind each other, each with its own provider timeout and
    // its own fence. They go as one run now, which is both the overlap and the
    // single journal.
    expect(h.telnyx.of("hangup").length + h.telnyx.of("playbackStop").length).toBeGreaterThanOrEqual(3);
    expect(runs.some((size) => size > 1)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("bridge")).toHaveLength(1);
  });

  it("keeps the bridge itself out of the run", async () => {
    const h = harness();
    const call = await ringingInbound(h);
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const seen = watchConcurrency(h, ["bridge"]);

    await h.legEvent(winner, "call.answered");

    // The bridge carries a compensation and, with recording on, participant
    // observation. It is the one command the caller is waiting for; it keeps
    // its own turn.
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(seen.peak).toBe(1);
  });

  it("keeps a recorded call sequential", async () => {
    vi.stubEnv("TELNYX_RECORDING_ENABLED", "true");
    vi.stubEnv("TELNYX_RECORDING_CONTRACT_VERIFIED", "true");
    const h = harness();
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true,
      approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
    const call = await ringingInbound(h);
    const meta = h.session(call.sessionId).metadata as Record<string, unknown>;
    const recording = meta.recording as { policy: Record<string, unknown> } | undefined;
    if (recording) {
      h.db.update("motorist_call_sessions",
        { metadata: { ...meta, recording: { ...recording, policy: { ...recording.policy, enabled: true } } } },
        row => row.id === call.sessionId);
    }
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const seen = watchConcurrency(h, ["playbackStop", "hangup"]);

    await h.legEvent(winner, "call.answered");

    // Capture state is read and written around audio commands, so nothing here
    // may overlap.
    expect(seen.peak).toBeLessThanOrEqual(1);
  });

  it("still reports a best-effort failure and leaves the rest of the run alone", async () => {
    const h = harness();
    const call = await ringingInbound(h);
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    h.telnyx.failNext("playbackStop", "Telnyx refused the playback stop");

    await h.legEvent(winner, "call.answered");

    expect(h.session(call.sessionId).state).toBe("talking");
    const audited = h.rows("motorist_call_events")
      .flatMap(row => ((row.normalized_payload as { commands?: { kind: string; ok: boolean; error?: string }[] } | null)?.commands) ?? []);
    expect(audited.filter(command => !command.ok).map(command => command.kind)).toContain("playback_stop");
    // The losing operators were still hung up: one best-effort failure does not
    // take the rest of the run with it, and the call is not ended.
    expect(h.telnyx.of("hangup").length).toBeGreaterThanOrEqual(2);
    expect((h.session(call.sessionId) as SessionRow).ended_at).toBeNull();
  });

  it("journals the teardown run once, not once per command", async () => {
    const h = harness();
    const call = await ringingInbound(h);
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const from = h.db.log.length;

    await h.legEvent(winner, "call.answered");

    // A stop and two losing legs: three fences and three records, for commands
    // that have no bookkeeping between them at all.
    const rows = h.db.log.slice(from);
    const batched = rows.filter((row) => /provider_command_(prepare|result)_batch_v2/.test(row.table)).length;
    expect(batched).toBeGreaterThanOrEqual(2);
    expect(h.session(call.sessionId).state).toBe("talking");
  });
});
