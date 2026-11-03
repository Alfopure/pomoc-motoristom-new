import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { loadCaseDetail, loadCaseDetailSnapshot } from "@/data/case-detail-repository";
import { caseMutationIdentity } from "@/server/case-atomic-save";
import { createMobileCase, getMobileCase, parseMobileCaseCreate, parseMobileCaseUpdate, updateMobileCase } from "./cases";
import { mobileCaseMap, mobileLocationChanges, parseMobilePlaceSelection } from "./case-locations";

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
const id = (n: number) => `82000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { profileId: id(1), organizationId: id(2), userId: id(3), role: "dispatcher" as const, displayName: "Jana" };
const when = "2026-10-12T18:00:00.123456Z", later = "2026-10-12T18:00:00.123457Z";
const place = { label: "Bod", address: "Bratislava", lat: 48.1, lng: 17.1, provider: "manual" as const };
const command = { mutationId: id(9), expectedUpdatedAt: when };
function row(overrides: Record<string, unknown> = {}) {
  return { id: id(4), organization_id: actor.organizationId, owner_id: actor.profileId, case_number: "PM-2026-1", status: "open", priority: "normal",
    created_at: when, updated_at: when, summary: "", customer_details: {}, vehicle_details: {}, incident_details: {}, location_details: {},
    replacement_vehicle_details: {}, payment_details: {}, closure_details: {}, attachments_metadata: [], ...overrides };
}
function fixture(overrides: Record<string, unknown> = {}) {
  const f = createFakeSupabase(); mocks.admin.mockReturnValue(f.admin);
  f.db.seed("motorist_cases", [row(overrides)]);
  f.db.seed("motorist_profiles", [{ id: actor.profileId, organization_id: actor.organizationId, active: true, role: "dispatcher", display_name: "Jana", kind: "human" }]);
  f.db.seed("motorist_organizations", [{ id: actor.organizationId, active: true, slug: "pomoc-motoristom" }]);
  return f;
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("strict mobile location writes", () => {
  it("accepts explicit zero and boundary coordinates without coercion", () => {
    expect(parseMobilePlaceSelection({ ...place, lat: 0, lng: 0 })).toMatchObject({ lat: 0, lng: 0 });
    expect(parseMobileCaseCreate({ pickup: { ...place, lat: -90, lng: 180, label: " Bod ", address: " Adresa " } }).pickup).toEqual({ ...place, lat: -90, lng: 180, address: "Adresa" });
    expect(parseMobileCaseUpdate({ ...command, destination: null })).toEqual({ ...command, destination: null });
  });
  it.each([null, "48", NaN, Infinity, 90.1, -90.1])("rejects invalid latitude %s", lat => {
    expect(() => parseMobileCaseCreate({ pickup: { ...place, lat } })).toThrow();
  });
  it.each([null, "17", NaN, Infinity, 180.1, -180.1])("rejects invalid longitude %s", lng => {
    expect(() => parseMobileCaseCreate({ destination: { ...place, lng } })).toThrow();
  });
  it.each([{ provider: undefined }, { provider: ["manual"] }, { provider: "browser_geolocation" }, { provider: "unknown" },
    { label: " " }, { address: "x".repeat(501) }, { label: "x".repeat(201) }, { address: "a\nb" }, { address: "x\uD800" },
    { placeId: null }, { placeId: "" }, { placeId: "x".repeat(301) }, { placeId: "x\u0000" }, { id: id(80) }, { metadata: { secret: true } }])("rejects malformed or extra selection fields %j", override => {
    expect(() => parseMobilePlaceSelection({ ...place, ...override })).toThrow();
  });
  it.each(["pickup", "destination"] as const)("rejects ambiguous %s selection and manual address even when empty/null", target => {
    const manual = target === "pickup" ? "manualPickupAddress" : "manualDestinationAddress";
    for (const selection of [place, null]) expect(() => parseMobileCaseCreate({ [target]: selection, [manual]: "" })).toThrow();
  });
  it("preserves the exact legacy fingerprint and omitted targets", () => {
    const legacy = { ...command, manualPickupAddress: "New address", note: "N" };
    expect(mobileLocationChanges(legacy)).toEqual({ ...legacy, pickup: null });
    expect(caseMutationIdentity(mobileLocationChanges(legacy))).toEqual(caseMutationIdentity({ ...legacy, pickup: null }));
    expect(mobileLocationChanges({ ...command, note: "Only note" })).toEqual({ ...command, note: "Only note" });
    expect(mobileLocationChanges({ pickup: place })).toEqual({ pickup: place, manualPickupAddress: "" });
  });
  it("validates direct create calls before related writes and persists explicit manual provenance", async () => {
    const f = fixture();
    await expect(createMobileCase(actor, { pickup: { ...place, lat: 91 } })).rejects.toMatchObject({ status: 400 });
    expect(f.db.log).toHaveLength(0);
    const created = await createMobileCase(actor, { pickup: place });
    const location = f.db.rows("motorist_locations")[0];
    expect(location).toMatchObject({ organization_id: actor.organizationId, provider: "manual", lat: 48.1, lng: 17.1 });
    expect(f.db.rows("motorist_cases").find(item => item.id === created.caseId)).toMatchObject({ pickup_location_id: location.id, location_details: { manualPickupAddress: null } });
  });
  it("uses one existing atomic write and clears stale manual fallback deterministically", async () => {
    const f = fixture({ pickup_location_id: id(10), destination_location_id: id(11), location_details: { manualPickupAddress: "Old", manualDestinationAddress: "Keep", custom: "Keep" } });
    f.db.registerRpc("motorist_case_mutation_result", () => null);
    f.db.registerRpc("motorist_save_case_atomic", args => ({ ...row(), ...args.p_case_patch as object, updated_at: later }));
    const input = { ...command, pickup: place };
    const result = await updateMobileCase(actor, id(4), input);
    const args = f.db.log.find(entry => entry.table === "motorist_save_case_atomic")!.payload;
    expect(args).toMatchObject({ p_actor_id: actor.profileId, p_organization_id: actor.organizationId, p_expected_updated_at: when,
      p_case_patch: { pickup_location_id: id(10), destination_location_id: id(11), location_details: { manualPickupAddress: null, manualDestinationAddress: "Keep", custom: "Keep" } },
      p_related: [{ table: "motorist_locations", id: id(10), insert: false, patch: { ...place, place_id: null, metadata: { source: "operator_form" } } }] });
    expect(result).toMatchObject({ caseId: id(4), mutationId: command.mutationId, committedRevision: later });
    expect(f.db.log.some(entry => ["insert", "update"].includes(entry.operation))).toBe(false);
    expect(input).toEqual({ ...command, pickup: place });
    f.db.registerRpc("motorist_case_mutation_result", () => row({ updated_at: later }));
    const start = f.db.log.length;
    expect(await updateMobileCase(actor, id(4), input)).toEqual(result);
    expect(f.db.log.slice(start).map(entry => entry.table)).toEqual(["motorist_case_mutation_result"]);
    const receipts = f.db.log.filter(entry => entry.table === "motorist_case_mutation_result").map(entry => entry.payload as { p_fingerprint: string });
    expect(receipts[0].p_fingerprint).toBe(receipts[1].p_fingerprint);
  });
});

describe("raw scoped map snapshots", () => {
  it("keeps legacy display text wider than writable selections and omits corrupt map-only rows without breaking detail", async () => {
    const f = fixture({ pickup_location_id: id(10) });
    f.db.seed("motorist_locations", [{ id: id(10), organization_id: actor.organizationId, label: "L".repeat(300), address: "A".repeat(600), lat: 48, lng: 17, provider: "manual" }]);
    expect((await getMobileCase(actor, id(4), undefined, f.admin)).map?.pickup?.address).toHaveLength(600);
    f.db.update("motorist_locations", { label: "L".repeat(10001) }, () => true);
    const detail = await getMobileCase(actor, id(4), undefined, f.admin);
    expect(detail.map?.pickup).toBeNull(); expect(detail.pickupAddress).toHaveLength(600);
  });
  it.each([[null, null], [null, 0], [0, null], ["48", 17], [48, "17"], [91, 17], [48, -181]])("never converts invalid raw coordinates %s,%s to a point", async (lat, lng) => {
    const f = fixture({ pickup_location_id: id(10) });
    f.db.seed("motorist_locations", [{ id: id(10), organization_id: actor.organizationId, label: "Legacy", address: "Adresa", lat, lng, provider: "other", metadata: {} }]);
    const result = await getMobileCase(actor, id(4), undefined, f.admin);
    expect(result.map?.pickup).toMatchObject({ point: null, source: "unknown", address: "Adresa" });
    expect(result.editable.manualPickupAddress).toBe("Adresa");
  });
  it("keeps exact zero and provider, exposes safe accepted GPS fields only, and never foreign rows", async () => {
    const f = fixture({ pickup_location_id: id(10), destination_location_id: id(11) });
    f.db.seed("motorist_locations", [
      { id: id(10), organization_id: actor.organizationId, label: "Zero", address: "Adresa", lat: 0, lng: 0, provider: "google_places", place_id: "Hidden place id", metadata: { secret: "Hidden" } },
      { id: id(11), organization_id: id(99), label: "Foreign", address: "Secret", lat: 48, lng: 17, provider: "manual" },
      { id: id(12), organization_id: actor.organizationId, label: "Klient", address: "GPS", lat: 48, lng: 17, provider: "browser_geolocation", metadata: { accuracy_meters: 12.5, link_id: id(70), token: "SECRET" } },
    ]);
    f.db.seed("motorist_location_submissions", [{ id: id(15), organization_id: actor.organizationId, case_id: id(4), location_id: id(12), accepted: true, submitted_at: when },
      { id: id(16), organization_id: actor.organizationId, case_id: id(4), location_id: id(11), accepted: false, submitted_at: later }]);
    const snapshot = await loadCaseDetailSnapshot(id(4), actor, undefined, f.admin), map = mobileCaseMap(snapshot);
    expect(map).toEqual({ pickup: { id: id(10), label: "Zero", address: "Adresa", point: { lat: 0, lng: 0 }, source: "google_places", accuracyMeters: null, capturedAt: null }, destination: null,
      clientLocation: { id: id(12), label: "Klient", address: "GPS", point: { lat: 48, lng: 17 }, source: "client_gps", accuracyMeters: 12.5, capturedAt: when } });
    expect(JSON.stringify(map)).not.toMatch(/SECRET|Hidden|link_id|Foreign/);
    expect(f.db.log.every(entry => entry.filters?.includes("eq(organization_id)"))).toBe(true);
    expect(await loadCaseDetail(id(4), actor, undefined, f.admin)).not.toHaveProperty("locations");
  });
  it("retries the complete raw snapshot when a case changes during relation reads", async () => {
    const f = fixture({ pickup_location_id: id(10) });
    f.db.seed("motorist_locations", [{ id: id(10), organization_id: actor.organizationId, label: "Old", address: "Old", lat: 1, lng: 1 },
      { id: id(11), organization_id: actor.organizationId, label: "New", address: "New", lat: 2, lng: 2 }]);
    const original = f.db.select.bind(f.db); let changed = false;
    vi.spyOn(f.db, "select").mockImplementation((table, filter) => {
      const result = original(table, filter);
      if (table === "motorist_locations" && !changed) { changed = true; f.db.update("motorist_cases", { pickup_location_id: id(11), updated_at: later }, () => true); }
      return result;
    });
    const snapshot = await loadCaseDetailSnapshot(id(4), actor, undefined, f.admin);
    expect(snapshot.detail.updatedAt).toBe(later);
    expect(mobileCaseMap(snapshot).pickup?.point).toEqual({ lat: 2, lng: 2 });
  });
});
