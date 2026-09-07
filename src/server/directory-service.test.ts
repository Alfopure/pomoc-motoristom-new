import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotoristActor } from "@/server/api-auth";
import { createFakeSupabase, fakeError, type FakeRow, type FakeSupabase } from "@/test/fake-supabase";
import { emptyDirectoryDraft, type DirectoryEntry } from "@/lib/directory";

const adminMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: adminMock }));

import { loadDirectory, parseDirectoryDraft, saveDirectoryEntry } from "./directory-service";
import { createPartnerDirectoryEntry, updatePartnerDirectoryEntry } from "./motorist-mutations";

const ORG = "10000000-0000-4000-8000-000000000001";
const FOREIGN_ORG = "10000000-0000-4000-8000-000000000002";
const COMPANY = "20000000-0000-4000-8000-000000000001";
const CONTACT = "30000000-0000-4000-8000-000000000001";
const BRANCH = "40000000-0000-4000-8000-000000000001";
const LOCATION = "50000000-0000-4000-8000-000000000001";
const OLD_TIME = "2026-09-07T09:00:00.000Z";
const NOW = "2026-09-07T10:00:00.000Z";
const actor: MotoristActor = { userId: "user-test", profileId: "profile-test", organizationId: ORG, displayName: "Directory manager", role: "manager" };
const place = { label: "Test branch", address: "Test street 1, Bratislava", lat: 48.15, lng: 17.12, provider: "manual" as const };
let fake: FakeSupabase;

function company(overrides: FakeRow = {}): FakeRow {
  return { id: COMPANY, organization_id: ORG, kind: "company", name: "Test company", phone: null, email: null, ico: null, active: true, metadata: {}, updated_at: OLD_TIME, ...overrides };
}
function contact(overrides: FakeRow = {}): FakeRow {
  return { id: CONTACT, organization_id: ORG, name: "Ján Novák", phone: "+421 900 111 222", email: null, role: "partner", notes: null, updated_at: OLD_TIME, ...overrides };
}
function branch(overrides: FakeRow = {}): FakeRow {
  return { id: BRANCH, organization_id: ORG, name: "Test branch", address: place.address, phone: null, active: true, available_replacement_cars: 2, location_id: LOCATION, metadata: {}, updated_at: OLD_TIME, ...overrides };
}
function seedBranch() {
  fake.db.seed("motorist_branches", [branch()]);
  fake.db.seed("motorist_locations", [{ id: LOCATION, organization_id: ORG, label: place.label, address: place.address, lat: place.lat, lng: place.lng, provider: place.provider, place_id: null, metadata: { historical: true } }]);
}
function writes() { return fake.db.log.filter(log => log.operation !== "select"); }

beforeEach(() => {
  fake = createFakeSupabase({
    now: () => new Date(NOW),
    uniqueKeys: {
      motorist_partner_directory: [["id"], { columns: ["organization_id", "kind", "name"], where: row => row.active === true }],
    },
  });
  adminMock.mockReset().mockReturnValue(fake.admin);
});
afterEach(() => vi.restoreAllMocks());

describe("directory draft validation", () => {
  it.each([
    ["empty name", { name: " \n " }],
    ["oversized name", { name: "a".repeat(181) }],
    ["wrong state type", { active: "true" }],
    ["invalid phone", { phone: "call-me" }],
    ["invalid email", { email: "a@localhost" }],
    ["unsafe website", { website: "javascript:alert(1)" }],
    ["fractional inventory", { availableReplacementCars: 1.2 }],
    ["unknown role", { role: "admin" }],
    ["unknown focus", { focus: "constructor" }],
    ["foreign organization injection", { organization_id: FOREIGN_ORG }],
    ["raw metadata injection", { metadata: { directory: {} } }],
    ["invalid contact ID", { contactIds: ["../contact"] }],
    ["invalid parent ID", { parentId: 42 }],
    ["kind change", { kind: "contact" }],
  ])("rejects %s", (_label, patch) => {
    expect(() => parseDirectoryDraft({ name: "Company", ...patch }, "company")).toThrow(expect.objectContaining({ status: 400 }));
  });

  it.each([null, [], "name", 42])("rejects non-object input %j", input => {
    expect(() => parseDirectoryDraft(input, "company")).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("normalizes Unicode names and deduplicates linked contacts", () => {
    expect(parseDirectoryDraft({ name: "  Žltá   firma \n", contactIds: [CONTACT, CONTACT] }, "company"))
      .toMatchObject({ name: "Žltá firma", contactIds: [CONTACT] });
    expect(parseDirectoryDraft({ name: "Ján", email: "jan@example.test" }, "contact")).toMatchObject({ phone: "", email: "jan@example.test" });
  });

  it("keeps historical contacts and operational branches from being deactivated", () => {
    expect(() => parseDirectoryDraft({ name: "Ján" }, "contact")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseDirectoryDraft({ name: "Ján", phone: "101", active: false }, "contact")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseDirectoryDraft({ name: "Branch", location: place, active: false }, "branch")).toThrow(expect.objectContaining({ status: 400 }));
    const current: DirectoryEntry = { ...emptyDirectoryDraft("branch"), id: BRANCH, updatedAt: OLD_TIME, name: "Branch", location: place };
    expect(() => parseDirectoryDraft({ location: null }, "branch", current)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it.each([
    { lat: 91 }, { lng: -181 }, { lat: "48.15" }, { address: " " }, { provider: ["manual"] },
  ])("rejects malformed branch location %j", patch => {
    expect(() => parseDirectoryDraft({ name: "Branch", location: { ...place, ...patch } }, "branch"))
      .toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("directory authorization and tenant boundaries", () => {
  it.each(["dispatcher", "senior_dispatcher"] as const)("denies %s writes before accessing storage", async role => {
    await expect(saveDirectoryEntry({ ...actor, role }, "company", { name: "Denied" })).rejects.toMatchObject({ status: 403 });
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("denies unrecognized read roles before accessing storage", async () => {
    await expect(loadDirectory({ ...actor, role: "viewer" as MotoristActor["role"] })).rejects.toMatchObject({ status: 403 });
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("loads every page of the shared phonebook while excluding foreign rows and locations", async () => {
    fake.db.seed("motorist_contacts", Array.from({ length: 501 }, (_, index) => contact({ id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` })));
    fake.db.seed("motorist_contacts", [contact({ id: "30000000-0000-4000-8000-000000000999", organization_id: FOREIGN_ORG, name: "Foreign contact" })]);
    fake.db.seed("motorist_partner_directory", [company({ active: false }), company({ id: "20000000-0000-4000-8000-000000000002", organization_id: FOREIGN_ORG, name: "Foreign company" })]);
    fake.db.seed("motorist_branches", [branch()]);
    fake.db.seed("motorist_locations", [{ id: LOCATION, organization_id: FOREIGN_ORG, ...place }]);

    const result = await loadDirectory({ ...actor, role: "dispatcher" });

    expect(result.canEdit).toBe(false);
    expect(result.entries).toHaveLength(503);
    expect(result.entries.some(entry => entry.name.startsWith("Foreign"))).toBe(false);
    expect(result.entries.find(entry => entry.id === COMPANY)?.active).toBe(false);
    expect(result.entries.find(entry => entry.id === BRANCH)?.location).toBeNull();
    expect(fake.db.log.filter(log => log.table === "motorist_contacts")).toHaveLength(2);
    expect(fake.db.log.every(log => log.filters?.includes("eq(organization_id)"))).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("fails a partial directory read instead of returning an incomplete successful list", async () => {
    fake.db.seed("motorist_contacts", [contact()]);
    fake.db.failNext("motorist_branches", "select", "unavailable");
    await expect(loadDirectory(actor)).rejects.toMatchObject({ status: 503 });
  });

  it.each(["company", "assistance"] as const)("does not update foreign or mismatched %s IDs", async kind => {
    fake.db.seed("motorist_partner_directory", [company({ organization_id: FOREIGN_ORG })]);
    await expect(saveDirectoryEntry(actor, kind, { name: "Changed", expectedUpdatedAt: OLD_TIME }, COMPANY)).rejects.toMatchObject({ status: 404 });
    expect(writes()).toEqual([]);
  });

  it("rejects a company ID addressed through the assistance route", async () => {
    fake.db.seed("motorist_partner_directory", [company()]);
    await expect(saveDirectoryEntry(actor, "assistance", { name: "Changed", expectedUpdatedAt: OLD_TIME }, COMPANY)).rejects.toMatchObject({ status: 404 });
    expect(writes()).toEqual([]);
  });

  it.each(["contact", "parent"] as const)("rejects a foreign %s reference before creating a branch location", async relation => {
    fake.db.seed("motorist_contacts", [contact({ organization_id: FOREIGN_ORG })]);
    fake.db.seed("motorist_partner_directory", [company({ organization_id: FOREIGN_ORG })]);
    const links = relation === "contact" ? { contactIds: [CONTACT] } : { parentId: COMPANY };
    await expect(saveDirectoryEntry(actor, "branch", { name: "Branch", location: place, ...links })).rejects.toMatchObject({ status: 400 });
    expect(writes()).toEqual([]);
  });
});

describe("directory persistence and concurrency", () => {
  it.each(["manager", "admin"] as const)("saves a real shared contact as %s", async role => {
    const entry = await saveDirectoryEntry({ ...actor, role }, "contact", { name: "Ján Novák", phone: "0900 111 222", role: "partner" });
    expect(fake.db.rows("motorist_contacts")).toEqual([expect.objectContaining({ id: entry.id, organization_id: ORG, name: "Ján Novák", phone: "0900 111 222", role: "partner" })]);
    expect(fake.db.rows("motorist_audit_log")).toEqual([expect.objectContaining({ entity_id: entry.id, organization_id: ORG, actor_profile_id: actor.profileId, action: "directory.create" })]);
  });

  it("preserves unrelated metadata and updates only the selected entity links", async () => {
    fake.db.seed("motorist_contacts", [contact()]);
    fake.db.seed("motorist_partner_directory", [company({ metadata: { vendor: { retained: true }, note: "Old", directory: { futureField: "keep", website: "https://example.test" } } })]);
    const result = await saveDirectoryEntry(actor, "company", { note: "New", contactIds: [CONTACT, CONTACT], expectedUpdatedAt: OLD_TIME }, COMPANY);
    expect(result).toMatchObject({ id: COMPANY, contactIds: [CONTACT], website: "https://example.test", note: "New", updatedAt: NOW });
    expect(fake.db.rows("motorist_partner_directory")[0].metadata).toMatchObject({ vendor: { retained: true }, note: "New", directory: { futureField: "keep", contactIds: [CONTACT], website: "https://example.test" } });
    expect(fake.db.rows("motorist_contacts")[0]).toMatchObject({ notes: null, updated_at: OLD_TIME });
  });

  it.each([undefined, "2026-09-07T08:00:00.000Z"])("rejects a stale or missing update version %s", async expectedUpdatedAt => {
    fake.db.seed("motorist_partner_directory", [company()]);
    await expect(saveDirectoryEntry(actor, "company", { name: "Lost update", expectedUpdatedAt }, COMPANY)).rejects.toMatchObject({ status: 409 });
    expect(writes()).toEqual([]);
    expect(fake.db.rows("motorist_partner_directory")[0].name).toBe("Test company");
  });

  it("protects an edit made between the read and compare-and-swap write", async () => {
    fake.db.seed("motorist_partner_directory", [company()]);
    const originalUpdate = fake.db.update.bind(fake.db);
    let injected = false;
    vi.spyOn(fake.db, "update").mockImplementation((table, values, filter) => {
      if (table === "motorist_partner_directory" && !injected) {
        injected = true;
        originalUpdate(table, { name: "Colleague edit", metadata: { retained: true } }, row => row.id === COMPANY);
      }
      return originalUpdate(table, values, filter);
    });
    await expect(saveDirectoryEntry(actor, "company", { name: "My edit", expectedUpdatedAt: OLD_TIME }, COMPANY)).rejects.toMatchObject({ status: 409 });
    expect(fake.db.rows("motorist_partner_directory")[0]).toMatchObject({ name: "Colleague edit", metadata: { retained: true } });
    expect(fake.db.rows("motorist_audit_log")).toEqual([]);
  });

  it("rejects same-name contacts sharing a normalized phone or case-insensitive email", async () => {
    fake.db.seed("motorist_contacts", [contact({ email: "JAN@example.test" })]);
    await expect(saveDirectoryEntry(actor, "contact", { name: "Ján Novák", phone: "0900 111 222" })).rejects.toMatchObject({ status: 409 });
    await expect(saveDirectoryEntry(actor, "contact", { name: "Ján Novák", email: "jan@example.test" })).rejects.toMatchObject({ status: 409 });
    expect(writes()).toEqual([]);
  });

  it("permits distinct people with the same name and rejects archived company duplicates", async () => {
    fake.db.seed("motorist_contacts", [contact()]);
    fake.db.seed("motorist_partner_directory", [company({ active: false })]);
    await expect(saveDirectoryEntry(actor, "contact", { name: "Ján Novák", phone: "0900 333 444" })).resolves.toMatchObject({ name: "Ján Novák" });
    await expect(saveDirectoryEntry(actor, "company", { name: "Test company" })).rejects.toMatchObject({ status: 409 });
    expect(fake.db.rows("motorist_partner_directory")).toHaveLength(1);
  });

  it.each(["note", "archive"] as const)("allows a normal %s change when legacy archived duplicates already exist", async change => {
    const archivedId = "20000000-0000-4000-8000-000000000002";
    fake.db.seed("motorist_partner_directory", [company(), company({ id: archivedId, active: false })]);
    const patch = change === "note" ? { note: "Corrected note" } : { active: false };
    await expect(saveDirectoryEntry(actor, "company", { ...patch, expectedUpdatedAt: OLD_TIME }, COMPANY)).resolves.toMatchObject(patch);
    expect(fake.db.rows("motorist_partner_directory").find(row => row.id === archivedId)).toMatchObject({ active: false, updated_at: OLD_TIME });
  });

  it("rejects reactivation when an active duplicate already exists", async () => {
    fake.db.seed("motorist_partner_directory", [company({ active: false }), company({ id: "20000000-0000-4000-8000-000000000002" })]);
    await expect(saveDirectoryEntry(actor, "company", { active: true, expectedUpdatedAt: OLD_TIME }, COMPANY)).rejects.toMatchObject({ status: 409 });
    expect(writes()).toEqual([]);
  });

  it("turns an active-company uniqueness race into one successful create and one conflict", async () => {
    const results = await Promise.allSettled([
      saveDirectoryEntry(actor, "company", { name: "Same company" }),
      saveDirectoryEntry(actor, "company", { name: "Same company" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) })]);
    expect(fake.db.rows("motorist_partner_directory")).toHaveLength(1);
  });

  it("keeps a branch location stable for a phone-only edit", async () => {
    seedBranch();
    await saveDirectoryEntry(actor, "branch", { phone: "101", expectedUpdatedAt: OLD_TIME }, BRANCH);
    expect(fake.db.rows("motorist_branches")[0].location_id).toBe(LOCATION);
    expect(fake.db.rows("motorist_locations")).toHaveLength(1);
    expect(writes().some(log => log.table === "motorist_locations")).toBe(false);
  });

  it("preserves an approximate branch location through an unrelated edit", async () => {
    seedBranch();
    fake.db.update("motorist_locations", { provider: "approximate" }, row => row.id === LOCATION);
    const result = await saveDirectoryEntry(actor, "branch", { note: "Updated note", expectedUpdatedAt: OLD_TIME }, BRANCH);
    expect(result.location?.provider).toBe("approximate");
    expect(fake.db.rows("motorist_branches")[0].location_id).toBe(LOCATION);
    expect(fake.db.rows("motorist_locations")).toHaveLength(1);
  });

  it("moves a branch without changing historical case or vehicle coordinates", async () => {
    seedBranch();
    fake.db.seed("motorist_cases", [{ id: "case-history", organization_id: ORG, destination_location_id: LOCATION }]);
    fake.db.seed("motorist_fleet_assets", [{ id: "vehicle-history", organization_id: ORG, branch_id: BRANCH, current_location_id: LOCATION }]);
    const result = await saveDirectoryEntry(actor, "branch", { location: { ...place, address: "New street 2, Bratislava", lat: 48.2 }, expectedUpdatedAt: OLD_TIME }, BRANCH);
    expect(result.location).toMatchObject({ address: "New street 2, Bratislava", lat: 48.2 });
    expect(fake.db.rows("motorist_branches")[0].location_id).not.toBe(LOCATION);
    expect(fake.db.rows("motorist_locations").find(row => row.id === LOCATION)).toMatchObject({ address: place.address, lat: place.lat, metadata: { historical: true } });
    expect(fake.db.rows("motorist_cases")[0].destination_location_id).toBe(LOCATION);
    expect(fake.db.rows("motorist_fleet_assets")[0].current_location_id).toBe(LOCATION);
  });

  it.each(["error", "race"] as const)("removes a newly created location when branch update fails through %s", async failure => {
    seedBranch();
    if (failure === "error") fake.db.failNext("motorist_branches", "update", "write unavailable");
    else {
      const originalUpdate = fake.db.update.bind(fake.db);
      let injected = false;
      vi.spyOn(fake.db, "update").mockImplementation((table, values, filter) => {
        if (table === "motorist_branches" && !injected) {
          injected = true;
          originalUpdate(table, { phone: "202" }, row => row.id === BRANCH);
        }
        return originalUpdate(table, values, filter);
      });
    }
    await expect(saveDirectoryEntry(actor, "branch", { location: { ...place, lat: 48.2 }, expectedUpdatedAt: OLD_TIME }, BRANCH)).rejects.toMatchObject({ status: failure === "error" ? 503 : 409 });
    expect(fake.db.rows("motorist_locations")).toHaveLength(1);
    expect(fake.db.rows("motorist_locations")[0].id).toBe(LOCATION);
    expect(fake.db.rows("motorist_branches")[0].location_id).toBe(LOCATION);
    expect(fake.db.log.find(log => log.operation === "delete")?.filters).toContain("eq(organization_id)");
  });

  it("returns a committed contact after an audit error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.db.failNext("motorist_audit_log", "insert", fakeError("audit unavailable", "08006"));
    await expect(saveDirectoryEntry(actor, "contact", { name: "Saved contact", phone: "101" })).resolves.toMatchObject({ name: "Saved contact" });
    expect(fake.db.rows("motorist_contacts")).toHaveLength(1);
  });

  it("does not turn an audit transport rejection into a failed committed create", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const insert = fake.db.insert.bind(fake.db);
    vi.spyOn(fake.db, "insert").mockImplementation((table, rows) => {
      if (table === "motorist_audit_log") throw new Error("audit transport rejected");
      return insert(table, rows);
    });
    await expect(saveDirectoryEntry(actor, "contact", { name: "Saved contact", phone: "101" })).resolves.toMatchObject({ name: "Saved contact" });
    expect(fake.db.rows("motorist_contacts")).toHaveLength(1);
  });
});

describe("legacy partner forms preserve directory metadata", () => {
  beforeEach(() => vi.stubEnv("MOTORIST_ORGANIZATION_ID", ORG));
  afterEach(() => vi.unstubAllEnvs());

  it.each(["reactivate", "update"] as const)("retains contact links through legacy %s", async operation => {
    fake.db.seed("motorist_organizations", [{ id: ORG, slug: "pomoc-motoristom", active: true }]);
    const metadata = { source: "import", directory: { contactIds: [CONTACT], website: "https://example.test" }, note: "Old note" };
    fake.db.seed("motorist_partner_directory", [company({ metadata })]);
    if (operation === "reactivate") await createPartnerDirectoryEntry({ kind: "company", name: "Test company", note: "New note" });
    else await updatePartnerDirectoryEntry(COMPANY, { note: "New note" });
    expect(fake.db.rows("motorist_partner_directory")[0].metadata).toEqual({ ...metadata, note: "New note" });
  });
});
