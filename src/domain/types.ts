export type CaseStatus =
  | "new"
  | "triage"
  | "open"
  | "waiting_for_client"
  | "scheduled"
  | "assigned"
  | "dispatched"
  | "in_progress"
  | "waiting_for_docs"
  | "completed_assisted"
  | "completed_no_assistance"
  | "rejected"
  | "cancelled"
  | "futile_trip";

export type CallStatus =
  | "incoming"
  | "ringing_agent"
  | "answered"
  | "missed"
  | "outbound"
  | "ended";

export type OperatorStatus =
  | "available"
  | "ringing"
  | "on_call"
  | "after_call_work"
  | "working_case"
  | "paused"
  | "offline";

export type CasePriority = "urgent" | "high" | "normal" | "low";
export type CaseTaskKind = "callback" | "sms" | "dispatch" | "documents" | "billing" | "handover" | "other";
export type TaskReminderStatus = "pending" | "processing" | "sent" | "cancelled" | "failed";
export type NotificationVisibility = "private" | "team";
export type NotificationKind = "task_due" | "task_overdue" | "handover" | "system";
export type NotificationSeverity = "info" | "warning" | "urgent";
export type NotificationStatus = "unread" | "read" | "archived";
export type NotificationDeliveryStatus = "in_app" | "email_sent" | "email_failed" | "failed";
export type TaskReminderChannel = "in_app" | "email";
export type CustomerType = "private_person" | "insurance" | "company";
export type JobType = "tow" | "replacement_vehicle" | "onsite_assistance" | "vehicle_recovery";
export type VehicleTransmission = "manual" | "automatic" | "unknown";
export type ClientVehicleType = "passenger" | "suv" | "van" | "truck" | "motorcycle" | "electric";
export type VehicleConditionFlag =
  | "driveable"
  | "immobile"
  | "locked"
  | "no_keys"
  | "blocked_wheel"
  | "after_accident"
  | "overturned"
  | "in_ditch";
export type IncidentType = "traffic_accident" | "breakdown" | "flat_tire" | "dead_battery" | "wrong_fuel" | "locked_keys" | "overheating" | "fire" | "other";
export type DamageArea = "front" | "rear" | "left_side" | "right_side" | "roof" | "undercarriage" | "wheel" | "glass" | "engine";
export type PlaceType = "road" | "highway" | "parking_lot" | "garage_outdoor" | "garage_underground" | "company_site" | "field" | "forest";
export type AccessComplication = "narrow_road" | "parallel_parking" | "difficult_access" | "mud" | "snow" | "low_clearance";
export type ReplacementVehiclePreference = "manual" | "automatic" | "suv" | "wagon" | "van" | "ev";
export type CaseAttachmentCategory = "photo" | "video" | "document";
export type PaymentMethod = "cash" | "card" | "invoice" | "insurance";
export type PaymentStatus = "paid" | "unpaid" | "waiting_for_insurance";
export type ClosureType = "insurance_portal" | "self_payer" | "internal";
export type LocationKind = "pickup" | "destination" | "branch" | "tow" | "replacement_car";
export type CustomerContactRole = "primary_customer" | "driver" | "owner" | "company" | "assistance" | "partner" | "police" | "family" | "billing" | "other";
export type PartnerDirectoryKind = "assistance" | "company";
export type AppRole = "dispatcher" | "senior_dispatcher" | "manager" | "admin";
export type AccessStatus = "not_invited" | "invited" | "active" | "disabled";
export type FleetAssetKind = "tow_truck" | "replacement_car";
export type FleetAssetStatus = "available" | "reserved" | "rented" | "assigned" | "busy" | "service" | "offline";
export type FleetLocationSource = "webdispecink" | "commander" | "manual" | "settings_form" | "seed";
export type FleetAssetCategory =
  | "small_car"
  | "wagon"
  | "suv"
  | "van"
  | "personal_tow"
  | "van_tow"
  | "specialized_tow"
  | "heavy_tow";
export type FleetAssetOccupancyType = "reservation" | "rental" | "case_assignment";
/**
 * Overená SWHouse obsadenosť náhradného vozidla (jediný zdroj pravdy = server snapshot).
 * `occupied` = SWHouse ho pozná ako prenajaté, `free` = SWHouse ho pozná ako voľné,
 * `unverified` = SWHouse danú ŠPZ nepozná, `stale` = snapshot je starší než prah / chýba.
 */
export type FleetAssetOccupancy = "occupied" | "free" | "unverified" | "stale";
export type FleetDriverStatus = "available" | "on_shift" | "on_call" | "off_shift";
export type TowTruckCategory = "personal" | "van" | "specialized" | "heavy";
export type TowCapability = "winch" | "low_garage" | "vans" | "trucks" | "immobile" | "crashed";
export type AttendanceShiftTemplateKind = "fixed_8h" | "fixed_12h" | "custom";
export type AttendanceShiftStatus = "draft" | "published" | "confirmed" | "declined" | "completed" | "cancelled" | "no_show";
export type AttendanceSessionStatus = "open" | "closed" | "adjusted";
export type AttendanceSessionSource = "login" | "manual" | "system";
export type AttendanceRequestType = "vacation" | "unavailable" | "sick_leave" | "doctor" | "other";
export type AttendanceRequestStatus = "draft" | "pending" | "approved" | "declined" | "cancelled";
export type AttendanceScheduleBatchStatus = "draft" | "published" | "cancelled";
export type AttendanceAvailabilityLevel = "available" | "warning" | "blocked";
export type AttendancePlanningWarningCode =
  | "approved_vacation"
  | "approved_unavailability"
  | "existing_shift"
  | "overlapping_shift"
  | "pending_time_off"
  | "previous_night_shift"
  | "inactive_profile";

export type GeoPoint = {
  lat: number;
  lng: number;
};

export type DispatchLocation = GeoPoint & {
  id: string;
  label: string;
  address: string;
  kind: LocationKind;
  notes?: string;
};

export type CustomerSharedLocation = GeoPoint & {
  accuracyMeters?: number;
  address?: string;
  label: string;
  locationId?: string;
  submittedAt: string;
};

export type CustomerDetails = {
  type?: CustomerType;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  companyIdNumber?: string;
  assistanceServiceName?: string;
  assistanceReference?: string;
  partnerDirectoryId?: string;
  alternativeContact?: string;
  contacts?: CustomerContact[];
  note?: string;
};

export type CustomerContact = {
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
  isPrimary?: boolean;
};

export type Contact = {
  id: string;
  name: string;
  phone: string;
  email?: string;
  role: "client" | "assistance" | "branch" | "partner";
  notes?: string;
};

export type Vehicle = {
  vehicleLookup?: import("@/lib/vehicle-lookup").VehicleLookupSnapshot;
  id: string;
  licensePlate: string;
  vin?: string;
  make: string;
  model: string;
  productionYear?: number;
  color?: string;
  category: string;
  vehicleType?: ClientVehicleType;
  transmission?: VehicleTransmission;
  driveType?: string;
  weightKg?: number;
  driveable: boolean;
  conditionFlags: VehicleConditionFlag[];
  issue: string;
  specifics?: string;
  note?: string;
};

export type IncidentDetails = {
  type?: IncidentType;
  description?: string;
  participantsCount?: number;
  passengersCount?: number;
  damages?: string;
  damageAreas: DamageArea[];
  damageNote?: string;
};

export type CaseLocationDetails = {
  manualPickupAddress?: string;
  manualDestinationAddress?: string;
  roadName?: string;
  kilometerSection?: string;
  drivingDirection?: string;
  placeType?: PlaceType;
  complications?: string;
  accessComplications: AccessComplication[];
  destinationNote?: string;
};

/** Stav reálneho poskytnutia náhradného vozidla (P-11). Chýbajúca hodnota = zatiaľ nerozhodnuté. */
export type ReplacementVehicleProvisionStatus = "provided" | "not_provided" | "pending";

/** Kategória požadovaného náhradného vozidla (P-03). */
export type ReplacementVehicleCategory = "small_car" | "wagon" | "suv" | "van";

/** Nárok zákazníka na pristavenie náhradného vozidla (P-03). */
export type ReplacementVehicleEntitlement = "yes" | "no" | "unverified";

export type ReplacementVehicleRequest = {
  needed: boolean;
  requestedType?: string;
  preferences: ReplacementVehiclePreference[];
  note?: string;
  category?: ReplacementVehicleCategory;
  deliveryPlace?: string;
  entitlement?: ReplacementVehicleEntitlement;
  extensionPossible?: boolean;
  maxDays?: number;
  provisionStatus?: ReplacementVehicleProvisionStatus;
  provisionReason?: string;
};

export type CaseAttachmentMetadata = {
  id: string;
  category: CaseAttachmentCategory;
  fileName: string;
  storageBucket?: string;
  storagePath?: string;
  mimeType?: string;
  sizeBytes?: number;
  note?: string;
  createdAt: string;
};

export type PaymentDetails = {
  method?: PaymentMethod;
  status?: PaymentStatus;
};

export type ClosureDetails = {
  type?: ClosureType;
  status?: string;
  insurancePortalUrl?: string;
  note?: string;
  closedAt?: string;
};

export type Operator = {
  id: string;
  name: string;
  extension: string;
  status: OperatorStatus;
};

export type AccessUser = {
  id: string;
  name: string;
  email?: string;
  role: AppRole;
  extension?: string;
  active: boolean;
  accessStatus: AccessStatus;
  userId?: string;
  invitedAt?: string;
  inviteLastSentAt?: string;
  passwordSetAt?: string;
  accessDisabledAt?: string;
  lastSignInAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AttendanceShiftTemplate = {
  id: string;
  label: string;
  kind: AttendanceShiftTemplateKind;
  startsAtLocal?: string;
  endsAtLocal?: string;
  plannedMinutes?: number;
  color: string;
  active: boolean;
};

export type AttendanceSession = {
  id: string;
  profileId: string;
  operatorName: string;
  shiftId?: string;
  status: AttendanceSessionStatus;
  source: AttendanceSessionSource;
  startedAt: string;
  endedAt?: string;
  notes?: string;
};

export type AttendanceShift = {
  id: string;
  profileId: string;
  operatorName: string;
  operatorExtension: string;
  templateId?: string;
  templateLabel?: string;
  status: AttendanceShiftStatus;
  dateLocal: string;
  timezone: string;
  plannedStartAt: string;
  plannedEndAt: string;
  publishedAt?: string;
  confirmedAt?: string;
  declinedAt?: string;
  confirmationNote?: string;
  notes?: string;
  scheduleBatchId?: string;
  batchCreatedOrder?: number;
  actualStartAt?: string;
  actualEndAt?: string;
  sessionStatus?: AttendanceSessionStatus;
};

export type AttendanceEmployeeSettings = {
  id: string;
  profileId: string;
  operatorName: string;
  operatorExtension: string;
  defaultAvailable: boolean;
  active: boolean;
  vacationDaysPerYear: number;
  maxWeeklyMinutes?: number;
  notes?: string;
};

export type AttendanceUnavailabilityRequest = {
  id: string;
  profileId: string;
  operatorName: string;
  type: AttendanceRequestType;
  status: AttendanceRequestStatus;
  startDateLocal: string;
  endDateLocal: string;
  startTimeLocal?: string;
  endTimeLocal?: string;
  reason?: string;
  decisionNote?: string;
  decidedAt?: string;
  decidedByName?: string;
  createdAt: string;
  updatedAt: string;
};

export type AttendanceTimeOffBalance = {
  id: string;
  profileId: string;
  operatorName: string;
  year: number;
  vacationDaysTotal: number;
  vacationDaysUsed: number;
  vacationDaysPending: number;
  vacationDaysRemaining: number;
  carriedOverDays: number;
};

export type AttendanceScheduleBatch = {
  id: string;
  name: string;
  status: AttendanceScheduleBatchStatus;
  shiftMode: AttendanceShiftTemplateKind;
  dateFromLocal: string;
  dateToLocal: string;
  notes?: string;
  createdAt: string;
  publishedAt?: string;
};

export type AttendancePlanningWarning = {
  id: string;
  dateLocal: string;
  profileId: string;
  operatorName: string;
  code: AttendancePlanningWarningCode;
  label: string;
  severity: Exclude<AttendanceAvailabilityLevel, "available">;
  requestId?: string;
  shiftId?: string;
};

export type AttendanceAvailabilityStatus = {
  dateLocal: string;
  profileId: string;
  operatorName: string;
  status: AttendanceAvailabilityLevel;
  plannedMinutesInMonth: number;
  reasons: AttendancePlanningWarning[];
};

export type AttendanceCoverageGap = {
  id: string;
  dateLocal: string;
  startMinute: number;
  endMinute: number;
  label: string;
};

export type AttendanceDaySummary = {
  dateLocal: string;
  isToday: boolean;
  shifts: AttendanceShift[];
  gaps: AttendanceCoverageGap[];
  status: "covered" | "pending" | "gap";
  plannedCount: number;
  confirmedCount: number;
  pendingCount: number;
};

export type AttendanceData = {
  timezone: string;
  monthStart: string;
  templates: AttendanceShiftTemplate[];
  shifts: AttendanceShift[];
  sessions: AttendanceSession[];
  employeeSettings: AttendanceEmployeeSettings[];
  unavailabilityRequests: AttendanceUnavailabilityRequest[];
  timeOffBalances: AttendanceTimeOffBalance[];
  scheduleBatches: AttendanceScheduleBatch[];
  availabilityByDate: Record<string, AttendanceAvailabilityStatus[]>;
  planningWarnings: AttendancePlanningWarning[];
  days: AttendanceDaySummary[];
};

export type Branch = {
  id: string;
  name: string;
  address: string;
  phone: string;
  point: GeoPoint;
  /** Manuálne zadaný počet náhradných vozidiel (DB motorist_branches.available_replacement_cars). */
  availableReplacementCars: number;
  /** Živý počet voľných náhradných vozidiel zo SWHouse (client-side hydration); null = nedostupné. */
  liveReplacementCars?: number | null;
  /** Zdroj zobrazeného počtu náhradných vozidiel. */
  replacementCarsSource?: "swhouse" | "manual";
};

export type PartnerDirectoryEntry = {
  id: string;
  kind: PartnerDirectoryKind;
  name: string;
  ico?: string;
  phone?: string;
  email?: string;
  active: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type FleetAsset = {
  vehicleLookup?: import("@/lib/vehicle-lookup").VehicleLookupSnapshot;
  id: string;
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
  point: GeoPoint;
  lastSeen: string;
  /** false = no measured/manual vehicle location; never plot a branch fallback as GPS. */
  positionKnown?: boolean;
  gps?: {
    source: FleetLocationSource | string;
    externalId?: string;
    positionTime?: string;
    syncedAt?: string;
    speedKph?: number;
    headingDegrees?: number;
    ignitionOn?: boolean;
    odometerKm?: number;
    details?: Record<string, string | number | boolean | null>;
    stale: boolean;
    staleAfterMinutes: number;
  };
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
  capabilities: TowCapability[];
  /** true = auto má potvrdený link na SWHouse (client_vehicle_db) = je zo zdroja pravdy. false = „duch" (len Commander). */
  swhouseLinked?: boolean;
  /** Local dispatch status is separate from the SWHouse occupancy overlay. */
  internalStatus?: FleetAssetStatus;
  availabilityVerified?: boolean;
  /** Overená SWHouse obsadenosť z posledného occupancy snapshotu (len pre náhradné vozidlá). */
  occupancy?: FleetAssetOccupancy;
  swhouse?: {
    carId: string;
    branchName?: string;
    color?: string;
    ownerType?: string;
    rentTo?: string;
    checkedAt?: string;
    /** First uninterrupted observation, NOT the actual start of a rental. */
    observedSince?: string;
    details: Record<string, string | number | boolean | null>;
  };
};

export type PriceRule = {
  id: string;
  name: string;
  sourceType: "samoplatca" | "avp" | "europe" | "partner";
  baseFee: number;
  pricePerKm: number;
  minimumPrice: number;
  vatRate: number;
};

export type CaseTask = {
  id: string;
  caseId: string;
  title: string;
  assignedTo: string;
  dueAt: string;
  status: "open" | "done" | "overdue";
  priority: CasePriority;
  kind: CaseTaskKind;
  createdBy?: string;
  completedBy?: string;
  completedAt?: string;
};

export type TaskReminder = {
  id: string;
  caseId: string;
  taskId: string;
  recipientProfileId?: string;
  visibility: NotificationVisibility;
  channels: TaskReminderChannel[];
  scheduledFor: string;
  status: TaskReminderStatus;
  dedupeKey: string;
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type DispatchNotification = {
  id: string;
  caseId?: string;
  taskId?: string;
  reminderId?: string;
  recipientProfileId?: string;
  visibility: NotificationVisibility;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  status: NotificationStatus;
  deliveryStatus: NotificationDeliveryStatus;
  dedupeKey: string;
  snoozedUntil?: string;
  readAt?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type TimelineEvent = {
  id: string;
  caseId: string;
  time: string;
  actor: string;
  title: string;
  body: string;
  /** Pôvodné event_type z motorist_case_events; umožňuje filtrovať poznámky a aktivity (P-01, P-02). */
  type?: string;
};

export type DispatchCall = {
  id: string;
  status: CallStatus;
  callerNumber: string;
  callerName?: string;
  calledNumber: string;
  receivedNumber?: string;
  destinationNumber?: string;
  lineId?: string;
  lineLabel: string;
  queueLabel?: string;
  startedAt: string;
  waitSeconds: number;
  caseId?: string;
  history: string[];
};

export type DispatchCase = {
  id: string;
  caseNumber: string;
  status: CaseStatus;
  priority: CasePriority;
  sourceType?: "client" | "assistance" | "samoplatca" | "partner" | "internal";
  caseType?: string;
  jobTypes: JobType[];
  ownerId: string;
  ownerName?: string;
  contact: Contact;
  customerDetails: CustomerDetails;
  vehicle: Vehicle;
  incidentDetails: IncidentDetails;
  pickup?: DispatchLocation;
  destination?: DispatchLocation;
  customerSharedLocation?: CustomerSharedLocation;
  locationDetails: CaseLocationDetails;
  replacementVehicle: ReplacementVehicleRequest;
  attachments: CaseAttachmentMetadata[];
  paymentDetails: PaymentDetails;
  closureDetails: ClosureDetails;
  branchId?: string;
  selectedAssetId?: string;
  priceRuleId?: string;
  summary: string;
  mainNote: string;
  createdAt: string;
  updatedAt: string;
  nextStep: string;
  tasks: CaseTask[];
  timeline: TimelineEvent[];
};

export type DispatchMetrics = {
  totalCalls: number;
  answeredCalls: number;
  missedCalls: number;
  newCases: number;
  openTasks: number;
  futileTrips: number;
  answerRate: number;
  serviceLevel: number;
};
