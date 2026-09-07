import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { blindTransfer, createRateLimiter, startOutboundCall } from "../call-actions";
import { runSessionEvent } from "../session-runner";
import { TelnyxCommandError } from "../telnyx/client";
import { readMeta, type SessionRow } from "./types";

afterEach(() => vi.unstubAllEnvs());
function harness() {
  for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(key, "true");
  const h = createTelephonyHarness();
  h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  return h;
}
async function ringing(h: TelephonyHarness) {
  const call = await h.inbound(); await completeCallAnnouncements(h, call.sessionId);
  return { ...call, operator: String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id) };
}
async function sweep(h: TelephonyHarness, id: string) {
  h.advance(2000);
  await runSessionEvent(h.deps, id, { kind: "app", id: "recover-connection", type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
}
const pending = (h: TelephonyHarness, id: string) => readMeta(h.session(id) as SessionRow).recording?.pendingAudio;

describe("recorded customer conference connection", () => {
  it("connects an inbound operator only after the notice, recorder and customer membership", async () => {
    const h = harness(), call = await ringing(h);
    await h.legEvent(call.operator, "call.answered");
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(h.telnyx.of("createConference")[0].params.callControlId).toBe(call.callControlId);
    expect(h.telnyx.of("conference:join")[0].params).toMatchObject({ call_control_id: call.operator, end_conference_on_exit: false, hold: false, mute: false });
    const methods = h.telnyx.calls.map(x => x.method);
    expect(methods.indexOf("recordingStart")).toBeLessThan(methods.indexOf("createConference"));
    expect(h.session(call.sessionId).conference_id).toBeTruthy();
    expect(pending(h, call.sessionId)).toBeNull();
  });

  it("uses the same customer anchor for outbound calls after their privacy notice", async () => {
    const h = harness();
    const call = await startOutboundCall({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) }, { profileId: PROFILES.o1, role: "dispatcher" }, { to: "+421905123456" });
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const customer = h.legs(call.sessionId).find(x => x.role === "customer")!;
    await h.legEvent(String(customer.telnyx_call_control_id), "call.answered", { direction: "outgoing" });
    expect(h.telnyx.of("createConference")).toHaveLength(0);
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.telnyx.of("createConference")[0].params.callControlId).toBe(customer.telnyx_call_control_id);
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(pending(h, call.sessionId)).toBeNull();
  });

  it("retains a partially created conference and retries only the stable operator join", async () => {
    const h = harness(), call = await ringing(h);
    h.telnyx.failNext("conference:join", new TelnyxCommandError({ code: "timeout", status: 504 }));
    await h.legEvent(call.operator, "call.answered");
    expect(h.session(call.sessionId).conference_id).toBeTruthy();
    expect(pending(h, call.sessionId)?.commands).toHaveLength(1);
    expect(h.telnyx.of("hangup").some(x => x.params.callControlId === call.operator)).toBe(false);
    await sweep(h, call.sessionId);
    expect(h.telnyx.of("createConference")).toHaveLength(1);
    expect(h.telnyx.of("conference:join")[0].params.commandId).toBe(h.telnyx.of("conference:join")[1].params.commandId);
    expect(pending(h, call.sessionId)).toBeNull();
    expect(h.telnyx.of("bridge")).toHaveLength(0);
  });

  it("recovers a lost create response by the exact connection name", async () => {
    const h = harness(), call = await ringing(h), create = h.telnyx.client.createConference.bind(h.telnyx.client), request = h.telnyx.client.request.bind(h.telnyx.client);
    let found: { id: string; name: string | null } | undefined;
    vi.spyOn(h.telnyx.client, "createConference").mockImplementation(async p => { found = await create(p); throw new TelnyxCommandError({ code: "timeout", status: 504 }); });
    vi.spyOn(h.telnyx.client, "request").mockImplementation(async (method, path, options) => path === "/conferences" ? { data: [{ id: "foreign", name: "foreign" }, found] } as never : request(method, path, options));
    await h.legEvent(call.operator, "call.answered");
    expect(h.session(call.sessionId).conference_id).toBe(found?.id);
    expect(pending(h, call.sessionId)).toBeNull();
    expect(h.telnyx.of("bridge")).toHaveLength(0);
  });

  it("does not reconnect after an objection or hangup races with create", async () => {
    for (const reason of ["objection", "hangup"]) {
      const h = harness(), call = await ringing(h), create = h.telnyx.client.createConference.bind(h.telnyx.client);
      vi.spyOn(h.telnyx.client, "createConference").mockImplementation(async p => {
        const response = await create(p), session = h.session(call.sessionId) as SessionRow, meta = readMeta(session);
        h.db.update("motorist_call_sessions", { version: session.version + 1, ...(reason === "hangup" ? { ended_at: h.now().toISOString() } : {}), metadata: { ...meta, recording: { ...meta.recording!, epoch: meta.recording!.epoch + 1, suppressionReason: "objection", pendingAudio: null } } }, row => row.id === call.sessionId);
        return response;
      });
      await h.legEvent(call.operator, "call.answered");
      expect(h.telnyx.of("conference:join")).toHaveLength(0);
      expect(h.telnyx.of("bridge")).toHaveLength(0);
      expect(pending(h, call.sessionId)).toBeNull();
    }
  });

  it("retains the stable create command if its database checkpoint fails", async () => {
    const h = harness(), call = await ringing(h), create = h.telnyx.client.createConference.bind(h.telnyx.client);
    let response: Awaited<ReturnType<typeof create>> | undefined;
    const attempts: string[] = [];
    vi.spyOn(h.telnyx.client, "createConference").mockImplementation(async p => {
      attempts.push(p.commandId!);
      if (!response) { response = await create(p); h.db.failNext("motorist_call_sessions", "update", "checkpoint unavailable"); }
      return response;
    });
    await h.legEvent(call.operator, "call.answered");
    expect(h.telnyx.of("conference:join")).toHaveLength(0);
    expect(pending(h, call.sessionId)?.commands).toHaveLength(1);
    await sweep(h, call.sessionId);
    expect(attempts).toHaveLength(2); expect(attempts[0]).toBe(attempts[1]);
    expect(h.session(call.sessionId).conference_id).toBe(response?.id);
    expect(pending(h, call.sessionId)).toBeNull();
  });

  it("cancels the delayed join when the operator leg ends during membership confirmation", async () => {
    const h = harness(), call = await ringing(h), request = h.telnyx.client.request.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "request").mockImplementation(async (method, path, options) => {
      const response = await request(method, path, options);
      if (path.endsWith("/participants")) h.db.update("motorist_call_legs", { state: "ended", ended_at: h.now().toISOString() }, row => row.telnyx_call_control_id === call.operator);
      return response;
    });
    await h.legEvent(call.operator, "call.answered");
    expect(h.telnyx.of("conference:join")).toHaveLength(0);
    expect(h.telnyx.of("bridge")).toHaveLength(0);
  });

  it("does not accept an acknowledgement without actual joined membership", async () => {
    const h = harness(), call = await ringing(h);
    vi.spyOn(h.telnyx.client, "request").mockResolvedValue({ data: [] });
    await h.legEvent(call.operator, "call.answered");
    expect(h.telnyx.of("conference:join")).toHaveLength(0);
    expect(pending(h, call.sessionId)?.commands).toHaveLength(1);
    expect(h.telnyx.client.request).toHaveBeenCalledTimes(8);
  });

  it("leaves the previous conference when a blind transfer clears its stored id", async () => {
    const h = harness(), call = await ringing(h);
    await h.legEvent(call.operator, "call.answered");
    const conferenceId = h.session(call.sessionId).conference_id;
    await blindTransfer(h.deps, { profileId: PROFILES.o1, role: "dispatcher" }, call.sessionId, { profileId: PROFILES.o2 });
    await completeCallAnnouncements(h, call.sessionId);
    expect(h.telnyx.of("conference:leave").some(x => x.params.conferenceId === conferenceId && x.params.call_control_id === call.callControlId)).toBe(true);
  });
});
