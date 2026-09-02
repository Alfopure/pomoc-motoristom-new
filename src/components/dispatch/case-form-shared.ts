import type {
  AccessComplication,
  CaseAttachmentCategory,
  ClientVehicleType,
  CustomerContactRole,
  CustomerType,
  DamageArea,
  IncidentType,
  JobType,
  PaymentMethod,
  PaymentStatus,
  PartnerDirectoryKind,
  PlaceType,
  ReplacementVehicleCategory,
  ReplacementVehicleEntitlement,
  ReplacementVehiclePreference,
  VehicleConditionFlag,
  VehicleTransmission,
} from "@/domain/types";
import {
  accessComplicationLabels,
  clientVehicleTypeLabels,
  customerContactRoleLabels,
  customerTypeLabels,
  damageAreaLabels,
  incidentTypeLabels,
  isReplacementVehicleOnlyCase,
  jobTypeLabels,
  paymentMethodLabels,
  paymentStatusLabels,
  partnerDirectoryKindLabels,
  placeTypeLabels,
  replacementCategoryLabels,
  replacementEntitlementLabels,
  replacementPreferenceLabels,
  requiresTowDestination,
  transmissionLabels,
  vehicleConditionFlagLabels,
} from "@/domain/case-card";

export const jobTypes = Object.keys(jobTypeLabels) as JobType[];
export const vehicleTypes = Object.keys(clientVehicleTypeLabels) as ClientVehicleType[];
export const transmissions = Object.keys(transmissionLabels) as VehicleTransmission[];
export const customerTypes = Object.keys(customerTypeLabels) as CustomerType[];
export const customerContactRoles = Object.keys(customerContactRoleLabels) as CustomerContactRole[];
export const partnerDirectoryKinds = Object.keys(partnerDirectoryKindLabels) as PartnerDirectoryKind[];
export const conditionFlags = (Object.keys(vehicleConditionFlagLabels) as VehicleConditionFlag[]).filter(
  (flag) => flag !== "driveable" && flag !== "immobile",
);
export const incidentTypes = Object.keys(incidentTypeLabels) as IncidentType[];
export const damageAreas = Object.keys(damageAreaLabels) as DamageArea[];
export const placeTypes = Object.keys(placeTypeLabels) as PlaceType[];
export const accessComplications = Object.keys(accessComplicationLabels) as AccessComplication[];
export const replacementPreferences = Object.keys(replacementPreferenceLabels) as ReplacementVehiclePreference[];
export const replacementCategories = Object.keys(replacementCategoryLabels) as ReplacementVehicleCategory[];
export const replacementEntitlements = Object.keys(replacementEntitlementLabels) as ReplacementVehicleEntitlement[];
export const paymentMethods = Object.keys(paymentMethodLabels) as PaymentMethod[];
export const paymentStatuses = Object.keys(paymentStatusLabels) as PaymentStatus[];
export const attachmentCategories: CaseAttachmentCategory[] = ["photo", "video", "document"];

export const attachmentCategoryLabels: Record<CaseAttachmentCategory, string> = {
  photo: "Fotka",
  video: "Video",
  document: "Dokument",
};

export function normalizeVehicleConditionFlags(flags: VehicleConditionFlag[], driveable: boolean): VehicleConditionFlag[] {
  const uniqueFlags = Array.from(new Set(flags));
  const withoutContradiction = uniqueFlags.filter((flag) => flag !== (driveable ? "immobile" : "driveable"));
  const requiredFlag = driveable ? "driveable" : "immobile";

  return withoutContradiction.includes(requiredFlag) ? withoutContradiction : [requiredFlag, ...withoutContradiction];
}

export type CaseFormCompletionInput = {
  assistanceReference?: string;
  assistanceServiceName?: string;
  companyIdNumber?: string;
  companyName?: string;
  contactName?: string;
  contactPhone?: string;
  customerType?: CustomerType | "";
  destinationSelected?: boolean;
  incidentType?: IncidentType | "";
  jobTypes?: JobType[];
  licensePlate?: string;
  needsDestination?: boolean;
  paymentMethod?: PaymentMethod | "";
  paymentStatus?: PaymentStatus | "";
  pickupSelected?: boolean;
  replacementVehicleDeliveryPlace?: string;
  replacementVehicleNeeded?: boolean | null;
  replacementVehicleType?: string;
  sourceType?: string;
  vehicleDriveable?: boolean | null;
  vehicleIssue?: string;
};

export type CaseFormValidationInput = CaseFormCompletionInput & {
  additionalContacts?: Array<{ email?: string; name?: string; phone?: string }>;
  attachmentError?: string | null;
  companyIdNumber?: string;
  contactEmail?: string;
  insurancePortalUrl?: string;
  kilometerSection?: string;
  participantsCount?: string | number;
  passengersCount?: string | number;
  productionYear?: string | number;
  requireCoreFields?: boolean;
  vin?: string;
  weightKg?: string | number;
};

export type CaseFormFieldErrors = Partial<
  Record<
    | "companyIdNumber"
    | "contactName"
    | "contactPhone"
    | "contactEmail"
    | "destination"
    | "insurancePortalUrl"
    | "jobTypes"
    | "kilometerSection"
    | "licensePlate"
    | "participantsCount"
    | "passengersCount"
    | "productionYear"
    | "vehicleIssue"
    | "vin"
    | "weightKg",
    string
  >
>;

export function getCaseFormFieldErrors(input: CaseFormValidationInput): CaseFormFieldErrors {
  const errors: CaseFormFieldErrors = {};
  // Pri čisto NV prípade sú údaje o klientovom vozidle voliteľné (P-03); kontakt ostáva povinný.
  const replacementOnly = isReplacementVehicleOnlyCase(input.jobTypes);
  const requireCoreFields = input.requireCoreFields ?? false;
  const phoneDigits = (input.contactPhone ?? "").replace(/\D/g, "");
  const plate = input.licensePlate?.trim() ?? "";
  const normalizedVin = input.vin?.trim().toLocaleUpperCase("sk-SK") ?? "";
  const year =
    typeof input.productionYear === "number" ? input.productionYear : input.productionYear?.trim() ? Number(input.productionYear) : undefined;

  if (requireCoreFields && !input.contactName?.trim()) errors.contactName = "Meno zákazníka je povinné.";
  if (requireCoreFields && !input.contactPhone?.trim()) errors.contactPhone = "Telefón zákazníka je povinný.";
  if (input.contactPhone?.trim() && (phoneDigits.length < 9 || phoneDigits.length > 15)) {
    errors.contactPhone = "Telefón musí obsahovať 9 až 15 číslic vrátane predvoľby.";
  }
  const contactEmailError = getEmailValidationError(input.contactEmail);
  if (contactEmailError) errors.contactEmail = contactEmailError;
  if (requireCoreFields && !replacementOnly && !input.licensePlate?.trim()) errors.licensePlate = "EČV je povinné.";
  if (plate && (!/^[\p{L}\p{N} -]+$/u.test(plate) || plate.length > 16)) {
    errors.licensePlate = "EČV môže obsahovať iba písmená, čísla, medzeru a pomlčku.";
  }
  if (normalizedVin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(normalizedVin)) {
    errors.vin = "VIN musí mať 17 znakov a nesmie obsahovať I, O ani Q.";
  }
  if (year !== undefined && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1)) {
    errors.productionYear = "Rok výroby musí byť medzi 1950 a budúcim rokom.";
  }
  validateOptionalInteger(input.weightKg, "Hmotnosť", 1, 100_000, (message) => { errors.weightKg = message; });
  validateOptionalInteger(input.participantsCount, "Počet účastníkov", 0, 99, (message) => { errors.participantsCount = message; });
  validateOptionalInteger(input.passengersCount, "Počet pasažierov", 0, 99, (message) => { errors.passengersCount = message; });
  validateOptionalDecimal(input.kilometerSection, "Kilometrový úsek", 0, 9_999, (message) => { errors.kilometerSection = message; });
  if (input.companyIdNumber?.trim() && !/^\d{8}$/.test(input.companyIdNumber.trim())) {
    errors.companyIdNumber = "IČO musí obsahovať presne 8 číslic.";
  }
  if (input.insurancePortalUrl?.trim() && !isValidHttpUrl(input.insurancePortalUrl)) {
    errors.insurancePortalUrl = "Portál musí byť platná adresa začínajúca http:// alebo https://.";
  }
  if (requireCoreFields && !replacementOnly && !input.vehicleIssue?.trim()) errors.vehicleIssue = "Typ problému je povinný.";
  if (requireCoreFields && !input.jobTypes?.length) errors.jobTypes = "Vyber aspoň jeden typ zákazky.";
  if (requireCoreFields && requiresTowDestination(input.jobTypes) && !input.destinationSelected) {
    errors.destination = "Cieľ odťahu je povinný pre odťah alebo vyslobodenie MV.";
  }

  return errors;
}

export function validateCaseFormBasics(input: CaseFormValidationInput) {
  return Object.values(getCaseFormFieldErrors(input));
}

export function getCaseFormCompletionErrors(input: CaseFormCompletionInput) {
  // Čisto NV prípad má špecializovaný formulár: údaje o klientovom vozidle a
  // odťahové polia sú voliteľné (P-03/P-04); vyžaduje sa miesto pristavenia.
  const replacementOnly = isReplacementVehicleOnlyCase(input.jobTypes);

  return [
    !input.jobTypes?.length ? "Vyberte aspoň jeden typ zákazky." : null,
    !input.sourceType ? "Vyberte zdroj prípadu." : null,
    !input.customerType ? "Vyberte typ zákazníka." : null,
    !input.contactName?.trim() ? "Doplňte meno zákazníka." : null,
    !input.contactPhone?.trim() ? "Doplňte telefón zákazníka." : null,
    input.customerType === "insurance" && !input.assistanceServiceName?.trim() ? "Doplňte asistenčnú službu." : null,
    input.customerType === "insurance" && !input.assistanceReference?.trim() ? "Doplňte číslo prípadu asistenčnej služby." : null,
    input.customerType === "company" && !input.companyName?.trim() ? "Doplňte názov firmy." : null,
    input.customerType === "company" && !input.companyIdNumber?.trim() ? "Doplňte IČO firmy." : null,
    !replacementOnly && !input.licensePlate?.trim() ? "Doplňte EČV vozidla." : null,
    !replacementOnly && !input.vehicleIssue?.trim() ? "Doplňte opis problému alebo situácie." : null,
    !replacementOnly && (input.vehicleDriveable === null || input.vehicleDriveable === undefined) ? "Určite, či je vozidlo pojazdné." : null,
    !replacementOnly && !input.incidentType ? "Vyberte typ incidentu." : null,
    !replacementOnly && !input.pickupSelected ? "Vyberte miesto incidentu." : null,
    replacementOnly && !input.replacementVehicleDeliveryPlace?.trim() ? "Doplňte miesto pristavenia náhradného vozidla." : null,
    input.needsDestination && !input.destinationSelected ? "Vyberte cieľ odťahu." : null,
    input.replacementVehicleNeeded === null || input.replacementVehicleNeeded === undefined
      ? "Určite, či zákazník potrebuje náhradné vozidlo."
      : null,
    input.replacementVehicleNeeded === true && !input.replacementVehicleType?.trim()
      ? "Doplňte požadovaný typ náhradného vozidla."
      : null,
    !input.paymentMethod ? "Vyberte spôsob platby." : null,
    !input.paymentStatus ? "Vyberte stav platby." : null,
  ].filter((message): message is string => Boolean(message));
}

export type CaseFormSectionKey = "basic" | "customer" | "vehicle" | "location" | "extras";

export type CaseFormValidationResult = {
  errors: string[];
  fieldErrors: CaseFormFieldErrors;
  sectionErrors: Record<CaseFormSectionKey, string[]>;
  sectionValid: Record<CaseFormSectionKey, boolean>;
  valid: boolean;
};

export function getCaseFormValidation(input: CaseFormValidationInput): CaseFormValidationResult {
  const fieldErrors = getCaseFormFieldErrors(input);
  const replacementOnly = isReplacementVehicleOnlyCase(input.jobTypes);
  const sectionErrors: Record<CaseFormSectionKey, string[]> = {
    basic: compactErrors([
      !input.jobTypes?.length ? "Vyberte aspoň jeden typ zákazky." : null,
      !input.sourceType ? "Vyberte zdroj prípadu." : null,
      fieldErrors.jobTypes,
    ]),
    customer: compactErrors([
      !input.customerType ? "Vyberte typ zákazníka." : null,
      !input.contactName?.trim() ? "Doplňte meno zákazníka." : null,
      !input.contactPhone?.trim() ? "Doplňte telefón zákazníka." : null,
      input.customerType === "insurance" && !input.assistanceServiceName?.trim() ? "Doplňte asistenčnú službu." : null,
      input.customerType === "insurance" && !input.assistanceReference?.trim() ? "Doplňte číslo prípadu asistenčnej služby." : null,
      input.customerType === "company" && !input.companyName?.trim() ? "Doplňte názov firmy." : null,
      input.customerType === "company" && !input.companyIdNumber?.trim() ? "Doplňte IČO firmy." : null,
      fieldErrors.contactName,
      fieldErrors.contactPhone,
      fieldErrors.contactEmail,
      fieldErrors.companyIdNumber,
      ...(input.additionalContacts ?? []).flatMap((contact, index) => {
        const contactNumber = index + 2;
        const digits = (contact.phone ?? "").replace(/\D/g, "");
        return compactErrors([
          !contact.name?.trim() ? `${contactNumber}. kontakt: doplňte meno.` : null,
          !contact.phone?.trim() ? `${contactNumber}. kontakt: doplňte telefón.` : null,
          contact.phone?.trim() && (digits.length < 9 || digits.length > 15)
            ? `${contactNumber}. kontakt: telefón musí obsahovať 9 až 15 číslic.`
            : null,
          getEmailValidationError(contact.email)
            ? `${contactNumber}. kontakt: email nemá správny formát.`
            : null,
        ]);
      }),
    ]),
    vehicle: compactErrors([
      !replacementOnly && !input.licensePlate?.trim() ? "Doplňte EČV vozidla." : null,
      !replacementOnly && !input.vehicleIssue?.trim() ? "Doplňte opis problému alebo situácie." : null,
      !replacementOnly && (input.vehicleDriveable === null || input.vehicleDriveable === undefined) ? "Určite, či je vozidlo pojazdné." : null,
      !replacementOnly && !input.incidentType ? "Vyberte typ incidentu." : null,
      fieldErrors.licensePlate,
      fieldErrors.vin,
      fieldErrors.productionYear,
      fieldErrors.weightKg,
      fieldErrors.participantsCount,
      fieldErrors.passengersCount,
      fieldErrors.vehicleIssue,
    ]),
    location: compactErrors([
      !replacementOnly && !input.pickupSelected ? "Vyberte miesto incidentu." : null,
      input.needsDestination && !input.destinationSelected ? "Vyberte cieľ odťahu." : null,
      fieldErrors.destination,
      fieldErrors.kilometerSection,
    ]),
    extras: compactErrors([
      input.replacementVehicleNeeded === null || input.replacementVehicleNeeded === undefined
        ? "Určite, či zákazník potrebuje náhradné vozidlo."
        : null,
      input.replacementVehicleNeeded === true && !input.replacementVehicleType?.trim()
        ? "Doplňte požadovaný typ náhradného vozidla."
        : null,
      replacementOnly && !input.replacementVehicleDeliveryPlace?.trim()
        ? "Doplňte miesto pristavenia náhradného vozidla."
        : null,
      !input.paymentMethod ? "Vyberte spôsob platby." : null,
      !input.paymentStatus ? "Vyberte stav platby." : null,
      fieldErrors.insurancePortalUrl,
      input.attachmentError,
    ]),
  };
  const errors = Array.from(new Set(Object.values(sectionErrors).flat()));
  const sectionValid = Object.fromEntries(
    Object.entries(sectionErrors).map(([key, messages]) => [key, messages.length === 0]),
  ) as Record<CaseFormSectionKey, boolean>;

  return {
    errors,
    fieldErrors,
    sectionErrors,
    sectionValid,
    valid: errors.length === 0,
  };
}

export function digitsOnly(value: string, maxLength?: number) {
  const digits = value.replace(/\D/g, "");
  return maxLength ? digits.slice(0, maxLength) : digits;
}

export function decimalOnly(value: string, maxIntegerDigits = 4) {
  const normalized = value.replace(",", ".").replace(/[^\d.]/g, "");
  const [integer = "", ...decimalParts] = normalized.split(".");
  const decimal = decimalParts.join("").slice(0, 2);
  const boundedInteger = integer.slice(0, maxIntegerDigits);
  return decimalParts.length > 0 ? `${boundedInteger}.${decimal}` : boundedInteger;
}

export function normalizeLicensePlateInput(value: string) {
  return value.toLocaleUpperCase("sk-SK").replace(/[^\p{L}\p{N} -]/gu, "").slice(0, 16);
}

export function normalizeVinInput(value: string) {
  return value.toLocaleUpperCase("sk-SK").replace(/[^A-HJ-NPR-Z0-9]/g, "").slice(0, 17);
}

function compactErrors(messages: Array<string | null | undefined>) {
  return Array.from(new Set(messages.filter((message): message is string => Boolean(message))));
}

export function getEmailValidationError(value?: string) {
  if (!value?.trim()) {
    return undefined;
  }

  return isValidEmail(value) ? undefined : "Email nemá správny formát.";
}

function isValidEmail(value: string) {
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function isValidHttpUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function validateOptionalInteger(
  value: string | number | undefined,
  label: string,
  minimum: number,
  maximum: number,
  setError: (message: string) => void,
) {
  if (value === undefined || value === "" || (typeof value === "string" && !value.trim())) return;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    setError(`${label} musí byť celé číslo od ${minimum} do ${maximum}.`);
  }
}

function validateOptionalDecimal(
  value: string | number | undefined,
  label: string,
  minimum: number,
  maximum: number,
  setError: (message: string) => void,
) {
  if (value === undefined || value === "" || (typeof value === "string" && !value.trim())) return;
  const number = Number(typeof value === "string" ? value.replace(",", ".") : value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    setError(`${label} musí byť číslo od ${minimum} do ${maximum}.`);
  }
}

export { customerContactRoleLabels, isReplacementVehicleOnlyCase, partnerDirectoryKindLabels, requiresTowDestination };
