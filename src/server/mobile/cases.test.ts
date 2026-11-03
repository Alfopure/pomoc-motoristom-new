import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { CaseCreationCommittedError, createCase } from "@/server/motorist-mutations";
import { createMobileCase, getMobileCase, listMobileCaseDispatchers, listMobileCases, parseMobileCaseCreate, parseMobileCaseQuery, parseMobileCaseUpdate, readMobileCaseCreate, readMobileCaseUpdate, updateMobileCase } from "./cases";
import { MutationError } from "@/server/mutation-error";
import { GET as list, POST as create } from "@/app/api/mobile/v1/cases/route";
import { GET as dispatchers } from "@/app/api/mobile/v1/cases/dispatchers/route";
import { GET as detail, PATCH as patch } from "@/app/api/mobile/v1/cases/[id]/route";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), actor: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("./auth", () => ({ requireMobileActor: mocks.actor, mobileEnvironment: () => "test" }));
const uuid = (n: number) => `40000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const actor = { userId: uuid(1), profileId: uuid(2), organizationId: uuid(3), displayName: "Jana", role: "dispatcher" as const };
const otherOrg = uuid(4), otherProfile = uuid(5);
const when = "2026-10-11T10:00:00.000001Z";
function row(n: number, overrides: Record<string, unknown> = {}) {
  return { id: uuid(n), organization_id: actor.organizationId, owner_id: actor.profileId, case_number: `PM-2026-${n}`,
    status: "open", priority: "normal", created_at: when, updated_at: when, summary: "",
    customer_details: {}, vehicle_details: {}, incident_details: {}, location_details: {}, replacement_vehicle_details: {}, payment_details: {}, closure_details: {}, attachments_metadata: [], ...overrides };
}
function fixture(rows: ReturnType<typeof row>[] = []) {
  const f = createFakeSupabase();
  f.db.seed("motorist_organizations", [{ id: actor.organizationId, slug: "pomoc-motoristom", active: true }, { id: otherOrg, slug: "other", active: true }]);
  f.db.seed("motorist_profiles", [{ id: actor.profileId, organization_id: actor.organizationId, display_name: "Jana", active: true, role: "dispatcher", kind: "human" },
    { id: otherProfile, organization_id: otherOrg, display_name: "Foreign secret", active: true, role: "dispatcher", kind: "human" }]);
  f.db.seed("motorist_cases", rows);
  mocks.admin.mockReturnValue(f.admin);
  return f;
}
function query(raw = "") { return parseMobileCaseQuery(new URLSearchParams(raw)); }
const request = (body: unknown = {}, path = "") => new Request(`https://test.dispecing.linkapomoci.sk/api/mobile/v1/cases${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => { vi.clearAllMocks(); mocks.actor.mockResolvedValue(actor); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("mobile case filters and input", () => {
  it("defaults to all open cases and trims only the search edges", () => {
    expect(query()).toEqual({ ownership: "all", category: "open", q: "", ownerId: null, status: null, priority: null, limit: 25, cursor: null });
    expect(query("q=++Ján++Novák++").q).toBe("Ján  Novák");
  });
  it.each(["ownership=foreign", "ownerId=", "ownerId=invalid", `ownership=mine&ownerId=${actor.profileId}`, `ownerId=${actor.profileId}&ownerId=${actor.profileId}`, "category=closed", "limit=0", "limit=26", "limit=2.5", "limit=01", "q=x&q=y", "organizationId=forged", "cursor=nope", "cursor=" + "a".repeat(1025), "q=" + "x".repeat(121)])("rejects invalid filter %s", raw => {
    expect(() => query(raw)).toThrow(MutationError);
  });
  it("allows incomplete drafts and keeps field validation separate from business warnings", () => {
    expect(parseMobileCaseCreate({})).toEqual({});
    expect(parseMobileCaseCreate({ contactPhone: " 123 ", jobTypes: [], priority: "normal" })).toEqual({ contactPhone: "123", jobTypes: [], priority: "normal" });
  });
  it.each([null, [], "text", { ownerId: actor.profileId }, { organizationId: actor.organizationId }, { status: "cancelled" },
    { contactName: 1 }, { contactName: "x".repeat(201) }, { contactPhone: null }, { priority: "__proto__" },
    { jobTypes: ["tow", "tow"] }, { jobTypes: ["__proto__"] }, { jobTypes: "tow" }, { note: "a\0b" },
    { pickup: { lat: 48, lng: 17 } }, { attachments: [] }])("rejects non-allowlisted input %j", value => {
    expect(() => parseMobileCaseCreate(value)).toThrow(MutationError);
  });
  it("rejects malformed JSON and bounds the actual streamed body", async () => {
    await expect(readMobileCaseCreate(new Request("https://app.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }))).rejects.toMatchObject({ status: 400 });
    await expect(readMobileCaseCreate(request({ note: "x".repeat(64_001) }))).rejects.toMatchObject({ status: 400 });
    await expect(readMobileCaseCreate(new Request("https://app.test", { method: "POST", body: "{}" }))).rejects.toMatchObject({ status: 400 });
  });
});

describe("authorized bounded mobile case reads", () => {
  it("filters organization, ownership and terminal status before pagination", async () => {
    const f = fixture([row(10), row(11, { owner_id: uuid(9) }), row(12, { status: "cancelled" }), row(13, { organization_id: otherOrg }), row(14, { status: "waiting_for_docs" })]);
    expect((await listMobileCases(actor, query(), undefined, f.admin)).cases.map(item => item.id)).toEqual([uuid(14), uuid(11), uuid(10)]);
    expect((await listMobileCases(actor, query("ownership=mine"), undefined, f.admin)).cases.map(item => item.id)).toEqual([uuid(14), uuid(10)]);
    expect((await listMobileCases(actor, query("ownership=all&category=all"), undefined, f.admin)).cases.map(item => item.id)).toEqual([uuid(14), uuid(12), uuid(11), uuid(10)]);
    expect(f.db.log.filter(entry => entry.operation === "select").every(entry => entry.filters?.includes("eq(organization_id)"))).toBe(true);
  });
  it("preserves timestamp microseconds and UUID tie breaks across pages, despite updates", async () => {
    const f = fixture([row(10), row(11), row(12, { created_at: "2026-10-11T10:00:00.000002Z" }), row(13, { created_at: "2026-10-11T09:59:59.999999Z" })]);
    const first = await listMobileCases(actor, query("limit=2"), undefined, f.admin);
    expect(first.cases.map(item => item.id)).toEqual([uuid(12), uuid(11)]);
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString())).toMatchObject({ createdAt: when, id: uuid(11) });
    f.db.update("motorist_cases", { updated_at: "2026-10-12T12:00:00Z" }, item => item.id === uuid(10));
    const next = await listMobileCases(actor, query(`limit=2&cursor=${first.nextCursor}`), undefined, f.admin);
    expect(next.cases.map(item => item.id)).toEqual([uuid(10), uuid(13)]); expect(next.nextCursor).toBeNull();
    await expect(listMobileCases(actor, query(`ownership=mine&cursor=${first.nextCursor}`), undefined, f.admin)).rejects.toMatchObject({ status: 400 });
    await expect(listMobileCases({ ...actor, profileId: uuid(99) }, query(`cursor=${first.nextCursor}`), undefined, f.admin)).rejects.toMatchObject({ status: 400 });
  });
  it("filters an inactive eligible owner before searching and pagination", async () => {
    const ownerId = uuid(9);
    const f = fixture([row(10, { owner_id: ownerId, summary: "defekt" }), row(11, { owner_id: ownerId, summary: "defekt" }),
      row(12, { owner_id: ownerId, status: "cancelled", summary: "defekt" }),
      ...Array.from({ length: 110 }, (_, i) => row(100 + i, { summary: "defekt" }))]);
    f.db.seed("motorist_profiles", [{ id: ownerId, organization_id: actor.organizationId, display_name: "Former dispatcher", role: "dispatcher", kind: "human", active: false }]);
    const first = await listMobileCases(actor, query(`ownerId=${ownerId}&q=defekt&limit=1`), undefined, f.admin);
    expect(first.cases.map(item => item.id)).toEqual([uuid(11)]);
    expect(first.selection).toEqual({ ownership: "all", category: "open", q: "defekt", ownerId, status: null, priority: null });
    const next = await listMobileCases(actor, query(`ownerId=${ownerId}&q=defekt&limit=1&cursor=${first.nextCursor}`), undefined, f.admin);
    expect(next.cases.map(item => item.id)).toEqual([uuid(10)]);
    expect(next.nextCursor).toBeNull();
    for (const filter of ["", `ownerId=${actor.profileId}&`]) {
      await expect(listMobileCases(actor, query(`${filter}q=defekt&cursor=${first.nextCursor}`), undefined, f.admin)).rejects.toMatchObject({ status: 400 });
    }
  });
  it.each([
    { organization_id: otherOrg, role: "dispatcher", kind: "human" },
    { organization_id: actor.organizationId, role: "dispatcher", kind: "ai" },
    { organization_id: actor.organizationId, role: "partner", kind: "human" },
    null,
  ])("rejects an unavailable selected owner before any case/search reads: %j", async profile => {
    const f = fixture([row(10)]);
    if (profile) f.db.seed("motorist_profiles", [{ id: uuid(9), display_name: "Excluded", active: true, ...profile }]);
    await expect(listMobileCases(actor, query(`ownerId=${uuid(9)}&q=secret`), undefined, f.admin)).rejects.toMatchObject({ status: 400 });
    expect(f.db.log.map(entry => entry.table)).toEqual(["motorist_profiles"]);
  });
  it("does not fall back to all cases when selected-owner verification fails", async () => {
    const f = fixture([row(10)]); f.db.failNext("motorist_profiles", "select", "private failure");
    await expect(listMobileCases(actor, query(`ownerId=${actor.profileId}`), undefined, f.admin)).rejects.toMatchObject({ status: 503 });
    expect(f.db.log.map(entry => entry.table)).toEqual(["motorist_profiles"]);
  });
  it.each(["mine", "all"])("accepts legacy unfiltered cursor fingerprints for explicit %s ownership", async ownership => {
    const f = fixture([row(10), row(11)]);
    const selection = createHash("sha256").update(JSON.stringify([actor.organizationId, actor.profileId, ownership, "open", ""])).digest("hex");
    const cursor = Buffer.from(JSON.stringify({ v: 1, id: uuid(11), createdAt: when, selection })).toString("base64url");
    const result = await listMobileCases(actor, query(`ownership=${ownership}&cursor=${cursor}`), undefined, f.admin);
    expect(result.cases.map(item => item.id)).toEqual([uuid(10)]);
    expect(result.selection.ownerId).toBeNull();
  });
  it.each(["Novák", "+421905", "BA123XY", "PM-2026-10", "defekt"])("searches scoped related rows before paging: %s", q => {
    const f = fixture([row(10, { contact_id: uuid(20), vehicle_id: uuid(21), summary: "defekt" }), row(11, { contact_id: uuid(22) })]);
    f.db.seed("motorist_contacts", [{ id: uuid(20), organization_id: actor.organizationId, name: "Ján Novák", phone: "+421905123456" }, { id: uuid(22), organization_id: otherOrg, name: "Novák", phone: "+421905888888" }]);
    f.db.seed("motorist_vehicles", [{ id: uuid(21), organization_id: actor.organizationId, license_plate: "BA123XY", make: "Škoda", model: "Fabia" }]);
    return listMobileCases(actor, query(new URLSearchParams({ q }).toString()), undefined, f.admin).then(result => {
      expect(result.cases.map(item => item.id)).toEqual([uuid(10)]);
      expect(result.cases[0]).toMatchObject({ contact: { name: "Ján Novák" }, vehicle: { licensePlate: "BA123XY" } });
      expect(f.db.log.every(entry => entry.operation !== "select" || entry.filters?.includes("eq(organization_id)"))).toBe(true);
    });
  });
  it("treats PostgREST punctuation as a literal parameter and never raw filter grammar", async () => {
    const f = fixture([row(10)]);
    const result = await listMobileCases(actor, query(new URLSearchParams({ q: "x),organization_id.neq.y" }).toString()), undefined, f.admin);
    expect(result.cases).toEqual([]);
    expect(f.db.log.every(entry => !entry.filters?.some(filter => filter.startsWith("or(")))).toBe(true);
  });
  it("reports broad search explicitly instead of silently dropping matches", async () => {
    const f = fixture(Array.from({ length: 101 }, (_, i) => row(100 + i, { summary: "common" })));
    await expect(listMobileCases(actor, query("q=common"), undefined, f.admin)).rejects.toMatchObject({ status: 400 });
  });
  it("fails visibly on case and related read failures", async () => {
    const f = fixture([row(10, { contact_id: uuid(20) })]);
    f.db.failNext("motorist_cases", "select", "private DB error");
    await expect(listMobileCases(actor, query(), undefined, f.admin)).rejects.toMatchObject({ status: 503 });
    f.db.failNext("motorist_contacts", "select", "private DB error");
    await expect(listMobileCases(actor, query(), undefined, f.admin)).rejects.toMatchObject({ status: 503 });
  });
  it("returns only minimal readable detail and excludes foreign joins, attachments and event payloads", async () => {
    const f = fixture([row(10, { contact_id: uuid(20), owner_id: otherProfile, main_note: "Poznámka", incident_details: { description: "Defekt" },
      attachments_metadata: [{ url: "secret-storage", label: "secret" }], location_details: { manualPickupAddress: "D1 smer Nitra" } })]);
    f.db.seed("motorist_contacts", [{ id: uuid(20), organization_id: otherOrg, name: "Foreign secret", phone: "private" }]);
    f.db.seed("motorist_case_events", Array.from({ length: 60 }, (_, i) => ({ id: uuid(100 + i), organization_id: actor.organizationId, case_id: uuid(10),
      title: "Udalosť", body: "Text", created_at: when, actor_profile_id: actor.profileId, payload: { token: "raw-provider-secret" } })));
    const result = await getMobileCase(actor, uuid(10), undefined, f.admin);
    expect(result).toMatchObject({ contact: { name: null, phone: null }, owner: { name: null }, mainNote: "Poznámka", pickupAddress: "D1 smer Nitra" });
    expect(result.timeline).toHaveLength(50);
    expect(JSON.stringify(result)).not.toMatch(/secret|payload|attachments|tasks/);
    await expect(getMobileCase({ ...actor, organizationId: otherOrg }, uuid(10), undefined, f.admin)).rejects.toMatchObject({ status: 404 });
    await expect(getMobileCase(actor, "invalid", undefined, f.admin)).rejects.toMatchObject({ status: 400 });
  });
});

describe("mobile case dispatcher choices", () => {
  it("lists only same-organization human dispatchers and includes inactive historical owners", async () => {
    const f = fixture();
    f.db.seed("motorist_profiles", [
      ...["dispatcher", "senior_dispatcher", "manager", "admin"].map((role, i) => ({ id: uuid(10 + i), organization_id: actor.organizationId, display_name: `Person ${i}`, kind: "human", role, active: i !== 0, email: "private@example.test", telephony_settings: { secret: "token" } })),
      { id: uuid(20), organization_id: actor.organizationId, display_name: "AI", kind: "ai", role: "dispatcher", active: true },
      { id: uuid(21), organization_id: actor.organizationId, display_name: "Partner", kind: "human", role: "partner", active: true },
      { id: uuid(22), organization_id: otherOrg, display_name: "Foreign", kind: "human", role: "dispatcher", active: true },
    ]);
    expect(await listMobileCaseDispatchers(actor, undefined, f.admin)).toEqual(
      [{ id: actor.profileId, name: "Jana", active: true }, ...["dispatcher", "senior_dispatcher", "manager", "admin"].map((_, i) => ({ id: uuid(10 + i), name: `Person ${i}`, active: i !== 0 }))],
    );
    expect(f.db.log).toHaveLength(1);
    expect(f.db.log[0].filters).toContain("eq(organization_id)");
  });
  it("accepts exactly 200 choices and fails explicitly instead of truncating 201", async () => {
    const f = fixture();
    const profiles = Array.from({ length: 200 }, (_, i) => ({ id: uuid(100 + i), organization_id: actor.organizationId, display_name: `Person ${i}`, kind: "human", role: "dispatcher", active: true }));
    f.db.seed("motorist_profiles", profiles.slice(0, 199));
    expect(await listMobileCaseDispatchers(actor, undefined, f.admin)).toHaveLength(200);
    f.db.seed("motorist_profiles", [profiles[199]]);
    await expect(listMobileCaseDispatchers(actor, undefined, f.admin)).rejects.toMatchObject({ status: 503, code: "case_dispatchers_limit" });
  });
  it("does not report read failure as an empty directory", async () => {
    const f = fixture(); f.db.failNext("motorist_profiles", "select", "private failure");
    await expect(listMobileCaseDispatchers(actor, undefined, f.admin)).rejects.toMatchObject({ status: 503 });
  });
});

describe("mobile atomic editor", () => {
  const identity = { mutationId: uuid(30), expectedUpdatedAt: when };
  const statuses = ["open", "completed_assisted", "completed_no_assistance", "waiting_for_docs", "cancelled", "futile_trip"] as const;
  it("requires an exact revision, UUID and a nonempty allowlisted patch", () => {
    expect(() => parseMobileCaseUpdate({ note: "x", mutationId: uuid(30) })).toThrow(expect.objectContaining({ status: 428, code: "CASE_REVISION_REQUIRED" }));
    for (const input of [null, [], { ...identity }, { ...identity, mutationId: "bad", note: "x" }, { ...identity, expectedUpdatedAt: "2026-02-31T00:00:00Z", note: "x" },
      { ...identity, ownerId: actor.profileId }, { ...identity, organizationId: actor.organizationId }, { ...identity, contacts: [] },
      { ...identity, pickup: { lat: 48 } }, { ...identity, attachmentMetadata: [] }, { ...identity, status: "new" }, { ...identity, note: "x".repeat(10001) }]) {
      expect(() => parseMobileCaseUpdate(input)).toThrow(MutationError);
    }
    expect(parseMobileCaseUpdate({ ...identity, note: "  hello  ", manualPickupAddress: "" })).toEqual({ ...identity, note: "hello", manualPickupAddress: "" });
  });
  it.each(statuses)("accepts the existing writable status %s", status => {
    expect(parseMobileCaseUpdate({ ...identity, status }).status).toBe(status);
  });
  it("bounds actual PATCH body bytes before parsing", async () => {
    await expect(readMobileCaseUpdate(request({ ...identity, note: "x".repeat(64001) }))).rejects.toMatchObject({ status: 400 });
  });
  it("returns canonical editable values and the six status options", async () => {
    const f = fixture([row(10, { status: "new", contact_id: uuid(20), vehicle_id: uuid(21), pickup_location_id: uuid(22), main_note: "Main",
      customer_details: { contacts: [{ name: "Web Primary", phone: "+421905333333", isPrimary: true }] },
      vehicle_details: { jobTypes: ["tow"] }, incident_details: { description: "Defekt" },
      location_details: { manualPickupAddress: "Old hidden text", manualDestinationAddress: "Manual destination" } })]);
    f.db.seed("motorist_contacts", [{ id: uuid(20), organization_id: actor.organizationId, name: "Stale row", phone: "+421905000000" }]);
    f.db.seed("motorist_vehicles", [{ id: uuid(21), organization_id: actor.organizationId, license_plate: "BA123XY", make: "Land Rover", model: "Range Rover Sport" }]);
    f.db.seed("motorist_locations", [{ id: uuid(22), organization_id: actor.organizationId, address: "Effective address", label: "Place", lat: 48, lng: 17 }]);
    const result = await getMobileCase(actor, uuid(10), undefined, f.admin);
    expect(result.editable).toEqual({ contactName: "Web Primary", contactPhone: "+421905333333", licensePlate: "BA123XY", vehicleMake: "Land Rover", vehicleModel: "Range Rover Sport",
      manualPickupAddress: "Effective address", manualDestinationAddress: "Manual destination", incidentDescription: "Defekt", note: "Main", priority: "normal", status: "new", jobTypes: ["tow"] });
    expect(result.contact).toEqual({ name: "Web Primary", phone: "+421905333333" });
    expect(result.statusOptions.map(option => option.value)).toEqual(statuses);
    expect((await listMobileCases(actor, query(), undefined, f.admin)).cases[0].contact).toEqual(result.contact);
  });
  it("uses actor scope and stable location overrides while returning only a confirmed receipt", async () => {
    const f = fixture([row(10, { pickup_location_id: uuid(22), destination_location_id: uuid(23), location_details: { manualDestinationAddress: "Keep", custom: "Keep" } })]);
    f.db.registerRpc("motorist_case_mutation_result", () => null);
    f.db.registerRpc("motorist_save_case_atomic", args => ({ ...row(10), ...args.p_case_patch as object, updated_at: "2026-10-11T10:00:00.000002Z" }));
    const result = await updateMobileCase(actor, uuid(10), { ...identity, manualPickupAddress: "New place", note: "Note", status: "cancelled" });
    expect(result).toEqual({ caseId: uuid(10), mutationId: identity.mutationId, committedRevision: "2026-10-11T10:00:00.000002Z", warnings: [], refreshRequired: true });
    const call = f.db.log.find(entry => entry.table === "motorist_save_case_atomic")!.payload;
    expect(call).toMatchObject({ p_organization_id: actor.organizationId, p_actor_id: actor.profileId, p_expected_updated_at: when,
      p_case_patch: { pickup_location_id: null, destination_location_id: uuid(23), main_note: "Note", status: "cancelled", location_details: { manualPickupAddress: "New place", manualDestinationAddress: "Keep", custom: "Keep" } } });
    expect(f.db.log.some(entry => entry.table === "motorist_locations")).toBe(false);
  });
  it("clears both explicit empty addresses with the same fingerprint on retries", async () => {
    const f = fixture([row(10, { pickup_location_id: uuid(22), destination_location_id: uuid(23) })]);
    f.db.registerRpc("motorist_case_mutation_result", () => null);
    f.db.registerRpc("motorist_save_case_atomic", args => ({ ...row(10), ...args.p_case_patch as object }));
    const input = { ...identity, manualPickupAddress: "", manualDestinationAddress: "" };
    await updateMobileCase(actor, uuid(10), input);
    await updateMobileCase(actor, uuid(10), input);
    const calls = f.db.log.filter(entry => entry.table === "motorist_save_case_atomic").map(entry => entry.payload as { p_case_patch: unknown; p_fingerprint: string });
    expect(calls[0].p_case_patch).toMatchObject({ pickup_location_id: null, destination_location_id: null, location_details: { manualPickupAddress: null, manualDestinationAddress: null } });
    expect(calls[0].p_fingerprint).toBe(calls[1].p_fingerprint);
    expect(input).toEqual({ ...identity, manualPickupAddress: "", manualDestinationAddress: "" });
  });
  it.each([{}, { id: uuid(99), organization_id: actor.organizationId, updated_at: when }, { id: uuid(10), organization_id: otherOrg, updated_at: when }, { id: uuid(10), organization_id: actor.organizationId, updated_at: "bad" }, { id: uuid(10), organization_id: actor.organizationId, updated_at: "2026-10-11T10:00:00.000000Z" }])("rejects malformed or foreign committed receipts: %j", async receipt => {
    const f = fixture(); f.db.registerRpc("motorist_case_mutation_result", () => receipt);
    await expect(updateMobileCase(actor, uuid(10), { ...identity, note: "x" })).rejects.toMatchObject({ status: 503, code: "CASE_SAVE_UNCONFIRMED" });
  });
  it("returns the original exact receipt on replay without a detail reload or new write", async () => {
    const f = fixture(); f.db.registerRpc("motorist_case_mutation_result", () => row(10));
    expect(await updateMobileCase(actor, uuid(10), { ...identity, contactName: "Saved" })).toMatchObject({ caseId: uuid(10), mutationId: identity.mutationId, committedRevision: when });
    expect(f.db.log).toHaveLength(1);
  });
  it("authenticates and validates an HTTP patch before any mutation and keeps success private", async () => {
    const f = fixture();
    const context = { params: Promise.resolve({ id: uuid(10) }) };
    expect((await patch(request({ ...identity, organizationId: otherOrg }), context)).status).toBe(400);
    expect((await patch(request({ mutationId: identity.mutationId, note: "x" }), context)).status).toBe(428);
    expect((await patch(request({ ...identity, note: "x" }), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
    expect(f.db.log).toEqual([]);
    f.db.registerRpc("motorist_case_mutation_result", () => row(10));
    const response = await patch(request({ ...identity, note: "x" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, environment: "test", profileId: actor.profileId, caseId: uuid(10), mutationId: identity.mutationId, committedRevision: when, refreshRequired: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Authorization, X-PM-App-Environment");
  });
  it("reports untyped transport failure as uncertainty without retrying", async () => {
    const f = fixture(); f.db.registerRpc("motorist_case_mutation_result", () => { throw new Error("private transport failure"); });
    await expect(updateMobileCase(actor, uuid(10), { ...identity, note: "x" })).rejects.toMatchObject({ status: 503, code: "CASE_SAVE_UNCONFIRMED" });
    expect(f.db.log).toHaveLength(1);
  });
  it.each([["PT409", 409, "CASE_REVISION_CONFLICT"], ["PT422", 422, "CASE_MUTATION_MISMATCH"], ["42501", 403, undefined], ["P0002", 404, undefined], ["unknown", 500, "CASE_SAVE_UNCONFIRMED"]])("preserves mutation error %s without retries or leaked database text", async (code, status, expectedCode) => {
    const f = fixture(); f.db.failNext("motorist_case_mutation_result", "rpc", { code: String(code), message: "private db text", details: null, hint: null });
    const response = await patch(request({ ...identity, note: "Saved" }), { params: Promise.resolve({ id: uuid(10) }) });
    expect(response.status).toBe(status);
    const body = await response.json(); expect(body.code).toBe(expectedCode); expect(JSON.stringify(body)).not.toContain("private db text");
    expect(f.db.log).toHaveLength(1);
  });
});

describe("mobile case creation and confirmed commit boundary", () => {
  it("uses the actor's explicit organization and owner while preserving draft warnings", async () => {
    const f = fixture(); vi.stubEnv("MOTORIST_ORGANIZATION_ID", otherOrg);
    const result = await createMobileCase(actor, { contactPhone: "123", manualPickupAddress: "D1" });
    expect(result).toMatchObject({ caseId: expect.any(String), caseNumber: expect.any(String), warnings: expect.arrayContaining([expect.objectContaining({ code: "invalid_phone" })]) });
    expect(f.db.rows("motorist_cases")[0]).toMatchObject({ organization_id: actor.organizationId, owner_id: actor.profileId, location_details: expect.objectContaining({ manualPickupAddress: "D1" }) });
  });
  it("rejects an owner/organization mismatch before any related insertion", async () => {
    const f = fixture();
    await expect(createCase({ contactName: "Nobody", vehicleMake: "No" }, actor.profileId, otherOrg)).rejects.toMatchObject({ status: 404 });
    expect(f.db.log.filter(entry => entry.operation === "insert")).toEqual([]);
  });
  it.each(["motorist_case_events", "motorist_audit_log"])("returns committed identity and an honest warning after %s failure", async table => {
    const f = fixture(); const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.db.failNext(table, "insert", "private-error");
    const result = await createMobileCase(actor, {});
    expect(f.db.rows("motorist_cases")).toHaveLength(1);
    expect(result.caseId).toBe(f.db.rows("motorist_cases")[0].id);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "case_history_incomplete" }));
    expect(log).toHaveBeenCalledOnce(); expect(JSON.stringify(log.mock.calls)).not.toContain("private-error");
    expect(JSON.stringify(result)).not.toContain("private-error");
  });
  it("exposes a typed confirmed-case error to other callers without claiming audit success", async () => {
    const f = fixture(); f.db.failNext("motorist_case_events", "insert", "event failure");
    await expect(createCase({}, actor.profileId, actor.organizationId)).rejects.toBeInstanceOf(CaseCreationCommittedError);
    expect(f.db.rows("motorist_cases")).toHaveLength(1);
  });
  it("never reports a failed case insert as committed and never retries it", async () => {
    const f = fixture(); f.db.failNext("motorist_cases", "insert", "lost response");
    await expect(createMobileCase(actor, {})).rejects.toMatchObject({ status: 503, code: "case_create_uncertain" });
    expect(f.db.rows("motorist_cases")).toHaveLength(0);
    expect(f.db.log.filter(entry => entry.table === "motorist_cases" && entry.operation === "insert")).toHaveLength(1);
  });
});

describe("mobile cases HTTP boundary", () => {
  it.each([list, create, dispatchers, (r: Request) => patch(r, { params: Promise.resolve({ id: uuid(10) }) }), (r: Request) => detail(r, { params: Promise.resolve({ id: uuid(10) }) })])("authenticates before parsing or reading/writing", async route => {
    fixture(); mocks.actor.mockRejectedValue(new MutationError("Prihláste sa.", 401));
    const response = await route(request({ ownerId: "forged" }, "?unknown=bad"));
    expect(response.status).toBe(401); expect(mocks.admin).not.toHaveBeenCalled();
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Authorization, X-PM-App-Environment");
  });
  it("rejects invalid input after auth, before mutation", async () => {
    const f = fixture();
    expect((await create(request({ ownerId: "forged" }))).status).toBe(400);
    expect((await list(request({}, "?limit=99"))).status).toBe(400);
    expect(f.db.log).toHaveLength(0);
  });
  it("returns private scoped dispatcher choices and the default all-open selection", async () => {
    fixture([row(10)]);
    const response = await dispatchers(new Request("https://app.test/api/mobile/v1/cases/dispatchers"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, apiVersion: 1, checkedAt: expect.any(String), environment: "test", profileId: actor.profileId, dispatchers: [{ id: actor.profileId, name: "Jana", active: true }] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Authorization, X-PM-App-Environment");
    expect(await (await list(new Request("https://app.test/api/mobile/v1/cases"))).json()).toMatchObject({ selection: { ownership: "all", category: "open", q: "", ownerId: null } });
  });
  it("returns a scoped 201 receipt without a full dispatch reload", async () => {
    const f = fixture(); const response = await create(request({ note: "Mobile" }));
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, apiVersion: 1, environment: "test", profileId: actor.profileId, caseId: expect.any(String) });
    expect(result).not.toHaveProperty("dispatchData");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(f.db.rows("motorist_cases")).toHaveLength(1);
  });
  it("returns uncertainty without leaking failed provider/database details", async () => {
    const f = fixture(); f.db.failNext("motorist_cases", "insert", "secret-database-message");
    const response = await create(request()); expect(response.status).toBe(503);
    const body = await response.json(); expect(body).toMatchObject({ ok: false, code: "case_create_uncertain" });
    expect(JSON.stringify(body)).not.toContain("secret-database-message");
    expect(body.error).toContain("skontrolujte zoznam");
  });
});
