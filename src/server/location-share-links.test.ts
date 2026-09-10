import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
const admin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: admin }));
import { hashLocationShareToken } from "@/lib/sms/location-share";
import { submitPublicLocation } from "./location-share-links";
function setup() {
  const fake = createFakeSupabase(); admin.mockReturnValue(fake.admin);
  fake.db.seed("motorist_location_share_links", [{ id: "link", organization_id: "org", case_id: "case", token_hash: hashLocationShareToken("token"), status: "active", expires_at: "2099-01-01T00:00:00Z", metadata: {} }]);
  return fake;
}
describe("public location submissions", () => {
  it("preserves the composer's explicit no-task choice even before source RPC migration", async () => {
    const fake = setup();
    await fake.admin.from("motorist_location_share_links").update({ metadata: { source: "sms_location_request", task_id: null, task_association: null } }).eq("id", "link");
    fake.db.seed("motorist_case_tasks", [{ id: "unrelated", organization_id: "org", case_id: "case", status: "open", title: "Vyúčtovať lokalizačnú SMS" }]);
    await submitPublicLocation("token", { lat: 48, lng: 17 });
    expect(fake.db.rows("motorist_case_tasks")[0].status).toBe("open");
  });

  it("reconciles the same accepted submission after a transient source failure and retries without duplicate effects", async () => {
    const fake = setup();
    const complete = vi.fn(() => ({ completed: true }));
    fake.db.registerRpc("motorist_complete_task_source_v1", complete);
    fake.db.failNext("motorist_complete_task_source_v1", "rpc", { code: "08006", message: "temporary", details: null, hint: null });
    const payload = { lat: 48, lng: 17, accuracy: 12 };
    await expect(submitPublicLocation("token", payload)).rejects.toThrow("Task source completion failed.");
    const accepted = fake.db.rows("motorist_location_submissions")[0];
    await expect(submitPublicLocation("token", payload)).resolves.toEqual({ locationId: accepted.location_id, status: "stored", submittedAt: accepted.submitted_at });
    await Promise.all([submitPublicLocation("token", payload), submitPublicLocation("token", payload)]);
    expect(fake.db.rows("motorist_locations")).toHaveLength(1);
    expect(fake.db.rows("motorist_location_submissions")).toHaveLength(1);
    expect(fake.db.rows("motorist_case_events")).toHaveLength(1);
    expect(fake.db.rows("motorist_notifications")).toHaveLength(1);
    await expect(submitPublicLocation("token", { ...payload, lat: 49 })).rejects.toMatchObject({ status: 410 });
    expect(complete).toHaveBeenCalledTimes(3);
  });
  it("does not turn an installed false proof into a broad task update", async () => {
    const fake = setup();
    fake.db.registerRpc("motorist_complete_task_source_v1", () => ({ completed: false }));
    fake.db.seed("motorist_case_tasks", [{ id: "task", organization_id: "org", case_id: "case", status: "open", title: "lokalizačná SMS" }]);
    await submitPublicLocation("token", { lat: 48, lng: 17 });
    expect(fake.db.rows("motorist_case_tasks")[0].status).toBe("open");
  });

  it("rejects invalid GPS without a write", async () => {
    const fake = setup();
    await expect(submitPublicLocation("token", { lat: 91, lng: 17 })).rejects.toMatchObject({ status: 400 });
    expect(fake.db.rows("motorist_locations")).toHaveLength(0);
  });
  it("reports a competing submission rejected by the database as expired and removes only its orphan location", async () => {
    const fake = setup();
    fake.db.failNext("motorist_location_submissions", "insert", { code: "P0001", message: "location_link_inactive", details: null, hint: null });
    await expect(submitPublicLocation("token", { lat: 48, lng: 17 })).rejects.toMatchObject({ status: 410 });
    expect(fake.db.rows("motorist_locations")).toHaveLength(0);
    expect(fake.db.rows("motorist_location_submissions")).toHaveLength(0);
  });
  it("stores supplemental GPS without updating the incident location", async () => {
    const fake = setup();
    fake.db.seed("motorist_cases", [{ id: "case", organization_id: "org", case_number: "PM-1", pickup_location_id: "original" }]);
    await expect(submitPublicLocation("token", { lat: 48, lng: 17, accuracy: 12 })).resolves.toMatchObject({ status: "stored" });
    expect(fake.db.rows("motorist_cases")[0].pickup_location_id).toBe("original");
    expect(fake.db.rows("motorist_location_share_links")[0].status).toBe("used");
  });
});
