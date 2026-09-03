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

    expect(claim).toEqual({ outcome: "claimed", status: "queued", attempts: 1 });
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
    await claimWebhookEvent(admin, input);
    await markWebhookEventProcessed(admin, "evt-1", { now: () => new Date(START + 200) });

    expect(db.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({
      status: "processed",
      processed_at: "2026-09-03T10:00:00.200Z",
      claimed_at: null,
      error: null,
    });

    db.setNow(new Date(START + 60_000));
    expect(await claimWebhookEvent(admin, input)).toEqual({ outcome: "duplicate", status: "processed", attempts: 1 });
  });

  it("reports busy while another invocation holds a fresh claim", async () => {
    const { admin, db, input } = harness();
    await claimWebhookEvent(admin, input);

    db.setNow(new Date(START + 10_000));
    expect(await claimWebhookEvent(admin, input)).toEqual({ outcome: "busy", status: "queued", attempts: 1 });
    expect(db.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ attempts: 1, claimed_at: "2026-09-03T10:00:00.000Z" });
  });

  it("lets a stale queued or failed claim be reprocessed", async () => {
    const { admin, db, input } = harness();
    await claimWebhookEvent(admin, input);
    await markWebhookEventFailed(admin, "evt-1", new Error("answer failed"));
    expect(db.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ status: "failed", error: "Error: answer failed" });

    db.setNow(new Date(START + 29_000));
    expect(await claimWebhookEvent(admin, input)).toMatchObject({ outcome: "busy" });

    db.setNow(new Date(START + 31_000));
    expect(await claimWebhookEvent(admin, input)).toEqual({ outcome: "claimed", status: "failed", attempts: 2 });
    expect(db.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ attempts: 2, claimed_at: "2026-09-03T10:00:31.000Z" });

    // A custom stale window is passed through to the RPC.
    db.setNow(new Date(START + 33_000));
    expect(await claimWebhookEvent(admin, { ...input, staleAfterMs: 1000 })).toMatchObject({ outcome: "claimed", attempts: 3 });
  });

  it("wraps RPC failures and malformed rows in WebhookLedgerError", async () => {
    const { admin, db, input } = harness();
    db.failNext("motorist_telnyx_claim_webhook_event", "rpc", "connection reset");
    await expect(claimWebhookEvent(admin, input)).rejects.toBeInstanceOf(WebhookLedgerError);

    db.registerRpc("motorist_telnyx_claim_webhook_event", () => [{ outcome: "weird", event_status: "queued", event_attempts: 1 }]);
    await expect(claimWebhookEvent(admin, input)).rejects.toThrow(/unexpected row/);

    await expect(claimWebhookEvent(admin, { ...input, eventId: "  " })).rejects.toThrow(/eventId/);
  });

  it("propagates update failures from the mark helpers", async () => {
    const { admin, db } = harness();
    db.failNext("motorist_telnyx_webhook_events", "update", "read only");
    await expect(markWebhookEventProcessed(admin, "evt-1")).rejects.toThrow(/read only/);
    db.failNext("motorist_telnyx_webhook_events", "update", "read only");
    await expect(markWebhookEventFailed(admin, "evt-1", "x")).rejects.toThrow(/read only/);
  });
});
