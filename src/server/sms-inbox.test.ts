import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
const adminMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: adminMock }));
vi.mock("@/lib/supabase/env", () => ({ requireSupabaseServiceEnv: () => ({ serviceKey: "test-draft-secret" }) }));
import { getInboundSms, loadSmsConversation, loadSmsInbox, loadSmsInboxSummary, updateSmsInboxMessage } from "./sms-inbox";
import { prepareSms, sendPreparedSms } from "./sms-workflow";

const org = "11111111-1111-4111-8111-111111111111";
const actor = { organizationId: org, actorProfileId: "dispatcher" };
const local = "+12025550123";
const remote = "+421905123456";
function harness() {
  const h = createFakeSupabase({ uniqueKeys: { motorist_sms_messages: [["id"], ["organization_id", "provider", "idempotency_key"]] } });
  adminMock.mockReturnValue(h.admin);
  h.db.seed("motorist_sms_messages", [{ id: "inbound", organization_id: org, provider: "telnyx_sms", provider_message_id: "provider", messaging_profile_id: "profile",
    from_sender: remote, to_number: local, body: "Prijatá správa", direction: "inbound", status: "received", status_detail: "received_unread", case_id: null,
    raw_payload: { source: "telnyx_inbound", inbox: { assigned_profile_id: null }, provider_event: { id: "immutable-event" } } }]);
  h.db.seed("motorist_cases", [{ id: "case-1", organization_id: org, case_number: "PM-123", contact_id: "primary" }, { id: "case-2", organization_id: org, case_number: "PM-456" }, { id: "foreign-case", organization_id: "foreign" }]);
  h.db.seed("motorist_contacts", [{ id: "primary", organization_id: org, name: "Iný primárny kontakt", phone: "+421905999999" }]);
  h.db.seed("motorist_profiles", [{ id: "dispatcher", organization_id: org, display_name: "Dispečer", active: true, access_status: "active" }, { id: "foreign-profile", organization_id: "foreign", active: true, access_status: "active" }, { id: "disabled", organization_id: org, active: false, access_status: "disabled" }]);
  return h;
}
beforeEach(() => {
  vi.stubEnv("TELNYX_API_KEY", "test-key"); vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "profile");
  vi.stubEnv("TELNYX_PUBLIC_KEY", "test-public-key");
  vi.stubEnv("TELNYX_SMS_FROM_NUMBER", local); vi.stubEnv("TELNYX_SMS_ORGANIZATION_ID", org); vi.stubEnv("TELNYX_SMS_REPLIES_VERIFIED", "true");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("inbox ownership and explicit assignment", () => {
  it("lists unknown senders without a case and keeps other organizations out", async () => {
    const h = harness();
    h.db.seed("motorist_sms_messages", [{ id: "foreign", organization_id: "foreign", provider: "telnyx_sms", direction: "inbound", status_detail: "received_unread" }]);
    expect(await loadSmsInboxSummary(org)).toEqual({ unreadCount: 1 });
    const inbox = await loadSmsInbox(org, "unassigned");
    expect(inbox.messages).toMatchObject([{ id: "inbound", caseId: null, unread: true, canReply: true }]);
    expect(inbox.operators).toEqual([{ id: "dispatcher", name: "Dispečer" }]);
    await expect(getInboundSms(h.admin, org, "foreign")).rejects.toMatchObject({ status: 404 });
  });
  it("assigns only the selected message and persists a shared read state while preserving the receipt", async () => {
    const h = harness();
    const row = await getInboundSms(h.admin, org, "inbound");
    await updateSmsInboxMessage(actor, "inbound", { caseId: "case-2", assignedProfileId: "dispatcher", version: row.updated_at });
    await updateSmsInboxMessage(actor, "inbound", { read: true });
    const inbox = await loadSmsInbox(org);
    expect(inbox.messages).toMatchObject([{ id: "inbound", caseId: "case-2", caseNumber: "PM-456", assignedName: "Dispečer", unread: false }]);
    expect(await loadSmsInboxSummary(org)).toEqual({ unreadCount: 0 });
    expect((await loadSmsInbox(org, "unassigned")).messages).toEqual([]);
    expect((await loadSmsInbox(org, "unread")).messages).toEqual([]);
    expect((await getInboundSms(h.admin, org, "inbound")).raw_payload).toMatchObject({ source: "telnyx_inbound", provider_event: { id: "immutable-event" }, inbox: { assigned_by: "dispatcher", read_by: "dispatcher" } });
  });
  it("rejects foreign cases, inactive/foreign dispatchers and stale concurrent assignments", async () => {
    const h = harness(); const row = await getInboundSms(h.admin, org, "inbound");
    await expect(updateSmsInboxMessage(actor, "inbound", { caseId: "foreign-case", version: row.updated_at })).rejects.toMatchObject({ status: 400 });
    for (const profile of ["foreign-profile", "disabled"]) await expect(updateSmsInboxMessage(actor, "inbound", { assignedProfileId: profile, version: row.updated_at })).rejects.toMatchObject({ status: 400 });
    h.db.advance(1000);
    await updateSmsInboxMessage(actor, "inbound", { caseId: "case-1", version: row.updated_at });
    await expect(updateSmsInboxMessage(actor, "inbound", { caseId: "case-2", version: row.updated_at })).rejects.toMatchObject({ status: 409 });
    expect((await getInboundSms(h.admin, org, "inbound")).case_id).toBe("case-1");
  });
  it("paginates without losing unassigned messages or counting outbound messages as unread", async () => {
    const h = harness();
    h.db.seed("motorist_sms_messages", Array.from({ length: 51 }, (_, i) => ({ id: `in-${i}`, organization_id: org, provider: "telnyx_sms", from_sender: remote, to_number: local, direction: "inbound", status_detail: "received_unread", raw_payload: {}, case_id: null })));
    h.db.seed("motorist_sms_messages", [{ id: "out", organization_id: org, provider: "telnyx_sms", direction: "outbound", status_detail: "received_unread" }]);
    expect((await loadSmsInbox(org)).messages).toHaveLength(50);
    expect((await loadSmsInbox(org)).hasMore).toBe(true);
    expect((await loadSmsInbox(org, "all", 50)).messages).toHaveLength(2);
    expect(await loadSmsInboxSummary(org)).toEqual({ unreadCount: 52 });
  });
  it("scopes a conversation to both phone numbers, the profile and organization, independent of cases", async () => {
    const h = harness();
    h.db.seed("motorist_sms_messages", [
      { id: "reply", organization_id: org, provider: "telnyx_sms", from_sender: local, to_number: remote, direction: "outbound", messaging_profile_id: "profile", body: "Odpoveď", case_id: "case-2" },
      { id: "other-profile", organization_id: org, provider: "telnyx_sms", from_sender: local, to_number: remote, direction: "outbound", messaging_profile_id: "other-profile" },
      { id: "other-number", organization_id: org, provider: "telnyx_sms", from_sender: local, to_number: "+421905999999", direction: "outbound", messaging_profile_id: "profile" },
      { id: "other-org", organization_id: "foreign", provider: "telnyx_sms", from_sender: local, to_number: remote, direction: "outbound", messaging_profile_id: "profile" },
    ]);
    const conversation = await loadSmsConversation(org, "inbound");
    expect(conversation.messages.map((row) => row.id).sort()).toEqual(["inbound", "reply"]);
    expect(conversation.messages.find((row) => row.id === "reply")?.caseNumber).toBe("PM-456");
  });
});

describe("replies through the verified editor", () => {
  async function preview() { return prepareSms({ ...actor, replyToMessageId: "inbound", requestId: randomUUID(), template: "custom", message: "Odpoveď klientovi.", publicBaseUrl: "https://sms.test" }); }
  it("replies to the actual sender from the receiving number, even when a case's primary contact differs", async () => {
    const h = harness();
    await h.admin.from("motorist_sms_messages").update({ case_id: "case-1" }).eq("id", "inbound");
    const p = await preview();
    expect(p.draft).toMatchObject({ toNumber: remote, sender: local, caseId: "case-1", caseNumber: "PM-123", replyToMessageId: "inbound", repliesEnabled: true });
    const send = vi.fn().mockResolvedValue({ status: "sent", providerMessageId: "sent-id", fromSender: local, messagingProfileId: "profile" });
    const input = { ...p, ...actor, message: p.draft.message };
    await sendPreparedSms(input, { transport: { send } });
    await sendPreparedSms(input, { transport: { send } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: remote, from: local }));
  });
  it("rejects a changed case assignment or channel before sending", async () => {
    const h = harness(); const p = await preview(); const send = vi.fn();
    await h.admin.from("motorist_sms_messages").update({ case_id: "case-2" }).eq("id", "inbound");
    await expect(sendPreparedSms({ ...p, ...actor, message: p.draft.message }, { transport: { send } })).rejects.toMatchObject({ status: 409 });
    vi.stubEnv("TELNYX_SMS_FROM_NUMBER", "+12025550999");
    await expect(preview()).rejects.toMatchObject({ status: 423 });
    expect(send).not.toHaveBeenCalled();
  });
  it("does not let a client change the recipient or use an unrelated case", async () => {
    harness();
    for (const override of [{ toNumber: "+421905999999" }, { caseId: "case-2" }]) {
      await expect(prepareSms({ ...actor, replyToMessageId: "inbound", requestId: randomUUID(), template: "custom", message: "Test", publicBaseUrl: "https://sms.test", ...override })).rejects.toMatchObject({ status: 409 });
    }
  });
});
