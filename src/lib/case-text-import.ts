export const caseTextFields = [
  { key: "customer", label: "Meno hlavného kontaktu" },
  { key: "phone", label: "Telefón hlavného kontaktu" },
  { key: "plate", label: "EČV" },
  { key: "make", label: "Značka vozidla" },
  { key: "model", label: "Model vozidla" },
  { key: "vehicleNote", label: "Poznámka k vozidlu" },
  { key: "pickup", label: "Miesto incidentu" },
  { key: "destination", label: "Cieľ" },
  { key: "description", label: "Popis incidentu" },
  { key: "reference", label: "Referencia asistenčnej služby" },
] as const;
export type CaseTextField = typeof caseTextFields[number]["key"];
export type CaseTextValues = Record<CaseTextField, string>;
export type CaseTextSuggestion = { key: CaseTextField; values: string[] };
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const aliases: Record<string, CaseTextField> = {
  klient: "customer", zakaznik: "customer", meno: "customer", "meno klienta": "customer", kontakt: "customer",
  telefon: "phone", tel: "phone", mobil: "phone", ecv: "plate", spz: "plate",
  znacka: "make", "znacka vozidla": "make", model: "model", "model vozidla": "model", vozidlo: "vehicleNote", auto: "vehicleNote",
  miesto: "pickup", "miesto udalosti": "pickup", "miesto incidentu": "pickup", adresa: "pickup",
  ciel: "destination", "miesto dorucenia": "destination", poznamka: "description", "popis incidentu": "description", poziadavka: "description", porucha: "description",
  referencia: "reference", "referencia asistencie": "reference", "cislo objednavky": "reference",
};

/** Bounded extraction of labelled facts, not an AI interpretation of free text. */
export function parseCaseText(text: string): CaseTextSuggestion[] {
  if (text.length > 20_000) return [];
  const facts = new Map<CaseTextField, string[]>();
  for (const line of text.split(/\r?\n|;\s*/)) {
    const cleaned = line.replace(/^\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/, "").trim();
    const match = cleaned.match(/^([^:]{1,50}):\s*(.+)$/u);
    if (!match) continue;
    const key = aliases[normalize(match[1])];
    const value = match[2].trim();
    if (!key || !value || /^(?:neviem|nezname|neznamy|neuvedene|n\/a|[-—?])$/.test(normalize(value))) continue;
    const max = ["description", "vehicleNote"].includes(key) ? 2000 : 300;
    if (value.length > max) continue;
    const found = facts.get(key) ?? [];
    if (!found.includes(value)) facts.set(key, [...found, value]);
  }
  return caseTextFields.flatMap(({ key }) => facts.has(key) ? [{ key, values: facts.get(key)! }] : []);
}
