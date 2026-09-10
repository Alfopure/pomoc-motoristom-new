"use client";

import { VehicleLookupControl } from "./VehicleLookupControl";
import { protectDraftBeforeUnload } from "@/lib/draft-unload";
import { resolveInternalVehicle, type VehicleLookupSnapshot } from "@/lib/vehicle-lookup";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CarFront,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Download,
  Edit3,
  FileText,
  FileUp,
  Link2,
  Loader2,
  MapPin,
  MessageSquareText,
  Navigation,
  Phone,
  PhoneIncoming,
  Plus,
  ReceiptText,
  Star,
  TriangleAlert,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CaseAttachmentInput, CaseContactInput, PlaceSelectionInput, UpdateCaseInput } from "@/data/case-inputs";
import type { CommanderVehicleConnection, DispatchData } from "@/data/dispatch-types";
import type { PhoneBarCall } from "@/lib/telephony/active-calls-model";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { CASE_ATTACHMENT_ACCEPT, validateCaseAttachmentFiles } from "@/lib/case-attachments";
import type {
  AccessComplication,
  Branch,
  CasePriority,
  ClientVehicleType,
  ClosureType,
  CustomerContactRole,
  CustomerType,
  DamageArea,
  DispatchCase,
  FleetAsset,
  IncidentType,
  JobType,
  Operator,
  PartnerDirectoryEntry,
  PaymentMethod,
  PaymentStatus,
  PlaceType,
  PriceRule,
  ReplacementVehicleCategory,
  ReplacementVehicleEntitlement,
  ReplacementVehiclePreference,
  ReplacementVehicleProvisionStatus,
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
  isReplacementVehicleOnlyCase,
  replacementProvisionLabels,
  requiresTowDestination,
  transmissionLabels,
  vehicleConditionFlagLabels,
} from "@/domain/case-card";
import { casePriorityLabels, caseStatusLabels, caseStatusTone } from "@/domain/statuses";
import { assignableOperators, isTaskOpen, isTaskOverdue, taskPriorities, taskPriorityLabels, taskPriorityTone } from "@/domain/tasks";
import { formatDateTime, formatTime } from "@/lib/dispatch-calculations";
import { createDispatchMapModel } from "@/lib/map-adapter";
import {
  attachmentCategories,
  attachmentCategoryLabels,
  accessComplications,
  conditionFlags,
  customerContactRoles,
  customerTypes,
  type CaseFormFieldErrors,
  damageAreas,
  decimalOnly,
  digitsOnly,
  getCaseFormValidation,
  getCaseFormFieldErrors,
  getEmailValidationError,
  incidentTypes,
  jobTypes,
  normalizeVehicleConditionFlags,
  paymentMethods,
  paymentStatuses,
  placeTypes,
  replacementCategories,
  replacementEntitlements,
  replacementPreferences,
  transmissions,
  vehicleTypes,
} from "./case-form-shared";
import {
  CheckboxGroup,
  type ContactDraft,
  FormSection as EditFormSection,
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
import type { SaveCaseDraft } from "./NewCaseDrawer";
import { UseCustomerLocationButton } from "./UseCustomerLocationButton";
import { CaseEditorHeader, type CaseEditorControls } from "./CaseEditorHeader";
import { changedCaseFields } from "./case-editor-save";
import { CaseSummary } from "./CaseSummary";
import styles from "./case-detail.module.css";
import { CaseSmsHistory } from "./CaseSmsHistory";
import { SmsComposerDialog } from "./SmsComposerDialog";

type CaseDetailProps = {
  onEditorControlsChange?: (controls: CaseEditorControls | null) => void;
  caseItem: DispatchCase;
  branches: Branch[];
  assets: FleetAsset[];
  compactEditor?: boolean;
  editing?: boolean;
  embedded?: boolean;
  focusedTaskId?: string;
  partnerDirectory: PartnerDirectoryEntry[];
  priceRule?: PriceRule;
  /** Live inbound calls that still need an explicit case link. */
  callLinkCandidates?: PhoneBarCall[];
  onLinkCall?: (call: PhoneBarCall, caseId: string) => Promise<boolean>;
  onDataChange?: (dispatchData: DispatchData) => void;
  /** Click-to-call; absent (or refusing) while no telephony provider is wired in. */
  onDial?: (phone: string, caseId?: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onEditingChange?: (editing: boolean, force?: boolean) => boolean | void;
  onSaveDraftChange?: (saveDraft: SaveCaseDraft | null) => void;
  onSavingChange?: (saving: boolean) => void;
  commanderVehicles?: CommanderVehicleConnection[];
  operators?: Operator[];
  persistentEditing?: boolean;
  showInlineEditButton?: boolean;
  /** Kokpit (P-10) zobrazuje poznámky a aktivitu vo vlastnom bočnom stĺpci — potlačí interné vykreslenie. */
  hideNotesAndActivity?: boolean;
  viewerProfileId?: string;
};

type ApiMutationResponse = {
  committedRevision?: string;
  code?: string;
  caseId?: string;
  dispatchData?: DispatchData;
  error?: string;
  warnings?: Array<{ message: string }>;
  sms?: {
    reused?: boolean;
    status?: string;
    statusDetail?: string | null;
  };
};

type AttachmentUrlResponse = {
  error?: string;
  signedUrl?: string;
};

/** Opens a stored attachment through a short-lived signed URL; the bucket itself is private. */
async function openCaseAttachment(caseId: string, attachmentId: string) {
  const response = await fetch(`/api/cases/${caseId}/attachments?attachmentId=${encodeURIComponent(attachmentId)}`);
  const result = (await response.json()) as AttachmentUrlResponse;

  if (!response.ok || !result.signedUrl) {
    throw new Error(result.error ?? "Prílohu sa nepodarilo otvoriť.");
  }

  window.open(result.signedUrl, "_blank", "noopener,noreferrer");
}

const CASE_AUTOSAVE_DEBOUNCE_MS = 1_200;
const CASE_AUTOSAVE_REQUEST_TIMEOUT_MS = 20_000;
const CASE_SAVE_SLOW_MS = 8_000;
const CASE_AUTOSAVE_RETRY_DELAYS_MS = [0, 1_500, 5_000] as const;
type CaseSavePhase = "idle" | "waiting" | "saving" | "saved" | "error";

const actionLabels = {
  call_customer: "Zavolať zákazníkovi",
  send_sms: "Poslať lokalizačnú SMS",
  send_eta: "Poslať ETA SMS",
  create_pdf: "Stiahnuť PDF",
  mark_completed: "Označiť dokončené",
  invoice: "Pripraviť fakturáciu",
  close_case: "Ukončiť zásah",
} as const;

const externalActionSuccessLabels = {
  send_sms: "SMS je pripravená a zapísaná do timeline.",
  send_eta: "ETA je pripravená a zapísaná do timeline.",
  create_pdf: "PDF je pripravené a zapísané do timeline.",
  invoice: "Fakturácia je pripravená a zapísaná do timeline.",
} as const;

const taskPriorityOptions = taskPriorities.map((priority) => [priority, taskPriorityLabels[priority]] as const);
const taskDuePresets = [
  { label: "O 5 min", minutes: 5 },
  { label: "O 30 min", minutes: 30 },
  { label: "O hodinu", minutes: 60 },
] as const;

/**
 * Stavy, ktoré vie dispečer nastaviť ručne pri ukončení prípadu.
 * `open` je návratová voľba pre omylom ukončený alebo zrušený prípad.
 */
const caseClosureStatuses = ["completed_assisted", "completed_no_assistance", "waiting_for_docs", "futile_trip", "cancelled", "open"] as const;
type CaseClosureStatus = (typeof caseClosureStatuses)[number];

const driveTypeOptions = [
  ["front", "Predný"],
  ["rear", "Zadný"],
  ["4x4", "4x4"],
  ["unknown", "Nezistené"],
] as const;

const sourceTypeOptions: Array<[NonNullable<DispatchCase["sourceType"]>, string]> = [
  ["client", "Klient"],
  ["assistance", "Asistenčka"],
  ["samoplatca", "Samoplatca"],
  ["partner", "Partner"],
  ["internal", "Interné"],
];

const closureTypeLabels: Record<ClosureType, string> = {
  insurance_portal: "Asistenčná služba",
  self_payer: "Samoplatca",
  internal: "Interné",
};

export function CaseDetail({
  caseItem,
  branches,
  assets,
  compactEditor = false,
  commanderVehicles = [],
  editing,
  embedded = false,
  onEditorControlsChange,
  focusedTaskId,
  onDataChange,
  onDial,
  onDirtyChange,
  onEditingChange,
  onSaveDraftChange,
  onSavingChange,
  operators = [],
  partnerDirectory,
  persistentEditing = false,
  priceRule,
  callLinkCandidates = [],
  onLinkCall,
  showInlineEditButton = true,
  hideNotesAndActivity = false,
  viewerProfileId,
}: CaseDetailProps) {
  const exportSaveRef = useRef<SaveCaseDraft | null>(null);
  const handleEditorSaveDraft = useCallback((saveDraft: SaveCaseDraft | null) => {
    exportSaveRef.current = saveDraft;
    onSaveDraftChange?.(saveDraft);
  }, [onSaveDraftChange]);
  const [editorControls, setEditorControls] = useState<CaseEditorControls | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [smsComposerOpen, setSmsComposerOpen] = useState(false);
  const [smsTemplate, setSmsTemplate] = useState<"custom" | "location_request" | "eta_update">("custom");
  const [isRunningAction, setIsRunningAction] = useState(false);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [linkingCallSessionId, setLinkingCallSessionId] = useState<string | null>(null);
  const [selectedCallSessionId, setSelectedCallSessionId] = useState("");
  const [localEditing, setLocalEditing] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDueAt, setTaskDueAt] = useState(() => dateTimeLocalInMinutes(30));
  // Nová úloha nesmie zdediť urgentnosť prípadu (U-10) a predvolený riešiteľ je prihlásený
  // používateľ, nie owner prípadu (U-02).
  const [taskPriority, setTaskPriority] = useState<CasePriority>("normal");
  const [taskAssignee, setTaskAssignee] = useState(viewerProfileId ?? "unassigned");
  const [sendTaskReminderEmail, setSendTaskReminderEmail] = useState(false);
  const [pendingAttachmentFiles, setPendingAttachmentFiles] = useState<File[]>([]);
  const [attachmentUploadNote, setAttachmentUploadNote] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [isEditSaveLocked, setIsEditSaveLocked] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const model = caseItem.pickup ? createDispatchMapModel(caseItem, branches, assets, priceRule) : null;
  const routePlan = model?.routePlan ?? null;
  const routeEta = routePlan?.segments.find((segment) => segment.id === "asset-to-pickup")?.eta ?? routePlan?.totalEta;
  const selectedAsset = caseItem.selectedAssetId ? assets.find((asset) => asset.id === caseItem.selectedAssetId) : undefined;
  const mapsUrl = caseItem.pickup
    ? `https://www.google.com/maps/search/?api=1&query=${caseItem.pickup.lat},${caseItem.pickup.lng}`
    : null;
  const customerLocationMapsUrl = caseItem.customerSharedLocation
    ? `https://www.google.com/maps/search/?api=1&query=${caseItem.customerSharedLocation.lat},${caseItem.customerSharedLocation.lng}`
    : null;
  const closureType = caseItem.closureDetails.type;
  const openTasks = caseItem.tasks.filter(isTaskOpen);
  // Dokončené úlohy ostávajú dohľadateľné v detaile prípadu vrátane autora a časov (U-06, U-09).
  const assignableTaskOperators = assignableOperators(operators);
  const completedTasks = caseItem.tasks
    .filter((task) => !isTaskOpen(task))
    .sort((left, right) => new Date(right.completedAt ?? right.dueAt).getTime() - new Date(left.completedAt ?? left.dueAt).getTime());
  const focusedTask = focusedTaskId ? caseItem.tasks.find((task) => task.id === focusedTaskId) : undefined;
  const selectedCall = callLinkCandidates.find((call) => call.sessionId === selectedCallSessionId) ?? callLinkCandidates[0];
  // Detail prípadu zobrazuje všetky otvorené úlohy (U-06); fokusovaná úloha ide navrch.
  const displayedTasks = focusedTask
    ? [focusedTask, ...openTasks.filter((task) => task.id !== focusedTask.id)]
    : openTasks;
  const nextTask = openTasks[0];

  function profileName(profileId: string | undefined) {
    if (!profileId || profileId === "unassigned") {
      return undefined;
    }

    return operators.find((operator) => operator.id === profileId)?.name;
  }
  const primaryContact = caseItem.customerDetails.contacts?.find((contact) => contact.isPrimary) ?? caseItem.customerDetails.contacts?.[0];
  const fallbackContactName = caseItem.contact.name.trim();
  const customerName =
    caseItem.customerDetails.type === "company"
      ? caseItem.customerDetails.companyName || fallbackContactName
      : caseItem.customerDetails.type === "insurance"
        ? caseItem.customerDetails.assistanceServiceName || fallbackContactName
        : [caseItem.customerDetails.firstName, caseItem.customerDetails.lastName].filter(Boolean).join(" ") || fallbackContactName;
  const customerDetail =
    caseItem.customerDetails.type === "company"
      ? caseItem.customerDetails.companyIdNumber ? `IČO ${caseItem.customerDetails.companyIdNumber}` : customerTypeLabels.company
      : caseItem.customerDetails.type === "insurance"
        ? caseItem.customerDetails.assistanceReference ? `Číslo prípadu ${caseItem.customerDetails.assistanceReference}` : customerTypeLabels.insurance
        : caseItem.customerDetails.type ? customerTypeLabels[caseItem.customerDetails.type] : "Typ zákazníka nezadaný";
  const contactPhone = (primaryContact?.phone || caseItem.contact.phone).trim();
  const contactEmail = (primaryContact?.email || caseItem.contact.email || "").trim();
  const readOnlyFieldErrors = getCaseFormFieldErrors({
    companyIdNumber: caseItem.customerDetails.companyIdNumber,
    contactEmail,
    contactName: primaryContact?.name || caseItem.contact.name,
    contactPhone,
    destinationSelected: Boolean(caseItem.destination) || Boolean(caseItem.locationDetails.manualDestinationAddress?.trim()),
    jobTypes: caseItem.jobTypes,
    licensePlate: caseItem.vehicle.licensePlate,
    participantsCount: caseItem.incidentDetails.participantsCount,
    passengersCount: caseItem.incidentDetails.passengersCount,
    productionYear: caseItem.vehicle.productionYear,
    requireCoreFields: true,
    vehicleIssue: caseItem.vehicle.issue || caseItem.incidentDetails.description,
    vin: caseItem.vehicle.vin,
    weightKg: caseItem.vehicle.weightKg,
  });
  const driveabilitySelected =
    caseItem.vehicle.conditionFlags.includes("driveable") || caseItem.vehicle.conditionFlags.includes("immobile");
  const isEditing = editing ?? localEditing;

  function setEditing(nextEditing: boolean, force = false) {
    if (!nextEditing && isEditSaveLocked && !force) {
      return;
    }

    if (onEditingChange) {
      const changed = onEditingChange(nextEditing, force);

      if (!nextEditing && changed !== false) {
        setDraftDirty(false);
        onDirtyChange?.(false);
      }

      return;
    }

    if (!nextEditing && !force && draftDirty) {
      return;
    }

    if (!nextEditing) {
      setDraftDirty(false);
      onDirtyChange?.(false);
    }

    setLocalEditing(nextEditing);
  }

  function updateDirtyState(dirty: boolean) {
    setDraftDirty(dirty);
    onDirtyChange?.(dirty);
  }

  function updateSavingState(saving: boolean) {
    setIsEditSaveLocked(saving);
    onSavingChange?.(saving);
  }

  function discardEditorDraft() {
    if (!persistentEditing) {
      setEditing(false, true);
      return;
    }

    setDraftDirty(false);
    onDirtyChange?.(false);
    setIsEditSaveLocked(false);
    onSavingChange?.(false);
    setEditorRevision((current) => current + 1);
    setNotice("Rozpracované zmeny boli zahodené. Karta zostáva otvorená na úpravu.");
  }

  useEffect(() => {
    if (!focusedTaskId) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const taskElement = document.getElementById(`task-${focusedTaskId}`);
      let ancestor = taskElement?.parentElement;
      while (ancestor) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      const scrollRegion = taskElement?.closest<HTMLElement>("[data-case-detail-scroll-region]");

      if (taskElement && scrollRegion) {
        const taskRect = taskElement.getBoundingClientRect();
        const scrollRect = scrollRegion.getBoundingClientRect();
        scrollRegion.scrollTo({
          behavior: "smooth",
          top: scrollRegion.scrollTop + taskRect.top - scrollRect.top - 24,
        });
        return;
      }

      taskElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [caseItem.id, focusedTaskId]);

  async function postAction(payload: Record<string, unknown>, successMessage: string) {
    if (isRunningAction) {
      return false;
    }

    setIsRunningAction(true);
    try {
      const response = await fetch(`/api/cases/${caseItem.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, ...(typeof payload.taskId === "string" ? { taskExpectedRevision: caseItem.tasks.find(task => task.id === payload.taskId)?.revision } : {}) }),
      });
      const result = (await response.json()) as ApiMutationResponse;
      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Akciu sa nepodarilo vykonať.");
      }
      onDataChange?.(result.dispatchData);
      setNotice(successMessage);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Akciu sa nepodarilo vykonať.");
      return false;
    } finally {
      setIsRunningAction(false);
    }
  }

  function postLocationSms() {
    setSmsTemplate("location_request");
    setSmsComposerOpen(true);
  }

  function postEtaSms() {
    setSmsTemplate("eta_update");
    setSmsComposerOpen(true);
  }

  async function runAction(action: keyof typeof actionLabels) {
    if (action === "create_pdf") {
      setIsRunningAction(true);
      setNotice("Pripravujem PDF…");
      try {
        if ((draftDirty || isEditSaveLocked) && (!exportSaveRef.current || !await exportSaveRef.current())) {
          setNotice("Pred exportom uložte rozpracované zmeny. Údaje zostávajú vo formulári.");
          return;
        }
        const response = await fetch(`/api/cases/${encodeURIComponent(caseItem.id)}/pdf`, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(55_000) });
        if (!response.ok || !response.headers.get("Content-Type")?.includes("application/pdf")) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error ?? "PDF sa nepodarilo vytvoriť. Skúste to znova.");
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${caseItem.caseNumber.replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`;
        document.body.append(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setNotice("PDF uložených údajov je pripravené na stiahnutie.");
      } catch (error) { setNotice(error instanceof Error ? error.message : "PDF sa nepodarilo vytvoriť."); }
      finally { setIsRunningAction(false); }
      return;
    }
    if (action === "call_customer") {
      if (!contactPhone) {
        setNotice("Hovor nie je možné spustiť, kým v karte nie je telefónne číslo.");
        return;
      }

      if (!onDial) {
        setNotice(TELEPHONY_NOT_CONFIGURED_MESSAGE);
        return;
      }

      setIsRunningAction(true);
      try {
        await onDial(contactPhone, caseItem.id);
        setNotice(`Volanie na ${contactPhone} bolo spustené.`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Hovor sa nepodarilo spustiť.");
      } finally {
        setIsRunningAction(false);
      }
      return;
    }

    if (action === "send_sms") {
      await postLocationSms();
      return;
    }

    if (action === "send_eta") {
      await postEtaSms();
      return;
    }

    const externalWorkflow = action === "invoice";
    const message = externalWorkflow
      ? externalActionSuccessLabels[action as keyof typeof externalActionSuccessLabels]
      : `${actionLabels[action]} zapísané do timeline.`;

    await postAction({ action }, message);
  }

  async function createTask() {
    const title = taskTitle.trim() || "Nová úloha";
    if (!title) {
      setNotice("Úloha potrebuje názov.");
      return;
    }

    const dueAt = isoFromLocalDateTime(taskDueAt);
    if (!dueAt) {
      setNotice("Termín úlohy musí byť platný dátum a čas.");
      return;
    }

    await postAction(
      {
        action: "create_task",
        assignedTo: taskAssignee,
        taskDueAt: dueAt,
        taskPriority,
        taskReminderChannels: sendTaskReminderEmail ? ["in_app", "email"] : ["in_app"],
        taskTitle: title,
      },
      "Úloha vytvorená v karte zásahu.",
    );
    setTaskTitle("");
    setTaskDueAt(dateTimeLocalInMinutes(30));
    setSendTaskReminderEmail(false);
  }

  function handleAttachmentFiles(files: FileList | null) {
    if (!files) {
      return;
    }

    setPendingAttachmentFiles((current) => [...current, ...Array.from(files)].slice(0, 10));
  }

  async function uploadAttachments() {
    if (pendingAttachmentFiles.length === 0 || isUploadingAttachment) {
      return;
    }

    setIsUploadingAttachment(true);
    setNotice(null);

    try {
      const form = new FormData();
      pendingAttachmentFiles.forEach((file) => form.append("files", file));
      if (attachmentUploadNote.trim()) {
        form.append("note", attachmentUploadNote.trim());
      }

      const response = await fetch(`/api/cases/${caseItem.id}/attachments`, {
        method: "POST",
        body: form,
      });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Prílohy sa nepodarilo nahrať.");
      }

      setPendingAttachmentFiles([]);
      setAttachmentUploadNote("");
      onDataChange?.(result.dispatchData);
      setNotice("Prílohy sú nahraté a uložené pri karte zásahu.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Prílohy sa nepodarilo nahrať.");
    } finally {
      setIsUploadingAttachment(false);
    }
  }

  async function openAttachment(attachmentId: string) {
    try {
      await openCaseAttachment(caseItem.id, attachmentId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Prílohu sa nepodarilo otvoriť.");
    }
  }

  async function linkSelectedCall() {
    if (!selectedCall || !onLinkCall || linkingCallSessionId) return;

    setLinkingCallSessionId(selectedCall.sessionId);
    setNotice(null);
    try {
      const linked = await onLinkCall(selectedCall, caseItem.id);
      if (linked) {
        const number = formatPhoneNumberForDisplay(selectedCall.number) || selectedCall.number || "Neznáme číslo";
        setNotice(`Hovor ${number} je priradený k prípadu ${caseItem.caseNumber}.`);
      }
    } finally {
      setLinkingCallSessionId(null);
    }
  }

  return (
    <div className={`${styles.surface} ${styles.detail} grid min-w-0 max-w-full overflow-x-clip @container`}>
      {!embedded && <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={styles.caseNumber}>{caseItem.caseNumber}</h2>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${caseStatusTone[caseItem.status]}`}>
              {caseStatusLabels[caseItem.status]}
            </span>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200">
              {casePriorityLabels[caseItem.priority]}
            </span>
          </div>
          <p className="mt-1 text-xs font-medium text-zinc-500">
            {caseItem.caseType || "Typ nezadaný"} · dispečer: {caseItem.ownerName ?? "nepriradený"} · založené {formatDateTime(caseItem.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {routePlan ? (
            <div className="rounded-md bg-[#FCD703] px-3 py-2 text-sm font-semibold text-zinc-950">
              {routePlan.totalOperationalKm} km · {routePlan.totalEta} min
            </div>
          ) : (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">Trasa nezadaná</div>
          )}
          {isEditing && editorControls && <CaseEditorHeader controls={editorControls} />}
          {showInlineEditButton && (
            <button type="button" onClick={() => setEditing(!isEditing)} disabled={isEditSaveLocked} className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:cursor-wait disabled:bg-zinc-100 disabled:text-zinc-400">
              {isEditing ? <X size={16} /> : <Edit3 size={16} />}
              {isEditing ? "Zavrieť editáciu" : "Upraviť"}
            </button>
          )}
        </div>
      </div>}

      <CaseSummary caseItem={caseItem} assets={assets} operators={operators} identityInHeader={embedded && Boolean(onEditorControlsChange)} />

      {notice && <div role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">{notice}</div>}

      {onLinkCall && callLinkCandidates.length > 0 && selectedCall && (
        <section className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 shadow-sm" aria-labelledby={`case-call-link-${caseItem.id}`}>
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[#FCD703] text-zinc-950">
              <PhoneIncoming size={17} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 id={`case-call-link-${caseItem.id}`} className="text-sm font-bold text-zinc-950">Priradiť prichádzajúci hovor</h3>
              <p className="mt-0.5 text-xs leading-5 text-zinc-600">Telefónne číslo sa s touto kartou neprepája automaticky. Vyberte hovor a potvrďte priradenie.</p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <select
                  value={selectedCall.sessionId}
                  onChange={(event) => setSelectedCallSessionId(event.target.value)}
                  aria-label="Aktívny prichádzajúci hovor"
                  className="h-9 min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 text-xs font-semibold text-zinc-800 outline-none ring-yellow-400 focus:ring-2"
                >
                  {callLinkCandidates.map((call) => {
                    const number = formatPhoneNumberForDisplay(call.number) || call.number || "Neznáme číslo";
                    return <option key={call.sessionId} value={call.sessionId}>{number} · {call.lineLabel}</option>;
                  })}
                </select>
                <button
                  type="button"
                  onClick={() => void linkSelectedCall()}
                  disabled={!selectedCall.callId || linkingCallSessionId !== null}
                  title={selectedCall.callId ? "Priradiť vybraný hovor k tomuto prípadu" : "Hovor sa dá priradiť po zápise do call logu"}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-xs font-bold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:bg-zinc-300 disabled:text-zinc-600"
                >
                  {linkingCallSessionId === selectedCall.sessionId ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Link2 size={15} aria-hidden="true" />}
                  Priradiť k prípadu
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {caseItem.customerSharedLocation && (
        <section className={styles.gps} aria-label="Doplnková GPS poloha od klienta">
          <div className={styles.gpsInformation}>
            <span className={styles.gpsIcon}><MapPin size={15} aria-hidden="true" /></span>
            <div className="min-w-0">
              <div className={styles.gpsTitle}>
                <h3>GPS od klienta</h3>
                <span className={styles.gpsCoordinates}>{caseItem.customerSharedLocation.lat}, {caseItem.customerSharedLocation.lng}</span>
              </div>
              <p className={styles.gpsCaption}>
                Prijaté {formatDateTime(caseItem.customerSharedLocation.submittedAt)}
                {caseItem.customerSharedLocation.accuracyMeters !== undefined ? ` · presnosť približne ${Math.round(caseItem.customerSharedLocation.accuracyMeters)} m` : ""}
              </p>
              <p className={styles.gpsCaption}>
                Doplnková poloha. Miesto incidentu, trasa a ETA sa zmenia až po potvrdení.
              </p>
            </div>
          </div>
          <div className={styles.gpsActions}>
            <UseCustomerLocationButton caseId={caseItem.id} location={caseItem.customerSharedLocation}
              disabled={draftDirty || isEditSaveLocked || isRunningAction} onNotice={setNotice}
              onApplied={(data) => { onDataChange?.(data); setEditorRevision((revision) => revision + 1); }} />
            {customerLocationMapsUrl && (
              <a href={customerLocationMapsUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md bg-sky-700 px-3 text-xs font-semibold text-white hover:bg-sky-800">
                <Navigation size={15} /> Otvoriť GPS
              </a>
            )}
          </div>
        </section>
      )}

          <details open={Boolean(focusedTaskId)} data-testid="case-tasks" className={`group ${styles.section}`} aria-labelledby="case-tasks-heading">
            <summary className={`${styles.sectionHeader} cursor-pointer`}>
              <span id="case-tasks-heading" className={styles.sectionTitle}>Úlohy prípadu <span className={styles.sectionHelp}>· {openTasks.length} otvorených · {openTasks.filter((task) => isTaskOverdue(task)).length} po termíne</span></span>
              <span className="flex shrink-0 items-center gap-2">
                <span className={`${styles.sectionHelp} group-open:hidden`}>Pridať úlohu</span>
                <ChevronDown size={14} className="shrink-0 text-zinc-500 transition-transform group-open:rotate-180" aria-hidden="true" />
              </span>
            </summary>
            <div className="grid min-w-0 gap-3 p-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
              <div className="grid min-w-0 content-start gap-2">
                {displayedTasks.length > 0 ? displayedTasks.map((task) => {
                  const focused = task.id === focusedTaskId;
                  const assignee = operators.find((operator) => operator.id === task.assignedTo)?.name ?? (task.assignedTo === "unassigned" ? "Nepriradené" : "Neznáma osoba");

                  return (
                    <div
                      key={task.id}
                      id={`task-${task.id}`}
                      className={`min-w-0 rounded-md border p-2.5 transition ${focused ? "border-yellow-400 bg-yellow-50 ring-2 ring-yellow-200" : "border-zinc-200 bg-zinc-50"}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          {focused && <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-amber-800">Otvorená úloha</div>}
                          <div className="break-words text-sm font-semibold text-zinc-950">{task.title}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-zinc-500">
                            <span>{formatTime(task.dueAt)} · {assignee}</span>
                            {isTaskOverdue(task) && <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 ring-1 ring-red-200">Po termíne</span>}
                          </div>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${taskPriorityTone[task.priority]}`}>{taskPriorityLabels[task.priority]}</span>
                      </div>
                      {isTaskOpen(task) ? (
                        <button type="button" onClick={() => void postAction({ action: "complete_task", taskId: task.id }, "Úloha označená ako vybavená.")} className="mt-2 inline-flex h-11 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"><CheckCircle2 size={13} /> Vybaviť</button>
                      ) : (
                        <span className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-emerald-50 px-2 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200"><CheckCircle2 size={13} /> Úloha je vybavená</span>
                      )}
                    </div>
                  );
                }) : <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-6 text-center text-sm font-medium text-zinc-500">Prípad zatiaľ nemá otvorenú úlohu.</div>}
                {completedTasks.length > 0 && (
                  <details className="group rounded-md border border-zinc-200 bg-white">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-50 [&::-webkit-details-marker]:hidden">
                      <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={13} className="text-emerald-600" /> Vybavené úlohy ({completedTasks.length})</span>
                      <ChevronDown size={14} className="text-zinc-500 transition-transform group-open:rotate-180" aria-hidden="true" />
                    </summary>
                    <div className="grid gap-1.5 border-t border-zinc-200 p-2">
                      {completedTasks.map((task) => {
                        const completedBy = profileName(task.completedBy);
                        const assignedTo = task.assignedTo === "unassigned" ? "Nepriradené" : profileName(task.assignedTo) ?? "Neznáma osoba";

                        return (
                          <div key={task.id} id={`task-${task.id}`} className="min-w-0 rounded-md border border-zinc-200 bg-zinc-50 p-2">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0 break-words text-xs font-semibold text-zinc-800">{task.title}</div>
                              <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 ring-1 ring-emerald-200">Vybavené</span>
                            </div>
                            <div className="mt-1 text-[11px] text-zinc-500">
                              {assignedTo}
                              {task.completedAt ? ` · vybavené ${formatTime(task.completedAt)}` : ""}
                              {completedBy ? ` (${completedBy})` : ""}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}
              </div>

              <div className={`${styles.taskComposer} grid min-w-0 content-start rounded-md border border-zinc-200 bg-zinc-50`}>
                <h4 className="text-base font-semibold text-zinc-950">Pridať novú úlohu</h4>
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-zinc-700">
                  Názov úlohy
                  <textarea value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="Nová úloha" rows={3} className="min-h-24 w-full min-w-0 resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 text-base font-medium leading-6 text-zinc-950 outline-none ring-yellow-300 transition placeholder:font-normal placeholder:text-zinc-400 focus:ring-2" aria-label="Názov novej úlohy" />
                </label>
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Rýchle nastavenie termínu">
                  {taskDuePresets.map((preset) => (
                    <button key={preset.minutes} type="button" onClick={() => setTaskDueAt(dateTimeLocalInMinutes(preset.minutes))} className="h-9 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-100">{preset.label}</button>
                  ))}
                </div>
                <div className="grid min-w-0 gap-3">
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-zinc-700">
                    Termín
                    <input type="datetime-local" value={taskDueAt} onChange={(event) => setTaskDueAt(event.target.value)} className="h-11 w-full min-w-0 max-w-full overflow-hidden rounded-md border border-zinc-300 bg-white px-3 text-base font-medium text-zinc-950 outline-none ring-yellow-300 transition focus:ring-2" aria-label="Termín úlohy" />
                  </label>
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-zinc-700">
                    Zodpovedná osoba
                    <select value={taskAssignee} onChange={(event) => setTaskAssignee(event.target.value)} className="h-11 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 text-base font-medium text-zinc-950 outline-none ring-yellow-300 transition focus:ring-2" aria-label="Zodpovedná osoba">
                      <option value="unassigned">Nepriradené</option>
                      {assignableTaskOperators.map((operator) => <option key={operator.id} value={operator.id}>{operator.name}</option>)}
                      {taskAssignee !== "unassigned" && !assignableTaskOperators.some((operator) => operator.id === taskAssignee) && <option value={taskAssignee}>{taskAssignee === viewerProfileId ? "Ja (prihlásený)" : caseItem.ownerName ?? "Aktuálne priradená osoba"}</option>}
                    </select>
                  </label>
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-zinc-700">
                    Priorita
                    <select value={taskPriority} onChange={(event) => setTaskPriority(event.target.value as CasePriority)} className="h-11 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 text-base font-medium text-zinc-950 outline-none ring-yellow-300 transition focus:ring-2" aria-label="Priorita úlohy">
                      {taskPriorityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                </div>
                <label className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold text-zinc-700"><input type="checkbox" checked={sendTaskReminderEmail} onChange={(event) => setSendTaskReminderEmail(event.target.checked)} className="size-4 shrink-0 rounded border-zinc-300 text-zinc-950" />Email zodpovednej osobe</label>
                <button type="button" onClick={() => void createTask()} disabled={isRunningAction} className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:bg-zinc-300 disabled:text-zinc-600">{isRunningAction ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}Pridať úlohu</button>
              </div>
            </div>
          </details>

      {isEditing ? (
        <>
          <EditCaseForm
            onEditorControlsChange={onEditorControlsChange ?? setEditorControls}
            key={`${caseItem.id}:${editorRevision}`}
            caseItem={caseItem}
            commanderVehicles={commanderVehicles}
            compact={compactEditor}
            onDataChange={onDataChange}
            onDiscard={discardEditorDraft}
            onDirtyChange={updateDirtyState}
            onNotice={setNotice}
            onSaveDraftChange={handleEditorSaveDraft}
            onSavingChange={updateSavingState}
            partnerDirectory={partnerDirectory}
          />

        </>
      ) : (
        <div className="grid min-w-0 gap-3">
          <InfoPanel title="1. Základ prípadu" icon={ClipboardList}>
            <div className="grid min-w-0 gap-2 sm:grid-cols-2 @4xl:grid-cols-4">
              <InfoItem label="Typy zákazky" value={labelList(caseItem.jobTypes, jobTypeLabels)} required invalid={caseItem.jobTypes.length === 0} />
              <InfoItem label="Typ / zdroj" value={[caseItem.caseType, caseItem.sourceType].filter(Boolean).join(" · ")} required invalid={!caseItem.caseType || !caseItem.sourceType} />
              <InfoItem label="Priorita / stav" value={`${casePriorityLabels[caseItem.priority]} · ${caseStatusLabels[caseItem.status]}`} />
              <InfoItem label="Technika / vodič" value={selectedAsset ? `${selectedAsset.label}${selectedAsset.assignedDriverName ? ` · ${selectedAsset.assignedDriverName}` : ""}` : "Nepriradené"} />
              <InfoItem label="Ďalší krok" value={nextTask?.title ?? "Bez otvorenej úlohy"} detail={nextTask ? formatTime(nextTask.dueAt) : undefined} />
              <InfoItem
                label="Dispečer prípadu"
                value={caseItem.ownerName ?? "Nepriradený dispečer"}
                detail={caseItem.ownerName ? "Priradené automaticky podľa prihláseného používateľa." : undefined}
              />
              <InfoItem label="Vytvorené" value={formatDateTime(caseItem.createdAt)} detail={caseItem.ownerName ? `Založil ${caseItem.ownerName}` : undefined} />
              <InfoItem label="Posledná aktivita" value={formatTime(caseItem.updatedAt)} />
            </div>
          </InfoPanel>

          <InfoPanel title="2. Zákazník a kontakty" icon={UserRound}>
            <div className="grid min-w-0 gap-2 @xl:grid-cols-2 @4xl:grid-cols-4">
              <InfoItem label="Typ zákazníka" value={caseItem.customerDetails.type ? customerTypeLabels[caseItem.customerDetails.type] : ""} required />
              <InfoItem
                label="Zákazník"
                value={customerName}
                detail={customerDetail}
                required
                invalid={
                  !customerName.trim() ||
                  (caseItem.customerDetails.type === "company" && (!caseItem.customerDetails.companyName || !caseItem.customerDetails.companyIdNumber || Boolean(readOnlyFieldErrors.companyIdNumber))) ||
                  (caseItem.customerDetails.type === "insurance" && (!caseItem.customerDetails.assistanceServiceName || !caseItem.customerDetails.assistanceReference))
                }
              />
              <InfoItem label="Primárny kontakt" value={primaryContact?.name || caseItem.contact.name} detail={contactPhone || undefined} required invalid={Boolean(readOnlyFieldErrors.contactName || readOnlyFieldErrors.contactPhone)} />
              <InfoItem label="E-mail kontaktu" value={contactEmail} invalid={Boolean(readOnlyFieldErrors.contactEmail)} warningMessage={readOnlyFieldErrors.contactEmail} />
              <InfoItem label="Alternatívny kontakt" value={caseItem.customerDetails.alternativeContact ?? ""} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Action icon={Phone} label="Zavolať" onClick={() => void runAction("call_customer")} disabled={!contactPhone || isRunningAction} disabledReason="Najprv doplňte telefónne číslo." />
              <Action icon={MessageSquareText} label="Vyžiadať polohu SMS" onClick={() => void runAction("send_sms")} disabled={!contactPhone || isRunningAction} disabledReason="Najprv doplňte telefónne číslo." />
              <Action icon={MessageSquareText} label="Napísať SMS" onClick={() => { setSmsTemplate("custom"); setSmsComposerOpen(true); }} disabled={isRunningAction} />
            </div>
            <p className="text-xs leading-5 text-zinc-500">Žiadosť o polohu pošle pripravený bezpečný link. Prijatá GPS sa uloží ako doplnková informácia a neprepíše miesto incidentu.</p>
            {!contactPhone && <p className="text-xs font-medium text-amber-800">Volanie a žiadosť o polohu sa sprístupnia po doplnení telefónneho čísla. Vlastnú SMS môžete poslať aj na ručne zadané číslo.</p>}
          </InfoPanel>

          <InfoPanel title="3. Vozidlo a incident" icon={CarFront}>
            <div className="grid min-w-0 gap-2 @xl:grid-cols-2 @4xl:grid-cols-4">
              <InfoItem label="EČV" value={caseItem.vehicle.licensePlate} required invalid={Boolean(readOnlyFieldErrors.licensePlate)} warningMessage={readOnlyFieldErrors.licensePlate} />
              <InfoItem label="VIN" value={caseItem.vehicle.vin ?? ""} invalid={Boolean(readOnlyFieldErrors.vin)} warningMessage={readOnlyFieldErrors.vin} />
              <InfoItem label="Značka / model" value={[caseItem.vehicle.make, caseItem.vehicle.model].filter(Boolean).join(" ")} />
              <InfoItem label="Technické údaje" value={[caseItem.vehicle.productionYear, caseItem.vehicle.color, caseItem.vehicle.vehicleType ? clientVehicleTypeLabels[caseItem.vehicle.vehicleType] : undefined].filter(Boolean).join(" · ")} />
              <InfoItem label="Prevodovka / pohon" value={[caseItem.vehicle.transmission ? transmissionLabels[caseItem.vehicle.transmission] : undefined, caseItem.vehicle.driveType].filter(Boolean).join(" · ")} />
              <InfoItem label="Opis problému / situácie" value={caseItem.vehicle.issue || caseItem.incidentDetails.description || ""} detail={caseItem.vehicle.note ?? labelList(caseItem.vehicle.conditionFlags, vehicleConditionFlagLabels)} required invalid={Boolean(readOnlyFieldErrors.vehicleIssue)} />
              <InfoItem label="Pojazdnosť" value={caseItem.vehicle.conditionFlags.includes("driveable") ? "Pojazdné" : caseItem.vehicle.conditionFlags.includes("immobile") ? "Nepojazdné" : ""} required invalid={!driveabilitySelected} />
              <InfoItem label="Typ incidentu" value={caseItem.incidentDetails.type ? incidentTypeLabels[caseItem.incidentDetails.type] : ""} required />
              <InfoItem label="Účastníci / pasažieri" value={[caseItem.incidentDetails.participantsCount, caseItem.incidentDetails.passengersCount].some((value) => value !== undefined) ? `${caseItem.incidentDetails.participantsCount ?? "–"} / ${caseItem.incidentDetails.passengersCount ?? "–"}` : ""} />
              <InfoItem label="Poškodenia" value={labelList(caseItem.incidentDetails.damageAreas, damageAreaLabels)} detail={caseItem.incidentDetails.damageNote ?? caseItem.incidentDetails.damages} />
            </div>
          </InfoPanel>

          <InfoPanel title="4. Miesto a cieľ" icon={MapPin}>
            <div className="grid min-w-0 gap-2 @xl:grid-cols-2 @4xl:grid-cols-4">
              <InfoItem
                label="Miesto incidentu"
                value={caseItem.pickup?.address || caseItem.locationDetails.manualPickupAddress || ""}
                detail={caseItem.pickup?.label || (caseItem.locationDetails.manualPickupAddress ? "Ručne zadané bez súradníc" : undefined)}
                required
                invalid={!caseItem.pickup && (caseItem.locationDetails.manualPickupAddress?.trim().length ?? 0) < 3}
              />
              <InfoItem
                label="Cieľ odťahu"
                value={caseItem.destination?.address || caseItem.locationDetails.manualDestinationAddress || ""}
                detail={caseItem.destination?.label || (caseItem.locationDetails.manualDestinationAddress ? "Ručne zadané bez súradníc" : undefined)}
                required={requiresTowDestination(caseItem.jobTypes)}
                invalid={requiresTowDestination(caseItem.jobTypes) && !caseItem.destination && (caseItem.locationDetails.manualDestinationAddress?.trim().length ?? 0) < 3}
              />
              <InfoItem label="Cesta / km / smer" value={[caseItem.locationDetails.roadName, caseItem.locationDetails.kilometerSection, caseItem.locationDetails.drivingDirection].filter(Boolean).join(" · ")} />
              <InfoItem label="Komplikácie" value={labelList(caseItem.locationDetails.accessComplications, accessComplicationLabels)} detail={caseItem.locationDetails.complications} />
              <InfoItem label="Trasa" value={routePlan ? `${routePlan.totalOperationalKm} km · ${routePlan.totalEta} min` : ""} detail={!routePlan ? "Doplňte miesto zásahu; dovtedy sa trasa ani ETA nepočítajú." : undefined} />
              {caseItem.customerSharedLocation && (
                <InfoItem
                  label="GPS od klienta"
                  value={`${caseItem.customerSharedLocation.lat}, ${caseItem.customerSharedLocation.lng}`}
                  detail={`Prijaté ${formatDateTime(caseItem.customerSharedLocation.submittedAt)}${caseItem.customerSharedLocation.accuracyMeters !== undefined ? ` · presnosť ${Math.round(caseItem.customerSharedLocation.accuracyMeters)} m` : ""}`}
                />
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {mapsUrl ? (
                <a href={mapsUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50">
                  <Navigation size={15} /> Navigovať
                </a>
              ) : (
                <Action icon={Navigation} label="Navigovať" onClick={() => setNotice("Navigácia nie je dostupná, kým nie je doplnené miesto zásahu.")} disabled disabledReason="Najprv doplňte miesto zásahu." />
              )}
              <Action icon={MessageSquareText} label="Poslať ETA" onClick={() => void runAction("send_eta")} disabled={!contactPhone || !caseItem.pickup || !routePlan || !routeEta || isRunningAction} disabledReason={!contactPhone ? "Najprv doplňte telefónne číslo." : "Najprv doplňte miesto zásahu a trasu."} />
              {customerLocationMapsUrl && (
                <a href={customerLocationMapsUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100">
                  <MapPin size={15} /> Otvoriť GPS od klienta
                </a>
              )}
            </div>
            {(!caseItem.pickup || !routePlan) && <p className="text-xs font-medium text-amber-800">Navigácia a ETA sa sprístupnia po doplnení použiteľného miesta zásahu.</p>}
          </InfoPanel>

          <InfoPanel title="5. Doplnky" icon={ReceiptText}>
            <div className="grid min-w-0 gap-3 @3xl:grid-cols-2">
              <div className="grid min-w-0 content-start gap-2 sm:grid-cols-2">
                <InfoItem
                  label="Náhradné vozidlo"
                  value={caseItem.replacementVehicle.needed ? "Áno" : "Nie"}
                  detail={[
                    caseItem.replacementVehicle.category ? replacementCategoryLabels[caseItem.replacementVehicle.category] : undefined,
                    caseItem.replacementVehicle.requestedType,
                    labelList(caseItem.replacementVehicle.preferences, replacementPreferenceLabels),
                    caseItem.replacementVehicle.deliveryPlace ? `Pristavenie: ${caseItem.replacementVehicle.deliveryPlace}` : undefined,
                  ].filter((value) => value && value !== "Nezadané").join(" · ")}
                />
                {caseItem.replacementVehicle.needed && (
                  <InfoItem
                    label="Nárok a rozsah"
                    value={caseItem.replacementVehicle.entitlement ? replacementEntitlementLabels[caseItem.replacementVehicle.entitlement] : "Nárok nezadaný"}
                    detail={[
                      caseItem.replacementVehicle.extensionPossible === undefined ? undefined : caseItem.replacementVehicle.extensionPossible ? "Predĺženie možné" : "Bez predĺženia",
                      caseItem.replacementVehicle.maxDays ? `max ${caseItem.replacementVehicle.maxDays} dní` : undefined,
                    ].filter(Boolean).join(" · ")}
                  />
                )}
                {caseItem.replacementVehicle.needed && (
                  <InfoItem
                    label="Poskytnutie náhr. vozidla"
                    value={caseItem.replacementVehicle.provisionStatus ? replacementProvisionLabels[caseItem.replacementVehicle.provisionStatus] : "Nerozhodnuté"}
                    detail={caseItem.replacementVehicle.provisionReason}
                  />
                )}
                <InfoItem label="Platba" value={caseItem.paymentDetails.method ? paymentMethodLabels[caseItem.paymentDetails.method] : ""} detail={caseItem.paymentDetails.status ? paymentStatusLabels[caseItem.paymentDetails.status] : undefined} required invalid={!caseItem.paymentDetails.method || !caseItem.paymentDetails.status} />
                <InfoItem label="Ukončenie" value={caseItem.closureDetails.status ?? ""} detail={closureType ? closureTypeLabels[closureType] : undefined} />
                <InfoItem label="Interná poznámka" value={caseItem.mainNote} />
              </div>

              <div className="grid min-w-0 content-start gap-3">
                <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                  <h4 className="text-sm font-semibold text-zinc-950">Prílohy a komunikácia</h4>
                  <div className="mt-2 grid gap-2">
                    {caseItem.attachments.slice(0, 3).map((attachment, index) => (
                      <div key={attachment.id ?? `${attachment.fileName}-${index}`} className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs">
                        <span className="min-w-0 truncate font-semibold text-zinc-800">{attachment.fileName}</span>
                        {attachment.id && attachment.storagePath && <button type="button" onClick={() => void openAttachment(attachment.id!)} className="shrink-0 rounded-md border border-zinc-200 bg-white p-1 text-zinc-600 hover:bg-zinc-100" aria-label="Otvoriť prílohu"><Download size={13} /></button>}
                      </div>
                    ))}
                    {caseItem.attachments.length === 0 && <div className="text-xs font-medium text-zinc-500">Bez príloh.</div>}
                    {caseItem.attachments.length > 3 && <div className="text-xs font-medium text-zinc-500">+{caseItem.attachments.length - 3} ďalších v úprave karty zásahu.</div>}
                  </div>
                  <label className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-zinc-300 bg-white px-2 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"><FileUp size={15} />Pridať súbor<input type="file" multiple accept={CASE_ATTACHMENT_ACCEPT} className="sr-only" onChange={(event) => handleAttachmentFiles(event.target.files)} /></label>
                  {pendingAttachmentFiles.length > 0 && (
                    <div className="mt-2 grid gap-1.5">
                      {pendingAttachmentFiles.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs"><span className="min-w-0 truncate">{file.name}</span><button type="button" onClick={() => setPendingAttachmentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="text-zinc-500 hover:text-zinc-900" aria-label="Odobrať prílohu"><X size={13} /></button></div>)}
                      <textarea value={attachmentUploadNote} onChange={(event) => setAttachmentUploadNote(event.target.value)} placeholder="Poznámka k prílohám" className="min-h-14 min-w-0 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs outline-none ring-yellow-300 transition focus:ring-2" />
                      <button type="button" onClick={() => void uploadAttachments()} disabled={isUploadingAttachment} className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-zinc-950 px-2 text-xs font-semibold text-white hover:bg-zinc-800 disabled:bg-zinc-300 disabled:text-zinc-600">{isUploadingAttachment ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}Nahrať</button>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Action icon={Navigation} label="ETA" onClick={() => void runAction("send_eta")} disabled={!contactPhone || !caseItem.pickup || !routePlan || !routeEta || isRunningAction} disabledReason="ETA vyžaduje telefón, miesto a trasu." />
                  <Action icon={FileText} label="PDF" onClick={() => void runAction("create_pdf")} disabled={isRunningAction} />
                  <Action icon={ReceiptText} label="Faktúra" onClick={() => void runAction("invoice")} disabled={isRunningAction} />
                  <Action icon={CheckCircle2} label="Dokončiť" onClick={() => void runAction("mark_completed")} disabled={isRunningAction} />
                </div>
              </div>
            </div>
          </InfoPanel>
        </div>
      )}
      {!hideNotesAndActivity && (
        <CaseNotesAndActivity busy={isRunningAction} timeline={caseItem.timeline} onAddNote={(note) => postAction({ action: "add_note", note }, "Poznámka pridaná.")} />
      )}
      <CaseSmsHistory key={caseItem.id} caseId={caseItem.id} />
      <SmsComposerDialog
        initialTemplate={smsTemplate}
        caseId={caseItem.id}
        caseNumber={caseItem.caseNumber}
        initialPhone={contactPhone}
        locationPhone={contactPhone}
        onClose={() => setSmsComposerOpen(false)}
        onSent={(result) => {
          if (result.dispatchData) onDataChange?.(result.dispatchData);
          setNotice("Výsledok SMS požiadavky nájdete v histórii SMS.");
        }}
        open={smsComposerOpen}
      />
    </div>
  );
}

type CaseTimelineEntry = DispatchCase["timeline"][number];

const ACTIVITY_PREVIEW_LIMIT = 8;

/** Poznámky (interný chat, P-02) a história aktivít prípadu (P-01). */
export function CaseNotesAndActivity({
  busy,
  onAddNote,
  timeline,
}: {
  busy: boolean;
  onAddNote: (note: string) => Promise<boolean>;
  timeline: CaseTimelineEntry[];
}) {
  const [noteText, setNoteText] = useState("");
  const notes = timeline
    .filter((event) => event.type === "note_added")
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
  const activity = timeline
    .filter((event) => event.type !== "note_added")
    .sort((left, right) => new Date(right.time).getTime() - new Date(left.time).getTime());
  const visibleActivity = activity.slice(0, ACTIVITY_PREVIEW_LIMIT);
  const olderActivity = activity.slice(ACTIVITY_PREVIEW_LIMIT);

  async function submitNote() {
    const note = noteText.trim();

    if (!note || busy) {
      return;
    }

    const saved = await onAddNote(note);

    if (saved) {
      setNoteText("");
    }
  }

  return (
    <section className={styles.section} aria-labelledby="case-notes-heading">
      <div className={styles.sectionHeader}>
        <h3 id="case-notes-heading" className={styles.sectionTitle}>Poznámky a aktivita</h3>
        <span className={styles.sectionHelp}>Interná komunikácia a história</span>
      </div>
      {/* Panel je na celú šírku karty: na širokej obrazovke poznámky a aktivita vedľa seba,
          na úzkej sa zalomia pod seba. */}
      <div className="grid min-w-0 gap-4 p-3 @3xl:grid-cols-2">
        <div className="grid min-w-0 content-start gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Poznámky</h4>
          {notes.length > 0 ? (
            <div className="grid max-h-80 gap-2.5 overflow-y-auto pr-1">
              {notes.map((note) => (
                <div key={note.id} className="flex min-w-0 items-start gap-2">
                  <span aria-hidden="true" className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-[10px] font-bold text-white">
                    {actorInitials(note.actor)}
                  </span>
                  <div className="min-w-0 flex-1 rounded-md rounded-tl-none border border-zinc-200 bg-zinc-50 px-2.5 py-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-xs font-semibold text-zinc-950">{note.actor}</span>
                      <span className="text-[10px] font-medium text-zinc-500">{formatDateTime(note.time)}</span>
                    </div>
                    <p className="mt-0.5 whitespace-pre-line break-words text-sm leading-5 text-zinc-800">{note.body}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-4 text-center text-xs font-medium text-zinc-500">
              Zatiaľ bez poznámok. Napíš prvú — uvidí ju celý tím.
            </div>
          )}
          <div className="grid gap-1.5">
            <textarea
              value={noteText}
              onChange={(event) => setNoteText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void submitNote();
                }
              }}
              placeholder="Napíš internú poznámku k prípadu…"
              className="min-h-16 min-w-0 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-base outline-none ring-yellow-300 transition focus:ring-2"
              aria-label="Nová poznámka k prípadu"
            />
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
              <span className="text-[10px] font-medium text-zinc-400">Ctrl+Enter odošle</span>
              <button
                type="button"
                onClick={() => void submitNote()}
                disabled={busy || noteText.trim().length === 0}
                className="inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-zinc-950 px-3 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
              >
                {busy ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <Plus size={13} className="shrink-0" />}
                Pridať poznámku
              </button>
            </div>
          </div>
        </div>

        <div className="grid min-w-0 content-start gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Aktivita prípadu</h4>
          {activity.length > 0 ? (
            <div className="grid max-h-80 gap-1.5 overflow-y-auto pr-1">
              {visibleActivity.map((event) => <ActivityRow key={event.id} event={event} />)}
              {olderActivity.length > 0 && (
                <details className="group">
                  <summary className="cursor-pointer list-none rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 [&::-webkit-details-marker]:hidden">
                    Zobraziť staršiu aktivitu ({olderActivity.length})
                  </summary>
                  <div className="mt-1.5 grid gap-1.5">
                    {olderActivity.map((event) => <ActivityRow key={event.id} event={event} />)}
                  </div>
                </details>
              )}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-4 text-center text-xs font-medium text-zinc-500">
              Zatiaľ bez zaznamenanej aktivity.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ActivityRow({ event }: { event: CaseTimelineEntry }) {
  return (
    <div className="min-w-0 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px] font-medium text-zinc-500">
        <span>{formatDateTime(event.time)}</span>
        <span className="font-semibold text-zinc-700">{event.actor}</span>
      </div>
      <div className="mt-0.5 text-xs font-semibold text-zinc-900">{event.title}</div>
      {event.body && <div className="break-words text-xs leading-4 text-zinc-600">{event.body}</div>}
    </div>
  );
}

function actorInitials(actor: string) {
  const parts = actor.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return "?";
  }

  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function EditCaseForm({
  onEditorControlsChange,
  caseItem,
  commanderVehicles,
  compact,
  onDataChange,
  onDiscard,
  onDirtyChange,
  onNotice,
  onSaveDraftChange,
  onSavingChange,
  partnerDirectory,
}: {
  onEditorControlsChange?: (controls: CaseEditorControls | null) => void;
  caseItem: DispatchCase;
  commanderVehicles: CommanderVehicleConnection[];
  compact: boolean;
  onDataChange?: (dispatchData: DispatchData) => void;
  onDiscard: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onNotice: (message: string) => void;
  onSaveDraftChange?: (saveDraft: SaveCaseDraft | null) => void;
  onSavingChange?: (saving: boolean) => void;
  partnerDirectory: PartnerDirectoryEntry[];
}) {
  const [selectedJobTypes, setSelectedJobTypes] = useState<JobType[]>(caseItem.jobTypes);
  const [priority, setPriority] = useState<CasePriority>(caseItem.priority);
  const [sourceType, setSourceType] = useState<NonNullable<DispatchCase["sourceType"]> | "">(caseItem.sourceType ?? "");
  const [contacts, setContacts] = useState<ContactDraft[]>(() => contactsFromCase(caseItem));
  const [customerType, setCustomerType] = useState<CustomerType | "">(caseItem.customerDetails.type ?? "private_person");
  const [companyName, setCompanyName] = useState(caseItem.customerDetails.companyName ?? "");
  const [companyIdNumber, setCompanyIdNumber] = useState(caseItem.customerDetails.companyIdNumber ?? "");
  const [assistanceServiceName, setAssistanceServiceName] = useState(caseItem.customerDetails.assistanceServiceName ?? "");
  const [assistanceReference, setAssistanceReference] = useState(caseItem.customerDetails.assistanceReference ?? "");
  const [partnerDirectoryId, setPartnerDirectoryId] = useState(caseItem.customerDetails.partnerDirectoryId ?? "");
  const [customerNote, setCustomerNote] = useState(caseItem.customerDetails.note ?? "");
  const [licensePlate, setLicensePlate] = useState(caseItem.vehicle.licensePlate);
  const [vin, setVin] = useState(caseItem.vehicle.vin ?? "");
  const [vehicleLookup, setVehicleLookup] = useState<VehicleLookupSnapshot | null>(caseItem.vehicle.vehicleLookup ?? null);
  const [vehicleMake, setVehicleMake] = useState(caseItem.vehicle.make);
  const [vehicleModel, setVehicleModel] = useState(caseItem.vehicle.model);
  const [vehicleCategory, setVehicleCategory] = useState(caseItem.vehicle.category);
  const [vehicleType, setVehicleType] = useState<ClientVehicleType | "">(caseItem.vehicle.vehicleType ?? "");
  const [transmission, setTransmission] = useState<VehicleTransmission | "">(caseItem.vehicle.transmission ?? "");
  const [transmissionNote, setTransmissionNote] = useState("");
  const [driveType, setDriveType] = useState(caseItem.vehicle.driveType ?? "");
  const [weightKg, setWeightKg] = useState(caseItem.vehicle.weightKg ? String(caseItem.vehicle.weightKg) : "");
  const [productionYear, setProductionYear] = useState(caseItem.vehicle.productionYear ? String(caseItem.vehicle.productionYear) : "");
  const [vehicleColor, setVehicleColor] = useState(caseItem.vehicle.color ?? "");
  const [vehicleIssue, setVehicleIssue] = useState(caseItem.vehicle.issue || caseItem.incidentDetails.description || "");
  const [vehicleDriveable, setVehicleDriveable] = useState<boolean | null>(() => {
    if (caseItem.vehicle.conditionFlags.includes("driveable")) return true;
    if (caseItem.vehicle.conditionFlags.includes("immobile")) return false;
    return null;
  });
  const [vehicleFlags, setVehicleFlags] = useState<VehicleConditionFlag[]>(caseItem.vehicle.conditionFlags);
  const [vehicleNote, setVehicleNote] = useState(caseItem.vehicle.note ?? "");
  const [incidentType, setIncidentType] = useState<IncidentType | "">(caseItem.incidentDetails.type ?? "");
  const [participantsCount, setParticipantsCount] = useState(caseItem.incidentDetails.participantsCount ? String(caseItem.incidentDetails.participantsCount) : "");
  const [passengersCount, setPassengersCount] = useState(caseItem.incidentDetails.passengersCount ? String(caseItem.incidentDetails.passengersCount) : "");
  const [selectedDamageAreas, setSelectedDamageAreas] = useState<DamageArea[]>(caseItem.incidentDetails.damageAreas);
  const [damageNote, setDamageNote] = useState(caseItem.incidentDetails.damageNote ?? caseItem.incidentDetails.damages ?? "");
  const [pickup, setPickup] = useState<PlaceSelectionInput | null>(() => placeFromLocation(caseItem.pickup));
  const [destination, setDestination] = useState<PlaceSelectionInput | null>(() => placeFromDestination(caseItem.destination));
  const [manualPickupAddress, setManualPickupAddress] = useState(caseItem.locationDetails.manualPickupAddress ?? "");
  const [manualDestinationAddress, setManualDestinationAddress] = useState(caseItem.locationDetails.manualDestinationAddress ?? "");
  const [roadName, setRoadName] = useState(caseItem.locationDetails.roadName ?? "");
  const [kilometerSection, setKilometerSection] = useState(caseItem.locationDetails.kilometerSection ?? "");
  const [drivingDirection, setDrivingDirection] = useState(caseItem.locationDetails.drivingDirection ?? "");
  const [placeType, setPlaceType] = useState<PlaceType | "">(caseItem.locationDetails.placeType ?? "");
  const [locationComplications, setLocationComplications] = useState(caseItem.locationDetails.complications ?? "");
  const [selectedAccessComplications, setSelectedAccessComplications] = useState<AccessComplication[]>(caseItem.locationDetails.accessComplications);
  const [destinationNote, setDestinationNote] = useState(caseItem.locationDetails.destinationNote ?? "");
  const [replacementVehicleNeeded, setReplacementVehicleNeeded] = useState(caseItem.replacementVehicle.needed);
  const [replacementVehicleType, setReplacementVehicleType] = useState(caseItem.replacementVehicle.requestedType ?? "");
  const [selectedReplacementPreferences, setSelectedReplacementPreferences] = useState<ReplacementVehiclePreference[]>(caseItem.replacementVehicle.preferences);
  const [replacementVehicleNote, setReplacementVehicleNote] = useState(caseItem.replacementVehicle.note ?? "");
  const [replacementProvisionStatus, setReplacementProvisionStatus] = useState<"" | ReplacementVehicleProvisionStatus>(caseItem.replacementVehicle.provisionStatus ?? "");
  const [replacementProvisionReason, setReplacementProvisionReason] = useState(caseItem.replacementVehicle.provisionReason ?? "");
  const [replacementCategory, setReplacementCategory] = useState<"" | ReplacementVehicleCategory>(caseItem.replacementVehicle.category ?? "");
  const [replacementDeliveryPlace, setReplacementDeliveryPlace] = useState(caseItem.replacementVehicle.deliveryPlace ?? "");
  const [replacementEntitlement, setReplacementEntitlement] = useState<"" | ReplacementVehicleEntitlement>(caseItem.replacementVehicle.entitlement ?? "");
  const [replacementExtension, setReplacementExtension] = useState<"" | "yes" | "no">(
    caseItem.replacementVehicle.extensionPossible === undefined ? "" : caseItem.replacementVehicle.extensionPossible ? "yes" : "no",
  );
  const [replacementMaxDays, setReplacementMaxDays] = useState(caseItem.replacementVehicle.maxDays ? String(caseItem.replacementVehicle.maxDays) : "");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | "">(caseItem.paymentDetails.method ?? "");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus | "">(caseItem.paymentDetails.status ?? "");
  const [closureType, setClosureType] = useState<ClosureType | "">(caseItem.closureDetails.type ?? "");
  const [closureStatus, setClosureStatus] = useState(caseItem.closureDetails.status ?? "");
  // Ukončovací stav prípadu je AKCIA, nie zrkadlo aktuálneho stavu: štartuje vždy prázdny,
  // takže autosave nikdy neposiela status, kým ho dispečer vedome nezvolí. Predvyplnenie by
  // spôsobilo, že rozpracovaná karta prepíše stav zmenený medzitým inde (napr. priradenie techniky).
  const [caseClosureStatus, setCaseClosureStatus] = useState<"" | CaseClosureStatus>("");
  const [insurancePortalUrl, setInsurancePortalUrl] = useState(caseItem.closureDetails.insurancePortalUrl ?? "");
  const [closureNote, setClosureNote] = useState(caseItem.closureDetails.note ?? "");
  const [note, setNote] = useState(caseItem.mainNote);
  const [attachments, setAttachments] = useState<CaseAttachmentInput[]>(
    caseItem.attachments.map((attachment) => ({
      category: attachment.category,
      createdAt: attachment.createdAt,
      fileName: attachment.fileName,
      id: attachment.id,
      mimeType: attachment.mimeType,
      note: attachment.note,
      sizeBytes: attachment.sizeBytes,
      storageBucket: attachment.storageBucket,
      storagePath: attachment.storagePath,
    })),
  );
  const [attachmentCategory, setAttachmentCategory] = useState<CaseAttachmentInput["category"]>("photo");
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [attachmentNote, setAttachmentNote] = useState("");
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [savePhase, setSavePhase] = useState<CaseSavePhase>("idle");
  const [saveSlow, setSaveSlow] = useState(false);
  const [saveAttempt, setSaveAttempt] = useState(0);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (!lastSavedAt) return;
    const timer = window.setTimeout(() => setLastSavedAt(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [lastSavedAt]);
  const [retryToken, setRetryToken] = useState(0);
  const [refreshOnlyRevision, setRefreshOnlyRevision] = useState<number | null>(null);
  const serverRevisionRef = useRef(caseItem.updatedAt);
  const conflictRef = useRef(false);
  const [conflict, setConflict] = useState(false);
  const acceptedDraftRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeRequestRef = useRef<AbortController | null>(null);
  const latestDraftRef = useRef<string | null>(null);
  const committedDraftRef = useRef<{ payload: string; revision: number } | null>(null);
  const saveDraftHandlerRef = useRef<SaveCaseDraft>(() => Promise.resolve(false));
  const [saveError, setSaveError] = useState<{ message: string; payload: string } | null>(null);
  const needsDestination = requiresTowDestination(selectedJobTypes);
  // Čisto NV prípad používa špecializovaný formulár bez odťahových polí (P-03/P-04).
  const replacementOnly = isReplacementVehicleOnlyCase(selectedJobTypes);
  const primaryContact = contacts.find((contact) => contact.isPrimary) ?? contacts[0];
  const contactName = contactDisplayName(primaryContact);
  const contactPhone = fullPhone(primaryContact);
  const contactEmail = primaryContact?.email ?? "";
  const caseType = caseTypeFromJobTypes(selectedJobTypes);
  const contactInputs: CaseContactInput[] = contacts
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
    }));
  const directoryOptions = partnerDirectory.filter((entry) =>
    customerType === "insurance" ? entry.kind === "assistance" && entry.active : customerType === "company" ? entry.kind === "company" && entry.active : false,
  );
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
    companyIdNumber,
    companyName,
    contactName,
    contactPhone,
    contactEmail,
    customerType,
    destinationSelected: hasPlaceValue(destination) || manualDestinationAddress.trim().length >= 3,
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
    pickupSelected: hasPlaceValue(pickup) || manualPickupAddress.trim().length >= 3,
    productionYear,
    replacementVehicleDeliveryPlace: replacementDeliveryPlace,
    replacementVehicleNeeded,
    replacementVehicleType,
    sourceType,
    vehicleDriveable,
    vehicleIssue,
    vin,
    weightKg,
  });
  const fieldErrors = formValidation.fieldErrors;
  const validationErrors = formValidation.errors;
  const draftPayload: UpdateCaseInput = {
    contactName,
    contactPhone,
    contactEmail,
    customerType: customerType || null,
    customerFirstName: primaryContact?.firstName,
    customerLastName: primaryContact?.lastName,
    companyName,
    companyIdNumber,
    assistanceServiceName,
    assistanceReference,
    partnerDirectoryId,
    contacts: contactInputs,
    alternativeContact: contactInputs[1]?.phone ?? "",
    customerNote,
    licensePlate,
    vin,
    vehicleLookup,
    vehicleMake,
    vehicleModel,
    vehicleCategory,
    vehicleType: vehicleType || null,
    productionYear: toOptionalNumber(productionYear),
    vehicleColor,
    transmission: transmission || null,
    driveType,
    weightKg: toOptionalNumber(weightKg),
    vehicleIssue,
    vehicleDriveable: vehicleDriveable ?? undefined,
    vehicleConditionFlags: vehicleDriveable === null ? vehicleFlags : normalizeVehicleConditionFlags(vehicleFlags, vehicleDriveable),
    vehicleNote: [transmissionNote ? `Prevodovka: ${transmissionNote}` : "", vehicleNote].filter(Boolean).join(" · "),
    caseType,
    jobTypes: selectedJobTypes,
    priority,
    sourceType: sourceType || null,
    pickup,
    destination: needsDestination ? destination : null,
    manualPickupAddress,
    manualDestinationAddress: needsDestination ? manualDestinationAddress : "",
    roadName,
    kilometerSection,
    drivingDirection,
    placeType: placeType || null,
    incidentDescription: vehicleIssue,
    incidentType: incidentType || null,
    participantsCount: toOptionalNumber(participantsCount),
    passengersCount: toOptionalNumber(passengersCount),
    damageAreas: selectedDamageAreas,
    damageNote,
    locationComplications,
    accessComplications: selectedAccessComplications,
    destinationNote,
    replacementVehicleNeeded,
    replacementVehicleType,
    replacementVehiclePreferences: replacementVehicleNeeded ? selectedReplacementPreferences : [],
    replacementVehicleNote,
    replacementVehicleCategory: replacementCategory || null,
    replacementVehicleDeliveryPlace: replacementDeliveryPlace,
    replacementVehicleEntitlement: replacementEntitlement || null,
    replacementVehicleExtensionPossible: replacementExtension === "" ? null : replacementExtension === "yes",
    replacementVehicleMaxDays: toOptionalNumber(replacementMaxDays),
    replacementVehicleProvisionStatus: replacementProvisionStatus || null,
    replacementVehicleProvisionReason: replacementProvisionReason,
    paymentMethod: paymentMethod || null,
    paymentStatus: paymentStatus || null,
    closureType: closureType || null,
    closureStatus,
    insurancePortalUrl,
    closureNote,
    note,
    attachmentMetadata: attachments,
    ...(caseClosureStatus ? { status: caseClosureStatus } : {}),
  };
  const serializedDraft = JSON.stringify(draftPayload);
  const [acceptedDraft, setAcceptedDraft] = useState(serializedDraft);
  const isDirty = serializedDraft !== acceptedDraft;
  const currentError = conflict ? "Prípad medzitým zmenil iný používateľ. Rozpracované údaje zostávajú v editore." : saveError?.payload === serializedDraft ? saveError.message : null;
  const displayedSavePhase: CaseSavePhase =
    savePhase === "saving" ? "saving" : currentError ? "error" : isDirty ? "waiting" : savePhase;
  const showSaveStatus = displayedSavePhase === "saving" || displayedSavePhase === "waiting" || displayedSavePhase === "error" || Boolean(lastSavedAt);

  useEffect(() => {
    if (acceptedDraftRef.current === null) acceptedDraftRef.current = serializedDraft;
    onEditorControlsChange?.({ priority, status: caseClosureStatus || caseItem.status, busy: savePhase === "saving" || conflict,
      onPriorityChange: setPriority, onStatusChange: setCaseClosureStatus });
  }, [priority, caseClosureStatus, caseItem.status, savePhase, conflict, onEditorControlsChange, serializedDraft]);

  useEffect(() => () => onEditorControlsChange?.(null), [onEditorControlsChange]);

  useEffect(() => {
    latestDraftRef.current = serializedDraft;
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange, serializedDraft]);

  useEffect(() => {
    onSavingChange?.(savePhase === "saving");
  }, [onSavingChange, savePhase]);

  useEffect(() => {
    if (!isDirty && savePhase !== "saving") {
      return;
    }

    const preventUnload = (event: BeforeUnloadEvent) => protectDraftBeforeUnload(event);
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [isDirty, savePhase]);

  useEffect(() => {
    return () => activeRequestRef.current?.abort();
  }, []);

  function setDriveable(nextDriveable: boolean) {
    setVehicleDriveable(nextDriveable);
    setVehicleFlags((current) => normalizeVehicleConditionFlags(current, nextDriveable));
  }

  function selectCustomerType(type: CustomerType) {
    setCustomerType(type);
    setPartnerDirectoryId("");

    if (type === "insurance") {
      setSourceType("assistance");
      setPaymentMethod("insurance");
      setPaymentStatus("waiting_for_insurance");
      setClosureType("insurance_portal");
      return;
    }

    if (type === "company") {
      setSourceType("partner");
      setPaymentMethod("invoice");
      setPaymentStatus("unpaid");
      setClosureType("self_payer");
      return;
    }

    setSourceType("client");
    setPaymentMethod("cash");
    setPaymentStatus("unpaid");
    setClosureType("self_payer");
  }

  function selectDirectoryEntry(entryId: string) {
    setPartnerDirectoryId(entryId);
    const entry = partnerDirectory.find((candidate) => candidate.id === entryId);

    if (!entry) {
      return;
    }

    if (entry.kind === "assistance") {
      setAssistanceServiceName(entry.name);
      setSourceType("assistance");
      setPaymentMethod("insurance");
      setPaymentStatus("waiting_for_insurance");
      setClosureType("insurance_portal");
    } else {
      setCompanyName(entry.name);
      setCompanyIdNumber(entry.ico ?? "");
      setSourceType("partner");
      setPaymentMethod("invoice");
    }
  }

  function addContact() {
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
    setContacts((current) => current.map((contact) => (contact.id === id ? { ...contact, ...patch } : contact)));
  }

  function removeContact(id: string) {
    setContacts((current) => {
      const next = current.filter((contact) => contact.id !== id);
      if (next.length === 0) {
        return current;
      }

      return next.some((contact) => contact.isPrimary) ? next : [{ ...next[0], isPrimary: true }, ...next.slice(1)];
    });
  }

  function setPrimaryContact(id: string) {
    setContacts((current) => current.map((contact) => ({ ...contact, isPrimary: contact.id === id })));
  }

  function moveContact(id: string, direction: -1 | 1) {
    setContacts((current) => moveById(current, id, direction));
  }

  function addAttachmentFiles(files: FileList | null) {
    if (!files) return;
    setAttachmentFiles((current) => [...current, ...Array.from(files)].slice(0, 10));
  }

  /**
   * Uploads the chosen files right away through the attachments route (the
   * bucket is private; the route validates, stores and records them). The
   * metadata returned is folded into the draft so the next autosave keeps the
   * same list instead of dropping the files it does not know about. A refused
   * file leaves the form and the picked files untouched.
   */
  async function uploadFormAttachments() {
    if (attachmentFiles.length === 0 || isUploadingAttachments) return;

    const validationError = validateCaseAttachmentFiles(attachmentFiles);
    if (validationError) {
      onNotice(validationError);
      return;
    }

    setIsUploadingAttachments(true);

    try {
      const form = new FormData();
      attachmentFiles.forEach((file) => form.append("files", file));
      form.append("category", attachmentCategory);
      if (attachmentNote.trim()) {
        form.append("note", attachmentNote.trim());
      }

      const response = await fetch(`/api/cases/${caseItem.id}/attachments`, { method: "POST", body: form });
      const result = (await response.json()) as ApiMutationResponse & { attachments?: CaseAttachmentInput[] };

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Prílohy sa nepodarilo nahrať.");
      }

      const uploaded = result.attachments ?? [];
      setAttachments((current) => [...current, ...uploaded.filter((item) => !current.some((existing) => existing.id && existing.id === item.id))]);
      setAttachmentFiles([]);
      setAttachmentNote("");
      onDataChange?.(result.dispatchData);
      onNotice(uploaded.length === 1 ? "Príloha je nahratá a uložená pri karte zásahu." : `${uploaded.length} príloh je nahratých a uložených pri karte zásahu.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Prílohy sa nepodarilo nahrať.");
    } finally {
      setIsUploadingAttachments(false);
    }
  }

  async function openStoredAttachment(attachmentId: string) {
    try {
      await openCaseAttachment(caseItem.id, attachmentId);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Prílohu sa nepodarilo otvoriť.");
    }
  }

  function prefillFromCommander() {
    const normalizedPlate = normalizePlate(licensePlate);
    if (!normalizedPlate) {
      return;
    }

    const vehicle = resolveInternalVehicle(commanderVehicles, licensePlate, vin);
    if (!vehicle) {
      return;
    }

    if (!vehicleMake.trim() && vehicle.make) setVehicleMake(vehicle.make);
    if (!vehicleModel.trim() && vehicle.model) setVehicleModel(vehicle.model);
    if (!vin.trim() && vehicle.vin) setVin(vehicle.vin);
    onNotice(`Údaje vozidla boli predvyplnené z Commandera pre ${vehicle.licensePlate ?? licensePlate}.`);
  }

  async function loadCanonicalCaseState() {
    const controller = new AbortController();
    activeRequestRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), CASE_AUTOSAVE_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`/api/cases/${caseItem.id}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const result = (await response.json().catch(() => null)) as ApiMutationResponse | null;

      if (!response.ok || !result?.dispatchData || result.dispatchData.source !== "supabase") {
        throw new Error(result?.error ?? "Aktuálny stav karty sa nepodarilo spoľahlivo načítať.");
      }

      return result.dispatchData;
    } finally {
      window.clearTimeout(timeoutId);
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
      }
    }
  }

  function acceptCanonicalCaseState(dispatchData: DispatchData, revision: number, serializedPayload: string) {
    onDataChange?.(dispatchData);
    acceptedDraftRef.current = serializedPayload;
    setAcceptedDraft(serializedPayload);
    savedRevisionRef.current = Math.max(savedRevisionRef.current, revision);
    setLastSavedAt(new Date());
    setSaveAttempt(0);
    setSaveError(null);
    setRefreshOnlyRevision(null);

    if (latestDraftRef.current === serializedPayload) {
      setSavePhase("saved");
    } else {
      setSavePhase("waiting");
    }
  }

  async function reconcileCommittedRevision(revision: number) {
    const committedDraft = committedDraftRef.current;
    if (!committedDraft || committedDraft.revision !== revision) {
      return;
    }

    setSavePhase("saving");
    setSaveSlow(false);
    setSaveError(null);

    try {
      const dispatchData = await loadCanonicalCaseState();
      acceptCanonicalCaseState(dispatchData, revision, committedDraft.payload);
    } catch {
      if (latestDraftRef.current !== committedDraft.payload) {
        setRefreshOnlyRevision(null);
        setSavePhase("waiting");
        return;
      }

      setRefreshOnlyRevision(revision);
      setSaveError({
        message: "Zmena bola prijatá serverom, ale jej aktuálny stav sa nepodarilo overiť. Údaje zostávajú v editore.",
        payload: committedDraft.payload,
      });
      setSavePhase("error");
    }
  }

  async function persistDraft(serializedPayload: string, revision: number) {
    if (conflictRef.current) return false;
    const changes = changedCaseFields(acceptedDraftRef.current ?? acceptedDraft, serializedPayload);
    if (Object.keys(changes).length === 0) return true;
    const requestPayload = JSON.stringify({ ...changes, expectedUpdatedAt: serverRevisionRef.current });
    if (revision <= savedRevisionRef.current) {
      return true;
    }

    setSavePhase("saving");
    setSaveSlow(false);
    setSaveError(null);
    setRefreshOnlyRevision(null);
    const slowTimerId = window.setTimeout(() => setSaveSlow(true), CASE_SAVE_SLOW_MS);
    let failureMessage = "Automatické uloženie zlyhalo.";

    try {
      for (let attempt = 0; attempt < CASE_AUTOSAVE_RETRY_DELAYS_MS.length; attempt += 1) {
        const retryDelay = CASE_AUTOSAVE_RETRY_DELAYS_MS[attempt];
        setSaveAttempt(attempt + 1);
        if (retryDelay > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
        }

        const controller = new AbortController();
        activeRequestRef.current = controller;
        const timeoutId = window.setTimeout(() => controller.abort(), CASE_AUTOSAVE_REQUEST_TIMEOUT_MS);

        try {
          const response = await fetch(`/api/cases/${caseItem.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: requestPayload,
            signal: controller.signal,
          });
          const result = (await response.json().catch(() => null)) as ApiMutationResponse | null;

          if (!response.ok) {
            if (response.status === 409 && result?.code === "CASE_REVISION_CONFLICT") {
              conflictRef.current = true;
              setConflict(true);
              setSavePhase("error");
              return false;
            }
            failureMessage = result?.error ?? "Kartu zásahu sa nepodarilo automaticky uložiť.";
            if (response.status < 500 && response.status !== 429) {
              break;
            }
            continue;
          }

          if (result?.committedRevision) serverRevisionRef.current = result.committedRevision;
          savedRevisionRef.current = Math.max(savedRevisionRef.current, revision);
          committedDraftRef.current = { payload: serializedPayload, revision };
          acceptedDraftRef.current = serializedPayload;
          if (result?.warnings?.length) {
            onNotice(`Karta je uložená. Upozornenia: ${result.warnings.map((warning) => warning.message).join(" · ")}`);
          }
          const responseDispatchData = result?.dispatchData?.source === "supabase" ? result.dispatchData : null;
          if (responseDispatchData) {
            acceptCanonicalCaseState(responseDispatchData, revision, serializedPayload);
            return true;
          }

          try {
            const dispatchData = await loadCanonicalCaseState();
            acceptCanonicalCaseState(dispatchData, revision, serializedPayload);
          } catch {
            if (latestDraftRef.current === serializedPayload) {
              setRefreshOnlyRevision(revision);
              setSaveError({
                message: "Zmena bola prijatá serverom, ale jej aktuálny stav sa nepodarilo overiť. Údaje zostávajú v editore.",
                payload: serializedPayload,
              });
              setSavePhase("error");
              return false;
            } else {
              setRefreshOnlyRevision(null);
              setSavePhase("waiting");
              return false;
            }
          }
          return true;
        } catch (caught) {
          failureMessage =
            caught instanceof DOMException && caught.name === "AbortError"
              ? "Automatické uloženie prekročilo časový limit."
              : "Automatické uloženie sa nepripojilo k serveru.";
        } finally {
          window.clearTimeout(timeoutId);
          if (activeRequestRef.current === controller) {
            activeRequestRef.current = null;
          }
        }
      }

      if (latestDraftRef.current !== serializedPayload) {
        setRefreshOnlyRevision(null);
        setSavePhase("waiting");
        return false;
      }

      setSaveError({
        message: `${failureMessage} Zmeny zostávajú v editore. Skúste uloženie zopakovať.`,
        payload: serializedPayload,
      });
      setSavePhase("error");
      return false;
    } finally {
      window.clearTimeout(slowTimerId);
      setSaveSlow(false);
    }
  }

  async function saveDraftNow() {
    const payload = latestDraftRef.current ?? serializedDraft;
    if (payload === acceptedDraft) {
      return true;
    }

    const revision = revisionRef.current + 1;
    revisionRef.current = revision;
    let saved = false;
    const queuedSave = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        saved = await persistDraft(payload, revision);
      });
    saveQueueRef.current = queuedSave;
    await queuedSave;
    return saved && latestDraftRef.current === payload;
  }

  useEffect(() => {
    saveDraftHandlerRef.current = saveDraftNow;
  });

  useEffect(() => {
    const saveDraft = () => saveDraftHandlerRef.current();
    onSaveDraftChange?.(saveDraft);
    return () => onSaveDraftChange?.(null);
  }, [onSaveDraftChange]);

  async function reloadConflictingCase() {
    try {
      const dispatchData = await loadCanonicalCaseState();
      onDataChange?.(dispatchData);
      onDiscard();
    } catch {
      onNotice("Aktuálny stav sa nepodarilo načítať. Váš rozpracovaný text zostáva v editore.");
    }
  }

  function retryAutosave() {
    if (conflictRef.current) return;
    setSaveError(null);
    setSaveAttempt(0);

    if (refreshOnlyRevision !== null) {
      const revision = refreshOnlyRevision;
      const queuedRefresh = saveQueueRef.current
        .catch(() => undefined)
        .then(() => reconcileCommittedRevision(revision));
      saveQueueRef.current = queuedRefresh;
      return;
    }

    setSavePhase("waiting");
    setRetryToken((current) => current + 1);
  }

  function discardDraft() {
    activeRequestRef.current?.abort();
    onDirtyChange?.(false);
    onSavingChange?.(false);
    onDiscard();
  }

  useEffect(() => {
    if (!isDirty) {
      return;
    }

    const payload = serializedDraft;
    const timerId = window.setTimeout(() => {
      const revision = revisionRef.current + 1;
      revisionRef.current = revision;
      const queuedSave = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await persistDraft(payload, revision);
        });
      saveQueueRef.current = queuedSave;
    }, CASE_AUTOSAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timerId);
    // persistDraft is intentionally captured with the exact serialized revision queued above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, retryToken, serializedDraft]);

  return (
    <section className="grid min-w-0 gap-2 lg:gap-3 @container" aria-busy={savePhase === "saving"}>
      {showSaveStatus && <div
        className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-[11px] font-medium lg:min-h-10 lg:px-3 lg:py-2 lg:text-xs ${
          isDirty && validationErrors.length > 0
            ? "border-red-200 bg-red-50 text-red-800"
            : displayedSavePhase === "error"
              ? "border-red-200 bg-red-50 text-red-800"
              : displayedSavePhase === "saving" || displayedSavePhase === "waiting"
                ? "border-blue-200 bg-blue-50 text-blue-800"
                : "border-emerald-200 bg-emerald-50 text-emerald-800"
        }`}
        data-testid="case-autosave-status"
        aria-live="polite"
      >
        {isDirty && validationErrors.length > 0 && displayedSavePhase !== "saving" && displayedSavePhase !== "error" ? (
          <span role="alert">{validationErrors[0]} Rozpracovaná zmena sa napriek tomu automaticky uloží.</span>
        ) : displayedSavePhase === "saving" ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 size={14} className="animate-spin" />
            {saveAttempt > 1 ? `Opakujem uloženie (${saveAttempt}/${CASE_AUTOSAVE_RETRY_DELAYS_MS.length})…` : "Ukladám automaticky…"}
          </span>
        ) : displayedSavePhase === "waiting" ? (
          <span>Čakám na dokončenie zmeny; potom ju automaticky uložím…</span>
        ) : displayedSavePhase === "error" ? (
          <span role="alert">{currentError}</span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 size={14} />
            {lastSavedAt ? `Uložené automaticky o ${lastSavedAt.toLocaleTimeString("sk-SK")}` : "Uložené automaticky."}
          </span>
        )}

        {isDirty && (validationErrors.length > 0 || displayedSavePhase === "error") && (
          <span className="flex items-center gap-3">
            {displayedSavePhase === "error" && !conflict && (
              <button type="button" onClick={retryAutosave} className="font-semibold underline underline-offset-2">
                {refreshOnlyRevision !== null ? "Overiť uložený stav" : "Skúsiť znova"}
              </button>
            )}
            <button type="button" onClick={discardDraft} className="font-semibold underline underline-offset-2">
              Zahodiť zmeny
            </button>
          </span>
        )}
      </div>}

      {saveSlow && (
        <div role="status" className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900">
          Automatické ukladanie stále prebieha. Kartu zatiaľ nezatvárajte.
        </div>
      )}

      {conflict && <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        Prípad medzitým zmenil iný používateľ. Vaše údaje zostávajú v editore. Načítaním aktuálneho stavu nahradíte tento draft uloženými údajmi.
        <button type="button" onClick={() => void reloadConflictingCase()} className="mt-2 flex min-h-11 items-center rounded-md border border-amber-400 bg-white px-3 font-semibold">Načítať aktuálny stav prípadu</button>
      </div>}
      <div className="m-0 min-w-0 border-0 p-0 @container">
        <div className={`${styles.formMain} grid min-w-0`} data-testid="case-edit-form-main">
      <p className="text-[10px] font-medium text-zinc-500 lg:text-xs lg:font-semibold">
        <span className="text-red-600" aria-hidden="true">*</span> Povinné údaje
      </p>

      <EditFormSection
        title="1. Základ prípadu"
        valid={formValidation.sectionValid.basic}
        errorCount={formValidation.sectionErrors.basic.length}
        collapsible={compact}
        defaultOpen={compact}
      >
        <div className="grid min-w-0 grid-cols-2 gap-2 lg:gap-3 @3xl:grid-cols-[minmax(0,1fr)_150px_150px]">
          <div className="col-span-2 @3xl:col-span-1">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Typ zákazky<RequiredMark /></span>
            <CheckboxGroup compact items={jobTypes} labels={jobTypeLabels} selected={selectedJobTypes} onChange={setSelectedJobTypes} />
          </div>
          <SelectField label="Priorita" value={priority} onChange={(value) => setPriority(value as CasePriority)} options={(["urgent", "high", "normal", "low"] as CasePriority[]).map((item) => [item, casePriorityLabels[item]])} />
          <SelectField label="Zdroj" value={sourceType} onChange={(value) => setSourceType(value as NonNullable<DispatchCase["sourceType"]> | "")} options={[["", "Nezadaný"], ...sourceTypeOptions]} required />
        </div>
        <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-medium text-zinc-600">
          Typ karty sa uloží ako <strong className="text-zinc-900">{caseType || "nezadaný"}</strong>. {needsDestination ? "Cieľ odťahu bude potrebný až pred vyslaním." : "Cieľ odťahu sa pre tento draft nevyžaduje."}
        </div>
      </EditFormSection>

      <EditFormSection
        title="2. Zákazník a kontakty"
        valid={formValidation.sectionValid.customer}
        errorCount={formValidation.sectionErrors.customer.length}
        collapsible={compact}
      >
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
          <div className="grid gap-3 @3xl:grid-cols-3">
            <SelectField
              label={customerType === "insurance" ? "Adresár asistenčných služieb" : "Adresár firiem"}
              value={partnerDirectoryId}
              onChange={selectDirectoryEntry}
              options={[["", "Vybrať z adresára"], ...directoryOptions.map((entry) => [entry.id, entry.ico ? `${entry.name} · IČO ${entry.ico}` : entry.name] as [string, string])]}
            />
            {customerType === "company" ? (
              <>
                <TextField label="Názov firmy" value={companyName} onChange={setCompanyName} required />
                <TextField label="IČO" value={companyIdNumber} onChange={setCompanyIdNumber} error={fieldErrors.companyIdNumber} inputMode="numeric" maxLength={8} transformValue={(value) => digitsOnly(value, 8)} required />
              </>
            ) : (
              <>
                <TextField label="Asistenčná služba" value={assistanceServiceName} onChange={setAssistanceServiceName} required />
                <TextField label="Číslo prípadu asistenčky" value={assistanceReference} onChange={setAssistanceReference} required />
              </>
            )}
          </div>
        )}

        <ContactEditor contacts={contacts} fieldErrors={fieldErrors} onAdd={addContact} onMove={moveContact} onPrimary={setPrimaryContact} onRemove={removeContact} onUpdate={updateContact} />
        <TextareaField label="Poznámka k zákazníkovi" value={customerNote} onChange={setCustomerNote} />
      </EditFormSection>

      <EditFormSection
        title={replacementOnly ? "3. Vozidlo klienta (voliteľné)" : "3. Vozidlo a incident"}
        valid={formValidation.sectionValid.vehicle}
        errorCount={formValidation.sectionErrors.vehicle.length}
        collapsible={compact}
      >
        {replacementOnly && (
          <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-900">
            Prípad na náhradné vozidlo: údaje o klientovom vozidle sú voliteľné a odťahové polia sú skryté.
          </p>
        )}
        <div className="grid gap-3 @3xl:grid-cols-3">
          <VehicleLookupControl contextKey={caseItem.id} plate={licensePlate} vin={vin} snapshot={vehicleLookup} required={!replacementOnly} plateError={fieldErrors.licensePlate} vinError={fieldErrors.vin} onPlateChange={setLicensePlate} onVinChange={setVin} onPlateBlur={prefillFromCommander} values={{ make: vehicleMake, model: vehicleModel, color: vehicleColor }} onApply={(patch, snapshot) => {
            setVehicleLookup(snapshot);
            if (patch.plate !== undefined) setLicensePlate(patch.plate);
            if (patch.vin !== undefined) setVin(patch.vin);
            if (patch.make !== undefined) setVehicleMake(patch.make);
            if (patch.model !== undefined) setVehicleModel(patch.model);
            if (patch.color !== undefined) setVehicleColor(patch.color);
          }} />
          <TextField label="Značka" value={vehicleMake} onChange={setVehicleMake} />
          <TextField label="Model" value={vehicleModel} onChange={setVehicleModel} />
          <TextField label="Rok výroby" value={productionYear} onChange={setProductionYear} error={fieldErrors.productionYear} type="number" inputMode="numeric" min={1950} max={new Date().getFullYear() + 1} step={1} transformValue={(value) => digitsOnly(value, 4)} />
          <TextField label="Farba" value={vehicleColor} onChange={setVehicleColor} />
          <SelectField label="Typ vozidla" value={vehicleType} onChange={(value) => setVehicleType(value as ClientVehicleType | "")} options={[["", "Nezadaný"], ...vehicleTypes.map((type) => [type, clientVehicleTypeLabels[type]] as [string, string])]} />
          <SelectField label="Prevodovka" value={transmission} onChange={(value) => setTransmission(value as VehicleTransmission | "")} options={[["", "Nezadaná"], ...transmissions.map((item) => [item, transmissionLabels[item]] as [string, string])]} />
          <TextField label="Poznámka k prevodovke" value={transmissionNote} onChange={setTransmissionNote} />
          <SelectField label="Pohon" value={driveType} onChange={setDriveType} options={[["", "Nezadaný"], ...driveTypeOptions.map(([value, label]) => [value, label] as [string, string])]} />
          <TextField label="Hmotnosť kg" value={weightKg} onChange={setWeightKg} error={fieldErrors.weightKg} type="number" inputMode="numeric" min={1} max={100000} step={1} transformValue={(value) => digitsOnly(value, 6)} />
          <TextField label="Kategória" value={vehicleCategory} onChange={setVehicleCategory} />
        </div>
        <TextareaField label="Opis problému / situácie" value={vehicleIssue} onChange={setVehicleIssue} required={!replacementOnly} />
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
            <h4 className="border-t border-zinc-200 pt-3 text-xs font-semibold uppercase tracking-normal text-zinc-500">Incident</h4>
            <div className="grid gap-3 @3xl:grid-cols-3">
              <SelectField label="Typ incidentu" value={incidentType} onChange={(value) => setIncidentType(value as IncidentType | "")} options={[["", "Nezadaný"], ...incidentTypes.map((type) => [type, incidentTypeLabels[type]] as [string, string])]} required />
              <TextField label="Počet účastníkov" value={participantsCount} onChange={setParticipantsCount} error={fieldErrors.participantsCount} type="number" inputMode="numeric" min={0} max={99} step={1} transformValue={(value) => digitsOnly(value, 2)} />
              <TextField label="Počet pasažierov" value={passengersCount} onChange={setPassengersCount} error={fieldErrors.passengersCount} type="number" inputMode="numeric" min={0} max={99} step={1} transformValue={(value) => digitsOnly(value, 2)} />
            </div>
            <CheckboxGroup items={damageAreas} labels={damageAreaLabels} selected={selectedDamageAreas} onChange={setSelectedDamageAreas} />
            <TextareaField label="Poznámka k poškodeniu" value={damageNote} onChange={setDamageNote} />
          </>
        )}
      </EditFormSection>

      <EditFormSection
        title="4. Miesto a cieľ"
        valid={formValidation.sectionValid.location}
        errorCount={formValidation.sectionErrors.location.length}
        collapsible={compact}
      >
        <div className={styles.locationFields}>
          <GooglePlaceAutocomplete
            label={replacementOnly ? "Miesto (voliteľné, mapa)" : "Miesto incidentu"}
            required={!replacementOnly}
            placeholder="Kde je vozidlo?"
            value={pickup}
            manualValue={manualPickupAddress}
            onManualChange={(value) => {
              setPickup(null);
              setManualPickupAddress(value);
            }}
            onSelect={(value) => {
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
                setDestination(null);
                setManualDestinationAddress(value);
              }}
              onSelect={(value) => {
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
        <LocationPicker value={pickup} onSelect={setPickup} />
        <div className={`rounded-md border p-3 ${placeType === "highway" ? "border-yellow-300 bg-yellow-50" : "border-zinc-200 bg-white"}`}>
          <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
            <TextField label="Diaľnica / cesta" value={roadName} onChange={setRoadName} />
            <TextField label="Km úsek" value={kilometerSection} onChange={setKilometerSection} error={fieldErrors.kilometerSection} type="number" inputMode="decimal" min={0} max={9999} step="0.01" transformValue={(value) => decimalOnly(value, 4)} />
            <TextField label="Smer jazdy" value={drivingDirection} onChange={setDrivingDirection} />
            <SelectField label="Typ miesta" value={placeType} onChange={(value) => setPlaceType(value as PlaceType | "")} options={[["", "Nezadaný"], ...placeTypes.map((type) => [type, placeTypeLabels[type]] as [string, string])]} />
          </div>
        </div>
        {!replacementOnly && (
          <>
            <TextareaField label="Komplikácie" value={locationComplications} onChange={setLocationComplications} />
            <CheckboxGroup items={accessComplications} labels={accessComplicationLabels} selected={selectedAccessComplications} onChange={setSelectedAccessComplications} />
          </>
        )}
        {needsDestination && <TextareaField label="Poznámka k cieľu odťahu" value={destinationNote} onChange={setDestinationNote} />}
      </EditFormSection>

      <EditFormSection
        title="5. Doplnkové služby a administratíva"
        valid={formValidation.sectionValid.extras}
        errorCount={formValidation.sectionErrors.extras.length}
        collapsible={compact}
      >
        <div className="rounded-lg border border-zinc-200 bg-white p-3">
          <h4 className="text-sm font-semibold text-zinc-950">Náhradné vozidlo</h4>
          <p className="mt-0.5 text-xs font-medium text-zinc-600">Potrebuje zákazník zabezpečiť náhradné vozidlo?</p>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Potreba náhradného vozidla">
            <button
              type="button"
              onClick={() => setReplacementVehicleNeeded(true)}
              aria-pressed={replacementVehicleNeeded}
              className={`h-9 rounded-md px-4 text-sm font-semibold ring-1 ${replacementVehicleNeeded ? "bg-yellow-100 text-zinc-950 ring-yellow-300" : "bg-zinc-50 text-zinc-600 ring-zinc-200 hover:bg-white"}`}
            >
              Áno, potrebuje
            </button>
            <button
              type="button"
              onClick={() => setReplacementVehicleNeeded(false)}
              aria-pressed={!replacementVehicleNeeded}
              className={`h-9 rounded-md px-4 text-sm font-semibold ring-1 ${!replacementVehicleNeeded ? "bg-yellow-100 text-zinc-950 ring-yellow-300" : "bg-zinc-50 text-zinc-600 ring-zinc-200 hover:bg-white"}`}
            >
              Nie, nepotrebuje
            </button>
          </div>
          <div className={`mt-3 grid gap-3 rounded-md border p-3 ${replacementVehicleNeeded ? "border-yellow-200 bg-white" : "border-zinc-200 bg-zinc-100"}`}>
            <div className="grid gap-3 @xl:grid-cols-2">
              <TextField label="Požadovaný typ vozidla" value={replacementVehicleType} onChange={setReplacementVehicleType} disabled={!replacementVehicleNeeded} required={replacementVehicleNeeded} />
              <TextField label="Špeciálne požiadavky" value={replacementVehicleNote} onChange={setReplacementVehicleNote} disabled={!replacementVehicleNeeded} />
            </div>
            <div>
              <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Preferencie</span>
              <CheckboxGroup
                items={replacementPreferences}
                labels={replacementPreferenceLabels}
                selected={selectedReplacementPreferences}
                onChange={setSelectedReplacementPreferences}
                disabled={!replacementVehicleNeeded}
              />
            </div>
            {replacementOnly && customerType !== "insurance" && (
              <div className="grid gap-3 border-t border-zinc-100 pt-3 @xl:grid-cols-2">
                <TextField label="Asistenčná služba" value={assistanceServiceName} onChange={setAssistanceServiceName} disabled={!replacementVehicleNeeded} />
                <TextField label="Číslo prípadu asistenčky" value={assistanceReference} onChange={setAssistanceReference} disabled={!replacementVehicleNeeded} />
              </div>
            )}
            <div className="grid gap-3 border-t border-zinc-100 pt-3 @xl:grid-cols-2">
              <SelectField
                label="Kategória vozidla"
                value={replacementCategory}
                onChange={(value) => setReplacementCategory(value as "" | ReplacementVehicleCategory)}
                options={[["", "Nezadaná"], ...replacementCategories.map((category) => [category, replacementCategoryLabels[category]] as [string, string])]}
                disabled={!replacementVehicleNeeded}
              />
              <TextField
                label="Miesto pristavenia"
                value={replacementDeliveryPlace}
                onChange={setReplacementDeliveryPlace}
                disabled={!replacementVehicleNeeded}
                required={replacementOnly}
              />
              <SelectField
                label="Nárok na pristavenie"
                value={replacementEntitlement}
                onChange={(value) => setReplacementEntitlement(value as "" | ReplacementVehicleEntitlement)}
                options={[["", "Nezadaný"], ...replacementEntitlements.map((entitlement) => [entitlement, replacementEntitlementLabels[entitlement]] as [string, string])]}
                disabled={!replacementVehicleNeeded}
              />
              <SelectField
                label="Možnosť predĺženia"
                value={replacementExtension}
                onChange={(value) => setReplacementExtension(value as "" | "yes" | "no")}
                options={[["", "Nezadaná"], ["yes", "Áno"], ["no", "Nie"]]}
                disabled={!replacementVehicleNeeded}
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
                disabled={!replacementVehicleNeeded}
              />
            </div>
            <div className="grid gap-3 border-t border-zinc-100 pt-3 @xl:grid-cols-2">
              <SelectField
                label="Poskytnuté náhradné vozidlo"
                value={replacementProvisionStatus}
                onChange={(value) => setReplacementProvisionStatus(value as "" | ReplacementVehicleProvisionStatus)}
                options={[
                  ["", "Nerozhodnuté"],
                  ["pending", "Čaká na preverenie"],
                  ["provided", "Áno, poskytnuté"],
                  ["not_provided", "Nie, neposkytnuté"],
                ]}
                disabled={!replacementVehicleNeeded}
              />
              {(replacementProvisionStatus === "not_provided" || replacementProvisionStatus === "pending") && (
                <TextField
                  label={replacementProvisionStatus === "not_provided" ? "Dôvod neposkytnutia" : "Čo sa preveruje"}
                  value={replacementProvisionReason}
                  onChange={setReplacementProvisionReason}
                  disabled={!replacementVehicleNeeded}
                  required={replacementProvisionStatus === "not_provided"}
                />
              )}
            </div>
            {!replacementVehicleNeeded && (
              <p className="text-xs font-medium text-zinc-500">
                Podrobnosti sa sprístupnia po voľbe „Áno, potrebuje“ a zostanú na rovnakom mieste.
              </p>
            )}
          </div>
        </div>
        <h4 className="border-t border-zinc-200 pt-3 text-xs font-semibold uppercase tracking-normal text-zinc-500">Dokumenty</h4>
        <div className="grid gap-3 @3xl:grid-cols-[160px_1fr_1fr_auto]">
          <SelectField label="Typ prílohy" value={attachmentCategory} onChange={(value) => setAttachmentCategory(value as CaseAttachmentInput["category"])} options={attachmentCategories.map((category) => [category, attachmentCategoryLabels[category]])} />
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Súbory</span>
            <span className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-50">
              <FileUp size={16} />
              {attachmentFiles.length > 0 ? `Vybrané: ${attachmentFiles.length}` : "Vybrať súbory"}
              <input
                type="file"
                multiple
                accept={CASE_ATTACHMENT_ACCEPT}
                className="sr-only"
                onChange={(event) => {
                  addAttachmentFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </span>
          </label>
          <TextField label="Poznámka" value={attachmentNote} onChange={setAttachmentNote} />
          <button
            type="button"
            onClick={() => void uploadFormAttachments()}
            disabled={attachmentFiles.length === 0 || isUploadingAttachments}
            className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
          >
            {isUploadingAttachments ? <Loader2 size={16} className="animate-spin" /> : <FileUp size={16} />}
            Nahrať
          </button>
        </div>
        <p className="text-xs font-medium text-zinc-500">Povolené sú JPG, PNG, PDF a Word do 10 MB. Súbor sa nahrá hneď po stlačení Nahrať a uloží sa k tejto karte.</p>
        {attachmentFiles.length > 0 && (
          <div className="grid gap-1.5">
            {attachmentFiles.map((file, index) => (
              <div key={`${file.name}-${file.lastModified}-${index}`} className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-dashed border-zinc-300 bg-white px-3 py-1.5 text-xs">
                <span className="min-w-0 truncate font-medium text-zinc-700">{file.name} · {Math.max(1, Math.round(file.size / 1024))} kB</span>
                <button type="button" onClick={() => setAttachmentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={isUploadingAttachments} className="shrink-0 text-zinc-500 hover:text-zinc-900 disabled:text-zinc-300" aria-label={`Nevybrať súbor ${file.name}`}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="grid gap-2">
            {attachments.map((attachment, index) => (
              <div key={attachment.id ?? `${attachment.fileName}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{attachmentCategoryLabels[attachment.category]} · {attachment.fileName}{attachment.note ? ` · ${attachment.note}` : ""}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {attachment.id && attachment.storagePath && (
                    <button type="button" onClick={() => void openStoredAttachment(attachment.id!)} className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-200 px-2 text-xs font-semibold text-zinc-600 hover:bg-zinc-50">
                      <Download size={14} />
                      Otvoriť
                    </button>
                  )}
                  <button type="button" onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-200 px-2 text-xs font-semibold text-zinc-600 hover:bg-zinc-50">
                    <Trash2 size={14} />
                    Odobrať
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <h4 className="border-t border-zinc-200 pt-3 text-xs font-semibold uppercase tracking-normal text-zinc-500">Platba</h4>
        <div className="grid gap-3 @xl:grid-cols-2">
          <SelectField label="Platba" value={paymentMethod} onChange={(value) => setPaymentMethod(value as PaymentMethod | "")} options={[["", "Nezadaná"], ...paymentMethods.map((method) => [method, paymentMethodLabels[method]] as [string, string])]} required />
          <SelectField label="Stav platby" value={paymentStatus} onChange={(value) => setPaymentStatus(value as PaymentStatus | "")} options={[["", "Nezadaný"], ...paymentStatuses.map((status) => [status, paymentStatusLabels[status]] as [string, string])]} required />
        </div>
        <h4 className="border-t border-zinc-200 pt-3 text-xs font-semibold uppercase tracking-normal text-zinc-500">Ukončenie a poznámky</h4>
        <div className="grid gap-3 @3xl:grid-cols-3">
          <SelectField
            label="Stav prípadu"
            value={caseClosureStatus}
            onChange={(value) => setCaseClosureStatus(value as "" | CaseClosureStatus)}
            options={[
              ["", "Ponechať aktuálny"],
              ...caseClosureStatuses.map((status) => [status, status === "open" ? "Otvorený (vrátiť do práce)" : caseStatusLabels[status]] as [string, string]),
            ]}
          />
          <SelectField label="Typ ukončenia" value={closureType} onChange={(value) => setClosureType(value as ClosureType | "")} options={[["", "Nezadaný"], ["insurance_portal", "Asistenčná služba"], ["self_payer", "Samoplatca"], ["internal", "Interné"]]} />
          <TextField label="Stav ukončenia" value={closureStatus} onChange={setClosureStatus} />
          {sourceType === "assistance" && <TextField label="Portál asistenčnej služby" value={insurancePortalUrl} onChange={setInsurancePortalUrl} error={fieldErrors.insurancePortalUrl} type="url" inputMode="url" />}
        </div>
        {caseClosureStatus === "cancelled" && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
            Prípad sa uloží ako zrušený a zmizne zo zoznamu aktívnych prípadov. Nájdeš ho v Prípady → História.
          </p>
        )}
        <TextareaField label="Poznámka k ukončeniu zásahu" value={closureNote} onChange={setClosureNote} />
        <TextareaField label="Interná poznámka dispečera" value={note} onChange={setNote} />
      </EditFormSection>
        </div>
      </div>
    </section>
  );
}

function ContactEditor({
  contacts,
  fieldErrors,
  onAdd,
  onMove,
  onPrimary,
  onRemove,
  onUpdate,
}: {
  contacts: ContactDraft[];
  fieldErrors: CaseFormFieldErrors;
  onAdd: () => void;
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
        <div key={contact.id} className="grid gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-600">
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
          <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
            <TextField label="Meno" value={contact.firstName} onChange={(value) => onUpdate(contact.id, { firstName: value })} error={contact.isPrimary ? fieldErrors.contactName : undefined} required={contact.isPrimary} />
            <TextField label="Priezvisko" value={contact.lastName} onChange={(value) => onUpdate(contact.id, { lastName: value })} />
            <PhoneField contact={contact} onChange={(patch) => onUpdate(contact.id, patch)} error={contact.isPrimary ? fieldErrors.contactPhone : undefined} required={contact.isPrimary} />
            <TextField label="Email" value={contact.email} onChange={(value) => onUpdate(contact.id, { email: value })} error={contact.isPrimary ? fieldErrors.contactEmail : getEmailValidationError(contact.email)} type="email" inputMode="email" />
            <SelectField label="Rola" value={contact.role} onChange={(value) => onUpdate(contact.id, { role: value as CustomerContactRole })} options={customerContactRoles.map((role) => [role, customerContactRoleLabels[role]])} />
            <TextField label="Poznámka" value={contact.note} onChange={(value) => onUpdate(contact.id, { note: value })} />
          </div>
        </div>
      ))}
    </div>
  );
}

function InfoPanel({ children, icon: Icon, title }: { children: ReactNode; icon?: LucideIcon; title: string }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-200 bg-zinc-50 px-3 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
          {Icon && (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white text-zinc-700 ring-1 ring-zinc-200">
              <Icon size={15} />
            </span>
          )}
          <span className="border-l-4 border-[#FCD703] pl-2">{title}</span>
        </h3>
      </div>
      <div className="grid min-w-0 gap-2 p-3">{children}</div>
    </section>
  );
}

function InfoItem({
  detail,
  invalid,
  label,
  required = false,
  value,
  warningMessage,
}: {
  detail?: string;
  invalid?: boolean;
  label: string;
  required?: boolean;
  value: string;
  warningMessage?: string;
}) {
  const missing = !value.trim();
  const warning = invalid ?? (required && missing);

  return (
    <div
      className={`grid min-w-0 gap-1 rounded-md border border-l-2 px-3 py-2.5 ${
        warning ? "border-red-200 border-l-red-500 bg-red-50" : "border-zinc-200 border-l-zinc-400 bg-zinc-50"
      }`}
      data-info-state={warning ? "warning" : missing ? "missing" : "complete"}
      title={warning ? warningMessage ?? "Povinný alebo nesprávny údaj je potrebné opraviť." : undefined}
    >
      <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${warning ? "text-red-700" : "text-zinc-500"}`}>
        {warning && <TriangleAlert size={13} aria-label="Údaj vyžaduje pozornosť" />}
        <span>{label}</span>
      </div>
      <div className={`break-words text-sm font-semibold ${warning ? "text-red-900" : "text-zinc-950"}`}>{value || "Nezadané"}</div>
      {detail && <div className="break-words text-xs leading-5 text-zinc-600">{detail}</div>}
    </div>
  );
}

function Action({ disabled = false, disabledReason, icon: Icon, label, onClick }: { disabled?: boolean; disabledReason?: string; icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={disabled ? disabledReason : label} className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400">
      <Icon size={15} />
      {label}
    </button>
  );
}

function labelList<T extends string>(values: T[], labels: Record<T, string>) {
  return values.length > 0 ? values.map((value) => labels[value]).join(", ") : "Nezadané";
}

function contactsFromCase(caseItem: DispatchCase): ContactDraft[] {
  const contacts = caseItem.customerDetails.contacts?.length
    ? caseItem.customerDetails.contacts.map((contact) => {
        const parsedPhone = parsePhone(contact.phone);
        const split = splitName(contact.name);

        return {
          id: contact.id,
          firstName: contact.firstName ?? split.firstName,
          lastName: contact.lastName ?? split.lastName,
          phonePrefix: contact.phonePrefix ?? parsedPhone.prefix,
          phoneNational: contact.phoneNational ?? parsedPhone.national,
          email: contact.email ?? "",
          role: contact.role,
          note: contact.note ?? "",
          isPrimary: Boolean(contact.isPrimary),
        };
      })
    : [];

  if (contacts.length > 0) {
    return contacts.some((contact) => contact.isPrimary) ? contacts : [{ ...contacts[0], isPrimary: true }, ...contacts.slice(1)];
  }

  const split = splitName(caseItem.contact.name);
  const parsedPhone = parsePhone(caseItem.contact.phone);

  return [
    {
      id: caseItem.contact.id,
      firstName: caseItem.customerDetails.firstName ?? split.firstName,
      lastName: caseItem.customerDetails.lastName ?? split.lastName,
      phonePrefix: parsedPhone.prefix,
      phoneNational: parsedPhone.national,
      email: caseItem.contact.email ?? "",
      role: "primary_customer",
      note: "",
      isPrimary: true,
    },
  ];
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

function placeFromLocation(location: DispatchCase["pickup"]): PlaceSelectionInput | null {
  if (!location) {
    return null;
  }

  return {
    label: location.label,
    address: location.address,
    lat: location.lat,
    lng: location.lng,
    provider: "manual",
  };
}

function placeFromDestination(location: DispatchCase["destination"]): PlaceSelectionInput | null {
  if (!location || location.id.includes("no-tow-destination")) {
    return null;
  }

  return placeFromLocation(location);
}

function hasPlaceValue(place: PlaceSelectionInput | null): place is PlaceSelectionInput {
  return Boolean(place?.label.trim() && place.address.trim() && Number.isFinite(place.lat) && Number.isFinite(place.lng));
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

function dateTimeLocalInMinutes(minutes: number) {
  const date = new Date(Date.now() + minutes * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
}

function isoFromLocalDateTime(value: string) {
  const date = new Date(value);

  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toOptionalNumber(value: string) {
  const number = Number(value);
  return Number.isFinite(number) && value.trim() ? number : null;
}

function normalizePlate(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
