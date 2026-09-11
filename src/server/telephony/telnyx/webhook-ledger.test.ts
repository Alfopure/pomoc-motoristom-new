import { describe, expect, it } from "vitest";

import { createFakeSupabase } from "@/test/fake-supabase";

import { claimWebhookEvent, describeWebhookClaim, markWebhookEventFailed, markWebhookEventProcessed, WebhookLedgerError } from "./webhook-ledger";

const START = Date.parse("2026-09-03T10:00:00.000Z");

function harness() {
  const fake = createFakeSupabase({ now: () => new Date(START) });
  const input = {
    eventId: "evt-1",
    eventType: "call.initiated",
    payload: { call_control_id: "cc-1", to: "+4210232408700" },
    organizationId: "00000000-0000-4000-8000-000000000001",
    callSessionId: "sess-1",
    callLegId: "leg-1",
    callControlId: "cc-1",
    connectionId: "3040091293100279025",
    occurredAt: "2026-09-03T09:59:59.500Z",
  };
  return { ...fake, input };
}

describe("claimWebhookEvent", () => {
  it("claims a fresh event and stores the envelope columns", async () => {
    const { admin, db, input } = harness();

    const claim = await claimWebhookEvent(admin, input);

    expect(claim).toMatchObject({ outcome: "claimed", status: "queued", attempts: 1, claimedAt: expect.any(String) });
    expect(describeWebhookClaim(claim)).toBe("claimed(queued#1)");
    expect(db.rows("motorist_telnyx_webhook_events")).toEqual([
      expect.objectContaining({
        event_id: "evt-1",
        event_type: "call.initiated",
        call_session_id: "sess-1",
        call_leg_id: "leg-1",
        call_control_id: "cc-1",
        connection_id: "3040091293100279025",
        organization_id: input.organizationId,
        occurred_at: input.occurredAt,
        status: "queued",
        attempts: 1,
        claimed_at: "2026-09-03T10:00:00.000Z",
        payload: input.payload,
      }),
    ]);
    expect(db.log.at(-1)?.payload).toMatchObject({ p_stale_after_ms: 30000 });
  });

  it("reports a processed event as duplicate", async () => {
    const { admin, db, input } = harness();
    const first = await claimWebhookEvent(admin, input);
    db.setNow(new Date(START + 200));
    await markWebhookEventProcessed(admin, "evt-1", { claimedAt: first.claimedAt });

    expect(db.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({
      status: "processed",
      processed_at: "2026-09-03T10:00:00.200Z",
      claimed_at: null,
      error: null,
    });

    db.setNow(new Date(START + 60_000));
    expect(await claimWebhookEvent(admin, input)).toMatchObject({ outcome: "duplicate", status: "processed", attempts: 1, claimedAt: null });
  });

  it("reports busy while another invocation holds a fresh claim", async () => {
    const { admin, db, input } = harness();
    await claimWebhookEvent(admin, input);

    db.setNow(new Date(START + 10_000));
    expect(await claimWebhookEvent(admin, input)).toMatchObject({ outcome: "busy", status: "queued", attempts: 1, claimedAt: expect.any(String) });
    expect(db.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ attempts: 1, claimed_at: "2026-09-03T10:00:00.000Z" });
  });

  it("lets a stale queued or failed claim be reprocessed", async () => {
    const { admin, db, input } = harness();
    const first = await claimWebhookEvent(admin, input);
    await markWebhookEventFailed(admin, "evt-1", new Error("answer failed"), { claimedAt: first.claimedAt });
    expect(db.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ status: "failed", error: "Error: answer failed" });

    db.setNow(new Date(START + 29_000));
    expect(await claimWebhookEvent(admin, input)).toMatchObject({ outcome: "busy" });

    db.setNow(new Date(START + 31_000));
    expect(await claimWebhookEvent(admin, input)).toMatchObject({ outcome: "claimed", status: "failed", attempts: 2, claimedAt: expect.any(String) });
    expect(db.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ attempts: 2, claimed_at: "2026-09-03T10:00:31.000Z" });

    // A custom stale window is passed through to the RPC.
    db.setNow(new Date(START + 33_000));
    expect(await claimWebhookEvent(admin, { ...input, staleAfterMs: 1000 })).toMatchObject({ outcome: "claimed", attempts: 3 });
  });

  it("backs off a deferred event briefly without allowing an old owner to release its replacement", async () => {
    const { admin, db, input } = harness();
    const first = await claimWebhookEvent(admin, input);
    expect(await markWebhookEventFailed(admin, input.eventId, "lease busy", { claimedAt: first.claimedAt, releaseForRetry: true })).toBe(true);
    db.setNow(new Date(START + 1));
    expect(await claimWebhookEvent(admin, input)).toMatchObject({ outcome: "busy" });
    db.setNow(new Date(START + 500));
    const second = await claimWebhookEvent(admin, input);
    expect(second).toMatchObject({ outcome: "claimed", attempts: 2 });
    expect(await markWebhookEventFailed(admin, input.eventId, "late failure", { claimedAt: first.claimedAt, releaseForRetry: true })).toBe(false);
    expect(db.rows("motorist_telnyx_webhook_events")[0].claimed_at).toBe(second.claimedAt);
    expect(await claimWebhookEvent(admin, input)).toMatchObject({ outcome: "busy" });
  });

  it("wraps RPC failures and malformed rows in WebhookLedgerError", async () => {
    const { admin, db, input } = harness();
    db.failNext("motorist_telnyx_claim_webhook_event_v2", "rpc", "connection reset");
    await expect(claimWebhookEvent(admin, input)).rejects.toBeInstanceOf(WebhookLedgerError);

    db.registerRpc("motorist_telnyx_claim_webhook_event_v2", () => [{ outcome: "weird", event_status: "queued", event_attempts: 1 }]);
    await expect(claimWebhookEvent(admin, input)).rejects.toThrow(/unexpected row/);

    await expect(claimWebhookEvent(admin, { ...input, eventId: "  " })).rejects.toThrow(/eventId/);
  });

  it("propagates update failures from the mark helpers", async () => {
    const { admin, db } = harness();
    db.failNext("motorist_telnyx_finish_webhook_event_v2", "rpc", "read only");
    await expect(markWebhookEventProcessed(admin, "evt-1", { claimedAt: new Date(START).toISOString() })).rejects.toThrow(/read only/);
    db.failNext("motorist_telnyx_finish_webhook_event_v2", "rpc", "read only");
    await expect(markWebhookEventFailed(admin, "evt-1", "x", { claimedAt: new Date(START).toISOString() })).rejects.toThrow(/read only/);
  });
  it("requires a claim stamp and cannot reverse completion", async () => {
    const { admin, db, input } = harness();
    const claim = await claimWebhookEvent(admin, input);
    await expect(markWebhookEventProcessed(admin, input.eventId)).rejects.toThrow(/claim stamp/);
    expect(await markWebhookEventProcessed(admin, input.eventId, { claimedAt: claim.claimedAt })).toBe(true);
    expect(await markWebhookEventFailed(admin, input.eventId, "late", { claimedAt: claim.claimedAt })).toBe(false);
    expect(db.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ status: "processed", effect_failure_count: 0 });
  });

  it("does not exhaust the effect-failure budget after more than five deferrals", async () => {
    const { admin, db, input } = harness();
    for (let count = 0; count < 8; count++) {
      const claim = await claimWebhookEvent(admin, input);
      expect(claim.outcome).toBe("claimed");
      await markWebhookEventFailed(admin, input.eventId, "lease busy", { claimedAt: claim.claimedAt, releaseForRetry: true });
      db.setNow(new Date(START + (count + 1) * 5000));
    }
    expect(db.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ attempts: 8, delivery_count: 8, deferral_count: 8, effect_failure_count: 0, retry_state: "deferred" });
    expect(await claimWebhookEvent(admin, { ...input, replay: "cron" })).toMatchObject({ outcome: "claimed", attempts: 9 });
    expect(db.rows("motorist_telnyx_webhook_events")[0].delivery_count).toBe(8);
  });

  it("terminalizes actual effect failures explicitly and cannot claim the dead letter", async () => {
    const { admin, db, input } = harness();
    for (let count = 0; count < 5; count++) {
      const claim = await claimWebhookEvent(admin, input);
      await markWebhookEventFailed(admin, input.eventId, "unknown command outcome", { claimedAt: claim.claimedAt });
      db.setNow(new Date(START + (count + 1) * 120_000));
    }
    expect(await claimWebhookEvent(admin, input)).toMatchObject({ outcome: "terminal", retryState: "dead_letter", terminalReason: "effect_failure_limit" });
    expect(db.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ effect_failure_count: 5, deferral_count: 0, claimed_at: null });
  });

});
