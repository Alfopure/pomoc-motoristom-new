import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { caseStatusLabels, casePriorityLabels } from "@/domain/statuses";
import { listMobileCases, parseMobileCaseQuery } from "./cases";

const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { userId: id(1), profileId: id(2), organizationId: id(3), displayName: "Actor", role: "dispatcher" as const };
const at = "2026-10-12T18:00:00.000001Z";
const query = (text = "") => parseMobileCaseQuery(new URLSearchParams(text));
function fixture() {
  const f = createFakeSupabase();
  f.db.seed("motorist_profiles", [{ id: actor.profileId, organization_id: actor.organizationId, display_name: "Actor", role: "dispatcher", kind: "human", active: true }]);
  f.db.seed("motorist_cases", Array.from({ length: 9 }, (_, i) => ({
    id: id(10 + i), organization_id: i === 8 ? id(80) : actor.organizationId,
    owner_id: i === 7 ? id(90) : actor.profileId, case_number: `PM${i}`,
    status: i === 6 ? "cancelled" : i === 5 ? "open" : "waiting_for_docs", priority: i === 4 ? "normal" : "urgent",
    created_at: i === 3 ? "2026-10-12T18:00:00.000002Z" : i === 0 ? "2026-10-12T18:00:00.000000Z" : at,
    updated_at: at, summary: "Search", contact_id: id(40), vehicle_id: id(41), customer_details: {}, vehicle_details: {},
    incident_details: {}, location_details: {}, replacement_vehicle_details: {}, payment_details: {}, closure_details: {}, attachments_metadata: [],
  })));
  f.db.seed("motorist_contacts", [{ id: id(40), organization_id: actor.organizationId, name: "Contact", phone: "123" }]);
  f.db.seed("motorist_vehicles", [{ id: id(41), organization_id: actor.organizationId, license_plate: "PLATE" }]);
  return f;
}

describe("exact mobile case status and priority filters", () => {
  it("defaults both extras to null and accepts every known web value", () => {
    expect(query()).toMatchObject({ status: null, priority: null });
    for (const status of Object.keys(caseStatusLabels)) expect(query(`category=all&status=${status}`).status).toBe(status);
    for (const priority of Object.keys(casePriorityLabels)) expect(query(`priority=${priority}`).priority).toBe(priority);
  });
  it.each(["status=", "status=OPEN", "status=__proto__", "status=unknown", "priority=", "priority=HIGH", "priority=__proto__", "priority=null", "status=open&status=open", "priority=high&priority=low",
    ...["completed_assisted", "completed_no_assistance", "rejected", "cancelled", "futile_trip"].map(s => `status=${s}`)])("rejects invalid or contradictory filter %s", raw => {
    expect(() => query(raw)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it.each(["Search", "Contact", "123", "PLATE", "PM", "absent"])("applies exact extras and owner through every search and both page branches: %s", async q => {
    const f = fixture();
    const filter = `ownerId=${actor.profileId}&status=waiting_for_docs&priority=urgent&q=${q}&limit=2`;
    const first = await listMobileCases(actor, query(filter), undefined, f.admin);
    expect(first.selection).toMatchObject({ status: "waiting_for_docs", priority: "urgent" });
    if (q === "absent") { expect(first.cases).toEqual([]); return; }
    expect(first.cases.map(c => c.id)).toEqual([id(13), id(12)]);
    const second = await listMobileCases(actor, query(`${filter}&cursor=${first.nextCursor}`), undefined, f.admin);
    expect(second.cases.map(c => c.id)).toEqual([id(11), id(10)]);
    expect(second.nextCursor).toBeNull();
    for (const read of f.db.log.filter(x => x.table === "motorist_cases")) {
      expect(read.filters).toEqual(expect.arrayContaining(["eq(organization_id)", "eq(owner_id)", "eq(status)", "eq(priority)"]));
    }
  });
  it.each(["mine", "all", "unassigned", "owner"])("preserves legacy %s fingerprint exactly when no extras active", async mode => {
    const f = fixture();
    if (mode === "unassigned") f.db.update("motorist_cases", { owner_id: null }, () => true);
    const ownership = mode === "owner" ? "all" : mode;
    const scope = [actor.organizationId, actor.profileId, ownership, "open", ""];
    if (mode === "owner") scope.push(actor.profileId);
    const selection = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
    const cursor = Buffer.from(JSON.stringify({ v: 1, id: id(12), createdAt: at, selection })).toString("base64url");
    const result = await listMobileCases(actor, query(`ownership=${ownership}${mode === "owner" ? `&ownerId=${actor.profileId}` : ""}&cursor=${cursor}`), undefined, f.admin);
    expect(result.cases.map(c => c.id)).toEqual([id(11), id(10)]);
  });
  it("binds active extras to cursor, rejects changing or removing them before reads", async () => {
    const f = fixture();
    const first = await listMobileCases(actor, query("status=waiting_for_docs&priority=urgent&limit=1"), undefined, f.admin);
    for (const filter of ["", "status=waiting_for_docs", "priority=urgent", "status=open&priority=urgent", "status=waiting_for_docs&priority=high"]) {
      const before = f.db.log.length;
      await expect(listMobileCases(actor, query(`${filter}&cursor=${first.nextCursor}`), undefined, f.admin)).rejects.toMatchObject({ status: 400 });
      expect(f.db.log).toHaveLength(before);
    }
    const marker = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()).selection;
    const legacy = createHash("sha256").update(JSON.stringify([actor.organizationId, actor.profileId, "all", "open", ""])).digest("hex");
    expect(marker).not.toBe(legacy);
  });
  it("allows exact closed status with category all and combines priority", async () => {
    const f = fixture();
    expect((await listMobileCases(actor, query("category=all&status=cancelled&priority=urgent"), undefined, f.admin)).cases.map(c => c.id)).toEqual([id(16)]);
    expect((await listMobileCases(actor, query("category=all&status=cancelled&priority=low"), undefined, f.admin)).cases).toEqual([]);
  });
});
