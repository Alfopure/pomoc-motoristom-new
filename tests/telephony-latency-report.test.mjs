import { test } from "node:test";
import assert from "node:assert/strict";
import { measureLatency } from "../scripts/measure-telephony-latency.mjs";

const at = ms => new Date(Date.UTC(2026, 8, 22) + ms).toISOString();

test("latency report excludes missing and reversed stamps and keeps replay ingress separate", () => {
  const events = [
    { ingress_at: at(0), claimed_at: at(100), lease_acquired_at: at(300), first_command_at: at(450), processing_ms: 700 },
    { ingress_at: at(0), claimed_at: at(1000), lease_acquired_at: at(900), first_command_at: null },
    { ingress_at: at(0), claimed_at: at(5000), source: "ledger_replay" },
  ].map(timing => ({ event_type: "call.answered", normalized_payload: { timing } }));
  const result = measureLatency(events).by_event["call.answered"];
  assert.deepEqual(result.ingress_to_claim, { n: 2, p50_ms: 100, p95_ms: 1000, max_ms: 1000 });
  assert.deepEqual(result.claim_to_lease, { n: 1, p50_ms: 200, p95_ms: 200, max_ms: 200 });
  assert.equal(result.lease_to_dispatch.n, 1);
});

test("holder report joins only the same session and overlapping confirmed lease spans", () => {
  const waiter = { scope: "webhook", deferral: "lease_busy", eventId: "e", sessionId: "s", lease_wait_ms: 200, finished_at: at(500), polls: 3 };
  const holder = { scope: "lease-timing", outcome: "finished", release_confirmed: true, sessionId: "s", lease_acquired_at: at(100), finished_at: at(400), eventType: "app.sweep", held_ms: 300, generation: 2 };
  const result = measureLatency([], [waiter, holder, { ...holder, sessionId: "other" }, { ...holder, release_confirmed: false }]);
  assert.equal(result.lease_deferrals[0].holders.length, 1);
  assert.equal(result.lease_deferrals[0].holders[0].overlap_ms, 100);
  assert.equal(measureLatency([], [waiter]).lease_deferrals[0].attribution, "unknown");
});
