import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { getRecentConnectionOutcomes } from "../connection-outcomes";
import { getTelephonyHealth } from "../health";
import { alertsFromReport } from "../alerts";
import { processTelnyxEvent } from "../telnyx/event-processor";
import { encodeClientState } from "../telnyx/client-state";
import { readPendingEffects } from "./continuation";
import type { SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function setup(recording = false) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED"]) vi.stubEnv(key, String(recording));
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false, now: "2026-10-09T15:14:28.000Z" });
  // The callback RPC has separate SQL tests; retain its durable obligation in this journey.
  h.db.registerRpc("motorist_create_callback_obligation_v1", args =>
    h.rows("motorist_callback_requests").find(row => row.session_id === args.p_session_id) ?? h.db.insert("motorist_callback_requests", {
      organization_id: args.p_organization_id, session_id: args.p_session_id,
      caller_number: (args.p_plan as { callerNumber: string }).callerNumber, source: "missed", status: "open", metadata: {},
    })[0]);
  if (recording) h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true,
    approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true });
  const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
  const work: Array<() => Promise<void>> = [];
  h.deps.deferMaintenance = task => { work.push(task); };
  const answer = h.envelope("call.answered", { call_control_id: call.callControlId, call_session_id: call.telnyxSessionId,
    client_state: encodeClientState(h.clientStateOf(call.callControlId)), direction: "incoming", state: "answered" }, "setup-answer");
  const outcomes = () => getRecentConnectionOutcomes({ admin: h.admin, organizationId: ORG, since: "2026-10-09T15:00:00Z" });
  const timeout = () => h.db.failNext("motorist_provider_command_prepare_v2", "rpc", {
    code: "", message: "AbortError: owned database request exceeded 4000 ms", details: null, hint: null,
  });
  return { h, call, answer, work, outcomes, timeout };
}

describe("bounded recovery of initial call setup", () => {
  it.each([false, true])("recovers pre-dispatch greeting timeout without cron, recording=%s", async recording => {
    const { h, call, answer, work, outcomes, timeout } = await setup(recording);
    timeout();
    expect(await h.process(answer)).toMatchObject({ outcome: "failed" });
    expect(h.telnyx.of("playbackStart")).toHaveLength(0);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.session(call.sessionId).lease_token).toBeNull();
    expect(work).toHaveLength(1);
    expect((await outcomes()).entries).toEqual([expect.objectContaining({ outcome: "pending" })]);

    await work.shift()!();
    const prompt = h.telnyx.of("playbackStart")[0];
    expect(h.telnyx.of("playbackStart")).toHaveLength(1);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    expect((await outcomes()).entries[0].outcome).toBe("command_recovered");

    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: prompt.params.clientState });
    const dialCount = h.telnyx.of("dial").length;
    expect(dialCount).toBeGreaterThan(0);
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: prompt.params.clientState });
    expect(h.telnyx.of("dial")).toHaveLength(dialCount);
    expect((await outcomes()).entries[0].outcome).toBe("setup_recovered");
    const operator = h.legFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(operator.telnyx_call_control_id), "call.answered");
    expect(h.session(call.sessionId).answered_at).toBeTruthy();
    expect(h.telnyx.of("recordingStart").length > 0).toBe(recording);
  });

  it("keeps the Oct9 missed setup actionable after hangup and a late processed ledger replay", async () => {
    const { h, call, answer, work, outcomes, timeout } = await setup();
    timeout();
    // Persist the failure obligation even when its first audit INSERT is lost.
    h.db.failNext("motorist_call_events", "insert", "audit temporarily unavailable");
    await h.process(answer);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries[0].failureAudit?.recorded).not.toBe(true);
    h.advance(52_000);
    const result = await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    expect(result.error).toBeFalsy();
    expect(h.call(call.sessionId)).toMatchObject({ status: "missed", end_reason: "caller_hangup" });
    await work.shift()!();
    h.advance(5 * 60_000);
    await processTelnyxEvent({ ...h.deps, ledgerReplay: "cron", deferMaintenance: undefined }, answer);
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "setup-answer")?.status).toBe("processed");
    expect(h.telnyx.of("playbackStart")).toHaveLength(0);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect((await outcomes()).entries).toEqual([expect.objectContaining({ sessionId: call.sessionId, outcome: "setup_failed" })]);
    const report = await getTelephonyHealth({ admin: h.admin, organizationId: ORG, config: h.deps.config, now: h.now });
    expect(report.checks.find(check => check.key === "connections")).toMatchObject({ status: "fail", detail: { setupFailed: 1 } });
    expect(alertsFromReport(report, "2026-10-09").some(alert => alert.check === "connections" && alert.status === "fail")).toBe(true);
  });

  it("does not resend or replace a greeting whose provider acceptance is unknown", async () => {
    const { h, answer, work, outcomes } = await setup();
    h.telnyx.loseNextResponse("playbackStart");
    await h.process(answer);
    expect(h.telnyx.of("playbackStart")).toHaveLength(1);
    await work.shift()!();
    expect(h.telnyx.of("playbackStart")).toHaveLength(1);
    expect(h.telnyx.of("speak")).toHaveLength(0);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect((await outcomes()).entries[0].outcome).toBe("pending");
  });

  it("uses immutable accepted evidence after the response checkpoint times out", async () => {
    const { h, answer, work, outcomes } = await setup();
    const record = h.db.rpcHandlers.get("motorist_provider_command_result_v2")!;
    let lose = true;
    h.db.registerRpc("motorist_provider_command_result_v2", async (args, db) => {
      const result = await record(args, db);
      if (lose) { lose = false; throw new Error("response checkpoint timeout"); }
      return result;
    });
    await h.process(answer);
    expect(h.telnyx.of("playbackStart")).toHaveLength(1);
    await work.shift()!();
    expect(h.telnyx.of("playbackStart")).toHaveLength(1);
    expect(h.telnyx.of("speak")).toHaveLength(0);
    expect((await outcomes()).entries[0].outcome).toBe("command_recovered");
  });

  it("yields recovery to another owner instead of dispatching concurrently", async () => {
    const { h, call, answer, work, timeout } = await setup();
    timeout();
    await h.process(answer);
    h.db.update("motorist_call_sessions", { lease_token: "other-owner", lease_until: new Date(h.now().getTime() + 60_000).toISOString() }, row => row.id === call.sessionId);
    await work.shift()!();
    expect(h.telnyx.of("playbackStart")).toHaveLength(0);
    expect(h.session(call.sessionId).lease_token).toBe("other-owner");
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toHaveLength(1);
  });

  it("leaves recovery durable when retained maintenance starts after its time budget", async () => {
    const { h, call, answer, work, timeout } = await setup();
    timeout();
    await h.process(answer);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 21_000);
    await work.shift()!();
    expect(h.telnyx.of("playbackStart")).toHaveLength(0);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toHaveLength(1);
  });
});
