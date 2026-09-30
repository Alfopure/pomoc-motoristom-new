/** Public contract shared by the server and all three vehicle forms. No secrets. */
export type VehicleCountry = "SK" | "CZ";
export type VehicleSource = "databazavozidiel" | "skp" | "stkonline" | "haka" | "vpic" | "mycarplate" | "rsv" | "autokuk";
export type LookupStatus = "found" | "not_found" | "ambiguous" | "challenge_required" | "rate_limited" | "unavailable" | "unsupported";
export type VehicleField = "plate" | "vin" | "make" | "model" | "color" | "fuel" | "modelYear" | "bodyType" | "doors" | "seats" | "transmission" | "engineCapacityCc" | "powerKw" | "technicalInspectionValidUntil" | "emissionInspectionValidUntil" | "technicalInspectionAt" | "emissionInspectionAt" | "insurer" | "insuranceStatus"
  | "vehicleCategory" | "vehicleType" | "vehicleTypeDesignation" | "typeVariantVersion" | "variant" | "version" | "manufacturer" | "firstRegisteredAt" | "firstRegisteredInSkAt"
  | "engineType" | "engineManufacturer" | "engineNumber" | "engineRpm" | "transmissionGears" | "maxSpeedKmh" | "emissionClass"
  | "curbWeightKg" | "grossWeightKg" | "grossTrainWeightKg" | "maxAxleWeightKg" | "trailerWeightKg" | "trailerBrakedWeightKg" | "trailerUnbrakedWeightKg"
  | "axleCount" | "drivenAxles" | "wheelbaseMm" | "lengthMm" | "widthMm" | "heightMm" | "tireDimensions" | "rimDimensions" | "towingDevice"
  | "vignetteStatus" | "vignetteValidFrom" | "vignetteValidUntil";
export type VehicleFact = { value: string; quality: "reported" | "decoded" | "partial" };
export type VehicleFacts = Partial<Record<VehicleField, VehicleFact>>;
export type VehicleIdentity = { plate?: string; vin?: string; country?: string };
export type VehicleReport = { url: string; title: string; identity?: VehicleIdentity };
export type VehicleFieldChoices = Partial<Record<VehicleField, VehicleSource>>;
export type VehicleFactOption = { source: VehicleSource; fact: VehicleFact };
export type VehicleQuery = { kind: "plate" | "vin"; value: string; country: VehicleCountry; checkedForDate: string };
export type VehicleLookupInput = { kind: "plate" | "vin"; value: string; country: VehicleCountry; knownIdentity?: VehicleIdentity };
export type VehicleSourceResult = {
  source: VehicleSource;
  status: LookupStatus;
  url: string;
  fetchedAt: string;
  facts: VehicleFacts;
  warnings: string[];
  candidates?: VehicleIdentity[];
  reports?: VehicleReport[];
};
export type VehicleLookupResult = {
  version: 1;
  id: string;
  query: VehicleQuery;
  fetchedAt: string;
  sources: VehicleSourceResult[];
};
export type VehicleLookupSnapshot = { result: VehicleLookupResult; proof: string };
export type VehicleLookupResponse = { snapshot: VehicleLookupSnapshot; cached: boolean; conflict?: string };
export type VehicleFormValues = Partial<Record<VehicleField, string>>;

export const vehicleSourceLabels: Record<VehicleSource, string> = { databazavozidiel: "DatabázaVozidiel.sk", skp: "SKP · PZP", stkonline: "STKonline", haka: "HAKA · hlásenia", vpic: "NHTSA · VIN dekódovanie", mycarplate: "MyCarPlate · ČR", rsv: "Register vozidiel ČR", autokuk: "Autokuk · ČR" };
export const vehicleFieldLabels: Record<VehicleField, string> = {
  plate: "EČV", vin: "VIN", make: "Značka", model: "Model", color: "Farba", fuel: "Palivo",
  modelYear: "Modelový rok (nie rok výroby)", bodyType: "Karoséria", doors: "Dvere", seats: "Sedadlá",
  transmission: "Prevodovka", engineCapacityCc: "Objem motora (cm³)", powerKw: "Výkon (kW)",
  technicalInspectionValidUntil: "TK platná do", emissionInspectionValidUntil: "EK platná do",
  technicalInspectionAt: "TK vykonaná", emissionInspectionAt: "EK vykonaná",
  insurer: "Poisťovňa PZP", insuranceStatus: "PZP ku dňu overenia",
  vehicleCategory: "Kategória vozidla", vehicleType: "Druh vozidla", variant: "Variant", version: "Verzia", manufacturer: "Výrobca vozidla",
  vehicleTypeDesignation: "Typ vozidla", typeVariantVersion: "Typ / variant / verzia",
  firstRegisteredAt: "Prvá evidencia", firstRegisteredInSkAt: "Prvá evidencia v SR",
  engineType: "Typ motora", engineManufacturer: "Výrobca motora", engineNumber: "Číslo motora", engineRpm: "Otáčky motora (ot./min)",
  transmissionGears: "Počet prevodových stupňov", maxSpeedKmh: "Max. rýchlosť (km/h)", emissionClass: "Emisná norma",
  curbWeightKg: "Prevádzková hmotnosť (kg)", grossWeightKg: "Max. prípustná hmotnosť (kg)", grossTrainWeightKg: "Max. hmotnosť súpravy (kg)",
  maxAxleWeightKg: "Max. hmotnosť na nápravu (kg)", trailerWeightKg: "Max. hmotnosť prípojného vozidla (kg)",
  trailerBrakedWeightKg: "Max. hmotnosť brzdeného prívesu (kg)", trailerUnbrakedWeightKg: "Max. hmotnosť nebrzdeného prívesu (kg)",
  axleCount: "Počet náprav", drivenAxles: "Poháňané nápravy", wheelbaseMm: "Rázvor (mm)", lengthMm: "Dĺžka (mm)", widthMm: "Šírka (mm)", heightMm: "Výška (mm)",
  tireDimensions: "Pneumatiky", rimDimensions: "Ráfiky", towingDevice: "Spájacie zariadenie",
  vignetteStatus: "Česká diaľničná známka", vignetteValidFrom: "Známka platná od", vignetteValidUntil: "Známka platná do",
};

export function normalizeVehicleIdentifier(value: string) { return value.trim().toUpperCase().replace(/[\s-]/g, ""); }
export function isVin(value: string) { return /^[A-HJ-NPR-Z0-9]{17}$/.test(value); }
export function isSlovakPlate(value: string) { return /^[A-Z0-9]{5,8}$/.test(value) && /[A-Z]/.test(value); }
export function isCzechPlate(value: string) { return /^[A-Z0-9]{5,8}$/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value); }
export function slovakToday(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bratislava", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)!.value).join("-");
}

export function parseVehicleLookupInput(input: unknown, now = new Date()): { query: VehicleQuery; knownIdentity: VehicleIdentity } {
  if (!input || typeof input !== "object") throw new Error("Zadajte EČV alebo 17-miestny VIN.");
  const row = input as Record<string, unknown>;
  if ((row.country !== "SK" && row.country !== "CZ") || !["plate", "vin"].includes(String(row.kind)) || typeof row.value !== "string" || row.value.length > 30) throw new Error("Zvoľte Slovensko alebo Česko a zadajte EČV alebo VIN.");
  const country = row.country as VehicleCountry;
  const kind = row.kind as "plate" | "vin";
  const value = normalizeVehicleIdentifier(row.value);
  const validPlate = country === "CZ" ? isCzechPlate : isSlovakPlate;
  if (!(kind === "vin" ? isVin(value) : validPlate(value))) throw new Error(kind === "vin" ? "VIN musí mať 17 znakov bez I, O a Q." : `Skontrolujte EČV vozidla (${country}).`);
  const known = row.knownIdentity;
  if (known !== undefined && (!known || typeof known !== "object")) throw new Error("Neplatná identita vozidla.");
  const identity = (known ?? {}) as Record<string, unknown>;
  const knownIdentity: VehicleIdentity = { country };
  for (const field of ["vin", "plate"] as const) {
    if (identity[field] !== undefined && typeof identity[field] !== "string") throw new Error("Neplatná identita vozidla.");
    const normalized = normalizeVehicleIdentifier((identity[field] as string | undefined) ?? "");
    if (normalized && !(field === "vin" ? isVin(normalized) : validPlate(normalized))) throw new Error("Skontrolujte aj druhý vyplnený identifikátor vozidla.");
    if (normalized) knownIdentity[field] = normalized;
  }
  if (identity.country && identity.country !== country) throw new Error("Krajina vozidla nesúhlasí s vyhľadávaním.");
  if (knownIdentity[kind] && knownIdentity[kind] !== value) throw new Error("Identifikátor sa počas dohľadávania zmenil.");
  return { query: { kind, value, country, checkedForDate: slovakToday(now) }, knownIdentity };
}

/** Empty provider sentinels are not vehicle information. */
export function vehicleText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text || text.length > 180 || /^(NEUVEDEN[ÝÁÉEA]?|NEZ[NÁA]M[ÝÁÉ]?|OSTATN[ÉE]|N\/?A|NULL|NONE|UNKNOWN|-|—)$/iu.test(text)) return undefined;
  return text;
}

/** SKP can still list an older EČV for a policy found by VIN. Trust its insurer
 * only when a technical source independently binds the queried vehicle's EČV
 * to the same VIN; never replace the EČV in the case with SKP's value. */
export function vinLinkedSkpPlateDifference(result: VehicleLookupResult): { technicalPlate: string; skpPlate: string } | undefined {
  if (result.sources.some((source) => source.status === "ambiguous")) return undefined;
  const skp = result.sources.find((source) => source.source === "skp" && source.status === "found");
  const skpVin = normalizeVehicleIdentifier(skp?.facts.vin?.value ?? "");
  const skpPlate = normalizeVehicleIdentifier(skp?.facts.plate?.value ?? "");
  if (!isVin(skpVin) || !isSlovakPlate(skpPlate) || (result.query.kind === "vin" && skpVin !== result.query.value)) return undefined;

  const technical = result.sources.filter((source) => source.status === "found" && (source.source === "databazavozidiel" || source.source === "stkonline"));
  const matching = technical.find((source) => normalizeVehicleIdentifier(source.facts.vin?.value ?? "") === skpVin && isSlovakPlate(normalizeVehicleIdentifier(source.facts.plate?.value ?? "")));
  const technicalPlate = normalizeVehicleIdentifier(matching?.facts.plate?.value ?? "");
  if (!technicalPlate || technicalPlate === skpPlate || (result.query.kind === "plate" && technicalPlate !== result.query.value)) return undefined;
  if (technical.some((source) => (source.facts.vin && normalizeVehicleIdentifier(source.facts.vin.value) !== skpVin)
    || (source.facts.plate && normalizeVehicleIdentifier(source.facts.plate.value) !== technicalPlate))) return undefined;
  return { technicalPlate, skpPlate };
}

export function lookupIdentityConflict(result: VehicleLookupResult, identity: VehicleIdentity): string | undefined {
  if (identity.country && identity.country !== result.query.country) return "Krajina výsledku nesúhlasí so zvolenou krajinou vozidla. Dohľadajte vozidlo znova.";
  const enteredQueryIdentifier = identity[result.query.kind];
  if (enteredQueryIdentifier !== undefined && normalizeVehicleIdentifier(enteredQueryIdentifier) !== result.query.value) return "Výsledok patrí k inému zadanému identifikátoru vozidla. Dohľadajte aktuálne vozidlo znova.";
  if (result.sources.some((source) => source.status === "ambiguous")) return "Zdroj vrátil viac vozidiel alebo rozdielne identifikátory. Overte VIN v dokladoch.";
  const historicalSkpPlate = vinLinkedSkpPlateDifference(result)?.skpPlate;
  for (const field of ["vin", "plate"] as const) {
    const values = new Set(result.sources.filter((source) => source.status === "found" && !(field === "plate" && historicalSkpPlate && source.source === "skp"))
      .map((source) => source.facts[field]?.value).filter((v): v is string => Boolean(v)).map(normalizeVehicleIdentifier));
    const expected = normalizeVehicleIdentifier(identity[field] ?? (result.query.kind === field ? result.query.value : ""));
    if (values.size > 1 || (expected && [...values].some((value) => value !== expected))) return `Dohľadané ${field === "vin" ? "VIN" : "EČV"} nesúhlasí s formulárom alebo iným zdrojom. Údaje sa nedoplnili.`;
  }
}

export function preferredVehicleFacts(result: VehicleLookupResult, includePartial = false): VehicleFacts {
  const facts: VehicleFacts = {};
  const order: VehicleSource[] = result.query.country === "CZ" ? ["rsv", "autokuk", "mycarplate", "vpic", "databazavozidiel", "skp", "stkonline", "haka"] : ["databazavozidiel", "skp", "stkonline", "vpic", "haka", "rsv", "autokuk", "mycarplate"];
  const historicalSkpPlate = vinLinkedSkpPlateDifference(result)?.skpPlate;
  for (const source of [...result.sources].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))) {
    if (source.status !== "found" || source.source === "haka") continue;
    for (const [key, fact] of Object.entries(source.facts) as [VehicleField, VehicleFact][]) {
      if (key === "plate" && source.source === "skp" && historicalSkpPlate) continue;
      if (!facts[key] && (includePartial || fact.quality !== "partial")) facts[key] = fact;
    }
  }
  return facts;
}

function comparableFact(field: VehicleField, value: string) {
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  if (field === "fuel") {
    if (["ELEKTRINA", "ELECTRIC", "ELECTRICITY"].includes(normalized)) return "ELECTRIC";
    if (["NAFTA", "DIESEL"].includes(normalized)) return "DIESEL";
    if (["BENZIN", "GASOLINE", "PETROL"].includes(normalized)) return "PETROL";
  }
  if (field === "transmission") {
    if (["AT", "AUTOMATICKA", "AUTOMATIC"].includes(normalized)) return "AUTOMATIC";
    if (["MT", "MANUALNA", "MANUAL"].includes(normalized)) return "MANUAL";
  }
  return normalized;
}

/** A source priority must not silently settle a substantive disagreement. */
export function vehicleFactConflicts(result: VehicleLookupResult, includePartial = false): Partial<Record<VehicleField, VehicleFactOption[]>> {
  const options: Partial<Record<VehicleField, VehicleFactOption[]>> = {};
  for (const source of result.sources) {
    if (source.status !== "found" || source.source === "haka") continue;
    for (const [field, fact] of Object.entries(source.facts) as [VehicleField, VehicleFact][]) {
      if (field === "vin" || field === "plate" || (!includePartial && fact.quality === "partial")) continue;
      (options[field] ??= []).push({ source: source.source, fact });
    }
  }
  return Object.fromEntries(Object.entries(options).filter(([field, values]) => new Set(values.map(({ fact }) => comparableFact(field as VehicleField, fact.value))).size > 1));
}

/** Classify community reports independently of the vehicle facts being filled. */
export function hakaReportMatch(report: VehicleReport, result: VehicleLookupResult, identity: VehicleIdentity): "vin" | "plate" | "conflict" | "unverified" {
  const expected = (field: "vin" | "plate") => new Set([
    identity[field], result.query.kind === field ? result.query.value : undefined,
    ...result.sources.filter(source => source.status === "found" && source.source !== "haka").map(source => source.facts[field]?.value),
  ].filter((value): value is string => Boolean(value)).map(normalizeVehicleIdentifier));
  const vins = expected("vin");
  const reportVin = normalizeVehicleIdentifier(report.identity?.vin ?? "");
  if (reportVin && vins.size) return vins.size === 1 && vins.has(reportVin) ? "vin" : "conflict";
  const plates = expected("plate");
  const reportPlate = normalizeVehicleIdentifier(report.identity?.plate ?? "");
  if (reportPlate && plates.size) return plates.size === 1 && plates.has(reportPlate) ? "plate" : "conflict";
  return "unverified";
}

export function emptyVehicleFieldPatch(result: VehicleLookupResult, current: VehicleFormValues, includePartial = false, choices: VehicleFieldChoices = {}): VehicleFormValues {
  if (lookupIdentityConflict(result, { vin: current.vin, plate: current.plate })) return {};
  const facts = preferredVehicleFacts(result, includePartial);
  for (const [field, options] of Object.entries(vehicleFactConflicts(result, includePartial)) as [VehicleField, VehicleFactOption[]][]) {
    const chosen = options.find(option => option.source === choices[field]);
    if (chosen) facts[field] = chosen.fact;
    else delete facts[field];
  }
  return Object.fromEntries(Object.entries(current).filter(([key, value]) => !value?.trim() && facts[key as VehicleField]).map(([key]) => [key, facts[key as VehicleField]!.value]));
}

/** Values still matching an accepted lookup can be removed when the vehicle identity changes. */
export function vehicleFieldsMatchingLookup(result: VehicleLookupResult, current: VehicleFormValues): Set<VehicleField> {
  const matches = new Set<VehicleField>();
  for (const [field, value] of Object.entries(current) as [VehicleField, string][]) {
    if (!value?.trim()) continue;
    const values = result.sources
      .filter((source) => source.status === "found" && source.source !== "haka")
      .map((source) => source.facts[field]?.value)
      .filter((candidate): candidate is string => Boolean(candidate));
    if (result.query.kind === field) values.push(result.query.value);
    const normalize = field === "plate" || field === "vin" ? normalizeVehicleIdentifier : (candidate: string) => candidate;
    if (values.some((candidate) => normalize(candidate) === normalize(value))) matches.add(field);
  }
  return matches;
}

/** Internal feeds with no country must not assert a new plate → VIN binding. */
export function resolveInternalVehicle<T extends { licensePlate?: string; vin?: string; country?: string }>(vehicles: T[], plate: string, vin: string): T | undefined {
  const normalized = normalizeVehicleIdentifier(plate);
  const expectedVin = normalizeVehicleIdentifier(vin);
  if (!normalized) return undefined;
  const matches = vehicles.filter((vehicle) => normalizeVehicleIdentifier(vehicle.licensePlate ?? "") === normalized);
  if (matches.length !== 1) return undefined;
  const candidate = matches[0];
  if (expectedVin ? normalizeVehicleIdentifier(candidate.vin ?? "") !== expectedVin : candidate.country !== "SK") return undefined;
  return candidate;
}

/** Defensive read of snapshots already persisted by the signed server write path. */
export function readVehicleLookupSnapshot(value: unknown): VehicleLookupSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const snapshot = value as VehicleLookupSnapshot;
  if (typeof snapshot.proof !== "string" || !/^[\w-]{43}$/.test(snapshot.proof) || snapshot.result?.version !== 1 || !Array.isArray(snapshot.result.sources) || snapshot.result.sources.length > 5 || !snapshot.result.query) return undefined;
  if (snapshot.result.query.country !== "SK" && snapshot.result.query.country !== "CZ") return undefined;
  const sourceHosts: Record<VehicleSource, string> = { databazavozidiel: "www.databazavozidiel.sk", skp: "www.skp.sk", stkonline: "www.stkonline.sk", haka: "www.hakasystem.eu", vpic: "vpic.nhtsa.dot.gov", mycarplate: "www.mycarplate.online", rsv: "dataovozidlech.cz", autokuk: "autokuk.cz" };
  const seen = new Set<VehicleSource>();
  try {
    for (const source of snapshot.result.sources) {
      const url = new URL(source.url);
      if (!Object.hasOwn(sourceHosts, source.source) || seen.has(source.source) || url.protocol !== "https:" || url.hostname !== sourceHosts[source.source] || url.username || url.password || url.port || !source.facts || !Array.isArray(source.warnings)) return undefined;
      seen.add(source.source);
      for (const [field, fact] of Object.entries(source.facts)) if (!Object.hasOwn(vehicleFieldLabels, field) || typeof fact.value !== "string" || fact.value.length > 180) return undefined;
      for (const report of source.reports ?? []) {
        if (!/^https:\/\/www\.hakasystem\.eu\/kradeze-automobilov\/prispevok\/\d+$/.test(report.url)) return undefined;
        if (report.identity?.vin && !isVin(report.identity.vin)) return undefined;
        if (report.identity?.plate && !isSlovakPlate(report.identity.plate)) return undefined;
      }
    }
  } catch { return undefined; }
  return snapshot;
}
