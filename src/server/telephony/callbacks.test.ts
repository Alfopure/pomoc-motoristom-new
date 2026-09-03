import { describe, expect, it } from "vitest";

import { CASE_ID, createTelephonyHarness, LINES, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import type { FakeRow } from "@/test/fake-supabase";

import { CallActionError, createRateLimiter, parkCall, type CallActionDeps, type CallActor } from "./call-actions";
import {
  callBackRequest,
  claimCallbackRequest,
  loadCallbackQueue,
  resolveCallbackRequest,
  type CallbackQueueDeps,
} from "./callbacks";

const o1: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };
const o2: CallActor = { profileId: PROFILES.o2, role: "dispatcher", displayName: "Peter" };
const senior: CallActor = { profileId: PROFILES.o3, role: "senior_dispatcher", displayName: "Senior" };

function queueDeps(h: TelephonyHarness): CallbackQueueDeps {
  return { admin: h.deps.admin, organizationId: h.deps.organizationId, now: h.deps.now, logger: h.deps.logger };
}

function actionDeps(h: TelephonyHarness, overrides: Partial<CallActionDeps> = {}): CallActionDeps {
  return { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }), ...overrides };
}

/** Inserts a callback request as the state machine writes them. */
function seedRequest(h: TelephonyHarness, overrides: Partial<FakeRow> = {}): string {
  const createdAt = new Date(h.now().getTime() - 10 * 60_000).toISOString();
  const [row] = h.db.insert("motorist_callback_requests", {
    organization_id: h.deps.organizationId,
    caller_number: NUMBERS.customer,
    caller_name: null,
    source: "missed",
    status: "open",
    line_id: LINES.allianz,
    created_at: createdAt,
    due_at: new Date(Date.parse(createdAt) + 30 * 60_000).toISOString(),
    ...overrides,
  });
  return String(row.id);
}

async function fail(promise: Promise<unknown>): Promise<CallActionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CallActionError) return error;
    throw error;
  }
  throw new Error("expected a CallActionError");
}

describe("loadCallbackQueue", () => {
  it("returns the live queue oldest first with its line and claimant labels", async () => {
    const h = createTelephonyHarness();
    const older = seedRequest(h, { created_at: new Date(h.now().getTime() - 40 * 60_000).toISOString(), source: "park_timeout" });
    const newer = seedRequest(h, { created_at: new Date(h.now().getTime() - 2 * 60_000).toISOString(), claimed_by: PROFILES.o2, status: "scheduled" });

    const queue = await loadCallbackQueue(queueDeps(h), { profileId: PROFILES.o1, role: "dispatcher" });

    expect(queue).toMatchObject({ configured: true, actorProfileId: PROFILES.o1, actorRole: "dispatcher" });
    expect(queue.open.map((row) => row.id)).toEqual([older, newer]);
    expect(queue.open[0]).toMatchObject({ source: "park_timeout", lineLabel: "Allianz Assistance", partnerName: "Allianz Assistance", claimedByName: null });
    expect(queue.open[1]).toMatchObject({ status: "scheduled", claimedByProfileId: PROFILES.o2, claimedByName: "Peter Dispečer" });
  });

  it("shows the last day of settled requests as context and drops anything older", async () => {
    const h = createTelephonyHarness();
    seedRequest(h, { status: "done", resolved_at: new Date(h.now().getTime() - 60 * 60_000).toISOString() });
    seedRequest(h, { status: "cancelled", resolved_at: new Date(h.now().getTime() - 26 * 60 * 60_000).toISOString() });

    const queue = await loadCallbackQueue(queueDeps(h), { profileId: PROFILES.o1, role: "dispatcher" });

    expect(queue.open).toHaveLength(0);
    expect(queue.resolved.map((row) => row.status)).toEqual(["done"]);
  });

  it("never leaks another organisation's queue", async () => {
    const h = createTelephonyHarness();
    seedRequest(h, { organization_id: "00000000-0000-4000-8000-0000000000ff" });
    const queue = await loadCallbackQueue(queueDeps(h), { profileId: PROFILES.o1, role: "dispatcher" });
    expect(queue.open).toHaveLength(0);
  });

  it("reports the not-configured mode without hiding the rows", async () => {
    // The rows are ordinary database records: with the provider off a
    // dispatcher must still see (and be able to cancel) the promise given.
    const h = createTelephonyHarness();
    seedRequest(h);
    const queue = await loadCallbackQueue(queueDeps(h), { profileId: PROFILES.o1, role: "dispatcher" }, { configured: false });
    expect(queue).toMatchObject({ configured: false });
    expect(queue.open).toHaveLength(1);
  });
});

describe("claimCallbackRequest", () => {
  it("claims a free request and schedules it", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h);

    const { request } = await claimCallbackRequest(queueDeps(h), o1, id);

    expect(request).toMatchObject({ status: "scheduled", claimedByProfileId: PROFILES.o1, claimedByName: "Jana Dispečerka" });
    expect(h.db.find("motorist_callback_requests", (row) => row.id === id)).toMatchObject({ status: "scheduled", claimed_by: PROFILES.o1 });
  });

  it("is idempotent for the operator who already holds it", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h);
    const first = await claimCallbackRequest(queueDeps(h), o1, id);
    h.advance(60_000);
    const second = await claimCallbackRequest(queueDeps(h), o1, id);
    expect(second.request.claimedAt).toBe(first.request.claimedAt);
  });

  it("refuses a request another dispatcher already holds and names them", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h);
    await claimCallbackRequest(queueDeps(h), o1, id);

    const error = await fail(claimCallbackRequest(queueDeps(h), o2, id));

    expect(error).toMatchObject({ status: 409, code: "already_claimed" });
    expect(error.message).toContain("Jana Dispečerka");
    expect(h.db.find("motorist_callback_requests", (row) => row.id === id)).toMatchObject({ claimed_by: PROFILES.o1 });
  });

  it("gives exactly one of two dispatchers pressing the button at once the caller", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h);

    const results = await Promise.allSettled([
      claimCallbackRequest(queueDeps(h), o1, id),
      claimCallbackRequest(queueDeps(h), o2, id),
    ]);

    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const rejection = (losers[0] as PromiseRejectedResult).reason as CallActionError;
    expect(rejection).toMatchObject({ status: 409, code: "already_claimed" });
    const row = h.db.find("motorist_callback_requests", (candidate) => candidate.id === id)!;
    // The winner in the database is the one whose promise resolved.
    const winner = (winners[0] as PromiseFulfilledResult<{ request: { claimedByProfileId: string | null } }>).value;
    expect(row.claimed_by).toBe(winner.request.claimedByProfileId);
    expect(row.status).toBe("scheduled");
  });

  it("lets a senior dispatcher take a request over from a colleague who went home", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h);
    await claimCallbackRequest(queueDeps(h), o1, id);

    const { request } = await claimCallbackRequest(queueDeps(h), senior, id);

    expect(request.claimedByProfileId).toBe(PROFILES.o3);
    expect(h.db.find("motorist_callback_requests", (row) => row.id === id)).toMatchObject({ claimed_by: PROFILES.o3 });
  });

  it("refuses a settled request", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h, { status: "done", resolved_at: h.now().toISOString() });
    expect(await fail(claimCallbackRequest(queueDeps(h), o1, id))).toMatchObject({ status: 409, code: "already_resolved" });
  });

  it("answers 404 for an unknown request", async () => {
    const h = createTelephonyHarness();
    expect(await fail(claimCallbackRequest(queueDeps(h), o1, "00000000-0000-4000-8000-0000000009ff"))).toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("resolveCallbackRequest", () => {
  it("closes the request, stamps the claimant and closes the case task", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h, { case_id: CASE_ID });
    h.db.insert("motorist_case_tasks", {
      organization_id: h.deps.organizationId,
      case_id: CASE_ID,
      title: "Zavolať späť",
      status: "open",
      kind: "callback",
      priority: "high",
    });

    const { request } = await resolveCallbackRequest(queueDeps(h), o1, id, { status: "done", notes: "  Vybavené telefonicky  " });

    expect(request).toMatchObject({ status: "done", notes: "Vybavené telefonicky", claimedByProfileId: PROFILES.o1 });
    expect(request.resolvedAt).toBe(h.now().toISOString());
    // A callback task left open would keep the case looking unfinished.
    expect(h.db.find("motorist_case_tasks", (row) => row.kind === "callback")).toMatchObject({ status: "done", completed_by: PROFILES.o1 });
  });

  it("cancels without touching the case task", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h, { case_id: CASE_ID });
    h.db.insert("motorist_case_tasks", {
      organization_id: h.deps.organizationId,
      case_id: CASE_ID,
      title: "Zavolať späť",
      status: "open",
      kind: "callback",
      priority: "high",
    });

    const { request } = await resolveCallbackRequest(queueDeps(h), o1, id, { status: "cancelled" });

    expect(request.status).toBe("cancelled");
    expect(h.db.find("motorist_case_tasks", (row) => row.kind === "callback")).toMatchObject({ status: "open" });
  });

  it("refuses to close a request another dispatcher holds, but lets a senior do it", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h);
    await claimCallbackRequest(queueDeps(h), o1, id);

    expect(await fail(resolveCallbackRequest(queueDeps(h), o2, id, { status: "done" }))).toMatchObject({ status: 409, code: "already_claimed" });
    const { request } = await resolveCallbackRequest(queueDeps(h), senior, id, { status: "done" });
    expect(request).toMatchObject({ status: "done", claimedByProfileId: PROFILES.o1 });
  });

  it("lets exactly one of a claim and a concurrent cancel win", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h);

    // Dispatcher B reads the request as unclaimed and cancels it in the same
    // instant A claims it. Without the conditional update both succeed: A's
    // panel shows the caller as theirs and rings them, while the queue records
    // the promise as closed by B.
    const results = await Promise.allSettled([
      claimCallbackRequest(queueDeps(h), o1, id),
      resolveCallbackRequest(queueDeps(h), o2, id, { status: "cancelled" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason as CallActionError;
    expect(rejection.status).toBe(409);
    const row = h.db.find("motorist_callback_requests", (candidate) => candidate.id === id)!;
    // Either A holds an open request or B closed an unclaimed one — never both.
    expect(row.status === "scheduled" ? row.claimed_by : row.status).toBeTruthy();
    expect(row.status === "scheduled" || row.status === "cancelled").toBe(true);
  });

  it("writes an audit row for every claim, close and cancel", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h);

    await claimCallbackRequest(queueDeps(h), o1, id);
    await resolveCallbackRequest(queueDeps(h), o1, id, { status: "cancelled" });

    expect(h.rows("motorist_audit_log").map((row) => row.action)).toEqual(["telephony.callback.claim", "telephony.callback.cancel"]);
    expect(h.rows("motorist_audit_log").at(-1)).toMatchObject({
      entity_type: "telephony_callback",
      entity_id: id,
      actor_profile_id: PROFILES.o1,
      after_payload: expect.objectContaining({ status: "cancelled", caller_number: NUMBERS.customer }),
    });
  });

  it("answers 404 for an id that is not a uuid instead of a database error", async () => {
    const h = createTelephonyHarness();
    expect(await fail(resolveCallbackRequest(queueDeps(h), o1, "abc", { status: "done" }))).toMatchObject({ status: 404, code: "not_found" });
    expect(await fail(claimCallbackRequest(queueDeps(h), o1, "../../etc/passwd"))).toMatchObject({ status: 404, code: "not_found" });
  });

  it("refuses to close the same request twice", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h);
    await resolveCallbackRequest(queueDeps(h), o1, id, { status: "done" });
    expect(await fail(resolveCallbackRequest(queueDeps(h), o1, id, { status: "cancelled" }))).toMatchObject({ status: 409, code: "already_resolved" });
  });
});

describe("callBackRequest", () => {
  it("claims the request, dials the caller from the line they rang and links both rows", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h, { case_id: CASE_ID });

    const result = await callBackRequest(actionDeps(h), o1, id);

    expect(result.call).toMatchObject({ to: NUMBERS.customer, from: NUMBERS.allianz });
    expect(result.linked).toBe(true);
    // The request stays open: the call being placed is not proof the caller was
    // reached, so the operator still has to settle it.
    expect(result.request).toMatchObject({ status: "scheduled", claimedByProfileId: PROFILES.o1, lastCallSessionId: result.call.sessionId });
    expect(h.session(result.call.sessionId)).toMatchObject({ direction: "outbound", case_id: CASE_ID });
    // The link is written on the request row only. A live session's metadata is
    // the session runner's, written under a lease with a version CAS; a
    // read-modify-write from here would race the reducer for the operator leg.
    expect(h.rows("motorist_callback_requests")[0].metadata).toMatchObject({ callback_call: { session_id: result.call.sessionId, by: PROFILES.o1 } });
    expect(h.telnyx.of("dial")).toHaveLength(1);
  });

  it("falls back to the operator's own line when the line the caller rang was switched off", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h, { line_id: LINES.neutral });
    h.db.update("motorist_telephony_lines", { active: false }, (row) => row.id === LINES.neutral);

    const result = await callBackRequest(actionDeps(h), o1, id);

    // An inactive line would make `startOutboundCall` refuse the call outright.
    expect(result.call.from).toBe(NUMBERS.allianz);
  });

  it("does not dial a request another dispatcher holds", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h);
    await claimCallbackRequest(queueDeps(h), o1, id);

    expect(await fail(callBackRequest(actionDeps(h), o2, id))).toMatchObject({ status: 409, code: "already_claimed" });
    expect(h.telnyx.of("dial")).toHaveLength(0);
  });

  it("does not dial a settled request", async () => {
    const h = createTelephonyHarness();
    const id = seedRequest(h, { status: "cancelled", resolved_at: h.now().toISOString() });
    expect(await fail(callBackRequest(actionDeps(h), o1, id))).toMatchObject({ status: 409, code: "already_resolved" });
    expect(h.telnyx.of("dial")).toHaveLength(0);
  });
});

describe("park limit", () => {
  /** Inbound call answered by o1 (the losing legs hung up) → talking. */
  async function talkingWith(h: TelephonyHarness, operator = PROFILES.o1) {
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = h.legFor(call.sessionId, operator)!;
    await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
    for (const leg of h.legs(call.sessionId)) {
      if (leg.role !== "customer" && leg.profile_id !== operator) {
        await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
      }
    }
    expect(h.session(call.sessionId).state).toBe("talking");
    return call;
  }

  it("offers the caller a callback instead of parking them for ever, and the queue picks it up", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);

    await parkCall(actionDeps(h), o1, call.sessionId);
    const parked = h.session(call.sessionId);
    expect(parked).toMatchObject({ state: "parked", answered_by_profile_id: null });
    // Who parked the caller and the limit they arrived with are both on the
    // session, so the waiting room can name them.
    expect(parked.metadata).toMatchObject({ park: expect.objectContaining({ by: PROFILES.o1 }), waiting: expect.objectContaining({ reason: "parked", max_minutes: 30 }) });

    // Nobody rescues them: the waiting-room tick past the limit ends the wait.
    const tick = h.telnyx.of("gather").at(-1)!;
    h.advance(31 * 60_000);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: tick.params.clientState });
    expect(h.session(call.sessionId).state).toBe("callback_offered");
    expect(h.telnyx.of("gatherUsingAudio").at(-1)?.params.audioUrl).toBe("https://media.test/telephony/callback-offer.mp3");

    const offer = h.telnyx.of("gatherUsingAudio").at(-1)!;
    await h.legEvent(call.callControlId, "call.gather.ended", { digits: "1", status: "valid", client_state: offer.params.clientState });

    const queue = await loadCallbackQueue(queueDeps(h), { profileId: PROFILES.o2, role: "dispatcher" });
    expect(queue.open).toHaveLength(1);
    expect(queue.open[0]).toMatchObject({
      source: "park_timeout",
      status: "open",
      callerNumber: NUMBERS.customer,
      lineLabel: "Allianz Assistance",
      sessionId: call.sessionId,
    });
  });

  it("keeps a parked caller waiting the limit they arrived with, not a shorter one saved meanwhile", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    await parkCall(actionDeps(h), o1, call.sessionId);

    // An admin lowers the waiting-room limit while the caller is parked: a
    // configuration change must not disturb a call in progress.
    h.db.update("motorist_telephony_settings", { park_max_minutes: 5 }, () => true);
    const tick = h.telnyx.of("gather").at(-1)!;
    h.advance(6 * 60_000);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: tick.params.clientState });
    expect(h.session(call.sessionId).state).toBe("parked");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);

    const next = h.telnyx.of("gather").at(-1)!;
    h.advance(25 * 60_000);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: next.params.clientState });
    expect(h.session(call.sessionId).state).toBe("callback_offered");
  });

  it("hangs up without a promise when the caller declines the offer", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    await parkCall(actionDeps(h), o1, call.sessionId);

    const tick = h.telnyx.of("gather").at(-1)!;
    h.advance(31 * 60_000);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: tick.params.clientState });
    const offer = h.telnyx.of("gatherUsingAudio").at(-1)!;
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: offer.params.clientState });

    // A promise nobody asked for is worse than none: nothing is queued.
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.callControlId);
  });
});
