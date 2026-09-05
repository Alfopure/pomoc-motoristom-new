import "server-only";
import { matchFleetIdentities } from "@/lib/fleet-pairing";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CreateAttendanceRequestInput,
  CopyAttendanceInput,
  CreateBulkAttendanceShiftsInput,
  CreateAttendanceShiftInput,
  EndAttendanceSessionInput,
  StartAttendanceSessionInput,
  UpdateAttendanceRequestInput,
  UpdateAttendanceShiftInput,
} from "@/data/attendance-inputs";
import { isIsoDate, isIsoDateTime, isTimeLocal } from "@/data/attendance-inputs";
import type {
  AssignCaseInput,
  CaseActionInput,
  CaseAttachmentInput,
  CaseContactInput,
  CreateBranchInput,
  CreateCaseInput,
  CreateFleetAssetInput,
  PartnerDirectoryInput,
  PlaceSelectionInput,
  UpdateCaseInput,
  UpdateFleetAssetInput,
} from "@/data/case-inputs";
import { collectCaseInputWarnings, isValidPlaceSelection, nonEmpty } from "@/data/case-inputs";
import {
  canonicalCaseProblemDescription,
  requiresTowDestination,
} from "@/domain/case-card";
import { casePriorityLabels, caseStatusLabels } from "@/domain/statuses";
import { defaultTaskTitle, taskKinds, taskPriorities } from "@/domain/tasks";
import type { CaseAttachmentCategory, CasePriority, CaseStatus, CaseTaskKind, CustomerContactRole, FleetAssetOccupancy, JobType, TaskReminderChannel, VehicleConditionFlag } from "@/domain/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
// Lives in its own module so that latency-sensitive routes (the Telnyx webhook)
// can catch it without loading this file; re-exported for existing importers.
import { MutationError } from "@/server/mutation-error";

export { MutationError };
import { cancelPendingTaskReminders, createDefaultTaskReminder, createTaskAssignmentNotification, latestTaskReminderChannels } from "./task-notifications";
import {
  deriveReplacementOccupancy,
  isOccupiedAssignmentBlocked,
  isUnverifiedAssignmentBlocked,
  loadLatestOccupancySnapshot,
} from "./integrations/swhouse/occupancy-snapshot";

type AdminClient = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];
type AuditLogRow = Tables["motorist_audit_log"]["Row"];
type AttendanceShiftRow = Tables["motorist_attendance_shifts"]["Row"];
type AttendanceSessionRow = Tables["motorist_attendance_sessions"]["Row"];
type AttendanceShiftTemplateRow = Tables["motorist_attendance_shift_templates"]["Row"];
type AttendanceRequestRow = Tables["motorist_attendance_unavailability_requests"]["Row"];
type AttendanceScheduleBatchRow = Tables["motorist_attendance_schedule_batches"]["Row"];
type BranchRow = Tables["motorist_branches"]["Row"];
type CaseEventRow = Tables["motorist_case_events"]["Row"];
type CaseRow = Tables["motorist_cases"]["Row"];
type CaseTaskRow = Tables["motorist_case_tasks"]["Row"];
type CaseTaskInsertPayload = {
  organization_id: string;
  case_id: string;
  title: string;
  assigned_to?: string | null;
  due_at?: string | null;
  status: CaseTaskRow["status"];
  priority?: CaseTaskRow["priority"];
  kind?: CaseTaskRow["kind"];
  created_by?: string | null;
};
type ContactRow = Tables["motorist_contacts"]["Row"];
type ExternalVehicleRecordRow = Tables["motorist_external_vehicle_records"]["Row"];
type FleetAssetLinkRow = Tables["motorist_fleet_asset_links"]["Row"];
type FleetAssetRow = Tables["motorist_fleet_assets"]["Row"];
type FleetCurrentPositionRow = Tables["motorist_fleet_current_positions"]["Row"];
type LocationRow = Tables["motorist_locations"]["Row"];
type NotificationRow = Tables["motorist_notifications"]["Row"];
type OrganizationProfileRow = Tables["motorist_organization_profiles"]["Row"];
type OrganizationRow = Tables["motorist_organizations"]["Row"];
type PartnerDirectoryRow = Tables["motorist_partner_directory"]["Row"];
type ProfileRow = Tables["motorist_profiles"]["Row"];
type VehicleRow = Tables["motorist_vehicles"]["Row"];
type OrganizationAuthorizer = (organizationId: string) => Promise<void>;

const DEFAULT_ORGANIZATION_SLUG = "pomoc-motoristom";
const CASE_ATTACHMENTS_BUCKET = "motorist-case-attachments";
const MAX_CASE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const CASE_TASK_PHASE0_COLUMNS = ["priority", "kind", "created_by", "completed_by", "completed_at"] as const;
const ALLOWED_CASE_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export async function createCase(input: CreateCaseInput, ownerProfileId?: string) {
  const warnings = collectCaseInputWarnings(input);

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const organizationId = organization.id;
  const ownerId = ownerProfileId
    ? (await getProfile(supabase, organizationId, ownerProfileId)).id
    : await resolveDefaultOwnerId(supabase, organizationId);
  const caseNumber = await nextCaseNumber(supabase, organizationId);
  const primaryContact = primaryContactInput(input);
  const contact = hasMeaningfulContact(primaryContact)
    ? await createCaseContact(supabase, organizationId, primaryContact, input.customerNote)
    : null;
  const vehicle = hasMeaningfulVehicleInput(input) ? await createCaseVehicle(supabase, organizationId, input) : null;
  const pickup = isValidPlaceSelection(input.pickup) ? await createLocation(supabase, organizationId, input.pickup, "Pickup") : null;
  const destination = isValidPlaceSelection(input.destination) ? await createLocation(supabase, organizationId, input.destination, "Servis") : null;

  const caseRow = await insertSingle<CaseRow>(
    supabase
      .from("motorist_cases")
      .insert({
        organization_id: organizationId,
        case_number: caseNumber,
        status: "new",
        priority: input.priority ?? "normal",
        source_type: input.sourceType ?? null,
        case_type: cleanString(input.caseType),
        owner_id: ownerId,
        contact_id: contact?.id ?? null,
        vehicle_id: vehicle?.id ?? null,
        pickup_location_id: pickup?.id ?? null,
        destination_location_id: destination?.id ?? null,
        summary: caseSummary(input),
        main_note: cleanString(input.note),
        selected_asset_id: null,
        customer_details: customerDetailsPayload(input),
        vehicle_details: vehicleDetailsPayload(input),
        incident_details: incidentDetailsPayload(input),
        location_details: locationDetailsPayload(input),
        replacement_vehicle_details: replacementVehiclePayload(input),
        payment_details: paymentDetailsPayload(input),
        closure_details: closureDetailsPayload(input),
        attachments_metadata: attachmentMetadataPayload(input.attachmentMetadata),
      })
      .select("*")
      .single(),
  );

  await insertSingle<CaseEventRow>(
    supabase
      .from("motorist_case_events")
      .insert({
        organization_id: organizationId,
        case_id: caseRow.id,
        actor_profile_id: ownerId,
        event_type: "case_created",
        title: "Prípad vytvorený operátorom",
        body: caseCreatedEventBody(pickup, destination),
        payload: {
          source: "manual_dispatch_form",
          pickup_place_id: pickup?.place_id ?? null,
          destination_place_id: destination?.place_id ?? null,
        },
      })
      .select("*")
      .single(),
  );
  await audit(supabase, organizationId, ownerId, "case.create", "motorist_cases", caseRow.id, {
    case_number: caseRow.case_number,
    source: "manual_dispatch_form",
  });

  return { caseRow, warnings };
}

export async function updateCase(caseId: string, input: UpdateCaseInput, actorProfileId?: string) {
  if (!nonEmpty(caseId)) {
    throw new MutationError("Chýba prípad.", 400);
  }
  const warnings = collectCaseInputWarnings(input);

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const organizationId = organization.id;
  const existing = await getCase(supabase, organizationId, caseId);
  const ownerId = existing.owner_id ?? (await resolveDefaultOwnerId(supabase, organizationId));
  // Aktivitu prípadu zapisujeme na prihláseného editora, nie na majiteľa prípadu (P-01).
  const actorId = nonEmpty(actorProfileId) ? (await getProfile(supabase, organizationId, actorProfileId)).id : ownerId;
  const contact = existing.contact_id ? await getContact(supabase, organizationId, existing.contact_id) : null;
  const vehicle = existing.vehicle_id ? await getVehicle(supabase, organizationId, existing.vehicle_id) : null;

  const contactId = await upsertCaseContact(supabase, organizationId, contact, input);
  const vehicleId = await upsertCaseVehicle(supabase, organizationId, vehicle, input);
  const pickupLocationId = await upsertCaseLocation(supabase, organizationId, existing.pickup_location_id, input, "pickup", "Pickup");
  const destinationLocationId = await upsertCaseLocation(supabase, organizationId, existing.destination_location_id, input, "destination", "Servis");

  const updatePayload = caseUpdatePayload(
    existing,
    input,
    contactId,
    vehicleId,
    pickupLocationId,
    destinationLocationId,
    vehicle?.license_plate ?? null,
  );

  const updated = await insertSingle<CaseRow>(
    supabase.from("motorist_cases").update(updatePayload).eq("organization_id", organizationId).eq("id", caseId).select("*").single(),
  );

  // História aktivít (P-01): udalosť vzniká len pri reálnej zmene, s menovitým popisom.
  // Autosave bez zmeny nesmie zaplavovať timeline.
  const changedFields = collectChangedCaseFields(existing, updatePayload);

  if (changedFields.length > 0) {
    const statusChanged = changedFields.includes("status");
    const priorityChanged = changedFields.includes("priority");
    const otherFields = changedFields.filter((field) => field !== "status" && field !== "priority");

    if (statusChanged && updated.status) {
      await insertCaseActivityEvent(supabase, organizationId, caseId, actorId, {
        event_type: "status_changed",
        title: "Stav prípadu zmenený",
        body: `Nový stav: ${caseStatusLabels[updated.status as CaseStatus] ?? updated.status}.`,
      });
    }

    if (priorityChanged && updated.priority) {
      await insertCaseActivityEvent(supabase, organizationId, caseId, actorId, {
        event_type: "priority_changed",
        title: "Priorita prípadu zmenená",
        body: `Nová priorita: ${casePriorityLabels[updated.priority as CasePriority] ?? updated.priority}.`,
      });
    }

    if (otherFields.length > 0) {
      await insertCaseActivityEvent(supabase, organizationId, caseId, actorId, {
        event_type: "case_updated",
        title: "Karta zásahu upravená",
        body: `Zmenené: ${otherFields.map((field) => caseFieldLabels[field] ?? field).join(", ")}.`,
      });
    }

    await audit(supabase, organizationId, actorId, "case.update", "motorist_cases", caseId, {
      case_number: updated.case_number,
      source: "extended_case_card",
      changed_fields: changedFields,
    });
  }

  return { caseRow: updated, warnings };
}

const caseFieldLabels: Record<string, string> = {
  attachments_metadata: "prílohy",
  case_type: "typ zásahu",
  closure_details: "ukončenie",
  contact_id: "kontakt",
  customer_details: "údaje zákazníka",
  destination_location_id: "cieľ",
  incident_details: "incident",
  location_details: "lokalita",
  main_note: "interná poznámka",
  payment_details: "platba",
  pickup_location_id: "miesto zásahu",
  priority: "priorita",
  replacement_vehicle_details: "náhradné vozidlo",
  selected_asset_id: "technika",
  source_type: "zdroj",
  status: "stav",
  summary: "súhrn",
  vehicle_details: "údaje o vozidle",
  vehicle_id: "vozidlo",
};

function collectChangedCaseFields(existing: CaseRow, updatePayload: Record<string, unknown>) {
  return Object.keys(updatePayload).filter((key) => {
    const before = (existing as Record<string, unknown>)[key];
    const after = updatePayload[key];
    return stableJson(before ?? null) !== stableJson(after ?? null);
  });
}

/** Deterministická serializácia na porovnanie jsonb hodnôt bez ohľadu na poradie kľúčov. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
  }

  return JSON.stringify(value ?? null);
}

async function insertCaseActivityEvent(
  supabase: AdminClient,
  organizationId: string,
  caseId: string,
  actorId: string | null,
  event: { event_type: string; title: string; body: string },
) {
  await insertSingle<CaseEventRow>(
    supabase
      .from("motorist_case_events")
      .insert({
        organization_id: organizationId,
        case_id: caseId,
        actor_profile_id: actorId,
        event_type: event.event_type,
        title: event.title,
        body: event.body,
        payload: { source: "extended_case_card" },
      })
      .select("*")
      .single(),
  );
}

export async function runCaseAction(caseId: string, input: CaseActionInput, actorProfileId?: string) {
  if (!nonEmpty(caseId) || !nonEmpty(input.action)) {
    throw new MutationError("Chýba prípad alebo akcia.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const organizationId = organization.id;
  const caseRow = await getCase(supabase, organizationId, caseId);
  const ownerId = caseRow.owner_id ?? (await resolveDefaultOwnerId(supabase, organizationId));
  // Actor = prihlásený používateľ, ktorý akciu vykonal. Owner prípadu je iba fallback
  // pre volania bez autentifikovaného profilu (napr. staršie interné workflow).
  const actorId = nonEmpty(actorProfileId) ? (await getProfile(supabase, organizationId, actorProfileId)).id : ownerId;

  if (input.action === "call_customer") {
    const contact = caseRow.contact_id ? await getContact(supabase, organizationId, caseRow.contact_id) : null;
    if (!contact?.phone || contact.phone.replace(/\D/g, "").length < 6) {
      throw new MutationError("Volanie vyžaduje platné telefónne číslo kontaktu.", 409, "CASE_PHONE_REQUIRED");
    }
  }

  if (input.action === "add_note") {
    const note = cleanString(input.note);

    if (!note) {
      throw new MutationError("Poznámka nemôže byť prázdna.", 400);
    }

    await insertSingle<CaseEventRow>(
      supabase
        .from("motorist_case_events")
        .insert({
          organization_id: organizationId,
          case_id: caseId,
          actor_profile_id: actorId,
          event_type: "note_added",
          title: "Poznámka",
          body: note,
          payload: { source: "case_notes" },
        })
        .select("*")
        .single(),
    );
    await audit(supabase, organizationId, actorId, "case.note.add", "motorist_cases", caseId, { length: note.length });
    return;
  }

  if (input.action === "complete_task") {
    if (!nonEmpty(input.taskId)) {
      throw new MutationError("Chýba úloha na dokončenie.", 400);
    }

    await completeCaseTask(supabase, organizationId, caseId, input.taskId, actorId);
    await cancelPendingTaskReminders(supabase, organizationId, input.taskId);
    await markTaskNotificationsRead(supabase, organizationId, input.taskId);
    await insertSingle<CaseEventRow>(
      supabase
        .from("motorist_case_events")
        .insert({
          organization_id: organizationId,
          case_id: caseId,
          actor_profile_id: actorId,
          event_type: "task_done",
          title: "Úloha označená ako vybavená",
          body: cleanString(input.note) ?? "Operátor vybavil úlohu v karte zásahu.",
          payload: { source: "case_task_workflow", task_id: input.taskId },
        })
        .select("*")
        .single(),
    );
    await audit(supabase, organizationId, actorId, "case.task.complete", "motorist_cases", caseId, { task_id: input.taskId });
    return;
  }

  if (input.action === "create_task" || input.action === "callback_15" || input.action === "callback_30" || input.action === "callback_60") {
    const callbackMinutes = input.action === "callback_15" ? 15 : input.action === "callback_30" ? 30 : input.action === "callback_60" ? 60 : null;
    const taskKind = normalizeTaskKind(input.taskKind, callbackMinutes ? "callback" : "other");
    // Úloha nesmie mlčky zdediť urgentnosť prípadu (U-10): bez explicitnej voľby je priorita bežná.
    const taskPriority = normalizeTaskPriority(input.taskPriority, callbackMinutes ? "high" : "normal");
    const title = cleanString(input.taskTitle) ?? (callbackMinutes ? `Zavolať zákazníkovi o ${callbackMinutes} min` : taskKind === "other" ? null : defaultTaskTitle(taskKind));
    const assignedTo = await resolveTaskAssignee(supabase, organizationId, input.assignedTo, ownerId);

    if (!title) {
      throw new MutationError("Úloha potrebuje názov.", 400);
    }

    const task = await insertCaseTask(supabase, {
      organization_id: organizationId,
      case_id: caseId,
      title,
      assigned_to: assignedTo,
      due_at: dueAtForTask(input.taskDueAt, callbackMinutes ?? 30),
      status: "open",
      priority: taskPriority,
      kind: taskKind,
      created_by: actorId,
    });
    await createDefaultTaskReminder(supabase, {
      organizationId,
      caseId,
      task,
      createdBy: actorId,
      channels: normalizeTaskReminderChannels(input.taskReminderChannels),
    });
    await createTaskAssignmentNotification(supabase, { organizationId, caseId, task });
    await insertSingle<CaseEventRow>(
      supabase
        .from("motorist_case_events")
        .insert({
          organization_id: organizationId,
          case_id: caseId,
          actor_profile_id: actorId,
          event_type: input.action,
          title: callbackMinutes ? "Spätný hovor odložený" : "Úloha vytvorená",
          body: callbackMinutes ? `Spätné volanie bolo naplánované o ${callbackMinutes} minút.` : title,
          payload: { source: "case_task_workflow", note: input.note ?? null, kind: taskKind, priority: taskPriority, due_at: input.taskDueAt ?? null },
        })
        .select("*")
        .single(),
    );
    await audit(supabase, organizationId, actorId, `case.task.${input.action}`, "motorist_cases", caseId, { title, kind: taskKind, priority: taskPriority });
    return;
  }

  if (input.action === "update_task") {
    if (!nonEmpty(input.taskId)) {
      throw new MutationError("Chýba úloha na úpravu.", 400);
    }

    const task = await getCaseTask(supabase, organizationId, caseId, input.taskId);
    const updates: Tables["motorist_case_tasks"]["Update"] = {};
    const changes: string[] = [];
    let assignedToChanged = false;
    let dueAtChanged = false;
    let reopenedTask = false;

    if (input.taskTitle !== undefined) {
      const title = cleanString(input.taskTitle);
      if (!title) {
        throw new MutationError("Úloha potrebuje názov.", 400);
      }
      if (title !== task.title) {
        updates.title = title;
        changes.push("názov upravený");
      }
    }

    if ("assignedTo" in input) {
      const assignedTo = await resolveTaskAssignee(supabase, organizationId, input.assignedTo, task.assigned_to);
      updates.assigned_to = assignedTo;
      assignedToChanged = assignedTo !== task.assigned_to;
      if (assignedToChanged) {
        changes.push(assignedTo ? "zmenené priradenie operátora" : "úloha odobratá z operátora");
      }
    }

    if (input.taskDueAt !== undefined) {
      const dueAt = dueAtForTaskUpdate(input.taskDueAt);
      if (!sameIsoDateTime(dueAt, task.due_at)) {
        updates.due_at = dueAt;
        dueAtChanged = true;
        changes.push("termín upravený");
      }
    }

    if (input.taskKind !== undefined) {
      const taskKind = normalizeTaskKind(input.taskKind, task.kind);
      if (taskKind !== task.kind) {
        updates.kind = taskKind;
        changes.push("typ upravený");
      }
    }

    if (input.taskPriority !== undefined) {
      const taskPriority = normalizeTaskPriority(input.taskPriority, task.priority);
      if (taskPriority !== task.priority) {
        updates.priority = taskPriority;
        changes.push("priorita upravená");
      }
    }

    if (input.taskStatus !== undefined) {
      const taskStatus = normalizeTaskStatus(input.taskStatus);
      if (taskStatus !== task.status) {
        updates.status = taskStatus;
        reopenedTask = task.status === "done" && taskStatus !== "done";
        changes.push(`stav zmenený na ${taskStatusEventLabel(taskStatus)}`);
        if (taskStatus === "done") {
          updates.completed_at = new Date().toISOString();
          updates.completed_by = actorId;
        } else {
          updates.completed_at = null;
          updates.completed_by = null;
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    const updatedTask = await updateCaseTask(supabase, organizationId, caseId, input.taskId, updates, task);

    if (updatedTask.status === "done") {
      await cancelPendingTaskReminders(supabase, organizationId, input.taskId);
      await markTaskNotificationsRead(supabase, organizationId, input.taskId);
    } else if (assignedToChanged || dueAtChanged || reopenedTask) {
      // Zachovaj pôvodný spôsob pripomienky (napr. email) aj po zmene termínu či riešiteľa (U-03).
      const previousChannels = input.taskReminderChannels ?? (await latestTaskReminderChannels(supabase, organizationId, input.taskId));
      await cancelPendingTaskReminders(supabase, organizationId, input.taskId);
      await createDefaultTaskReminder(supabase, {
        organizationId,
        caseId,
        task: updatedTask,
        createdBy: actorId,
        channels: normalizeTaskReminderChannels(previousChannels ?? undefined),
      });
      if (assignedToChanged && updatedTask.assigned_to) {
        await createTaskAssignmentNotification(supabase, { organizationId, caseId, task: updatedTask });
      }
    }

    await insertSingle<CaseEventRow>(
      supabase
        .from("motorist_case_events")
        .insert({
          organization_id: organizationId,
          case_id: caseId,
          actor_profile_id: actorId,
          event_type: "task_updated",
          title: "Úloha upravená",
          body: [changes.length > 0 ? changes.join(" · ") : "Úloha bola upravená.", cleanString(input.note)].filter(Boolean).join(" · "),
          payload: { source: "case_task_workflow", task_id: input.taskId, note: input.note ?? null, updates },
        })
        .select("*")
        .single(),
    );
    await audit(supabase, organizationId, actorId, "case.task.update", "motorist_cases", caseId, { task_id: input.taskId, updates });
    return;
  }

  if (input.action === "delete_task") {
    if (!nonEmpty(input.taskId)) {
      throw new MutationError("Chýba úloha na vymazanie.", 400);
    }

    const task = await getCaseTask(supabase, organizationId, caseId, input.taskId);
    await cancelPendingTaskReminders(supabase, organizationId, input.taskId);
    await archiveTaskNotifications(supabase, organizationId, input.taskId);
    await deleteCaseTask(supabase, organizationId, caseId, input.taskId);
    await insertSingle<CaseEventRow>(
      supabase
        .from("motorist_case_events")
        .insert({
          organization_id: organizationId,
          case_id: caseId,
          actor_profile_id: actorId,
          event_type: "task_deleted",
          title: "Úloha vymazaná",
          body: [task.title, cleanString(input.note)].filter(Boolean).join(" · "),
          payload: { source: "case_task_workflow", task_id: input.taskId, note: input.note ?? null },
        })
        .select("*")
        .single(),
    );
    await audit(supabase, organizationId, actorId, "case.task.delete", "motorist_cases", caseId, { task_id: input.taskId, title: task.title });
    return;
  }

  const action = caseActionDescriptor(input.action, input.note);

  if (action.status) {
    const closureDetails = {
      ...objectJson(caseRow.closure_details),
      ...(input.closureType ? { type: input.closureType } : {}),
      ...(input.closureStatus !== undefined ? { status: cleanString(input.closureStatus) ?? "closed" } : { status: "closed" }),
      closedAt: new Date().toISOString(),
      note: cleanString(input.note) ?? cleanString(input.closureStatus) ?? "Manuálne ukončené operátorom.",
    };
    const paymentDetails = {
      ...objectJson(caseRow.payment_details),
      ...(input.paymentMethod ? { method: input.paymentMethod } : {}),
      ...(input.paymentStatus ? { status: input.paymentStatus } : {}),
    };

    await throwOnResult(
      supabase
        .from("motorist_cases")
        .update({
          status: action.status,
          closed_at: action.status.startsWith("completed") ? new Date().toISOString() : caseRow.closed_at,
          closure_details: input.action === "mark_completed" || input.action === "close_case" ? closureDetails : caseRow.closure_details,
          payment_details: input.paymentMethod || input.paymentStatus ? paymentDetails : caseRow.payment_details,
        })
        .eq("organization_id", organizationId)
        .eq("id", caseId),
    );
  }

  if (action.taskTitle) {
    const task = await insertCaseTask(supabase, {
      organization_id: organizationId,
      case_id: caseId,
      title: action.taskTitle,
      assigned_to: ownerId,
      due_at: dueInMinutes(action.taskDueMinutes ?? 15),
      status: "open",
      priority: action.taskPriority ?? "normal",
      kind: action.taskKind ?? "other",
      created_by: actorId,
    });
    await createDefaultTaskReminder(supabase, {
      organizationId,
      caseId,
      task,
      createdBy: actorId,
    });
  }

  if (input.action === "invoice") {
    await throwOnResult(
      supabase
        .from("motorist_cases")
        .update({
          payment_details: {
            ...objectJson(caseRow.payment_details),
            method: "invoice",
            status: input.paymentStatus ?? "unpaid",
          },
          closure_details: {
            ...objectJson(caseRow.closure_details),
            status: "invoice_requested",
            note: cleanString(input.note) ?? "Fakturácia pripravená na kontrolu.",
          },
        })
        .eq("organization_id", organizationId)
        .eq("id", caseId),
    );
  }

  await insertSingle<CaseEventRow>(
    supabase
      .from("motorist_case_events")
      .insert({
        organization_id: organizationId,
        case_id: caseId,
        actor_profile_id: actorId,
        event_type: input.action,
        title: action.title,
        body: action.body,
        payload: { source: "case_card_action", note: input.note ?? null },
      })
      .select("*")
      .single(),
  );
  await audit(supabase, organizationId, actorId, `case.action.${input.action}`, "motorist_cases", caseId, {
    case_number: caseRow.case_number,
  });
}

export async function assignCase(caseId: string, input: AssignCaseInput, actorProfileId?: string) {
  if (!nonEmpty(caseId) || !nonEmpty(input.assetId)) {
    throw new MutationError("Chýba prípad alebo technika.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const organizationId = organization.id;
  const caseRow = await getCase(supabase, organizationId, caseId);

  if (!caseRow.pickup_location_id) {
    throw new MutationError("Pred priradením techniky doplň miesto incidentu.", 409, "CASE_PICKUP_REQUIRED");
  }

  if (requiresTowDestination(effectiveJobTypesForUpdate(caseRow, {})) && !caseRow.destination_location_id) {
    throw new MutationError("Odťah alebo vyslobodenie vyžaduje cieľ.", 409, "CASE_DESTINATION_REQUIRED");
  }

  const asset = await getFleetAsset(supabase, organizationId, input.assetId);
  const ownerId = caseRow.owner_id ?? (await resolveDefaultOwnerId(supabase, organizationId));
  // Priradenie techniky sa v histórii pripisuje prihlásenému dispečerovi (P-01).
  const actorId = nonEmpty(actorProfileId) ? (await getProfile(supabase, organizationId, actorProfileId)).id : ownerId;
  let assignmentOccupancy: FleetAssetOccupancy | undefined;
  let occupancySnapshotAt: string | null = null;

  // T2: SWHouse je zdroj pravdy obsadenosti. Obsadené aj neisté auto
  // vyžaduje vedomé potvrdenie; overene voľné prejde bez prerušenia.
  if (asset.kind === "replacement_car") {
    const occupancySnapshot = await loadLatestOccupancySnapshot(supabase, organizationId);
    assignmentOccupancy = deriveReplacementOccupancy(occupancySnapshot, asset.license_plate);
    occupancySnapshotAt = occupancySnapshot?.capturedAt ?? null;
    if (isOccupiedAssignmentBlocked(assignmentOccupancy, input.allowOccupiedOverride === true)) {
      throw new MutationError(
        `Vozidlo ${asset.label}${asset.license_plate ? ` (${asset.license_plate})` : ""} je podľa SWHouse aktuálne prenajaté. Priradenie potvrď explicitne (override).`,
        409,
        "OCCUPIED_ASSET_CONFIRMATION_REQUIRED",
      );
    }
    if (isUnverifiedAssignmentBlocked(assignmentOccupancy, input.allowUnverifiedOverride === true)) {
      throw new MutationError(
        `Dostupnosť vozidla ${asset.label}${asset.license_plate ? ` (${asset.license_plate})` : ""} nie je v SWHouse aktuálne overená. Pred priradením ju potvrď manuálne.`,
        409,
        "UNVERIFIED_ASSET_CONFIRMATION_REQUIRED",
      );
    }
  }

  await throwOnResult(
    supabase
      .from("motorist_cases")
      .update({ status: "assigned", selected_asset_id: asset.id })
      .eq("organization_id", organizationId)
      .eq("id", caseId),
  );
  await throwOnResult(
    supabase
      .from("motorist_fleet_assets")
      .update({
        status: "assigned",
        occupied_from: new Date().toISOString(),
        occupancy_type: "case_assignment",
        occupancy_case_id: caseId,
        occupancy_note: `Priradené k prípadu ${caseRow.case_number}`,
      })
      .eq("organization_id", organizationId)
      .eq("id", asset.id),
  );
  await insertSingle<CaseEventRow>(
    supabase
      .from("motorist_case_events")
      .insert({
        organization_id: organizationId,
        case_id: caseId,
        actor_profile_id: actorId,
        event_type: "asset_assigned",
        title: "Technika priradená",
        body: `${asset.label} · ${asset.license_plate ?? "bez EČV"}`,
        payload: {
          asset_id: asset.id,
          source: "dispatch_console",
          occupancy: assignmentOccupancy ?? null,
          occupancy_snapshot_at: occupancySnapshotAt,
          occupied_override: input.allowOccupiedOverride === true,
          unverified_override: input.allowUnverifiedOverride === true,
        },
      })
      .select("*")
      .single(),
  );
  const smsTask = await insertCaseTask(supabase, {
    organization_id: organizationId,
    case_id: caseId,
    title: "Poslať lokalizačnú SMS",
    assigned_to: ownerId,
    due_at: dueInMinutes(5),
    status: "open",
    priority: "high",
    kind: "sms",
    created_by: actorId,
  });
  await createDefaultTaskReminder(supabase, {
    organizationId,
    caseId,
    task: smsTask,
    createdBy: actorId,
  });
  await audit(supabase, organizationId, actorId, "case.assign_asset", "motorist_cases", caseId, {
    asset_id: asset.id,
    asset_label: asset.label,
    occupancy: assignmentOccupancy ?? null,
    occupancy_snapshot_at: occupancySnapshotAt,
    occupied_override: input.allowOccupiedOverride === true,
    unverified_override: input.allowUnverifiedOverride === true,
  });
}

export async function markNotificationRead(notificationId: string) {
  return updateNotificationStatus(notificationId, "read");
}

export async function snoozeNotification(
  notificationId: string,
  snoozedUntil: string,
  actor: Pick<ProfileRow, "id" | "organization_id">,
) {
  if (!nonEmpty(notificationId)) {
    throw new MutationError("Chýba notifikácia.", 400);
  }

  const snoozedUntilTime = new Date(snoozedUntil).getTime();
  const nowTime = Date.now();
  if (!Number.isFinite(snoozedUntilTime) || snoozedUntilTime < nowTime + 30_000) {
    throw new MutationError("Čas pripomenutia musí byť v budúcnosti.", 400);
  }
  if (snoozedUntilTime > nowTime + 366 * 24 * 60 * 60 * 1_000) {
    throw new MutationError("Pripomenutie možno odložiť najviac o jeden rok.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organizationId = actor.organization_id;
  const ownerId = actor.id;
  const now = new Date(nowTime).toISOString();
  const normalizedSnoozedUntil = new Date(snoozedUntilTime).toISOString();
  const existing = await supabase
    .from("motorist_notifications")
    .select("id,payload,recipient_profile_id")
    .eq("organization_id", organizationId)
    .eq("id", notificationId)
    .maybeSingle();

  if (isNotificationSchemaMiss(existing.error)) {
    throw new MutationError("Notifikácie zatiaľ nie sú dostupné. Treba nasadiť Supabase migráciu pre notifikačné tabuľky.", 503);
  }
  await throwOnResult(existing);
  if (!existing.data) {
    throw new MutationError("Notifikácia sa nenašla.", 404);
  }
  if (existing.data.recipient_profile_id !== ownerId) {
    throw new MutationError("Túto notifikáciu nemožno odložiť.", 403);
  }

  const result = await supabase
    .from("motorist_notifications")
    .update({
      status: "unread",
      read_at: null,
      archived_at: null,
      payload: {
        ...objectJson(existing.data.payload),
        snoozed_at: now,
        snoozed_until: normalizedSnoozedUntil,
      },
    })
    .eq("organization_id", organizationId)
    .eq("id", notificationId)
    .select("id")
    .maybeSingle();

  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Notifikáciu sa nepodarilo odložiť.", 404);
  }

  await audit(supabase, organizationId, ownerId, "notification.snoozed", "motorist_notifications", result.data.id, {
    snoozed_until: normalizedSnoozedUntil,
  });

  return result.data as Pick<NotificationRow, "id">;
}

export async function updateNotificationStatus(notificationId: string, status: NotificationRow["status"]) {
  if (!nonEmpty(notificationId)) {
    throw new MutationError("Chýba notifikácia.", 400);
  }
  if (status !== "unread" && status !== "read" && status !== "archived") {
    throw new MutationError("Neplatný stav notifikácie.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const organizationId = organization.id;
  const ownerId = await resolveDefaultOwnerId(supabase, organizationId);
  const now = new Date().toISOString();
  const result = await supabase
    .from("motorist_notifications")
    .update(notificationStatusUpdatePayload(status, now))
    .eq("organization_id", organizationId)
    .eq("id", notificationId)
    .select("id")
    .maybeSingle();

  if (isNotificationSchemaMiss(result.error)) {
    throw new MutationError("Notifikácie zatiaľ nie sú dostupné. Treba nasadiť Supabase migráciu pre notifikačné tabuľky.", 503);
  }

  await throwOnResult(result);

  if (!result.data) {
    throw new MutationError("Notifikácia sa nenašla.", 404);
  }

  await audit(supabase, organizationId, ownerId, `notification.${status}`, "motorist_notifications", result.data.id, {});
  return result.data as Pick<NotificationRow, "id">;
}

export async function createBranch(input: CreateBranchInput) {
  if (!nonEmpty(input.name) || !isValidPlaceSelection(input.location)) {
    throw new MutationError("Pobočka potrebuje názov a Google adresu.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const location = await createLocation(supabase, organization.id, input.location, input.name);
  const branch = await insertSingle<BranchRow>(
    supabase
      .from("motorist_branches")
      .insert({
        organization_id: organization.id,
        name: input.name.trim(),
        address: input.location.address.trim(),
        phone: input.phone.trim() || null,
        location_id: location.id,
        available_replacement_cars: Math.max(0, Math.round(input.availableReplacementCars || 0)),
        active: true,
        metadata: { source: "settings_form" },
      })
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, null, "branch.create", "motorist_branches", branch.id, {
    name: branch.name,
  });

  return branch;
}

export async function createPartnerDirectoryEntry(input: PartnerDirectoryInput, authorize?: OrganizationAuthorizer) {
  validatePartnerDirectoryInput(input);

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  await authorizeOrganizationAccess(authorize, organization.id);
  const existingResult = await supabase
    .from("motorist_partner_directory")
    .select("*")
    .eq("organization_id", organization.id)
    .eq("kind", input.kind)
    .eq("name", input.name.trim())
    .order("active", { ascending: false })
    .limit(1)
    .maybeSingle();
  await throwOnResult(existingResult);

  if (existingResult.data) {
    const entry = await insertSingle<PartnerDirectoryRow>(
      supabase
        .from("motorist_partner_directory")
        .update({
          ico: cleanString(input.ico),
          phone: cleanString(input.phone),
          email: cleanString(input.email),
          active: input.active ?? true,
          metadata: { note: cleanString(input.note) },
        })
        .eq("organization_id", organization.id)
        .eq("id", existingResult.data.id)
        .select("*")
        .single(),
    );

    await audit(supabase, organization.id, null, "partner_directory.reactivate", "motorist_partner_directory", entry.id, {
      kind: entry.kind,
      name: entry.name,
      active: entry.active,
    });

    return entry;
  }

  const entry = await insertSingle<PartnerDirectoryRow>(
    supabase
      .from("motorist_partner_directory")
      .insert({
        organization_id: organization.id,
        kind: input.kind,
        name: input.name.trim(),
        ico: cleanString(input.ico),
        phone: cleanString(input.phone),
        email: cleanString(input.email),
        active: input.active ?? true,
        metadata: { note: cleanString(input.note) },
      })
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, null, "partner_directory.create", "motorist_partner_directory", entry.id, {
    kind: entry.kind,
    name: entry.name,
  });

  return entry;
}

export async function updatePartnerDirectoryEntry(id: string, input: Partial<PartnerDirectoryInput>, authorize?: OrganizationAuthorizer) {
  if (!nonEmpty(id)) {
    throw new MutationError("Chýba položka adresára.", 400);
  }
  validatePartnerDirectoryInput(input, false);

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  await authorizeOrganizationAccess(authorize, organization.id);
  await getPartnerDirectoryEntry(supabase, organization.id, id);

  const entry = await insertSingle<PartnerDirectoryRow>(
    supabase
      .from("motorist_partner_directory")
      .update({
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.ico !== undefined ? { ico: cleanString(input.ico) } : {}),
        ...(input.phone !== undefined ? { phone: cleanString(input.phone) } : {}),
        ...(input.email !== undefined ? { email: cleanString(input.email) } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.note !== undefined ? { metadata: { note: cleanString(input.note) } } : {}),
      })
      .eq("organization_id", organization.id)
      .eq("id", id)
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, null, "partner_directory.update", "motorist_partner_directory", entry.id, {
    kind: entry.kind,
    name: entry.name,
    active: entry.active,
  });

  return entry;
}

export async function deletePartnerDirectoryEntry(id: string, authorize?: OrganizationAuthorizer) {
  if (!nonEmpty(id)) {
    throw new MutationError("Chýba položka adresára.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  await authorizeOrganizationAccess(authorize, organization.id);
  const entry = await getPartnerDirectoryEntry(supabase, organization.id, id);
  await throwOnResult(supabase.from("motorist_partner_directory").update({ active: false }).eq("organization_id", organization.id).eq("id", id));
  await audit(supabase, organization.id, null, "partner_directory.deactivate", "motorist_partner_directory", id, {
    kind: entry.kind,
    name: entry.name,
    source: "settings_form",
  });
}

/**
 * Nahrá do adresára asistenčné služby, ktoré sa už používajú v prípadoch,
 * ale v adresári chýbajú (P-08). Mená sa porovnávajú bez ohľadu na veľkosť
 * písmen; deaktivované záznamy sa nerecyklujú (reaktivácia je vedomá akcia v UI).
 */
export async function backfillAssistanceDirectoryFromCases(authorize?: OrganizationAuthorizer) {
  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  await authorizeOrganizationAccess(authorize, organization.id);

  const casesResult = await supabase.from("motorist_cases").select("customer_details").eq("organization_id", organization.id);
  await throwOnResult(casesResult);

  const usedNames = new Map<string, string>();

  for (const row of casesResult.data ?? []) {
    const details = objectJson(row.customer_details);
    const name = typeof details.assistanceServiceName === "string" ? details.assistanceServiceName.trim() : "";

    if (!name) {
      continue;
    }

    const key = name.toLocaleLowerCase("sk");

    if (!usedNames.has(key)) {
      usedNames.set(key, name);
    }
  }

  const directoryResult = await supabase
    .from("motorist_partner_directory")
    .select("name")
    .eq("organization_id", organization.id)
    .eq("kind", "assistance");
  await throwOnResult(directoryResult);

  const existing = new Set((directoryResult.data ?? []).map((entry) => entry.name.trim().toLocaleLowerCase("sk")));
  const missing = [...usedNames.entries()]
    .filter(([key]) => !existing.has(key))
    .map(([, name]) => name)
    .sort((left, right) => left.localeCompare(right, "sk"));

  const created: string[] = [];

  for (const name of missing) {
    const entry = await insertSingle<PartnerDirectoryRow>(
      supabase
        .from("motorist_partner_directory")
        .insert({
          organization_id: organization.id,
          kind: "assistance",
          name,
          active: true,
          metadata: { note: "Prevzaté z prípadov" },
        })
        .select("*")
        .single(),
    );
    created.push(entry.name);
  }

  if (created.length > 0) {
    await audit(supabase, organization.id, null, "partner_directory.backfill_assistance", "motorist_partner_directory", organization.id, {
      created,
    });
  }

  return { created };
}

export async function uploadCaseAttachments(caseId: string, files: File[], note?: string, authorize?: OrganizationAuthorizer) {
  if (!nonEmpty(caseId)) {
    throw new MutationError("Chýba prípad.", 400);
  }
  if (files.length === 0) {
    throw new MutationError("Vyber aspoň jeden súbor.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  await authorizeOrganizationAccess(authorize, organization.id);
  const caseRow = await getCase(supabase, organization.id, caseId);
  const ownerId = caseRow.owner_id ?? (await resolveDefaultOwnerId(supabase, organization.id));
  const existingAttachments = attachmentMetadataPayloadFromJson(caseRow.attachments_metadata);
  const createdAt = new Date().toISOString();
  const uploadedAttachments: CaseAttachmentInput[] = [];
  const uploadedPaths: string[] = [];
  let metadataUpdated = false;

  files.forEach(validateCaseAttachmentFile);

  try {
    for (const file of files) {
      const id = crypto.randomUUID();
      const storagePath = `${organization.id}/cases/${caseId}/${id}-${safeStorageFileName(file.name)}`;
      const bytes = await file.arrayBuffer();
      const uploadResult = await supabase.storage.from(CASE_ATTACHMENTS_BUCKET).upload(storagePath, bytes, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      await throwOnResult(uploadResult);
      uploadedPaths.push(storagePath);
      uploadedAttachments.push({
        id,
        category: attachmentCategoryForMime(file.type),
        fileName: file.name,
        storageBucket: CASE_ATTACHMENTS_BUCKET,
        storagePath,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        note,
        createdAt,
      });
    }

    const nextAttachments = [...existingAttachments, ...uploadedAttachments];
    await throwOnResult(
      supabase
        .from("motorist_cases")
        .update({ attachments_metadata: trustedAttachmentMetadataPayload(nextAttachments) })
        .eq("organization_id", organization.id)
        .eq("id", caseId),
    );
    metadataUpdated = true;

    await insertSingle<CaseEventRow>(
      supabase
        .from("motorist_case_events")
        .insert({
          organization_id: organization.id,
          case_id: caseId,
          actor_profile_id: ownerId,
          event_type: "attachments_uploaded",
          title: "Dokumenty nahraté",
          body: `${uploadedAttachments.length} súbor(ov) bolo uložených do privátneho storage.`,
          payload: { source: "case_attachments", attachments: trustedAttachmentMetadataPayload(uploadedAttachments) },
        })
        .select("*")
        .single(),
    );
    await audit(supabase, organization.id, ownerId, "case.attachments.upload", "motorist_cases", caseId, {
      count: uploadedAttachments.length,
    });
  } catch (error) {
    if (metadataUpdated) {
      const restoreResult = await supabase
        .from("motorist_cases")
        .update({ attachments_metadata: trustedAttachmentMetadataPayload(existingAttachments) })
        .eq("organization_id", organization.id)
        .eq("id", caseId);

      if (restoreResult.error) {
        console.warn("Case attachment metadata restore failed:", restoreResult.error.message);
      }
    }

    if (uploadedPaths.length > 0) {
      const cleanupResult = await supabase.storage.from(CASE_ATTACHMENTS_BUCKET).remove(uploadedPaths);
      if (cleanupResult.error) {
        console.warn("Case attachment cleanup failed:", cleanupResult.error.message);
      }
    }
    throw error;
  }

  return uploadedAttachments;
}

export async function createCaseAttachmentSignedUrl(caseId: string, attachmentId: string, authorize?: OrganizationAuthorizer) {
  if (!nonEmpty(caseId) || !nonEmpty(attachmentId)) {
    throw new MutationError("Chýba prípad alebo príloha.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  await authorizeOrganizationAccess(authorize, organization.id);
  const caseRow = await getCase(supabase, organization.id, caseId);
  const attachment = attachmentMetadataPayloadFromJson(caseRow.attachments_metadata).find((item) => item.id === attachmentId);

  if (!attachment?.storagePath) {
    throw new MutationError("Príloha nemá storage cestu.", 404);
  }

  const bucket = attachment.storageBucket ?? CASE_ATTACHMENTS_BUCKET;

  if (bucket !== CASE_ATTACHMENTS_BUCKET) {
    throw new MutationError("Príloha nepatrí do povoleného storage bucketu.", 403);
  }

  const expectedPrefix = `${organization.id}/cases/${caseId}/`;

  if (!attachment.storagePath.startsWith(expectedPrefix)) {
    throw new MutationError("Príloha nepatrí k tomuto prípadu.", 403);
  }

  const signedUrlResult = await supabase.storage.from(CASE_ATTACHMENTS_BUCKET).createSignedUrl(attachment.storagePath, 300, {
    download: attachment.fileName,
  });
  await throwOnResult(signedUrlResult);

  if (!signedUrlResult.data?.signedUrl) {
    throw new MutationError("Signed URL sa nepodarilo vytvoriť.");
  }

  return {
    attachmentId,
    fileName: attachment.fileName,
    signedUrl: signedUrlResult.data.signedUrl,
    expiresIn: 300,
  };
}

export async function createFleetAsset(input: CreateFleetAssetInput) {
  if (!nonEmpty(input.label) || !nonEmpty(input.branchId)) {
    throw new MutationError("Technika potrebuje názov a pobočku.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const branch = await getBranch(supabase, organization.id, input.branchId);
  const currentLocationId = input.location
    ? (await createLocation(supabase, organization.id, input.location, input.label)).id
    : branch.location_id;
  const asset = await insertSingle<FleetAssetRow>(
    supabase
      .from("motorist_fleet_assets")
      .insert({
        organization_id: organization.id,
        kind: input.kind,
        label: input.label.trim(),
        ...fleetAssetWritePayload(input),
        branch_id: branch.id,
        current_location_id: currentLocationId,
        location_source: input.location ? "manual" : "settings_form",
        metadata: { source: "settings_form" },
      })
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, null, "fleet_asset.create", "motorist_fleet_assets", asset.id, {
    label: asset.label,
    branch_id: branch.id,
  });

  return asset;
}

export async function updateFleetAsset(id: string, input: UpdateFleetAssetInput) {
  if (!nonEmpty(id)) {
    throw new MutationError("Chýba vozidlo flotily.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const existing = await getFleetAsset(supabase, organization.id, id);
  const branch = input.branchId ? await getBranch(supabase, organization.id, input.branchId) : null;
  const currentLocationId =
    input.location === null
      ? existing.current_location_id
      : input.location
        ? (await createLocation(supabase, organization.id, input.location, input.label ?? existing.label)).id
        : existing.current_location_id;
  const payload = {
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.label ? { label: input.label.trim() } : {}),
    ...fleetAssetWritePayload(input),
    ...(branch ? { branch_id: branch.id } : {}),
    current_location_id: currentLocationId,
    ...(input.location ? { location_source: "manual" } : {}),
    ...(input.status && objectJson(existing.metadata).availabilityUnverified === true
      ? { metadata: { ...objectJson(existing.metadata), availabilityUnverified: false } } : {}),
  };
  const asset = await insertSingle<FleetAssetRow>(
    supabase
      .from("motorist_fleet_assets")
      .update(payload)
      .eq("organization_id", organization.id)
      .eq("id", id)
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, null, "fleet_asset.update", "motorist_fleet_assets", asset.id, {
    label: asset.label,
    status: asset.status,
  });

  return asset;
}

export async function confirmCommanderVehicleLink(input: { externalVehicleRecordId: string; fleetAssetId: string }) {
  if (!nonEmpty(input.externalVehicleRecordId) || !nonEmpty(input.fleetAssetId)) {
    throw new MutationError("Chýba Commander vozidlo alebo náhradné vozidlo.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const externalRecord = await getCommanderExternalVehicle(supabase, organization.id, input.externalVehicleRecordId);
  const asset = await getFleetAsset(supabase, organization.id, input.fleetAssetId);

  assertReplacementAsset(asset);

  const link = await upsertCommanderLink(supabase, organization.id, actorId, externalRecord, asset);

  await audit(supabase, organization.id, actorId, "commander_vehicle.link", "motorist_fleet_asset_links", link.id, {
    external_vehicle_record_id: externalRecord.id,
    fleet_asset_id: asset.id,
    source_vehicle_id: externalRecord.source_vehicle_id,
  });

  return link;
}

export async function rejectCommanderVehicle(input: { externalVehicleRecordId: string }) {
  if (!nonEmpty(input.externalVehicleRecordId)) {
    throw new MutationError("Chýba Commander vozidlo.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const externalRecord = await getCommanderExternalVehicle(supabase, organization.id, input.externalVehicleRecordId);
  const now = new Date().toISOString();
  const existing = await getLatestCommanderLink(supabase, organization.id, externalRecord.id);
  const metadata = { reason: "manual_reject", source: "fleet_gps_connections" };
  const link = existing
    ? await insertSingle<FleetAssetLinkRow>(
        supabase
          .from("motorist_fleet_asset_links")
          .update({
            link_status: "rejected",
            match_method: "manual",
            match_confidence: 0,
            confirmed_at: null,
            confirmed_by: null,
            rejected_at: now,
            rejected_by: actorId,
            metadata: { ...objectJson(existing.metadata), ...metadata },
          })
          .eq("organization_id", organization.id)
          .eq("id", existing.id)
          .select("*")
          .single(),
      )
    : await insertSingle<FleetAssetLinkRow>(
        supabase
          .from("motorist_fleet_asset_links")
          .insert({
            organization_id: organization.id,
            fleet_asset_id: null,
            external_vehicle_record_id: externalRecord.id,
            source_provider: "commander",
            link_status: "rejected",
            match_method: "manual",
            match_confidence: 0,
            rejected_at: now,
            rejected_by: actorId,
            metadata,
          })
          .select("*")
          .single(),
      );

  await clearCommanderCurrentPositionLink(supabase, organization.id, externalRecord.id);
  await audit(supabase, organization.id, actorId, "commander_vehicle.reject", "motorist_fleet_asset_links", link.id, {
    external_vehicle_record_id: externalRecord.id,
    source_vehicle_id: externalRecord.source_vehicle_id,
  });

  return link;
}

export async function unlinkCommanderVehicle(input: { linkId: string }) {
  if (!nonEmpty(input.linkId)) {
    throw new MutationError("Chýba link na zrušenie.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const existing = await getCommanderLink(supabase, organization.id, input.linkId);
  const now = new Date().toISOString();
  const link = await insertSingle<FleetAssetLinkRow>(
    supabase
      .from("motorist_fleet_asset_links")
      .update({
        link_status: "rejected",
        confirmed_at: null,
        confirmed_by: null,
        rejected_at: now,
        rejected_by: actorId,
        metadata: { ...objectJson(existing.metadata), reason: "manual_unlink", previous_fleet_asset_id: existing.fleet_asset_id },
      })
      .eq("organization_id", organization.id)
      .eq("id", existing.id)
      .select("*")
      .single(),
  );

  await clearCommanderCurrentPositionLink(supabase, organization.id, existing.external_vehicle_record_id);
  await audit(supabase, organization.id, actorId, "commander_vehicle.unlink", "motorist_fleet_asset_links", link.id, {
    external_vehicle_record_id: existing.external_vehicle_record_id,
    previous_fleet_asset_id: existing.fleet_asset_id,
  });

  return link;
}

/**
 * Automatické dopárovanie: pre každý Commander záznam, ktorého ŠPZ/VIN jednoznačne sedí so SWHouse autom
 * (má potvrdený client_vehicle_db link) BEZ Commander napojenia → presuň naň Commander polohu.
 * Ak Commander záznam predtým visel na duchovi, ktorý tým ostane prázdny, ducha odstráni.
 * Toto rieši „keď v Commanderi opravia ŠPZ, jedno Obnoviť dopáruje".
 */
export async function autoConfirmCommanderLinks(): Promise<{ autoPaired: number }> {
  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);

  const recordsResult = await supabase
    .from("motorist_external_vehicle_records")
    .select("*")
    .eq("organization_id", organization.id)
    .eq("source_provider", "commander")
    .eq("source_active", true);
  await throwOnResult(recordsResult);
  const records = recordsResult.data ?? [];

  const assetsResult = await supabase
    .from("motorist_fleet_assets")
    .select("*")
    .eq("organization_id", organization.id)
    .eq("kind", "replacement_car");
  await throwOnResult(assetsResult);
  const assets = assetsResult.data ?? [];

  const swhouseLinksResult = await supabase
    .from("motorist_fleet_asset_links")
    .select("fleet_asset_id")
    .eq("organization_id", organization.id)
    .eq("source_provider", "client_vehicle_db")
    .eq("link_status", "confirmed");
  await throwOnResult(swhouseLinksResult);
  const swhouseAssetIds = new Set((swhouseLinksResult.data ?? []).map((link) => link.fleet_asset_id));

  const commanderLinksResult = await supabase
    .from("motorist_fleet_asset_links")
    .select("external_vehicle_record_id,fleet_asset_id,link_status,match_method")
    .eq("organization_id", organization.id)
    .eq("source_provider", "commander");
  await throwOnResult(commanderLinksResult);
  const confirmed = (commanderLinksResult.data ?? []).filter((link) => link.link_status === "confirmed");
  const manuallyRejected = new Set((commanderLinksResult.data ?? []).filter((link) => link.link_status === "rejected" && link.match_method === "manual").map((link) => link.external_vehicle_record_id));
  const commanderAssetByRecord = new Map(confirmed.map((link) => [link.external_vehicle_record_id, link.fleet_asset_id]));
  const commanderLinkedAssetIds = new Set(confirmed.map((link) => link.fleet_asset_id).filter((id): id is string => Boolean(id)));

  // Kandidáti = SWHouse autá (zdroj pravdy) bez Commander napojenia. Jednoznačná ŠPZ/VIN mapa (nejednoznačné vynechá).
  const matches = matchFleetIdentities(
    records.map((record) => ({ id: record.id, plate: record.normalized_license_plate, vin: record.normalized_vin })),
    assets.filter((asset) => swhouseAssetIds.has(asset.id)).map((asset) => ({ id: asset.id, plate: asset.license_plate, vin: asset.vin })),
  ).filter((match) => !commanderAssetByRecord.has(match.sourceId) && !commanderLinkedAssetIds.has(match.targetId) && !manuallyRejected.has(match.sourceId));
  // Bounded concurrency for the initial fleet import. Never replace confirmed links or delete assets automatically.
  let autoPaired = 0;
  for (let offset = 0; offset < matches.length; offset += 4) {
    const results = await Promise.allSettled(matches.slice(offset, offset + 4).map(async (match) => {
      const record = records.find((record) => record.id === match.sourceId)!;
      const asset = assets.find((asset) => asset.id === match.targetId)!;
      await upsertCommanderLink(supabase, organization.id, actorId, record, asset, match.method);
    }));
    autoPaired += results.filter((result) => result.status === "fulfilled").length;
    const failed = results.find((result) => result.status === "rejected" && !(result.reason instanceof MutationError && result.reason.status === 409));
    if (failed?.status === "rejected") throw failed.reason;
  }
  return { autoPaired };
}

/**
 * Ručné priradenie z panela: Commander vozidlo → SWHouse auto. Presunie polohu a odstráni pôvodného ducha (ak ostal prázdny).
 */
export async function assignCommanderToSwhouseCar(input: { commanderRecordId: string; swhouseAssetId: string }) {
  if (!nonEmpty(input.commanderRecordId) || !nonEmpty(input.swhouseAssetId)) {
    throw new MutationError("Chýba Commander vozidlo alebo SWHouse auto.", 400);
  }
  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const externalRecord = await getCommanderExternalVehicle(supabase, organization.id, input.commanderRecordId);
  const targetAsset = await getFleetAsset(supabase, organization.id, input.swhouseAssetId);
  assertReplacementAsset(targetAsset);

  const previous = await getConfirmedCommanderLink(supabase, organization.id, externalRecord.id);
  const previousAssetId = previous?.fleet_asset_id ?? null;

  const link = await upsertCommanderLink(supabase, organization.id, actorId, externalRecord, targetAsset);

  let removedDuplicate = false;
  if (previousAssetId && previousAssetId !== targetAsset.id) {
    removedDuplicate = await tryDeleteGhostAsset(supabase, organization.id, actorId, previousAssetId);
  }

  await audit(supabase, organization.id, actorId, "fleet_pairing.assign", "motorist_fleet_asset_links", link.id, {
    external_vehicle_record_id: externalRecord.id,
    fleet_asset_id: targetAsset.id,
    previous_fleet_asset_id: previousAssetId,
    removed_duplicate: removedDuplicate,
  });

  return { linkId: link.id, removedDuplicate };
}

/**
 * „Označiť ako predané / vyradené": odstráni ducha (Commander auto, ktoré SWHouse nepozná).
 */
export async function decommissionGhostAsset(input: { assetId: string }) {
  if (!nonEmpty(input.assetId)) {
    throw new MutationError("Chýba vozidlo na vyradenie.", 400);
  }
  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const asset = await getFleetAsset(supabase, organization.id, input.assetId);
  await assertDeletableGhost(supabase, organization.id, asset);
  await deleteGhostAssetRow(supabase, organization.id, actorId, asset);
  return { id: asset.id };
}

/** Zmaže ducha, ak prejde guardom; inak ho ticho nechá (pre auto/assign cleanup). Vráti či zmazal. */
async function tryDeleteGhostAsset(supabase: AdminClient, organizationId: string, actorId: string | null, assetId: string): Promise<boolean> {
  try {
    const asset = await getFleetAsset(supabase, organizationId, assetId);
    await assertDeletableGhost(supabase, organizationId, asset);
    await deleteGhostAssetRow(supabase, organizationId, actorId, asset);
    return true;
  } catch {
    return false;
  }
}

async function assertDeletableGhost(supabase: AdminClient, organizationId: string, asset: FleetAssetRow) {
  if (asset.kind !== "replacement_car") {
    throw new MutationError("Odstrániť sa dá len náhradné vozidlo.", 400);
  }
  const swhouseLink = await supabase
    .from("motorist_fleet_asset_links")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("fleet_asset_id", asset.id)
    .eq("source_provider", "client_vehicle_db")
    .eq("link_status", "confirmed")
    .limit(1);
  await throwOnResult(swhouseLink);
  if ((swhouseLink.data ?? []).length > 0) {
    throw new MutationError("Toto auto vedie SWHouse — nedá sa odstrániť.", 409);
  }
  if (asset.occupancy_case_id || asset.status === "assigned" || asset.status === "busy") {
    throw new MutationError("Auto je práve priradené k prípadu — najprv ho uvoľni.", 409);
  }
  const activeCase = await supabase
    .from("motorist_cases")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("selected_asset_id", asset.id)
    .not("status", "in", "(completed_assisted,completed_no_assistance,rejected,cancelled,futile_trip)")
    .limit(1);
  await throwOnResult(activeCase);
  if ((activeCase.data ?? []).length > 0) {
    throw new MutationError("Auto je naviazané na aktívny prípad — najprv ho uvoľni.", 409);
  }
}

async function deleteGhostAssetRow(supabase: AdminClient, organizationId: string, actorId: string | null, asset: FleetAssetRow) {
  await throwOnResult(
    supabase.from("motorist_cases").update({ selected_asset_id: null }).eq("organization_id", organizationId).eq("selected_asset_id", asset.id),
  );
  await throwOnResult(supabase.from("motorist_fleet_assets").delete().eq("organization_id", organizationId).eq("id", asset.id));
  await audit(supabase, organizationId, actorId, "fleet_asset.decommission", "motorist_fleet_assets", asset.id, {
    license_plate: asset.license_plate,
    source_system: asset.source_system,
  });
}

export async function importCommanderVehicle(input: { externalVehicleRecordId: string; branchId: string }) {
  if (!nonEmpty(input.externalVehicleRecordId) || !nonEmpty(input.branchId)) {
    throw new MutationError("Import potrebuje Commander vozidlo a pobočku.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const externalRecord = await getCommanderExternalVehicle(supabase, organization.id, input.externalVehicleRecordId);
  const branch = await getBranch(supabase, organization.id, input.branchId);
  const confirmed = await getConfirmedCommanderLink(supabase, organization.id, externalRecord.id);

  if (confirmed?.fleet_asset_id) {
    throw new MutationError("Commander vozidlo je už spárované s náhradným vozidlom.", 409);
  }

  const position = await getCommanderCurrentPosition(supabase, organization.id, externalRecord.id);
  const currentLocationId = position ? (await createCommanderLocation(supabase, organization.id, externalRecord, position)).id : branch.location_id;
  const asset = await insertSingle<FleetAssetRow>(
    supabase
      .from("motorist_fleet_assets")
      .insert({
        organization_id: organization.id,
        kind: "replacement_car",
        label: commanderAssetLabel(externalRecord),
        make: cleanString(externalRecord.make ?? undefined),
        model: cleanString(externalRecord.model ?? undefined),
        license_plate: cleanString(externalRecord.normalized_license_plate ?? undefined),
        vin: cleanString(externalRecord.normalized_vin ?? undefined),
        status: "available",
        branch_id: branch.id,
        current_location_id: currentLocationId,
        source_system: "commander",
        external_id: externalRecord.source_vehicle_id,
        location_source: "commander",
        capabilities: [],
        metadata: {
          source: "commander_import",
          external_vehicle_record_id: externalRecord.id,
          source_vehicle_id: externalRecord.source_vehicle_id,
        },
      })
      .select("*")
      .single(),
  );

  const link = await upsertCommanderLink(supabase, organization.id, actorId, externalRecord, asset);

  await audit(supabase, organization.id, actorId, "commander_vehicle.import", "motorist_fleet_assets", asset.id, {
    external_vehicle_record_id: externalRecord.id,
    source_vehicle_id: externalRecord.source_vehicle_id,
    link_id: link.id,
  });

  return asset;
}

export type ImportAllCommanderVehiclesInput = {
  branchId?: string;
  limit?: number;
  dryRun?: boolean;
};

export type ImportAllCommanderVehiclesResult = {
  candidates: number;
  imported: number;
  failed: number;
  remaining: number;
  branchId: string;
  dryRun: boolean;
  errors: Array<{ externalVehicleRecordId: string; error: string }>;
};

/**
 * Bulk-imports every active, not-yet-paired Commander vehicle as a replacement_car
 * fleet asset so it shows up on the dispatch map. Idempotent: records that already have
 * a confirmed Commander link are skipped, so re-running never creates duplicates.
 */
export async function importAllCommanderVehicles(
  input: ImportAllCommanderVehiclesInput = {},
): Promise<ImportAllCommanderVehiclesResult> {
  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const branch = input.branchId
    ? await getBranch(supabase, organization.id, input.branchId)
    : await getFirstBranch(supabase, organization.id);

  const linksResult = await supabase
    .from("motorist_fleet_asset_links")
    .select("external_vehicle_record_id, fleet_asset_id, link_status")
    .eq("organization_id", organization.id)
    .eq("source_provider", "commander")
    .eq("link_status", "confirmed");
  await throwOnResult(linksResult);
  const linkedRecordIds = new Set(
    (linksResult.data ?? []).filter((link) => link.fleet_asset_id).map((link) => link.external_vehicle_record_id),
  );

  const recordsResult = await supabase
    .from("motorist_external_vehicle_records")
    .select("*")
    .eq("organization_id", organization.id)
    .eq("source_provider", "commander")
    .eq("source_active", true)
    .order("created_at", { ascending: true });
  await throwOnResult(recordsResult);
  const candidates = (recordsResult.data ?? []).filter((record) => !linkedRecordIds.has(record.id));

  const limit = input.limit && input.limit > 0 ? input.limit : candidates.length;
  const batch = candidates.slice(0, limit);
  const errors: Array<{ externalVehicleRecordId: string; error: string }> = [];
  let imported = 0;
  let failed = 0;

  if (!input.dryRun) {
    for (const externalRecord of batch) {
      try {
        const position = await getCommanderCurrentPosition(supabase, organization.id, externalRecord.id);
        const currentLocationId = position
          ? (await createCommanderLocation(supabase, organization.id, externalRecord, position)).id
          : branch.location_id;
        const asset = await insertSingle<FleetAssetRow>(
          supabase
            .from("motorist_fleet_assets")
            .insert({
              organization_id: organization.id,
              kind: "replacement_car",
              label: commanderAssetLabel(externalRecord),
              make: cleanString(externalRecord.make ?? undefined),
              model: cleanString(externalRecord.model ?? undefined),
              license_plate: cleanString(externalRecord.normalized_license_plate ?? undefined),
              vin: cleanString(externalRecord.normalized_vin ?? undefined),
              status: "available",
              branch_id: branch.id,
              current_location_id: currentLocationId,
              source_system: "commander",
              external_id: externalRecord.source_vehicle_id,
              location_source: "commander",
              capabilities: [],
              metadata: {
                source: "commander_import_all",
                external_vehicle_record_id: externalRecord.id,
                source_vehicle_id: externalRecord.source_vehicle_id,
              },
            })
            .select("*")
            .single(),
        );
        await upsertCommanderLink(supabase, organization.id, actorId, externalRecord, asset);
        imported += 1;
      } catch (error) {
        failed += 1;
        errors.push({
          externalVehicleRecordId: externalRecord.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await audit(supabase, organization.id, actorId, "commander_vehicle.import_all", "motorist_branches", branch.id, {
      candidates: candidates.length,
      imported,
      failed,
    });
  }

  return {
    candidates: candidates.length,
    imported,
    failed,
    remaining: candidates.length - batch.length,
    branchId: branch.id,
    dryRun: Boolean(input.dryRun),
    errors: errors.slice(0, 10),
  };
}

async function getFirstBranch(supabase: AdminClient, organizationId: string): Promise<BranchRow> {
  const result = await supabase
    .from("motorist_branches")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Organizácia nemá žiadnu pobočku pre import.", 400);
  }
  return result.data;
}

export async function createAttendanceShift(input: CreateAttendanceShiftInput) {
  validateAttendanceShiftInput(input);

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const organizationProfile = await resolveOrganizationProfile(supabase, organization.id);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  await getProfile(supabase, organization.id, input.profileId);

  const shift = await insertSingle<AttendanceShiftRow>(
    supabase
      .from("motorist_attendance_shifts")
      .insert({
        organization_id: organization.id,
        profile_id: input.profileId,
        template_id: cleanString(input.templateId ?? undefined),
        status: input.publish ? "published" : "draft",
        date_local: input.dateLocal,
        timezone: organizationProfile?.timezone ?? "Europe/Bratislava",
        planned_start_at: input.plannedStartAt,
        planned_end_at: input.plannedEndAt,
        published_at: input.publish ? new Date().toISOString() : null,
        notes: cleanString(input.notes),
        created_by: actorId,
        updated_by: actorId,
      })
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, actorId, "attendance.shift.create", "motorist_attendance_shifts", shift.id, {
    profile_id: shift.profile_id,
    status: shift.status,
    planned_start_at: shift.planned_start_at,
    planned_end_at: shift.planned_end_at,
  });

  return shift;
}

export async function updateAttendanceShift(id: string, input: UpdateAttendanceShiftInput) {
  if (!nonEmpty(id)) {
    throw new MutationError("Chýba služba.", 400);
  }

  validateAttendanceShiftUpdateInput(input);

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  await getAttendanceShift(supabase, organization.id, id);

  if (input.profileId) {
    await getProfile(supabase, organization.id, input.profileId);
  }

  const payload = {
    ...(input.profileId ? { profile_id: input.profileId } : {}),
    ...(input.templateId !== undefined ? { template_id: cleanString(input.templateId ?? undefined) } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.dateLocal ? { date_local: input.dateLocal } : {}),
    ...(input.plannedStartAt ? { planned_start_at: input.plannedStartAt } : {}),
    ...(input.plannedEndAt ? { planned_end_at: input.plannedEndAt } : {}),
    ...(input.notes !== undefined ? { notes: cleanString(input.notes) } : {}),
    updated_by: actorId,
  };
  const shift = await insertSingle<AttendanceShiftRow>(
    supabase
      .from("motorist_attendance_shifts")
      .update(payload)
      .eq("organization_id", organization.id)
      .eq("id", id)
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, actorId, "attendance.shift.update", "motorist_attendance_shifts", shift.id, {
    profile_id: shift.profile_id,
    status: shift.status,
  });

  return shift;
}

export async function publishAttendanceShift(id: string) {
  return setAttendanceShiftStatus(id, "published", {
    published_at: new Date().toISOString(),
    declined_at: null,
    confirmed_at: null,
    confirmation_note: null,
  });
}

export async function confirmAttendanceShift(id: string, note?: string) {
  return setAttendanceShiftStatus(id, "confirmed", {
    confirmed_at: new Date().toISOString(),
    declined_at: null,
    confirmation_note: cleanString(note),
  });
}

export async function declineAttendanceShift(id: string, note?: string) {
  return setAttendanceShiftStatus(id, "declined", {
    declined_at: new Date().toISOString(),
    confirmation_note: cleanString(note),
  });
}

export async function createAttendanceRequest(input: CreateAttendanceRequestInput) {
  validateAttendanceRequestInput(input);

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  await getProfile(supabase, organization.id, input.profileId);
  const status = input.status ?? "pending";
  const request = await insertSingle<AttendanceRequestRow>(
    supabase
      .from("motorist_attendance_unavailability_requests")
      .insert({
        organization_id: organization.id,
        profile_id: input.profileId,
        type: input.type,
        status,
        start_date_local: input.startDateLocal,
        end_date_local: input.endDateLocal,
        start_time_local: cleanString(input.startTimeLocal ?? undefined),
        end_time_local: cleanString(input.endTimeLocal ?? undefined),
        reason: cleanString(input.reason),
        submitted_at: status === "pending" ? new Date().toISOString() : null,
        created_by: actorId,
      })
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, actorId, "attendance.request.create", "motorist_attendance_unavailability_requests", request.id, {
    profile_id: request.profile_id,
    type: request.type,
    status: request.status,
  });

  return request;
}

export async function updateAttendanceRequest(id: string, input: UpdateAttendanceRequestInput) {
  if (!nonEmpty(id)) {
    throw new MutationError("Chýba žiadosť.", 400);
  }

  validateAttendanceRequestUpdateInput(input);

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const existing = await getAttendanceRequest(supabase, organization.id, id);

  if (!["draft", "pending"].includes(existing.status)) {
    throw new MutationError("Upraviť sa dá iba draft alebo pending žiadosť.", 409);
  }

  if (input.profileId) {
    await getProfile(supabase, organization.id, input.profileId);
  }

  const status = input.status ?? existing.status;
  const request = await insertSingle<AttendanceRequestRow>(
    supabase
      .from("motorist_attendance_unavailability_requests")
      .update({
        ...(input.profileId ? { profile_id: input.profileId } : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(input.status ? { status } : {}),
        ...(input.startDateLocal ? { start_date_local: input.startDateLocal } : {}),
        ...(input.endDateLocal ? { end_date_local: input.endDateLocal } : {}),
        ...(input.startTimeLocal !== undefined ? { start_time_local: cleanString(input.startTimeLocal ?? undefined) } : {}),
        ...(input.endTimeLocal !== undefined ? { end_time_local: cleanString(input.endTimeLocal ?? undefined) } : {}),
        ...(input.reason !== undefined ? { reason: cleanString(input.reason) } : {}),
        ...(input.status === "pending" && existing.status === "draft" ? { submitted_at: new Date().toISOString() } : {}),
      })
      .eq("organization_id", organization.id)
      .eq("id", id)
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, actorId, "attendance.request.update", "motorist_attendance_unavailability_requests", request.id, {
    profile_id: request.profile_id,
    status: request.status,
  });

  return request;
}

export async function approveAttendanceRequest(id: string, note?: string) {
  return setAttendanceRequestStatus(id, "approved", note);
}

export async function declineAttendanceRequest(id: string, note?: string) {
  return setAttendanceRequestStatus(id, "declined", note);
}

export async function cancelAttendanceRequest(id: string) {
  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const existing = await getAttendanceRequest(supabase, organization.id, id);

  if (!["draft", "pending"].includes(existing.status)) {
    throw new MutationError("Zrušiť sa dá iba draft alebo pending žiadosť.", 409);
  }

  return setAttendanceRequestStatus(id, "cancelled");
}

export async function createBulkAttendanceShifts(input: CreateBulkAttendanceShiftsInput) {
  validateBulkAttendanceInput(input);

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const organizationProfile = await resolveOrganizationProfile(supabase, organization.id);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const timezone = organizationProfile?.timezone ?? "Europe/Bratislava";
  const assignments = input.assignments;
  const profileIds = [...new Set(assignments.map((assignment) => assignment.profileId))];
  const templateIds = [...new Set(assignments.map((assignment) => assignment.templateId))];
  const [profilesResult, templatesResult, requestsResult, shiftsResult] = await Promise.all([
    supabase.from("motorist_profiles").select("*").eq("organization_id", organization.id).in("id", profileIds),
    supabase.from("motorist_attendance_shift_templates").select("*").eq("organization_id", organization.id).in("id", templateIds),
    supabase
      .from("motorist_attendance_unavailability_requests")
      .select("*")
      .eq("organization_id", organization.id)
      .in("profile_id", profileIds)
      .in("status", ["approved", "pending"]),
    supabase
      .from("motorist_attendance_shifts")
      .select("*")
      .eq("organization_id", organization.id)
      .in("profile_id", profileIds)
      .not("status", "in", "(cancelled,declined)"),
  ]);
  await Promise.all([throwOnResult(profilesResult), throwOnResult(templatesResult), throwOnResult(requestsResult), throwOnResult(shiftsResult)]);

  const profilesById = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
  const templatesById = new Map((templatesResult.data ?? []).map((template) => [template.id, template]));
  const plannedRows = assignments.map((assignment, index) =>
    bulkAssignmentToShiftRow({
      assignment,
      index,
      organizationId: organization.id,
      timezone,
      actorId,
      publish: Boolean(input.publish),
      templatesById,
    }),
  );

  plannedRows.forEach((row) => {
    const profile = profilesById.get(row.profile_id);

    if (!profile?.active) {
      throw new MutationError("Neaktívny profil nie je možné naplánovať.", 409);
    }

    const approvedRequest = (requestsResult.data ?? []).find(
      (request) => request.profile_id === row.profile_id && request.status === "approved" && request.start_date_local <= row.date_local && request.end_date_local >= row.date_local,
    );

    if (approvedRequest) {
      throw new MutationError("Schválené voľno blokuje plánovanie.", 409);
    }

    const pendingRequest = (requestsResult.data ?? []).find(
      (request) => request.profile_id === row.profile_id && request.status === "pending" && request.start_date_local <= row.date_local && request.end_date_local >= row.date_local,
    );

    if (pendingRequest && !input.overridePendingRequests) {
      throw new MutationError("Pending voľno vyžaduje ručné prekonanie warningu.", 409);
    }

    const overlap = (shiftsResult.data ?? []).find(
      (shift) =>
        shift.profile_id === row.profile_id &&
        new Date(shift.planned_start_at).getTime() < new Date(row.planned_end_at).getTime() &&
        new Date(shift.planned_end_at).getTime() > new Date(row.planned_start_at).getTime(),
    );

    if (overlap) {
      throw new MutationError("Operátor už má v tomto čase smenu.", 409);
    }
  });

  const dateLocals = plannedRows.map((row) => row.date_local).sort();
  const batch = await insertSingle<AttendanceScheduleBatchRow>(
    supabase
      .from("motorist_attendance_schedule_batches")
      .insert({
        organization_id: organization.id,
        name: cleanString(input.name) ?? `Plán ${dateLocals[0]}-${dateLocals.at(-1)}`,
        status: input.publish ? "published" : "draft",
        shift_mode: input.shiftMode,
        date_from_local: dateLocals[0],
        date_to_local: dateLocals.at(-1) ?? dateLocals[0],
        notes: cleanString(input.notes),
        created_by: actorId,
        published_at: input.publish ? new Date().toISOString() : null,
      })
      .select("*")
      .single(),
  );
  const rowsWithBatch = plannedRows.map((row) => ({ ...row, schedule_batch_id: batch.id }));
  const insertResult = await supabase.from("motorist_attendance_shifts").insert(rowsWithBatch).select("*");
  await throwOnResult(insertResult);

  await audit(supabase, organization.id, actorId, "attendance.bulk_shifts.create", "motorist_attendance_schedule_batches", batch.id, {
    count: rowsWithBatch.length,
    status: batch.status,
    shift_mode: input.shiftMode,
  });

  return batch;
}

export async function publishAttendanceScheduleBatch(id: string) {
  if (!nonEmpty(id)) {
    throw new MutationError("Chýba plánovací batch.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const publishedAt = new Date().toISOString();
  const batch = await insertSingle<AttendanceScheduleBatchRow>(
    supabase
      .from("motorist_attendance_schedule_batches")
      .update({ status: "published", published_at: publishedAt })
      .eq("organization_id", organization.id)
      .eq("id", id)
      .select("*")
      .single(),
  );
  await throwOnResult(
    supabase
      .from("motorist_attendance_shifts")
      .update({ status: "published", published_at: publishedAt, updated_by: actorId })
      .eq("organization_id", organization.id)
      .eq("schedule_batch_id", id)
      .eq("status", "draft"),
  );

  await audit(supabase, organization.id, actorId, "attendance.schedule_batch.publish", "motorist_attendance_schedule_batches", batch.id, {
    published_at: publishedAt,
  });

  return batch;
}

export async function copyAttendance(input: CopyAttendanceInput) {
  if (!isIsoDate(input.sourceDateLocal) || !isIsoDate(input.targetDateLocal)) {
    throw new MutationError("Kopírovanie potrebuje zdrojový a cieľový dátum.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const sourceStart = new Date(`${input.sourceDateLocal}T00:00:00`);
  const targetStart = new Date(`${input.targetDateLocal}T00:00:00`);
  const dayOffset = Math.round((targetStart.getTime() - sourceStart.getTime()) / 86_400_000);
  const sourceEnd = addDays(input.sourceDateLocal, input.mode === "week" ? 6 : 0);
  const result = await supabase
    .from("motorist_attendance_shifts")
    .select("*")
    .eq("organization_id", organization.id)
    .gte("date_local", input.sourceDateLocal)
    .lte("date_local", sourceEnd)
    .order("planned_start_at");
  await throwOnResult(result);

  const rows = (result.data ?? []).map((shift) => ({
    organization_id: organization.id,
    profile_id: shift.profile_id,
    template_id: shift.template_id,
    status: "draft" as const,
    date_local: addDays(shift.date_local, dayOffset),
    timezone: shift.timezone,
    planned_start_at: shiftIsoPlusDays(shift.planned_start_at, dayOffset),
    planned_end_at: shiftIsoPlusDays(shift.planned_end_at, dayOffset),
    notes: shift.notes ? `Kópia: ${shift.notes}` : "Kópia služby",
    created_by: actorId,
    updated_by: actorId,
  }));

  if (rows.length === 0) {
    throw new MutationError("Na zvolený deň nie sú žiadne služby na kopírovanie.", 404);
  }

  const insertResult = await supabase.from("motorist_attendance_shifts").insert(rows).select("*");
  await throwOnResult(insertResult);

  await audit(supabase, organization.id, actorId, "attendance.shift.copy", "motorist_attendance_shifts", organization.id, {
    source_date: input.sourceDateLocal,
    target_date: input.targetDateLocal,
    mode: input.mode,
    count: rows.length,
  });
}

export async function startAttendanceForProfile(profileId: string, source: StartAttendanceSessionInput["source"] = "login", input: Partial<StartAttendanceSessionInput> = {}) {
  if (!nonEmpty(profileId)) {
    throw new MutationError("Chýba operátor.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  await getProfile(supabase, organization.id, profileId);

  const session = await insertSingle<AttendanceSessionRow>(
    supabase
      .from("motorist_attendance_sessions")
      .insert({
        organization_id: organization.id,
        profile_id: profileId,
        shift_id: cleanString(input.shiftId ?? undefined),
        status: "open",
        source,
        started_at: input.startedAt && isIsoDateTime(input.startedAt) ? input.startedAt : new Date().toISOString(),
        notes: cleanString(input.notes),
        created_by: actorId,
      })
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, actorId, "attendance.session.start", "motorist_attendance_sessions", session.id, {
    profile_id: profileId,
    shift_id: session.shift_id,
    source,
  });

  return session;
}

export async function startAttendanceSession(input: StartAttendanceSessionInput) {
  return startAttendanceForProfile(input.profileId, input.source ?? "manual", input);
}

export async function endAttendanceSession(id: string, input: EndAttendanceSessionInput = {}) {
  if (!nonEmpty(id)) {
    throw new MutationError("Chýba dochádzková session.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  const endedAt = input.endedAt && isIsoDateTime(input.endedAt) ? input.endedAt : new Date().toISOString();
  const session = await insertSingle<AttendanceSessionRow>(
    supabase
      .from("motorist_attendance_sessions")
      .update({
        status: "closed",
        ended_at: endedAt,
        notes: input.notes !== undefined ? cleanString(input.notes) : undefined,
      })
      .eq("organization_id", organization.id)
      .eq("id", id)
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, actorId, "attendance.session.end", "motorist_attendance_sessions", session.id, {
    profile_id: session.profile_id,
    shift_id: session.shift_id,
    ended_at: endedAt,
  });

  return session;
}


async function resolveOrganization(supabase: AdminClient): Promise<OrganizationRow> {
  const organizationId = process.env.MOTORIST_ORGANIZATION_ID?.trim();
  const query = organizationId
    ? supabase.from("motorist_organizations").select("*").eq("id", organizationId).maybeSingle()
    : supabase
        .from("motorist_organizations")
        .select("*")
        .eq("slug", process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || DEFAULT_ORGANIZATION_SLUG)
        .maybeSingle();
  const result = await query;
  await throwOnResult(result);

  if (!result.data?.active) {
    throw new MutationError("Aktívna organizácia sa nenašla.", 404);
  }

  return result.data;
}

async function resolveDefaultOwnerId(supabase: AdminClient, organizationId: string) {
  const result = await supabase
    .from("motorist_profiles")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("active", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  await throwOnResult(result);
  return result.data?.id ?? null;
}

async function resolveTaskAssignee(supabase: AdminClient, organizationId: string, assignedTo: string | undefined, fallback: string | null) {
  if (assignedTo === undefined) {
    return fallback;
  }

  const profileId = cleanString(assignedTo);
  if (!profileId || profileId === "unassigned") {
    return null;
  }

  const profile = await getProfile(supabase, organizationId, profileId);
  return profile.id;
}

async function resolveOrganizationProfile(supabase: AdminClient, organizationId: string): Promise<OrganizationProfileRow | null> {
  const result = await supabase.from("motorist_organization_profiles").select("*").eq("organization_id", organizationId).maybeSingle();
  await throwOnResult(result);
  return result.data ?? null;
}

async function getProfile(supabase: AdminClient, organizationId: string, id: string): Promise<ProfileRow> {
  const result = await supabase.from("motorist_profiles").select("*").eq("organization_id", organizationId).eq("id", id).maybeSingle();
  await throwOnResult(result);
  if (!result.data?.active) {
    throw new MutationError("Operátor sa nenašiel.", 404);
  }
  return result.data;
}

async function getAttendanceShift(supabase: AdminClient, organizationId: string, id: string): Promise<AttendanceShiftRow> {
  const result = await supabase.from("motorist_attendance_shifts").select("*").eq("organization_id", organizationId).eq("id", id).maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Služba sa nenašla.", 404);
  }
  return result.data;
}

async function getAttendanceRequest(supabase: AdminClient, organizationId: string, id: string): Promise<AttendanceRequestRow> {
  const result = await supabase.from("motorist_attendance_unavailability_requests").select("*").eq("organization_id", organizationId).eq("id", id).maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Žiadosť sa nenašla.", 404);
  }
  return result.data;
}

async function setAttendanceShiftStatus(
  id: string,
  status: AttendanceShiftRow["status"],
  extra: Partial<Pick<AttendanceShiftRow, "published_at" | "confirmed_at" | "declined_at" | "confirmation_note">>,
) {
  if (!nonEmpty(id)) {
    throw new MutationError("Chýba služba.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  await getAttendanceShift(supabase, organization.id, id);

  const shift = await insertSingle<AttendanceShiftRow>(
    supabase
      .from("motorist_attendance_shifts")
      .update({
        status,
        ...extra,
        updated_by: actorId,
      })
      .eq("organization_id", organization.id)
      .eq("id", id)
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, actorId, `attendance.shift.${status}`, "motorist_attendance_shifts", shift.id, {
    profile_id: shift.profile_id,
    status,
  });

  return shift;
}

async function setAttendanceRequestStatus(id: string, status: AttendanceRequestRow["status"], note?: string) {
  if (!nonEmpty(id)) {
    throw new MutationError("Chýba žiadosť.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const actorId = await resolveDefaultOwnerId(supabase, organization.id);
  await getAttendanceRequest(supabase, organization.id, id);
  const request = await insertSingle<AttendanceRequestRow>(
    supabase
      .from("motorist_attendance_unavailability_requests")
      .update({
        status,
        decision_note: cleanString(note),
        decided_at: ["approved", "declined", "cancelled"].includes(status) ? new Date().toISOString() : null,
        decided_by: ["approved", "declined"].includes(status) ? actorId : null,
      })
      .eq("organization_id", organization.id)
      .eq("id", id)
      .select("*")
      .single(),
  );

  await audit(supabase, organization.id, actorId, `attendance.request.${status}`, "motorist_attendance_unavailability_requests", request.id, {
    profile_id: request.profile_id,
    type: request.type,
    status,
  });

  return request;
}

function bulkAssignmentToShiftRow({
  actorId,
  assignment,
  index,
  organizationId,
  publish,
  templatesById,
  timezone,
}: {
  actorId: string | null;
  assignment: CreateBulkAttendanceShiftsInput["assignments"][number];
  index: number;
  organizationId: string;
  publish: boolean;
  templatesById: Map<string, AttendanceShiftTemplateRow>;
  timezone: string;
}) {
  const template = templatesById.get(assignment.templateId);

  if (!template) {
    throw new MutationError("Šablóna smeny sa nenašla.", 404);
  }

  const startTime = template.kind === "custom" ? assignment.startTimeLocal : template.starts_at_local?.slice(0, 5);
  const endTime = template.kind === "custom" ? assignment.endTimeLocal : template.ends_at_local?.slice(0, 5);

  if (!isTimeLocal(startTime) || !isTimeLocal(endTime)) {
    throw new MutationError("Custom smena potrebuje platný čas od-do.", 400);
  }

  const plannedStartAt = localDateTimeToIso(assignment.dateLocal, startTime);
  const endDateLocal = endTime <= startTime ? addDays(assignment.dateLocal, 1) : assignment.dateLocal;
  const plannedEndAt = localDateTimeToIso(endDateLocal, endTime);

  if (!plannedStartAt || !plannedEndAt) {
    throw new MutationError("Smena potrebuje platný dátum a čas.", 400);
  }

  return {
    organization_id: organizationId,
    profile_id: assignment.profileId,
    template_id: template.kind === "custom" ? null : template.id,
    status: publish ? ("published" as const) : ("draft" as const),
    date_local: assignment.dateLocal,
    timezone,
    planned_start_at: plannedStartAt,
    planned_end_at: plannedEndAt,
    published_at: publish ? new Date().toISOString() : null,
    notes: cleanString(assignment.notes),
    created_by: actorId,
    updated_by: actorId,
    batch_created_order: index + 1,
  };
}

async function nextCaseNumber(supabase: AdminClient, organizationId: string) {
  const year = new Date().getFullYear();
  const prefix = `PM-${year}-`;
  const result = await supabase
    .from("motorist_cases")
    .select("case_number")
    .eq("organization_id", organizationId)
    .like("case_number", `${prefix}%`)
    .order("case_number", { ascending: false })
    .limit(1);
  await throwOnResult(result);
  const lastSequence = Number(result.data?.[0]?.case_number.split("-").at(-1) ?? "0");
  return `${prefix}${String((Number.isFinite(lastSequence) ? lastSequence : 0) + 1).padStart(4, "0")}`;
}

async function createLocation(
  supabase: AdminClient,
  organizationId: string,
  input: PlaceSelectionInput,
  fallbackLabel: string,
): Promise<LocationRow> {
  return insertSingle<LocationRow>(
    supabase
      .from("motorist_locations")
      .insert({
        organization_id: organizationId,
        label: input.label.trim() || fallbackLabel,
        address: input.address.trim(),
        lat: input.lat,
        lng: input.lng,
        place_id: input.placeId ?? null,
        provider: input.provider ?? "google_places",
        confidence: input.provider === "approximate" ? 0.4 : input.provider === "manual" ? 0.7 : 0.98,
        metadata: { source: "operator_form" },
      })
      .select("*")
      .single(),
  );
}

async function updateLocation(
  supabase: AdminClient,
  organizationId: string,
  id: string,
  input: PlaceSelectionInput,
  fallbackLabel: string,
) {
  await throwOnResult(
    supabase
      .from("motorist_locations")
      .update({
        label: input.label.trim() || fallbackLabel,
        address: input.address.trim(),
        lat: input.lat,
        lng: input.lng,
        place_id: input.placeId ?? null,
        provider: input.provider ?? "google_places",
        confidence: input.provider === "approximate" ? 0.4 : input.provider === "manual" ? 0.7 : 0.98,
        metadata: { source: "operator_form" },
      })
      .eq("organization_id", organizationId)
      .eq("id", id),
  );
}

async function upsertCaseLocation(
  supabase: AdminClient,
  organizationId: string,
  existingId: string | null,
  input: UpdateCaseInput,
  field: "pickup" | "destination",
  fallbackLabel: string,
) {
  if (!(field in input)) {
    return existingId;
  }

  const location = input[field];
  if (location === null) {
    return null;
  }

  // An incomplete draft selection produces a warning and leaves an already
  // valid stored location untouched. Explicit null is the unlink operation.
  if (!isValidPlaceSelection(location)) {
    return existingId;
  }

  if (existingId) {
    await updateLocation(supabase, organizationId, existingId, location, fallbackLabel);
    return existingId;
  }

  return (await createLocation(supabase, organizationId, location, fallbackLabel)).id;
}

function includesAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

function isJobType(value: string): value is JobType {
  return value === "tow" || value === "replacement_vehicle" || value === "onsite_assistance" || value === "vehicle_recovery";
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

async function getCase(supabase: AdminClient, organizationId: string, id: string): Promise<CaseRow> {
  const result = await supabase.from("motorist_cases").select("*").eq("organization_id", organizationId).eq("id", id).maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Prípad sa nenašiel.", 404);
  }
  return result.data;
}

async function getCaseTask(supabase: AdminClient, organizationId: string, caseId: string, taskId: string): Promise<CaseTaskRow> {
  const result = await supabase
    .from("motorist_case_tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("case_id", caseId)
    .eq("id", taskId)
    .maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Úloha sa nenašla.", 404);
  }
  return caseTaskWithDefaults(result.data as Partial<CaseTaskRow>, {
    organization_id: organizationId,
    case_id: caseId,
    title: result.data.title,
    assigned_to: result.data.assigned_to,
    due_at: result.data.due_at,
    status: result.data.status,
    priority: "normal",
    kind: "other",
    created_by: null,
  });
}

async function getBranch(supabase: AdminClient, organizationId: string, id: string): Promise<BranchRow> {
  const result = await supabase.from("motorist_branches").select("*").eq("organization_id", organizationId).eq("id", id).maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Pobočka sa nenašla.", 404);
  }
  return result.data;
}

async function getPartnerDirectoryEntry(supabase: AdminClient, organizationId: string, id: string): Promise<PartnerDirectoryRow> {
  const result = await supabase.from("motorist_partner_directory").select("*").eq("organization_id", organizationId).eq("id", id).maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Položka adresára sa nenašla.", 404);
  }
  return result.data;
}

async function getFleetAsset(supabase: AdminClient, organizationId: string, id: string): Promise<FleetAssetRow> {
  const result = await supabase.from("motorist_fleet_assets").select("*").eq("organization_id", organizationId).eq("id", id).maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Technika sa nenašla.", 404);
  }
  return result.data;
}

async function getCommanderExternalVehicle(supabase: AdminClient, organizationId: string, id: string): Promise<ExternalVehicleRecordRow> {
  const result = await supabase
    .from("motorist_external_vehicle_records")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("source_provider", "commander")
    .eq("id", id)
    .maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Commander vozidlo sa nenašlo.", 404);
  }
  return result.data;
}

async function getCommanderLink(supabase: AdminClient, organizationId: string, id: string): Promise<FleetAssetLinkRow> {
  const result = await supabase
    .from("motorist_fleet_asset_links")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("source_provider", "commander")
    .eq("id", id)
    .maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Commander link sa nenašiel.", 404);
  }
  return result.data;
}

async function getLatestCommanderLink(supabase: AdminClient, organizationId: string, externalVehicleRecordId: string): Promise<FleetAssetLinkRow | null> {
  const result = await supabase
    .from("motorist_fleet_asset_links")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("source_provider", "commander")
    .eq("external_vehicle_record_id", externalVehicleRecordId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  await throwOnResult(result);
  return result.data ?? null;
}

async function getConfirmedCommanderLink(supabase: AdminClient, organizationId: string, externalVehicleRecordId: string): Promise<FleetAssetLinkRow | null> {
  const result = await supabase
    .from("motorist_fleet_asset_links")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("source_provider", "commander")
    .eq("external_vehicle_record_id", externalVehicleRecordId)
    .eq("link_status", "confirmed")
    .maybeSingle();
  await throwOnResult(result);
  return result.data ?? null;
}

async function getCommanderCurrentPosition(
  supabase: AdminClient,
  organizationId: string,
  externalVehicleRecordId: string,
): Promise<FleetCurrentPositionRow | null> {
  const result = await supabase
    .from("motorist_fleet_current_positions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("source_provider", "commander")
    .eq("external_vehicle_record_id", externalVehicleRecordId)
    .maybeSingle();
  await throwOnResult(result);
  return result.data ?? null;
}

async function upsertCommanderLink(
  supabase: AdminClient,
  organizationId: string,
  actorId: string | null,
  externalRecord: ExternalVehicleRecordRow,
  asset: FleetAssetRow,
  matchMethod: FleetAssetLinkRow["match_method"] = "manual",
): Promise<FleetAssetLinkRow> {
  const now = new Date().toISOString();
  const linksResult = await supabase
    .from("motorist_fleet_asset_links")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("source_provider", "commander");
  await throwOnResult(linksResult);

  const links = linksResult.data ?? [];
  if (matchMethod !== "manual" && links.some((link) =>
    (link.link_status === "confirmed" && (link.external_vehicle_record_id === externalRecord.id || link.fleet_asset_id === asset.id)) ||
    (link.link_status === "rejected" && link.match_method === "manual" && link.external_vehicle_record_id === externalRecord.id))) {
    throw new MutationError("Vozidlo bolo medzičasom ručne spárované alebo odmietnuté; automatika ho nemení.", 409);
  }
  const staleLinks = links.filter(
    (link) =>
      link.link_status !== "rejected" &&
      ((link.external_vehicle_record_id === externalRecord.id && link.fleet_asset_id !== asset.id) ||
        (link.fleet_asset_id === asset.id && link.external_vehicle_record_id !== externalRecord.id)),
  );

  await Promise.all(
    staleLinks.map((link) =>
      throwOnResult(
        supabase
          .from("motorist_fleet_asset_links")
          .update({
            link_status: "rejected",
            confirmed_at: null,
            confirmed_by: null,
            rejected_at: now,
            rejected_by: actorId,
            metadata: { ...objectJson(link.metadata), reason: "superseded_by_manual_link", replacement_fleet_asset_id: asset.id },
          })
          .eq("organization_id", organizationId)
          .eq("id", link.id),
      ),
    ),
  );

  const existing = links.find((link) => link.external_vehicle_record_id === externalRecord.id && link.fleet_asset_id === asset.id);
  const payload = {
    organization_id: organizationId,
    fleet_asset_id: asset.id,
    external_vehicle_record_id: externalRecord.id,
    source_provider: "commander" as const,
    link_status: "confirmed" as const,
    match_method: matchMethod,
    match_confidence: matchMethod === "license_plate" ? 0.95 : 1,
    confirmed_at: now,
    confirmed_by: actorId,
    rejected_at: null,
    rejected_by: null,
    metadata: {
      source: matchMethod === "manual" ? "fleet_gps_connections" : "fleet_auto_pairing",
      source_vehicle_id: externalRecord.source_vehicle_id,
      fleet_asset_label: asset.label,
    },
  };
  const link = existing
    ? await insertSingle<FleetAssetLinkRow>(
        supabase
          .from("motorist_fleet_asset_links")
          .update({ ...payload, metadata: { ...objectJson(existing.metadata), ...payload.metadata } })
          .eq("organization_id", organizationId)
          .eq("id", existing.id)
          .select("*")
          .single(),
      )
    : await insertSingle<FleetAssetLinkRow>(supabase.from("motorist_fleet_asset_links").insert(payload).select("*").single());

  await throwOnResult(
    supabase
      .from("motorist_fleet_current_positions")
      .update({ fleet_asset_id: asset.id })
      .eq("organization_id", organizationId)
      .eq("source_provider", "commander")
      .eq("external_vehicle_record_id", externalRecord.id),
  );

  return link;
}

async function clearCommanderCurrentPositionLink(supabase: AdminClient, organizationId: string, externalVehicleRecordId: string) {
  await throwOnResult(
    supabase
      .from("motorist_fleet_current_positions")
      .update({ fleet_asset_id: null })
      .eq("organization_id", organizationId)
      .eq("source_provider", "commander")
      .eq("external_vehicle_record_id", externalVehicleRecordId),
  );
}

async function createCommanderLocation(
  supabase: AdminClient,
  organizationId: string,
  externalRecord: ExternalVehicleRecordRow,
  position: FleetCurrentPositionRow,
) {
  return insertSingle<LocationRow>(
    supabase
      .from("motorist_locations")
      .insert({
        organization_id: organizationId,
        label: commanderAssetLabel(externalRecord),
        address: `Commander GPS ${Number(position.lat).toFixed(5)}, ${Number(position.lng).toFixed(5)}`,
        lat: Number(position.lat),
        lng: Number(position.lng),
        provider: "manual",
        confidence: 0.9,
        metadata: {
          source: "commander",
          external_vehicle_record_id: externalRecord.id,
          source_vehicle_id: externalRecord.source_vehicle_id,
          gps_time: position.gps_time,
        },
      })
      .select("*")
      .single(),
  );
}

function assertReplacementAsset(asset: FleetAssetRow) {
  if (asset.kind !== "replacement_car") {
    throw new MutationError("Commander GPS sa páruje iba na náhradné vozidlá.", 400);
  }
}

function commanderAssetLabel(record: ExternalVehicleRecordRow) {
  return cleanString(record.label ?? undefined) ?? cleanString(record.normalized_license_plate ?? undefined) ?? `Commander ${record.source_vehicle_id}`;
}

async function getContact(supabase: AdminClient, organizationId: string, id: string): Promise<ContactRow> {
  const result = await supabase.from("motorist_contacts").select("*").eq("organization_id", organizationId).eq("id", id).maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Kontakt sa nenašiel.", 404);
  }
  return result.data;
}

async function getVehicle(supabase: AdminClient, organizationId: string, id: string): Promise<VehicleRow> {
  const result = await supabase.from("motorist_vehicles").select("*").eq("organization_id", organizationId).eq("id", id).maybeSingle();
  await throwOnResult(result);
  if (!result.data) {
    throw new MutationError("Vozidlo sa nenašlo.", 404);
  }
  return result.data;
}

async function insertSingle<Row>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row> {
  const result = await query;
  if (result.error) {
    throw new MutationError(result.error.message);
  }
  if (!result.data) {
    throw new MutationError("Supabase nevrátil vytvorený záznam.");
  }
  return result.data as Row;
}

async function insertCaseTask(supabase: AdminClient, payload: CaseTaskInsertPayload): Promise<CaseTaskRow> {
  const result = await supabase.from("motorist_case_tasks").insert(payload).select("*").single();

  if (isCaseTaskPhase0SchemaDrift(result.error)) {
    const legacyResult = await supabase.from("motorist_case_tasks").insert(legacyCaseTaskPayload(payload)).select("*").single();

    if (legacyResult.error) {
      throw new MutationError(legacyResult.error.message);
    }

    if (!legacyResult.data) {
      throw new MutationError("Supabase nevrátil vytvorenú úlohu.");
    }

    return caseTaskWithDefaults(legacyResult.data as Partial<CaseTaskRow>, payload);
  }

  if (result.error) {
    throw new MutationError(result.error.message);
  }

  if (!result.data) {
    throw new MutationError("Supabase nevrátil vytvorenú úlohu.");
  }

  return caseTaskWithDefaults(result.data as Partial<CaseTaskRow>, payload);
}

async function updateCaseTask(
  supabase: AdminClient,
  organizationId: string,
  caseId: string,
  taskId: string,
  updates: Tables["motorist_case_tasks"]["Update"],
  fallback: CaseTaskRow,
): Promise<CaseTaskRow> {
  const result = await supabase
    .from("motorist_case_tasks")
    .update(updates)
    .eq("organization_id", organizationId)
    .eq("case_id", caseId)
    .eq("id", taskId)
    .select("*")
    .maybeSingle();

  if (isCaseTaskPhase0SchemaDrift(result.error)) {
    const legacyResult = await supabase
      .from("motorist_case_tasks")
      .update(legacyCaseTaskUpdatePayload(updates))
      .eq("organization_id", organizationId)
      .eq("case_id", caseId)
      .eq("id", taskId)
      .select("*")
      .maybeSingle();
    await throwOnResult(legacyResult);

    if (!legacyResult.data) {
      throw new MutationError("Úloha sa nenašla.", 404);
    }

    return caseTaskWithDefaults(legacyResult.data as Partial<CaseTaskRow>, {
      organization_id: organizationId,
      case_id: caseId,
      title: legacyResult.data.title === undefined ? fallback.title : legacyResult.data.title,
      assigned_to: legacyResult.data.assigned_to === undefined ? fallback.assigned_to : legacyResult.data.assigned_to,
      due_at: legacyResult.data.due_at === undefined ? fallback.due_at : legacyResult.data.due_at,
      status: legacyResult.data.status === undefined ? fallback.status : legacyResult.data.status,
      priority: legacyResult.data.priority === undefined ? fallback.priority : legacyResult.data.priority,
      kind: legacyResult.data.kind === undefined ? fallback.kind : legacyResult.data.kind,
      created_by: legacyResult.data.created_by === undefined ? fallback.created_by : legacyResult.data.created_by,
    });
  }

  await throwOnResult(result);

  if (!result.data) {
    throw new MutationError("Úloha sa nenašla.", 404);
  }

  return caseTaskWithDefaults(result.data as Partial<CaseTaskRow>, {
    organization_id: organizationId,
    case_id: caseId,
    title: result.data.title === undefined ? fallback.title : result.data.title,
    assigned_to: result.data.assigned_to === undefined ? fallback.assigned_to : result.data.assigned_to,
    due_at: result.data.due_at === undefined ? fallback.due_at : result.data.due_at,
    status: result.data.status === undefined ? fallback.status : result.data.status,
    priority: result.data.priority === undefined ? fallback.priority : result.data.priority,
    kind: result.data.kind === undefined ? fallback.kind : result.data.kind,
    created_by: result.data.created_by === undefined ? fallback.created_by : result.data.created_by,
  });
}

async function deleteCaseTask(supabase: AdminClient, organizationId: string, caseId: string, taskId: string) {
  await throwOnResult(
    supabase
      .from("motorist_case_tasks")
      .delete()
      .eq("organization_id", organizationId)
      .eq("case_id", caseId)
      .eq("id", taskId),
  );
}

async function completeCaseTask(supabase: AdminClient, organizationId: string, caseId: string, taskId: string, ownerId: string | null) {
  const result = await supabase
    .from("motorist_case_tasks")
    .update({ status: "done", completed_at: new Date().toISOString(), completed_by: ownerId })
    .eq("organization_id", organizationId)
    .eq("case_id", caseId)
    .eq("id", taskId);

  if (isCaseTaskPhase0SchemaDrift(result.error)) {
    await throwOnResult(
      supabase
        .from("motorist_case_tasks")
        .update({ status: "done" })
        .eq("organization_id", organizationId)
        .eq("case_id", caseId)
        .eq("id", taskId),
    );
    return;
  }

  await throwOnResult(result);
}

async function markTaskNotificationsRead(supabase: AdminClient, organizationId: string, taskId: string) {
  const result = await supabase
    .from("motorist_notifications")
    .update({ status: "read", read_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("task_id", taskId)
    .eq("status", "unread");

  if (isNotificationSchemaMiss(result.error)) {
    return;
  }

  await throwOnResult(result);
}

async function archiveTaskNotifications(supabase: AdminClient, organizationId: string, taskId: string) {
  const result = await supabase
    .from("motorist_notifications")
    .update({ status: "archived", archived_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("task_id", taskId)
    .neq("status", "archived");

  if (isNotificationSchemaMiss(result.error)) {
    return;
  }

  await throwOnResult(result);
}

function legacyCaseTaskPayload(payload: CaseTaskInsertPayload) {
  return {
    organization_id: payload.organization_id,
    case_id: payload.case_id,
    title: payload.title,
    assigned_to: payload.assigned_to ?? null,
    due_at: payload.due_at ?? null,
    status: payload.status,
  };
}

function legacyCaseTaskUpdatePayload(updates: Tables["motorist_case_tasks"]["Update"]) {
  return {
    ...(updates.title !== undefined ? { title: updates.title } : {}),
    ...(updates.assigned_to !== undefined ? { assigned_to: updates.assigned_to } : {}),
    ...(updates.due_at !== undefined ? { due_at: updates.due_at } : {}),
    ...(updates.status !== undefined ? { status: updates.status } : {}),
  };
}

function caseTaskWithDefaults(row: Partial<CaseTaskRow>, fallback: CaseTaskInsertPayload): CaseTaskRow {
  return {
    ...row,
    priority: row.priority ?? fallback.priority ?? "normal",
    kind: row.kind ?? fallback.kind ?? "other",
    created_by: row.created_by ?? fallback.created_by ?? null,
    completed_by: row.completed_by ?? null,
    completed_at: row.completed_at ?? null,
  } as CaseTaskRow;
}

function isCaseTaskPhase0SchemaDrift(error: { message?: string; code?: string } | null) {
  if (!error) {
    return false;
  }

  const message = String(error.message ?? "").toLowerCase();
  return (
    (error.code === "PGRST204" || message.includes("schema cache")) &&
    CASE_TASK_PHASE0_COLUMNS.some((column) => message.includes(column))
  );
}

function isNotificationSchemaMiss(error: { message?: string; code?: string } | null | undefined) {
  if (!error) {
    return false;
  }

  const message = String(error.message ?? "").toLowerCase();
  return (
    (error.code === "PGRST204" || error.code === "PGRST205" || message.includes("schema cache") || message.includes("does not exist")) &&
    message.includes("motorist_notifications")
  );
}

async function throwOnResult(result: PromiseLike<{ error: { message: string } | null }> | { error: { message: string } | null }) {
  const resolved = await result;
  if (resolved.error) {
    throw new MutationError(resolved.error.message);
  }
}

async function authorizeOrganizationAccess(authorize: OrganizationAuthorizer | undefined, organizationId: string) {
  if (authorize) {
    await authorize(organizationId);
  }
}

async function audit(
  supabase: AdminClient,
  organizationId: string,
  actorProfileId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  payload: Json,
) {
  await insertSingle<AuditLogRow>(
    supabase
      .from("motorist_audit_log")
      .insert({
        organization_id: organizationId,
        actor_profile_id: actorProfileId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        source: "dispatch_console",
        after_payload: payload,
      })
      .select("*")
      .single(),
  );
}

function validatePartnerDirectoryInput(input: Partial<PartnerDirectoryInput>, requireName = true) {
  if (requireName && (!input.name || !nonEmpty(input.name))) {
    throw new MutationError("Adresár potrebuje názov.", 400);
  }

  if (input.kind !== undefined && input.kind !== "assistance" && input.kind !== "company") {
    throw new MutationError("Neplatný typ položky adresára.", 400);
  }

  if (input.email !== undefined && nonEmpty(input.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    throw new MutationError("Email adresára nemá správny formát.", 400);
  }
}

function primaryContactInput(input: CreateCaseInput | UpdateCaseInput) {
  const normalizedContacts = normalizeCaseContacts(input);
  const primary = normalizedContacts.find((contact) => contact.isPrimary) ?? normalizedContacts[0];

  return {
    name: primary?.name ?? input.contactName?.trim() ?? "",
    phone: primary?.phone ?? input.contactPhone?.trim() ?? "",
    email: primary?.email ?? input.contactEmail,
  };
}

function hasMeaningfulContact(contact: { name?: string; phone?: string; email?: string }) {
  return Boolean(cleanString(contact.name) || cleanString(contact.phone) || cleanString(contact.email));
}

async function createCaseContact(
  supabase: AdminClient,
  organizationId: string,
  contact: { name?: string; phone?: string; email?: string },
  note?: string,
) {
  const name = cleanString(contact.name) ?? cleanString(contact.phone) ?? cleanString(contact.email);
  if (!name) {
    return null;
  }

  return insertSingle<ContactRow>(
    supabase
      .from("motorist_contacts")
      .insert({
        organization_id: organizationId,
        name,
        phone: cleanString(contact.phone),
        email: cleanString(contact.email),
        role: "client",
        notes: cleanString(note),
      })
      .select("*")
      .single(),
  );
}

function contactForUpdate(contact: ContactRow | null, input: UpdateCaseInput) {
  const normalizedContacts = input.contacts === undefined ? [] : normalizeCaseContacts({ contacts: input.contacts });
  const selected = normalizedContacts.find((candidate) => candidate.isPrimary) ?? normalizedContacts[0];

  if (selected) {
    return selected;
  }

  if (input.contacts !== undefined && !hasAny(input, ["contactName", "contactPhone", "contactEmail"])) {
    return { name: "", phone: "", email: undefined };
  }

  return {
    name: input.contactName !== undefined ? input.contactName : contact?.name ?? "",
    phone: input.contactPhone !== undefined ? input.contactPhone : contact?.phone ?? "",
    email: input.contactEmail !== undefined ? input.contactEmail : contact?.email ?? undefined,
  };
}

async function upsertCaseContact(supabase: AdminClient, organizationId: string, contact: ContactRow | null, input: UpdateCaseInput) {
  if (!hasContactUpdate(input)) {
    return contact?.id ?? null;
  }

  const next = contactForUpdate(contact, input);
  if (!hasMeaningfulContact(next)) {
    return null;
  }

  if (!contact) {
    return (await createCaseContact(supabase, organizationId, next, input.customerNote))?.id ?? null;
  }

  await throwOnResult(
    supabase
      .from("motorist_contacts")
      .update({
        name: cleanString(next.name) ?? cleanString(next.phone) ?? cleanString(next.email) ?? contact.name,
        phone: cleanString(next.phone),
        email: cleanString(next.email),
        ...(input.customerNote !== undefined ? { notes: cleanString(input.customerNote) } : {}),
      })
      .eq("organization_id", organizationId)
      .eq("id", contact.id),
  );
  return contact.id;
}

function vehicleWritePayload(input: CreateCaseInput | UpdateCaseInput) {
  return {
    license_plate: cleanString(input.licensePlate)?.toUpperCase() ?? null,
    vin: cleanString(input.vin)?.toUpperCase() ?? null,
    make: cleanString(input.vehicleMake),
    model: cleanString(input.vehicleModel),
    category: cleanString(input.vehicleCategory),
    transmission: cleanString(input.transmission),
    production_year: cleanNumber(input.productionYear),
    color: cleanString(input.vehicleColor),
    drive_type: cleanString(input.driveType),
    weight_kg: cleanNumber(input.weightKg),
    is_driveable: input.vehicleDriveable ?? null,
    notes: canonicalCaseProblemDescription(input.vehicleIssue, input.incidentDescription) ?? null,
  };
}

function hasMeaningfulVehicleInput(input: CreateCaseInput | UpdateCaseInput) {
  return Boolean(
    cleanString(input.licensePlate) ||
      cleanString(input.vin) ||
      cleanString(input.vehicleMake) ||
      cleanString(input.vehicleModel) ||
      cleanString(input.vehicleCategory) ||
      cleanString(input.vehicleType) ||
      canonicalCaseProblemDescription(input.vehicleIssue, input.incidentDescription) ||
      cleanString(input.vehicleNote) ||
      cleanString(input.vehicleColor) ||
      cleanString(input.transmission) ||
      cleanString(input.driveType) ||
      cleanNumber(input.productionYear) !== null ||
      cleanNumber(input.weightKg) !== null ||
      input.vehicleDriveable !== undefined && input.vehicleDriveable !== null ||
      Boolean(input.vehicleConditionFlags?.length),
  );
}

async function createCaseVehicle(supabase: AdminClient, organizationId: string, input: CreateCaseInput | UpdateCaseInput) {
  return insertSingle<VehicleRow>(
    supabase
      .from("motorist_vehicles")
      .insert({ organization_id: organizationId, ...vehicleWritePayload(input) })
      .select("*")
      .single(),
  );
}

async function upsertCaseVehicle(supabase: AdminClient, organizationId: string, vehicle: VehicleRow | null, input: UpdateCaseInput) {
  if (!hasVehicleUpdate(input)) {
    return vehicle?.id ?? null;
  }

  const effective = {
    licensePlate: input.licensePlate !== undefined ? input.licensePlate : vehicle?.license_plate ?? undefined,
    vin: input.vin !== undefined ? input.vin : vehicle?.vin ?? undefined,
    vehicleMake: input.vehicleMake !== undefined ? input.vehicleMake : vehicle?.make ?? undefined,
    vehicleModel: input.vehicleModel !== undefined ? input.vehicleModel : vehicle?.model ?? undefined,
    vehicleCategory: input.vehicleCategory !== undefined ? input.vehicleCategory : vehicle?.category ?? undefined,
    vehicleType: input.vehicleType,
    vehicleIssue: input.vehicleIssue !== undefined ? input.vehicleIssue : vehicle?.notes ?? undefined,
    incidentDescription: input.incidentDescription,
    vehicleNote: input.vehicleNote,
    vehicleColor: input.vehicleColor !== undefined ? input.vehicleColor : vehicle?.color ?? undefined,
    transmission: input.transmission !== undefined ? input.transmission : (vehicle?.transmission as CreateCaseInput["transmission"] | null) ?? undefined,
    driveType: input.driveType !== undefined ? input.driveType : vehicle?.drive_type ?? undefined,
    productionYear: input.productionYear !== undefined ? input.productionYear : vehicle?.production_year ?? undefined,
    weightKg: input.weightKg !== undefined ? input.weightKg : vehicle?.weight_kg ?? undefined,
    vehicleDriveable: input.vehicleDriveable !== undefined ? input.vehicleDriveable : vehicle?.is_driveable ?? undefined,
    vehicleConditionFlags: input.vehicleConditionFlags,
  } satisfies CreateCaseInput;

  if (!hasMeaningfulVehicleInput(effective)) {
    return null;
  }

  if (!vehicle) {
    return (await createCaseVehicle(supabase, organizationId, input)).id;
  }

  const payload = vehicleWritePayload(input);
  await throwOnResult(
    supabase
      .from("motorist_vehicles")
      .update({
        ...(input.licensePlate !== undefined ? { license_plate: payload.license_plate } : {}),
        ...(input.vin !== undefined ? { vin: payload.vin } : {}),
        ...(input.vehicleMake !== undefined ? { make: payload.make } : {}),
        ...(input.vehicleModel !== undefined ? { model: payload.model } : {}),
        ...(input.vehicleCategory !== undefined ? { category: payload.category } : {}),
        ...(input.transmission !== undefined ? { transmission: payload.transmission } : {}),
        ...(input.productionYear !== undefined ? { production_year: payload.production_year } : {}),
        ...(input.vehicleColor !== undefined ? { color: payload.color } : {}),
        ...(input.driveType !== undefined ? { drive_type: payload.drive_type } : {}),
        ...(input.weightKg !== undefined ? { weight_kg: payload.weight_kg } : {}),
        ...(input.vehicleDriveable !== undefined ? { is_driveable: payload.is_driveable } : {}),
        ...(input.vehicleIssue !== undefined || input.incidentDescription !== undefined ? { notes: payload.notes } : {}),
      })
      .eq("organization_id", organizationId)
      .eq("id", vehicle.id),
  );
  return vehicle.id;
}

function caseSummary(input: CreateCaseInput | UpdateCaseInput) {
  const parts = [cleanString(input.caseType), cleanString(input.licensePlate)?.toUpperCase()].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function caseCreatedEventBody(pickup: LocationRow | null, destination: LocationRow | null) {
  if (pickup && destination) {
    return `Pickup: ${pickup.address}. Cieľ: ${destination.address}.`;
  }
  if (pickup) {
    return `Pickup: ${pickup.address}.`;
  }
  return "Prázdna karta bola založená na neskoršie doplnenie.";
}

function effectiveJobTypesForUpdate(existing: CaseRow, input: UpdateCaseInput): JobType[] {
  if (input.jobTypes !== undefined) {
    return jobTypesForInput(input);
  }

  const vehicleDetails = objectJson(existing.vehicle_details);
  if (Array.isArray(vehicleDetails.jobTypes)) {
    return vehicleDetails.jobTypes.filter((value): value is JobType => typeof value === "string" && isJobType(value));
  }

  const text = normalizeText([existing.case_type, cleanString(typeof vehicleDetails.note === "string" ? vehicleDetails.note : undefined)].filter(Boolean).join(" "));
  const inferred: JobType[] = [];

  if (includesAny(text, ["vyslobod", "priekop", "prevrat"])) inferred.push("vehicle_recovery");
  if (existing.destination_location_id || includesAny(text, ["odtah"])) inferred.push("tow");
  if (includesAny(text, ["nahrad"])) inferred.push("replacement_vehicle");
  if (!existing.destination_location_id && includesAny(text, ["asistenc", "defekt", "bateria"])) inferred.push("onsite_assistance");

  return inferred;
}

function normalizeCaseContacts(input: CreateCaseInput | UpdateCaseInput) {
  const contacts = (input.contacts ?? []).map(normalizeCaseContact).filter((contact): contact is NormalizedCaseContact => Boolean(contact));
  const fallbackName = cleanString(input.contactName);
  const fallbackPhone = cleanString(input.contactPhone);

  if (fallbackName && fallbackPhone && !contacts.some((contact) => samePhone(contact.phone, fallbackPhone))) {
    contacts.unshift({
      id: crypto.randomUUID(),
      name: fallbackName,
      phone: fallbackPhone,
      email: cleanString(input.contactEmail) ?? undefined,
      role: "primary_customer",
      isPrimary: true,
    });
  }

  if (contacts.length === 0) {
    return [];
  }

  const primaryIndex = contacts.findIndex((contact) => contact.isPrimary);
  const effectivePrimaryIndex = primaryIndex >= 0 ? primaryIndex : 0;

  return contacts.map((contact, index) => ({
    ...contact,
    isPrimary: index === effectivePrimaryIndex,
  }));
}

type NormalizedCaseContact = {
  id: string;
  firstName?: string;
  lastName?: string;
  name: string;
  phone: string;
  phonePrefix?: string;
  phoneNational?: string;
  email?: string;
  role: CustomerContactRole;
  note?: string;
  isPrimary: boolean;
};

function normalizeCaseContact(contact: CaseContactInput): NormalizedCaseContact | null {
  const phone = cleanString(contact.phone);
  const firstName = cleanString(contact.firstName);
  const lastName = cleanString(contact.lastName);
  const name = cleanString(contact.name) ?? cleanString([firstName, lastName].filter(Boolean).join(" "));
  const email = cleanString(contact.email);
  const note = cleanString(contact.note);

  if (!phone && !name && !email && !note) {
    return null;
  }

  return {
    id: cleanString(contact.id) ?? crypto.randomUUID(),
    firstName: firstName ?? undefined,
    lastName: lastName ?? undefined,
    name: name ?? "",
    phone: phone ?? "",
    phonePrefix: cleanString(contact.phonePrefix) ?? undefined,
    phoneNational: cleanString(contact.phoneNational) ?? undefined,
    email: email ?? undefined,
    role: isCustomerContactRole(contact.role) ? contact.role : "other",
    note: note ?? undefined,
    isPrimary: Boolean(contact.isPrimary),
  };
}

function samePhone(left: string, right: string) {
  return left.replace(/\D/g, "") === right.replace(/\D/g, "");
}

function customerDetailsPayload(input: CreateCaseInput | UpdateCaseInput): Json {
  const contacts = normalizeCaseContacts(input);

  return {
    ...(input.customerType !== undefined ? { type: input.customerType } : {}),
    ...(input.customerFirstName !== undefined ? { firstName: cleanString(input.customerFirstName) } : {}),
    ...(input.customerLastName !== undefined ? { lastName: cleanString(input.customerLastName) } : {}),
    ...(input.companyName !== undefined ? { companyName: cleanString(input.companyName) } : {}),
    ...(input.companyIdNumber !== undefined ? { companyIdNumber: cleanString(input.companyIdNumber) } : {}),
    ...(input.assistanceServiceName !== undefined ? { assistanceServiceName: cleanString(input.assistanceServiceName) } : {}),
    ...(input.assistanceReference !== undefined ? { assistanceReference: cleanString(input.assistanceReference) } : {}),
    ...(input.partnerDirectoryId !== undefined ? { partnerDirectoryId: cleanString(input.partnerDirectoryId) } : {}),
    ...(input.alternativeContact !== undefined ? { alternativeContact: cleanString(input.alternativeContact) } : {}),
    ...(input.contacts !== undefined ? { contacts } : {}),
    ...(input.customerNote !== undefined ? { note: cleanString(input.customerNote) } : {}),
  };
}

function vehicleDetailsPayload(input: CreateCaseInput | UpdateCaseInput, options: { includeJobTypes?: boolean } = { includeJobTypes: true }): Json {
  const flags = normalizeVehicleFlags(input.vehicleConditionFlags, input.vehicleDriveable);

  return {
    ...(options.includeJobTypes === false || input.jobTypes === undefined ? {} : { jobTypes: jobTypesForInput(input) }),
    ...(input.vehicleType !== undefined ? { vehicleType: input.vehicleType } : {}),
    ...(input.productionYear !== undefined ? { productionYear: cleanNumber(input.productionYear) } : {}),
    ...(input.vehicleColor !== undefined ? { color: cleanString(input.vehicleColor) } : {}),
    ...(input.driveType !== undefined ? { driveType: cleanString(input.driveType) } : {}),
    ...(flags !== undefined ? { conditionFlags: flags } : {}),
    ...(input.vehicleNote !== undefined ? { note: cleanString(input.vehicleNote) } : {}),
  };
}

function normalizeVehicleFlags(flags: VehicleConditionFlag[] | undefined, driveable: boolean | null | undefined) {
  if (flags === undefined && driveable === undefined) {
    return undefined;
  }

  if (driveable === null) {
    return Array.from(new Set(flags ?? [])).filter((flag) => flag !== "driveable" && flag !== "immobile");
  }

  const fallbackDriveable = driveable ?? flags?.includes("driveable") ?? false;
  const uniqueFlags = Array.from(new Set(flags ?? (fallbackDriveable ? ["driveable" as const] : ["immobile" as const])));
  const blockedFlag = fallbackDriveable ? "immobile" : "driveable";
  const requiredFlag = fallbackDriveable ? "driveable" : "immobile";
  const normalized = uniqueFlags.filter((flag) => flag !== blockedFlag);

  return normalized.includes(requiredFlag) ? normalized : [requiredFlag, ...normalized];
}

function incidentDetailsPayload(input: CreateCaseInput | UpdateCaseInput): Json {
  return {
    ...(input.incidentType !== undefined ? { type: input.incidentType } : {}),
    ...("vehicleIssue" in input || "incidentDescription" in input
      ? { description: canonicalCaseProblemDescription(input.vehicleIssue, input.incidentDescription) ?? null }
      : {}),
    ...(input.participantsCount !== undefined ? { participantsCount: cleanNumber(input.participantsCount) } : {}),
    ...(input.passengersCount !== undefined ? { passengersCount: cleanNumber(input.passengersCount) } : {}),
    ...(input.damages !== undefined ? { damages: cleanString(input.damages) } : {}),
    ...(input.damageAreas !== undefined ? { damageAreas: input.damageAreas } : {}),
    ...(input.damageNote !== undefined ? { damageNote: cleanString(input.damageNote) } : {}),
  };
}

function locationDetailsPayload(input: CreateCaseInput | UpdateCaseInput): Json {
  return {
    ...(input.manualPickupAddress !== undefined ? { manualPickupAddress: cleanString(input.manualPickupAddress) } : {}),
    ...(input.manualDestinationAddress !== undefined ? { manualDestinationAddress: cleanString(input.manualDestinationAddress) } : {}),
    ...(input.roadName !== undefined ? { roadName: cleanString(input.roadName) } : {}),
    ...(input.kilometerSection !== undefined ? { kilometerSection: cleanString(input.kilometerSection) } : {}),
    ...(input.drivingDirection !== undefined ? { drivingDirection: cleanString(input.drivingDirection) } : {}),
    ...(input.placeType !== undefined ? { placeType: input.placeType } : {}),
    ...(input.locationComplications !== undefined ? { complications: cleanString(input.locationComplications) } : {}),
    ...(input.accessComplications !== undefined ? { accessComplications: input.accessComplications } : {}),
    ...(input.destinationNote !== undefined ? { destinationNote: cleanString(input.destinationNote) } : {}),
  };
}

function replacementVehiclePayload(input: CreateCaseInput | UpdateCaseInput): Json {
  return {
    ...(input.replacementVehicleNeeded !== undefined ? { needed: input.replacementVehicleNeeded } : {}),
    ...(input.replacementVehicleType !== undefined ? { requestedType: cleanString(input.replacementVehicleType) } : {}),
    ...(input.replacementVehiclePreferences !== undefined ? { preferences: input.replacementVehiclePreferences } : {}),
    ...(input.replacementVehicleNote !== undefined ? { note: cleanString(input.replacementVehicleNote) } : {}),
    ...("replacementVehicleCategory" in input ? { category: input.replacementVehicleCategory ?? null } : {}),
    ...(input.replacementVehicleDeliveryPlace !== undefined ? { deliveryPlace: cleanString(input.replacementVehicleDeliveryPlace) } : {}),
    ...("replacementVehicleEntitlement" in input ? { entitlement: input.replacementVehicleEntitlement ?? null } : {}),
    ...("replacementVehicleExtensionPossible" in input ? { extensionPossible: input.replacementVehicleExtensionPossible ?? null } : {}),
    ...("replacementVehicleMaxDays" in input ? { maxDays: input.replacementVehicleMaxDays ?? null } : {}),
    ...("replacementVehicleProvisionStatus" in input ? { provisionStatus: input.replacementVehicleProvisionStatus ?? null } : {}),
    ...(input.replacementVehicleProvisionReason !== undefined ? { provisionReason: cleanString(input.replacementVehicleProvisionReason) } : {}),
  };
}

function paymentDetailsPayload(input: CreateCaseInput | UpdateCaseInput): Json {
  return {
    ...(input.paymentMethod !== undefined ? { method: input.paymentMethod } : {}),
    ...(input.paymentStatus !== undefined ? { status: input.paymentStatus } : {}),
  };
}

function closureDetailsPayload(input: CreateCaseInput | UpdateCaseInput): Json {
  return {
    ...(input.closureType !== undefined ? { type: input.closureType } : {}),
    ...(input.closureStatus !== undefined ? { status: cleanString(input.closureStatus) } : {}),
    ...(input.insurancePortalUrl !== undefined ? { insurancePortalUrl: cleanString(input.insurancePortalUrl) } : {}),
    ...(input.closureNote !== undefined ? { note: cleanString(input.closureNote) } : {}),
  };
}

function attachmentMetadataPayload(attachments: CaseAttachmentInput[] | undefined): Json {
  return (attachments ?? [])
    .filter((attachment) => nonEmpty(attachment.fileName))
    .map((attachment) => ({
      id: cleanString(attachment.id) ?? crypto.randomUUID(),
      category: attachment.category,
      fileName: attachment.fileName.trim(),
      mimeType: cleanString(attachment.mimeType),
      sizeBytes: cleanNumber(attachment.sizeBytes),
      note: cleanString(attachment.note),
      createdAt: cleanString(attachment.createdAt) ?? new Date().toISOString(),
    }));
}

function trustedAttachmentMetadataPayload(attachments: CaseAttachmentInput[] | undefined): Json {
  return (attachments ?? [])
    .filter((attachment) => nonEmpty(attachment.fileName))
    .map((attachment) => ({
      id: cleanString(attachment.id) ?? crypto.randomUUID(),
      category: attachment.category,
      fileName: attachment.fileName.trim(),
      storageBucket: cleanString(attachment.storageBucket),
      storagePath: cleanString(attachment.storagePath),
      mimeType: cleanString(attachment.mimeType),
      sizeBytes: cleanNumber(attachment.sizeBytes),
      note: cleanString(attachment.note),
      createdAt: cleanString(attachment.createdAt) ?? new Date().toISOString(),
    }));
}

function attachmentMetadataPayloadForCaseUpdate(existing: CaseAttachmentInput[], attachments: CaseAttachmentInput[] | undefined): Json {
  const existingStorageById = new Map(
    existing
      .filter((attachment) => attachment.id && attachment.storagePath)
      .map((attachment) => [
        attachment.id as string,
        {
          storageBucket: attachment.storageBucket ?? CASE_ATTACHMENTS_BUCKET,
          storagePath: attachment.storagePath as string,
        },
      ]),
  );

  return (attachments ?? [])
    .filter((attachment) => nonEmpty(attachment.fileName))
    .map((attachment) => {
      const id = cleanString(attachment.id) ?? crypto.randomUUID();
      const existingStorage = existingStorageById.get(id);

      return {
        id,
        category: attachment.category,
        fileName: attachment.fileName.trim(),
        storageBucket: existingStorage?.storageBucket,
        storagePath: existingStorage?.storagePath,
        mimeType: cleanString(attachment.mimeType),
        sizeBytes: cleanNumber(attachment.sizeBytes),
        note: cleanString(attachment.note),
        createdAt: cleanString(attachment.createdAt) ?? new Date().toISOString(),
      };
    });
}

function attachmentMetadataPayloadFromJson(value: Json): CaseAttachmentInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = objectJson(item as Json);
    const fileName = typeof record.fileName === "string" ? record.fileName : null;
    const category = typeof record.category === "string" && isAttachmentCategory(record.category) ? record.category : null;

    if (!fileName || !category) {
      return [];
    }

    return [
      {
        id: typeof record.id === "string" ? record.id : undefined,
        category,
        fileName,
        storageBucket: typeof record.storageBucket === "string" ? record.storageBucket : undefined,
        storagePath: typeof record.storagePath === "string" ? record.storagePath : undefined,
        mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
        sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : undefined,
        note: typeof record.note === "string" ? record.note : undefined,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
      },
    ];
  });
}

function validateCaseAttachmentFile(file: File) {
  if (file.size <= 0) {
    throw new MutationError(`Súbor ${file.name} je prázdny.`, 400);
  }

  if (file.size > MAX_CASE_ATTACHMENT_BYTES) {
    throw new MutationError(`Súbor ${file.name} presahuje limit 10 MB.`, 413);
  }

  if (!ALLOWED_CASE_ATTACHMENT_TYPES.has(file.type)) {
    throw new MutationError(`Typ súboru ${file.type || "neznámy"} nie je povolený.`, 415);
  }
}

function attachmentCategoryForMime(mimeType: string): CaseAttachmentCategory {
  if (mimeType.startsWith("image/")) {
    return "photo";
  }

  if (mimeType.startsWith("video/")) {
    return "video";
  }

  return "document";
}

function isAttachmentCategory(value: string): value is CaseAttachmentCategory {
  return value === "photo" || value === "video" || value === "document";
}

function safeStorageFileName(fileName: string) {
  const extension = fileName.includes(".") ? `.${fileName.split(".").pop()}` : "";
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const safeBase = normalizeText(baseName).replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "document";
  return `${safeBase}${extension.toLowerCase()}`;
}

function caseUpdatePayload(
  existing: CaseRow,
  input: UpdateCaseInput,
  contactId: string | null,
  vehicleId: string | null,
  pickupLocationId: string | null,
  destinationLocationId: string | null,
  existingLicensePlate: string | null,
) {
  return {
    ...(input.status ? { status: input.status } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...("sourceType" in input ? { source_type: input.sourceType ?? null } : {}),
    ...(input.caseType !== undefined ? { case_type: cleanString(input.caseType) } : {}),
    ...(input.note !== undefined ? { main_note: cleanString(input.note) } : {}),
    ...(input.licensePlate !== undefined || input.caseType !== undefined
      ? {
          summary: caseSummary({
            caseType: input.caseType !== undefined ? input.caseType : existing.case_type,
            licensePlate: input.licensePlate !== undefined ? input.licensePlate : existingLicensePlate ?? undefined,
          }),
        }
      : {}),
    contact_id: contactId,
    vehicle_id: vehicleId,
    pickup_location_id: pickupLocationId,
    destination_location_id: destinationLocationId,
    ...(hasAny(input, [
      "customerType",
      "customerFirstName",
      "customerLastName",
      "companyName",
      "companyIdNumber",
      "assistanceServiceName",
      "assistanceReference",
      "partnerDirectoryId",
      "contacts",
      "alternativeContact",
      "customerNote",
    ])
      ? { customer_details: mergeJson(existing.customer_details, customerDetailsPayload(input)) }
      : {}),
    ...(hasAny(input, ["jobTypes", "vehicleType", "productionYear", "vehicleColor", "driveType", "vehicleConditionFlags", "vehicleDriveable", "vehicleNote"])
      ? { vehicle_details: mergeJson(existing.vehicle_details, vehicleDetailsPayload(input, { includeJobTypes: "jobTypes" in input })) }
      : {}),
    ...(hasAny(input, ["incidentType", "incidentDescription", "vehicleIssue", "participantsCount", "passengersCount", "damages", "damageAreas", "damageNote"])
      ? { incident_details: mergeJson(existing.incident_details, incidentDetailsPayload(input)) }
      : {}),
    ...(hasAny(input, ["manualPickupAddress", "manualDestinationAddress", "roadName", "kilometerSection", "drivingDirection", "placeType", "locationComplications", "accessComplications", "destinationNote"])
      ? { location_details: mergeJson(existing.location_details, locationDetailsPayload(input)) }
      : {}),
    ...(hasAny(input, ["replacementVehicleNeeded", "replacementVehicleType", "replacementVehiclePreferences", "replacementVehicleNote"])
      ? { replacement_vehicle_details: mergeJson(existing.replacement_vehicle_details, replacementVehiclePayload(input)) }
      : {}),
    ...(hasAny(input, ["paymentMethod", "paymentStatus"]) ? { payment_details: mergeJson(existing.payment_details, paymentDetailsPayload(input)) } : {}),
    ...(hasAny(input, ["closureType", "closureStatus", "insurancePortalUrl", "closureNote"])
      ? { closure_details: mergeJson(existing.closure_details, closureDetailsPayload(input)) }
      : {}),
    ...(input.attachmentMetadata !== undefined
      ? { attachments_metadata: attachmentMetadataPayloadForCaseUpdate(attachmentMetadataPayloadFromJson(existing.attachments_metadata), input.attachmentMetadata) }
      : {}),
  };
}

function hasAny(input: UpdateCaseInput, keys: string[]) {
  return keys.some((key) => key in input);
}

function mergeJson(previous: Json, next: Json): Json {
  return { ...objectJson(previous), ...objectJson(next) };
}

function objectJson(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : {};
}

function hasContactUpdate(input: UpdateCaseInput) {
  return ["contactName", "contactPhone", "contactEmail", "contacts", "customerNote"].some((key) => key in input);
}

function hasVehicleUpdate(input: UpdateCaseInput) {
  return [
    "licensePlate",
    "vin",
    "vehicleMake",
    "vehicleModel",
    "vehicleCategory",
    "vehicleType",
    "transmission",
    "productionYear",
    "vehicleColor",
    "driveType",
    "weightKg",
    "vehicleDriveable",
    "vehicleIssue",
    "incidentDescription",
    "vehicleNote",
  ].some((key) => key in input);
}

function jobTypesForInput(input: CreateCaseInput | UpdateCaseInput): JobType[] {
  if (input.jobTypes !== undefined) {
    return input.jobTypes;
  }

  const text = normalizeText([input.caseType ?? "", input.vehicleIssue ?? ""].join(" "));
  const jobs: JobType[] = [];
  if (includesAny(text, ["odtah", "asistenc"])) jobs.push("tow");
  if (includesAny(text, ["nahrad"])) jobs.push("replacement_vehicle");
  if (includesAny(text, ["mieste", "bateria", "defekt"])) jobs.push("onsite_assistance");
  if (includesAny(text, ["vyslobod", "priekop", "prevrat"])) jobs.push("vehicle_recovery");
  return jobs;
}

type CaseActionDescriptor = {
  body: string;
  status?: CaseStatus;
  taskDueMinutes?: number;
  taskKind?: CaseTaskKind;
  taskPriority?: CasePriority;
  taskTitle?: string;
  title: string;
};

function caseActionDescriptor(action: CaseActionInput["action"], note: string | undefined): CaseActionDescriptor {
  const suffix = note ? ` Poznámka: ${note}` : "";

  if (action === "call_customer") {
    return {
      title: "Hovor zákazníkovi",
      body: `Operátor má zavolať zákazníkovi.${suffix}`,
      taskTitle: "Zavolať zákazníkovi",
      taskDueMinutes: 5,
      taskKind: "callback",
      taskPriority: "high",
    };
  }
  if (action === "send_sms") {
    return { title: "SMS pripravená", body: `Lokalizačná SMS bola pripravená na spracovanie mimo karty zásahu.${suffix}` };
  }
  if (action === "send_eta") {
    return { title: "ETA pripravené", body: `ETA pre klienta bolo pripravené na spracovanie mimo karty zásahu.${suffix}` };
  }
  if (action === "create_pdf") {
    return { title: "PDF pripravené", body: `PDF karta zásahu bola označená ako pripravená na neskorší export.${suffix}` };
  }
  if (action === "invoice") {
    return {
      title: "Fakturácia označená",
      body: `Prípad bol označený na fakturáciu.${suffix}`,
      taskTitle: "Skontrolovať fakturáciu prípadu",
      taskDueMinutes: 60,
      taskKind: "billing",
      taskPriority: "normal",
    };
  }
  if (action === "close_case") {
    return { title: "Ukončenie zásahu", body: `Zásah bol manuálne ukončený.${suffix}`, status: "completed_assisted" as CaseStatus };
  }

  return { title: "Zásah označený ako dokončený", body: `Prípad bol označený ako dokončený.${suffix}`, status: "completed_assisted" as CaseStatus };
}

function validateAttendanceShiftInput(input: CreateAttendanceShiftInput) {
  if (!nonEmpty(input.profileId)) {
    throw new MutationError("Služba potrebuje operátora.", 400);
  }

  if (!isIsoDate(input.dateLocal) || !isIsoDateTime(input.plannedStartAt) || !isIsoDateTime(input.plannedEndAt)) {
    throw new MutationError("Služba potrebuje platný dátum a čas.", 400);
  }

  if (new Date(input.plannedEndAt).getTime() <= new Date(input.plannedStartAt).getTime()) {
    throw new MutationError("Koniec služby musí byť po začiatku.", 400);
  }
}

function validateAttendanceShiftUpdateInput(input: UpdateAttendanceShiftInput) {
  if (input.dateLocal !== undefined && !isIsoDate(input.dateLocal)) {
    throw new MutationError("Dátum služby nie je platný.", 400);
  }

  if (input.plannedStartAt !== undefined && !isIsoDateTime(input.plannedStartAt)) {
    throw new MutationError("Začiatok služby nie je platný.", 400);
  }

  if (input.plannedEndAt !== undefined && !isIsoDateTime(input.plannedEndAt)) {
    throw new MutationError("Koniec služby nie je platný.", 400);
  }

  if (
    input.plannedStartAt &&
    input.plannedEndAt &&
    new Date(input.plannedEndAt).getTime() <= new Date(input.plannedStartAt).getTime()
  ) {
    throw new MutationError("Koniec služby musí byť po začiatku.", 400);
  }
}

function validateAttendanceRequestInput(input: CreateAttendanceRequestInput) {
  if (!nonEmpty(input.profileId)) {
    throw new MutationError("Žiadosť potrebuje zamestnanca.", 400);
  }

  if (!["vacation", "unavailable", "sick_leave", "doctor", "other"].includes(input.type)) {
    throw new MutationError("Typ žiadosti nie je platný.", 400);
  }

  if (!isIsoDate(input.startDateLocal) || !isIsoDate(input.endDateLocal) || input.endDateLocal < input.startDateLocal) {
    throw new MutationError("Žiadosť potrebuje platný rozsah dátumov.", 400);
  }

  if ((input.startTimeLocal && !isTimeLocal(input.startTimeLocal)) || (input.endTimeLocal && !isTimeLocal(input.endTimeLocal))) {
    throw new MutationError("Čas nedostupnosti nie je platný.", 400);
  }

  if (input.status && !["draft", "pending"].includes(input.status)) {
    throw new MutationError("Nová žiadosť môže byť iba draft alebo pending.", 400);
  }
}

function validateAttendanceRequestUpdateInput(input: UpdateAttendanceRequestInput) {
  if (input.profileId !== undefined && !nonEmpty(input.profileId)) {
    throw new MutationError("Žiadosť potrebuje zamestnanca.", 400);
  }

  if (input.type !== undefined && !["vacation", "unavailable", "sick_leave", "doctor", "other"].includes(input.type)) {
    throw new MutationError("Typ žiadosti nie je platný.", 400);
  }

  if (input.startDateLocal !== undefined && !isIsoDate(input.startDateLocal)) {
    throw new MutationError("Začiatok žiadosti nie je platný.", 400);
  }

  if (input.endDateLocal !== undefined && !isIsoDate(input.endDateLocal)) {
    throw new MutationError("Koniec žiadosti nie je platný.", 400);
  }

  if (input.startDateLocal && input.endDateLocal && input.endDateLocal < input.startDateLocal) {
    throw new MutationError("Koniec žiadosti musí byť po začiatku.", 400);
  }

  if ((input.startTimeLocal && !isTimeLocal(input.startTimeLocal)) || (input.endTimeLocal && !isTimeLocal(input.endTimeLocal))) {
    throw new MutationError("Čas nedostupnosti nie je platný.", 400);
  }

  if (input.status !== undefined && !["draft", "pending", "cancelled"].includes(input.status)) {
    throw new MutationError("Status žiadosti nie je platný.", 400);
  }
}

function validateBulkAttendanceInput(input: CreateBulkAttendanceShiftsInput) {
  if (!["fixed_8h", "fixed_12h", "custom"].includes(input.shiftMode)) {
    throw new MutationError("Režim smien nie je platný.", 400);
  }

  if (!Array.isArray(input.assignments) || input.assignments.length === 0) {
    throw new MutationError("Plánovanie potrebuje aspoň jednu smenu.", 400);
  }

  input.assignments.forEach((assignment) => {
    if (!nonEmpty(assignment.profileId) || !nonEmpty(assignment.templateId) || !isIsoDate(assignment.dateLocal)) {
      throw new MutationError("Každá plánovaná smena potrebuje deň, šablónu a operátora.", 400);
    }

    if ((assignment.startTimeLocal && !isTimeLocal(assignment.startTimeLocal)) || (assignment.endTimeLocal && !isTimeLocal(assignment.endTimeLocal))) {
      throw new MutationError("Custom časy smeny nie sú platné.", 400);
    }
  });
}

function fleetAssetWritePayload(input: CreateFleetAssetInput | UpdateFleetAssetInput) {
  return {
    ...(input.make !== undefined ? { make: cleanString(input.make) } : {}),
    ...(input.model !== undefined ? { model: cleanString(input.model) } : {}),
    ...(input.licensePlate !== undefined ? { license_plate: cleanString(input.licensePlate)?.toUpperCase() ?? null } : {}),
    ...(input.vin !== undefined ? { vin: cleanString(input.vin)?.toUpperCase() ?? null } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.category !== undefined ? { category: input.category ?? null } : {}),
    ...(input.weightKg !== undefined ? { weight_kg: optionalNumber(input.weightKg) } : {}),
    ...(input.notes !== undefined ? { notes: cleanString(input.notes) } : {}),
    ...(input.insuranceValidUntil !== undefined ? { insurance_valid_until: optionalDate(input.insuranceValidUntil) } : {}),
    ...(input.highwayVignetteValidUntil !== undefined ? { highway_vignette_valid_until: optionalDate(input.highwayVignetteValidUntil) } : {}),
    ...(input.technicalInspectionValidUntil !== undefined ? { technical_inspection_valid_until: optionalDate(input.technicalInspectionValidUntil) } : {}),
    ...(input.emissionInspectionValidUntil !== undefined ? { emission_inspection_valid_until: optionalDate(input.emissionInspectionValidUntil) } : {}),
    ...(input.occupiedFrom !== undefined ? { occupied_from: optionalDateTime(input.occupiedFrom) } : {}),
    ...(input.occupiedUntil !== undefined ? { occupied_until: optionalDateTime(input.occupiedUntil) } : {}),
    ...(input.occupancyType !== undefined ? { occupancy_type: input.occupancyType ?? null } : {}),
    ...(input.occupancyCaseId !== undefined ? { occupancy_case_id: cleanString(input.occupancyCaseId) } : {}),
    ...(input.occupancyNote !== undefined ? { occupancy_note: cleanString(input.occupancyNote) } : {}),
    ...(input.assignedDriverName !== undefined ? { assigned_driver_name: cleanString(input.assignedDriverName) } : {}),
    ...(input.assignedDriverPhone !== undefined ? { assigned_driver_phone: cleanString(input.assignedDriverPhone) } : {}),
    ...(input.assignedDriverStatus !== undefined ? { assigned_driver_status: input.assignedDriverStatus ?? null } : {}),
    ...(input.towCategory !== undefined ? { tow_category: input.towCategory ?? null } : {}),
    ...(input.capabilities !== undefined ? { capabilities: input.capabilities ?? [] } : {}),
  };
}

function isCustomerContactRole(value: CustomerContactRole | undefined): value is CustomerContactRole {
  return Boolean(value && ["primary_customer", "driver", "owner", "company", "assistance", "partner", "police", "family", "billing", "other"].includes(value));
}

function cleanString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function cleanNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function optionalNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function optionalDate(value: string | undefined) {
  return value?.trim() || null;
}

function optionalDateTime(value: string | undefined) {
  return value?.trim() || null;
}

function dueInMinutes(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function normalizeTaskKind(value: CaseTaskKind | undefined, fallback: CaseTaskKind): CaseTaskKind {
  return value && taskKinds.includes(value) ? value : fallback;
}

function normalizeTaskPriority(value: CasePriority | undefined, fallback: string | CasePriority): CasePriority {
  if (value && taskPriorities.includes(value)) {
    return value;
  }

  return taskPriorities.includes(fallback as CasePriority) ? (fallback as CasePriority) : "normal";
}

function normalizeTaskStatus(value: CaseTaskRow["status"]): CaseTaskRow["status"] {
  if (value === "open" || value === "done" || value === "overdue") {
    return value;
  }

  throw new MutationError("Neplatný stav úlohy.", 400);
}

function taskStatusEventLabel(status: CaseTaskRow["status"]) {
  if (status === "done") return "vybavené";
  if (status === "overdue") return "po termíne";

  return "otvorená";
}

function normalizeTaskReminderChannels(value: TaskReminderChannel[] | undefined): TaskReminderChannel[] {
  const channels = new Set<TaskReminderChannel>(["in_app"]);

  for (const item of value ?? []) {
    if (item === "in_app" || item === "email") {
      channels.add(item);
    }
  }

  return [...channels];
}

function dueAtForTask(value: string | undefined, fallbackMinutes: number) {
  const cleaned = optionalDateTime(value);

  if (!cleaned) {
    return dueInMinutes(fallbackMinutes);
  }

  const dueAt = new Date(cleaned);

  if (!Number.isFinite(dueAt.getTime())) {
    throw new MutationError("Termín úlohy musí byť platný dátum.", 400);
  }

  if (dueAt.getTime() < Date.now() - 60_000) {
    throw new MutationError("Termín úlohy nemôže byť v minulosti.", 400);
  }

  return dueAt.toISOString();
}

function dueAtForTaskUpdate(value: string | undefined) {
  const cleaned = optionalDateTime(value);

  if (!cleaned) {
    throw new MutationError("Termín úlohy musí byť platný dátum.", 400);
  }

  const dueAt = new Date(cleaned);

  if (!Number.isFinite(dueAt.getTime())) {
    throw new MutationError("Termín úlohy musí byť platný dátum.", 400);
  }

  return dueAt.toISOString();
}

function sameIsoDateTime(left: string | null | undefined, right: string | null | undefined) {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();

  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return left === right;
  }

  return leftTime === rightTime;
}

function notificationStatusUpdatePayload(status: NotificationRow["status"], now: string): Tables["motorist_notifications"]["Update"] {
  if (status === "unread") {
    return { status, read_at: null, archived_at: null };
  }

  if (status === "read") {
    return { status, read_at: now, archived_at: null };
  }

  return { status, archived_at: now };
}

function addDays(dateLocal: string, days: number) {
  const date = new Date(`${dateLocal}T00:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function shiftIsoPlusDays(value: string, days: number) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);

  return date.toISOString();
}

function localDateTimeToIso(dateLocal: string, timeLocal: string) {
  const value = new Date(`${dateLocal}T${timeLocal}`);

  if (!Number.isFinite(value.getTime())) {
    return null;
  }

  return value.toISOString();
}
