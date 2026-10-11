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
