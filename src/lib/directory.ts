import type { PlaceSelectionInput } from "@/data/case-inputs";
import { normalizeDialNumberForComparison } from "@/lib/telephony/phone";

export const DIRECTORY_KINDS = ["company", "assistance", "branch", "contact"] as const;
export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];
export const DIRECTORY_LABELS: Record<DirectoryKind, string> = { company: "Firma", assistance: "Asistenčná spoločnosť", branch: "Pobočka", contact: "Kontaktná osoba" };
export const DIRECTORY_FILTERS: Record<DirectoryKind, string> = { company: "Firmy", assistance: "Asistencia", branch: "Pobočky", contact: "Kontakty" };
export const CONTACT_ROLES = { client: "Klient", assistance: "Asistencia", branch: "Pobočka", partner: "Partner" } as const;
export const DIRECTORY_FOCUS = { "": "Bez zaradenia", towing: "Odťahová služba", garage: "Servis", rental: "Požičovňa", insurer: "Poisťovňa", other: "Iné" } as const;

export type DirectoryEntry = {
  id: string;
  kind: DirectoryKind;
  name: string;
  phone: string;
  email: string;
  note: string;
  active: boolean;
  updatedAt: string;
  ico: string;
  address: string;
  website: string;
  focus: keyof typeof DIRECTORY_FOCUS;
  contactIds: string[];
  parentId: string | null;
  role: keyof typeof CONTACT_ROLES;
  location: PlaceSelectionInput | null;
  availableReplacementCars: number;
};

export type DirectoryData = { entries: DirectoryEntry[]; canEdit: boolean };
export type DirectoryDraft = Omit<DirectoryEntry, "id" | "updatedAt">;

export function emptyDirectoryDraft(kind: DirectoryKind): DirectoryDraft {
  return { kind, name: "", phone: "", email: "", note: "", active: true, ico: "", address: "", website: "", focus: "", contactIds: [], parentId: null, role: "partner", location: null, availableReplacementCars: 0 };
}

export function directoryDraft(entry: DirectoryEntry): DirectoryDraft {
  return { kind: entry.kind, name: entry.name, phone: entry.phone, email: entry.email, note: entry.note, active: entry.active, ico: entry.ico, address: entry.address, website: entry.website, focus: entry.focus, contactIds: [...entry.contactIds], parentId: entry.parentId, role: entry.role, location: entry.location ? { ...entry.location } : null, availableReplacementCars: entry.availableReplacementCars };
}

export function directoryKey(entry: Pick<DirectoryEntry, "kind" | "id">) { return `${entry.kind}:${entry.id}`; }

export function normalizeDirectorySearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("sk").trim();
}

export function directoryRelations(entry: DirectoryEntry, entries: DirectoryEntry[]) {
  if (entry.kind === "contact") return entries.filter(item => item.kind !== "contact" && item.contactIds.includes(entry.id));
  return entries.filter(item => (entry.parentId === item.id && (item.kind === "company" || item.kind === "assistance")) || (item.kind === "branch" && item.parentId === entry.id && entry.kind !== "branch"));
}

export function filterDirectory(entries: DirectoryEntry[], options: { query: string; kind: DirectoryKind | "all"; status: "active" | "archived" | "all" }) {
  const query = normalizeDirectorySearch(options.query);
  const digits = /^\+?[\d\s()./-]+$/.test(query) ? query.replace(/\D/g, "") : "";
  const contacts = new Map(entries.filter(entry => entry.kind === "contact").map(entry => [entry.id, entry]));
  const partners = new Map(entries.filter(entry => entry.kind === "company" || entry.kind === "assistance").map(entry => [entry.id, entry]));
  const owners = new Map<string, string[]>();
  for (const entry of entries) for (const contactId of entry.contactIds) owners.set(contactId, [...(owners.get(contactId) ?? []), entry.name]);
  return entries.filter(entry => {
    if (options.kind !== "all" && entry.kind !== options.kind) return false;
    if (options.status === "active" && !entry.active || options.status === "archived" && entry.active) return false;
    const linkedNames = entry.kind === "contact" ? owners.get(entry.id) ?? [] : entry.contactIds.map(id => contacts.get(id)?.name ?? "");
    const text = [entry.name, entry.phone, entry.email, entry.ico, entry.address, entry.note, entry.website, DIRECTORY_LABELS[entry.kind], DIRECTORY_FOCUS[entry.focus], entry.kind === "contact" ? CONTACT_ROLES[entry.role] : "", entry.parentId ? partners.get(entry.parentId)?.name : "", ...linkedNames].join(" ");
    return !query || normalizeDirectorySearch(text).includes(query) || Boolean(digits && (entry.phone.replace(/\D/g, "").includes(digits) || normalizeDialNumberForComparison(entry.phone).includes(normalizeDialNumberForComparison(query))));
  }).sort((a, b) => a.name.localeCompare(b.name, "sk", { sensitivity: "base", numeric: true }) || directoryKey(a).localeCompare(directoryKey(b)));
}

export function safeDirectoryWebsite(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.hostname.includes(".") ? url.href : null;
  } catch { return null; }
}
