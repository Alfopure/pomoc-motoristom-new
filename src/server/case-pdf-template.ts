import {
  accessComplicationLabels, damageAreaLabels, incidentTypeLabels, jobTypeLabels,
  legacyVehicleProblemDescription,
  paymentMethodLabels, placeTypeLabels, replacementCategoryLabels,
  replacementEntitlementLabels, replacementPreferenceLabels, replacementProvisionLabels,
  vehicleConditionFlagLabels,
} from "@/domain/case-card";
import type { JobType } from "@/domain/types";

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

function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function prose(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n")
    : text(value);
}

function first(...values: unknown[]): string {
  return values.map(text).find(Boolean) ?? "";
}

function mapped(value: unknown, labels: Record<string, string>): string {
  const key = text(value);
  return key ? labels[key] ?? key : "";
}

function mappedList(value: unknown, labels: Record<string, string>): string {
  return Array.isArray(value) ? value.map(item => mapped(item, labels)).filter(Boolean).join(" · ") : "";
}

function dateTime(value: unknown): string {
  const raw = text(value);
  if (!raw || !Number.isFinite(Date.parse(raw))) return "";
  return new Intl.DateTimeFormat("sk-SK", { timeZone: "Europe/Bratislava", dateStyle: "medium", timeStyle: "short" }).format(new Date(raw));
}

function location(record: RecordValue | null | undefined, manual: unknown): string {
  // The operator's manual address takes precedence over an older map selection.
  return first(manual, record?.address, record?.label);
}

function serviceTypes(c: RecordValue, vehicleDetails: RecordValue): JobType[] {
  const values = vehicleDetails.jobTypes;
  if (Array.isArray(values)) {
    const types = values.filter((value): value is JobType => typeof value === "string" && value in jobTypeLabels);
    if (types.length) return [...new Set(types)];
  }
  const legacy = text(c.case_type).toLocaleLowerCase("sk");
  const inferred: JobType[] = [];
  if (/odťah|odtah/.test(legacy)) inferred.push("tow");
  if (/vyslobod/.test(legacy)) inferred.push("vehicle_recovery");
  if (/asistenc|výjazd|vyjazd/.test(legacy)) inferred.push("onsite_assistance");
  if (/náhradn|nahradn|prenájom|prenajom/.test(legacy)) inferred.push("replacement_vehicle");
  return inferred;
}

/** A one-page operational brief. The complete saved case remains available in the app. */
export function renderCasePdf(snapshot: CasePdfSnapshot, fontRegular: string, fontBold: string, textBudget = 1): string {
  const c = snapshot.case;
  const customer = object(c.customer_details);
  const vehicleDetails = object(c.vehicle_details);
  const incident = object(c.incident_details);
  const places = object(c.location_details);
  const replacement = object(c.replacement_vehicle_details);
  const payment = object(c.payment_details);
  const vehicle = object(snapshot.vehicle);
  const asset = object(snapshot.assignedAsset);
  const contact = object(snapshot.contact);
  const contacts = Array.isArray(customer.contacts) ? customer.contacts.map(object) : [];
  const primary = contacts.find(item => item.isPrimary === true) ?? contacts[0] ?? {};
  const storedTypes = serviceTypes(c, vehicleDetails);
  // "Need a replacement" is saved separately from job types in the form. A
  // towing job can therefore also need delivery even if the type list says tow.
  const types: JobType[] = storedTypes.length ? [...storedTypes]
    : snapshot.destination || text(places.manualDestinationAddress) ? ["tow"] : [];
  if (replacement.needed === true && !types.includes("replacement_vehicle")) types.push("replacement_vehicle");
  const rentalOnly = types.length === 1 && types[0] === "replacement_vehicle";
  const showRoadside = !rentalOnly;
  const showTowRoute = types.some(type => type === "tow" || type === "vehicle_recovery") || (types.length === 0 && Boolean(snapshot.destination || text(places.manualDestinationAddress)));
  const showReplacement = replacement.needed === true || (replacement.needed == null && types.includes("replacement_vehicle"));
  let shortened = false;

  function brief(full: string, limit: number, priority = false): string {
    const allowed = Math.max(35, Math.floor(limit * (priority ? 1 : textBudget)));
    if (full.length <= allowed) return full;
    shortened = true;
    const prefix = full.slice(0, allowed).replace(/\s+\S*$/, "").trimEnd() || full.slice(0, allowed);
    return `${prefix}…*`;
  }

  function fact(label: string, value: unknown, options: { wide?: boolean; limit?: number; priority?: boolean; multiline?: boolean } = {}): string {
    const clean = options.multiline ? prose(value) : text(value);
    if (!clean) return "";
    return `<div class="fact${options.wide ? " wide" : ""}"><dt>${escapePdfText(label)}</dt><dd>${escapePdfText(brief(clean, options.limit ?? 130, options.priority))}</dd></div>`;
  }

  function card(title: string, content: string, className = ""): string {
    return content ? `<section class="card ${className}"><h2>${escapePdfText(title)}</h2><dl class="facts">${content}</dl></section>` : "";
  }

  const serviceLabel = types.length ? types.map(type => jobTypeLabels[type]).join(" · ") : first(c.case_type, "Typ služby neurčený");
  const contactName = first(
    primary.name,
    [text(primary.firstName), text(primary.lastName)].filter(Boolean).join(" "),
    contact.name,
  );
  const customerName = first(customer.companyName, [text(customer.firstName), text(customer.lastName)].filter(Boolean).join(" "));
  const contactBody = [
    fact("Zákazník", customerName && customerName.toLocaleLowerCase("sk") !== contactName.toLocaleLowerCase("sk") ? customerName : "", { wide: true, limit: 110, priority: true }),
    fact("Kontakt", first(contactName, customerName), { limit: 90, priority: true }),
    fact("Telefón", first(primary.phone, !contactName || contactName === text(contact.name) ? contact.phone : ""), { limit: 60, priority: true }),
    fact("E-mail", first(primary.email, !contactName || contactName === text(contact.name) ? contact.email : ""), { wide: true, limit: 100 }),
  ].join("");
  const vehicleBody = [
    fact("EČV", vehicle.license_plate, { limit: 40, priority: true }),
    fact("VIN", vehicle.vin, { limit: 50, priority: true }),
    fact("Značka a model", [text(vehicle.make), text(vehicle.model)].filter(Boolean).join(" "), { wide: true, limit: 100 }),
  ].join("");
  const assistanceBody = [
    fact("Asistenčná služba", customer.assistanceServiceName, { limit: 100, priority: true }),
    fact("Číslo asistenčného prípadu", first(customer.assistanceReference, c.assistance_reference), { limit: 90, priority: true }),
  ].join("");

  const routeBody = showRoadside ? [
    fact("Miesto zásahu", location(snapshot.pickup, places.manualPickupAddress), { wide: !showTowRoute, limit: 350, priority: true }),
    showTowRoute ? fact("Cieľ odťahu", location(snapshot.destination, places.manualDestinationAddress), { limit: 350, priority: true }) : "",
  ].join("") : "";
  const roadDescription = [mapped(incident.type, incidentTypeLabels), first(incident.description, legacyVehicleProblemDescription(text(vehicle.notes), text(vehicleDetails.note)))].filter(Boolean).join(" · ");
  const driveability = typeof vehicle.is_driveable === "boolean" ? vehicle.is_driveable ? "Pojazdné" : "Nepojazdné" : "";
  const flags = Array.isArray(vehicleDetails.conditionFlags) ? vehicleDetails.conditionFlags : [];
  const condition = [driveability || mappedList(flags.filter(flag => flag === "driveable" || flag === "immobile"), vehicleConditionFlagLabels), mappedList(flags.filter(flag => flag !== "driveable" && flag !== "immobile"), vehicleConditionFlagLabels)].filter(Boolean).join(" · ");
  const roadPosition = [text(places.roadName), places.kilometerSection ? `km ${text(places.kilometerSection)}` : "", places.drivingDirection ? `smer ${text(places.drivingDirection)}` : "", mapped(places.placeType, placeTypeLabels)].filter(Boolean).join(" · ");
  const access = [text(places.complications), mappedList(places.accessComplications, accessComplicationLabels)].filter(Boolean).join(" · ");
  const damage = [text(incident.damages), mappedList(incident.damageAreas, damageAreaLabels), text(incident.damageNote)].filter(Boolean).join(" · ");
  const roadsideBody = showRoadside ? [
    fact("Problém", roadDescription, { wide: true, limit: 240 }),
    fact("Stav vozidla", condition, { limit: 120 }),
    fact("Cesta a poloha", roadPosition, { limit: 180 }),
    fact("Prístup / upozornenie", access, { wide: true, limit: 220 }),
    fact("Poškodenie", damage, { wide: true, limit: 160 }),
    showTowRoute ? fact("Pokyn k cieľu", places.destinationNote, { wide: true, limit: 170 }) : "",
  ].join("") : "";

  const requestedVehicle = [first(replacement.requestedType, mapped(replacement.category, replacementCategoryLabels)), mappedList(replacement.preferences, replacementPreferenceLabels)].filter(Boolean).join(" · ");
  const replacementBody = showReplacement ? [
    fact("Požadované vozidlo", requestedVehicle, { limit: 130 }),
    fact("Maximálna doba", replacement.maxDays != null ? `${text(replacement.maxDays)} dní` : "", { limit: 50 }),
    fact("Miesto pristavenia", first(replacement.deliveryPlace, rentalOnly ? location(snapshot.pickup, places.manualPickupAddress) : ""), { wide: true, limit: 350, priority: true }),
    fact("Nárok na pristavenie", mapped(replacement.entitlement, replacementEntitlementLabels), { limit: 80 }),
    fact("Predĺženie", typeof replacement.extensionPossible === "boolean" ? replacement.extensionPossible ? "Možné" : "Nie" : "", { limit: 60 }),
    fact("Stav poskytnutia", mapped(replacement.provisionStatus, replacementProvisionLabels), { limit: 90 }),
    fact("Limit a požiadavky", replacement.note, { wide: true, limit: 300, priority: true, multiline: true }),
  ].join("") : replacement.needed === false && types.includes("replacement_vehicle")
    ? fact("Potreba", "Nie, zákazník nepotrebuje") : "";

  const assignmentBody = [
    fact("Vozidlo / technika", [text(asset.label), text(asset.license_plate)].filter(Boolean).join(" · "), { limit: 110 }),
    fact("Vodič", [text(asset.assignedDriverName), text(asset.assignedDriverPhone)].filter(Boolean).join(" · "), { limit: 110 }),
  ].join("");
  const generatedSummary = [text(c.case_type), text(vehicle.license_plate).toUpperCase()].filter(Boolean).join(" · ");
  const noteValues = [
    ["Pokyn pre výjazd", c.main_note],
    ["Stručný opis", showRoadside && text(c.summary) !== generatedSummary ? c.summary : undefined],
    ["Zákazník", first(customer.note, primary.note, contact.notes)],
    ["Vozidlo", showRoadside ? vehicleDetails.note : undefined],
  ] as const;
  const noteBody = noteValues
    .filter(([, value]) => text(value))
    .filter(([, value], index, all) => all.findIndex(([, other]) => text(other) === text(value)) === index)
    .map(([label, value]) => fact(label, value, { wide: true, limit: label === "Pokyn pre výjazd" ? 300 : 220, priority: label === "Pokyn pre výjazd", multiline: true }))
    .join("");
  const paymentBody = [
    fact("Spôsob úhrady", mapped(payment.method, paymentMethodLabels), { limit: 100 }),
  ].join("");

  const sections = [
    card("Asistenčný prípad", assistanceBody, "assist"),
    `<div class="pair">${card("Kontakt", contactBody)}${card("Vozidlo zákazníka", vehicleBody)}</div>`,
    card(showTowRoute ? "Trasa odťahu" : "Miesto zásahu", routeBody),
    card("Zásah", roadsideBody),
    card("Náhradné vozidlo", replacementBody),
    assignmentBody || paymentBody ? `<div class="pair">${card("Pridelenie", assignmentBody)}${card("Úhrada", paymentBody)}</div>` : "",
    card("Poznámky", noteBody),
  ].filter(Boolean).join("");
  const createdAt = dateTime(c.created_at);

  return `<!doctype html><html lang="sk"><head><meta charset="utf-8"><title>${escapePdfText(c.case_number)}</title><style>
    @font-face{font-family:Export;src:url(data:font/ttf;base64,${fontRegular}) format('truetype');font-weight:400}
    @font-face{font-family:Export;src:url(data:font/ttf;base64,${fontBold}) format('truetype');font-weight:700}
    @page{size:A4;margin:10mm 11mm 10mm}
    *{box-sizing:border-box}html,body{margin:0;padding:0}body{width:188mm;font-family:Export,Arial,sans-serif;color:#18181b;font-size:8.4pt;line-height:1.28}
    header{display:flex;justify-content:space-between;align-items:flex-start;gap:7mm;border-top:2.2mm solid #eab308;border-bottom:1px solid #d4d4d8;padding:3mm 0 3mm;margin-bottom:2.4mm}
    .eyebrow{font-size:7.3pt;letter-spacing:.06em;text-transform:uppercase;color:#52525b;font-weight:700}h1{font-size:20pt;line-height:1.08;letter-spacing:-.02em;margin:1mm 0 1.5mm;overflow-wrap:anywhere}
    .service{font-size:9pt;font-weight:700}.date{font-size:8pt;color:#52525b;white-space:nowrap;text-align:right;margin-top:1mm}
    .card{border:1px solid #e4e4e7;border-radius:2mm;padding:2mm 2.8mm;margin:0 0 1.7mm;break-inside:avoid-page;min-width:0}
    .assist{background:#fffdf2;border-color:#f5e6a0}h2{font-size:9.2pt;line-height:1.2;margin:0 0 1.7mm;color:#27272a}
    .pair{display:grid;grid-template-columns:1fr 1fr;gap:2.4mm;align-items:stretch}.pair .card{height:calc(100% - 1.7mm)}
    dl{margin:0}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:3mm;row-gap:1.3mm}.fact{min-width:0;break-inside:avoid}.fact.wide{grid-column:1/-1}
    dt{font-size:7.1pt;color:#71717a;font-weight:700;margin-bottom:.25mm}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-weight:400}
    .footnote{font-size:7.2pt;color:#52525b;margin:1mm 0 0}
  </style></head><body><header><div><div class="eyebrow">Prípad č.</div><h1>${escapePdfText(c.case_number)}</h1><div class="service">${escapePdfText(brief(serviceLabel, 130))}</div></div>${createdAt ? `<div class="date">Založené<br><strong>${escapePdfText(createdAt)}</strong></div>` : ""}</header>${sections}${shortened ? '<p class="footnote">* Skrátené. Úplné znenie je v karte prípadu.</p>' : ""}</body></html>`;
}
