import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { loadCaseDetail } from "./case-detail-repository";
const id = "40000000-0000-4000-8000-000000000001";
const actor = { organizationId: "org", profileId: "actor" };
function fixture() {
  const fake = createFakeSupabase();
  fake.db.seed("motorist_cases", [{ id, organization_id: "org", status: "open", priority: "normal", updated_at: "2026-09-11T10:00:00.000001Z", created_at: "2026-09-11T09:00:00Z", customer_details: {}, vehicle_details: {}, incident_details: {}, location_details: {}, replacement_vehicle_details: {}, payment_details: {}, closure_details: {}, attachments_metadata: [] }]);
  return fake;
}
describe("authorized narrow case reads", () => {
  it("returns a single card without unrelated modules, tasks or credentials", async () => {
    const f = fixture();
    const detail = await loadCaseDetail(id, actor, undefined, f.admin);
    expect(detail).toMatchObject({ id, priority: "normal", timeline: [] });
    expect(detail).not.toHaveProperty("tasks");
    expect(new Set(f.db.log.map(x => x.table))).toEqual(new Set(["motorist_cases", "motorist_case_events", "motorist_location_submissions"]));
    expect(f.db.log.every(x => x.filters?.includes("eq(organization_id)"))).toBe(true);
  });
  it("cannot read another organization's case", async () => {
    const f = fixture();
    await expect(loadCaseDetail(id, { ...actor, organizationId: "other" }, undefined, f.admin)).rejects.toMatchObject({ status: 404 });
  });
  it("propagates an aborted request to the underlying read", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(loadCaseDetail(id, actor, controller.signal, f.admin)).rejects.toMatchObject({ status: 503 });
  });
  it("returns failure when a required relation read fails", async () => {
    const f = fixture(); f.db.failNext("motorist_case_events", "select", "unavailable");
    await expect(loadCaseDetail(id, actor, undefined, f.admin)).rejects.toMatchObject({ status: 503 });
  });
});
