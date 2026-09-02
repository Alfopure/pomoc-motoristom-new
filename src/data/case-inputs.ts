import type {
  AccessComplication,
  CaseAttachmentCategory,
  CasePriority,
  CaseTaskKind,
  ClientVehicleType,
  ClosureType,
  CustomerContactRole,
  CustomerType,
  DamageArea,
  FleetAssetCategory,
  FleetAssetKind,
  FleetAssetOccupancyType,
  FleetAssetStatus,
  FleetDriverStatus,
  IncidentType,
  JobType,
  PaymentMethod,
  PaymentStatus,
  PartnerDirectoryKind,
  PlaceType,
  ReplacementVehicleCategory,
  ReplacementVehicleEntitlement,
  ReplacementVehiclePreference,
  ReplacementVehicleProvisionStatus,
  TaskReminderChannel,
  TowCapability,
  TowTruckCategory,
  VehicleConditionFlag,
  VehicleTransmission,
} from "@/domain/types";

export type PlaceSelectionInput = {
  label: string;
  address: string;
  lat: number;
  lng: number;
  placeId?: string;
  provider?: "google_places" | "manual" | "approximate";
};

export type CreateCaseInput = {
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  customerType?: CustomerType | null;
  customerFirstName?: string;
  customerLastName?: string;
  companyName?: string;
  companyIdNumber?: string;
  assistanceServiceName?: string;
  assistanceReference?: string;
  partnerDirectoryId?: string;
  contacts?: CaseContactInput[];
  alternativeContact?: string;
  customerNote?: string;
  licensePlate?: string;
  vin?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleCategory?: string;
  vehicleType?: ClientVehicleType | null;
  productionYear?: number | null;
  vehicleColor?: string;
  transmission?: VehicleTransmission | null;
  driveType?: string;
  weightKg?: number | null;
  vehicleIssue?: string;
  vehicleDriveable?: boolean | null;
  vehicleConditionFlags?: VehicleConditionFlag[];
  vehicleNote?: string;
  caseType?: string | null;
  jobTypes?: JobType[];
  priority?: CasePriority;
  sourceType?: "client" | "assistance" | "samoplatca" | "partner" | "internal" | null;
  pickup?: PlaceSelectionInput | null;
  destination?: PlaceSelectionInput | null;
  manualPickupAddress?: string;
  manualDestinationAddress?: string;
  roadName?: string;
  kilometerSection?: string;
  drivingDirection?: string;
  placeType?: PlaceType | null;
  locationComplications?: string;
  accessComplications?: AccessComplication[];
  destinationNote?: string;
  incidentType?: IncidentType | null;
  incidentDescription?: string;
  participantsCount?: number | null;
  passengersCount?: number | null;
  damages?: string;
  damageAreas?: DamageArea[];
  damageNote?: string;
  replacementVehicleNeeded?: boolean;
  replacementVehicleType?: string;
  replacementVehiclePreferences?: ReplacementVehiclePreference[];
  replacementVehicleNote?: string;
  replacementVehicleCategory?: ReplacementVehicleCategory | null;
  replacementVehicleDeliveryPlace?: string;
  replacementVehicleEntitlement?: ReplacementVehicleEntitlement | null;
  replacementVehicleExtensionPossible?: boolean | null;
  replacementVehicleMaxDays?: number | null;
  replacementVehicleProvisionStatus?: ReplacementVehicleProvisionStatus | null;
  replacementVehicleProvisionReason?: string;
  attachmentMetadata?: CaseAttachmentInput[];
  paymentMethod?: PaymentMethod | null;
  paymentStatus?: PaymentStatus | null;
  closureType?: ClosureType | null;
  closureStatus?: string;
  insurancePortalUrl?: string;
  closureNote?: string;
  note?: string;
};

export type CaseInputWarningCode =
  | "incomplete_contact"
  | "invalid_phone"
  | "invalid_email"
  | "invalid_vin"
  | "invalid_year"
  | "invalid_location";

export type CaseInputWarning = {
  code: CaseInputWarningCode;
  field: string;
  message: string;
};

export type AssignCaseInput = {
  assetId: string;
  /** Explicitné potvrdenie priradenia auta, ktoré SWHouse hlási ako obsadené (occupancy:"occupied"). */
  allowOccupiedOverride?: boolean;
  /** Explicitné potvrdenie priradenia, keď SWHouse dostupnosť chýba alebo je neaktuálna. */
  allowUnverifiedOverride?: boolean;
};

export type CaseAttachmentInput = {
  id?: string;
  category: CaseAttachmentCategory;
  fileName: string;
  storageBucket?: string;
  storagePath?: string;
  mimeType?: string;
  sizeBytes?: number;
  note?: string;
  createdAt?: string;
};

export type CaseContactInput = {
  id?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  phone: string;
  phonePrefix?: string;
  phoneNational?: string;
  email?: string;
  role?: CustomerContactRole;
  note?: string;
  isPrimary?: boolean;
};

export type PartnerDirectoryInput = {
  kind: PartnerDirectoryKind;
  name: string;
  ico?: string;
  phone?: string;
  email?: string;
  note?: string;
  active?: boolean;
};

export type UpdateCaseInput = Partial<CreateCaseInput> & {
  /** `open` slúži na vrátenie omylom ukončeného/zrušeného prípadu späť do práce. */
  status?: "open" | "completed_assisted" | "completed_no_assistance" | "waiting_for_docs" | "cancelled" | "futile_trip";
};

export type CaseActionInput = {
  action:
    | "call_customer"
    | "send_sms"
    | "send_eta"
    | "create_pdf"
    | "mark_completed"
    | "invoice"
    | "close_case"
    | "add_note"
    | "create_task"
    | "update_task"
    | "delete_task"
    | "complete_task"
    | "callback_15"
    | "callback_30"
    | "callback_60";
  note?: string;
  taskId?: string;
  taskStatus?: "open" | "done" | "overdue";
  taskTitle?: string;
  taskDueAt?: string;
  taskKind?: CaseTaskKind;
  taskPriority?: CasePriority;
  taskReminderChannels?: TaskReminderChannel[];
  assignedTo?: string;
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  closureType?: ClosureType;
  closureStatus?: string;
};

export type CreateBranchInput = {
  name: string;
  phone: string;
  availableReplacementCars: number;
  location: PlaceSelectionInput;
};

export type CreateFleetAssetInput = {
  kind: FleetAssetKind;
  label: string;
  make?: string;
  model?: string;
  licensePlate: string;
  vin?: string;
  status: FleetAssetStatus;
  category?: FleetAssetCategory;
  weightKg?: number;
  branchId: string;
  location?: PlaceSelectionInput;
  notes?: string;
  insuranceValidUntil?: string;
  highwayVignetteValidUntil?: string;
  technicalInspectionValidUntil?: string;
  emissionInspectionValidUntil?: string;
  occupiedFrom?: string;
  occupiedUntil?: string;
  occupancyType?: FleetAssetOccupancyType;
  occupancyCaseId?: string;
  occupancyNote?: string;
  assignedDriverName?: string;
  assignedDriverPhone?: string;
  assignedDriverStatus?: FleetDriverStatus;
  towCategory?: TowTruckCategory;
  capabilities?: TowCapability[];
};

export type UpdateFleetAssetInput = Partial<Omit<CreateFleetAssetInput, "location">> & {
  location?: PlaceSelectionInput | null;
};

export function isValidPlaceSelection(value: unknown): value is PlaceSelectionInput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as PlaceSelectionInput;
  return (
    nonEmpty(candidate.label) &&
    nonEmpty(candidate.address) &&
    typeof candidate.lat === "number" &&
    Number.isFinite(candidate.lat) &&
    typeof candidate.lng === "number" &&
    Number.isFinite(candidate.lng)
  );
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Draft cards are always saveable. These warnings describe values that cannot
 * yet be used by downstream actions (calling, SMS, vehicle lookup or routing),
 * but deliberately do not act as mutation validation errors.
 */
export function collectCaseInputWarnings(input: CreateCaseInput): CaseInputWarning[] {
  const warnings: CaseInputWarning[] = [];

  appendIncompleteContactWarning(warnings, "contact", input.contactName, input.contactPhone, input.contactEmail);
  appendContactWarnings(warnings, "contactPhone", "contactEmail", input.contactPhone, input.contactEmail);

  input.contacts?.forEach((contact, index) => {
    const name = contact.name ?? [contact.firstName, contact.lastName].filter(Boolean).join(" ");
    appendIncompleteContactWarning(warnings, `contacts.${index}`, name, contact.phone, contact.email, contact.note);
    appendContactWarnings(warnings, `contacts.${index}.phone`, `contacts.${index}.email`, contact.phone, contact.email);
  });

  if (nonEmpty(input.vin) && input.vin.trim().length !== 17) {
    warnings.push({ code: "invalid_vin", field: "vin", message: "VIN má mať 17 znakov." });
  }

  if (input.productionYear !== undefined && input.productionYear !== null) {
    const year = Number(input.productionYear);
    if (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1) {
      warnings.push({ code: "invalid_year", field: "productionYear", message: "Rok výroby je mimo povoleného rozsahu." });
    }
  }

  if (input.pickup !== undefined && input.pickup !== null && !isValidPlaceSelection(input.pickup)) {
    warnings.push({ code: "invalid_location", field: "pickup", message: "Miesto incidentu ešte nemá použiteľnú adresu a súradnice." });
  }

  if (input.destination !== undefined && input.destination !== null && !isValidPlaceSelection(input.destination)) {
    warnings.push({ code: "invalid_location", field: "destination", message: "Cieľ ešte nemá použiteľnú adresu a súradnice." });
  }

  return warnings;
}

function appendIncompleteContactWarning(
  warnings: CaseInputWarning[],
  field: string,
  name: string | undefined,
  phone: string | undefined,
  email: string | undefined,
  note?: string,
) {
  const hasAnyValue = [name, phone, email, note].some(nonEmpty);
  if (!hasAnyValue || (nonEmpty(name) && nonEmpty(phone))) {
    return;
  }

  warnings.push({
    code: "incomplete_contact",
    field,
    message: "Kontakt je uložený ako rozpracovaný; pre volanie doplňte meno a telefón.",
  });
}

function appendContactWarnings(
  warnings: CaseInputWarning[],
  phoneField: string,
  emailField: string,
  phone: string | undefined,
  email: string | undefined,
) {
  if (nonEmpty(phone) && phone.replace(/\D/g, "").length < 6) {
    warnings.push({ code: "invalid_phone", field: phoneField, message: "Telefón má obsahovať aspoň 6 číslic." });
  }

  if (nonEmpty(email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    warnings.push({ code: "invalid_email", field: emailField, message: "Email nemá správny formát." });
  }
}
