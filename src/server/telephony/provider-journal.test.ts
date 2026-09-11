import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { SessionLeaseLostError } from "./service-errors";
import { sessionOwnership, type Ownership } from "./ownership";
import { createTelnyxClient } from "./telnyx/client";
import { createTelephonyHarness, NUMBERS } from "@/test/telephony-harness";
import { effectsDeps, runSessionEvent } from "./session-runner";
import { applyReduceResult } from "./state/effects";
import { parseTelnyxEnvelope } from "./state/events";
import { emptyTransition, readMeta, type Command, type SessionRow } from "./state/types";
import { getTelnyxConfig } from "./telnyx/env";
import { journalRequest, payloadFingerprint, ProviderOutcomeUnknownError } from "./provider-journal";

function harness() {
  let generation = 1;
  let failEvidence = false;
  const journal = new Map<string, { fingerprint: string; generation: number; outcome: string; result?: unknown }>();
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "motorist_session_lease_renew_v2") return { data: args.p_generation === generation, error: null };
    const id = String(args.p_command_id);
    if (name === "motorist_provider_command_prepare_v2") {
      const prior = journal.get(id);
      if (prior) {
        if (prior.fingerprint !== args.p_fingerprint) return { data: null, error: { message: "payload identity conflict", code: "PT409" } };
        return { data: { ...prior, dispatch: false }, error: null };
      }
      journal.set(id, { fingerprint: String(args.p_fingerprint), generation, outcome: "unknown" });
      return { data: { dispatch: true }, error: null };
    }
    if (name === "motorist_provider_command_result_v2") {
      if (failEvidence) return { data: null, error: { message: "database unavailable" } };
      const prior = journal.get(id)!;
      expect(args.p_generation).toBe(prior.generation);
      const status = Number(args.p_status);
      prior.outcome = status < 300 ? "accepted" : status === 429 ? "rate_limited" : status < 500 && status !== 408 ? "rejected" : "unknown";
      prior.result = args.p_result;
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const admin = { rpc } as unknown as SupabaseClient<Database>;
  const owner = (): Ownership => ({ admin, sessionId: "session", organizationId: "org", token: `token-${generation}`, generation, contract: 2, deadline: Date.now() + 24_000 });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { call_control_id: "exact-leg", call_leg_id: "leg", call_session_id: "provider-session", is_alive: true } }), { status: 200 }));
  const client = createTelnyxClient({ config: getTelnyxConfig({ TELNYX_API_KEY: "test", TELNYX_CALL_CONTROL_APP_ID: "app", TELNYX_API_BASE_URL: "https://telnyx.test/v2" }), liveGate: { callsEnabled: true, smsEnabled: false }, fetch });
  const dial = () => client.dial({ commandId: "dial", to: "+421900000001", from: "+421900000002" });
  return { client, dial, owner, fetch, journal, rpc, takeover: () => { generation++; }, failEvidence: () => { failEvidence = true; } };
}

describe("provider HTTP journal recovery", () => {
  it("preserves distinct absent and empty wire bodies while storing an object payload", () => {
    const h = harness();
    sessionOwnership.run(h.owner(), () => {
      const absent = journalRequest("POST", "/calls/leg/actions/hangup", "hangup", undefined)!;
      const empty = journalRequest("POST", "/calls/leg/actions/hangup", "hangup", "{}")!;
      expect(absent.payload).toEqual({});
      expect(empty.payload).toEqual({});
      expect(absent.correlationState).toBeNull();
      expect(absent.fingerprint).not.toBe(empty.fingerprint);
      expect(absent.fingerprint).toBe(payloadFingerprint({ method: "POST", path: absent.path, body: null }));
      const correlated = journalRequest("POST", "/calls", "dial", '{"to":"sip:operator@example.invalid","client_state":"exact-state"}')!;
      expect(correlated.payload).toEqual({ to: "sip:operator@example.invalid", client_state: "exact-state" });
      expect(correlated.correlationState).toBe("exact-state");
      expect(() => journalRequest("POST", "/calls", null, "{}")).toThrow("lacks a stable command identity");
    });
    expect(sessionOwnership.run({ ...h.owner(), contract: 1 }, () => journalRequest("POST", "/calls", null, "{}"))).toBeNull();
  });

  it("adopts provider acceptance when the later effects checkpoint failed", async () => {
    const h = harness();
    await expect(sessionOwnership.run(h.owner(), async () => {
      expect((await h.dial()).callControlId).toBe("exact-leg");
      throw new Error("effects checkpoint lost");
    })).rejects.toThrow("effects checkpoint lost");
    h.takeover();
    const adopted = await sessionOwnership.run(h.owner(), h.dial);
    expect(adopted.callControlId).toBe("exact-leg");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("never redials when provider acceptance could not be stored", async () => {
    const h = harness();
    h.failEvidence();
    await expect(sessionOwnership.run(h.owner(), h.dial)).rejects.toThrow("database unavailable");
    h.takeover();
    await expect(sessionOwnership.run(h.owner(), h.dial)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([61_000, 301_000])("does not blindly dial an unknown outcome after %d ms", async age => {
    const h = harness();
    h.fetch.mockRejectedValueOnce(new Error("response lost"));
    await expect(sessionOwnership.run(h.owner(), h.dial)).rejects.toMatchObject({ code: "network" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + age);
    try {
      h.takeover();
      await expect(sessionOwnership.run(h.owner(), h.dial)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
      expect(h.fetch).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });

  it("retains an in-flight result after takeover but fences the old owner's next command", async () => {
    const h = harness();
    const original = h.owner();
    h.fetch.mockImplementationOnce(async () => {
      h.takeover();
      return new Response(JSON.stringify({ data: { call_control_id: "late-leg" } }), { status: 200 });
    });
    await sessionOwnership.run(original, async () => {
      expect((await h.dial()).callControlId).toBe("late-leg");
      await expect(h.client.hangup({ callControlId: "other-leg", commandId: "old-next" })).rejects.toMatchObject({ name: "SessionLeaseLostError" });
    });
    expect(h.journal.get("dial")).toMatchObject({ generation: 1, outcome: "accepted" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("journals conference hold without adding an undocumented provider command_id", async () => {
    const h = harness();
    await sessionOwnership.run(h.owner(), () => h.client.conferenceAction("conference", "hold", { commandId: "hold", call_control_ids: ["leg"] }));
    h.takeover();
    await sessionOwnership.run(h.owner(), () => h.client.conferenceAction("conference", "hold", { commandId: "hold", call_control_ids: ["leg"] }));
    expect(h.journal.get("hold")).toMatchObject({ outcome: "accepted" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ call_control_ids: ["leg"] }) }));
  });

  it("rejects a stable command ID reused with a different destination", async () => {
    const h = harness();
    await sessionOwnership.run(h.owner(), h.dial);
    h.takeover();
    await expect(sessionOwnership.run(h.owner(), () => h.client.dial({ commandId: "dial", to: "+421900000099", from: "+421900000002" }))).rejects.toThrow("payload identity conflict");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});


describe("contract2 media fallback boundary", () => {
  const cases = (["playback_start", "gather"] as const).flatMap(kind =>
    (["lost", "lease", 408, 429, 500, 422] as const).map(status => ({ kind, status })));
  it.each(cases)("keeps $kind recovery within the $status outcome contract", async ({ kind, status }) => {
    const provider = harness();
    const call = createTelephonyHarness({ sweepAfterEvent: false });
    const inbound = await call.inbound({ answer: false });
    const row = call.db.storage("motorist_call_sessions").find(row => row.id === inbound.sessionId)!;
    row.writer_contract = 2;
    const command: Command = kind === "playback_start"
      ? { kind, commandId: "media-command", leg: { callControlId: inbound.callControlId }, media: { key: "greeting" } }
      : { kind, commandId: "media-command", leg: { callControlId: inbound.callControlId }, spec: { media: { key: "ivrMain" }, purpose: "ivr" }, clientState: { sid: inbound.sessionId, role: "customer", intent: "ivr" } };
    const owner = { ...provider.owner(), sessionId: inbound.sessionId };
    if (status === "lost") provider.fetch.mockRejectedValueOnce(new Error("provider accepted media; response lost"));
    else if (status === "lease") vi.spyOn(provider.client, kind === "playback_start" ? "playbackStart" : "gatherUsingAudio").mockRejectedValueOnce(new SessionLeaseLostError());
    else provider.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ code: "10000", detail: "media request rejected" }] }),
      { status, headers: status === 429 ? { "retry-after": "30" } : undefined }));
    const run = () => {
      const session = call.session(inbound.sessionId) as SessionRow;
      return applyReduceResult({ ...effectsDeps(call.deps), telnyx: provider.client, mediaBaseUrl: "https://audio.test" }, {
        session, expectedVersion: session.version,
        event: { kind: "app", type: "sweep", id: "media-event", actorProfileId: null, occurredAt: call.now().toISOString() },
        result: { next: emptyTransition(), commands: [command], compensations: [], guard: null, ignored: null },
      });
    };
    if (status === "lease") {
      await expect(sessionOwnership.run(owner, run)).rejects.toBeInstanceOf(SessionLeaseLostError);
      expect(provider.fetch).not.toHaveBeenCalled();
      return;
    }
    expect((await sessionOwnership.run(owner, run)).failed).toBe(status !== 422);
    expect((await sessionOwnership.run(owner, run)).failed).toBe(status !== 422);
    expect(provider.fetch).toHaveBeenCalledTimes(status === 422 ? 2 : 1);
    expect(provider.journal.size).toBe(status === 422 ? 2 : 1);
    expect(provider.journal.get("media-command")?.outcome).toBe(status === 422 ? "rejected" : status === 429 ? "rate_limited" : "unknown");
  });
});


it("keeps an unknown IVR gather pending through the runner without routing or issuing more media", async () => {
  const provider = harness();
  const h = createTelephonyHarness({ sweepAfterEvent: false });
  const call = await h.inbound({ to: NUMBERS.neutral, completeGreeting: false });
  h.db.storage("motorist_call_sessions").find(row => row.id === call.sessionId)!.writer_contract = 2;
  const intro = h.telnyx.of("playbackStart").at(-1)!;
  const event = parseTelnyxEnvelope(h.envelope("call.playback.ended", {
    call_control_id: call.callControlId, status: "completed", client_state: intro.params.clientState,
  }, "intro-completed"));
  if (!event) throw new Error("invalid fixture event");
  provider.fetch.mockRejectedValueOnce(new Error("gather accepted; response lost"));
  const owner = { ...provider.owner(), sessionId: call.sessionId, organizationId: h.deps.organizationId };
  const deps = { ...h.deps, telnyx: provider.client };
  const first = await sessionOwnership.run(owner, () => runSessionEvent(deps, call.sessionId, event));
  expect(first).toMatchObject({ outcome: "applied", apply: { failed: true } });
  expect(h.session(call.sessionId).state).toBe("ivr");
  const gather = readMeta(h.session(call.sessionId) as SessionRow).gather!;
  expect(gather.failed).not.toBe(true);
  expect(Date.parse(gather.deadline_at)).toBeGreaterThan(h.now().getTime());
  await sessionOwnership.run(owner, () => runSessionEvent(deps, call.sessionId, {
    kind: "app", type: "sweep", id: "immediate-media-recheck", actorProfileId: null, occurredAt: h.now().toISOString(),
  }));
  expect(h.session(call.sessionId).state).toBe("ivr");
  expect(provider.fetch).toHaveBeenCalledTimes(1);
  expect(h.telnyx.of("dial")).toHaveLength(0);
  expect([...provider.journal.values()].map(row => row.outcome)).toEqual(["unknown"]);
});
