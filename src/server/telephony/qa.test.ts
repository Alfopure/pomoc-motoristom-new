import { describe, expect, it } from "vitest";

import type { FakeRow } from "@/test/fake-supabase";
import { createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { loadQaDashboard } from "./qa";

/**
 * The QA dashboard after recordings and transcripts left the scope.
 *
 * The interesting cases are the ones where the old score-based screen had
 * nothing to say: a call nobody documented, a promise kept a minute late, a
 * request cancelled instead of called back, and a `qa_score` table that stays
 * empty forever without the screen going blank.
 */

function deps(h: TelephonyHarness) {
  return { admin: h.deps.admin, organizationId: h.deps.organizationId, now: h.deps.now };
}

function ago(h: TelephonyHarness, minutes: number): string {
  return new Date(h.now().getTime() - minutes * 60_000).toISOString();
}

function seedCall(h: TelephonyHarness, row: FakeRow): void {
  h.db.insert("motorist_calls", {
    organization_id: ORG,
    provider: "telnyx",
    direction: "inbound",
    status: "ended",
    caller_number: NUMBERS.customer,
    line_id: LINES.allianz,
    started_at: ago(h, 60),
    answered_at: ago(h, 59),
    ended_at: ago(h, 55),
    operator_id: PROFILES.o1,
    case_id: null,
    raw_latest_payload: {},
    ...row,
  });
}

function seedCallback(h: TelephonyHarness, row: FakeRow): void {
  h.db.insert("motorist_callback_requests", {
    organization_id: ORG,
    caller_number: NUMBERS.customer,
    source: "ivr",
    status: "open",
    claimed_by: null,
    created_at: ago(h, 60),
    due_at: null,
    resolved_at: null,
    ...row,
  });
}

describe("loadQaDashboard — documentation", () => {
  it("measures the share of finished calls that carry an outcome", async () => {
    const h = createTelephonyHarness();
    seedCall(h, { raw_latest_payload: { outcome: "reached" }, case_id: null });
    seedCall(h, { raw_latest_payload: { outcome: "case_created" }, case_id: "00000000-0000-4000-8000-000000000801" });
    seedCall(h, { raw_latest_payload: {} });
    // Still in progress: it cannot be blamed for missing documentation yet.
    seedCall(h, { ended_at: null, status: "answered", raw_latest_payload: {} });

    const qa = await loadQaDashboard(deps(h));

    expect(qa.calls).toMatchObject({ completed: 3, documented: 2, documentedRate: 67, linkedToCase: 1, linkedRate: 50 });
    expect(qa.calls.byOutcome).toEqual([
      { outcome: "reached", label: "Dovolané", calls: 1 },
      { outcome: "case_created", label: "Prípad vytvorený", calls: 1 },
    ]);
  });

  it("ignores a value in the payload that is not a real outcome", async () => {
    const h = createTelephonyHarness();
    seedCall(h, { raw_latest_payload: { outcome: "vyriešené" } });

    const qa = await loadQaDashboard(deps(h));

    expect(qa.calls).toMatchObject({ completed: 1, documented: 0, documentedRate: 0 });
  });

  it("says the screen has no audio rather than implying it is missing", async () => {
    const qa = await loadQaDashboard(deps(createTelephonyHarness()));
    expect(qa).toMatchObject({ recordingEnabled: false, transcriptsEnabled: false, promiseMinutes: 30 });
  });
});

describe("loadQaDashboard — callback compliance", () => {
  it("counts a promise kept, a promise kept late and one still open past its deadline", async () => {
    const h = createTelephonyHarness();
    // Called back 10 minutes after the request: inside the 30-minute promise.
    seedCallback(h, { status: "done", claimed_by: PROFILES.o1, created_at: ago(h, 120), resolved_at: ago(h, 110) });
    // Called back after 45 minutes: settled, but the promise was broken.
    seedCallback(h, { status: "done", claimed_by: PROFILES.o2, created_at: ago(h, 120), resolved_at: ago(h, 75) });
    // Still open 60 minutes on: the clock did not stop because nobody looked.
    seedCallback(h, { status: "open", created_at: ago(h, 60) });
    // Fresh: not late yet.
    seedCallback(h, { status: "open", created_at: ago(h, 5) });
    // Cancelled: counted, but neither kept nor broken.
    seedCallback(h, { status: "cancelled", created_at: ago(h, 200), resolved_at: ago(h, 100) });

    const qa = await loadQaDashboard(deps(h));

    expect(qa.callbacks).toMatchObject({
      created: 5,
      done: 2,
      cancelled: 1,
      open: 2,
      overdue: 2,
      onTime: 1,
      // 1 kept out of the 4 requests that owed a call back.
      onTimeRate: 25,
      averageMinutesToClose: 28,
      medianMinutesToClose: 28,
    });
  });

  it("leaves a request it cannot time out of the rate instead of guessing", async () => {
    const h = createTelephonyHarness();
    // Settled, but nothing recorded when: praising or blaming it would invent a
    // compliance number nobody can check.
    seedCallback(h, { status: "done", claimed_by: PROFILES.o1, created_at: ago(h, 120), resolved_at: null });
    seedCallback(h, { status: "done", claimed_by: PROFILES.o1, created_at: ago(h, 120), resolved_at: ago(h, 110) });

    const qa = await loadQaDashboard(deps(h));

    expect(qa.callbacks).toMatchObject({ done: 2, measured: 1, onTime: 1, overdue: 0, onTimeRate: 100 });
  });

  it("honours an explicit due date instead of the default half hour", async () => {
    const h = createTelephonyHarness();
    // The caller asked to be rung back in two hours; calling back after 45
    // minutes is early, not late.
    seedCallback(h, {
      status: "done",
      claimed_by: PROFILES.o1,
      created_at: ago(h, 120),
      due_at: new Date(h.now().getTime() - 120 * 60_000 + 120 * 60_000).toISOString(),
      resolved_at: ago(h, 75),
    });

    const qa = await loadQaDashboard(deps(h));

    expect(qa.callbacks).toMatchObject({ done: 1, onTime: 1, overdue: 0, onTimeRate: 100 });
  });

  it("groups the requests by where they came from", async () => {
    const h = createTelephonyHarness();
    seedCallback(h, { source: "ivr", status: "done", resolved_at: ago(h, 50) });
    seedCallback(h, { source: "ivr", status: "open" });
    seedCallback(h, { source: "after_hours", status: "done", resolved_at: ago(h, 50) });

    const qa = await loadQaDashboard(deps(h));

    expect(qa.callbacks.bySource).toEqual([
      { source: "ivr", calls: 2, done: 1 },
      { source: "after_hours", calls: 1, done: 1 },
    ]);
  });
});

describe("loadQaDashboard — operators", () => {
  it("names each dispatcher with their documentation and their kept promises", async () => {
    const h = createTelephonyHarness();
    seedCall(h, { operator_id: PROFILES.o1, raw_latest_payload: { outcome: "reached" } });
    seedCall(h, { operator_id: PROFILES.o1, raw_latest_payload: {} });
    seedCall(h, { operator_id: PROFILES.o2, raw_latest_payload: { outcome: "not_reached" } });
    // Nobody answered it: it belongs to no dispatcher's documentation score.
    seedCall(h, { operator_id: null, status: "missed", answered_at: null, raw_latest_payload: {} });
    seedCallback(h, { status: "done", claimed_by: PROFILES.o1, created_at: ago(h, 60), resolved_at: ago(h, 50) });
    seedCallback(h, { status: "done", claimed_by: PROFILES.o1, created_at: ago(h, 60), resolved_at: ago(h, 10) });

    const qa = await loadQaDashboard(deps(h));

    expect(qa.operators).toHaveLength(2);
    expect(qa.operators[0]).toMatchObject({
      name: "Jana Dispečerka",
      calls: 2,
      documented: 1,
      documentedRate: 50,
      callbacksHandled: 2,
      callbacksOnTime: 1,
      callbacksOnTimeRate: 50,
    });
    expect(qa.operators[1]).toMatchObject({ name: "Peter Dispečer", calls: 1, documented: 1, documentedRate: 100, callbacksHandled: 0, callbacksOnTimeRate: null });
  });
});

describe("loadQaDashboard — window", () => {
  it("looks back thirty days and leaves older calls out", async () => {
    const h = createTelephonyHarness();
    seedCall(h, { started_at: ago(h, 29 * 24 * 60), raw_latest_payload: { outcome: "reached" } });
    seedCall(h, { started_at: ago(h, 31 * 24 * 60), raw_latest_payload: { outcome: "reached" } });

    const qa = await loadQaDashboard(deps(h));

    expect(qa.lookbackDays).toBe(30);
    expect(qa.calls.completed).toBe(1);
  });

  it("answers with empty counters rather than failing on a quiet organisation", async () => {
    const qa = await loadQaDashboard(deps(createTelephonyHarness()));
    expect(qa.calls).toMatchObject({ completed: 0, documented: 0, documentedRate: null, byOutcome: [] });
    expect(qa.callbacks).toMatchObject({ created: 0, onTimeRate: null, averageMinutesToClose: null });
    expect(qa.operators).toEqual([]);
  });
});
