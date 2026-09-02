import type {
  AccessUser,
  AttendanceData,
  Branch,
  DispatchCall,
  DispatchCase,
  DispatchMetrics,
  DispatchNotification,
  FleetAsset,
  Operator,
  PartnerDirectoryEntry,
  PriceRule,
} from "@/domain/types";

export type DispatchDataSource = "supabase" | "mock";

export type IntegrationConnection = {
  provider: "telnyx" | "telnyx_sms" | "google_maps" | "fleet" | "ai" | "commander" | "client_vehicle_db";
  enabled: boolean;
  status: "not_configured" | "configured" | "live" | "degraded" | "disabled";
  enabledFeatures: string[];
  baseUrl?: string;
  secretRef?: string;
  secretConfigured: boolean;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
};

export type FleetProviderVehicle = {
  id: string;
  provider: "webdispecink" | string;
  externalId: string;
  label?: string;
  licensePlate?: string;
  driverName?: string;
  online?: boolean;
  disabled?: boolean;
  linkedAssetId?: string;
  latestPositionAt?: string;
  lastCatalogSyncAt?: string;
  lastPositionSyncAt?: string;
  speedKph?: number;
  updatedAt: string;
};

export type CommanderVehicleConnection = {
  id: string;
  sourceVehicleId: string;
  label?: string;
  licensePlate?: string;
  vin?: string;
  make?: string;
  model?: string;
  kindHint?: "tow_truck" | "replacement_car";
  sourceActive: boolean;
  sourceDeletedAt?: string;
  lastSeenAt?: string;
  lastImportedAt: string;
  position?: {
    lat: number;
    lng: number;
    gpsTime: string;
    receivedAt: string;
    speedKph?: number;
    headingDegrees?: number;
    stale: boolean;
    staleAfterMinutes: number;
  };
  link?: {
    id: string;
    fleetAssetId?: string;
    status: "candidate" | "confirmed" | "rejected";
    matchMethod: "vin" | "license_plate" | "manual" | "existing_external_id";
    confidence: number;
    confirmedAt?: string;
    rejectedAt?: string;
  };
};

export type CallOutcome = "reached" | "not_reached" | "callback" | "informational" | "bad_contact" | "case_created";

export type CallerMatch = {
  id: string;
  type: "open_case" | "recent_case" | "contact" | "previous_call";
  label: string;
  subtitle?: string;
  phone?: string;
  caseId?: string;
  caseNumber?: string;
  contactId?: string;
  callId?: string;
  status?: string;
  updatedAt?: string;
  confidence: "high" | "medium" | "low";
};

export type CallCenterCall = {
  id: string;
  providerCallId?: string;
  /** Provider-side session/conversation id that groups the legs of one call. */
  providerSessionId?: string;
  status: "incoming" | "ringing_agent" | "answered" | "missed" | "abandoned_queue" | "outbound" | "ended" | "failed";
  direction: "inbound" | "outbound" | "internal";
  callerNumber: string;
  callerName?: string;
  calledNumber: string;
  receivedNumber?: string;
  destinationNumber?: string;
  operatorId?: string;
  lineId?: string;
  lineLabel: string;
  queueLabel?: string;
  operatorName?: string;
  caseId?: string;
  caseNumber?: string;
  createdAt?: string;
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  waitSeconds: number;
  durationSeconds?: number;
  recordingStatus: "not_requested" | "pending" | "available" | "failed" | "deleted";
  recordingId?: string;
  transcriptStatus: "not_requested" | "pending" | "complete" | "failed";
  summary?: string;
  outcome?: CallOutcome;
  outcomeNote?: string;
  callbackMinutes?: number;
  history: string[];
};

export type DispatchData = {
  attendance: AttendanceData;
  users: AccessUser[];
  operators: Operator[];
  branches: Branch[];
  partnerDirectory: PartnerDirectoryEntry[];
  fleetAssets: FleetAsset[];
  fleetProviderVehicles: FleetProviderVehicle[];
  commanderVehicles: CommanderVehicleConnection[];
  priceRules: PriceRule[];
  incomingCall: DispatchCall;
  callCenterCalls: CallCenterCall[];
  dispatchCases: DispatchCase[];
  notifications: DispatchNotification[];
  metrics: DispatchMetrics;
  integrations: IntegrationConnection[];
  /** Posledný úspešný Commander positions/full beh; oddelené od hodinového katalógu. */
  commanderGpsLastSuccessAt?: string;
  commanderGpsLatestRunAt?: string;
  commanderGpsLatestStatus?: "running" | "success" | "partial" | "failed";
  source: DispatchDataSource;
  warning?: string;
};
