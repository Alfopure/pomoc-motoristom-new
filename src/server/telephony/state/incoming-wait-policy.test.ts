import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingFlow, IncomingWaitPolicy } from "@/lib/telephony/incoming-flow";
import { defaultAnnouncementConfig } from "@/lib/telephony/announcements";
import { createTelephonyHarness, LINES, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { pickupWaitingCall } from "../call-actions";
import { runSessionEvent } from "../session-runner";
import { readMeta, type CallbackPlan, type SessionRow } from "./types";

const waitId = "00000000-0000-4000-8000-000000007801";
const ringId = "00000000-0000-4000-8000-000000007802";
const makeFlow = (policy?: IncomingWaitPolicy, minutes = 2): IncomingFlow => ({ version: 1, ending: "hangup", steps: [
  { id: waitId, type: "wait", minutes, ...(policy ? { policy } : {}) },
  { id: ringId, type: "ring", seconds: 20, people: [{ profileId: PROFILES.o1, application: true, personalNumber: null }] },
] });
const meta = (h: TelephonyHarness, id: string) => readMeta(h.session(id) as SessionRow);
const lastGather = (h: TelephonyHarness) => h.telnyx.calls.filter(command => ["gather", "gatherUsingAudio", "gatherUsingSpeak"].includes(command.method)).at(-1)!;
const complete = (h: TelephonyHarness, cc: string, state: unknown = lastGather(h).params.clientState, digits = "") =>
  h.legEvent(cc, "call.gather.ended", { status: digits ? "valid" : "timeout", digits, client_state: state });
const sweep = (h: TelephonyHarness, id: string) => runSessionEvent(h.deps, id, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });

beforeEach(() => {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network forbidden in waiting policy QA"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function setup(policy?: IncomingWaitPolicy, minutes = 2, options: { anonymous?: boolean; customAudio?: boolean } = {}) {
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.db.registerRpc("motorist_create_callback_obligation_v1", args => {
    const plan = args.p_plan as CallbackPlan;
    return h.rows("motorist_callback_requests").find(row => row.session_id === args.p_session_id) ?? h.db.insert("motorist_callback_requests", {
      organization_id: args.p_organization_id, session_id: args.p_session_id, caller_number: plan.callerNumber,
      source: plan.source, status: "open", metadata: plan.request ? { request: plan.request } : {},
    })[0];
  });
  const announcements = defaultAnnouncementConfig();
  if (options.customAudio) announcements.prompts.sk = { queueWaiting: { text: "Pre spätné volanie stlačte jednotku.", audioUrl: "https://audio.test/short-queue.mp3", voiceId: announcements.voiceId } };
  h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: makeFlow(policy, minutes), ...(options.customAudio ? { announcements } : {}) } }, row => row.id === LINES.allianz);
  const inbound = () => h.inbound({ to: NUMBERS.allianz, ...(options.anonymous ? { from: "anonymous" } : {}) });
  return { h, inbound };
}

describe("per-step waiting room audio policy", () => {
  it("preserves the combined minute-long callback prompt for an unchanged legacy wait", async () => {
    const { h, inbound } = setup();
    const call = await inbound();
    expect(lastGather(h)).toMatchObject({ method: "gatherUsingAudio", params: { audioUrl: expect.stringContaining("queueWaiting.mp3") } });
    expect(meta(h, call.sessionId).waiting?.audio_policy).toBeUndefined();
  });

  it("plays only music, ignores digit one without resetting the deadline and continues the next step", async () => {
    const { h, inbound } = setup({ mode: "music", intervalSeconds: 30 }, 1);
    const call = await inbound();
    const entered = meta(h, call.sessionId).waiting?.since;
    expect(lastGather(h).method).toBe("gather");
    expect(h.telnyx.of("gatherUsingAudio")).toHaveLength(0);
    expect(h.telnyx.of("gatherUsingSpeak")).toHaveLength(0);
    expect(h.telnyx.of("playbackStart").at(-1)?.params).toMatchObject({ audioUrl: expect.stringContaining("moh"), loop: "infinity" });
    h.advance(20_000);
    await complete(h, call.callControlId, undefined, "1");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(meta(h, call.sessionId).waiting?.since).toBe(entered);
    expect(lastGather(h).params.initialTimeoutMillis).toBe(40_000);
    h.advance(40_000);
    h.touchDevice(PROFILES.o1);
    await complete(h, call.callControlId);
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(1);
    expect(meta(h, call.sessionId).journey?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "step_enter", stepIndex: 0, phase: "waiting", at: entered }),
      expect.objectContaining({ kind: "step_exit", stepIndex: 0, reason: "wait_timeout" }),
      expect.objectContaining({ kind: "step_enter", stepIndex: 1, phase: "ringing" }),
    ]));
  });

  it.each([15, 30, 60] as const)("separates callback speech and %s seconds of music", async intervalSeconds => {
    const { h, inbound } = setup({ mode: "callback", intervalSeconds });
    const call = await inbound();
    expect(lastGather(h)).toMatchObject({ method: "gatherUsingSpeak", params: { payload: expect.stringContaining("jednotku") } });
    expect(meta(h, call.sessionId).waiting?.audio_phase).toBe("prompt");
    h.advance(8_000);
    await complete(h, call.callControlId);
    expect(lastGather(h)).toMatchObject({ method: "gather", params: { initialTimeoutMillis: intervalSeconds * 1_000 } });
    h.advance(intervalSeconds * 1_000);
    await complete(h, call.callControlId);
    expect(lastGather(h).method).toBe("gatherUsingSpeak");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it("keeps custom audio intact then plays the configured music interval", async () => {
    const { h, inbound } = setup({ mode: "callback", intervalSeconds: 15 }, 2, { customAudio: true });
    const call = await inbound();
    expect(lastGather(h)).toMatchObject({ method: "gatherUsingAudio", params: { audioUrl: "https://audio.test/short-queue.mp3" } });
    h.advance(20_000); // A prompt may itself last longer than the selected music gap.
    await complete(h, call.callControlId);
    expect(lastGather(h).params.initialTimeoutMillis).toBe(15_000);
  });

  it("announces waiting without offering or accepting callback, including after gather recovery", async () => {
    const { h, inbound } = setup({ mode: "announcement", intervalSeconds: 15 }, 3);
    const call = await inbound();
    expect(lastGather(h)).toMatchObject({ method: "gatherUsingAudio", params: { audioUrl: expect.stringContaining("holdReminder.mp3") } });
    await complete(h, call.callControlId, undefined, "1");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(lastGather(h).method).toBe("gather");
    h.advance(50_000);
    await sweep(h, call.sessionId);
    expect(lastGather(h).method).toBe("gather");
    await complete(h, call.callControlId, undefined, "1");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.telnyx.of("gatherUsingSpeak").some(command => String(command.params.payload).includes("jednotku"))).toBe(false);
  });

  it("does not promise a callback for a hidden number", async () => {
    const { h, inbound } = setup({ mode: "callback", intervalSeconds: 15 }, 1, { anonymous: true });
    const call = await inbound();
    expect(lastGather(h)).toMatchObject({ method: "gatherUsingAudio", params: { audioUrl: expect.stringContaining("holdReminder.mp3") } });
    await complete(h, call.callControlId, undefined, "1");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    h.advance(60_000); h.touchDevice(PROFILES.o1);
    await sweep(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("freezes mode and cadence while a line is edited", async () => {
    const { h, inbound } = setup({ mode: "announcement", intervalSeconds: 15 });
    const call = await inbound();
    h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: makeFlow({ mode: "callback", intervalSeconds: 60 }) } }, row => row.id === LINES.allianz);
    await complete(h, call.callControlId, undefined, "1");
    expect(lastGather(h).params.initialTimeoutMillis).toBe(15_000);
    expect(meta(h, call.sessionId).waiting?.audio_policy).toEqual({ mode: "announcement", intervalSeconds: 15 });
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it.each(["prompt", "music"])("records a real request during %s once and stops the route", async phase => {
    const { h, inbound } = setup({ mode: "callback", intervalSeconds: 15 });
    const call = await inbound();
    if (phase === "music") { h.advance(8_000); await complete(h, call.callControlId); }
    const gatherState = lastGather(h).params.clientState;
    const at = h.now().toISOString();
    await complete(h, call.callControlId, gatherState, "1");
    await complete(h, call.callControlId, gatherState, "1");
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    expect(h.rows("motorist_callback_requests")[0].metadata).toMatchObject({ request: { kind: "requested", digit: "1", context: "waiting_room", requested_at: at } });
    expect(meta(h, call.sessionId).journey?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "step_exit", stepIndex: 0, reason: "callback_requested" })]));
    h.advance(120_000); await sweep(h, call.sessionId);
    expect(h.telnyx.of("dial")).toHaveLength(0);
  });

  it.each(["answer", "callback"])("serializes simultaneous pickup and callback when %s wins", async winner => {
    const { h, inbound } = setup({ mode: "callback", intervalSeconds: 15 });
    const call = await inbound();
    const queueState = lastGather(h).params.clientState;
    await pickupWaitingCall(h.deps, { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId);
    const picker = h.openLegFor(call.sessionId, PROFILES.o2)!;
    const answer = () => h.legEvent(String(picker.telnyx_call_control_id), "call.answered");
    const callback = () => complete(h, call.callControlId, queueState, "1");
    if (winner === "answer") { await answer(); await callback(); }
    else { await callback(); await answer(); }
    expect(h.session(call.sessionId).state).toBe(winner === "answer" ? "talking" : "callback_offered");
    expect(h.rows("motorist_callback_requests")).toHaveLength(winner === "answer" ? 0 : 1);
    expect(h.telnyx.of("bridge")).toHaveLength(winner === "answer" ? 1 : 0);
  });

  it("does not accept an old wait choice after timeout or caller hangup", async () => {
    for (const end of ["timeout", "hangup"] as const) {
      const { h, inbound } = setup({ mode: "callback", intervalSeconds: 15 }, 1);
      const call = await inbound(); const oldGather = lastGather(h).params.clientState;
      if (end === "hangup") await h.legEvent(call.callControlId, "call.hangup");
      else { h.advance(60_000); h.touchDevice(PROFILES.o1); await sweep(h, call.sessionId); }
      await complete(h, call.callControlId, oldGather, "1");
      expect(h.rows("motorist_callback_requests").some(row => Boolean((row.metadata as { request?: unknown })?.request))).toBe(false);
      expect(h.session(call.sessionId).state).toBe(end === "timeout" ? "ringing" : "ended");
    }
  });

  it("records skipped steps without inventing a ringing interval", async () => {
    const { h, inbound } = setup({ mode: "music", intervalSeconds: 30 }, 1);
    h.setPresence(PROFILES.o1, { status: "offline" });
    const call = await inbound();
    h.advance(60_000);
    await complete(h, call.callControlId);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    const entries = meta(h, call.sessionId).journey!.entries.filter(entry => entry.stepIndex === 1);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "step_enter", stepIndex: 1, at: h.now().toISOString() }),
      expect.objectContaining({ kind: "step_exit", stepIndex: 1, reason: "no_eligible_members", at: h.now().toISOString() }),
    ]);
  });
});
