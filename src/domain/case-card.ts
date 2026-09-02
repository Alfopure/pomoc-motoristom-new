import type {
  AccessComplication,
  CaseAttachmentMetadata,
  CaseLocationDetails,
  ClientVehicleType,
  ClosureDetails,
  CustomerContactRole,
  CustomerDetails,
  CustomerType,
  DamageArea,
  IncidentDetails,
  IncidentType,
  JobType,
  PaymentDetails,
  PlaceType,
  ReplacementVehicleCategory,
  ReplacementVehicleEntitlement,
  ReplacementVehiclePreference,
  ReplacementVehicleProvisionStatus,
  ReplacementVehicleRequest,
  VehicleConditionFlag,
  VehicleTransmission,
  PartnerDirectoryKind,
} from "./types";

export const jobTypeLabels: Record<JobType, string> = {
  tow: "Odťah",
  replacement_vehicle: "Náhradné vozidlo",
  onsite_assistance: "Asistencia na mieste",
  vehicle_recovery: "Vyslobodenie MV",
};

export const customerTypeLabels: Record<CustomerType, string> = {
  private_person: "Súkromná osoba",
  insurance: "Asistenčná služba",
  company: "Firma",
};

export const clientVehicleTypeLabels: Record<ClientVehicleType, string> = {
  passenger: "Osobné",
  suv: "SUV",
  van: "Dodávka",
  truck: "Nákladné",
  motorcycle: "Motorka",
  electric: "Elektro",
};

export const transmissionLabels: Record<VehicleTransmission, string> = {
  manual: "Manuál",
  automatic: "Automat",
  unknown: "Nezistené",
};

export const vehicleConditionFlagLabels: Record<VehicleConditionFlag, string> = {
  driveable: "Pojazdné",
  immobile: "Nepojazdné",
  locked: "Zamknuté",
  no_keys: "Bez kľúčov",
  blocked_wheel: "Zablokované koleso",
  after_accident: "Po nehode",
  overturned: "Prevrátené",
  in_ditch: "V priekope",
};

export const incidentTypeLabels: Record<IncidentType, string> = {
  traffic_accident: "Dopravná nehoda",
  breakdown: "Porucha",
  flat_tire: "Defekt",
  dead_battery: "Vybitá batéria",
  wrong_fuel: "Zlé palivo",
  locked_keys: "Zabuchnuté kľúče",
  overheating: "Prehriatie",
  fire: "Požiar",
  other: "Iné",
};

export const damageAreaLabels: Record<DamageArea, string> = {
  front: "Predok",
  rear: "Zadok",
  left_side: "Ľavá strana",
  right_side: "Pravá strana",
  roof: "Strecha",
  undercarriage: "Podvozok",
  wheel: "Koleso",
  glass: "Sklo",
  engine: "Motor",
};

export const placeTypeLabels: Record<PlaceType, string> = {
  road: "Cesta",
  highway: "Diaľnica",
  parking_lot: "Parkovisko",
  garage_outdoor: "Garáž vonkajšia/nadzemná",
  garage_underground: "Podzemná garáž",
  company_site: "Firemný areál",
  field: "Pole",
  forest: "Les",
};

export const accessComplicationLabels: Record<AccessComplication, string> = {
  narrow_road: "Úzka cesta",
  parallel_parking: "Pozdĺžne parkovanie",
  difficult_access: "Komplikovanejší prístup k MV",
  mud: "Bahno",
  snow: "Sneh",
  low_clearance: "Nízky prejazd",
};

export const replacementPreferenceLabels: Record<ReplacementVehiclePreference, string> = {
  manual: "Manuál",
  automatic: "Automat",
  suv: "SUV",
  wagon: "Kombi",
  van: "Dodávka",
  ev: "EV",
};

export const replacementProvisionLabels: Record<ReplacementVehicleProvisionStatus, string> = {
  provided: "Poskytnuté",
  not_provided: "Neposkytnuté",
  pending: "Čaká na preverenie",
};

export const replacementCategoryLabels: Record<ReplacementVehicleCategory, string> = {
  small_car: "Malé auto",
  wagon: "Kombi",
  suv: "SUV",
  van: "Dodávka",
};

export const replacementEntitlementLabels: Record<ReplacementVehicleEntitlement, string> = {
  yes: "Áno, má nárok",
  no: "Nie, nemá nárok",
  unverified: "Nepreverené",
};

/**
 * Prípad výhradne na náhradné vozidlo (P-03/P-04): špecializovaný formulár bez
 * odťahových polí. Akákoľvek kombinácia s odťahom/vyslobodením/asistenciou
 * vracia plný formulár.
 */
export function isReplacementVehicleOnlyCase(jobTypes: JobType[] | undefined) {
  return Boolean(jobTypes && jobTypes.length > 0 && jobTypes.every((jobType) => jobType === "replacement_vehicle"));
}

export const paymentMethodLabels = {
  cash: "Hotovosť",
  card: "Karta",
  invoice: "Faktúra",
  insurance: "Asistenčná služba",
} as const;

export const paymentStatusLabels = {
  paid: "Uhradené",
  unpaid: "Neuhradené",
  waiting_for_insurance: "Čaká na asistenčnú službu",
} as const;

export const customerContactRoleLabels: Record<CustomerContactRole, string> = {
  primary_customer: "Zákazník",
  driver: "Šofér",
  owner: "Majiteľ",
  company: "Firma",
  assistance: "Asistenčná služba",
  partner: "Partner",
  police: "Polícia",
  family: "Príbuzný",
  billing: "Fakturácia",
  other: "Iný kontakt",
};

export const partnerDirectoryKindLabels: Record<PartnerDirectoryKind, string> = {
  assistance: "Asistenčná služba",
  company: "Firma",
};

export function requiresTowDestination(jobTypes: JobType[] | undefined) {
  return Boolean(jobTypes?.some((jobType) => jobType === "tow" || jobType === "vehicle_recovery"));
}

/**
 * The case card now exposes one problem/incident description. Keep a single,
 * deterministic value even while older rows can still contain both legacy
 * vehicle notes and a separate incident description.
 */
export function canonicalCaseProblemDescription(...values: Array<string | null | undefined>) {
  const unique: string[] = [];
  const normalized = new Set<string>();

  for (const value of values) {
    const cleaned = value?.trim();
    if (!cleaned) continue;

    const key = cleaned.replace(/\s+/g, " ").toLocaleLowerCase("sk");
    if (normalized.has(key)) continue;

    normalized.add(key);
    unique.push(cleaned);
  }

  return unique.length > 0 ? unique.join(" · ") : undefined;
}

/**
 * Historically `motorist_vehicles.notes` was persisted as
 * `problem · vehicle note`, while the vehicle note was also stored separately
 * in `vehicle_details.note`. Remove only those repeated trailing copies so a
 * subsequent save does not grow the text again.
 */
export function legacyVehicleProblemDescription(vehicleNotes: string | null | undefined, vehicleNote: string | null | undefined) {
  let problem = vehicleNotes?.trim() ?? "";
  const separateNote = vehicleNote?.trim() ?? "";

  if (!problem || !separateNote) {
    return problem || undefined;
  }

  const normalizedProblem = problem.replace(/\s+/g, " ").toLocaleLowerCase("sk");
  const normalizedNote = separateNote.replace(/\s+/g, " ").toLocaleLowerCase("sk");
  if (normalizedProblem === normalizedNote) {
    return undefined;
  }

  const suffix = ` · ${separateNote}`;
  while (problem.toLocaleLowerCase("sk").endsWith(suffix.toLocaleLowerCase("sk"))) {
    problem = problem.slice(0, -suffix.length).trim();
  }

  return problem || undefined;
}

export function defaultCustomerDetails(): CustomerDetails {
  return {};
}

export function defaultIncidentDetails(): IncidentDetails {
  return { damageAreas: [] };
}

export function defaultLocationDetails(): CaseLocationDetails {
  return { accessComplications: [] };
}

export function defaultReplacementVehicleRequest(): ReplacementVehicleRequest {
  return { needed: false, preferences: [] };
}

export function defaultPaymentDetails(): PaymentDetails {
  return {};
}

export function defaultClosureDetails(): ClosureDetails {
  return {};
}

export function defaultAttachments(): CaseAttachmentMetadata[] {
  return [];
}
