import { afterEach, describe, expect, it, vi } from "vitest";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { FAKE_TELNYX_ENV } from "@/test/fake-telnyx";
import { holdCall, parkCall, unholdCall } from "../call-actions";
import { sessionOwnership, type Ownership } from "../ownership";
import { readMeta, type SessionRow } from "../state/types";
import { createTelnyxClient } from "./client";
import { getTelnyxConfig } from "./env";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const env = { ...FAKE_TELNYX_ENV, MOTORIST_APP_ENV: "test", MOTORIST_TEST_LIVE_INTEGRATIONS: "true",
  MOTORIST_TEST_ALLOW_ANY_PHONE_NUMBER: "true", MOTORIST_TEST_FROM_NUMBERS: FAKE_TELNYX_ENV.TELNYX_DEFAULT_FROM_NUMBER,
  VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev", VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
  SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk" };

async function recordedControl(reuseOwnedProof: boolean) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
  for (const name of ["TELNYX_RECORDING_ENABLED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED",
    "TELNYX_RECORDING_CHANNELS_VERIFIED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED"]) vi.stubEnv(name, "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true,
    approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  const call = await h.inbound();
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, actor.profileId)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  expect((await h.legEvent(operator, "call.answered")).outcome).toBe("processed");
  for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== actor.profileId && !leg.ended_at) {
    await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  // The harness normally starts outbound legs without their initiated callback.
  // Provide its durable signed-origin evidence before installing the real HTTP adapter.
  await h.legEvent(operator, "call.initiated");
  const sent: Array<{ method: string; path: string }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(/^\/v2/, "");
    sent.push({ method: options?.method ?? "GET", path });
    const data = options?.method !== "GET" ? { result: "ok", recording_id: "new-recording" }
      : path.endsWith("/participants") ? h.legs(call.sessionId).filter(leg => !leg.ended_at)
        .map(leg => ({ call_control_id: leg.telnyx_call_control_id, status: "joined" }))
      : { connection_id: "app-test", is_alive: true };
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
  // A different trusted admin identity retains the original per-command proof
  // path. Its queries use the same database; it cannot borrow this owner's cache.
  const contextAdmin = reuseOwnedProof ? h.admin : new Proxy(h.admin, {});
  const client = createTelnyxClient({ config: getTelnyxConfig(env), liveGate: { callsEnabled: true, smsEnabled: false },
    fetch, testProvenanceContext: { admin: contextAdmin, organizationId: ORG } });
  h.deps.telnyx = client;
  const counts: Array<{ action: string; db: number; proofs: number }> = [];
  for (const [name, action] of [["hold", holdCall], ["unhold", unholdCall], ["park", parkCall]] as const) {
    const from = h.db.log.length;
    await action(h.deps, actor, call.sessionId);
    const rows = h.db.log.slice(from);
    counts.push({ action: name, db: rows.length, proofs: rows.filter(row => row.table === "motorist_telnyx_webhook_events" && row.operation === "select").length });
  }
  expect(h.session(call.sessionId).state).toBe("parked");
  expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.pendingAudio).toBeNull();
  const mutations = sent.filter(row => row.method === "POST").map(row => row.path);
  const stop = mutations.findIndex(path => path.endsWith("/record_stop"));
  const hold = mutations.findIndex(path => path.endsWith("/hold"));
  const start = mutations.findIndex(path => path.endsWith("/record_start"));
  const unhold = mutations.findIndex(path => path.endsWith("/unhold"));
  expect(stop).toBeGreaterThanOrEqual(0);
  expect(stop).toBeLessThan(hold);
  expect(start).toBeLessThan(unhold);
  expect(start).toBeGreaterThan(hold);
  return { counts, mutations, h, client, fetch };
}

describe("recorded TEST control provenance cost", () => {
  it("keeps real STOP/HOLD/START/UNHOLD/PARK commands while reusing only same-owner origin evidence", async () => {
    const baseline = await recordedControl(false);
    const optimized = await recordedControl(true);
    // Same provider/recording sequence; fewer projection and participant round
    // trips than the previously deployed 59 / 46 / 80 request fixture.
    expect(optimized.counts.map(row => row.db)).toEqual([53, 43, 71]);
    expect(optimized.mutations.map(path => path.split("/").at(-1))).toEqual(baseline.mutations.map(path => path.split("/").at(-1)));
    expect(optimized.counts.map(row => row.proofs)).toEqual([1, 1, 2]);
    expect(baseline.counts.map(row => row.proofs)).toEqual([3, 2, 6]);
    expect(optimized.counts.map((row, index) => baseline.counts[index].db - row.db)).toEqual([2, 1, 4]);
  });

  it("rechecks later ownership lifetimes and never keeps a missing origin as a reusable proof", async () => {
    const { h, client, fetch } = await recordedControl(true);
    const sessionId = String(h.rows("motorist_call_sessions")[0].id);
    const owner = (): Ownership => ({ admin: h.admin, organizationId: ORG, sessionId, contract: 2,
      token: "not-used-for-GET", generation: 1, deadline: Date.now() + 24_000, acquiredAt: Date.now() });
    // skipJournal keeps this test about provenance only; no live provider exists.
    const send = () => client.request("POST", "/calls/late-origin/actions/hangup", { skipJournal: true });
    const scope = owner();
    await sessionOwnership.run(scope, async () => {
      await expect(send()).rejects.toMatchObject({ code: "test_provider_boundary" });
      h.db.insert("motorist_telnyx_webhook_events", { event_id: "late", organization_id: ORG,
        call_control_id: "late-origin", event_type: "call.initiated", connection_id: "app-test" });
      await send();
      const after = h.db.log.length;
      await send();
      expect(h.db.log).toHaveLength(after);
    });
    h.db.delete("motorist_telnyx_webhook_events", row => row.event_id === "late");
    const sent = fetch.mock.calls.length;
    await expect(sessionOwnership.run(owner(), send)).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).toHaveBeenCalledTimes(sent);
  });

  it("deduplicates concurrent positive proofs, but rechecks independent owners and failed reads", async () => {
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    h.db.insert("motorist_telnyx_webhook_events", { event_id: "origin", organization_id: ORG,
      call_control_id: "owned-call", event_type: "call.initiated", connection_id: "app-test" });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { result: "ok" } }), { status: 200 }));
    const client = createTelnyxClient({ config: getTelnyxConfig(env), liveGate: { callsEnabled: true, smsEnabled: false },
      fetch, testProvenanceContext: { admin: h.admin, organizationId: ORG } });
    const owner = (): Ownership => ({ admin: h.admin, organizationId: ORG, sessionId: "owned-session", contract: 2,
      token: "test-owner", generation: 1, deadline: Date.now() + 24_000, acquiredAt: Date.now() });
    const send = () => client.request("POST", "/calls/owned-call/actions/hangup", { skipJournal: true });
    const proofCount = () => h.db.log.filter(row => row.table === "motorist_telnyx_webhook_events" && row.operation === "select").length;
    const scope = owner();
    await sessionOwnership.run(scope, async () => {
      h.db.failNext("motorist_telnyx_webhook_events", "select", "database unavailable");
      await expect(send()).rejects.toMatchObject({ code: "test_provider_boundary" });
      expect(fetch).not.toHaveBeenCalled();
      await Promise.all([send(), send(), send()]);
      expect(proofCount()).toBe(2);
      expect(fetch).toHaveBeenCalledTimes(3);
    });
    await sessionOwnership.run(owner(), send);
    expect(proofCount()).toBe(3);
    await send();
    await send();
    expect(proofCount()).toBe(5);
  });
});
