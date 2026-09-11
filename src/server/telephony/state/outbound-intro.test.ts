import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAnnouncementConfig } from "@/lib/telephony/announcements";
import { createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { callBackRequest } from "../callbacks";
import { createRateLimiter, startOutboundCall } from "../call-actions";
import { readMeta, type SessionRow } from "./types";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
afterEach(() => vi.unstubAllEnvs());

function deps(h: TelephonyHarness) {
  return { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) };
}

async function answerOutbound(h: TelephonyHarness, call: { sessionId: string; operatorLegCallControlId: string }) {
  await h.legEvent(call.operatorLegCallControlId, "call.answered");
  const customer = h.legs(call.sessionId).find((leg) => leg.role === "customer")!;
  await h.legEvent(String(customer.telnyx_call_control_id), "call.answered", { direction: "outgoing" });
  return String(customer.telnyx_call_control_id);
}

describe("outbound connection without service introduction", () => {
  it.each(["https://media.test/telephony", null])("connects on answer without media events when media base is %s", async (mediaBaseUrl) => {
    const h = createTelephonyHarness({ mediaBaseUrl });
    const announcements = defaultAnnouncementConfig();
    announcements.prompts.sk = { outboundIntro: { text: "Legacy saved introduction", audioUrl: "https://media.test/custom-outbound.mp3", voiceId: announcements.voiceId } };
    h.db.update("motorist_telephony_lines", { metadata: { announcements } }, (row) => row.id === LINES.allianz);
    const call = await startOutboundCall(deps(h), actor, { to: NUMBERS.customer });
    const customer = await answerOutbound(h, call);

    expect(h.telnyx.of("playbackStart")).toHaveLength(0);
    expect(h.telnyx.of("speak")).toHaveLength(0);
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.telnyx.of("bridge")[0].params).toMatchObject({ callControlId: customer, targetCallControlId: call.operatorLegCallControlId });
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence).toBeUndefined();

    await h.legEvent(customer, "call.answered", { direction: "outgoing" });
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.telnyx.of("playbackStart")).toHaveLength(0);
  });

  it.each([false, true])("connects callbacks without an introduction with stability=%s", async (stability) => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", String(stability));
    const h = createTelephonyHarness();
    const [request] = h.db.insert("motorist_callback_requests", {
      organization_id: ORG, caller_number: NUMBERS.customer, line_id: LINES.allianz,
      source: "missed", status: "open", created_at: h.now().toISOString(),
    });
    h.db.registerRpc("motorist_link_callback_outbound_v1", (args) => {
      h.db.update("motorist_callback_requests", { metadata: { callback_call: { session_id: args.p_session_id, by: actor.profileId, at: h.now().toISOString() } } }, (row) => row.id === request.id);
      return true;
    });
    const result = await callBackRequest(deps(h), actor, String(request.id));
    await answerOutbound(h, result.call);

    expect(result.linked).toBe(true);
    expect(h.session(result.call.sessionId)).toMatchObject({ direction: "outbound", state: "talking" });
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.telnyx.of("playbackStart")).toHaveLength(0);
    expect(h.telnyx.of("speak")).toHaveLength(0);
  });

  it.each([false, true])("retains only the recording notice before capture with quality=%s", async (quality) => {
    for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED"]) vi.stubEnv(key, "true");
    vi.stubEnv("TELNYX_RECORDING_CONFERENCE_VERIFIED", "false");
    const h = createTelephonyHarness();
    h.db.insert("motorist_call_recording_policies", {
      organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(),
      inbound_enabled: true, outbound_enabled: true, quality_enabled: quality, max_segment_seconds: 1800,
    });
    const call = await startOutboundCall(deps(h), actor, { to: NUMBERS.customer });
    const customer = await answerOutbound(h, call);
    const noticeKey = quality ? "recordingNotice" : "recordingServiceNotice";

    expect(readMeta(h.session(call.sessionId) as SessionRow).announcement_sequence?.keys).toEqual([noticeKey]);
    expect(h.telnyx.of("playbackStart")).toHaveLength(1);
    const notice = h.telnyx.of("playbackStart")[0];
    expect(notice.params.audioUrl).toContain(`/${noticeKey}.mp3`);
    expect(h.telnyx.of("recordingStart")).toHaveLength(0);
    expect(h.telnyx.of("bridge")).toHaveLength(0);

    await h.legEvent(customer, "call.playback.ended", { status: "completed", client_state: notice.params.clientState });

    expect(h.telnyx.of("playbackStart")).toHaveLength(1);
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    const methods = h.telnyx.calls.map((command) => command.method);
    expect(methods.indexOf("recordingStart")).toBeLessThan(methods.indexOf("bridge"));
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.noticeCompletedAt).toBeTruthy();
  });
});
