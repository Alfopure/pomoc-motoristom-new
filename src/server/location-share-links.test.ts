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
