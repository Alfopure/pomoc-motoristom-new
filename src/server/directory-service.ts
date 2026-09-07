import "server-only";
import type { Database, Json } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { CONTACT_ROLES, DIRECTORY_FOCUS, DIRECTORY_KINDS, emptyDirectoryDraft, safeDirectoryWebsite, type DirectoryData, type DirectoryDraft, type DirectoryEntry, type DirectoryKind } from "@/lib/directory";
import { cleanPhoneInput, sameDialNumber } from "@/lib/telephony/phone";
import type { MotoristActor } from "./api-auth";
import { MutationError } from "./mutation-error";

type Tables = Database["public"]["Tables"];
type ContactRow = Tables["motorist_contacts"]["Row"];
type BranchRow = Tables["motorist_branches"]["Row"];
type PartnerRow = Tables["motorist_partner_directory"]["Row"];
type LocationRow = Tables["motorist_locations"]["Row"];
type EntityRow = ContactRow | BranchRow | PartnerRow;
type EntityTable = "motorist_contacts" | "motorist_branches" | "motorist_partner_directory";
type Admin = ReturnType<typeof createSupabaseAdminClient>;
export const DIRECTORY_READ_ROLES: MotoristActor["role"][] = ["dispatcher", "senior_dispatcher", "manager", "admin"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EDIT_FIELDS = new Set(["kind", "name", "phone", "email", "note", "active", "ico", "address", "website", "focus", "contactIds", "parentId", "role", "location", "availableReplacementCars", "expectedUpdatedAt"]);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
const canEdit = (actor: MotoristActor) => actor.role === "manager" || actor.role === "admin";
const tableFor = (kind: DirectoryKind): EntityTable => kind === "contact" ? "motorist_contacts" : kind === "branch" ? "motorist_branches" : "motorist_partner_directory";
function invalid(message: string): never { throw new MutationError(message, 400); }

export function requireDirectoryKind(value: unknown): DirectoryKind {
  if (!DIRECTORY_KINDS.includes(value as DirectoryKind)) invalid("Vyberte platný typ záznamu.");
  return value as DirectoryKind;
}

export function parseDirectoryDraft(value: unknown, kind: DirectoryKind, current?: DirectoryEntry): DirectoryDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Záznam nemá platný formát.");
  const input = record(value);
  if (Object.keys(input).some(key => !EDIT_FIELDS.has(key))) invalid("Záznam obsahuje nepodporované pole.");
  if (input.kind !== undefined && input.kind !== kind) invalid("Typ existujúceho záznamu sa nedá zmeniť.");
  const merged = { ...(current ?? emptyDirectoryDraft(kind)), ...input };
  function text(key: keyof DirectoryDraft, max: number) {
    if (typeof merged[key] !== "string" || (merged[key] as string).length > max) invalid(`Pole ${key} nemá platný formát alebo je príliš dlhé.`);
    return (merged[key] as string).trim();
  }
  const name = text("name", 180).replace(/\s+/g, " ");
  if (!name) invalid("Zadajte názov alebo meno.");
  const phone = text("phone", 40);
  if (phone) try { cleanPhoneInput(phone); } catch { invalid("Zadajte platný telefón alebo internú klapku."); }
  const email = text("email", 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid("Zadajte platnú e-mailovú adresu.");
  if (kind === "contact" && !phone && !email) invalid("Kontakt potrebuje telefón alebo e-mail.");
  const website = text("website", 500);
  if (website && !safeDirectoryWebsite(website)) invalid("Zadajte platnú webovú adresu.");
  if (typeof merged.active !== "boolean") invalid("Neplatný stav záznamu.");
  if (kind === "contact" && !merged.active) invalid("Kontakty sa uchovávajú pre históriu hovorov a prípadov.");
  if (kind === "branch" && !merged.active && (!current || current.active)) invalid("Pobočku je možné upraviť; jej vyradenie vyžaduje presun vozidiel a otvorených prípadov.");
  if (typeof merged.role !== "string" || !Object.hasOwn(CONTACT_ROLES, merged.role)) invalid("Vyberte platné zaradenie kontaktu.");
  if (typeof merged.focus !== "string" || !Object.hasOwn(DIRECTORY_FOCUS, merged.focus)) invalid("Vyberte platné zameranie firmy.");
  if (!Array.isArray(merged.contactIds) || merged.contactIds.length > 100 || merged.contactIds.some(id => typeof id !== "string" || !UUID.test(id))) invalid("Vyberte platné kontaktné osoby.");
  const contactIds = [...new Set(merged.contactIds)];
  if (kind === "contact" && contactIds.length) invalid("Kontaktné osoby priraďujte k firme alebo pobočke.");
  if (merged.parentId !== null && (typeof merged.parentId !== "string" || !UUID.test(merged.parentId))) invalid("Vyberte platnú firmu alebo asistenčnú spoločnosť.");
  if (kind !== "branch" && merged.parentId) invalid("Firmu je možné priradiť k pobočke.");
  if (!Number.isInteger(merged.availableReplacementCars) || merged.availableReplacementCars < 0 || merged.availableReplacementCars > 100_000) invalid("Počet náhradných vozidiel musí byť nezáporné celé číslo.");
  const address = text("address", 500);
  let location: DirectoryDraft["location"] = null;
  if (merged.location !== null) {
    const place = record(merged.location);
    if (typeof place.address !== "string" || place.address.trim().length < 3 || place.address.length > 500 || typeof place.lat !== "number" || !Number.isFinite(place.lat) || Math.abs(place.lat) > 90 || typeof place.lng !== "number" || !Number.isFinite(place.lng) || Math.abs(place.lng) > 180) invalid("Adresa potrebuje platnú polohu na mape.");
    if (place.provider !== undefined && (typeof place.provider !== "string" || !["google_places", "manual", "approximate"].includes(place.provider))) invalid("Neplatná poloha.");
    if (place.placeId !== undefined && (typeof place.placeId !== "string" || place.placeId.length > 255)) invalid("Neplatná adresa.");
    location = { address: place.address.trim(), label: string(place.label).slice(0, 180) || name, lat: place.lat, lng: place.lng, provider: place.provider as "google_places" | "manual" | "approximate" | undefined, ...(place.placeId ? { placeId: String(place.placeId) } : {}) };
  }
  if (kind === "branch" && !current && !location) invalid("Vyberte adresu pobočky a jej polohu na mape.");
  if (kind === "branch" && current?.location && !location) invalid("Existujúcu polohu pobočky nie je možné vymazať.");
  return { kind, name, phone, email, note: text("note", 4000), active: merged.active, ico: text("ico", 32), address: kind === "branch" ? location?.address ?? current?.address ?? address : address, website, focus: merged.focus, contactIds, parentId: merged.parentId, role: merged.role, location: kind === "branch" ? location : null, availableReplacementCars: merged.availableReplacementCars };
}

async function allRows<T>(admin: Admin, table: EntityTable, organizationId: string): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < 10_000; start += 500) {
    const result = await admin.from(table).select("*").eq("organization_id", organizationId).order("id").range(start, start + 499);
    if (result.error) throw new MutationError("Adresár sa nepodarilo načítať.", 503);
    rows.push(...result.data as unknown as T[]);
    if (result.data.length < 500) return rows;
  }
  throw new MutationError("Adresár je príliš veľký na načítanie v jednom prehľade.", 503);
}

export async function loadDirectory(actor: MotoristActor): Promise<DirectoryData> {
  if (!DIRECTORY_READ_ROLES.includes(actor.role)) throw new MutationError("Na adresár nemáte oprávnenie.", 403);
  const admin = createSupabaseAdminClient();
  const [contacts, branches, partners] = await Promise.all([
    allRows<ContactRow>(admin, "motorist_contacts", actor.organizationId),
    allRows<BranchRow>(admin, "motorist_branches", actor.organizationId),
    allRows<PartnerRow>(admin, "motorist_partner_directory", actor.organizationId),
  ]);
  const locations = new Map<string, LocationRow>();
  const ids = [...new Set(branches.flatMap(branch => branch.location_id ? [branch.location_id] : []))];
  for (let start = 0; start < ids.length; start += 100) {
    const result = await admin.from("motorist_locations").select("*").eq("organization_id", actor.organizationId).in("id", ids.slice(start, start + 100));
    if (result.error) throw new MutationError("Adresy pobočiek sa nepodarilo načítať.", 503);
    for (const row of result.data) locations.set(row.id, row);
  }
  return { canEdit: canEdit(actor), entries: [
    ...partners.map(row => toDirectoryEntry(row, row.kind)),
    ...branches.map(row => toDirectoryEntry(row, "branch", row.location_id ? locations.get(row.location_id) : undefined)),
    ...contacts.map(row => toDirectoryEntry(row, "contact")),
  ] };
}

export function toDirectoryEntry(row: EntityRow, kind: DirectoryKind, location?: LocationRow): DirectoryEntry {
  const metadata = "metadata" in row ? record(row.metadata) : {};
  const extra = record(metadata.directory);
  const entry: DirectoryEntry = { ...emptyDirectoryDraft(kind), id: row.id, name: row.name, phone: row.phone ?? "", email: "email" in row ? row.email ?? "" : string(extra.email), updatedAt: row.updated_at, active: "active" in row ? row.active : true, note: "notes" in row ? row.notes ?? "" : string(metadata.note), ico: "ico" in row ? row.ico ?? "" : "", address: "address" in row ? row.address : string(extra.address), website: string(extra.website), focus: Object.hasOwn(DIRECTORY_FOCUS, string(extra.focus)) ? string(extra.focus) as DirectoryDraft["focus"] : "", contactIds: Array.isArray(extra.contactIds) ? extra.contactIds.filter((id): id is string => typeof id === "string" && UUID.test(id)) : [], parentId: kind === "branch" && typeof extra.parentId === "string" && UUID.test(extra.parentId) ? extra.parentId : null, role: "role" in row ? row.role : "partner", availableReplacementCars: "available_replacement_cars" in row ? row.available_replacement_cars : 0 };
  if (location) entry.location = { label: location.label, address: "address" in row ? row.address : location.address, lat: location.lat, lng: location.lng, provider: location.provider === "google_places" || location.provider === "approximate" ? location.provider : "manual", ...(location.place_id ? { placeId: location.place_id } : {}) };
  return entry;
}

async function readEntry(admin: Admin, actor: MotoristActor, kind: DirectoryKind, id: string) {
  if (!UUID.test(id)) invalid("Neplatný záznam adresára.");
  const result = await admin.from(tableFor(kind)).select("*").eq("organization_id", actor.organizationId).eq("id", id).maybeSingle();
  if (result.error) throw new MutationError("Záznam sa nepodarilo načítať.", 503);
  if (!result.data || "kind" in result.data && result.data.kind !== kind) throw new MutationError("Záznam sa nenašiel.", 404);
  let location: LocationRow | undefined;
  if ("location_id" in result.data && result.data.location_id) {
    const place = await admin.from("motorist_locations").select("*").eq("organization_id", actor.organizationId).eq("id", result.data.location_id).maybeSingle();
    if (place.error) throw new MutationError("Adresu pobočky sa nepodarilo načítať.", 503);
    location = place.data ?? undefined;
  }
  return { row: result.data, entry: toDirectoryEntry(result.data, kind, location), location };
}

async function checkReferences(admin: Admin, actor: MotoristActor, draft: DirectoryDraft) {
  if (draft.contactIds.length) {
    const result = await admin.from("motorist_contacts").select("id").eq("organization_id", actor.organizationId).in("id", draft.contactIds);
    if (result.error) throw new MutationError("Kontaktné osoby sa nepodarilo overiť.", 503);
    if (result.data.length !== draft.contactIds.length) invalid("Niektorá kontaktná osoba už nie je dostupná v tomto adresári.");
  }
  if (draft.parentId) {
    const result = await admin.from("motorist_partner_directory").select("id").eq("organization_id", actor.organizationId).eq("id", draft.parentId).maybeSingle();
    if (result.error) throw new MutationError("Priradenú firmu sa nepodarilo overiť.", 503);
    if (!result.data) invalid("Priradená firma nie je dostupná v tomto adresári.");
  }
}

function mergedMetadata(row: EntityRow | undefined, draft: DirectoryDraft): Json {
  const metadata = row && "metadata" in row ? record(row.metadata) : {};
  return { ...metadata, note: draft.note || null, directory: { ...record(metadata.directory), address: draft.address, website: draft.website, focus: draft.focus, email: draft.email, contactIds: draft.contactIds, ...(draft.kind === "branch" ? { parentId: draft.parentId } : {}) } } as Json;
}

export async function saveDirectoryEntry(actor: MotoristActor, kind: DirectoryKind, input: unknown, id?: string): Promise<DirectoryEntry> {
  if (!canEdit(actor)) throw new MutationError("Adresár môže upravovať manažér alebo administrátor.", 403);
  requireDirectoryKind(kind);
  const admin = createSupabaseAdminClient();
  const previous = id ? await readEntry(admin, actor, kind, id) : undefined;
  if (previous && (typeof record(input).expectedUpdatedAt !== "string" || record(input).expectedUpdatedAt !== previous.entry.updatedAt)) throw new MutationError("Záznam medzitým upravil kolega. Obnovte údaje a skontrolujte zmeny.", 409);
  const draft = parseDirectoryDraft(input, kind, previous?.entry);
  await checkReferences(admin, actor, draft);
  if (!previous || draft.name !== previous.entry.name || (!previous.entry.active && draft.active) || (kind === "contact" && (draft.phone !== previous.entry.phone || draft.email !== previous.entry.email))) {
    const duplicates = kind === "company" || kind === "assistance"
      ? await admin.from("motorist_partner_directory").select("*").eq("organization_id", actor.organizationId).eq("name", draft.name).eq("kind", kind).limit(100)
      : await admin.from(tableFor(kind)).select("*").eq("organization_id", actor.organizationId).eq("name", draft.name).limit(100);
    if (duplicates.error) throw new MutationError("Existujúce záznamy sa nepodarilo overiť.", 503);
    const duplicate = duplicates.data.find(row => row.id !== id && (kind !== "contact" || (draft.phone && sameDialNumber(row.phone, draft.phone)) || (draft.email && "email" in row && row.email?.toLowerCase() === draft.email.toLowerCase())));
    if (duplicate) throw new MutationError("Takýto záznam už v adresári existuje. Skontrolujte aj archivované záznamy.", 409);
  }
  let location = previous?.location;
  let createdLocationId: string | undefined;
  const sameLocation = draft.location && previous?.entry.location && (["address", "lat", "lng", "placeId", "provider"] as const).every(key => draft.location![key] === previous.entry.location![key]);
  if (kind === "branch" && draft.location && !sameLocation) {
    const place = await admin.from("motorist_locations").insert({ organization_id: actor.organizationId, label: draft.location.label, address: draft.location.address, lat: draft.location.lat, lng: draft.location.lng, place_id: draft.location.placeId ?? null, provider: draft.location.provider ?? "manual", metadata: { source: "directory" } }).select("*").single();
    if (place.error || !place.data) throw new MutationError("Adresu pobočky sa nepodarilo uložiť.", 503);
    location = place.data;
    createdLocationId = place.data.id;
  }
  const common = { name: draft.name, phone: draft.phone || null };
  const payload = kind === "contact" ? { ...common, email: draft.email || null, role: draft.role, notes: draft.note || null }
    : kind === "branch" ? { ...common, address: draft.address, available_replacement_cars: draft.availableReplacementCars, active: draft.active, metadata: mergedMetadata(previous?.row, draft), ...(location ? { location_id: location.id } : {}) }
    : { ...common, kind, email: draft.email || null, ico: draft.ico || null, active: draft.active, metadata: mergedMetadata(previous?.row, draft) };
  const result = id && previous
    ? await admin.from(tableFor(kind)).update(payload).eq("organization_id", actor.organizationId).eq("id", id).eq("updated_at", previous.entry.updatedAt).select("*").maybeSingle()
    : await admin.from(tableFor(kind)).insert({ ...payload, organization_id: actor.organizationId }).select("*").single();
  if (result.error || !result.data) {
    if (createdLocationId) {
      const cleanup = await admin.from("motorist_locations").delete().eq("organization_id", actor.organizationId).eq("id", createdLocationId);
      if (cleanup.error) console.error("Directory orphan location cleanup failed", { locationId: createdLocationId, code: cleanup.error.code });
    }
    if (result.error?.code === "23505") throw new MutationError("Záznam s týmto názvom už existuje.", 409);
    if (!result.error) throw new MutationError("Záznam medzitým upravil kolega. Obnovte údaje a skontrolujte zmeny.", 409);
    throw new MutationError("Záznam sa nepodarilo uložiť.", 503);
  }
  // Saving succeeded. An unavailable audit sink must not invite a duplicate create.
  try {
    const audit = await admin.from("motorist_audit_log").insert({ organization_id: actor.organizationId, actor_profile_id: actor.profileId, action: `directory.${id ? "update" : "create"}`, entity_type: tableFor(kind), entity_id: result.data.id, source: "dispatch_console", after_payload: { kind, name: draft.name, active: draft.active } });
    if (audit.error) console.error("Directory audit failed after save", { entityId: result.data.id, code: audit.error.code });
  } catch { console.error("Directory audit unavailable after save", { entityId: result.data.id }); }
  return toDirectoryEntry(result.data, kind, location);
}
