"use client";

import { VehicleLookupControl } from "./VehicleLookupControl";
import { resolveInternalVehicle, type VehicleLookupSnapshot } from "@/lib/vehicle-lookup";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, FileUp, GripVertical, Loader2, Plus, Save, Star, Trash2, X } from "lucide-react";
import type { CaseContactInput, CreateCaseInput, PlaceSelectionInput } from "@/data/case-inputs";
import type { CommanderVehicleConnection, DispatchData } from "@/data/dispatch-types";
import type {
  AccessComplication,
  CasePriority,
  ClientVehicleType,
  ClosureType,
  CustomerContactRole,
  CustomerType,
  DamageArea,
  DispatchCall,
  IncidentType,
  JobType,
  PartnerDirectoryEntry,
  PaymentMethod,
  PaymentStatus,
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
  jobTypeLabels,
  paymentMethodLabels,
  paymentStatusLabels,
  placeTypeLabels,
  replacementCategoryLabels,
  replacementEntitlementLabels,
  replacementPreferenceLabels,
  transmissionLabels,
  vehicleConditionFlagLabels,
} from "@/domain/case-card";
import { casePriorities, casePriorityLabels } from "@/domain/statuses";
import {
  accessComplications,
  conditionFlags,
  customerContactRoles,
  customerTypes,
  type CaseFormFieldErrors,
  damageAreas,
  decimalOnly,
  digitsOnly,
  getCaseFormValidation,
  getEmailValidationError,
  incidentTypes,
  jobTypes,
  normalizeVehicleConditionFlags,
  paymentMethods,
  paymentStatuses,
  placeTypes,
  isReplacementVehicleOnlyCase,
  replacementCategories,
  replacementEntitlements,
  replacementPreferences,
  requiresTowDestination,
  transmissions,
  vehicleTypes,
} from "./case-form-shared";
import {
  CheckboxGroup,
  type ContactDraft,
  FormSection,
  IconButton,
  joinContactPhone,
  PhoneField,
  RequiredMark,
  SelectField,
  TextareaField,
  TextField,
  splitContactPhone,
} from "./case-form-fields";
import { GooglePlaceAutocomplete } from "./GooglePlaceAutocomplete";
import { LocationPicker } from "./LocationPicker";

type NewCaseFormProps = {
  call: DispatchCall;
  onClose: () => void;
  onCreated: (dispatchData: DispatchData, caseId: string, notice?: string) => void;
  partnerDirectory: PartnerDirectoryEntry[];
  commanderVehicles?: CommanderVehicleConnection[];
  onDirtyChange?: (dirty: boolean) => void;
  onSaveDraftChange?: (saveDraft: SaveCaseDraft | null) => void;
  onSavingChange?: (saving: boolean) => void;
};

export type SaveCaseDraft = () => Promise<boolean>;

type NewCaseDrawerProps = NewCaseFormProps & {
  open: boolean;
};

type ApiMutationResponse = {
  caseId?: string;
  dispatchData?: DispatchData;
  error?: string;
  warnings?: Array<{ message: string }>;
};

const driveTypeOptions = [
  ["front", "Predný"],
  ["rear", "Zadný"],
  ["4x4", "4x4"],
  ["unknown", "Nezistené"],
] as const;

const maxAttachmentBytes = 10 * 1024 * 1024;
const allowedAttachmentTypes = new Set([
  "image/jpeg",
  "image/png",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export function NewCaseForm({ call, commanderVehicles = [], onClose, onCreated, onDirtyChange, onSaveDraftChange, onSavingChange, partnerDirectory }: NewCaseFormProps) {
  // Predvyplň kontakt IBA z reálneho aktívneho hovoru. Bez neho (generická nová karta,
  // idle/mock hovor) štartuje formulár čistý — žiadne prenesené meno/číslo.
  const hasActiveCall = Boolean(call.callerNumber) && call.callerNumber !== "Bez aktívneho hovoru";
  const initialName = splitName(hasActiveCall ? call.callerName ?? "" : "");
  const initialPhone = parsePhone(hasActiveCall ? call.callerNumber : "");
  const [contacts, setContacts] = useState<ContactDraft[]>([
    {
      id: crypto.randomUUID(),
      firstName: initialName.firstName,
      lastName: initialName.lastName,
      phonePrefix: initialPhone.prefix,
      phoneNational: initialPhone.national,
      email: "",
      role: "primary_customer",
      note: "",
      isPrimary: true,
    },
  ]);
  const [customerType, setCustomerType] = useState<CustomerType | "">("private_person");
  const [companyName, setCompanyName] = useState("");
  const [companyIdNumber, setCompanyIdNumber] = useState("");
  const [assistanceServiceName, setAssistanceServiceName] = useState("");
  const [assistanceReference, setAssistanceReference] = useState("");
  const [partnerDirectoryId, setPartnerDirectoryId] = useState("");
  const [directoryEntries, setDirectoryEntries] = useState(partnerDirectory);
  const [directorySaving, setDirectorySaving] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryNotice, setDirectoryNotice] = useState<string | null>(null);
  const [customerNote, setCustomerNote] = useState("");
  const [licensePlate, setLicensePlate] = useState("");
  const [vin, setVin] = useState("");
  const [vehicleLookup, setVehicleLookup] = useState<VehicleLookupSnapshot | null>(null);
  const [vehicleMake, setVehicleMake] = useState("");
  const [vehicleModel, setVehicleModel] = useState("");
  const [productionYear, setProductionYear] = useState("");
  const [vehicleColor, setVehicleColor] = useState("");
  const [vehicleCategory, setVehicleCategory] = useState("");
  const [vehicleType, setVehicleType] = useState<ClientVehicleType | "">("");
  const [transmission, setTransmission] = useState<VehicleTransmission | "">("");
  const [transmissionNote, setTransmissionNote] = useState("");
  const [driveType, setDriveType] = useState("unknown");
  const [weightKg, setWeightKg] = useState("");
  const [vehicleIssue, setVehicleIssue] = useState("");
  const [vehicleDriveable, setVehicleDriveable] = useState<boolean | null>(null);
  const [vehicleFlags, setVehicleFlags] = useState<VehicleConditionFlag[]>([]);
  const [vehicleNote, setVehicleNote] = useState("");
  const [selectedJobTypes, setSelectedJobTypes] = useState<JobType[]>([]);
  const [priority, setPriority] = useState<CasePriority>("normal");
  const [sourceType, setSourceType] = useState<NonNullable<CreateCaseInput["sourceType"]> | "">("");
  const [incidentType, setIncidentType] = useState<IncidentType | "">("");
  const [participantsCount, setParticipantsCount] = useState("");
  const [passengersCount, setPassengersCount] = useState("");
  const [selectedDamageAreas, setSelectedDamageAreas] = useState<DamageArea[]>([]);
  const [damageNote, setDamageNote] = useState("");
  const [pickup, setPickup] = useState<PlaceSelectionInput | null>(null);
  const [destination, setDestination] = useState<PlaceSelectionInput | null>(null);
  const [manualPickupAddress, setManualPickupAddress] = useState("");
  const [manualDestinationAddress, setManualDestinationAddress] = useState("");
  const [roadName, setRoadName] = useState("");
  const [kilometerSection, setKilometerSection] = useState("");
  const [drivingDirection, setDrivingDirection] = useState("");
  const [placeType, setPlaceType] = useState<PlaceType | "">("");
  const [locationComplications, setLocationComplications] = useState("");
  const [selectedAccessComplications, setSelectedAccessComplications] = useState<AccessComplication[]>([]);
  const [destinationNote, setDestinationNote] = useState("");
  const [replacementVehicleNeeded, setReplacementVehicleNeeded] = useState<boolean | null>(false);
  const [replacementVehicleType, setReplacementVehicleType] = useState("");
  const [selectedReplacementPreferences, setSelectedReplacementPreferences] = useState<ReplacementVehiclePreference[]>([]);
  const [replacementVehicleNote, setReplacementVehicleNote] = useState("");
  const [replacementCategory, setReplacementCategory] = useState<"" | ReplacementVehicleCategory>("");
  const [replacementDeliveryPlace, setReplacementDeliveryPlace] = useState("");
  const [replacementEntitlement, setReplacementEntitlement] = useState<"" | ReplacementVehicleEntitlement>("");
  const [replacementExtension, setReplacementExtension] = useState<"" | "yes" | "no">("");
  const [replacementMaxDays, setReplacementMaxDays] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachmentNote, setAttachmentNote] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | "">("");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus | "">("");
  const [closureType, setClosureType] = useState<ClosureType | "">("");
  const [closureStatus, setClosureStatus] = useState("");
  const [insurancePortalUrl, setInsurancePortalUrl] = useState("");
  const [closureNote, setClosureNote] = useState("");
  const [note, setNote] = useState("");
  const [draggedContactId, setDraggedContactId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [commanderNotice, setCommanderNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsDestination = requiresTowDestination(selectedJobTypes);
  // Čisto NV prípad používa špecializovaný formulár bez odťahových polí (P-03/P-04).
  const replacementOnly = isReplacementVehicleOnlyCase(selectedJobTypes);
  const primaryContact = contacts.find((contact) => contact.isPrimary) ?? contacts[0];
  const contactName = contactDisplayName(primaryContact);
  const contactPhone = fullPhone(primaryContact);
  const contactEmail = primaryContact?.email ?? "";
  const caseType = caseTypeFromJobTypes(selectedJobTypes);
  const directoryOptions = directoryEntries.filter((entry) =>
    customerType === "insurance" ? entry.kind === "assistance" && entry.active : customerType === "company" ? entry.kind === "company" && entry.active : false,
  );
  const existingAssistanceEntry = directoryEntries.find(
    (entry) => entry.kind === "assistance" && entry.active && entry.name.trim().toLocaleLowerCase("sk-SK") === assistanceServiceName.trim().toLocaleLowerCase("sk-SK"),
  );
  const attachmentValidationError = validateAttachmentFiles(pendingFiles);
  const formValidation = getCaseFormValidation({
    additionalContacts: contacts
      .filter((contact) => contact.id !== primaryContact?.id)
      .map((contact) => ({
        email: contact.email,
        name: contactDisplayName(contact),
        phone: fullPhone(contact),
      })),
    assistanceReference,
    assistanceServiceName,
    attachmentError: attachmentValidationError,
    companyIdNumber,
    companyName,
    contactName,
    contactPhone,
    contactEmail,
    customerType,
    destinationSelected: Boolean(destination) || manualDestinationAddress.trim().length >= 3,
    incidentType,
    insurancePortalUrl,
    jobTypes: selectedJobTypes,
    kilometerSection,
    licensePlate,
    needsDestination,
    participantsCount,
    passengersCount,
    paymentMethod,
    paymentStatus,
    pickupSelected: Boolean(pickup) || manualPickupAddress.trim().length >= 3,
    productionYear,
    replacementVehicleDeliveryPlace: replacementDeliveryPlace,
    replacementVehicleNeeded,
    replacementVehicleType,
    sourceType,
    vehicleDriveable,
    vehicleIssue,
    requireCoreFields: false,
    vin,
    weightKg,
  });
  const fieldErrors = formValidation.fieldErrors;
  const validationErrors = [
    ...Object.values(fieldErrors),
    ...(attachmentValidationError ? [attachmentValidationError] : []),
  ];
  const missingRequiredFields = formValidation.errors.filter((message) => !validationErrors.includes(message));
  const formReady = formValidation.valid;
  const canSubmit = !isSaving;
  const hasVehicleInput = Boolean(
    licensePlate.trim() ||
      vin.trim() ||
      vehicleMake.trim() ||
      vehicleModel.trim() ||
      vehicleCategory.trim() ||
      vehicleIssue.trim() ||
      productionYear.trim() ||
      vehicleColor.trim() ||
      transmission ||
      driveType !== "unknown" ||
      weightKg.trim() ||
      vehicleFlags.length > 0 ||
      vehicleNote.trim(),
  );

  const contactInputs = useMemo<CaseContactInput[]>(
    () =>
      contacts
        .map((contact) => ({
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          name: contactDisplayName(contact),
          phone: fullPhone(contact),
          phonePrefix: contact.phonePrefix,
          phoneNational: contact.phoneNational,
          email: contact.email,
          role: contact.role,
          note: contact.note,
          isPrimary: contact.isPrimary,
        }))
        .filter((contact) => Boolean(contact.name.trim() || contact.phone.trim() || contact.email?.trim())),
    [contacts],
  );

  useEffect(() => {
    onDirtyChange?.(isDirty);
    if (!isDirty) return;

    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [isDirty, onDirtyChange]);

  const submitCaseRef = useRef<SaveCaseDraft>(() => Promise.resolve(false));

  useEffect(() => {
    submitCaseRef.current = submitCase;
  });

  useEffect(() => {
    const saveDraft = () => submitCaseRef.current();
    onSaveDraftChange?.(saveDraft);
    return () => onSaveDraftChange?.(null);
  }, [onSaveDraftChange]);

  useEffect(() => {
    onSavingChange?.(isSaving);
    return () => onSavingChange?.(false);
  }, [isSaving, onSavingChange]);

  function markDirty() {
    setIsDirty(true);
  }

  function closeForm() {
    onClose();
  }

  function prefillFromCommander() {
    const normalizedPlate = normalizePlate(licensePlate);
    if (!normalizedPlate) return;
    const vehicle = resolveInternalVehicle(commanderVehicles, licensePlate, vin);
    if (!vehicle) return;

    if (!vehicleMake.trim() && vehicle.make) setVehicleMake(vehicle.make);
    if (!vehicleModel.trim() && vehicle.model) setVehicleModel(vehicle.model);
    if (!vin.trim() && vehicle.vin) setVin(vehicle.vin);
    setCommanderNotice(`Údaje predvyplnené z Commandera pre ${vehicle.licensePlate ?? licensePlate}.`);
  }

  function setDriveable(nextDriveable: boolean) {
    markDirty();
    setVehicleDriveable(nextDriveable);
    setVehicleFlags((current) => normalizeVehicleConditionFlags(current, nextDriveable));
  }

  function selectCustomerType(type: CustomerType) {
    markDirty();
    setCustomerType(type);
    setPartnerDirectoryId("");
    setDirectoryError(null);
    setDirectoryNotice(null);

    if (type === "insurance") {
      setSourceType("assistance");
      setPaymentMethod("insurance");
      setPaymentStatus("waiting_for_insurance");
      return;
    }

    if (type === "company") {
      setSourceType("partner");
      setPaymentMethod("invoice");
      setPaymentStatus("unpaid");
      return;
    }

    setSourceType("client");
    setPaymentMethod("cash");
    setPaymentStatus("unpaid");
  }

  function selectDirectoryEntry(entryId: string) {
    markDirty();
    setPartnerDirectoryId(entryId);
    setDirectoryError(null);
    setDirectoryNotice(null);
    const entry = directoryEntries.find((candidate) => candidate.id === entryId);

    if (!entry) {
      return;
    }

    if (entry.kind === "assistance") {
      setAssistanceServiceName(entry.name);
      setSourceType("assistance");
      setPaymentMethod("insurance");
      setPaymentStatus("waiting_for_insurance");
    } else {
      setCompanyName(entry.name);
      setCompanyIdNumber(entry.ico ?? "");
      setSourceType("partner");
    }
  }

  function changeAssistanceServiceName(value: string) {
    setAssistanceServiceName(value);
    setDirectoryError(null);
    setDirectoryNotice(null);

    const selectedEntry = directoryEntries.find((entry) => entry.id === partnerDirectoryId);
    if (selectedEntry?.name.trim().toLocaleLowerCase("sk-SK") !== value.trim().toLocaleLowerCase("sk-SK")) {
      setPartnerDirectoryId("");
    }
  }

  async function quickAddAssistanceService() {
    const name = assistanceServiceName.trim();
    if (!name || directorySaving || existingAssistanceEntry) {
      if (existingAssistanceEntry) {
        setPartnerDirectoryId(existingAssistanceEntry.id);
      }
      return;
    }

    setDirectorySaving(true);
    setDirectoryError(null);
    setDirectoryNotice(null);

    try {
      const response = await fetch("/api/partner-directory/assistance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Asistenčnú službu sa nepodarilo pridať do adresára.");
      }

      const nextEntries = result.dispatchData.partnerDirectory;
      const savedEntry = nextEntries.find(
        (entry) => entry.kind === "assistance" && entry.name.trim().toLocaleLowerCase("sk-SK") === name.toLocaleLowerCase("sk-SK"),
      );
      setDirectoryEntries(nextEntries);
      setPartnerDirectoryId(savedEntry?.id ?? "");
      setDirectoryNotice("Uložené do adresára.");
    } catch (caught) {
      setDirectoryError(caught instanceof Error ? caught.message : "Asistenčnú službu sa nepodarilo pridať do adresára.");
    } finally {
      setDirectorySaving(false);
    }
  }

  function selectReplacementVehicleNeed(needed: boolean) {
    markDirty();
    setReplacementVehicleNeeded(needed);
  }

  async function submitCase(): Promise<boolean> {
    if (!canSubmit) {
      return false;
    }

    setIsSaving(true);
    setError(null);

    const payload: CreateCaseInput = {
      contactName,
      contactPhone,
      contactEmail,
      customerType: customerType || undefined,
      customerFirstName: primaryContact?.firstName,
      customerLastName: primaryContact?.lastName,
      companyName,
      companyIdNumber,
      assistanceServiceName,
      assistanceReference,
      partnerDirectoryId,
      contacts: contactInputs,
      alternativeContact: contactInputs[1]?.phone,
      customerNote,
      licensePlate,
      vin,
      vehicleLookup,
      vehicleMake: vehicleMake.trim() || undefined,
      vehicleModel: vehicleModel.trim() || undefined,
      vehicleCategory: vehicleCategory.trim() || undefined,
      vehicleType: vehicleType || undefined,
      productionYear: toOptionalNumber(productionYear),
      vehicleColor,
      transmission: transmission || undefined,
      driveType: driveType === "unknown" ? undefined : driveType,
      weightKg: toOptionalNumber(weightKg),
      vehicleIssue,
      vehicleDriveable: hasVehicleInput ? Boolean(vehicleDriveable) : undefined,
      vehicleConditionFlags: hasVehicleInput && vehicleDriveable !== null ? normalizeVehicleConditionFlags(vehicleFlags, vehicleDriveable) : vehicleFlags,
      vehicleNote: [transmissionNote ? `Prevodovka: ${transmissionNote}` : "", vehicleNote].filter(Boolean).join(" · "),
      caseType: caseType || undefined,
      jobTypes: selectedJobTypes,
      priority,
      sourceType: sourceType || undefined,
      pickup: pickup ?? undefined,
      destination: needsDestination ? destination : undefined,
      manualPickupAddress,
      manualDestinationAddress: needsDestination ? manualDestinationAddress : "",
      roadName,
      kilometerSection,
      drivingDirection,
      placeType: placeType || undefined,
      locationComplications,
      accessComplications: selectedAccessComplications,
      destinationNote: needsDestination ? destinationNote : undefined,
      incidentType: incidentType || undefined,
      incidentDescription: vehicleIssue,
      participantsCount: toOptionalNumber(participantsCount),
      passengersCount: toOptionalNumber(passengersCount),
      damageAreas: selectedDamageAreas,
      damageNote,
      replacementVehicleNeeded: replacementVehicleNeeded === true,
      replacementVehicleType: replacementVehicleNeeded === true ? replacementVehicleType : undefined,
      replacementVehiclePreferences: replacementVehicleNeeded === true ? selectedReplacementPreferences : [],
      replacementVehicleNote: replacementVehicleNeeded === true ? replacementVehicleNote : undefined,
      replacementVehicleCategory: replacementVehicleNeeded === true && replacementCategory ? replacementCategory : null,
      replacementVehicleDeliveryPlace: replacementVehicleNeeded === true ? replacementDeliveryPlace : undefined,
      replacementVehicleEntitlement: replacementVehicleNeeded === true && replacementEntitlement ? replacementEntitlement : null,
      replacementVehicleExtensionPossible: replacementVehicleNeeded === true && replacementExtension !== "" ? replacementExtension === "yes" : null,
      replacementVehicleMaxDays: replacementVehicleNeeded === true ? toOptionalNumber(replacementMaxDays) : null,
      paymentMethod: paymentMethod || undefined,
      paymentStatus: paymentStatus || undefined,
      closureType: closureType || undefined,
      closureStatus,
      insurancePortalUrl,
      closureNote,
      note,
    };

    try {
      const response = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.caseId || !result.dispatchData) {
        throw new Error(result.error ?? "Prípad sa nepodarilo uložiť.");
      }

      let nextDispatchData = result.dispatchData;

      if (pendingFiles.length > 0 && !attachmentValidationError) {
        try {
          const uploadForm = new FormData();
          pendingFiles.forEach((file) => uploadForm.append("files", file));
          if (attachmentNote.trim()) {
            uploadForm.append("note", attachmentNote.trim());
          }
          const uploadResponse = await fetch(`/api/cases/${result.caseId}/attachments`, {
            method: "POST",
            body: uploadForm,
          });
          const uploadResult = (await uploadResponse.json()) as ApiMutationResponse;

          if (!uploadResponse.ok || !uploadResult.dispatchData) {
            throw new Error(uploadResult.error ?? "Prílohy sa nepodarilo nahrať.");
          }

          nextDispatchData = uploadResult.dispatchData;
        } catch (uploadCaught) {
          const uploadError = uploadCaught instanceof Error ? uploadCaught.message : "Prílohy sa nepodarilo nahrať.";
          setIsDirty(false);
          onDirtyChange?.(false);
          onCreated(result.dispatchData, result.caseId, `Prípad je uložený, ale prílohy sa nepodarilo nahrať: ${uploadError}`);
          resetTransientFields();
          return true;
        }
      }

      const noticeParts = [
        !formReady ? "Karta je uložená ako rozpracovaná. Kontrola ukazuje, ktoré údaje treba doplniť." : "Karta je uložená.",
        attachmentValidationError ? `Prílohy neboli uložené: ${attachmentValidationError}` : "",
        ...(result.warnings ?? []).map((warning) => warning.message),
      ].filter(Boolean);
      const warningNotice = noticeParts.join(" ");
      setIsDirty(false);
      onDirtyChange?.(false);
      onCreated(nextDispatchData, result.caseId, warningNotice);
      resetTransientFields();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Prípad sa nepodarilo uložiť.");
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  function resetTransientFields() {
    setLicensePlate("");
    setVin("");
    setVehicleLookup(null);
    setVehicleMake("");
    setVehicleModel("");
    setVehicleColor("");
    setVehicleIssue("");
    setVehicleDriveable(null);
    setVehicleFlags([]);
    setParticipantsCount("");
    setNote("");
    setPickup(null);
    setDestination(null);
    setPendingFiles([]);
    setAttachmentNote("");
  }

  function addContact() {
    markDirty();
    setContacts((current) =>
      current.length >= 5
        ? current
        : [
            ...current,
            {
              id: crypto.randomUUID(),
              firstName: "",
              lastName: "",
              phonePrefix: "+421",
              phoneNational: "",
              email: "",
              role: "driver",
              note: "",
              isPrimary: false,
            },
          ],
    );
  }

  function updateContact(id: string, patch: Partial<ContactDraft>) {
    markDirty();
    setContacts((current) => current.map((contact) => (contact.id === id ? { ...contact, ...patch } : contact)));
  }

  function removeContact(id: string) {
    markDirty();
    setContacts((current) => {
      const next = current.filter((contact) => contact.id !== id);
      if (next.length === 0) {
        return current;
      }

      return next.some((contact) => contact.isPrimary) ? next : [{ ...next[0], isPrimary: true }, ...next.slice(1)];
    });
  }

  function setPrimaryContact(id: string) {
    markDirty();
    setContacts((current) => current.map((contact) => ({ ...contact, isPrimary: contact.id === id })));
  }

  function moveContact(id: string, direction: -1 | 1) {
    markDirty();
    setContacts((current) => moveById(current, id, direction));
  }

  function dropContact(targetId: string) {
    if (!draggedContactId || draggedContactId === targetId) {
      return;
    }

    markDirty();
    setContacts((current) => moveToTarget(current, draggedContactId, targetId));
    setDraggedContactId(null);
  }

  function handleFiles(files: FileList | null) {
    if (!files) {
      return;
    }

    markDirty();
    setPendingFiles((current) => [...current, ...Array.from(files)].slice(0, 10));
  }

  return (
    <div
      className="h-full min-w-0 max-w-full overflow-y-auto overflow-x-hidden bg-zinc-50 p-2 sm:p-3 @container"
      data-testid="case-form-scroll-region"
      onChangeCapture={markDirty}
    >
      <div className="grid gap-3">
        <div className="grid min-w-0 gap-4 [&>section]:min-w-0" data-testid="case-form-main">
          <p className="text-right text-xs font-medium text-zinc-500">
            <span className="font-bold text-red-600" aria-hidden="true">*</span> Povinné údaje
          </p>

          <FormSection
            title="1. Základ prípadu"
            valid={formValidation.sectionValid.basic}
            errorCount={formValidation.sectionErrors.basic.length}
          >
            <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_180px_180px]">
              <div>
                <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Typ zákazky<RequiredMark /></span>
                <CheckboxGroup items={jobTypes} labels={jobTypeLabels} selected={selectedJobTypes} onChange={setSelectedJobTypes} />
              </div>
              <SelectField label="Priorita" value={priority} onChange={(value) => setPriority(value as CasePriority)} options={casePriorities.map((value) => [value, casePriorityLabels[value]] as [string, string])} />
              <SelectField label="Zdroj" required value={sourceType} onChange={(value) => setSourceType(value as NonNullable<CreateCaseInput["sourceType"]> | "")} options={[["", "Nezadané"], ["client", "Klient"], ["assistance", "Asistenčka"], ["samoplatca", "Samoplatca"], ["partner", "Partner"], ["internal", "Interné"]]} />
            </div>
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-medium text-zinc-600">
              Typ karty: <strong className="text-zinc-900">{caseType || "nezadaný"}</strong>. Cieľ sa zobrazí iba pri odťahu alebo vyslobodení.
            </div>
          </FormSection>

          <FormSection
            title="2. Zákazník a kontakty"
            valid={formValidation.sectionValid.customer}
            errorCount={formValidation.sectionErrors.customer.length}
          >
            {hasActiveCall && (
              <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-900">
                Kontakt bol predvyplnený z hovoru, z ktorého bola karta otvorená: <strong>{call.callerName || "meno nezistené"} · {call.callerNumber}</strong>
              </div>
            )}

            <div>
              <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Typ zákazníka<RequiredMark /></span>
              <div className="flex flex-wrap gap-2">
                {customerTypes.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => selectCustomerType(type)}
                    aria-pressed={customerType === type}
                    className={`h-9 rounded-md px-3 text-xs font-semibold ring-1 ${customerType === type ? "bg-[#FCD703] text-zinc-950 ring-yellow-500" : "bg-zinc-50 text-zinc-600 ring-zinc-200 hover:bg-white"}`}
                  >
                    {customerTypeLabels[type]}
                  </button>
                ))}
              </div>
            </div>

            {(customerType === "insurance" || customerType === "company") && (
              <div className="grid gap-3 md:grid-cols-3">
                <SelectField
                  label={customerType === "insurance" ? "Adresár asistenčných služieb" : "Adresár firiem"}
                  value={partnerDirectoryId}
                  onChange={selectDirectoryEntry}
                  options={[["", "Vybrať z adresára"], ...directoryOptions.map((entry) => [entry.id, entry.ico ? `${entry.name} · IČO ${entry.ico}` : entry.name] as [string, string])]}
                />
                {customerType === "company" ? (
                  <>
                    <TextField label="Názov firmy" required value={companyName} onChange={setCompanyName} />
                    <TextField
                      label="IČO"
                      required
                      value={companyIdNumber}
                      onChange={setCompanyIdNumber}
                      error={fieldErrors.companyIdNumber}
                      inputMode="numeric"
                      maxLength={8}
                      transformValue={(value) => digitsOnly(value, 8)}
                    />
                  </>
                ) : (
                  <>
                    <TextField label="Asistenčná služba" required value={assistanceServiceName} onChange={changeAssistanceServiceName} />
                    <TextField label="Číslo prípadu asistenčky" required value={assistanceReference} onChange={setAssistanceReference} />
                  </>
                )}
              </div>
            )}

            {customerType === "insurance" && assistanceServiceName.trim() && (
              <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-zinc-500" aria-live="polite">
                {directoryError ? (
                  <span role="alert" className="text-red-700">{directoryError}</span>
                ) : directoryNotice ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700">
                    <CheckCircle2 size={13} />
                    {directoryNotice}
                  </span>
                ) : existingAssistanceEntry ? (
                  partnerDirectoryId !== existingAssistanceEntry.id && (
                    <>
                      <span>Táto služba už je v adresári.</span>
                      <button
                        type="button"
                        onClick={() => selectDirectoryEntry(existingAssistanceEntry.id)}
                        className="font-semibold text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-950"
                      >
                        Použiť uloženú
                      </button>
                    </>
                  )
                ) : (
                  <>
                    <span>Nová služba. Môžete si ju uložiť aj na neskôr.</span>
                    <button
                      type="button"
                      onClick={() => void quickAddAssistanceService()}
                      disabled={directorySaving}
                      className="inline-flex items-center gap-1 font-semibold text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-950 disabled:cursor-not-allowed disabled:text-zinc-400"
                    >
                      {directorySaving && <Loader2 size={12} className="animate-spin" />}
                      Uložiť
                    </button>
                  </>
                )}
              </div>
            )}

            <ContactList
              contacts={contacts}
              draggedContactId={draggedContactId}
              fieldErrors={fieldErrors}
              onAdd={addContact}
              onDragStart={setDraggedContactId}
              onDrop={dropContact}
              onMove={moveContact}
              onPrimary={setPrimaryContact}
              onRemove={removeContact}
              onUpdate={updateContact}
            />
            <TextareaField label="Poznámka k zákazníkovi" value={customerNote} onChange={setCustomerNote} />
          </FormSection>

          <FormSection
            title={replacementOnly ? "3. Vozidlo klienta (voliteľné)" : "3. Vozidlo a incident"}
            valid={formValidation.sectionValid.vehicle}
            errorCount={formValidation.sectionErrors.vehicle.length}
          >
            {replacementOnly && (
              <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-900">
                Prípad na náhradné vozidlo: údaje o klientovom vozidle sú voliteľné a odťahové polia sú skryté.
              </p>
            )}
            <div className="grid gap-3 md:grid-cols-3">
              <VehicleLookupControl contextKey="new-case" plate={licensePlate} vin={vin} snapshot={vehicleLookup} required={!replacementOnly} plateError={fieldErrors.licensePlate} vinError={fieldErrors.vin} onPlateChange={setLicensePlate} onVinChange={setVin} onPlateBlur={prefillFromCommander} values={{ make: vehicleMake, model: vehicleModel, color: vehicleColor }} onApply={(patch, snapshot) => {
                markDirty(); setVehicleLookup(snapshot);
                if (patch.plate !== undefined) setLicensePlate(patch.plate);
                if (patch.vin !== undefined) setVin(patch.vin);
                if (patch.make !== undefined) setVehicleMake(patch.make);
                if (patch.model !== undefined) setVehicleModel(patch.model);
                if (patch.color !== undefined) setVehicleColor(patch.color);
              }} />
              <TextField label="Značka" value={vehicleMake} onChange={setVehicleMake} />
              <TextField label="Model" value={vehicleModel} onChange={setVehicleModel} />
              <TextField
                label="Rok výroby"
                value={productionYear}
                onChange={setProductionYear}
                error={fieldErrors.productionYear}
                reserveErrorSpace
                type="number"
                inputMode="numeric"
                min={1950}
                max={new Date().getFullYear() + 1}
                step={1}
                transformValue={(value) => digitsOnly(value, 4)}
              />
              <TextField label="Farba" value={vehicleColor} onChange={setVehicleColor} />
              <SelectField label="Typ vozidla" value={vehicleType} onChange={(value) => setVehicleType(value as ClientVehicleType | "")} options={[["", "Nezadané"], ...vehicleTypes.map((type) => [type, clientVehicleTypeLabels[type]] as [string, string])]} />
              <SelectField label="Prevodovka" value={transmission} onChange={(value) => setTransmission(value as VehicleTransmission | "")} options={[["", "Nezadané"], ...transmissions.map((item) => [item, transmissionLabels[item]] as [string, string])]} />
              <TextField label="Poznámka k prevodovke" value={transmissionNote} onChange={setTransmissionNote} />
              <SelectField label="Pohon" value={driveType} onChange={setDriveType} options={driveTypeOptions.map(([value, label]) => [value, label])} />
              <TextField label="Hmotnosť kg" value={weightKg} onChange={setWeightKg} error={fieldErrors.weightKg} type="number" inputMode="numeric" min={1} max={100000} step={1} transformValue={(value) => digitsOnly(value, 6)} />
              <TextField label="Kategória" value={vehicleCategory} onChange={setVehicleCategory} />
            </div>
            {commanderNotice && <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900">{commanderNotice}</div>}
            <TextareaField label="Opis problému / situácie" required={!replacementOnly} value={vehicleIssue} onChange={setVehicleIssue} />
            {!replacementOnly && (
              <>
                <div>
                  <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Pojazdnosť<RequiredMark /></span>
                  <div className="flex flex-wrap gap-2">
                  {[
                    [false, "Nepojazdné"],
                    [true, "Pojazdné"],
                  ].map(([value, label]) => (
                    <button
                      key={String(value)}
                      type="button"
                      onClick={() => setDriveable(Boolean(value))}
                      className={`h-9 rounded-md px-3 text-xs font-semibold ring-1 ${vehicleDriveable === value ? "bg-yellow-100 text-zinc-950 ring-yellow-300" : "bg-zinc-50 text-zinc-600 ring-zinc-200"}`}
                    >
                      {label}
                    </button>
                  ))}
                  </div>
                </div>
                <CheckboxGroup items={conditionFlags} labels={vehicleConditionFlagLabels} selected={vehicleFlags} onChange={(nextFlags) => setVehicleFlags(vehicleDriveable === null ? nextFlags : normalizeVehicleConditionFlags(nextFlags, vehicleDriveable))} />
              </>
            )}
            <TextareaField label="Poznámka k vozidlu" value={vehicleNote} onChange={setVehicleNote} />
            {!replacementOnly && (
              <>
                <h4 className="border-t border-zinc-200 pt-3 text-sm font-semibold text-zinc-900">Incident</h4>
                <div className="grid gap-3 md:grid-cols-3">
                  <SelectField label="Typ incidentu" required value={incidentType} onChange={(value) => setIncidentType(value as IncidentType | "")} options={[["", "Nezadané"], ...incidentTypes.map((type) => [type, incidentTypeLabels[type]] as [string, string])]} />
                  <TextField label="Počet účastníkov" value={participantsCount} onChange={setParticipantsCount} error={fieldErrors.participantsCount} type="number" inputMode="numeric" min={0} max={99} step={1} transformValue={(value) => digitsOnly(value, 2)} />
                  <TextField label="Počet pasažierov" value={passengersCount} onChange={setPassengersCount} error={fieldErrors.passengersCount} type="number" inputMode="numeric" min={0} max={99} step={1} transformValue={(value) => digitsOnly(value, 2)} />
                </div>
                <CheckboxGroup items={damageAreas} labels={damageAreaLabels} selected={selectedDamageAreas} onChange={setSelectedDamageAreas} />
                <TextareaField label="Poznámka k poškodeniu" value={damageNote} onChange={setDamageNote} />
              </>
            )}
          </FormSection>

          <FormSection
            title="4. Miesto a cieľ"
            valid={formValidation.sectionValid.location}
            errorCount={formValidation.sectionErrors.location.length}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <GooglePlaceAutocomplete
                label={replacementOnly ? "Miesto (voliteľné, mapa)" : "Miesto incidentu"}
                required={!replacementOnly}
                placeholder="Kde je vozidlo?"
                value={pickup}
                manualValue={manualPickupAddress}
                onManualChange={(value) => {
                  markDirty();
                  setPickup(null);
                  setManualPickupAddress(value);
                }}
                onSelect={(value) => {
                  markDirty();
                  setManualPickupAddress("");
                  setPickup(value);
                }}
              />
              {needsDestination ? (
                <GooglePlaceAutocomplete
                  label="Cieľ odťahu"
                  required
                  placeholder="Kam má ísť vozidlo?"
                  value={destination}
                  manualValue={manualDestinationAddress}
                  onManualChange={(value) => {
                    markDirty();
                    setDestination(null);
                    setManualDestinationAddress(value);
                  }}
                  onSelect={(value) => {
                    markDirty();
                    setManualDestinationAddress("");
                    setDestination(value);
                  }}
                />
              ) : (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900">
                  Asistencia na mieste: cieľ odťahu sa nevyžaduje.
                </div>
              )}
            </div>
            <div className="mt-3">
              <LocationPicker value={pickup} onSelect={(value) => { markDirty(); setPickup(value); }} />
            </div>
            <div className={`mt-3 rounded-md border p-3 ${placeType === "highway" ? "border-yellow-300 bg-yellow-50" : "border-zinc-200 bg-white"}`}>
              <div className="grid gap-3 md:grid-cols-4">
                <TextField label="Diaľnica / cesta" value={roadName} onChange={setRoadName} />
                <TextField label="Km úsek" value={kilometerSection} onChange={setKilometerSection} error={fieldErrors.kilometerSection} type="number" inputMode="decimal" min={0} max={9999} step="0.01" transformValue={(value) => decimalOnly(value, 4)} />
                <TextField label="Smer jazdy" value={drivingDirection} onChange={setDrivingDirection} />
                <SelectField label="Typ miesta" value={placeType} onChange={(value) => setPlaceType(value as PlaceType | "")} options={[["", "Nezadané"], ...placeTypes.map((type) => [type, placeTypeLabels[type]] as [string, string])]} />
              </div>
            </div>
            {!replacementOnly && (
              <>
                <TextareaField label="Komplikácie" value={locationComplications} onChange={setLocationComplications} />
                <CheckboxGroup items={accessComplications} labels={accessComplicationLabels} selected={selectedAccessComplications} onChange={setSelectedAccessComplications} />
              </>
            )}
            {needsDestination && <TextareaField label="Poznámka k cieľu odťahu" value={destinationNote} onChange={setDestinationNote} />}
          </FormSection>

          <FormSection
            title="5. Doplnkové služby a administratíva"
            valid={formValidation.sectionValid.extras}
            errorCount={formValidation.sectionErrors.extras.length}
          >
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
              <h4 className="text-sm font-semibold text-zinc-950">Náhradné vozidlo</h4>
              <p className="mt-0.5 text-xs font-medium text-zinc-600">Potrebuje zákazník zabezpečiť náhradné vozidlo?</p>
              <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Potreba náhradného vozidla">
                <button
                  type="button"
                  onClick={() => selectReplacementVehicleNeed(true)}
                  aria-pressed={replacementVehicleNeeded === true}
                  className={`h-9 rounded-md px-4 text-sm font-semibold ring-1 ${replacementVehicleNeeded === true ? "bg-yellow-100 text-zinc-950 ring-yellow-300" : "bg-zinc-50 text-zinc-600 ring-zinc-200 hover:bg-white"}`}
                >
                  Áno, potrebuje
                </button>
                <button
                  type="button"
                  onClick={() => selectReplacementVehicleNeed(false)}
                  aria-pressed={replacementVehicleNeeded === false}
                  className={`h-9 rounded-md px-4 text-sm font-semibold ring-1 ${replacementVehicleNeeded === false ? "bg-yellow-100 text-zinc-950 ring-yellow-300" : "bg-zinc-50 text-zinc-600 ring-zinc-200 hover:bg-white"}`}
                >
                  Nie, nepotrebuje
                </button>
              </div>
              <div className={`mt-3 grid gap-3 rounded-md border p-3 ${replacementVehicleNeeded === true ? "border-yellow-200 bg-white" : "border-zinc-200 bg-zinc-100"}`}>
                <div className="grid gap-3 md:grid-cols-2">
                  <TextField label="Požadovaný typ vozidla" required={replacementVehicleNeeded === true} value={replacementVehicleType} onChange={setReplacementVehicleType} disabled={replacementVehicleNeeded !== true} />
                  <TextField label="Špeciálne požiadavky" value={replacementVehicleNote} onChange={setReplacementVehicleNote} disabled={replacementVehicleNeeded !== true} />
                </div>
                <div>
                  <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Preferencie</span>
                  <CheckboxGroup
                    items={replacementPreferences}
                    labels={replacementPreferenceLabels}
                    selected={selectedReplacementPreferences}
                    onChange={setSelectedReplacementPreferences}
                    disabled={replacementVehicleNeeded !== true}
                  />
                </div>
                {replacementOnly && customerType !== "insurance" && (
                  <div className="grid gap-3 border-t border-zinc-100 pt-3 md:grid-cols-2">
                    <TextField label="Asistenčná služba" value={assistanceServiceName} onChange={setAssistanceServiceName} disabled={replacementVehicleNeeded !== true} />
                    <TextField label="Číslo prípadu asistenčky" value={assistanceReference} onChange={setAssistanceReference} disabled={replacementVehicleNeeded !== true} />
                  </div>
                )}
                <div className="grid gap-3 border-t border-zinc-100 pt-3 md:grid-cols-2">
                  <SelectField
                    label="Kategória vozidla"
                    value={replacementCategory}
                    onChange={(value) => setReplacementCategory(value as "" | ReplacementVehicleCategory)}
                    options={[["", "Nezadaná"], ...replacementCategories.map((category) => [category, replacementCategoryLabels[category]] as [string, string])]}
                    disabled={replacementVehicleNeeded !== true}
                  />
                  <TextField
                    label="Miesto pristavenia"
                    value={replacementDeliveryPlace}
                    onChange={setReplacementDeliveryPlace}
                    disabled={replacementVehicleNeeded !== true}
                    required={replacementOnly}
                  />
                  <SelectField
                    label="Nárok na pristavenie"
                    value={replacementEntitlement}
                    onChange={(value) => setReplacementEntitlement(value as "" | ReplacementVehicleEntitlement)}
                    options={[["", "Nezadaný"], ...replacementEntitlements.map((entitlement) => [entitlement, replacementEntitlementLabels[entitlement]] as [string, string])]}
                    disabled={replacementVehicleNeeded !== true}
                  />
                  <SelectField
                    label="Možnosť predĺženia"
                    value={replacementExtension}
                    onChange={(value) => setReplacementExtension(value as "" | "yes" | "no")}
                    options={[["", "Nezadaná"], ["yes", "Áno"], ["no", "Nie"]]}
                    disabled={replacementVehicleNeeded !== true}
                  />
                  <TextField
                    label="Maximálny počet dní"
                    value={replacementMaxDays}
                    onChange={setReplacementMaxDays}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={365}
                    step={1}
                    transformValue={(value) => digitsOnly(value, 3)}
                    disabled={replacementVehicleNeeded !== true}
                  />
                </div>
                {replacementVehicleNeeded !== true && (
                  <p className="text-xs font-medium text-zinc-500">
                    Podrobnosti sa sprístupnia po voľbe „Áno, potrebuje“ a zostanú na rovnakom mieste.
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-zinc-200 bg-white p-3">
              <h4 className="text-sm font-semibold text-zinc-950">Dokumenty</h4>
              <p className="mt-0.5 text-xs font-medium text-zinc-500">Priložte fotografie, protokoly alebo ďalšie podklady k prípadu.</p>
              <label className="mt-3 flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-4 text-center text-sm font-semibold text-zinc-700 hover:bg-white">
                <FileUp size={22} />
                Pridať dokument, fotku alebo PDF
                <span className="text-xs font-medium text-zinc-500">JPG, PNG, PDF alebo Word do 10 MB</span>
                <input type="file" multiple accept="image/jpeg,image/png,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only" onChange={(event) => handleFiles(event.target.files)} />
              </label>
              {pendingFiles.length > 0 && (
                <div className="mt-3 grid gap-2">
                  {pendingFiles.map((file, index) => (
                    <div key={`${file.name}-${file.lastModified}-${index}`} className="flex items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm">
                      <span className="min-w-0 truncate">{file.name}</span>
                      <button type="button" onClick={() => setPendingFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="rounded-md border border-zinc-200 p-1.5 text-zinc-600 hover:bg-zinc-50" aria-label="Odobrať prílohu">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3">
                <TextField label="Spoločná poznámka k prílohám" value={attachmentNote} onChange={setAttachmentNote} />
              </div>
            </div>

            <div className="grid gap-3 @3xl:grid-cols-2">
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <h4 className="text-sm font-semibold text-zinc-950">Platba</h4>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <SelectField label="Spôsob platby" required value={paymentMethod} onChange={(value) => setPaymentMethod(value as PaymentMethod | "")} options={[["", "Nezadané"], ...paymentMethods.map((method) => [method, paymentMethodLabels[method]] as [string, string])]} />
                  <SelectField label="Stav platby" required value={paymentStatus} onChange={(value) => setPaymentStatus(value as PaymentStatus | "")} options={[["", "Nezadané"], ...paymentStatuses.map((status) => [status, paymentStatusLabels[status]] as [string, string])]} />
                </div>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <h4 className="text-sm font-semibold text-zinc-950">Ukončenie prípadu</h4>
                <div className="mt-3 grid gap-3">
                  <SelectField label="Typ ukončenia" value={closureType} onChange={(value) => setClosureType(value as ClosureType | "")} options={[["", "Nezadané"], ["insurance_portal", "Asistenčná služba"], ["self_payer", "Samoplatca"], ["internal", "Interné"]]} />
                  <TextField label="Stav ukončenia" value={closureStatus} onChange={setClosureStatus} />
                  <TextField
                    label="Portál asistenčnej služby"
                    value={insurancePortalUrl}
                    onChange={setInsurancePortalUrl}
                    disabled={sourceType !== "assistance"}
                    error={fieldErrors.insurancePortalUrl}
                    type="url"
                    inputMode="url"
                  />
                  {sourceType !== "assistance" && (
                    <p className="text-xs font-medium text-zinc-500">Portál sa sprístupní pri zdroji „Asistenčka“.</p>
                  )}
                </div>
              </div>
            </div>
            <TextareaField label="Poznámka k ukončeniu zásahu" value={closureNote} onChange={setClosureNote} />
            <TextareaField label="Interná poznámka dispečera" value={note} onChange={setNote} />
          </FormSection>

          <div className="min-h-11" aria-live="polite">
            {(error || validationErrors.length > 0 || missingRequiredFields.length > 0) && (
              <div
                className={`rounded-md border px-3 py-2 text-sm font-medium ${error || validationErrors.length > 0 ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}
                role={error || validationErrors.length > 0 ? "alert" : "status"}
              >
                {error ?? validationErrors[0] ?? missingRequiredFields[0]}
              </div>
            )}
          </div>

          <div className="grid gap-2 rounded-md border border-zinc-200 bg-white p-3 sm:flex sm:items-center sm:justify-end">
            <button type="button" onClick={closeForm} className="h-10 rounded-md border border-zinc-200 px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-50">
              Zrušiť
            </button>
            <button
              type="button"
              onClick={() => void submitCase()}
              disabled={!canSubmit}
              title={formReady ? "Uložiť kartu" : "Uložiť rozpracovanú kartu a doplniť ju neskôr"}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
            >
              {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {isSaving ? "Ukladám…" : formReady ? "Uložiť kartu" : "Uložiť rozpracované"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function NewCaseDrawer({ call, onClose, onCreated, open, partnerDirectory }: NewCaseDrawerProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-y-0 right-0 z-[2147483200] flex w-full max-w-5xl flex-col border-l border-zinc-200 bg-white shadow-2xl">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-4">
        <div className="min-w-0">
          <span className="text-sm font-semibold uppercase tracking-normal text-zinc-600">Nový prípad</span>
          <div className="text-xs font-medium text-zinc-500">ID prípadu sa pridelí po uložení</div>
        </div>
        <button type="button" onClick={onClose} className="rounded-md border border-zinc-200 p-2 text-zinc-600 hover:bg-zinc-50" aria-label="Zavrieť nový prípad">
          <X size={18} />
        </button>
      </div>
      <NewCaseForm call={call} onClose={onClose} onCreated={onCreated} partnerDirectory={partnerDirectory} />
    </div>
  );
}

function ContactList({
  contacts,
  draggedContactId,
  fieldErrors,
  onAdd,
  onDragStart,
  onDrop,
  onMove,
  onPrimary,
  onRemove,
  onUpdate,
}: {
  contacts: ContactDraft[];
  draggedContactId: string | null;
  fieldErrors: CaseFormFieldErrors;
  onAdd: () => void;
  onDragStart: (id: string | null) => void;
  onDrop: (targetId: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onPrimary: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<ContactDraft>) => void;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-normal text-zinc-500">Kontakty v poradí volania</span>
        <button type="button" onClick={onAdd} className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-200 px-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50">
          <Plus size={14} />
          Kontakt
        </button>
      </div>
      {contacts.map((contact, index) => (
        <div
          key={contact.id}
          draggable
          onDragStart={() => onDragStart(contact.id)}
          onDragEnd={() => onDragStart(null)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => onDrop(contact.id)}
          className={`grid gap-3 rounded-md border p-3 ${draggedContactId === contact.id ? "border-yellow-300 bg-yellow-50" : "border-zinc-200 bg-zinc-50"}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-600">
              <GripVertical size={15} />
              {index + 1}. kontakt
              {contact.isPrimary && <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-yellow-900"><Star size={12} /> Primárny</span>}
            </div>
            <div className="flex gap-1">
              <IconButton label="Vyššie" onClick={() => onMove(contact.id, -1)} disabled={index === 0}>
                <ChevronUp size={15} />
              </IconButton>
              <IconButton label="Nižšie" onClick={() => onMove(contact.id, 1)} disabled={index === contacts.length - 1}>
                <ChevronDown size={15} />
              </IconButton>
              <IconButton label="Primárny" onClick={() => onPrimary(contact.id)} disabled={contact.isPrimary}>
                <Star size={15} />
              </IconButton>
              <IconButton label="Odobrať" onClick={() => onRemove(contact.id)} disabled={contacts.length === 1}>
                <Trash2 size={15} />
              </IconButton>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <TextField label="Meno" required={contact.isPrimary} value={contact.firstName} onChange={(value) => onUpdate(contact.id, { firstName: value })} error={contact.isPrimary ? fieldErrors.contactName : undefined} reserveErrorSpace={contact.isPrimary} />
            <TextField label="Priezvisko" value={contact.lastName} onChange={(value) => onUpdate(contact.id, { lastName: value })} />
            <PhoneField contact={contact} required={contact.isPrimary} onChange={(patch) => onUpdate(contact.id, patch)} error={contact.isPrimary ? fieldErrors.contactPhone : undefined} reserveErrorSpace={contact.isPrimary} />
            <TextField label="Email" value={contact.email} onChange={(value) => onUpdate(contact.id, { email: value })} error={contact.isPrimary ? fieldErrors.contactEmail : getEmailValidationError(contact.email)} reserveErrorSpace={contact.isPrimary} type="email" inputMode="email" />
            <SelectField label="Rola" value={contact.role} onChange={(value) => onUpdate(contact.id, { role: value as CustomerContactRole })} options={customerContactRoles.map((role) => [role, customerContactRoleLabels[role]])} />
            <TextField label="Poznámka" value={contact.note} onChange={(value) => onUpdate(contact.id, { note: value })} />
          </div>
        </div>
      ))}
    </div>
  );
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

function parsePhone(phone: string) {
  return splitContactPhone(phone);
}

function fullPhone(contact: ContactDraft | undefined) {
  return joinContactPhone(contact);
}

function contactDisplayName(contact: ContactDraft | undefined) {
  if (!contact) {
    return "";
  }

  return [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
}

function caseTypeFromJobTypes(types: JobType[]) {
  if (types.includes("tow")) return "Odťah";
  if (types.includes("vehicle_recovery")) return "Vyslobodenie MV";
  if (types.includes("replacement_vehicle")) return "Náhradné vozidlo";
  if (types.includes("onsite_assistance")) return "Asistencia na mieste";
  return "";
}

function normalizePlate(value: string) {
  return value.toLocaleUpperCase("sk-SK").replace(/[^A-Z0-9]/g, "");
}

function moveById<T extends { id: string }>(items: T[], id: string, direction: -1 | 1) {
  const index = items.findIndex((item) => item.id === id);
  const targetIndex = index + direction;

  if (index < 0 || targetIndex < 0 || targetIndex >= items.length) {
    return items;
  }

  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(targetIndex, 0, item);
  return next;
}

function moveToTarget<T extends { id: string }>(items: T[], draggedId: string, targetId: string) {
  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);

  if (draggedIndex < 0 || targetIndex < 0) {
    return items;
  }

  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  next.splice(targetIndex, 0, dragged);
  return next;
}

function toOptionalNumber(value: string) {
  const number = Number(value);
  return Number.isFinite(number) && value.trim() ? number : undefined;
}

function validateAttachmentFiles(files: File[]) {
  for (const file of files) {
    if (file.size <= 0) {
      return `Súbor ${file.name} je prázdny.`;
    }

    if (file.size > maxAttachmentBytes) {
      return `Súbor ${file.name} presahuje limit 10 MB.`;
    }

    if (!allowedAttachmentTypes.has(file.type)) {
      return `Typ súboru ${file.type || "neznámy"} nie je povolený.`;
    }
  }

  return null;
}
