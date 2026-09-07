import { describe, expect, it } from "vitest";

import { createFakeSupabase } from "@/test/fake-supabase";

import { applyTelnyxMessageStatus, parseTelnyxMessageEvent } from "./sms-status";

const NOW = new Date("2026-09-03T08:00:00.000Z");

function messageEvent(input: { type?: string; id?: string; status?: string; errors?: Array<Record<string, string>>; occurredAt?: string }) {
  return {
    data: {
      record_type: "event",
      event_type: input.type ?? "message.finalized",
      id: "evt-1",
      occurred_at: input.occurredAt ?? NOW.toISOString(),
      payload: {
        id: input.id ?? "msg-1",
        record_type: "message",
        direction: "outbound",
        from: { phone_number: "PomocMotor" },
        to: [{ phone_number: "+421905123456", status: input.status ?? "delivered" }],
        errors: input.errors ?? [],
      },
    },
  };
}

function harness(row: Record<string, unknown> = {}) {
  const fake = createFakeSupabase({ now: () => NOW });
  fake.db.seed("motorist_sms_messages", [
    {
      id: "sms-1",
      organization_id: "org-1",
      provider: "telnyx_sms",
      provider_message_id: "msg-1",
      to_number: "+421905123456",
      direction: "outbound",
      status: "sent",
      body: "test",
      sent_at: NOW.toISOString(),
      delivered_at: null,
      error: null,
      ...row,
    },
  ]);
  return fake;
}

describe("telnyx sms delivery status", () => {
  it("parses the per-recipient status out of the envelope", () => {
    const parsed = parseTelnyxMessageEvent(messageEvent({ status: "delivery_failed", errors: [{ code: "40300", title: "Blocked" }] }));
    expect(parsed).toMatchObject({ type: "message.finalized", providerMessageId: "msg-1", providerStatus: "delivery_failed", errors: ["40300 — Blocked"] });
  });

  it("marks a delivered message and stamps delivered_at", async () => {
    const fake = harness();
    const result = await applyTelnyxMessageStatus(fake.admin, messageEvent({ status: "delivered" }), { now: () => NOW });

    expect(result).toMatchObject({ outcome: "updated", status: "delivered", smsMessageId: "sms-1" });
    const row = fake.db.find("motorist_sms_messages", (candidate) => candidate.id === "sms-1");
    expect(row).toMatchObject({ status: "delivered", status_detail: "delivered", delivered_at: NOW.toISOString(), error: null });
  });

  it("records a failed delivery with the Telnyx error detail", async () => {
    const fake = harness();
    const result = await applyTelnyxMessageStatus(fake.admin, messageEvent({ status: "delivery_failed", errors: [{ code: "40001", detail: "Nedoručené" }] }), { now: () => NOW });

    expect(result).toMatchObject({ outcome: "updated", status: "failed" });
    expect(fake.db.find("motorist_sms_messages", (row) => row.id === "sms-1")).toMatchObject({ status: "failed", error: "40001 — Nedoručené" });
  });

  it("never moves a message backwards when events arrive out of order", async () => {
    const fake = harness({ status: "delivered", delivered_at: NOW.toISOString() });
    const result = await applyTelnyxMessageStatus(fake.admin, messageEvent({ type: "message.sent", status: "sent" }), { now: () => NOW });

    expect(result).toMatchObject({ outcome: "ignored", status: "delivered" });
    expect(fake.db.find("motorist_sms_messages", (row) => row.id === "sms-1")).toMatchObject({ status: "delivered" });
  });

  it("stays idempotent when Telnyx redelivers the same finalized event", async () => {
    const fake = harness();
    const event = messageEvent({ status: "delivered" });
    const first = await applyTelnyxMessageStatus(fake.admin, event, { now: () => NOW });
    const second = await applyTelnyxMessageStatus(fake.admin, event, { now: () => NOW });

    expect(first).toMatchObject({ outcome: "updated", status: "delivered" });
    expect(second).toMatchObject({ outcome: "ignored", status: "delivered", smsMessageId: "sms-1" });
    expect(fake.db.rows("motorist_sms_messages")).toHaveLength(1);
    expect(fake.db.find("motorist_sms_messages", (row) => row.id === "sms-1")).toMatchObject({
      status: "delivered",
      delivered_at: NOW.toISOString(),
    });
  });

  it("acknowledges an unknown message id and a foreign event type", async () => {
    const fake = harness();
    await expect(applyTelnyxMessageStatus(fake.admin, messageEvent({ id: "msg-other" }), { now: () => NOW })).resolves.toMatchObject({ outcome: "unknown_message" });
    await expect(applyTelnyxMessageStatus(fake.admin, messageEvent({ type: "call.hangup" }), { now: () => NOW })).resolves.toMatchObject({ outcome: "not_applicable" });
    await expect(applyTelnyxMessageStatus(fake.admin, messageEvent({ status: "sending" }), { now: () => NOW })).resolves.toMatchObject({ outcome: "ignored", status: "sent" });
    await expect(applyTelnyxMessageStatus(fake.admin, { data: { event_type: "message.finalized", id: "x", payload: { id: "msg-1", to: [{ status: "smoked" }] } } }, { now: () => NOW })).resolves.toMatchObject({ outcome: "ignored" });
  });
  it("preserves workflow metadata and author", async () => {
    const metadata = { location_link_id: "link-1", location_link_expires_at: "2026-09-04T08:00:00Z", task_id: "task-1", actor_profile_id: "author-1", template_version: 1 };
    const fake = harness({ raw_payload: metadata });
    await applyTelnyxMessageStatus(fake.admin, messageEvent({}), { now: () => NOW });
    expect(fake.db.rows("motorist_sms_messages")[0].raw_payload).toMatchObject({ ...metadata, provider_event: { id: "evt-1" } });
  });
  it("keeps unconfirmed delivery terminal against late sent events", async () => {
    const fake = harness();
    await applyTelnyxMessageStatus(fake.admin, messageEvent({ status: "delivery_unconfirmed" }));
    await applyTelnyxMessageStatus(fake.admin, messageEvent({ type: "message.sent", status: "sent" }));
    expect(fake.db.rows("motorist_sms_messages")[0]).toMatchObject({ status: "sent", status_detail: "delivery_unconfirmed" });
  });
  it("serializes competing receipts and prefers confirmed delivery", async () => {
    const fake = harness({ status: "queued", status_detail: "queued", updated_at: "2026-09-03T07:00:00Z" });
    const delivered = messageEvent({ status: "delivered" });
    const failed = messageEvent({ status: "delivery_failed" }); failed.data.id = "evt-2";
    await Promise.all([applyTelnyxMessageStatus(fake.admin, failed), applyTelnyxMessageStatus(fake.admin, delivered)]);
    expect(fake.db.rows("motorist_sms_messages")[0]).toMatchObject({ status: "delivered", status_detail: "delivered" });
  });
  it("scopes by provider, profile, sender and recipient", async () => {
    const fake = harness({ messaging_profile_id: "own" });
    await expect(applyTelnyxMessageStatus(fake.admin, messageEvent({}), { messagingProfileId: "own" })).resolves.toMatchObject({ outcome: "not_applicable" });
    const event = messageEvent({}); event.data.payload.to[0].phone_number = "+421905000000";
    await expect(applyTelnyxMessageStatus(fake.admin, event)).resolves.toMatchObject({ outcome: "ignored" });
    expect(fake.db.rows("motorist_sms_messages")[0].status).toBe("sent");
  });

});
