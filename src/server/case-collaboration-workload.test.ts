import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadCaseLiveSnapshot } from "./case-collaboration";
import type { MotoristActor } from "./api-auth";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
const uuid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("case collaboration service workload (counted local boundary, no remote timing)", () => {
  it("records cold-start, unchanged and 20-card burst query counts for 20 clients", async () => {
    // Execute the actual service, bulk mapping and notification
    // repository. Only the network/database boundary is a counted fake.
    const fixture = createFakeSupabase();
    vi.mocked(createSupabaseAdminClient).mockReturnValue(fixture.admin);
    const actor = { organizationId: uuid(900), profileId: uuid(901) } as MotoristActor;
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: uuid(index + 1), organization_id: actor.organizationId, owner_id: actor.profileId,
      contact_id: uuid(902), vehicle_id: uuid(903), pickup_location_id: uuid(904),
      status: "open", priority: "normal", updated_at: "2026-09-19T10:00:00.000001Z", created_at: "2026-09-19T09:00:00Z",
      customer_details: {}, vehicle_details: {}, incident_details: {}, location_details: {},
      replacement_vehicle_details: {}, payment_details: {}, closure_details: {}, attachments_metadata: [],
    }));
    fixture.db.seed("motorist_cases", rows);
    fixture.db.seed("motorist_profiles", [{ id: actor.profileId, organization_id: actor.organizationId, display_name: "Fixture operator" }]);
    fixture.db.seed("motorist_contacts", [{ id: uuid(902), organization_id: actor.organizationId, name: "Fixture customer" }]);
    fixture.db.seed("motorist_vehicles", [{ id: uuid(903), organization_id: actor.organizationId, registration_plate: "TEST" }]);
    fixture.db.seed("motorist_locations", [{ id: uuid(904), organization_id: actor.organizationId, label: "Fixture location" }]);
    const versions = Object.fromEntries(rows.map(row => [row.id, 1]));
    fixture.db.registerRpc("motorist_case_collaboration", input => {
      if (input.p_action !== "snapshot") return {};
      const known = (input.p_input as { versions: Record<string, number> }).versions;
      const changed = rows.filter(row => known[row.id] !== versions[row.id]);
      return { versions: { ...versions }, editors: [], more: changed.length > 40, details: {
        cases: changed.slice(0, 40), events: [], submissions: [], contacts: fixture.db.rows("motorist_contacts"),
        vehicles: fixture.db.rows("motorist_vehicles"), locations: fixture.db.rows("motorist_locations"), profiles: fixture.db.rows("motorist_profiles"),
      } };
    });
    const clientVersions: Record<string, number>[] = Array.from({ length: 20 }, () => ({}));
    let serviceReads = 0;
    const sync = async () => Promise.all(clientVersions.map(async (_, index) => {
      let more = true;
      while (more) {
        serviceReads++;
        const snapshot = await loadCaseLiveSnapshot(actor, { versions: clientVersions[index] });
        clientVersions[index] = snapshot.versions;
        more = snapshot.more;
      }
    }));
    const count = () => ({ serviceReads, repositoryQueries: fixture.db.log.filter(entry => entry.kind === "query").length, rpcCalls: fixture.db.log.filter(entry => entry.kind === "rpc").length });
    const reset = () => { serviceReads = 0; fixture.db.log.length = 0; };

    await sync();
    const cold = count();
    expect(cold).toEqual({ serviceReads: 60, repositoryQueries: 60, rpcCalls: 120 });
    reset(); await sync();
    const warm = count();
    expect(warm).toEqual({ serviceReads: 20, repositoryQueries: 20, rpcCalls: 40 });
    reset(); rows.slice(0, 20).forEach(row => { versions[row.id]++; }); await sync();
    const burst = count();
    expect(burst).toEqual({ serviceReads: 20, repositoryQueries: 20, rpcCalls: 40 });
    expect(new Set(fixture.db.log.map(entry => entry.table))).toEqual(new Set([
      "motorist_case_collaboration", "motorist_notifications",
    ]));
    console.info("CASE_SERVICE_WORKLOAD", JSON.stringify({ clients: 20, populatedCards: 100, cold, warm, burst, note: "Actual service/repository code; counted fake Supabase boundary. Burst is one fully coalesced 20-card batch per client. No database or network latency claim." }));
  });
});
