/** A read-only projection of a new form. Never includes files, lookup proofs or internal IDs. */
export const draftPreviewGroups = [
  { title: "Základ prípadu", fields: { jobTypes: "Úkony", priority: "Priorita", sourceType: "Zdroj", incidentType: "Udalosť", participants: "Účastníci", passengers: "Cestujúci", note: "Interná poznámka" } },
  { title: "Klient a kontakty", fields: { customerType: "Typ zákazníka", contacts: "Kontakty", companyName: "Firma", companyIdNumber: "IČO", assistance: "Asistenčná služba", assistanceReference: "Referencia", customerNote: "Poznámka ku klientovi" } },
  { title: "Vozidlo", fields: { plate: "EČV", vin: "VIN", make: "Značka", model: "Model", year: "Rok výroby", color: "Farba", category: "Kategória", vehicleType: "Typ vozidla", transmission: "Prevodovka", transmissionNote: "Poznámka k prevodovke", driveType: "Pohon", weight: "Hmotnosť (kg)", issue: "Problém s vozidlom", driveable: "Pojazdné", conditions: "Stav vozidla", vehicleNote: "Poznámka k vozidlu", damageAreas: "Poškodené časti", damageNote: "Popis poškodenia" } },
  { title: "Miesto a cieľ", fields: { pickup: "Miesto udalosti", destination: "Cieľ", road: "Cesta", kilometer: "Kilometer", direction: "Smer", placeType: "Typ miesta", complications: "Komplikácie na mieste", access: "Prístup k vozidlu", destinationNote: "Poznámka k cieľu" } },
  { title: "Náhradné vozidlo", fields: { replacementNeeded: "Potrebné náhradné vozidlo", replacementType: "Typ", replacementCategory: "Kategória", replacementPreferences: "Preferencie", replacementDelivery: "Miesto pristavenia", replacementEntitlement: "Nárok", replacementExtension: "Možnosť predĺženia", replacementDays: "Maximálny počet dní", replacementNote: "Poznámka" } },
  { title: "Dokončenie", fields: { paymentMethod: "Úhrada", paymentStatus: "Stav úhrady", closureType: "Spôsob ukončenia", closureStatus: "Stav ukončenia", insurancePortal: "Portál poisťovne", closureNote: "Poznámka k ukončeniu", attachments: "Pripravené prílohy", attachmentNote: "Poznámka k prílohám" } },
] as const;

type GroupFields<T> = T extends { fields: infer F } ? keyof F : never;
export type CaseDraftField = GroupFields<(typeof draftPreviewGroups)[number]>;
export type CaseDraftPreview = { version: 1; fields: Partial<Record<CaseDraftField, string>> };
export type CaseDraftPreviewSnapshot = {
  available: boolean; preview: CaseDraftPreview | null; sequence: number;
  updatedAt: string | null; expiresAt: string; displayName: string;
};
export const MAX_DRAFT_PREVIEW_BYTES = 48_000;
export const DRAFT_PREVIEW_FIELD_LIMIT = 4_000;
export const DRAFT_PREVIEW_READ_MS = 2_000;
const keys = new Set(draftPreviewGroups.flatMap(group => Object.keys(group.fields)));

export function parseCaseDraftPreview(value: unknown): CaseDraftPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Neplatný náhľad prípadu.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "version" && key !== "fields") || input.version !== 1 || !input.fields || typeof input.fields !== "object" || Array.isArray(input.fields)) throw new Error("Neplatný náhľad prípadu.");
  const entries = Object.entries(input.fields);
  if (entries.some(([key, field]) => !keys.has(key) || typeof field !== "string" || field.length > DRAFT_PREVIEW_FIELD_LIMIT)) throw new Error("Náhľad obsahuje nepovolené alebo príliš dlhé údaje.");
  const preview: CaseDraftPreview = { version: 1, fields: Object.fromEntries(entries) };
  if (new TextEncoder().encode(JSON.stringify(preview)).length > MAX_DRAFT_PREVIEW_BYTES) throw new Error("Náhľad prípadu je príliš veľký.");
  return preview;
}
