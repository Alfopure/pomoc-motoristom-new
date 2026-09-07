import { describe, expect, it } from "vitest";
import { directoryDraft, directoryRelations, emptyDirectoryDraft, filterDirectory, safeDirectoryWebsite, type DirectoryEntry } from "./directory";

const contact: DirectoryEntry = { ...emptyDirectoryDraft("contact"), id: "person", updatedAt: "2026-09-07T00:00:00Z", name: "Žofia Šťastná", phone: "+421 901 234 567", email: "zofia@example.test" };
const company: DirectoryEntry = { ...emptyDirectoryDraft("company"), id: "company", updatedAt: contact.updatedAt, name: "Žilinská pomoc", address: "Dlhá 25, Žilina", ico: "11698055", contactIds: [contact.id] };
const branch: DirectoryEntry = { ...emptyDirectoryDraft("branch"), id: "branch", updatedAt: contact.updatedAt, name: "Sever", parentId: company.id, location: { label: "Sever", address: "Dlhá 25", lat: 49.2, lng: 18.7 } };
const archived: DirectoryEntry = { ...company, id: "old", name: "Predošlý partner", active: false, contactIds: [] };
const entries = [contact, company, branch, archived];
const search = (query: string) => filterDirectory(entries, { query, kind: "all", status: "active" });

describe("shared directory browsing", () => {
  it("finds unaccented names and a phone number entered without display spaces", () => {
    expect(search("zofia stastna")).toContainEqual(contact);
    expect(search("0901")).toEqual([contact]);
    expect(search("901234567")).toEqual([contact]);
    expect(search("11698055")).toEqual([company]);
    expect(search("DLHA 25")).toEqual([company]);
  });
  it("finds a firm by its contact person and that person by the firm name", () => {
    expect(search("zofia")).toEqual(expect.arrayContaining([contact, company]));
    expect(search("zilinska pomoc")).toEqual(expect.arrayContaining([company, branch, contact]));
  });
  it("keeps archive and type filters independent of search", () => {
    expect(filterDirectory(entries, { query: "partner", kind: "company", status: "archived" })).toEqual([archived]);
    expect(filterDirectory(entries, { query: "", kind: "contact", status: "archived" })).toEqual([]);
    expect(filterDirectory(entries, { query: "", kind: "all", status: "all" })).toHaveLength(4);
  });
  it("does not confuse equal IDs from different source tables", () => {
    const collidingContact = { ...contact, id: company.id, name: "Marek" };
    expect(filterDirectory([company, branch, collidingContact], { query: "zilinska", kind: "branch", status: "active" })).toEqual([branch]);
    expect(directoryRelations(branch, [company, branch, collidingContact])).toEqual([company]);
  });
  it("opens the actual linked record and keeps draft edits separate from saved data", () => {
    expect(directoryRelations(contact, entries)).toEqual([company]);
    expect(directoryRelations(company, entries)).toEqual([branch]);
    const draft = directoryDraft(company);
    draft.contactIds.push("another");
    expect(company.contactIds).toEqual([contact.id]);
    expect(draft).not.toHaveProperty("updatedAt");
    expect(draft).not.toHaveProperty("id");
  });
  it("makes website links safe, including malicious legacy values", () => {
    expect(safeDirectoryWebsite("firma.sk/kontakt")).toBe("https://firma.sk/kontakt");
    expect(safeDirectoryWebsite("http://www.firma.sk")).toBe("http://www.firma.sk/");
    for (const value of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "https://user:password@example.com", "ftp://example.com", ""]) expect(safeDirectoryWebsite(value)).toBeNull();
  });
});
