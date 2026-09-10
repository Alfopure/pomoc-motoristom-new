import { casePriorityLabels, caseStatusLabels } from "@/domain/statuses";

type RecordValue = Record<string, unknown>;
export type CasePdfSnapshot = {
  case: RecordValue & { case_number: string; updated_at: string };
  snapshotAt?: string;
  assignedAsset?: RecordValue | null;
  owner?: string | null;
  contact?: RecordValue | null;
  vehicle?: RecordValue | null;
  pickup?: RecordValue | null;
  destination?: RecordValue | null;
  tasks: RecordValue[];
  events: RecordValue[];
  sms: RecordValue[];
};

export const escapePdfText = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const labels: Record<string, string> = {
  assignedDriverName: "Vodič", assignedDriverPhone: "Telefón vodiča", jobTypes: "Služby", kind: "Typ",
  summary: "Stručný opis", mainNote: "Hlavná poznámka", source: "Zdroj prípadu", note: "Poznámka", attachments: "Príloha", storageBucket: "Úložisko", sizeBytes: "Veľkosť (bajty)",
  participantsCount: "Počet účastníkov", passengersCount: "Počet cestujúcich", damages: "Škody", damageNote: "Poznámka k poškodeniu", vehicleType: "Typ vozidla", specifics: "Špecifiká", issue: "Porucha", driveable: "Pojazdné", driveType: "Pohon", weightKg: "Hmotnosť (kg)", productionYear: "Rok výroby",
  manualPickupAddress: "Zadané miesto zásahu", manualDestinationAddress: "Zadaný cieľ", roadName: "Cesta", kilometerSection: "Kilometer", drivingDirection: "Smer jazdy", placeType: "Typ miesta", complications: "Komplikácie", destinationNote: "Poznámka k cieľu",
  requestedType: "Požadovaný typ", deliveryPlace: "Miesto pristavenia", entitlement: "Nárok", extensionPossible: "Možnosť predĺženia", maxDays: "Maximálny počet dní", provisionStatus: "Poskytnutie vozidla", provisionReason: "Dôvod poskytnutia", insurancePortalUrl: "Portál poisťovne", closedAt: "Čas ukončenia",
  name: "Meno", firstName: "Meno", lastName: "Priezvisko", phone: "Telefón", email: "E-mail", role: "Úloha kontaktu", notes: "Poznámka",
  license_plate: "EČV", vin: "VIN", make: "Značka", model: "Model", category: "Kategória", transmission: "Prevodovka", production_year: "Rok výroby", color: "Farba", drive_type: "Pohon", weight_kg: "Hmotnosť (kg)", is_driveable: "Pojazdné",
  label: "Miesto", address: "Adresa", lat: "Zemepisná šírka", lng: "Zemepisná dĺžka", title: "Názov", body: "Text", createdAt: "Čas", updatedAt: "Aktualizácia", actor: "Autor", status: "Stav", priority: "Priorita", dueAt: "Termín", assignedTo: "Pridelené", direction: "Smer", to: "Príjemca", from: "Odosielateľ",
  type: "Typ", companyName: "Firma", companyId: "IČO", taxId: "DIČ", vatId: "IČ DPH", street: "Ulica", city: "Mesto", postalCode: "PSČ", country: "Krajina", contactName: "Kontaktná osoba", contactPhone: "Kontaktný telefón", assistanceService: "Asistenčná služba", assistanceCaseNumber: "Číslo asistenčného prípadu", insuranceCompany: "Poisťovňa", policyNumber: "Číslo poistky",
  description: "Opis", problemDescription: "Opis poruchy", damageAreas: "Poškodené časti", conditionFlags: "Stav vozidla", accessComplications: "Komplikácie prístupu", needed: "Požadované", preferences: "Požiadavky", method: "Spôsob úhrady", amount: "Suma", currency: "Mena", invoiceNumber: "Číslo faktúry", reason: "Dôvod", outcome: "Výsledok", fileName: "Názov súboru", filename: "Názov súboru", nameOriginal: "Názov súboru", size: "Veľkosť", mimeType: "Formát",
};
const excluded = new Set(["id", "organization_id", "user_id", "contact_id", "vehicle_id", "pickup_location_id", "destination_location_id", "owner_id", "created_by", "updated_by", "raw_payload", "metadata", "request_fingerprint", "idempotency_key", "storagePath", "storage_path", "url", "lookup", "vehicleLookup", "vehicle_lookup"]);
const valueLabels: Record<string, string> = { ...caseStatusLabels, ...casePriorityLabels, outbound: "Odchádzajúca", inbound: "Prichádzajúca", queued: "Vo fronte", sent: "Odoslaná", delivered: "Doručená", failed: "Neúspešná", received: "Prijatá", done: "Vybavená", client: "Klient", assistance: "Asistenčná služba", partner: "Partner", branch: "Pobočka", tow_truck: "Odťahové vozidlo", replacement_car: "Náhradné vozidlo", private_person: "Súkromná osoba", company: "Firma", card: "Karta", cash: "Hotovosť", unpaid: "Neuhradené", paid: "Uhradené" };
function display(value: unknown): string {
  if (typeof value === "boolean") return value ? "Áno" : "Nie";
  if (typeof value === "string") {
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value) && Number.isFinite(Date.parse(value))) return new Intl.DateTimeFormat("sk-SK", { timeZone: "Europe/Bratislava", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    return valueLabels[value] ?? value;
  }
  return String(value ?? "");
}
function fields(data: RecordValue | null | undefined): string {
  if (!data) return '<p class="empty">Neuvedené</p>';
  const rows: string[] = [];
  function add(value: unknown, key: string, prefix = "") {
    if (excluded.has(key) || value === undefined || value === null || value === "" || key.endsWith("_id")) return;
    const label = [prefix, labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")].filter(Boolean).join(" · ");
    if (Array.isArray(value)) {
      if (value.every(item => typeof item !== "object" || item === null)) rows.push(`<div class="field"><dt>${escapePdfText(label)}</dt><dd>${escapePdfText(value.map(display).join(", "))}</dd></div>`);
      else value.forEach((item, index) => { if (item && typeof item === "object") Object.entries(item).forEach(([child, entry]) => add(entry, child, `${label} ${index + 1}`)); });
    } else if (typeof value === "object") Object.entries(value).forEach(([child, entry]) => add(entry, child, label));
    else rows.push(`<div class="field"><dt>${escapePdfText(label)}</dt><dd>${escapePdfText(display(value))}</dd></div>`);
  }
  Object.entries(data).forEach(([key, value]) => add(value, key));
  return rows.length ? `<dl>${rows.join("")}</dl>` : '<p class="empty">Neuvedené</p>';
}
function section(title: string, content: string) { return `<section><h2>${escapePdfText(title)}</h2>${content}</section>`; }
function records(items: RecordValue[]) { return items.length ? items.map(item => `<article>${fields(item)}</article>`).join("") : '<p class="empty">Žiadne záznamy</p>'; }

/** Only saved case fields are rendered. Private notebook/task chat are absent from the DTO. */
export function renderCasePdf(snapshot: CasePdfSnapshot, fontRegular: string, fontBold: string): string {
  const c = snapshot.case;
  const { label: assetLabel, ...assetDetails } = snapshot.assignedAsset ?? {};
  const sections = [
    section("Prehľad prípadu", fields({ status: c.status, priority: c.priority, assignedTo: snapshot.owner, type: c.case_type, source: c.source_type, summary: c.summary, mainNote: c.main_note, jobTypes: c.job_types, createdAt: c.created_at, updatedAt: c.updated_at })),
    section("Pridelená technika", fields(snapshot.assignedAsset ? { title: assetLabel, ...assetDetails } : null)),
    section("Úlohy", records(snapshot.tasks)), section("Kontakt", fields(snapshot.contact)),
    section("Údaje zákazníka", fields(c.customer_details as RecordValue)), section("Vozidlo", fields({ ...snapshot.vehicle, ...c.vehicle_details as RecordValue })),
    section("Incident", fields(c.incident_details as RecordValue)), section("Miesto zásahu", fields(snapshot.pickup)), section("Cieľ", fields(snapshot.destination)),
    section("Podrobnosti miesta", fields(c.location_details as RecordValue)), section("Náhradné vozidlo", fields(c.replacement_vehicle_details as RecordValue)),
    section("Prílohy", fields({ attachments: c.attachments_metadata })), section("Platba", fields(c.payment_details as RecordValue)), section("Ukončenie", fields(c.closure_details as RecordValue)),
    section("Poznámky a aktivita", records(snapshot.events)), section("História SMS prípadu", records(snapshot.sms)),
  ].join("");
  return `<!doctype html><html lang="sk"><head><meta charset="utf-8"><title>${escapePdfText(c.case_number)}</title><style>
  @font-face{font-family:Export;src:url(data:font/ttf;base64,${fontRegular}) format('truetype');font-weight:400}
  @font-face{font-family:Export;src:url(data:font/ttf;base64,${fontBold}) format('truetype');font-weight:700}
  @page{size:A4;margin:17mm 15mm 20mm}*{box-sizing:border-box}body{font-family:Export,sans-serif;color:#18181b;font-size:10pt;line-height:1.45;margin:0}h1{font-size:23pt;margin:0 0 3mm}h2{font-size:13pt;border-bottom:1px solid #d4d4d8;padding:2mm 0;break-after:avoid}section{margin-top:6mm}article{break-inside:avoid-page;border-bottom:1px solid #e4e4e7;padding:2mm 0}dl{margin:0}.field{display:block;margin:1.5mm 0}dt{font-weight:700;color:#52525b;font-size:9pt;break-after:avoid}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;orphans:3;widows:3}.empty,.meta{color:#71717a;font-size:9pt}header{border-bottom:3px solid #eab308;padding-bottom:3mm}
  </style></head><body><header><p class="meta">Záznam zásahu · uložené údaje</p><h1>${escapePdfText(c.case_number)}</h1><p class="meta">Verzia uložená: ${escapePdfText(display(c.updated_at))} · slovenský čas</p><p class="meta">Revízia prípadu: ${escapePdfText(c.updated_at)}<br>Čas snímky: ${escapePdfText(snapshot.snapshotAt ?? "Neuvedené")}</p></header>${sections}</body></html>`;
}
