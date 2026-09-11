import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
const state = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => state.admin }));
import { loadDispatchData, loadFleetData, loadAccessUsers, loadAttendanceData } from "./dispatch-repository";
beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://isolated.example.test"); vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "synthetic"); vi.stubEnv("SUPABASE_SECRET_KEY", "synthetic"); vi.stubEnv("MOTORIST_ORGANIZATION_ID", "org");
});
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const fake = createFakeSupabase(); state.admin = fake.admin;
  fake.db.seed("motorist_organizations", [{ id: "org", active: true }]);
  const listUsers = vi.fn().mockResolvedValue({ data: { users: [{ id: "auth", email: "private@example.test" }] }, error: null });
  Object.assign(fake.admin, { auth: { admin: { listUsers } } });
  return { ...fake, listUsers };
}
describe("module-scoped dispatch reads", () => {
  it("first paint skips attendance/Auth and reads profiles once", async () => {
    const f = fixture();
    const data = await loadDispatchData({ organizationId: "org", profileId: "actor" }, { attendance: false, history: false });
    expect(data.source).toBe("supabase"); expect(data.users).toEqual([]);
    expect(f.db.log.some(entry => entry.table.startsWith("motorist_attendance") || ["motorist_case_events", "motorist_call_events"].includes(entry.table))).toBe(false);
    expect(f.db.log.filter(entry => entry.table === "motorist_profiles")).toHaveLength(1);
    expect(f.listUsers).not.toHaveBeenCalled();
  });
  it("fleet DTO never reads cases, communications, attendance, tasks or Auth", async () => {
    const f = fixture(); const result = await loadFleetData("org");
    expect(result).toMatchObject({ fleetAssets: [], fleetProviderVehicles: [], commanderVehicles: [] });
    expect(f.db.log.some(entry => /motorist_(cases|calls|attendance|profiles|tasks)/.test(entry.table))).toBe(false);
    expect(f.listUsers).not.toHaveBeenCalled();
  });
  it("only the access loader reads Auth identity details", async () => {
    const f = fixture(); f.db.seed("motorist_profiles", [{ id: "actor", organization_id: "org", user_id: "auth", display_name: "Actor", active: true, role: "admin" }]);
    expect(await loadAccessUsers("org")).toMatchObject([{ id: "actor", email: "private@example.test" }]);
    expect(f.listUsers).toHaveBeenCalledTimes(1);
    expect(f.db.log.every(entry => entry.table === "motorist_profiles")).toBe(true);
  });
  it("attendance opens independently of calls, cases and fleet", async () => {
    const f = fixture(); await loadAttendanceData("org");
    expect(f.db.log.every(entry => entry.table.startsWith("motorist_attendance") || entry.table === "motorist_profiles")).toBe(true);
    expect(f.listUsers).not.toHaveBeenCalled();
  });
});
