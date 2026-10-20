import type { CaseStatus } from "../domain/types";
import type { HandoffEvent, HandoffPublished, HandoffState } from "../domain/case-handoff";

/** Versioned, provider-neutral DTOs shared with the native client. */
export type MobileEnvironment = "test" | "production";
export type MobileRole = "dispatcher" | "senior_dispatcher" | "manager" | "admin";
export type MobilePresence = "available" | "ringing" | "on_call" | "after_call_work" | "paused" | "offline";
export type MobileScope = {
  ok: true;
  apiVersion: 1;
  environment: MobileEnvironment;
  profileId: string;
  checkedAt: string;
};
export type MobileDraftScope = MobileScope & { organizationId: string };
/** Configuration opt-ins only; not provider, device, push-delivery or audio acceptance. */
export type MobileVoiceReadiness = MobileScope & {
  nativeCallingEnabled: boolean;
  backgroundIncomingEnabled: boolean;
};
export type MobileVoiceColleague = {
  profileId: string;
  displayName: string;
  status: "available" | "paused" | "busy" | "offline";
  canCall: boolean;
  reason: "busy" | "wrap_up" | "offline" | "no_phone" | "personal_mobile" | null;
};
export type MobileVoiceColleagues = MobileScope & { colleagues: MobileVoiceColleague[]; hasMore: boolean };
export type MobileVoiceInternalStarted = MobileScope & {
  sessionId: string; operatorLegCallControlId: string; to: string; targetProfileId: string;
};
export type MobileVoiceCallbackStarted = MobileScope & {
  sessionId: string; operatorLegCallControlId: string; to: string; callbackRequestId: string; linked: boolean;
};
export type MobileVoiceAttemptEnded = MobileScope & {
  resolved: boolean; sessionId: string | null; terminationPending: boolean;
};
export type MobileMe = MobileScope & {
  profile: { id: string; displayName: string; email: string | null; role: MobileRole };
  capabilities: { voice: false; presenceWrite: false };
};
export type MobileActiveCall = {
  id: string;
  direction: "inbound" | "outbound" | "internal";
  state: string;
  number: string | null;
  name: string | null;
  /** The directory contact for the customer's number, when one is known. */
  contactName: string | null;
  lineLabel: string | null;
  startedAt: string;
};
export type MobileConsole = MobileScope & {
  presence: { status: MobilePresence; since: string | null };
  activeCalls: MobileActiveCall[];
  // These are capabilities of this native release, not the web phone's state.
  capabilities: { voice: false; presenceWrite: false };
};
export type MobileHistoryCall = {
  id: string;
  direction: "inbound" | "outbound" | "internal";
  status: string;
  number: string | null;
  name: string | null;
  lineLabel: string;
  operatorName: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  /** Callback request created for this call; status only, never its notes. */
  callback: { status: "open" | "scheduled" | "done" | "cancelled"; claimedByName: string | null } | null;
};
export type MobileHistory = MobileScope & {
  calls: MobileHistoryCall[];
  nextCursor: string | null;
};

export type MobileCaseStatus = CaseStatus;
export type MobileCasePriority = "urgent" | "high" | "normal" | "low";
export type MobileCaseJobType = "tow" | "replacement_vehicle" | "onsite_assistance" | "vehicle_recovery";
export type MobileCaseUpdateStatus = "open" | "completed_assisted" | "completed_no_assistance" | "waiting_for_docs" | "cancelled" | "futile_trip";
export type MobileCaseFilter = {
  ownership: "mine" | "all" | "unassigned";
  category: "open" | "all";
  q: string;
  ownerId?: string | null;
  status?: MobileCaseStatus | null;
  priority?: MobileCasePriority | null;
  cursor?: string | null;
};
export type MobileCaseSummary = {
  id: string;
  caseNumber: string;
  status: string;
  statusLabel: string;
  priority: MobileCasePriority;
  priorityLabel: string;
  owner: { id: string | null; name: string | null; mine: boolean };
  contact: { name: string | null; phone: string | null };
  vehicle: { licensePlate: string | null; description: string | null };
  pickupAddress: string | null;
  destinationAddress: string | null;
  summary: string;
  createdAt: string;
  updatedAt: string;
};
export type MobileCases = MobileScope & {
  cases: MobileCaseSummary[];
  nextCursor: string | null;
  selection: Pick<MobileCaseFilter, "ownership" | "category" | "q" | "status" | "priority"> & { ownerId: string | null };
};
/** Four independent exact-count observations, not a transaction-wide snapshot. */
export type MobileCaseOverview = MobileScope & {
  counts: { open: number; mine: number; unassigned: number; urgent: number };
};
export type MobileCaseDispatcher = { id: string; name: string; active: boolean };
export type MobileCaseDispatchers = MobileScope & { dispatchers: MobileCaseDispatcher[] };
export type MobileCaseDetailData = MobileCaseSummary & {
  mainNote: string;
  incidentDescription: string | null;
  jobTypeLabels: string[];
  editable: Required<Omit<MobileCaseCreateInput, "pickup" | "destination">> & { status: string };
  map?: MobileCaseMap;
  statusOptions: { value: MobileCaseUpdateStatus; label: string }[];
  timeline: { id: string; title: string; body: string | null; createdAt: string; actorName: string | null }[];
};
export type MobileCaseDetail = MobileScope & { case: MobileCaseDetailData };
export type MobileCaseCreateInput = {
  contactName?: string;
  contactPhone?: string;
  licensePlate?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  manualPickupAddress?: string;
  manualDestinationAddress?: string;
  /** Mutually exclusive with the same target's manual address. */
  pickup?: MobileCasePlaceSelection | null;
  destination?: MobileCasePlaceSelection | null;
  incidentDescription?: string;
  note?: string;
  priority?: MobileCasePriority;
  jobTypes?: MobileCaseJobType[];
};
export type MobileCasePlaceSelection = {
  label: string;
  address: string;
  lat: number;
  lng: number;
  provider: "google_places" | "manual" | "approximate";
  placeId?: string;
};
export type MobileCaseMapLocation = {
  id: string;
  label: string;
  address: string;
  point: { lat: number; lng: number } | null;
  source: "google_places" | "manual" | "approximate" | "client_gps" | "unknown";
  accuracyMeters: number | null;
  capturedAt: string | null;
};
export type MobileCaseMap = {
  pickup: MobileCaseMapLocation | null;
  destination: MobileCaseMapLocation | null;
  clientLocation: MobileCaseMapLocation | null;
};
export type MobileCaseOwnerInput = {
  mutationId: string;
  expectedUpdatedAt: string;
  ownerId: string;
};
export type MobileCaseOwnerContext = MobileScope & {
  caseId: string;
  caseRevision: string;
  owner: MobileCaseSummary["owner"];
  available: boolean;
  capabilities: { take: boolean; assign: boolean };
  targets: { id: string; name: string }[];
};
export type MobileCaseOwnerAssigned = MobileScope & {
  caseId: string;
  mutationId: string;
  committedRevision: string;
  ownerId: string;
  refreshRequired: true;
};
export type MobileCaseCreated = MobileScope & {
  caseId: string;
  caseNumber: string;
  warnings: { code: string; field: string; message: string }[];
};
export type MobileCaseUpdateInput = MobileCaseCreateInput & {
  expectedUpdatedAt: string;
  mutationId: string;
  status?: MobileCaseUpdateStatus;
};
export type MobileCaseUpdated = MobileScope & {
  caseId: string;
  mutationId: string;
  committedRevision: string;
  warnings: MobileCaseCreated["warnings"];
  refreshRequired: true;
};
export type MobileCaseNoteInput = { mutationId: string; note: string };
export type MobileCaseNoteAdded = MobileScope & {
  caseId: string;
  mutationId: string;
  eventId: string;
  warnings: MobileCaseCreated["warnings"];
  refreshRequired: true;
};

export const MOBILE_CASE_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
export type MobileCaseAttachmentInput = {
  mutationId: string;
  expectedUpdatedAt: string;
  fileName: string;
  category: "photo" | "document";
  note?: string;
};
export type MobileCaseAttachment = {
  id: string;
  fileName: string;
  category: "photo" | "video" | "document";
  mimeType: string | null;
  sizeBytes: number | null;
  note: string | null;
  createdAt: string | null;
  downloadable: boolean;
};
export type MobileCaseAttachments = MobileScope & {
  caseId: string;
  caseRevision: string;
  attachments: MobileCaseAttachment[];
};
export type MobileCaseAttachmentAdded = MobileScope & {
  caseId: string;
  mutationId: string;
  attachment: MobileCaseAttachment;
  committedRevision: string;
  refreshRequired: true;
};
export type MobileCaseAttachmentDownload = MobileScope & {
  caseId: string;
  attachmentId: string;
  url: string;
  expiresAt: string;
};

export type MobileTaskWorkflowState = "todo" | "in_progress" | "in_review" | "done";
export type MobileTaskWorkflowAction = "start" | "submit_review" | "approve" | "return" | "complete" | "reopen" | "to_todo";
export type MobileTaskKind = "callback" | "sms" | "dispatch" | "documents" | "billing" | "handover" | "other";
export type MobileTaskColleague = { id: string; name: string };
export type MobileTaskCapabilities = { create: boolean; workflow: boolean; messages: boolean };
export type MobileTask = {
  id: string;
  title: string;
  status: "open" | "done" | "overdue";
  priority: MobileCasePriority;
  kind: MobileTaskKind;
  revision: number;
  workflowState: MobileTaskWorkflowState;
  originLocked: boolean;
  assignedTo: MobileTaskColleague | null;
  reviewer: MobileTaskColleague | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByMe: boolean;
  reviewSubmission: string | null;
  reviewReturnReason: string | null;
};
export type MobileMyTaskFilter = {
  view: "assigned" | "review";
  category: "open" | "all";
  q: string;
  cursor?: string | null;
};
export type MobileMyTasks = MobileScope & {
  tasks: MobileTask[];
  nextCursor: string | null;
  capabilities: MobileTaskCapabilities;
  selection: Pick<MobileMyTaskFilter, "view" | "category" | "q">;
};
export type MobileCaseTasks = MobileScope & {
  caseId: string;
  tasks: MobileTask[];
  nextCursor: string | null;
  capabilities: MobileTaskCapabilities;
};
export type MobileTaskDetail = MobileScope & {
  task: MobileTask;
  linkedCases: { id: string; caseNumber: string; status: string }[];
  capabilities: MobileTaskCapabilities;
};
export type MobileTaskColleagues = MobileScope & { colleagues: MobileTaskColleague[] };
export type MobileTaskCreateInput = {
  title: string;
  assignedTo?: string | null;
  dueAt?: string | null;
  priority?: MobileCasePriority;
  kind?: MobileTaskKind;
};
export type MobileTaskCreated = MobileScope & { caseId: string; taskId: string; refreshRequired: true };
export type MobileTaskWorkflowInput = {
  action: MobileTaskWorkflowAction;
  expectedRevision: number;
  commandId: string;
  reviewerProfileId?: string;
  comment?: string;
};
export type MobileTaskTransitioned = MobileScope & {
  taskId: string;
  commandId: string;
  committedRevision: number;
  currentRevision: number;
  refreshRequired: true;
};
export type MobileTaskMessage = {
  id: string;
  taskId: string;
  authorProfileId: string;
  authorName: string;
  body: string;
  createdAt: string;
  clientMessageId: string;
};
export type MobileTaskMessages = MobileScope & { taskId: string; messages: MobileTaskMessage[]; nextCursor: string | null };
export type MobileTaskMessageInput = { clientMessageId: string; body: string };
export type MobileTaskMessageSent = MobileScope & { taskId: string; message: MobileTaskMessage; refreshRequired: true };

export const MOBILE_HANDOFF_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MOBILE_HANDOFF_MAX_GRANTS = 50;
export const MOBILE_HANDOFF_MAX_EVENTS = 200;
export type MobileHandoffSnapshot = HandoffPublished;
export type MobileHandoffGrant = {
  id: string;
  status: HandoffState;
  revision: number;
  publishedVersion: number;
  recipientName: string;
  recipientPhone: string;
  expiresAt: string;
  createdAt: string;
  openedAt: string | null;
  eta: string | null;
  createdBy: string | null;
  publishedAt: string | null;
  canRenew: boolean;
  recoverable: boolean;
  published: MobileHandoffSnapshot | null;
  events: HandoffEvent[];
};
export type MobileCaseHandoffs = MobileScope & {
  caseId: string;
  preview: MobileHandoffSnapshot;
  previewVersion: string;
  handoffs: MobileHandoffGrant[];
  enhanced: boolean;
};
type MobileHandoffTarget = { handoffId: string; expectedRevision: number };
export type MobileHandoffInput = { commandId: string } & (
  | {
      action: "issue";
      recipientName: string;
      recipientPhone: string;
      previewVersion: string;
      instructions?: string;
      scheduledAt?: string | null;
      hours?: number;
    }
  | (MobileHandoffTarget & {
      action: "publish";
      previewVersion: string;
      instructions?: string;
      scheduledAt?: string | null;
    })
  | (MobileHandoffTarget & { action: "renew" | "extend"; hours?: number })
  | (MobileHandoffTarget & { action: "revoke"; comment: string })
  | (MobileHandoffTarget & { action: "recover" })
);
export type MobileHandoffLink =
  | { status: "available"; url: string; expiresAt: string; currentRevision: number }
  | { status: "unavailable"; warning: "link_unavailable" }
  | { status: "not_requested" };
export type MobileHandoffMutation = MobileScope & {
  kind: "mutation";
  caseId: string;
  handoffId: string;
  commandId: string;
  action: Exclude<MobileHandoffInput["action"], "recover">;
  committedRevision: number;
  currentRevision: number;
  refreshRequired: true;
  link: MobileHandoffLink;
};
/** Current-link retrieval has no immutable mutation receipt in the existing RPC. */
export type MobileHandoffRecovered = MobileScope & {
  kind: "link";
  caseId: string;
  handoffId: string;
  commandId: string;
  currentRevision: number;
  link: Extract<MobileHandoffLink, { status: "available" }>;
};
export type MobileHandoffResult = MobileHandoffMutation | MobileHandoffRecovered;

export type MobileVoiceMedia = {
  version: number;
  state: "active" | "held" | "pending" | "unavailable";
  canHold: boolean;
  callControlId: string | null;
};
export type MobileVoiceHoldInput = {
  deviceSessionId: string;
  callControlId: string;
  requestId: string;
  held: boolean;
  expectedVersion: number;
};
export type MobileVoiceCallStatus = MobileScope & {
  sessionId: string;
  state: string;
  connected: boolean;
  ended: boolean;
  terminationPending: boolean;
  media: MobileVoiceMedia;
};
export type MobileVoiceHoldResult = MobileVoiceCallStatus & {
  operation: { requestId: string; held: boolean; outcome: "accepted" | "pending" | "rejected" | "not_found" };
};
