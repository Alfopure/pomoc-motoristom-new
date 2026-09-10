import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
const adminMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: adminMock }));
vi.mock("@/lib/supabase/env", () => ({ requireSupabaseServiceEnv: () => ({ serviceKey: "test-draft-secret" }) }));
import { normalizeSmsRecipient, notConfiguredTransport, prepareSms, resolveSmsTransport, sendCaseSms, sendPreparedSms, SmsWorkflowError, type SmsTransport } from "./sms-workflow";
import { applyTelnyxMessageStatus } from "./telephony/telnyx/sms-status";
import type { SmsPrepareInput } from "@/lib/sms/contracts";

const actor = { actorProfileId: "dispatcher", organizationId: "org-1" };
function harness() {
  const fake = createFakeSupabase({ uniqueKeys: {
    motorist_sms_messages: [["id"], ["organization_id", "provider", "idempotency_key"]],
    motorist_location_share_links: [["id"], ["token_hash"]],
  } });
  adminMock.mockReturnValue(fake.admin);
  fake.db.seed("motorist_cases", [{ id: "case-1", organization_id: "org-1", case_number: "PM-123", contact_id: "contact-1", owner_id: "someone-else" }]);
  fake.db.seed("motorist_contacts", [{ id: "contact-1", organization_id: "org-1", name: "Klient", phone: "0905 123 456" }]);
  fake.db.seed("motorist_organization_profiles", [{ id: "op-1", organization_id: "org-1", brand_name: "Pomoc motoristom", primary_phone: "+421905654321" }]);
  const send = vi.fn().mockResolvedValue({ providerMessageId: "msg-1", status: "sent", providerStatus: "sent", fromSender: "PomocMotor", messagingProfileId: "profile-1" });
  const transport: SmsTransport = { send };
  return { ...fake, send, transport };
}
async function preview(overrides: Partial<SmsPrepareInput> = {}) {
  return prepareSms({ ...actor, requestId: randomUUID(), template: "custom", message: "Test", toNumber: "0905 123 456", publicBaseUrl: "https://sms.example", ...overrides });
}
beforeEach(() => { vi.stubEnv("TELNYX_API_KEY", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("SMS preparation and verified recipient", () => {
  it.each([false, true])("never promotes an editable title to task proof (workspace enabled=%s)", async enabled => {
    const h = harness();
    h.db.seed("motorist_task_workspace_settings", [{ organization_id: "org-1", enabled, writer_inventory_verified_at: "2026-09-10", writer_inventory_note: "Local test" }]);
    h.db.seed("motorist_case_tasks", [
      { id: "contract", organization_id: "org-1", case_id: "case-1", status: "open", title: "Overiť ETA zmluvy" },
      { id: "unrelated", organization_id: "org-1", case_id: "case-1", status: "open", title: "Vyúčtovať lokalizačnú SMS" },
    ]);
    const eta = await preview({ caseId: "case-1", template: "eta_update", etaMinutes: 20, technicianDeparted: true });
    const location = await preview({ caseId: "case-1", template: "location_request" });
    expect(eta.draft).toMatchObject({ taskId: null, taskAssociation: null });
    expect(location.draft).toMatchObject({ taskId: null, taskAssociation: null });
    await sendPreparedSms({ ...actor, ...eta, message: eta.draft.message }, { transport: h.transport });
    expect(h.db.rows("motorist_sms_messages")[0].raw_payload).toMatchObject({ task_id: null, task_association: null });
    expect(h.db.rows("motorist_case_tasks").every(task => task.status === "open")).toBe(true);
  });
  it("accepts only an explicit open original-case task and rechecks before provider effects", async () => {
    const h = harness();
    h.db.seed("motorist_case_tasks", [
      { id: "chosen", organization_id: "org-1", case_id: "case-1", status: "overdue", title: "Explicit user choice" },
      { id: "done", organization_id: "org-1", case_id: "case-1", status: "done" },
      { id: "elsewhere", organization_id: "org-2", case_id: "case-1", status: "open" },
    ]);
    const context = { caseId: "case-1", template: "eta_update" as const, etaMinutes: 20, technicianDeparted: true };
    for (const taskId of ["done", "elsewhere"]) await expect(preview({ ...context, taskId })).rejects.toMatchObject({ status: 400 });
    const selected = await preview({ ...context, taskId: "chosen" });
    expect(selected.draft).toMatchObject({ taskId: "chosen", taskAssociation: "explicit" });
    await h.admin.from("motorist_case_tasks").update({ status: "done" }).eq("id", "chosen");
    await expect(sendPreparedSms({ ...actor, ...selected, message: selected.draft.message }, { transport: h.transport })).rejects.toMatchObject({ status: 400 });
    expect(h.send).not.toHaveBeenCalled(); expect(h.db.rows("motorist_sms_messages")).toHaveLength(0);
  });
  it("preserves explicit task association on the old schema and the same proven SMS workflow", async () => {
    const h = harness();
    h.db.seed("motorist_case_tasks", [{ id: "chosen", organization_id: "org-1", case_id: "case-1", status: "open", title: "Renamed" }]);
    const context = { caseId: "case-1", template: "eta_update" as const, etaMinutes: 20, technicianDeparted: true, taskId: "chosen" };
    h.db.failNext("motorist_task_origins", "select", { code: "42P01", message: "relation absent", details: null, hint: null });
    expect((await preview(context)).draft.taskId).toBe("chosen");
    h.db.seed("motorist_task_origins", [{ task_id: "chosen", organization_id: "org-1", source_type: "sms", source_id: "original-sms", origin_case_id: "case-1", cancelled_at: null }]);
    h.db.seed("motorist_sms_messages", [{ id: "original-sms", organization_id: "org-1", case_id: "case-1", template_key: "eta_update" }]);
    const selected = await preview(context);
    expect(selected.draft.taskAssociation).toBe("explicit");
    h.db.failNext("motorist_task_origins", "select", { code: "08006", message: "temporary", details: null, hint: null });
    await expect(preview(context)).rejects.toMatchObject({ status: 503 });
  });
  it("cannot fulfill a callback obligation by explicitly selecting its task for ETA", async () => {
    const h = harness();
    h.db.seed("motorist_case_tasks", [{ id: "callback", organization_id: "org-1", case_id: "case-1", status: "open", title: "Renamed ETA" }]);
    h.db.seed("motorist_task_origins", [{ task_id: "callback", organization_id: "org-1", source_type: "callback", source_id: "request", origin_case_id: "case-1", cancelled_at: null }]);
    await expect(preview({ caseId: "case-1", template: "eta_update", etaMinutes: 20, technicianDeparted: true, taskId: "callback" })).rejects.toMatchObject({ status: 409 });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("prepares a global draft with no case and without a write", async () => {
    const h = harness();
    const p = await preview();
    expect(p.draft).toMatchObject({ caseId: null, toNumber: "+421905123456", actorProfileId: "dispatcher" });
    expect(h.db.rows("motorist_sms_messages")).toHaveLength(0);
    expect(h.db.rows("motorist_location_share_links")).toHaveLength(0);
  });
  it("rejects missing, nonexistent and foreign cases and missing contacts", async () => {
    const h = harness();
    await expect(preview({ template: "location_request" })).rejects.toMatchObject({ status: 400 });
    await expect(preview({ template: "location_request", caseId: "missing" })).rejects.toMatchObject({ status: 404 });
    h.db.seed("motorist_cases", [{ id: "foreign", organization_id: "org-2" }]);
    await expect(preview({ template: "location_request", caseId: "foreign" })).rejects.toMatchObject({ status: 404 });
    h.db.seed("motorist_cases", [{ id: "no-contact", organization_id: "org-1" }]);
    await expect(preview({ template: "location_request", caseId: "no-contact" })).rejects.toMatchObject({ status: 400 });
  });
  it("resolves the saved contact and freezes it in the proof", async () => {
    const h = harness();
    const p = await preview({ caseId: "case-1", toNumber: "+421999999999", template: "location_request" });
    expect(p.draft.toNumber).toBe("+421905123456");
    expect(p.draft.message).toContain(p.draft.templateContext.link);
    expect(p.draft.locationToken).toHaveLength(43);
    await h.admin.from("motorist_contacts").update({ phone: "+421905999999" }).eq("id", "contact-1");
    await expect(sendPreparedSms({ ...actor, ...p, message: p.draft.message }, { transport: h.transport })).rejects.toMatchObject({ status: 409 });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.db.rows("motorist_sms_messages")).toHaveLength(0);
  });
  it("rejects unknown templates and ETA inferred only from a route", async () => {
    harness();
    await expect(preview({ template: "unknown" as never })).rejects.toMatchObject({ status: 400 });
    await expect(preview({ caseId: "case-1", template: "eta_update", etaMinutes: 20 })).rejects.toMatchObject({ status: 400 });
    await expect(preview({ caseId: "case-1", template: "eta_update", etaMinutes: 20, technicianDeparted: true })).resolves.toHaveProperty("proof");
  });
  it("rejects altered proofs, another actor, another case and removed template facts", async () => {
    const h = harness(); const p = await preview({ caseId: "case-1", template: "location_request" });
    await expect(sendPreparedSms({ ...actor, ...p, draft: { ...p.draft, toNumber: "+421905999999" }, message: p.draft.message }, { transport: h.transport })).rejects.toMatchObject({ status: 403 });
    await expect(sendPreparedSms({ ...actor, ...p, actorProfileId: "other", message: p.draft.message }, { transport: h.transport })).rejects.toMatchObject({ status: 403 });
    await expect(sendCaseSms({ ...actor, ...p, caseId: "other-case", message: p.draft.message }, { transport: h.transport })).rejects.toMatchObject({ status: 400 });
    await expect(sendPreparedSms({ ...actor, ...p, message: "No link" }, { transport: h.transport })).rejects.toMatchObject({ status: 400 });
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("durable SMS send and retries", () => {
  it("reconciles durable ETA acceptance after a transient completion failure without sending or auditing twice", async () => {
    const h = harness();
    const complete = vi.fn(() => ({ completed: true }));
    h.db.seed("motorist_case_tasks", [{ id: "task-1", organization_id: "org-1", case_id: "case-1", status: "open" }]);
    h.db.registerRpc("motorist_complete_task_source_v1", complete);
    h.db.failNext("motorist_complete_task_source_v1", "rpc", { code: "08006", message: "temporary", details: null, hint: null });
    const p = await preview({ caseId: "case-1", template: "eta_update", etaMinutes: 20, technicianDeparted: true, taskId: "task-1" });
    const input = { ...actor, ...p, message: p.draft.message };
    await expect(sendPreparedSms(input, { transport: h.transport })).rejects.toThrow("Task source completion failed.");
    await expect(sendPreparedSms(input, { transport: h.transport })).resolves.toMatchObject({ reused: true, providerMessageId: "msg-1" });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.db.rows("motorist_sms_messages")).toHaveLength(1);
    expect(h.db.rows("motorist_sms_attempts")).toHaveLength(1);
    expect(h.db.rows("motorist_case_events")).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(h.db.log.filter(entry => entry.kind === "rpc" && entry.table === "motorist_complete_task_source_v1")).toHaveLength(2);
    await expect(sendPreparedSms({ ...input, message: input.message + " changed" }, { transport: h.transport })).rejects.toMatchObject({ status: 409 });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("does not complete an ETA task on uncertain transport or fall back after unsupported proof", async () => {
    const h = harness();
    const complete = vi.fn(() => ({ completed: false }));
    h.db.registerRpc("motorist_complete_task_source_v1", complete);
    h.db.seed("motorist_case_tasks", [{ id: "task-1", organization_id: "org-1", case_id: "case-1", status: "open" }]);
    const p = await preview({ caseId: "case-1", template: "eta_update", etaMinutes: 20, technicianDeparted: true, taskId: "task-1" });
    const input = { ...actor, ...p, message: p.draft.message };
    await sendPreparedSms(input, { transport: h.transport });
    await sendPreparedSms(input, { transport: h.transport });
    expect(h.db.rows("motorist_case_tasks")[0].status).toBe("open");
    expect(complete).toHaveBeenCalledTimes(2);
    const uncertain = await preview({ caseId: "case-1", template: "eta_update", etaMinutes: 20, technicianDeparted: true, taskId: "task-1" });
    h.send.mockRejectedValueOnce(new Error("socket closed"));
    const uncertainInput = { ...actor, ...uncertain, message: uncertain.draft.message };
    await sendPreparedSms(uncertainInput, { transport: h.transport });
    await sendPreparedSms(uncertainInput, { transport: h.transport });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("persists exact text, authenticated author and template version", async () => {
    const h = harness(); const p = await preview({ caseId: "case-1", template: "location_request" });
    const result = await sendPreparedSms({ ...actor, ...p, message: p.draft.message }, { transport: h.transport });
    expect(result).toMatchObject({ status: "sent", reused: false });
    const row = h.db.rows("motorist_sms_messages")[0];
    expect(row).toMatchObject({ body: p.draft.message, to_number: p.draft.toNumber, template_key: "location_request", raw_payload: { actor_profile_id: "dispatcher", template_version: 1, location_link_id: p.draft.locationLinkId } });
    expect(h.db.rows("motorist_location_share_links")[0]).toMatchObject({ created_by: "dispatcher", case_id: "case-1" });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ body: p.draft.message, to: p.draft.toNumber }));
  });
  it("reuses one global SMS across sequential and concurrent retries", async () => {
    const h = harness(); const p = await preview(); const input = { ...actor, ...p, message: p.draft.message };
    const results = await Promise.all([sendPreparedSms(input, { transport: h.transport }), sendPreparedSms(input, { transport: h.transport })]);
    expect(new Set(results.map((r) => r.smsMessageId)).size).toBe(1);
    await sendPreparedSms(input, { transport: h.transport });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.db.rows("motorist_sms_messages")).toHaveLength(1);
    expect(h.db.rows("motorist_sms_attempts")).toHaveLength(1);
    await expect(sendPreparedSms({ ...input, message: "Different" }, { transport: h.transport })).rejects.toMatchObject({ status: 409 });
  });
  it("preserves location metadata through a receipt and never sends the retry again", async () => {
    const h = harness(); const p = await preview({ caseId: "case-1", template: "location_request" }); const input = { ...actor, ...p, message: p.draft.message };
    await sendPreparedSms(input, { transport: h.transport });
    await applyTelnyxMessageStatus(h.admin, { data: { id: "evt-1", event_type: "message.finalized", payload: { id: "msg-1", direction: "outbound", from: { phone_number: "PomocMotor" }, to: [{ phone_number: p.draft.toNumber, status: "delivered" }] } } });
    expect((await sendPreparedSms(input, { transport: h.transport })).status).toBe("delivered");
    expect(h.db.rows("motorist_sms_messages")[0].raw_payload).toMatchObject({ location_link_id: p.draft.locationLinkId, actor_profile_id: "dispatcher", provider_event: { id: "evt-1" } });
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it("never re-sends an uncertain transport outcome", async () => {
    const h = harness(); h.send.mockRejectedValue(new Error("network timeout")); const p = await preview(); const input = { ...actor, ...p, message: p.draft.message };
    expect(await sendPreparedSms(input, { transport: h.transport })).toMatchObject({ status: "sent", statusDetail: "send_unconfirmed" });
    expect(await sendPreparedSms(input, { transport: h.transport })).toMatchObject({ reused: true, statusDetail: "send_unconfirmed" });
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it("keeps a definite rejection durable and allows a deliberate new request", async () => {
    const h = harness(); h.send.mockRejectedValueOnce(new SmsWorkflowError("Rejected", 400)); const p = await preview({ caseId: "case-1", template: "location_request" }); const input = { ...actor, ...p, message: p.draft.message };
    expect(await sendPreparedSms(input, { transport: h.transport })).toMatchObject({ status: "failed" });
    expect(h.db.rows("motorist_location_share_links")[0].status).toBe("revoked");
    await sendPreparedSms(input, { transport: h.transport });
    const next = await preview({ caseId: "case-1", template: "location_request" });
    await sendPreparedSms({ ...actor, ...next, message: next.draft.message }, { transport: h.transport });
    expect(h.send).toHaveBeenCalledTimes(2);
  });
  it("blocks unconfigured transports and kill switches before writes", async () => {
    const h = harness(); const p = await preview(); const input = { ...actor, ...p, message: p.draft.message };
    expect(resolveSmsTransport()).toBe(notConfiguredTransport);
    await expect(sendPreparedSms(input)).rejects.toMatchObject({ status: 503 });
    await expect(sendPreparedSms(input, { transport: { send: h.send, preflight: async () => { throw new SmsWorkflowError("Disabled", 423); } } })).rejects.toMatchObject({ status: 423 });
    expect(h.send).not.toHaveBeenCalled(); expect(h.db.rows("motorist_sms_messages")).toHaveLength(0);
  });
});
describe("normalizeSmsRecipient", () => {
  it.each([
    ["0905 123 456", "+421905123456"],
    ["+421 905 123 456", "+421905123456"],
    ["00420777123456", "+420777123456"],
    ["421905123456", "+421905123456"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeSmsRecipient(input)).toBe(expected);
  });

  it.each(["", "abc", "+0421905123456", "123"])("rejects %j with a 400 workflow error", (input) => {
    let failure: unknown = null;

    try {
      normalizeSmsRecipient(input);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SmsWorkflowError);
    expect((failure as SmsWorkflowError).status).toBe(400);
  });
});
