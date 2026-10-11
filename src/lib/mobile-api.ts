/** Versioned, provider-neutral DTOs. Native imports these as types only. */
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
};
export type MobileHistory = MobileScope & {
  calls: MobileHistoryCall[];
  nextCursor: string | null;
};

export type MobileCasePriority = "urgent" | "high" | "normal" | "low";
export type MobileCaseJobType = "tow" | "replacement_vehicle" | "onsite_assistance" | "vehicle_recovery";
export type MobileCaseUpdateStatus = "open" | "completed_assisted" | "completed_no_assistance" | "waiting_for_docs" | "cancelled" | "futile_trip";
export type MobileCaseFilter = {
  ownership: "mine" | "all";
  category: "open" | "all";
  q: string;
  ownerId?: string | null;
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
  selection: Pick<MobileCaseFilter, "ownership" | "category" | "q"> & { ownerId: string | null };
};
export type MobileCaseDispatcher = { id: string; name: string; active: boolean };
export type MobileCaseDispatchers = MobileScope & { dispatchers: MobileCaseDispatcher[] };
export type MobileCaseDetailData = MobileCaseSummary & {
  mainNote: string;
  incidentDescription: string | null;
  jobTypeLabels: string[];
  editable: Required<MobileCaseCreateInput> & { status: string };
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
  incidentDescription?: string;
  note?: string;
  priority?: MobileCasePriority;
  jobTypes?: MobileCaseJobType[];
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
