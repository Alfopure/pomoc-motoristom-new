import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { caseMutationIdentity } from "./case-atomic-save";
import { updateCase } from "./motorist-mutations";

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
const uuid = (n: number) => `40000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const organizationId = uuid(1), actorId = uuid(2), caseId = uuid(3), contactId = uuid(4);
const when = "2026-10-11T10:00:00.000001Z";
const identity = { expectedUpdatedAt: when, mutationId: uuid(5) };
const primary = { id: "primary-stable", name: "Web Primary", firstName: "Web", lastName: "Primary", phone: "+421905111111", phonePrefix: "+421", phoneNational: "905111111", email: "primary@example.test", note: "Keep primary note", role: "driver", isPrimary: true, custom: { keep: true } };
const secondary = { id: "secondary-stable", name: "Secondary", firstName: "Keep", lastName: "Me", phone: "+420777123456", phonePrefix: "+420", phoneNational: "777123456", email: "other@example.test", role: "owner", note: "Keep note", custom: [1, 2] };
function fixture(contacts: unknown[] = [secondary, primary]) {
  const f = createFakeSupabase();
  const row = { id: caseId, organization_id: organizationId, owner_id: actorId, contact_id: contactId, vehicle_id: null,
    pickup_location_id: uuid(6), destination_location_id: uuid(7), updated_at: when,
    customer_details: { type: "company", custom: "keep", contacts }, vehicle_details: {} };
  f.db.seed("motorist_cases", [row]);
  f.db.seed("motorist_contacts", [{ id: contactId, organization_id: organizationId, name: "Old row", phone: "+421905222222", email: "old@example.test", updated_at: when, notes: "Keep row note" }]);
  f.db.registerRpc("motorist_case_mutation_result", () => null);
  f.db.registerRpc("motorist_save_case_atomic", args => ({ ...row, ...args.p_case_patch as object, updated_at: "2026-10-11T10:00:00.000002Z" }));
  mocks.admin.mockReturnValue(f.admin);
  return f;
}
function saved(f: ReturnType<typeof fixture>) {
  const payload = f.db.log.find(entry => entry.table === "motorist_save_case_atomic")!.payload as { p_case_patch: Record<string, unknown>; p_related: { table: string; patch: Record<string, unknown>; expectedUpdatedAt: string }[]; p_fingerprint: string };
  return { ...payload, contact: payload.p_related.find(write => write.table === "motorist_contacts")! };
}
beforeEach(() => vi.clearAllMocks());

describe("opt-in mobile primary contact synchronization", () => {
  it.each([
    [{ contactName: "New Name" }, "New Name", primary.phone],
    [{ contactPhone: "0905 333 333" }, primary.name, "+421905333333"],
    [{ contactName: "New Name", contactPhone: "0905 333 333" }, "New Name", "+421905333333"],
  ] as const)("updates only the selected primary and preserves omitted values: %j", async (patch, name, phone) => {
    const f = fixture(), input = { ...identity, ...patch };
    await updateCase(caseId, input, actorId, organizationId, { synchronizePrimaryContact: true });
    const result = saved(f);
    expect(result.contact).toMatchObject({ expectedUpdatedAt: when, patch: { name, phone, email: primary.email } });
    const details = result.p_case_patch.customer_details as { contacts: Record<string, unknown>[] };
    expect(details).toMatchObject({ type: "company", custom: "keep" });
    expect(details.contacts[0]).toEqual(secondary);
    expect(details.contacts[1]).toMatchObject({ id: primary.id, name, phone, email: primary.email, note: primary.note, custom: primary.custom, role: primary.role, isPrimary: true });
    if ("contactName" in patch) { expect(details.contacts[1]).not.toHaveProperty("firstName"); expect(details.contacts[1]).not.toHaveProperty("lastName"); }
    else expect(details.contacts[1]).toMatchObject({ firstName: "Web", lastName: "Primary" });
    if ("contactPhone" in patch) { expect(details.contacts[1]).not.toHaveProperty("phonePrefix"); expect(details.contacts[1]).not.toHaveProperty("phoneNational"); }
    else expect(details.contacts[1]).toMatchObject({ phonePrefix: "+421", phoneNational: "905111111" });
    expect(result.p_fingerprint).toBe(caseMutationIdentity(input)!.fingerprint);
    expect(f.db.log.filter(entry => entry.operation === "insert" || entry.operation === "update")).toEqual([]);
  });
  it("leaves the shared web default behavior unchanged", async () => {
    const f = fixture();
    await updateCase(caseId, { ...identity, contactName: "Web form simple name" }, actorId, organizationId);
    expect(saved(f).contact.patch).toMatchObject({ name: "Web form simple name", phone: "+421905222222", email: "old@example.test" });
    expect(saved(f).p_case_patch).not.toHaveProperty("customer_details");
  });
  it("skips meaningless JSON entries and updates the first meaningful contact without rewriting others", async () => {
    const f = fixture([null, {}, { firstName: "First", lastName: "Contact", phone: "+421905111111", custom: "keep" }, secondary]);
    await updateCase(caseId, { ...identity, contactPhone: "+421905333333" }, actorId, organizationId, { synchronizePrimaryContact: true });
    expect(saved(f).contact.patch).toMatchObject({ name: "First Contact", phone: "+421905333333" });
    expect(saved(f).p_case_patch.customer_details).toMatchObject({ contacts: [null, {}, expect.objectContaining({ firstName: "First", lastName: "Contact", custom: "keep", phone: "+421905333333" }), secondary] });
  });
  it("does not touch contact JSON for unrelated edits", async () => {
    const f = fixture();
    await updateCase(caseId, { ...identity, note: "Note only" }, actorId, organizationId, { synchronizePrimaryContact: true });
    expect(saved(f).p_related).toEqual([]);
    expect(saved(f).p_case_patch).not.toHaveProperty("customer_details");
  });
  it("materializes a legacy alternative primary only when edited and retains its original metadata", async () => {
    const f = fixture([]);
    f.db.update("motorist_cases", { customer_details: { alternativeContact: "+421905444444", custom: "Keep legacy", contacts: [null, {}] } }, item => item.id === caseId);
    await updateCase(caseId, { ...identity, contactName: "Legacy renamed" }, actorId, organizationId, { synchronizePrimaryContact: true });
    expect(saved(f).contact.patch).toMatchObject({ name: "Legacy renamed", phone: "+421905444444" });
    expect(saved(f).p_case_patch.customer_details).toEqual({ alternativeContact: "+421905444444", custom: "Keep legacy", contacts: [null, {},
      { id: "legacy-alternative-421905444444", name: "Legacy renamed", phone: "+421905444444", role: "other", isPrimary: false }] });
  });
  it("keeps simple cases on their existing contact source and creates missing relations through the atomic plan", async () => {
    const f = fixture([]);
    f.db.update("motorist_cases", { contact_id: null }, item => item.id === caseId);
    await updateCase(caseId, { ...identity, contactName: "New contact", contactPhone: "+421905333333" }, actorId, organizationId, { synchronizePrimaryContact: true });
    expect(saved(f).contact).toMatchObject({ insert: true, patch: { name: "New contact", phone: "+421905333333" } });
    expect(saved(f).p_case_patch).not.toHaveProperty("customer_details");
  });
  it.each([{ contactName: "New mobile name" }, { contactPhone: "+421905333333" }])("keeps mobile contact changes when the web editor reopens a legacy split-name customer: %j", async patch => {
    const f = fixture([]);
    const details = { firstName: "Legacy customer", lastName: "Identity", companyName: "Keep company", custom: { keep: true } };
    f.db.update("motorist_cases", { customer_details: details }, item => item.id === caseId);
    await updateCase(caseId, { ...identity, ...patch }, actorId, organizationId, { synchronizePrimaryContact: true });
    const result = saved(f);
    expect(result.p_case_patch.customer_details).toEqual({ ...details, contacts: [{ id: contactId, name: patch.contactName ?? "Old row",
      phone: patch.contactPhone ?? "+421905222222", email: "old@example.test", role: "primary_customer", isPrimary: true }] });
    expect(result.contact.patch).toMatchObject({ name: patch.contactName ?? "Old row", phone: patch.contactPhone ?? "+421905222222" });
    expect(result.p_fingerprint).toBe(caseMutationIdentity({ ...identity, ...patch })!.fingerprint);
  });
  it("returns the original receipt before contact reads or expansion on replay", async () => {
    const f = fixture(), input = { ...identity, contactName: "New Name" };
    f.db.registerRpc("motorist_case_mutation_result", () => ({ id: caseId, organization_id: organizationId, updated_at: when }));
    await updateCase(caseId, input, actorId, organizationId, { synchronizePrimaryContact: true });
    expect(f.db.log).toHaveLength(1);
    expect(f.db.log[0].payload).toMatchObject({ p_fingerprint: caseMutationIdentity(input)!.fingerprint });
  });
  it("rejects clearing a primary that would silently promote another contact", async () => {
    const f = fixture([{ id: "primary", name: "Primary", phone: "+421905111111", isPrimary: true }, secondary]);
    await expect(updateCase(caseId, { ...identity, contactName: "", contactPhone: "" }, actorId, organizationId, { synchronizePrimaryContact: true })).rejects.toMatchObject({ status: 400 });
    expect(f.db.log.some(entry => entry.table === "motorist_save_case_atomic")).toBe(false);
  });
  it("does not resurrect an unchanged legacy alternative after clearing the effective primary", async () => {
    const f = fixture([]);
    f.db.update("motorist_cases", { customer_details: { alternativeContact: "+421905444444" } }, item => item.id === caseId);
    await expect(updateCase(caseId, { ...identity, contactName: "", contactPhone: "" }, actorId, organizationId, { synchronizePrimaryContact: true })).rejects.toMatchObject({ status: 400 });
    expect(f.db.log.some(entry => entry.table === "motorist_save_case_atomic")).toBe(false);
  });
  it("still permits clearing the sole contact without deleting shared records", async () => {
    const f = fixture([{ id: "primary", name: "Primary", phone: "+421905111111", isPrimary: true }]);
    f.db.update("motorist_contacts", { email: null }, item => item.id === contactId);
    await updateCase(caseId, { ...identity, contactName: "", contactPhone: "" }, actorId, organizationId, { synchronizePrimaryContact: true });
    expect(saved(f).p_case_patch.contact_id).toBeNull();
    expect(saved(f).p_related).toEqual([]);
    expect(f.db.log.some(entry => entry.operation === "delete")).toBe(false);
  });
  it("preserves atomic related-row revision conflicts without a fallback write", async () => {
    const f = fixture();
    f.db.failNext("motorist_save_case_atomic", "rpc", { message: "Related row revision conflict", code: "PT409", details: null, hint: null });
    await expect(updateCase(caseId, { ...identity, contactName: "New Name" }, actorId, organizationId, { synchronizePrimaryContact: true })).rejects.toMatchObject({ status: 409, code: "CASE_REVISION_CONFLICT" });
    expect(saved(f).contact.expectedUpdatedAt).toBe(when);
    expect(f.db.log.filter(entry => entry.operation === "insert" || entry.operation === "update")).toEqual([]);
  });
  it("rejects a foreign case before preparing related writes", async () => {
    const f = fixture();
    await expect(updateCase(caseId, { ...identity, contactName: "New Name" }, actorId, uuid(99), { synchronizePrimaryContact: true })).rejects.toMatchObject({ status: 404 });
    expect(f.db.log.some(entry => entry.table === "motorist_contacts" || entry.table === "motorist_save_case_atomic")).toBe(false);
  });
});
