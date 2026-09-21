import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultAnnouncementConfig } from "@/lib/telephony/announcements";
import { evaluateBusinessHours } from "@/lib/telephony/business-hours";
import { fakeError, type FakeRow, type FakeQueryBuilder } from "@/test/fake-supabase";
import { BUSINESS_HOURS_ID, createTelephonyHarness, GROUPS, LINES, NUMBERS, ORG, PLAN_ID, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { loadRoutingContext, loadSessionSnapshot } from "./session-runner";
import { parseTelnyxEnvelope } from "./state/events";
import { reduce } from "./state/transitions";
import { readMeta, type SessionRow } from "./state/types";
import { readRuntimeRoutingSnapshot } from "./routing/snapshot";
import { materialiseRingPlan, materialiseRingPlanRows } from "./routing/ring-plan";
import { decodeClientState } from "./telnyx/client-state";
import { setPresence } from "./presence-service";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function prepared(options: { hours?: boolean; to?: string; now?: string } = {}) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false, now: options.now });
  h.db.update("motorist_telephony_lines", {
    metadata: { announcements: defaultAnnouncementConfig() },
    ...(options.hours ? {} : { business_hours_id: null }),
  }, () => true);
  const call = await h.inbound({ to: options.to ?? NUMBERS.allianz, answer: false });
  const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
  const event = parseTelnyxEnvelope(h.envelope("call.answered", { call_control_id: call.callControlId }))!;
  return { h, call, event, ...snapshot };
}

const contextReads = (h: TelephonyHarness) => h.db.log.filter(row => (row.operation === "select" || row.operation === "rpc") &&
  row.table !== "motorist_job_incidents");

async function parity(input: Awaited<ReturnType<typeof prepared>>) {
  const { h, session, event, legs, attempts } = input;
  const legacy = await loadRoutingContext(h.deps, session);
  h.db.log.length = 0;
  const snapshot = await loadRoutingContext(h.deps, session, event, legs);
  expect(h.db.log.some(row => row.table === "motorist_routing_snapshot")).toBe(true);
  expect(snapshot).toEqual(legacy);
  expect(reduce(session, legs, attempts, event, snapshot)).toEqual(reduce(session, legs, attempts, event, legacy));
  return snapshot;
}

function personal(h: TelephonyHarness, profileId: string, values: FakeRow) {
  const row = { organization_id: ORG, profile_id: profileId, default_mobile_number: null, pause_routing_mode: "none", pause_forward_profile_id: null, pause_forward_number: null, ...values };
  if (h.rows("motorist_operator_telephony_settings").some(item => item.profile_id === profileId)) h.db.update("motorist_operator_telephony_settings", row, item => item.profile_id === profileId);
  else h.db.insert("motorist_operator_telephony_settings", row);
}

describe("fresh initial inbound routing snapshot", () => {
  it("preserves context and reducer decisions with six reads instead of fourteen", async () => {
    const input = await prepared();
    input.h.db.log.length = 0;
    await loadRoutingContext(input.h.deps, input.session);
    expect(contextReads(input.h)).toHaveLength(14);
    const context = await parity(input);
    expect(contextReads(input.h)).toHaveLength(6);
    expect(context.ringPlan?.steps.map(step => step.strategy)).toEqual(["all", "ordered"]);
    expect(contextReads(input.h).map(row => row.table)).toEqual([
      "motorist_routing_snapshot", "motorist_operator_presence", "motorist_operator_presence",
      "motorist_operator_devices", "motorist_ring_attempts", "motorist_call_legs",
    ]);
  });

  it("removes four dependent read waves on the same synthetic latency fixture", async () => {
    const input = await prepared();
    const { h } = input;
    vi.useFakeTimers();
    const starts: number[] = [];
    // Each DB request has an equal simulated 10 ms transport delay. This
    // measures dependency depth, not a promised production latency reduction.
    for (const key of ["from", "rpc"] as const) {
      const original = h.client[key].bind(h.client);
      vi.spyOn(h.client, key).mockImplementation(((...args: unknown[]) => {
        const query = Reflect.apply(original, h.client, args) as FakeQueryBuilder;
        if (args[0] === "motorist_job_incidents") return query;
        const then = query.then.bind(query);
        query.then = (resolve, reject) => {
          starts.push(Date.now());
          return new Promise<void>(done => setTimeout(done, 10)).then(() => then(resolve, reject));
        };
        return query;
      }) as typeof h.client[typeof key]);
    }
    const compare = async (snapshot: boolean) => {
      starts.length = 0;
      const started = Date.now();
      const pending = loadRoutingContext(h.deps, input.session, snapshot ? input.event : undefined, input.legs);
      await vi.runAllTimersAsync();
      const context = await pending;
      return { context, elapsed: Date.now() - started, waves: new Set(starts).size };
    };
    const legacy = await compare(false);
    const snapshot = await compare(true);
    expect(snapshot.context).toEqual(legacy.context);
    expect([legacy.elapsed, legacy.waves, snapshot.elapsed, snapshot.waves]).toEqual([70, 7, 30, 3]);
  });

  it.each([
    ["before opening", "2026-09-03T04:59:00Z", false],
    ["opening", "2026-09-03T05:00:00Z", true],
    ["lunch", "2026-09-03T10:00:00Z", false],
    ["reopening", "2026-09-03T10:30:00Z", true],
    ["holiday", "2026-12-24T09:00:00Z", false],
  ])("preserves business hours at %s", async (_name, now, open) => {
    const input = await prepared({ hours: true, now: String(now) });
    const context = await parity(input);
    expect(evaluateBusinessHours(context.businessHours, context.now).open).toBe(open);
    expect(reduce(input.session, input.legs, input.attempts, input.event, context).commands.some(command => command.kind === "ring_fanout")).toBe(open);
  });

  it("retains inactive/missing plans and groups, ordering, timeout clamping and original queue members", async () => {
    const input = await prepared();
    const { h } = input;
    h.db.update("motorist_ring_groups", { active: false }, row => row.id === GROUPS.a);
    h.db.update("motorist_ring_plan_steps", { timeout_secs: 2 }, row => row.ring_group_id === GROUPS.b);
    h.db.update("motorist_ring_group_members", { ring_secs: 999 }, row => row.ring_group_id === GROUPS.b);
    const context = await parity(input);
    expect(context.ringPlan?.steps).toHaveLength(1);
    expect(context.ringPlan?.steps[0]).toMatchObject({ index: 0, groupId: GROUPS.b, timeoutSecs: 5 });
    expect(context.ringPlan?.steps[0].members.every(member => member.ringSecs === 120)).toBe(true);
    h.db.update("motorist_ring_plans", { active: false }, () => true);
    expect((await parity(input)).ringPlan).toBeNull();
    h.db.delete("motorist_ring_plans", () => true);
    expect((await parity(input)).ringPlan).toBeNull();
  });

  it("retains paused substitute deduplication and personal numbers outside the ring group", async () => {
    const input = await prepared();
    const { h } = input;
    h.setPresence(PROFILES.o1, { status: "paused" });
    personal(h, PROFILES.o1, { pause_routing_mode: "operator", pause_forward_profile_id: PROFILES.o2 });
    personal(h, PROFILES.o2, { default_mobile_number: "+421911222333", delivery_mode: "personal_mobile" });
    personal(h, "outside-group", { default_mobile_number: NUMBERS.external });
    const context = await parity(input);
    expect(context.ringPlan?.steps[0].members.filter(member => member.profileId === PROFILES.o2)).toHaveLength(1);
    expect(context.ringPlan?.steps[0].members[0]).toMatchObject({ profileId: PROFILES.o2, provenance: "personal_mobile", externalNumber: "+421911222333" });
    expect(context.ringPlan?.queueMembers?.some(member => member.profileId === PROFILES.o1)).toBe(true);
    expect(context.ringPlan?.steps[1].members.at(-1)).toMatchObject({ profileId: "outside-group", provenance: "personal_mobile" });
    personal(h, "second-owner", { default_mobile_number: NUMBERS.external });
    expect((await parity(input)).ringPlan?.steps[1].members.at(-1)?.profileId).toBe("ambiguous-personal-number");
  });

  it("uses the shared pure materializer with the stability gate off too", async () => {
    const { h } = await prepared();
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    personal(h, PROFILES.o1, { default_mobile_number: "+421911222333", delivery_mode: "personal_mobile" });
    const raw = await readRuntimeRoutingSnapshot(h.admin, ORG);
    const pure = materialiseRingPlanRows({ plan: raw.plans[0], steps: raw.steps, groups: raw.groups, members: raw.members,
      operatorRouting: raw.operatorSettings, pausedProfileIds: new Set(), destinationAllowlist: ["SK", "CZ"], personalMobileEnabled: false, now: h.now() });
    expect(pure).toEqual(await materialiseRingPlan(h.admin, { organizationId: ORG, ringPlanId: PLAN_ID, now: h.now() }));
    expect(pure?.steps[0].members[0].kind).toBe("operator");
  });

  it("keeps disallowed personal mobile delivery on the original web route", async () => {
    const input = await prepared();
    personal(input.h, PROFILES.o1, { default_mobile_number: "+420720123456", delivery_mode: "personal_mobile" });
    input.h.db.update("motorist_telephony_settings", { destination_allowlist: ["SK"] }, () => true);
    expect((await parity(input)).ringPlan?.steps[0].members[0]).toMatchObject({ kind: "operator", profileId: PROFILES.o1, externalNumber: null });
  });

  it("ignores stale RPC devices/presence and rereads environment-specific live eligibility", async () => {
    const input = await prepared();
    const { h } = input;
    const rpc = h.db.rpcHandlers.get("motorist_routing_snapshot")!;
    h.db.registerRpc("motorist_routing_snapshot", async (args, db) => {
      const stale = await rpc(args, db);
      h.setPresence(PROFILES.o1, { status: "paused" });
      h.db.update("motorist_operator_devices", { registration_state: "unregistered" }, row => row.profile_id === PROFILES.o2);
      h.db.insert("motorist_operator_devices", { organization_id: ORG, profile_id: PROFILES.o2, environment: "production", registration_state: "registered", device_seen_at: h.now().toISOString(), sip_username: "wrong-environment" });
      return stale;
    });
    const context = await loadRoutingContext(h.deps, input.session, input.event, input.legs);
    expect(context.presence.find(row => row.profile_id === PROFILES.o1)?.status).toBe("paused");
    expect(context.devices.find(row => row.profile_id === PROFILES.o2)?.registration_state).toBe("unregistered");
    const fanout = reduce(input.session, input.legs, input.attempts, input.event, context).commands.find(command => command.kind === "ring_fanout");
    expect(fanout && JSON.stringify(fanout)).not.toContain(PROFILES.o1);
    expect(fanout && JSON.stringify(fanout)).not.toContain(PROFILES.o2);
  });

  it("reads a configuration change on the next event without replacing a frozen plan", async () => {
    const input = await prepared();
    const original = await parity(input);
    input.h.db.update("motorist_ring_plan_steps", { timeout_secs: 45 }, row => row.ring_group_id === GROUPS.a);
    expect((await parity(input)).ringPlan?.steps[0].timeoutSecs).toBe(45);
    const frozen = { ...input.session, state: "ringing", metadata: { ...readMeta(input.session), ring: { plan: original.ringPlan, mode: "plan" } } } as SessionRow;
    input.h.db.log.length = 0;
    const context = await loadRoutingContext(input.h.deps, frozen, input.event, input.legs);
    expect(context.ringPlan?.steps[0].timeoutSecs).toBe(20);
    expect(input.h.db.log.some(row => row.table === "motorist_routing_snapshot")).toBe(false);
  });

  it("uses the resolved return line while preserving the number the customer dialed", async () => {
    const { h } = await prepared();
    h.db.update("motorist_telephony_lines", { metadata: { return_line_id: LINES.neutral }, ring_plan_id: null }, row => row.id === LINES.allianz);
    h.db.update("motorist_telephony_lines", { ivr_menu_id: null, business_hours_id: BUSINESS_HOURS_ID }, row => row.id === LINES.neutral);
    const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const event = parseTelnyxEnvelope(h.envelope("call.answered", { call_control_id: call.callControlId }))!;
    expect(snapshot.session).toMatchObject({ line_id: LINES.neutral, called_number: NUMBERS.allianz });
    const context = await parity({ h, call, event, ...snapshot });
    expect(context.line?.id).toBe(LINES.neutral);
    expect(context.businessHours).not.toBeNull();
    expect(context.ringPlan?.planId).toBe(PLAN_ID);
  });

  it("still waits for live capacity instead of dialing a full organization", async () => {
    const input = await prepared();
    input.h.db.update("motorist_telephony_settings", { max_concurrent_legs: 1 }, () => true);
    const context = await parity(input);
    expect(context.activeLegCount).toBe(1);
    expect(reduce(input.session, input.legs, input.attempts, input.event, context).commands.some(command => command.kind === "ring_fanout")).toBe(false);
    await input.h.legEvent(input.call.callControlId, "call.answered");
    expect(input.h.telnyx.of("dial")).toHaveLength(0);
    // Capacity retry intentionally stays in ringing with no operator dial.
    expect(input.h.session(input.call.sessionId).state).toBe("ringing");
  });

  it("rejects an operator who pauses after the new snapshot and final eligibility read", async () => {
    const { h, call } = await prepared();
    const rpc = h.db.rpcHandlers.get("motorist_presence_transition_v1")!;
    let paused = false;
    h.db.registerRpc("motorist_presence_transition_v1", async (args, db) => {
      if (!paused && args.p_action === "dispatch" && args.p_profile_id === PROFILES.o1) {
        paused = true;
        await setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o1, status: "paused" });
      }
      return rpc(args, db);
    });
    expect(await h.legEvent(call.callControlId, "call.answered")).toMatchObject({ status: 200, outcome: "processed" });
    expect(paused).toBe(true);
    expect(h.telnyx.of("dial")).toHaveLength(2);
    expect(h.telnyx.of("dial").some(command => decodeClientState(command.params.clientState)?.operatorId === PROFILES.o1)).toBe(false);
    expect(h.presence(PROFILES.o1).status).toBe("paused");
  });

  it("preserves IVR and explicitly enabled introductions through the legacy reader", async () => {
    const ivr = await prepared({ to: NUMBERS.neutral });
    const context = await loadRoutingContext(ivr.h.deps, ivr.session, ivr.event, ivr.legs);
    expect(context.ivr?.options).toHaveLength(2);
    expect(ivr.h.db.log.some(row => row.table === "motorist_ivr_options")).toBe(true);
    const intro = await prepared();
    const meta = readMeta(intro.session);
    const session = { ...intro.session, metadata: { ...meta, announcements: { ...meta.announcements, inboundStartAnnouncements: true } } } as SessionRow;
    intro.h.db.log.length = 0;
    await loadRoutingContext(intro.h.deps, session, intro.event, intro.legs);
    expect(intro.h.db.log.some(row => row.table === "motorist_routing_snapshot")).toBe(false);
  });

  it("keeps the live recording policy authoritative even after a frozen disabled admission", async () => {
    const input = await prepared();
    for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED"]) vi.stubEnv(key, "true");
    input.h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: input.h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
    input.h.db.log.length = 0;
    const context = await loadRoutingContext(input.h.deps, input.session, input.event, input.legs);
    expect(context.recordingPolicy?.enabled).toBe(true);
    expect(input.h.db.log.filter(row => row.table === "motorist_call_recording_policies")).toHaveLength(1);
    expect(input.h.db.log.some(row => row.table === "motorist_ring_plans")).toBe(true);
  });

  it.each(["gather", "announcement_sequence", "recording_barrier", "pending_effects", "unknown_customer", "contract_one"])("keeps %s on the original reader", async kind => {
    const input = await prepared();
    const meta = readMeta(input.session);
    const session = { ...input.session, metadata: { ...meta } } as SessionRow;
    if (kind === "gather" || kind === "announcement_sequence") Object.assign(session.metadata as object, { [kind]: { id: "pending" } });
    if (kind === "recording_barrier") Object.assign(session.metadata as object, { recording: { ...meta.recording, barrier: { id: "pending" } } });
    if (kind === "pending_effects") Object.assign(session, { pending_effects: { version: 1, entries: [{ id: "pending", commands: [] }] } });
    if (kind === "contract_one") session.writer_contract = 1;
    if (kind === "unknown_customer") session.customer_leg_id = "different-customer";
    input.h.db.log.length = 0;
    await loadRoutingContext(input.h.deps, session, input.event, input.legs);
    expect(input.h.db.log.some(row => row.table === "motorist_routing_snapshot")).toBe(false);
  });

  it.each(["missing", "malformed", "foreign_organization"])("falls back once with the whole configuration for a %s RPC", async kind => {
    const input = await prepared();
    const expected = await loadRoutingContext(input.h.deps, input.session);
    if (kind === "missing") input.h.db.rpcHandlers.delete("motorist_routing_snapshot");
    else {
      const rpc = input.h.db.rpcHandlers.get("motorist_routing_snapshot")!;
      input.h.db.registerRpc("motorist_routing_snapshot", async (args, db) => {
        const raw = await rpc(args, db) as Record<string, unknown>;
        return kind === "malformed" ? { ...raw, members: null } : { ...raw, plans: (raw.plans as FakeRow[]).map(row => ({ ...row, organization_id: "another-organization" })) };
      });
    }
    input.h.db.log.length = 0;
    const actual = await loadRoutingContext(input.h.deps, input.session, input.event, input.legs);
    expect(actual).toEqual(expected);
    expect(input.h.db.log.filter(row => row.table === "motorist_routing_snapshot")).toHaveLength(1);
    expect(input.h.logs).toContainEqual(expect.objectContaining({ code: "routing_snapshot_fallback", reason: kind === "missing" ? "missing" : "invalid" }));
  });

  it("leaves a transient snapshot failure retryable before dial instead of hiding it with fallback", async () => {
    const { h, call } = await prepared();
    h.db.failNext("motorist_routing_snapshot", "rpc", fakeError("unavailable", "08006"));
    expect(await h.legEvent(call.callControlId, "call.answered", {}, "snapshot-retry")).toMatchObject({ status: 500, outcome: "failed" });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    h.advance(500);
    expect(await h.legEvent(call.callControlId, "call.answered", {}, "snapshot-retry")).toMatchObject({ status: 200, outcome: "processed" });
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.logs.some(row => row.code === "routing_snapshot_fallback")).toBe(false);
  });

  it("does not conceal denied snapshot access or failed legacy fallback", async () => {
    const input = await prepared();
    input.h.db.failNext("motorist_routing_snapshot", "rpc", fakeError("permission denied", "42501"));
    await expect(loadRoutingContext(input.h.deps, input.session, input.event, input.legs)).rejects.toThrow("permission denied");
    input.h.db.rpcHandlers.delete("motorist_routing_snapshot");
    input.h.db.failNext("motorist_telephony_settings", "select", fakeError("legacy unavailable"));
    await expect(loadRoutingContext(input.h.deps, input.session, input.event, input.legs)).rejects.toThrow("legacy unavailable");
    expect(input.h.telnyx.of("dial")).toHaveLength(0);
  });
});
