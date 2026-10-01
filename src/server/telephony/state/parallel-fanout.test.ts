import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, GROUPS, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { TelnyxCommandError } from "../telnyx/client";
import { advanceRingStep } from "../routing/ring-plan";
import { runSessionEvent } from "../session-runner";
import { readPendingEffects } from "./continuation";
import type { RingFanout, SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function harness(options: Parameters<typeof createTelephonyHarness>[0] = {}) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  return createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false, ...options });
}

const offered = (h: TelephonyHarness, sessionId: string) =>
  h.attempts(sessionId).filter((attempt) => attempt.result === "offered");

/** Records how the step was handed to the provider: as a group, or one by one. */
function watchDials(h: TelephonyHarness) {
  const state = { groups: [] as number[], singles: 0 };
  const client = h.telnyx.client as unknown as Record<string, (input: never) => Promise<unknown>>;
  const many = client.dialMany.bind(h.telnyx.client);
  const one = client.dial.bind(h.telnyx.client);
  client.dialMany = async (list: never) => {
    state.groups.push((list as unknown[]).length);
    return many(list);
  };
  client.dial = async (params: never) => {
    state.singles += 1;
    return one(params);
  };
  return state;
}

describe("ring fan-out", () => {
  it.each([false, true])("rings both configured endpoints without blocking the group (explicit mobile owner=%s)", async explicitOwner => {
    const h = harness();
    h.db.update("motorist_operator_telephony_settings", { default_mobile_number: NUMBERS.external }, row => row.profile_id === PROFILES.o1);
    h.db.seed("motorist_ring_group_members", [{ organization_id: ORG, ring_group_id: GROUPS.a, member_kind: "external_number",
      profile_id: null, owner_profile_id: explicitOwner ? PROFILES.o1 : null, external_number: NUMBERS.external, position: 3, ring_secs: null }]);

    const call = await h.inbound({ to: NUMBERS.allianz });

    expect(h.telnyx.of("dial")).toHaveLength(4);
    expect(h.telnyx.of("dial").filter(dial => dial.params.to === NUMBERS.external)).toHaveLength(1);
    expect(new Set(h.telnyx.of("dial").map(dial => dial.params.commandId)).size).toBe(4);
    expect(offered(h, call.sessionId)).toHaveLength(4);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "ringing", current_session_id: call.sessionId });
    expect(h.rows("motorist_job_incidents").filter(row => row.status === "open")).toEqual([]);
  });

  it.each([false, true])("uses the owned mobile when that owner's SIP is unavailable (explicit owner=%s)", async explicitOwner => {
    const h = harness();
    h.db.delete("motorist_operator_devices", row => row.profile_id === PROFILES.o1);
    h.db.update("motorist_operator_telephony_settings", { default_mobile_number: NUMBERS.external }, row => row.profile_id === PROFILES.o1);
    h.db.seed("motorist_ring_group_members", [{ organization_id: ORG, ring_group_id: GROUPS.a, member_kind: "external_number",
      profile_id: null, owner_profile_id: explicitOwner ? PROFILES.o1 : null, external_number: NUMBERS.external, position: 3, ring_secs: null }]);

    const call = await h.inbound({ to: NUMBERS.allianz });
    const mobile = h.legs(call.sessionId).find(leg => leg.to_number === NUMBERS.external)!;
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(offered(h, call.sessionId)).toHaveLength(3);
    expect(mobile).toMatchObject({ profile_id: PROFILES.o1, role: "external" });

    h.telnyx.physical.answered(String(mobile.telnyx_call_control_id));
    await h.legEvent(String(mobile.telnyx_call_control_id), "call.answered");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.telnyx.physical.connected(call.callControlId, String(mobile.telnyx_call_control_id))).toBe(true);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
  });

  it("admits one exact endpoint safely before the database migration", async () => {
    const h = harness();
    h.db.uniqueKeys.motorist_ring_attempts = [["id"], ["session_id", "step_index", "profile_id"],
      ["session_id", "step_index", "external_number"], { columns: ["profile_id"], where: row => row.result === "offered" }];
    h.db.update("motorist_operator_telephony_settings", { default_mobile_number: NUMBERS.external }, row => row.profile_id === PROFILES.o1);
    h.db.seed("motorist_ring_group_members", [{ organization_id: ORG, ring_group_id: GROUPS.a, member_kind: "external_number",
      profile_id: null, external_number: NUMBERS.external, position: 3, ring_secs: null }]);

    const call = await h.inbound({ to: NUMBERS.allianz });

    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(offered(h, call.sessionId)).toHaveLength(3);
    expect(h.rows("motorist_job_incidents").filter(row => row.status === "open")).toEqual([]);
  });

  it.each([
    ["operator", "accepted"], ["external_number", "accepted"],
    ["operator", "unknown"], ["external_number", "unknown"],
  ] as const)("preserves the original %s endpoint with %s evidence in a legacy collision", async (memberKind, outcome) => {
    const h = harness();
    const stage = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    let webAddress = "";
    h.db.registerRpc("motorist_stage_transition_v1", (args, db) => {
      const main = args.p_main as { entry: { commands: Array<{ kind: string }> } };
      const fanout = main.entry.commands.find(command => command.kind === "ring_fanout") as RingFanout | undefined;
      if (fanout && !webAddress) {
        const original = fanout.dials.find(dial => dial.profileId === PROFILES.o1)!;
        webAddress = original.to;
        if (memberKind === "external_number") {
          Object.assign(original, { to: NUMBERS.external, role: "external", externalNumber: NUMBERS.external });
          original.clientState.role = "external";
          original.attempt!.externalNumber = NUMBERS.external;
          Object.assign(fanout.attempts.find(attempt => attempt.profileId === PROFILES.o1)!,
            { memberKind, externalNumber: NUMBERS.external });
        }
        if (outcome === "unknown") h.telnyx.loseNextResponse("dial");
        else h.db.failNext("motorist_call_legs", "upsert", "injected bookkeeping failure");
      }
      return stage(args, db);
    });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const pending = readPendingEffects(h.session(call.sessionId) as SessionRow);
    const fanout = pending.entries.flatMap(entry => entry.commands).find(command => command.kind === "ring_fanout") as RingFanout;
    const original = fanout.dials.find(dial => dial.profileId === PROFILES.o1)!;
    const journal = h.rows("motorist_provider_commands").find(row => row.command_id === original.commandId)!;
    expect(journal.outcome).toBe(outcome);
    const other = structuredClone(original);
    const otherExternal = memberKind === "operator";
    Object.assign(other, { to: otherExternal ? NUMBERS.external : webAddress,
      role: otherExternal ? "external" : "operator", externalNumber: otherExternal ? NUMBERS.external : null });
    other.clientState.role = otherExternal ? "external" : "operator";
    other.attempt!.externalNumber = otherExternal ? NUMBERS.external : null;
    fanout.dials.push(other);
    fanout.attempts.push({ ...fanout.attempts.find(attempt => attempt.profileId === PROFILES.o1)!,
      memberKind: otherExternal ? "external_number" : "operator", externalNumber: other.attempt!.externalNumber, position: 3 });
    h.db.seed("motorist_ring_attempts", [{ ...offered(h, call.sessionId).find(row => row.profile_id === PROFILES.o1)!,
      id: h.nextEventId(), member_kind: otherExternal ? "external_number" : "operator", external_number: other.attempt!.externalNumber, leg_id: null }]);
    h.db.update("motorist_call_sessions", { pending_effects: pending }, row => row.id === call.sessionId);

    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });

    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(h.rows("motorist_provider_commands").find(row => row.command_id === original.commandId)).toEqual(journal);
    expect(offered(h, call.sessionId).filter(row => row.profile_id === PROFILES.o1))
      .toEqual([expect.objectContaining({ member_kind: memberKind })]);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.length).toBe(outcome === "accepted" ? 0 : 1);
  });

  it.each(["operator", "external_number"] as const)("repairs an undispatched legacy collision and resumes both endpoints (%s first)", async memberKind => {
    const h = harness();
    const stage = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    let injected = false;
    h.db.registerRpc("motorist_stage_transition_v1", (args, db) => {
      const main = args.p_main as { entry: { commands: Array<{ kind: string }> } };
      const fanout = main.entry.commands.find(command => command.kind === "ring_fanout") as RingFanout | undefined;
      if (fanout && !injected) {
        // The old planner stored SIP and owned mobile under the same stable
        // identity. No journal exists, proving the old batch never dispatched.
        const sip = fanout.dials.find(dial => dial.profileId === PROFILES.o1)!;
        const mobile = structuredClone(sip);
        mobile.to = NUMBERS.external;
        mobile.role = "external";
        mobile.externalNumber = NUMBERS.external;
        mobile.clientState.role = "external";
        mobile.attempt!.externalNumber = NUMBERS.external;
        fanout.dials.push(mobile);
        const mobileAttempt = { ...fanout.attempts.find(attempt => attempt.profileId === PROFILES.o1)!,
          memberKind: "external_number" as const, externalNumber: NUMBERS.external, position: 3 };
        if (memberKind === "external_number") fanout.attempts.unshift(mobileAttempt);
        else fanout.attempts.push(mobileAttempt);
        // The provider accepts the whole batch, then one local leg write
        // fails. Its durable continuation and offered attempt must resume
        // against the immutable accepted journal without sending any dial again.
        h.db.failNext("motorist_call_legs", "upsert", "injected dial bookkeeping failure");
        injected = true;
      }
      return stage(args, db);
    });

    const call = await h.inbound({ to: NUMBERS.allianz });

    expect(injected).toBe(true);
    expect(h.telnyx.of("dial")).toHaveLength(4);
    expect(h.telnyx.of("dial").filter(dial => dial.params.to === NUMBERS.external)).toHaveLength(1);
    const pending = readPendingEffects(h.session(call.sessionId) as SessionRow);
    expect(pending.entries.some(entry => entry.commands.some(command => command.kind === "ring_fanout") && entry.lastError)).toBe(true);
    const attempt = offered(h, call.sessionId).find(row => row.profile_id === PROFILES.o1)!;
    expect(attempt.member_kind).toBe(memberKind);
    expect(h.rows("motorist_provider_commands").filter(row => row.session_id === call.sessionId && row.path === "/calls" && row.outcome === "accepted")).toHaveLength(4);

    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });

    expect(h.telnyx.of("dial")).toHaveLength(4);
    expect(offered(h, call.sessionId)).toHaveLength(4);
    expect(offered(h, call.sessionId).find(row => row.profile_id === PROFILES.o1)).toMatchObject({ id: attempt.id, member_kind: memberKind, leg_id: expect.any(String) });
    expect(h.legs(call.sessionId).filter(leg => leg.profile_id)).toHaveLength(4);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "ringing", current_session_id: call.sessionId });
  });

  it("settles all accepted legs concurrently and preserves the original offer time", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let first!: () => void;
    const started = new Promise<void>(done => { first = done; });
    let count = 0;
    const from = h.client.from.bind(h.client);
    vi.spyOn(h.client, "from").mockImplementation(table => {
      const query = from(table);
      if (table === "motorist_call_legs") {
        const upsert = query.upsert.bind(query);
        query.upsert = (...args) => {
          const write = upsert(...args);
          if ((args[0] as { role?: string }).role !== "operator") return write;
          const then = write.then.bind(write);
          write.then = (resolve, reject) => {
            count += 1;
            first();
            return gate.then(() => then()).then(resolve, reject);
          };
          return write;
        };
      }
      return query;
    });
    const call = h.inbound({ to: NUMBERS.allianz });
    await started;
    await new Promise<void>(done => setImmediate(done));
    const concurrent = count;
    const offeredAt = offered(h, String(h.rows("motorist_call_sessions")[0].id)).map(row => row.offered_at);
    h.advance(1_000);
    release();
    const completed = await call;
    expect(concurrent).toBe(3);
    expect(offered(h, completed.sessionId).map(row => row.offered_at)).toEqual(offeredAt);
    expect(h.legs(completed.sessionId).filter(leg => leg.role === "operator")).toHaveLength(3);
  });

  it("enters the waiting room in the same invocation when every dial is refused", async () => {
    const h = harness({ fallbackKind: "waiting_room" });
    for (let i = 0; i < 4; i++) h.telnyx.failNext("dial", new TelnyxCommandError({ code: "rejected", status: 422, detail: "dial refused" }));
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(offered(h, call.sessionId)).toHaveLength(0);
    const fanouts = call.results.flatMap(result => result.commands).filter(command => command.kind === "ring_fanout");
    expect(fanouts.some(command => command.detail?.dialed === 0)).toBe(true);
  });
  it("hands the whole step to the provider at once", async () => {
    const h = harness();
    const seen = watchDials(h);

    const call = await h.inbound({ to: NUMBERS.allianz });

    // Three operators share step 0. They used to go out one at a time, each
    // waiting out the last one's database round trips as well as its provider
    // call; now the step is one group, fenced and recorded together.
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(seen.groups).toEqual([3]);
    expect(seen.singles).toBe(0);
    expect(offered(h, call.sessionId)).toHaveLength(3);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("makes the offer tokens durable before any leg exists, in one write", async () => {
    const h = harness();
    const sessionWritesAtDial: number[] = [];
    const client = h.telnyx.client as unknown as Record<string, (input: never) => Promise<unknown>>;
    const many = client.dialMany.bind(h.telnyx.client);
    const sessionWrites = () =>
      h.db.log.filter((row) => row.table === "motorist_call_sessions" && row.operation === "update").length;
    client.dialMany = async (list: never) => {
      for (let member = 0; member < (list as unknown[]).length; member += 1) sessionWritesAtDial.push(sessionWrites());
      return many(list);
    };

    const call = await h.inbound({ to: NUMBERS.allianz });

    // A replayed webhook has to recognise its own offer, so the tokens are
    // written before a leg can exist. The three members are claimed, then
    // persisted together, then dialled: no session write falls between the
    // dials, where three fenced compare-and-sets would be racing on one row.
    expect(sessionWritesAtDial).toHaveLength(3);
    expect(sessionWritesAtDial[0]).toBeGreaterThan(0);
    expect(new Set(sessionWritesAtDial).size).toBe(1);
    expect(offered(h, call.sessionId)).toHaveLength(3);
  });

  it("rings the rest of the group when one operator's dial is refused", async () => {
    const h = harness();
    h.telnyx.failNext("dial", new TelnyxCommandError({ code: "rejected", status: 422, detail: "dial refused" }));

    const call = await h.inbound({ to: NUMBERS.allianz });

    // One member's rejection is that member's problem, not the group's.
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(h.attempts(call.sessionId).find((attempt) => attempt.profile_id === PROFILES.o1)?.result).toBe("failed");
    expect(offered(h, call.sessionId)).toHaveLength(2);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("skips a member already offered this step and dials the others", async () => {
    const h = harness();
    // What a replay looks like from below: the partial unique index refuses
    // the second offer for one member.
    h.db.failNext("motorist_ring_attempts", "insert", { code: "23505", message: "duplicate key" } as never);

    const call = await h.inbound({ to: NUMBERS.allianz });

    // A single multi-row insert would have taken the whole step down with it.
    expect(h.telnyx.of("dial")).toHaveLength(2);
    expect(offered(h, call.sessionId)).toHaveLength(2);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("refuses a second advance of the step it has already rung", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.telnyx.of("dial")).toHaveLength(3);

    // The group goes out under a compare-and-set on `current_step`. An
    // invocation arriving with the old expectation has to lose it, or three
    // more phones ring. (`transitions.test.ts` drives the whole race; this
    // pins the guard on the parallel path.)
    const step = Number(h.session(call.sessionId).current_step);
    expect(await advanceRingStep(h.admin, call.sessionId, step - 1)).toBe(false);
    expect(h.telnyx.of("dial")).toHaveLength(3);
  });

  it("dials each member once, however the group is retried", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });

    // The provider journal is what makes this true: a replayed command is
    // answered from the recorded outcome, not sent again.
    const perMember = new Map<string, number>();
    for (const dial of h.telnyx.of("dial")) {
      const to = String(dial.params.to);
      perMember.set(to, (perMember.get(to) ?? 0) + 1);
    }
    expect([...perMember.values()].every((count) => count === 1)).toBe(true);
    expect(offered(h, call.sessionId)).toHaveLength(3);
  });

  it("keeps one member's provider failure off the others", async () => {
    const h = harness();
    // A rate limit is not a refusal: the member is failed, the group is not.
    h.telnyx.failNext("dial", new TelnyxCommandError({ code: "rate_limited", status: 429, detail: "slow down" }));

    const call = await h.inbound({ to: NUMBERS.allianz });

    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(offered(h, call.sessionId).length).toBeGreaterThanOrEqual(2);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("asks the journal about a dial only when there is something to replay", async () => {
    const h = harness();
    await h.inbound({ to: NUMBERS.allianz });

    // A first attempt carries a continuation, so a lookup keyed on its mere
    // existence cost one round trip per operator rung and could never find
    // anything.
    const lookups = h.db.log.filter((row) => row.table === "motorist_provider_command_lookup_v2").length;
    expect(lookups).toBe(0);
  });

  it("journals the whole step in two round trips, not two per operator", async () => {
    const h = harness();
    const from = h.db.log.length;

    await h.inbound({ to: NUMBERS.allianz });

    // Three dials used to cost three `prepare_v2` and three `result_v2`, to a
    // database that serialises them on one session row anyway. The saving is
    // two per operator beyond the first, so it grows with the group.
    const batched = h.db.log.slice(from).filter((row) => /provider_command_(prepare|result)_batch_v2/.test(row.table)).length;
    const singles = h.db.log.slice(from).filter((row) => /provider_command_(prepare|result)_v2/.test(row.table) && !/batch/.test(row.table));
    expect(batched).toBe(2);
    expect(singles.filter((row) => row.table.includes("prepare")).length).toBeLessThanOrEqual(3);
    expect(h.telnyx.of("dial")).toHaveLength(3);
  });

  it("gives one member's refusal to that member only", async () => {
    const h = harness();
    h.telnyx.failNext("dial", new TelnyxCommandError({ code: "rejected", status: 422, detail: "dial refused" }));

    const call = await h.inbound({ to: NUMBERS.allianz });

    // The group is fenced and recorded together; the verdict is still per
    // member, or one bad number would take a whole ring step down.
    expect(offered(h, call.sessionId)).toHaveLength(2);
    expect(h.session(call.sessionId).state).toBe("ringing");
  });
});
