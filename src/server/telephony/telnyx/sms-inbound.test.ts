import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { receiveTelnyxSms } from "./sms-inbound";
const channel = { organizationId: "org", number: "+12025550123", messagingProfileId: "profile", verified: false, testRecipient: null };
function event(overrides: Record<string, unknown> = {}, id = "event-1") {
  return { data: { id, event_type: "message.received", occurred_at: "2026-09-07T10:00:00Z", payload: {
    id: "provider-id", direction: "inbound", messaging_profile_id: "profile", from: { phone_number: "+421905123456" },
    to: [{ phone_number: "+12025550123", status: "webhook_delivered" }], text: "Som na parkovisku.", ...overrides,
  } } };
}
function harness() { return createFakeSupabase({ uniqueKeys: { motorist_sms_messages: [["id"], ["organization_id", "provider", "idempotency_key"]] } }); }
describe("durable inbound Telnyx SMS", () => {
  it("stores a real message.received shape as unread and unassigned even when matching cases exist", async () => {
    const h = harness();
    h.db.seed("motorist_cases", [{ id: "first", organization_id: "org" }, { id: "latest", organization_id: "org" }]);
    expect(await receiveTelnyxSms(h.admin, event(), channel)).toMatchObject({ outcome: "stored" });
    expect(h.db.rows("motorist_sms_messages")).toMatchObject([{
      direction: "inbound", status: "received", status_detail: "received_unread", case_id: null,
      from_sender: "+421905123456", to_number: "+12025550123", body: "Som na parkovisku.", provider_message_id: "provider-id",
    }]);
  });
  it("deduplicates concurrent delivery and later event IDs without resetting case/read/dispatcher changes", async () => {
    const h = harness();
    const results = await Promise.all([receiveTelnyxSms(h.admin, event(), channel), receiveTelnyxSms(h.admin, event({}, "event-2"), channel)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["duplicate", "stored"]);
    const row = h.db.rows("motorist_sms_messages")[0];
    await h.admin.from("motorist_sms_messages").update({ case_id: "explicit-case", status_detail: "received_read", raw_payload: { inbox: { assigned_profile_id: "dispatcher" } } }).eq("id", String(row.id));
    await receiveTelnyxSms(h.admin, event({}, "event-3"), channel);
    expect(h.db.rows("motorist_sms_messages")).toMatchObject([{ case_id: "explicit-case", status_detail: "received_read", raw_payload: { inbox: { assigned_profile_id: "dispatcher" } } }]);
    expect(h.db.rows("motorist_sms_messages")).toHaveLength(1);
  });
  it("rejects foreign profiles/numbers before a database write", async () => {
    const h = harness();
    expect(await receiveTelnyxSms(h.admin, event({ messaging_profile_id: "foreign" }), channel)).toEqual({ outcome: "foreign_profile" });
    expect(await receiveTelnyxSms(h.admin, event({ to: [{ phone_number: "+12025550999" }] }), channel)).toEqual({ outcome: "foreign_number" });
    expect(h.db.rows("motorist_sms_messages")).toHaveLength(0);
  });
  it("normalizes E.164 and validates identity and direction", async () => {
    const h = harness();
    await receiveTelnyxSms(h.admin, event({ from: { phone_number: "00421 905 123 456" } }), channel);
    expect(h.db.rows("motorist_sms_messages")[0].from_sender).toBe("+421905123456");
    await expect(receiveTelnyxSms(h.admin, event({ id: null }), channel)).rejects.toMatchObject({ status: 400 });
    await expect(receiveTelnyxSms(h.admin, event({ direction: "outbound" }), channel)).rejects.toMatchObject({ status: 400 });
    await expect(receiveTelnyxSms(h.admin, event({ from: { phone_number: "not-a-phone" } }), channel)).rejects.toMatchObject({ status: 400 });
  });
  it("does not acknowledge a failed database write; the retry can persist it once", async () => {
    const h = harness(); h.db.failNext("motorist_sms_messages", "insert", "database unavailable");
    await expect(receiveTelnyxSms(h.admin, event(), channel)).rejects.toMatchObject({ status: 503 });
    expect(h.db.rows("motorist_sms_messages")).toHaveLength(0);
    expect(await receiveTelnyxSms(h.admin, event(), channel)).toMatchObject({ outcome: "stored" });
  });
  it("does not accept a conflicting message body under an already stored provider ID", async () => {
    const h = harness(); await receiveTelnyxSms(h.admin, event(), channel);
    await expect(receiveTelnyxSms(h.admin, event({ text: "Different body" }), channel)).rejects.toMatchObject({ status: 503 });
    expect(h.db.rows("motorist_sms_messages")[0].body).toBe("Som na parkovisku.");
  });
});
