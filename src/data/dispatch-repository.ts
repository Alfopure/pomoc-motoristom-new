import "server-only";

import { isWorkplaceTakeoverPayload } from "@/lib/telephony/workplace-takeover";

import type {
  AccessComplication,
  AccessUser,
  AttendanceEmployeeSettings,
  AttendanceSession,
  AttendanceShift,
  AttendanceScheduleBatch,
  AttendanceShiftTemplate,
  AttendanceTimeOffBalance,
  AttendanceUnavailabilityRequest,
  Branch,
  CallStatus,
  CaseAttachmentMetadata,
  CaseLocationDetails,
  CasePriority,
  CaseStatus,
  CaseTaskKind,
  ClientVehicleType,
  ClosureDetails,
  Contact,
  CustomerContact,
  CustomerContactRole,
  CustomerDetails,
  DamageArea,
  DispatchCall,
  DispatchCase,
  DispatchLocation,
  DispatchNotification,
  IncidentDetails,
  JobType,
  PaymentDetails,
  ReplacementVehiclePreference,
  ReplacementVehicleRequest,
  FleetAsset,
  FleetAssetKind,
  GeoPoint,
  Operator,
  PartnerDirectoryEntry,
  Vehicle,
  VehicleConditionFlag,
  VehicleTransmission,
} from "@/domain/types";
import { compareNotifications } from "@/domain/notifications";
import { isTaskOpen } from "@/domain/tasks";
import {
  canonicalCaseProblemDescription,
  defaultAttachments,
  defaultClosureDetails,
  defaultCustomerDetails,
  defaultIncidentDetails,
  defaultLocationDetails,
  defaultPaymentDetails,
  defaultReplacementVehicleRequest,
  legacyVehicleProblemDescription,
  requiresTowDestination,
} from "@/domain/case-card";
import { buildAttendanceOverview } from "@/lib/attendance";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { getSupabaseServiceEnv } from "@/lib/supabase/env";
import {
  branches as mockBranches,
  attendance as mockAttendance,
  callCenterCalls as mockCallCenterCalls,
  dispatchCases as mockDispatchCases,
  fleetAssets as mockFleetAssets,
  incomingCall as mockIncomingCall,
  integrations as mockIntegrations,
  metrics as mockMetrics,
  notifications as mockNotifications,
  operators as mockOperators,
  priceRules as mockPriceRules,
  telephonyStats as mockTelephonyStats,
} from "@/mock/seed";
import {
  deriveReplacementOccupancy,
  loadLatestOccupancySnapshot,
  type OccupancySnapshot,
} from "@/server/integrations/swhouse/occupancy-snapshot";
import {
  buildViptelLineCatalog,
  resolveViptelLineIdentity,
} from "@/server/telephony/viptel-line-catalog";
import type { CallCenterCall, CallOutcome, CommanderVehicleConnection, DispatchData, FleetProviderVehicle, IntegrationConnection } from "./dispatch-types";
import { deriveEffectiveIntegrationStatus } from "./integration-status";

type Tables = Database["public"]["Tables"];
type Row<TableName extends keyof Tables> = Tables[TableName]["Row"];
type OrganizationRow = Row<"motorist_organizations">;
type OrganizationProfileRow = Row<"motorist_organization_profiles">;
type OrganizationIntegrationRow = Row<"motorist_organization_integrations">;
type ProfileRow = Row<"motorist_profiles">;
type OperatorStatusRow = Row<"motorist_operator_statuses">;
type AttendanceShiftTemplateRow = Row<"motorist_attendance_shift_templates">;
type AttendanceShiftRow = Row<"motorist_attendance_shifts">;
type AttendanceSessionRow = Row<"motorist_attendance_sessions">;
type AttendanceEmployeeSettingsRow = Row<"motorist_attendance_employee_settings">;
type AttendanceUnavailabilityRequestRow = Row<"motorist_attendance_unavailability_requests">;
type AttendanceTimeOffBalanceRow = Row<"motorist_attendance_time_off_balances">;
type AttendanceScheduleBatchRow = Row<"motorist_attendance_schedule_batches">;
type LineRow = Row<"motorist_telephony_lines">;
type QueueRow = Row<"motorist_telephony_queues">;
type TelephonyExtensionRow = Row<"motorist_telephony_extensions">;
type ContactRow = Row<"motorist_contacts">;
type VehicleRow = Row<"motorist_vehicles">;
type LocationRow = Row<"motorist_locations">;
type LocationSubmissionRow = Row<"motorist_location_submissions">;
type BranchRow = Row<"motorist_branches">;
type FleetAssetRow = Row<"motorist_fleet_assets">;
type FleetProviderVehicleRow = Row<"motorist_fleet_provider_vehicles">;
type ExternalVehicleRecordRow = Row<"motorist_external_vehicle_records">;
type FleetAssetLinkRow = Row<"motorist_fleet_asset_links">;
type FleetCurrentPositionRow = Row<"motorist_fleet_current_positions">;
type PartnerDirectoryRow = Row<"motorist_partner_directory">;
type CaseRow = Row<"motorist_cases">;
type CaseTaskRow = Row<"motorist_case_tasks">;
type NotificationRow = Row<"motorist_notifications">;
type CaseEventRow = Row<"motorist_case_events">;
type CallRow = Row<"motorist_calls">;
type CallEventRow = Row<"motorist_call_events">;
type JsonRecord = Record<string, unknown>;
type AuthUserSummary = {
  id: string;
  email?: string;
  last_sign_in_at?: string;
};

const DEFAULT_ORGANIZATION_SLUG = "pomoc-motoristom";
const DEFAULT_SUPABASE_READ_TIMEOUT_MS = 10_000;
const GPS_STALE_AFTER_MINUTES = 10;

export function getMockDispatchData(warning?: string): DispatchData {
  const now = new Date().toISOString();

  return {
    attendance: mockAttendance,
    users: mockOperators.map((operator) => ({
      id: operator.id,
      name: operator.name,
      role: "dispatcher",
      extension: operator.extension,
      active: true,
      accessStatus: "not_invited",
      createdAt: now,
      updatedAt: now,
    })),
    operators: mockOperators,
    branches: mockBranches,
    partnerDirectory: [],
    fleetAssets: mockFleetAssets,
    fleetProviderVehicles: [],
    commanderVehicles: [],
    priceRules: mockPriceRules,
    incomingCall: mockIncomingCall,
    callCenterCalls: mockCallCenterCalls,
    dispatchCases: mockDispatchCases,
    notifications: mockNotifications,
    metrics: mockMetrics,
    integrations: mockIntegrations,
    commanderGpsLastSuccessAt: mockIntegrations.find((integration) => integration.provider === "commander")?.lastSuccessAt,
    commanderGpsLatestRunAt: mockIntegrations.find((integration) => integration.provider === "commander")?.lastSuccessAt,
    commanderGpsLatestStatus: "success",
    telephonyStats: mockTelephonyStats,
    source: "mock",
    warning,
  };
}

export async function loadDispatchData(): Promise<DispatchData> {
  if (!getSupabaseServiceEnv()) {
    return mockDispatchDataOrThrow(
      "Supabase server env nie je nastavený. Beží mock fallback.",
      "Supabase server env nie je nastavený.",
    );
  }

  try {
    return await withTimeout(loadSupabaseDispatchData(), getSupabaseReadTimeout());
  } catch (error) {
    console.warn("Supabase dispatch data fallback:", getErrorMessage(error));
    return mockDispatchDataOrThrow(
      "Supabase čítanie zlyhalo. Beží mock fallback.",
      "Supabase čítanie zlyhalo. Obnov stránku alebo kontaktuj správcu; testovacie dáta sa v produkcii nepoužijú.",
    );
  }
}

async function loadSupabaseDispatchData(): Promise<DispatchData> {
  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);

  if (!organization) {
    return mockDispatchDataOrThrow(
      "V Supabase sa nenašla aktívna organizácia pre demo.",
      "V Supabase sa nenašla aktívna organizácia.",
    );
  }

  const organizationId = organization.id;
  const [
    organizationProfilesResult,
    profilesResult,
    accessProfilesResult,
    statusesResult,
    attendanceTemplatesResult,
    attendanceShiftsResult,
    attendanceSessionsResult,
    attendanceEmployeeSettingsResult,
    attendanceRequestsResult,
    attendanceBalancesResult,
    attendanceScheduleBatchesResult,
    linesResult,
    queuesResult,
    telephonyExtensionsResult,
    contactsResult,
    vehiclesResult,
    locationsResult,
    locationSubmissionsResult,
    branchesResult,
    partnerDirectoryResult,
    fleetAssetsResult,
    fleetProviderVehiclesResult,
    commanderVehiclesResult,
    commanderLinksResult,
    commanderPositionsResult,
    casesResult,
    tasksResult,
    notificationsResult,
    caseEventsResult,
    callsResult,
    callEventsResult,
    integrationsResult,
    commanderGpsSyncResult,
    commanderGpsLatestRunResult,
    rawEventsResult,
    commandsResult,
    queueMembershipsResult,
    queueSnapshotsResult,
    transcriptsResult,
    recordingsResult,
  ] = await Promise.all([
    supabase.from("motorist_organization_profiles").select("*").eq("organization_id", organizationId).limit(1),
    supabase.from("motorist_profiles").select("*").eq("organization_id", organizationId).eq("active", true).order("display_name"),
    supabase.from("motorist_profiles").select("*").eq("organization_id", organizationId).order("display_name"),
    supabase.from("motorist_operator_statuses").select("*").eq("organization_id", organizationId).order("started_at", { ascending: false }),
    supabase.from("motorist_attendance_shift_templates").select("*").eq("organization_id", organizationId).eq("active", true).order("sort_order"),
    supabase.from("motorist_attendance_shifts").select("*").eq("organization_id", organizationId).order("planned_start_at", { ascending: true }).limit(200),
    supabase.from("motorist_attendance_sessions").select("*").eq("organization_id", organizationId).order("started_at", { ascending: false }).limit(200),
    supabase.from("motorist_attendance_employee_settings").select("*").eq("organization_id", organizationId).order("created_at"),
    supabase.from("motorist_attendance_unavailability_requests").select("*").eq("organization_id", organizationId).order("start_date_local", { ascending: true }).limit(200),
    supabase.from("motorist_attendance_time_off_balances").select("*").eq("organization_id", organizationId).order("year", { ascending: false }),
    supabase.from("motorist_attendance_schedule_batches").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(50),
    supabase.from("motorist_telephony_lines").select("*").eq("organization_id", organizationId).eq("active", true).order("label"),
    supabase.from("motorist_telephony_queues").select("*").eq("organization_id", organizationId).eq("active", true).order("label"),
    supabase
      .from("motorist_telephony_extensions")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("provider", "viptel")
      .eq("active", true)
      .order("extension"),
    supabase.from("motorist_contacts").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),
    supabase.from("motorist_vehicles").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),
    supabase.from("motorist_locations").select("*").eq("organization_id", organizationId),
    supabase
      .from("motorist_location_submissions")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("accepted", true)
      .order("submitted_at", { ascending: false }),
    supabase.from("motorist_branches").select("*").eq("organization_id", organizationId).eq("active", true).order("name"),
    supabase.from("motorist_partner_directory").select("*").eq("organization_id", organizationId).order("kind").order("name"),
    supabase.from("motorist_fleet_assets").select("*").eq("organization_id", organizationId).order("label"),
    supabase.from("motorist_fleet_provider_vehicles").select("*").eq("organization_id", organizationId).eq("provider", "webdispecink").order("updated_at", { ascending: false }),
    supabase
      .from("motorist_external_vehicle_records")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("source_provider", "commander")
      .order("label", { ascending: true, nullsFirst: false }),
    supabase.from("motorist_fleet_asset_links").select("*").eq("organization_id", organizationId).eq("source_provider", "commander"),
    supabase.from("motorist_fleet_current_positions").select("*").eq("organization_id", organizationId).eq("source_provider", "commander"),
    supabase.from("motorist_cases").select("*").eq("organization_id", organizationId).order("updated_at", { ascending: false }),
    supabase.from("motorist_case_tasks").select("*").eq("organization_id", organizationId).order("due_at", { ascending: true }),
    supabase
      .from("motorist_notifications")
      .select("*")
      .eq("organization_id", organizationId)
      .neq("status", "archived")
      .not("dedupe_key", "like", "workplace-takeover:%")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("motorist_case_events").select("*").eq("organization_id", organizationId).order("created_at", { ascending: true }),
    supabase.from("motorist_calls").select("*").eq("organization_id", organizationId).order("started_at", { ascending: false }).limit(25),
    supabase.from("motorist_call_events").select("*").eq("organization_id", organizationId).order("created_at", { ascending: true }).limit(100),
    supabase.from("motorist_organization_integrations").select("*").eq("organization_id", organizationId).order("provider"),
    supabase
      .from("motorist_fleet_sync_runs")
      .select("finished_at")
      .eq("organization_id", organizationId)
      .eq("provider", "commander")
      .in("mode", ["positions", "full"])
      .eq("status", "success")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("motorist_fleet_sync_runs")
      .select("started_at,finished_at,status")
      .eq("organization_id", organizationId)
      .eq("provider", "commander")
      .in("mode", ["positions", "full"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("motorist_integration_raw_events").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase.from("motorist_telephony_commands").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase.from("motorist_queue_memberships").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase.from("motorist_queue_snapshots").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase.from("motorist_call_transcripts").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase
      .from("motorist_call_recordings")
      .select("id, call_id, created_at")
      .eq("organization_id", organizationId)
      .eq("status", "available")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  [
    { label: "motorist_organization_profiles", result: organizationProfilesResult },
    { label: "motorist_profiles.active", result: profilesResult },
    { label: "motorist_profiles.access", result: accessProfilesResult },
    { label: "motorist_contacts", result: contactsResult },
    { label: "motorist_vehicles", result: vehiclesResult },
    { label: "motorist_locations", result: locationsResult },
    { label: "motorist_branches", result: branchesResult },
    { label: "motorist_fleet_assets", result: fleetAssetsResult },
    { label: "motorist_cases", result: casesResult },
    { label: "motorist_case_tasks", result: tasksResult },
  ].forEach(({ label, result }) => throwOnSupabaseError(result, label));

  [
    { label: "motorist_operator_statuses", result: statusesResult },
    { label: "motorist_attendance_shift_templates", result: attendanceTemplatesResult },
    { label: "motorist_attendance_shifts", result: attendanceShiftsResult },
    { label: "motorist_attendance_sessions", result: attendanceSessionsResult },
    { label: "motorist_attendance_employee_settings", result: attendanceEmployeeSettingsResult },
    { label: "motorist_attendance_unavailability_requests", result: attendanceRequestsResult },
    { label: "motorist_attendance_time_off_balances", result: attendanceBalancesResult },
    { label: "motorist_attendance_schedule_batches", result: attendanceScheduleBatchesResult },
    { label: "motorist_telephony_lines", result: linesResult },
    { label: "motorist_telephony_queues", result: queuesResult },
    { label: "motorist_telephony_extensions", result: telephonyExtensionsResult },
    { label: "motorist_location_submissions", result: locationSubmissionsResult },
    { label: "motorist_partner_directory", result: partnerDirectoryResult },
    { label: "motorist_fleet_provider_vehicles", result: fleetProviderVehiclesResult },
    { label: "motorist_external_vehicle_records.commander", result: commanderVehiclesResult },
    { label: "motorist_fleet_asset_links.commander", result: commanderLinksResult },
    { label: "motorist_fleet_current_positions.commander", result: commanderPositionsResult },
    { label: "motorist_notifications", result: notificationsResult },
    { label: "motorist_case_events", result: caseEventsResult },
    { label: "motorist_calls", result: callsResult },
    { label: "motorist_call_events", result: callEventsResult },
    { label: "motorist_organization_integrations", result: integrationsResult },
    { label: "motorist_fleet_sync_runs.commander_gps", result: commanderGpsSyncResult },
    { label: "motorist_fleet_sync_runs.commander_gps_latest", result: commanderGpsLatestRunResult },
    { label: "motorist_integration_raw_events.count", result: rawEventsResult },
    { label: "motorist_telephony_commands.count", result: commandsResult },
    { label: "motorist_queue_memberships.count", result: queueMembershipsResult },
    { label: "motorist_queue_snapshots.count", result: queueSnapshotsResult },
    { label: "motorist_call_transcripts.count", result: transcriptsResult },
    { label: "motorist_call_recordings", result: recordingsResult },
  ].forEach(({ label, result }) => warnOnOptionalSupabaseError(result, label));

  const organizationProfile = organizationProfilesResult.data?.[0] ?? null;
  const defaultPhone = organizationProfile?.primary_phone ?? mockIncomingCall.calledNumber;
  const locations = locationsResult.data ?? [];
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const latestLocationSubmissionByCaseId = latestAcceptedLocationSubmissions(locationSubmissionsResult.error ? [] : (locationSubmissionsResult.data ?? []));
  const branches = (branchesResult.data ?? []).map((branch) => mapBranch(branch, locationById, defaultPhone));
  const partnerDirectory = (partnerDirectoryResult.error ? [] : (partnerDirectoryResult.data ?? [])).map(mapPartnerDirectoryEntry);
  const fleetProviderVehicles = (fleetProviderVehiclesResult.error ? [] : (fleetProviderVehiclesResult.data ?? [])).map(mapFleetProviderVehicle);
  const commanderPositions = commanderPositionsResult.error ? [] : (commanderPositionsResult.data ?? []);

  const commanderPositionByFleetAssetId = latestCommanderPositionByFleetAssetId(commanderPositions);
  // Potvrdené SWHouse (client_vehicle_db) linky → ktoré autá sú zo zdroja pravdy vs „duchovia".
  const swhouseLinksResult = await supabase
    .from("motorist_fleet_asset_links")
    .select("fleet_asset_id")
    .eq("organization_id", organizationId)
    .eq("source_provider", "client_vehicle_db")
    .eq("link_status", "confirmed");
  const swhouseLinkedAssetIds = new Set((swhouseLinksResult.data ?? []).map((link) => link.fleet_asset_id));
  // T2: SWHouse je jediný zdroj pravdy o obsadenosti — najnovší snapshot čítame RAZ a odvodíme per-asset occupancy.
  const occupancySnapshot = await loadLatestOccupancySnapshot(supabase, organizationId);
  const fleetAssets = (fleetAssetsResult.data ?? []).map((asset) =>
    mapFleetAsset(asset, locationById, branches, commanderPositionByFleetAssetId.get(asset.id), swhouseLinkedAssetIds.has(asset.id), occupancySnapshot),
  );

  const latestStatusByProfile = latestOperatorStatuses(statusesResult.data ?? []);
  const profiles = profilesResult.data ?? [];
  const extensionByProfileId = primaryExtensionByProfile(telephonyExtensionsResult.data ?? []);
  const operators = profiles.map((profile) => mapOperator(profile, latestStatusByProfile.get(profile.id), extensionByProfileId.get(profile.id)));
  const accessProfiles = accessProfilesResult.data ?? [];
  const authUsersById = await loadAuthUsersById(
    supabase,
    accessProfiles.map((profile) => profile.user_id).filter((userId): userId is string => Boolean(userId)),
  );
  const users = accessProfiles.map((profile) => mapAccessUser(profile, authUsersById.get(profile.user_id ?? ""), extensionByProfileId.get(profile.id)));
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const attendanceTemplates = (attendanceTemplatesResult.data ?? []).map(mapAttendanceTemplate);
  const attendanceSessions = (attendanceSessionsResult.data ?? []).map((session) => mapAttendanceSession(session, profilesById));
  const sessionsByShiftId = latestAttendanceSessionsByShift(attendanceSessions);
  const attendanceShifts = (attendanceShiftsResult.data ?? []).map((shift) =>
    mapAttendanceShift(shift, profilesById, attendanceTemplates, extensionByProfileId, sessionsByShiftId.get(shift.id)),
  );
  const attendanceEmployeeSettings = (attendanceEmployeeSettingsResult.error ? [] : (attendanceEmployeeSettingsResult.data ?? [])).map((setting) =>
    mapAttendanceEmployeeSettings(setting, profilesById, extensionByProfileId),
  );
  const attendanceRequests = (attendanceRequestsResult.error ? [] : (attendanceRequestsResult.data ?? [])).map((request) => mapAttendanceRequest(request, profilesById));
  const attendanceBalances = (attendanceBalancesResult.error ? [] : (attendanceBalancesResult.data ?? [])).map((balance) => mapAttendanceBalance(balance, profilesById));
  const attendanceScheduleBatches = (attendanceScheduleBatchesResult.error ? [] : (attendanceScheduleBatchesResult.data ?? [])).map(mapAttendanceScheduleBatch);
  const contactsById = new Map((contactsResult.data ?? []).map((contact) => [contact.id, contact]));
  const vehiclesById = new Map((vehiclesResult.data ?? []).map((vehicle) => [vehicle.id, vehicle]));
  const tasksByCaseId = groupByCaseId(tasksResult.data ?? []);
  const eventsByCaseId = groupByCaseId(caseEventsResult.data ?? []);
  const dispatchCases = (casesResult.data ?? []).map((caseRow) =>
    mapCase({
      caseRow,
      contactsById,
      vehiclesById,
      locationById,
      customerLocationSubmission: latestLocationSubmissionByCaseId.get(caseRow.id),
      tasks: tasksByCaseId.get(caseRow.id) ?? [],
      events: eventsByCaseId.get(caseRow.id) ?? [],
      profilesById,
    }),
  );

  const linesById = new Map((linesResult.data ?? []).map((line) => [line.id, line]));
  const queuesById = new Map((queuesResult.data ?? []).map((queue) => [queue.id, queue]));
  const callEventsByCallId = groupCallEventsByCallId(callEventsResult.data ?? []);
  const calls = callsResult.data ?? [];
  const incomingCall = mapIncomingCall({
    call: calls.find((call) => call.status === "incoming" || call.status === "ringing_agent") ?? calls[0],
    organization,
    organizationProfile,
    linesById,
    callEventsByCallId,
  });
  const caseNumberById = new Map(dispatchCases.map((caseItem) => [caseItem.id, caseItem.caseNumber]));
  const notifications = (notificationsResult.data ?? [])
    .filter((notification) => !isWorkplaceTakeoverPayload(notification.payload))
    .map(mapNotification)
    .sort(compareNotifications);
  const recordingIdByCallId = new Map<string, string>();

  // recordingsResult is ordered newest-first, so the first hit per call wins.
  for (const recording of recordingsResult.data ?? []) {
    if (recording.call_id && !recordingIdByCallId.has(recording.call_id)) {
      recordingIdByCallId.set(recording.call_id, recording.id);
    }
  }

  const callCenterCalls = calls.map((call) =>
    mapCallCenterCall({
      call,
      callEvents: callEventsByCallId.get(call.id) ?? [],
      caseNumberById,
      linesById,
      profilesById,
      queuesById,
      recordingIdByCallId,
    }),
  );

  return {
    attendance: buildAttendanceOverview({
      timezone: organizationProfile?.timezone ?? "Europe/Bratislava",
      templates: attendanceTemplates,
      shifts: attendanceShifts,
      sessions: attendanceSessions,
      operators,
      employeeSettings: attendanceEmployeeSettings,
      unavailabilityRequests: attendanceRequests,
      timeOffBalances: attendanceBalances,
      scheduleBatches: attendanceScheduleBatches,
    }),
    users,
    operators,
    branches,
    partnerDirectory,
    fleetAssets,
    fleetProviderVehicles,
    commanderVehicles: mapCommanderVehicleConnections(
      commanderVehiclesResult.error ? [] : (commanderVehiclesResult.data ?? []),
      commanderLinksResult.error ? [] : (commanderLinksResult.data ?? []),
      commanderPositions,
    ),
    priceRules: mockPriceRules,
    incomingCall,
    callCenterCalls,
    dispatchCases,
    notifications,
    metrics: deriveMetrics(calls, dispatchCases),
    integrations: (integrationsResult.data ?? []).map(mapIntegrationConnection),
    commanderGpsLastSuccessAt: commanderGpsSyncResult.data?.finished_at ?? undefined,
    commanderGpsLatestRunAt:
      commanderGpsLatestRunResult.data?.finished_at ?? commanderGpsLatestRunResult.data?.started_at ?? undefined,
    commanderGpsLatestStatus: commanderGpsLatestRunResult.data?.status ?? undefined,
    telephonyStats: {
      rawEvents: rawEventsResult.count ?? 0,
      commands: commandsResult.count ?? 0,
      queueMemberships: queueMembershipsResult.count ?? 0,
      queueSnapshots: queueSnapshotsResult.count ?? 0,
      transcripts: transcriptsResult.count ?? 0,
    },
    source: "supabase",
  };
}

export async function loadDispatchNotifications(organizationId: string): Promise<DispatchNotification[]> {
  const supabase = createSupabaseAdminClient();
  const result = await supabase
    .from("motorist_notifications")
    .select("*")
    .eq("organization_id", organizationId)
    .neq("status", "archived")
    .not("dedupe_key", "like", "workplace-takeover:%")
    .order("created_at", { ascending: false })
    .limit(100);

  if (isOptionalTableSchemaMiss(result.error, "motorist_notifications")) return [];
  throwOnSupabaseError(result, "motorist_notifications");
  return (result.data ?? [])
    .filter((notification) => !isWorkplaceTakeoverPayload(notification.payload))
    .map(mapNotification)
    .sort(compareNotifications);
}

async function resolveOrganization(supabase: ReturnType<typeof createSupabaseAdminClient>): Promise<OrganizationRow | null> {
  const organizationId = process.env.MOTORIST_ORGANIZATION_ID?.trim();

  if (organizationId) {
    const result = await supabase.from("motorist_organizations").select("*").eq("id", organizationId).maybeSingle();
    throwOnSupabaseError(result);
    return result.data?.active ? result.data : null;
  }

  const organizationSlug = process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || DEFAULT_ORGANIZATION_SLUG;
  const bySlug = await supabase.from("motorist_organizations").select("*").eq("slug", organizationSlug).maybeSingle();
  throwOnSupabaseError(bySlug);

  if (bySlug.data?.active) {
    return bySlug.data;
  }

  const firstActive = await supabase.from("motorist_organizations").select("*").eq("active", true).order("created_at").limit(1).maybeSingle();
  throwOnSupabaseError(firstActive);
  return firstActive.data ?? null;
}

async function loadAuthUsersById(supabase: ReturnType<typeof createSupabaseAdminClient>, userIds: string[]) {
  const wantedIds = new Set(userIds);
  const users = new Map<string, AuthUserSummary>();

  if (wantedIds.size === 0) {
    return users;
  }

  let page = 1;
  const perPage = 1000;

  while (page <= 10 && users.size < wantedIds.size) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });

    if (error) {
      console.warn("Supabase auth users could not be loaded:", error.message);
      return users;
    }

    for (const user of data.users) {
      if (wantedIds.has(user.id)) {
        users.set(user.id, {
          id: user.id,
          email: user.email ?? undefined,
          last_sign_in_at: user.last_sign_in_at ?? undefined,
        });
      }
    }

    if (data.users.length < perPage) {
      break;
    }

    page += 1;
  }

  return users;
}

function primaryExtensionByProfile(extensions: TelephonyExtensionRow[]) {
  const result = new Map<string, string>();

  for (const extension of extensions) {
    if (extension.profile_id && !result.has(extension.profile_id)) {
      result.set(extension.profile_id, extension.extension);
    }
  }

  return result;
}

function mapOperator(profile: ProfileRow, status: OperatorStatusRow | undefined, extension: string | undefined): Operator {
  return {
    id: profile.id,
    name: profile.display_name,
    extension: extension ?? "-",
    status: status?.status ?? "offline",
  };
}

function mapAccessUser(profile: ProfileRow, authUser: AuthUserSummary | undefined, extension: string | undefined): AccessUser {
  return {
    id: profile.id,
    name: profile.display_name,
    email: profile.email ?? authUser?.email,
    role: profile.role,
    extension,
    active: profile.active,
    accessStatus: profile.access_status,
    userId: profile.user_id ?? undefined,
    invitedAt: profile.invited_at ?? undefined,
    inviteLastSentAt: profile.invite_last_sent_at ?? undefined,
    passwordSetAt: profile.password_set_at ?? undefined,
    accessDisabledAt: profile.access_disabled_at ?? undefined,
    lastSignInAt: authUser?.last_sign_in_at,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
  };
}

function mapAttendanceTemplate(row: AttendanceShiftTemplateRow): AttendanceShiftTemplate {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    startsAtLocal: row.starts_at_local?.slice(0, 5) ?? undefined,
    endsAtLocal: row.ends_at_local?.slice(0, 5) ?? undefined,
    plannedMinutes: row.planned_minutes ?? undefined,
    color: row.color,
    active: row.active,
  };
}

function mapAttendanceShift(
  row: AttendanceShiftRow,
  profilesById: Map<string, ProfileRow>,
  templates: AttendanceShiftTemplate[],
  extensionByProfileId: Map<string, string>,
  latestSession?: AttendanceSession,
): AttendanceShift {
  const profile = profilesById.get(row.profile_id);
  const template = row.template_id ? templates.find((candidate) => candidate.id === row.template_id) : undefined;

  return {
    id: row.id,
    profileId: row.profile_id,
    operatorName: profile?.display_name ?? "Neznámy operátor",
    operatorExtension: extensionByProfileId.get(row.profile_id) ?? "-",
    templateId: row.template_id ?? undefined,
    templateLabel: template?.label,
    status: row.status,
    dateLocal: row.date_local,
    timezone: row.timezone,
    plannedStartAt: row.planned_start_at,
    plannedEndAt: row.planned_end_at,
    publishedAt: row.published_at ?? undefined,
    confirmedAt: row.confirmed_at ?? undefined,
    declinedAt: row.declined_at ?? undefined,
    confirmationNote: row.confirmation_note ?? undefined,
    notes: row.notes ?? undefined,
    scheduleBatchId: row.schedule_batch_id ?? undefined,
    batchCreatedOrder: row.batch_created_order ?? undefined,
    actualStartAt: latestSession?.startedAt,
    actualEndAt: latestSession?.endedAt,
    sessionStatus: latestSession?.status,
  };
}

function mapAttendanceSession(row: AttendanceSessionRow, profilesById: Map<string, ProfileRow>): AttendanceSession {
  const profile = profilesById.get(row.profile_id);

  return {
    id: row.id,
    profileId: row.profile_id,
    operatorName: profile?.display_name ?? "Neznámy operátor",
    shiftId: row.shift_id ?? undefined,
    status: row.status,
    source: row.source,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    notes: row.notes ?? undefined,
  };
}

function mapAttendanceEmployeeSettings(
  row: AttendanceEmployeeSettingsRow,
  profilesById: Map<string, ProfileRow>,
  extensionByProfileId: Map<string, string>,
): AttendanceEmployeeSettings {
  const profile = profilesById.get(row.profile_id);

  return {
    id: row.id,
    profileId: row.profile_id,
    operatorName: profile?.display_name ?? "Neznámy operátor",
    operatorExtension: extensionByProfileId.get(row.profile_id) ?? "-",
    defaultAvailable: row.default_available,
    active: profile?.active ?? true,
    vacationDaysPerYear: row.vacation_days_per_year,
    maxWeeklyMinutes: row.max_weekly_minutes ?? undefined,
    notes: row.notes ?? undefined,
  };
}

function mapAttendanceRequest(row: AttendanceUnavailabilityRequestRow, profilesById: Map<string, ProfileRow>): AttendanceUnavailabilityRequest {
  const profile = profilesById.get(row.profile_id);
  const decider = row.decided_by ? profilesById.get(row.decided_by) : undefined;

  return {
    id: row.id,
    profileId: row.profile_id,
    operatorName: profile?.display_name ?? "Neznámy operátor",
    type: row.type,
    status: row.status,
    startDateLocal: row.start_date_local,
    endDateLocal: row.end_date_local,
    startTimeLocal: row.start_time_local?.slice(0, 5) ?? undefined,
    endTimeLocal: row.end_time_local?.slice(0, 5) ?? undefined,
    reason: row.reason ?? undefined,
    decisionNote: row.decision_note ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    decidedByName: decider?.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttendanceBalance(row: AttendanceTimeOffBalanceRow, profilesById: Map<string, ProfileRow>): AttendanceTimeOffBalance {
  const profile = profilesById.get(row.profile_id);
  const vacationDaysTotal = Number(row.vacation_days_total);
  const vacationDaysUsed = Number(row.vacation_days_used);
  const vacationDaysPending = Number(row.vacation_days_pending);
  const carriedOverDays = Number(row.carried_over_days);

  return {
    id: row.id,
    profileId: row.profile_id,
    operatorName: profile?.display_name ?? "Neznámy operátor",
    year: row.year,
    vacationDaysTotal,
    vacationDaysUsed,
    vacationDaysPending,
    vacationDaysRemaining: Math.max(0, vacationDaysTotal + carriedOverDays - vacationDaysUsed - vacationDaysPending),
    carriedOverDays,
  };
}

function mapAttendanceScheduleBatch(row: AttendanceScheduleBatchRow): AttendanceScheduleBatch {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    shiftMode: row.shift_mode,
    dateFromLocal: row.date_from_local,
    dateToLocal: row.date_to_local,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    publishedAt: row.published_at ?? undefined,
  };
}

function latestAttendanceSessionsByShift(sessions: AttendanceSession[]) {
  const latest = new Map<string, AttendanceSession>();

  sessions.forEach((session) => {
    if (!session.shiftId) {
      return;
    }

    const previous = latest.get(session.shiftId);

    if (!previous || new Date(session.startedAt).getTime() > new Date(previous.startedAt).getTime()) {
      latest.set(session.shiftId, session);
    }
  });

  return latest;
}

function mapIntegrationConnection(integration: OrganizationIntegrationRow): IntegrationConnection {
  const secretConfigured = isIntegrationSecretConfigured(integration.provider);

  return {
    provider: integration.provider,
    enabled: integration.enabled,
    status: deriveEffectiveIntegrationStatus(integration.status, secretConfigured),
    enabledFeatures: integration.enabled_features,
    baseUrl: integration.base_url ?? undefined,
    websocketUrl: integration.websocket_url ?? undefined,
    secretRef: integration.secret_ref ?? undefined,
    secretConfigured,
    lastSuccessAt: integration.last_success_at ?? undefined,
    lastErrorAt: integration.last_error_at ?? undefined,
    lastError: integration.last_error ?? undefined,
  };
}

export function mapCallCenterCall({
  call,
  callEvents,
  caseNumberById,
  linesById,
  profilesById,
  queuesById,
  recordingIdByCallId,
}: {
  call: CallRow;
  callEvents: CallEventRow[];
  caseNumberById: Map<string, string>;
  linesById: Map<string, LineRow>;
  profilesById: Map<string, ProfileRow>;
  queuesById: Map<string, QueueRow>;
  recordingIdByCallId?: Map<string, string>;
}): CallCenterCall {
  const inbound = call.direction === "inbound";
  const line = inbound && call.line_id ? linesById.get(call.line_id) : undefined;
  const lineIdentity = resolveViptelLineIdentity({
    catalog: buildViptelLineCatalog([...linesById.values()].filter((candidate) => candidate.provider === "viptel")),
    storedLineId: inbound ? call.line_id : undefined,
    storedReceivedNumber: inbound ? call.received_number : undefined,
    providerNumbers: inbound ? [call.called_number] : [],
  });
  const queue = call.queue_id ? queuesById.get(call.queue_id) : undefined;
  const operator = call.operator_id ? profilesById.get(call.operator_id) : undefined;
  const caseNumber = call.case_id ? caseNumberById.get(call.case_id) : undefined;
  const history = callEvents.map(callEventSummary);
  const latestPayload = jsonRecord(call.raw_latest_payload);
  const outcome = toCallOutcome(latestPayload.outcome);
  const status = effectivePersistedCallStatus(call);

  return {
    id: call.id,
    providerCallId: call.provider_call_id ?? undefined,
    viptelUniqueId: call.viptel_unique_id ?? undefined,
    fromQueueUniqueId: call.from_queue_unique_id ?? undefined,
    status,
    direction: call.direction,
    callerNumber: call.caller_number ?? "Neznáme číslo",
    callerName: call.caller_name ?? undefined,
    calledNumber: call.called_number ?? line?.phone_number ?? "-",
    receivedNumber: inbound ? lineIdentity.phoneNumber ?? call.received_number ?? undefined : undefined,
    destinationNumber: call.destination_number ?? undefined,
    callerExtension: call.caller_extension ?? undefined,
    receivedExtension: call.received_extension ?? undefined,
    destinationExtension: call.destination_extension ?? undefined,
    extensionId: call.extension_id ?? undefined,
    operatorId: call.operator_id ?? undefined,
    lineId: lineIdentity.lineId,
    lineLabel: lineIdentity.lineLabel,
    queueLabel: queue?.label ?? call.queue_number ?? undefined,
    operatorName: operator?.display_name ?? undefined,
    caseId: call.case_id ?? undefined,
    caseNumber,
    createdAt: call.created_at,
    startedAt: call.started_at ?? call.created_at,
    answeredAt: call.answered_at ?? undefined,
    endedAt: call.ended_at ?? undefined,
    waitSeconds: call.wait_seconds ?? 0,
    durationSeconds: call.duration_seconds ?? call.complete_duration_seconds ?? undefined,
    recordingStatus: call.recording_status,
    recordingId: recordingIdByCallId?.get(call.id),
    transcriptStatus: call.transcript_status,
    summary: call.summary ?? undefined,
    outcome,
    outcomeNote: stringValue(latestPayload.outcomeNote ?? latestPayload.outcome_note),
    callbackMinutes: numberValue(latestPayload.callbackMinutes ?? latestPayload.callback_minutes),
    history: history.length > 0 ? history : ["Hovor načítaný zo Supabase."],
  };
}

/**
 * An end timestamp is a hard terminal invariant. Besides guarding new data,
 * this prevents an already-corrupted historical row from becoming an
 * actionable call while background reconciliation repairs its stored status.
 */
function effectivePersistedCallStatus(call: CallRow): CallRow["status"] {
  if (!call.ended_at || !["incoming", "ringing_agent", "answered", "outbound"].includes(call.status)) {
    return call.status;
  }

  const reason = call.end_reason?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
  if (
    call.answered_at || (call.duration_seconds ?? 0) > 0 ||
    ["answer", "answered", "complete", "completed", "normalclearing"].includes(reason)
  ) {
    return "ended";
  }
  return call.direction === "outbound" ? "failed" : "missed";
}

function mapBranch(branch: BranchRow, locations: Map<string, LocationRow>, defaultPhone: string): Branch {
  const location = branch.location_id ? locations.get(branch.location_id) : undefined;

  return {
    id: branch.id,
    name: branch.name,
    address: branch.address,
    phone: branch.phone ?? defaultPhone,
    point: pointFromLocation(location, mockBranches[0].point),
    availableReplacementCars: branch.available_replacement_cars,
  };
}

function mapPartnerDirectoryEntry(row: PartnerDirectoryRow): PartnerDirectoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    ico: row.ico ?? undefined,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    active: row.active,
    note: stringValue(jsonRecord(row.metadata).note),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFleetAsset(
  asset: FleetAssetRow,
  locations: Map<string, LocationRow>,
  branches: Branch[],
  commanderPosition?: FleetCurrentPositionRow,
  swhouseLinked = false,
  occupancySnapshot: OccupancySnapshot | null = null,
): FleetAsset {
  const branch = branches.find((candidate) => candidate.id === asset.branch_id) ?? branches[0];
  const location = asset.current_location_id ? locations.get(asset.current_location_id) : undefined;
  const metadata = jsonRecord(asset.metadata);
  const gpsMetadata = jsonRecord(metadata.gps);
  const locationSource = asset.location_source ?? stringValue(gpsMetadata.source) ?? asset.source_system ?? undefined;
  const commanderGps = commanderPosition && asset.kind === "replacement_car" ? gpsFromCommanderPosition(commanderPosition) : undefined;
  const commanderPoint = commanderPosition && commanderGps ? { lat: Number(commanderPosition.lat), lng: Number(commanderPosition.lng) } : undefined;
  const assetGps = locationSource
    ? {
        source: locationSource,
        externalId: asset.external_id ?? stringValue(gpsMetadata.externalId) ?? stringValue(gpsMetadata.external_id),
        positionTime: asset.last_seen_at ?? stringValue(gpsMetadata.positionTime) ?? stringValue(gpsMetadata.position_time),
        syncedAt: stringValue(gpsMetadata.syncedAt) ?? stringValue(gpsMetadata.synced_at),
        speedKph: numberValue(gpsMetadata.speedKph) ?? numberValue(gpsMetadata.speed_kph),
        stale: isFleetGpsStale(asset.last_seen_at),
        staleAfterMinutes: numberValue(gpsMetadata.staleAfterMinutes) ?? 10,
      }
    : undefined;
  const gps = commanderGps ?? assetGps;

  // T2: overená obsadenosť zo SWHouse snapshotu (len náhradné vozidlá). `occupied` prepisuje status na "rented",
  // takže availabilityScore / recommend / nearest / mapa rešpektujú obsadenosť bez ďalšej zmeny.
  const occupancy = toFleetAssetKind(asset.kind) === "replacement_car" ? deriveReplacementOccupancy(occupancySnapshot, asset.license_plate) : undefined;
  const status = occupancy === "occupied" ? "rented" : asset.status;

  return {
    id: asset.id,
    kind: toFleetAssetKind(asset.kind),
    label: asset.label,
    make: asset.make ?? undefined,
    model: asset.model ?? undefined,
    licensePlate: asset.license_plate ?? "-",
    vin: asset.vin ?? undefined,
    status,
    category: asset.category ?? undefined,
    weightKg: asset.weight_kg ?? undefined,
    branchId: branch.id,
    point: commanderPoint ?? pointFromLocation(location, branch.point),
    lastSeen: gps?.positionTime ?? asset.last_seen_at ?? asset.updated_at,
    notes: asset.notes ?? undefined,
    insuranceValidUntil: asset.insurance_valid_until ?? undefined,
    highwayVignetteValidUntil: asset.highway_vignette_valid_until ?? undefined,
    technicalInspectionValidUntil: asset.technical_inspection_valid_until ?? undefined,
    emissionInspectionValidUntil: asset.emission_inspection_valid_until ?? undefined,
    occupiedFrom: asset.occupied_from ?? undefined,
    occupiedUntil: asset.occupied_until ?? undefined,
    occupancyType: asset.occupancy_type ?? undefined,
    occupancyCaseId: asset.occupancy_case_id ?? undefined,
    occupancyNote: asset.occupancy_note ?? undefined,
    assignedDriverName: asset.assigned_driver_name ?? undefined,
    assignedDriverPhone: asset.assigned_driver_phone ?? undefined,
    assignedDriverStatus: asset.assigned_driver_status ?? undefined,
    towCategory: asset.tow_category ?? undefined,
    capabilities: asset.capabilities ?? [],
    swhouseLinked,
    occupancy,
    gps,
  };
}

function mapFleetProviderVehicle(row: FleetProviderVehicleRow): FleetProviderVehicle {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    label: row.label ?? undefined,
    licensePlate: row.license_plate ?? undefined,
    driverName: row.driver_name ?? undefined,
    online: row.online ?? undefined,
    disabled: row.disabled ?? undefined,
    linkedAssetId: row.linked_asset_id ?? undefined,
    latestPositionAt: row.latest_position_at ?? undefined,
    lastCatalogSyncAt: row.last_catalog_sync_at ?? undefined,
    lastPositionSyncAt: row.last_position_sync_at ?? undefined,
    speedKph: row.speed_kph ?? undefined,
    updatedAt: row.updated_at,
  };
}

function mapCommanderVehicleConnections(
  records: ExternalVehicleRecordRow[],
  links: FleetAssetLinkRow[],
  positions: FleetCurrentPositionRow[],
): CommanderVehicleConnection[] {
  const linkByExternalRecordId = latestLinkByExternalRecordId(links);
  const positionByExternalRecordId = latestCommanderPositionByExternalRecordId(positions);

  return records.map((record) => {
    const position = positionByExternalRecordId.get(record.id);
    const link = linkByExternalRecordId.get(record.id);

    return {
      id: record.id,
      sourceVehicleId: record.source_vehicle_id,
      label: record.label ?? undefined,
      licensePlate: record.normalized_license_plate ?? undefined,
      vin: record.normalized_vin ?? undefined,
      make: record.make ?? undefined,
      model: record.model ?? undefined,
      kindHint: record.kind_hint ?? undefined,
      sourceActive: record.source_active,
      sourceDeletedAt: record.source_deleted_at ?? undefined,
      lastSeenAt: record.last_seen_at ?? undefined,
      lastImportedAt: record.last_imported_at,
      position: position
        ? {
            lat: Number(position.lat),
            lng: Number(position.lng),
            gpsTime: position.gps_time,
            receivedAt: position.received_at,
            speedKph: numberValue(position.speed_kmh),
            headingDegrees: numberValue(position.heading_degrees),
            stale: isFleetGpsStale(position.gps_time),
            staleAfterMinutes: GPS_STALE_AFTER_MINUTES,
          }
        : undefined,
      link: link
        ? {
            id: link.id,
            fleetAssetId: link.fleet_asset_id ?? undefined,
            status: link.link_status,
            matchMethod: link.match_method,
            confidence: Number(link.match_confidence),
            confirmedAt: link.confirmed_at ?? undefined,
            rejectedAt: link.rejected_at ?? undefined,
          }
        : undefined,
    };
  });
}

function latestCommanderPositionByFleetAssetId(rows: FleetCurrentPositionRow[]) {
  const latest = new Map<string, FleetCurrentPositionRow>();

  rows.forEach((row) => {
    if (!row.fleet_asset_id) {
      return;
    }

    const previous = latest.get(row.fleet_asset_id);
    if (!previous || new Date(row.gps_time).getTime() > new Date(previous.gps_time).getTime()) {
      latest.set(row.fleet_asset_id, row);
    }
  });

  return latest;
}

function latestCommanderPositionByExternalRecordId(rows: FleetCurrentPositionRow[]) {
  const latest = new Map<string, FleetCurrentPositionRow>();

  rows.forEach((row) => {
    const previous = latest.get(row.external_vehicle_record_id);
    if (!previous || new Date(row.gps_time).getTime() > new Date(previous.gps_time).getTime()) {
      latest.set(row.external_vehicle_record_id, row);
    }
  });

  return latest;
}

function latestLinkByExternalRecordId(rows: FleetAssetLinkRow[]) {
  const latest = new Map<string, FleetAssetLinkRow>();
  const rank = { confirmed: 0, rejected: 1, candidate: 2 };

  rows.forEach((row) => {
    const previous = latest.get(row.external_vehicle_record_id);
    if (!previous) {
      latest.set(row.external_vehicle_record_id, row);
      return;
    }

    const rowRank = rank[row.link_status];
    const previousRank = rank[previous.link_status];
    if (rowRank < previousRank || (rowRank === previousRank && new Date(row.updated_at).getTime() > new Date(previous.updated_at).getTime())) {
      latest.set(row.external_vehicle_record_id, row);
    }
  });

  return latest;
}

function gpsFromCommanderPosition(position: FleetCurrentPositionRow): FleetAsset["gps"] {
  return {
    source: "commander",
    externalId: position.source_vehicle_id,
    positionTime: position.gps_time,
    syncedAt: position.received_at,
    speedKph: numberValue(position.speed_kmh),
    headingDegrees: numberValue(position.heading_degrees),
    stale: isFleetGpsStale(position.gps_time),
    staleAfterMinutes: GPS_STALE_AFTER_MINUTES,
  };
}

function isFleetGpsStale(lastSeenAt: string | null) {
  if (!lastSeenAt) {
    return true;
  }

  const timestamp = Date.parse(lastSeenAt);

  if (!Number.isFinite(timestamp)) {
    return true;
  }

  return Date.now() - timestamp > 10 * 60 * 1000;
}

function mapCase({
  caseRow,
  contactsById,
  vehiclesById,
  locationById,
  customerLocationSubmission,
  tasks,
  events,
  profilesById,
}: {
  caseRow: CaseRow;
  contactsById: Map<string, ContactRow>;
  vehiclesById: Map<string, VehicleRow>;
  locationById: Map<string, LocationRow>;
  customerLocationSubmission?: LocationSubmissionRow;
  tasks: CaseTaskRow[];
  events: CaseEventRow[];
  profilesById: Map<string, ProfileRow>;
}): DispatchCase {
  const contact = caseRow.contact_id ? contactsById.get(caseRow.contact_id) : undefined;
  const vehicle = caseRow.vehicle_id ? vehiclesById.get(caseRow.vehicle_id) : undefined;
  const vehicleDetails = jsonRecord(caseRow.vehicle_details);
  const mappedJobTypes = inferJobTypes(caseRow, vehicleDetails, vehicle);
  const pickup = mapLocation(caseRow.pickup_location_id ? locationById.get(caseRow.pickup_location_id) : undefined, "pickup");
  const destination = mapLocation(caseRow.destination_location_id ? locationById.get(caseRow.destination_location_id) : undefined, "destination");
  const customerLocationRow = customerLocationSubmission?.location_id ? locationById.get(customerLocationSubmission.location_id) : undefined;
  const owner = caseRow.owner_id ? profilesById.get(caseRow.owner_id) : undefined;
  const mappedVehicle = mapVehicle(vehicle, vehicleDetails);
  const mappedIncidentDetails = mapIncidentDetails(caseRow.incident_details);
  const canonicalProblem = canonicalCaseProblemDescription(mappedVehicle.issue, mappedIncidentDetails.description);
  mappedVehicle.issue = canonicalProblem ?? "";
  mappedVehicle.specifics = canonicalProblem;
  mappedIncidentDetails.description = canonicalProblem;

  return {
    id: caseRow.id,
    caseNumber: caseRow.case_number,
    status: toCaseStatus(caseRow.status),
    priority: toCasePriority(caseRow.priority),
    sourceType: caseRow.source_type ?? undefined,
    caseType: caseRow.case_type ?? undefined,
    jobTypes: mappedJobTypes,
    ownerId: caseRow.owner_id ?? "unassigned",
    ownerName: owner?.display_name,
    contact: mapContact(contact),
    customerDetails: mapCustomerDetails(caseRow.customer_details),
    vehicle: mappedVehicle,
    incidentDetails: mappedIncidentDetails,
    pickup,
    destination,
    customerSharedLocation: customerLocationSubmission
      ? {
          accuracyMeters: customerLocationSubmission.accuracy_meters ?? undefined,
          address: customerLocationRow?.address ?? undefined,
          label: customerLocationRow?.label ?? "Poloha od klienta",
          lat: Number(customerLocationSubmission.lat),
          lng: Number(customerLocationSubmission.lng),
          locationId: customerLocationSubmission.location_id ?? undefined,
          submittedAt: customerLocationSubmission.submitted_at,
        }
      : undefined,
    locationDetails: mapLocationDetails(caseRow.location_details),
    replacementVehicle: mapReplacementVehicle(caseRow.replacement_vehicle_details),
    attachments: mapAttachments(caseRow.attachments_metadata),
    paymentDetails: mapPaymentDetails(caseRow.payment_details),
    closureDetails: mapClosureDetails(caseRow.closure_details),
    selectedAssetId: caseRow.selected_asset_id ?? undefined,
    priceRuleId: priceRuleIdForSource(caseRow.source_type ?? undefined),
    summary: caseRow.summary ?? "",
    mainNote: caseRow.main_note ?? "",
    createdAt: caseRow.created_at,
    updatedAt: caseRow.updated_at,
    nextStep: nextStepForCase(caseRow.status, {
      hasPickup: Boolean(pickup),
      hasPhone: Boolean(contact?.phone && contact.phone.replace(/\D/g, "").length >= 6),
      hasRequiredDestination: !requiresTowDestination(mappedJobTypes) || Boolean(destination),
    }),
    tasks: tasks.map((task) => ({
      id: task.id,
      caseId: task.case_id,
      title: task.title,
      // Nepriradená úloha musí ostať nepriradená (U-02) — owner prípadu nie je implicitný riešiteľ.
      assignedTo: task.assigned_to ?? "unassigned",
      dueAt: task.due_at ?? caseRow.updated_at,
      status: task.status,
      priority: toCasePriority(task.priority ?? "normal"),
      kind: toCaseTaskKind(task.kind ?? "other"),
      createdBy: task.created_by ?? undefined,
      completedBy: task.completed_by ?? undefined,
      completedAt: task.completed_at ?? undefined,
    })),
    timeline: events.map((event) => ({
      id: event.id,
      caseId: event.case_id,
      time: event.created_at,
      actor: event.actor_profile_id ? profilesById.get(event.actor_profile_id)?.display_name ?? "Systém" : "Systém",
      title: event.title,
      body: event.body ?? "",
      type: event.event_type ?? undefined,
    })),
  };
}

function mapNotification(row: NotificationRow): DispatchNotification {
  return {
    id: row.id,
    caseId: row.case_id ?? undefined,
    taskId: row.task_id ?? undefined,
    reminderId: row.reminder_id ?? undefined,
    recipientProfileId: row.recipient_profile_id ?? undefined,
    visibility: row.visibility,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body ?? undefined,
    status: row.status,
    deliveryStatus: row.delivery_status,
    dedupeKey: row.dedupe_key,
    readAt: row.read_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContact(contact?: ContactRow): Contact {
  if (!contact) {
    return { id: "", name: "", phone: "", role: "client" };
  }

  return {
    id: contact.id,
    name: contact.name,
    phone: contact.phone ?? "",
    email: contact.email ?? undefined,
    role: contact.role,
    notes: contact.notes ?? undefined,
  };
}

function mapVehicle(vehicle: VehicleRow | undefined, vehicleDetails: JsonRecord = {}): Vehicle {
  const conditionFlags = stringArray(vehicleDetails.conditionFlags).filter(isVehicleConditionFlag);
  const vehicleNote = stringValue(vehicleDetails.note);

  if (!vehicle) {
    return {
      id: "",
      licensePlate: "",
      make: "",
      model: "",
      category: "",
      productionYear: numberValue(vehicleDetails.productionYear),
      color: stringValue(vehicleDetails.color),
      vehicleType: stringValue(vehicleDetails.vehicleType) as ClientVehicleType | undefined,
      transmission: stringValue(vehicleDetails.transmission) as VehicleTransmission | undefined,
      driveType: stringValue(vehicleDetails.driveType),
      weightKg: numberValue(vehicleDetails.weightKg),
      driveable: conditionFlags.includes("driveable"),
      conditionFlags,
      issue: "",
      note: vehicleNote,
    };
  }

  const problem = legacyVehicleProblemDescription(vehicle.notes, vehicleNote);

  return {
    id: vehicle.id,
    licensePlate: vehicle.license_plate ?? "",
    vin: vehicle.vin ?? undefined,
    make: vehicle.make ?? "",
    model: vehicle.model ?? "",
    productionYear: vehicle.production_year ?? numberValue(vehicleDetails.productionYear),
    color: vehicle.color ?? stringValue(vehicleDetails.color),
    category: vehicle.category ?? "",
    vehicleType: stringValue(vehicleDetails.vehicleType) as ClientVehicleType | undefined,
    transmission: (vehicle.transmission ?? stringValue(vehicleDetails.transmission) ?? undefined) as VehicleTransmission | undefined,
    driveType: vehicle.drive_type ?? stringValue(vehicleDetails.driveType),
    weightKg: vehicle.weight_kg ?? numberValue(vehicleDetails.weightKg),
    driveable: vehicle.is_driveable ?? conditionFlags.includes("driveable"),
    conditionFlags: conditionFlags.length > 0 ? conditionFlags : vehicle.is_driveable === true ? ["driveable"] : [],
    issue: problem ?? "",
    specifics: problem,
    note: vehicleNote,
  };
}

function mapCustomerDetails(value: unknown): CustomerDetails {
  const record = jsonRecord(value);
  const contacts = Array.isArray(record.contacts) ? record.contacts.flatMap(mapCustomerContact) : [];
  const alternativeContact = stringValue(record.alternativeContact);

  return {
    ...defaultCustomerDetails(),
    ...(record.type === "private_person" || record.type === "insurance" || record.type === "company" ? { type: record.type } : {}),
    firstName: stringValue(record.firstName),
    lastName: stringValue(record.lastName),
    companyName: stringValue(record.companyName),
    companyIdNumber: stringValue(record.companyIdNumber),
    assistanceServiceName: stringValue(record.assistanceServiceName),
    assistanceReference: stringValue(record.assistanceReference),
    partnerDirectoryId: stringValue(record.partnerDirectoryId),
    alternativeContact,
    contacts: contacts.length > 0 ? contacts : alternativeContact ? [legacyAlternativeContact(alternativeContact)] : undefined,
    note: stringValue(record.note),
  };
}

function mapCustomerContact(item: unknown): CustomerContact[] {
  const record = jsonRecord(item);
  const phone = stringValue(record.phone) ?? "";
  const email = stringValue(record.email);
  const note = stringValue(record.note);
  const name = stringValue(record.name) ?? [stringValue(record.firstName), stringValue(record.lastName)].filter(Boolean).join(" ").trim();

  if (!phone && !name && !email && !note) {
    return [];
  }

  const role = String(record.role ?? "");

  return [
    {
      id: stringValue(record.id) ?? `draft-${normalizeText(name || phone || email || note || "contact")}`,
      firstName: stringValue(record.firstName),
      lastName: stringValue(record.lastName),
      name,
      phone,
      phonePrefix: stringValue(record.phonePrefix),
      phoneNational: stringValue(record.phoneNational),
      email,
      role: isCustomerContactRole(role) ? role : "other",
      note,
      isPrimary: Boolean(record.isPrimary),
    },
  ];
}

function legacyAlternativeContact(alternativeContact: string): CustomerContact {
  return {
    id: `legacy-alternative-${alternativeContact.replace(/\D/g, "") || "contact"}`,
    name: "Alternatívny kontakt",
    phone: alternativeContact,
    role: "other",
    isPrimary: false,
  };
}

function mapIncidentDetails(value: unknown): IncidentDetails {
  const record = jsonRecord(value);
  return {
    ...defaultIncidentDetails(),
    ...(isIncidentType(record.type) ? { type: record.type } : {}),
    description: stringValue(record.description),
    participantsCount: numberValue(record.participantsCount),
    passengersCount: numberValue(record.passengersCount),
    damages: stringValue(record.damages),
    damageAreas: stringArray(record.damageAreas).filter(isDamageArea),
    damageNote: stringValue(record.damageNote),
  };
}

function mapLocationDetails(value: unknown): CaseLocationDetails {
  const record = jsonRecord(value);
  return {
    ...defaultLocationDetails(),
    manualPickupAddress: stringValue(record.manualPickupAddress),
    manualDestinationAddress: stringValue(record.manualDestinationAddress),
    roadName: stringValue(record.roadName),
    kilometerSection: stringValue(record.kilometerSection),
    drivingDirection: stringValue(record.drivingDirection),
    placeType: isPlaceType(record.placeType) ? record.placeType : undefined,
    complications: stringValue(record.complications),
    accessComplications: stringArray(record.accessComplications).filter(isAccessComplication),
    destinationNote: stringValue(record.destinationNote),
  };
}

function mapReplacementVehicle(value: unknown): ReplacementVehicleRequest {
  const record = jsonRecord(value);
  const provisionStatus = stringValue(record.provisionStatus);
  const category = stringValue(record.category);
  const entitlement = stringValue(record.entitlement);
  const maxDays = typeof record.maxDays === "number" && Number.isFinite(record.maxDays) && record.maxDays > 0 ? Math.round(record.maxDays) : undefined;
  return {
    ...defaultReplacementVehicleRequest(),
    needed: Boolean(record.needed),
    requestedType: stringValue(record.requestedType),
    preferences: stringArray(record.preferences).filter(isReplacementPreference),
    note: stringValue(record.note),
    category: category === "small_car" || category === "wagon" || category === "suv" || category === "van" ? category : undefined,
    deliveryPlace: stringValue(record.deliveryPlace),
    entitlement: entitlement === "yes" || entitlement === "no" || entitlement === "unverified" ? entitlement : undefined,
    extensionPossible: typeof record.extensionPossible === "boolean" ? record.extensionPossible : undefined,
    maxDays,
    provisionStatus: provisionStatus === "provided" || provisionStatus === "not_provided" || provisionStatus === "pending" ? provisionStatus : undefined,
    provisionReason: stringValue(record.provisionReason),
  };
}

function mapAttachments(value: unknown): CaseAttachmentMetadata[] {
  if (!Array.isArray(value)) {
    return defaultAttachments();
  }

  return value.flatMap((item) => {
    const record = jsonRecord(item);
    const fileName = stringValue(record.fileName);
    const category = record.category;
    if (!fileName || (category !== "photo" && category !== "video" && category !== "document")) {
      return [];
    }

    return [
      {
        id: stringValue(record.id) ?? `${fileName}-${stringValue(record.createdAt) ?? "metadata"}`,
        category,
        fileName,
        storageBucket: stringValue(record.storageBucket),
        storagePath: stringValue(record.storagePath),
        mimeType: stringValue(record.mimeType),
        sizeBytes: numberValue(record.sizeBytes),
        note: stringValue(record.note),
        createdAt: stringValue(record.createdAt) ?? new Date(0).toISOString(),
      },
    ];
  });
}

function mapPaymentDetails(value: unknown): PaymentDetails {
  const record = jsonRecord(value);
  return {
    ...defaultPaymentDetails(),
    ...(record.method === "cash" || record.method === "card" || record.method === "invoice" || record.method === "insurance" ? { method: record.method } : {}),
    ...(record.status === "paid" || record.status === "unpaid" || record.status === "waiting_for_insurance" ? { status: record.status } : {}),
  };
}

function mapClosureDetails(value: unknown): ClosureDetails {
  const record = jsonRecord(value);
  return {
    ...defaultClosureDetails(),
    ...(record.type === "insurance_portal" || record.type === "self_payer" || record.type === "internal" ? { type: record.type } : {}),
    status: stringValue(record.status),
    insurancePortalUrl: stringValue(record.insurancePortalUrl),
    note: stringValue(record.note),
    closedAt: stringValue(record.closedAt),
  };
}

function mapLocation(location: LocationRow | undefined, kind: DispatchLocation["kind"]): DispatchLocation | undefined {
  if (!location) {
    return undefined;
  }

  return {
    id: location.id,
    label: location.label,
    address: location.address,
    kind,
    lat: Number(location.lat),
    lng: Number(location.lng),
  };
}

function mapIncomingCall({
  call,
  organization,
  organizationProfile,
  linesById,
  callEventsByCallId,
}: {
  call?: CallRow;
  organization: OrganizationRow;
  organizationProfile: OrganizationProfileRow | null;
  linesById: Map<string, LineRow>;
  callEventsByCallId: Map<string, CallEventRow[]>;
}): DispatchCall {
  if (!call) {
    return {
      ...mockIncomingCall,
      id: "call-idle",
      status: "ended",
      callerNumber: "Bez aktívneho hovoru",
      callerName: organization.name,
      calledNumber: organizationProfile?.primary_phone ?? mockIncomingCall.calledNumber,
      waitSeconds: 0,
      history: ["Supabase zatiaľ nemá žiadny hovor."],
    };
  }

  const line = call.direction === "inbound" && call.line_id ? linesById.get(call.line_id) : undefined;
  const events = callEventsByCallId.get(call.id) ?? [];
  const history = events.map((event) => callEventSummary(event));

  return {
    id: call.id,
    status: toCallStatus(call.status),
    callerNumber: call.caller_number ?? "Neznáme číslo",
    callerName: call.caller_name ?? undefined,
    calledNumber: call.called_number ?? line?.phone_number ?? organizationProfile?.primary_phone ?? mockIncomingCall.calledNumber,
    lineLabel: line?.label ?? organizationProfile?.brand_name ?? "Linka pomoci",
    startedAt: call.started_at ?? call.created_at,
    waitSeconds: call.wait_seconds ?? 0,
    caseId: call.case_id ?? undefined,
    history: history.length > 0 ? history : ["Hovor načítaný zo Supabase."],
  };
}

function latestOperatorStatuses(statuses: OperatorStatusRow[]) {
  const latest = new Map<string, OperatorStatusRow>();

  statuses.forEach((status) => {
    if (!latest.has(status.profile_id)) {
      latest.set(status.profile_id, status);
    }
  });

  return latest;
}

function latestAcceptedLocationSubmissions(rows: LocationSubmissionRow[]) {
  const latest = new Map<string, LocationSubmissionRow>();

  for (const submission of rows) {
    if (submission.accepted && !latest.has(submission.case_id)) {
      latest.set(submission.case_id, submission);
    }
  }

  return latest;
}

function groupByCaseId<RowWithCaseId extends { case_id: string }>(rows: RowWithCaseId[]) {
  return rows.reduce((groups, row) => {
    const list = groups.get(row.case_id) ?? [];
    list.push(row);
    groups.set(row.case_id, list);
    return groups;
  }, new Map<string, RowWithCaseId[]>());
}

function groupCallEventsByCallId(rows: CallEventRow[]) {
  return rows.reduce((groups, row) => {
    if (!row.call_id) {
      return groups;
    }

    const list = groups.get(row.call_id) ?? [];
    list.push(row);
    groups.set(row.call_id, list);
    return groups;
  }, new Map<string, CallEventRow[]>());
}

function pointFromLocation(location: LocationRow | undefined, fallback: GeoPoint): GeoPoint {
  if (!location) {
    return fallback;
  }

  return {
    lat: Number(location.lat),
    lng: Number(location.lng),
  };
}

function jsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toCallOutcome(value: unknown): CallOutcome | undefined {
  return typeof value === "string" && ["reached", "not_reached", "callback", "informational", "bad_contact", "case_created"].includes(value)
    ? (value as CallOutcome)
    : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function inferJobTypes(caseRow: CaseRow, vehicleDetails: JsonRecord, vehicle?: VehicleRow): JobType[] {
  if (Array.isArray(vehicleDetails.jobTypes)) {
    return stringArray(vehicleDetails.jobTypes).filter(isJobType);
  }

  const text = normalizeText(
    [
      caseRow.case_type,
      vehicle?.category,
      vehicle?.make,
      vehicle?.model,
      vehicle?.notes,
      stringValue(vehicleDetails.note),
      stringValue(vehicleDetails.vehicleType),
    ]
      .filter(Boolean)
      .join(" "),
  );
  const inferred: JobType[] = [];

  if (text.includes("vyslobodenie") || text.includes("vyslobod") || text.includes("priekop") || text.includes("prevrat")) {
    inferred.push("vehicle_recovery");
  }

  if (text.includes("odtah") || text.includes("odtahovy") || caseRow.destination_location_id) {
    inferred.push("tow");
  }

  if (text.includes("nahrad") || text.includes("replacement")) {
    inferred.push("replacement_vehicle");
  }

  if (!caseRow.destination_location_id && (text.includes("asistencia-na-mieste") || text.includes("defekt") || text.includes("bateria"))) {
    inferred.push("onsite_assistance");
  }

  return Array.from(new Set(inferred));
}

function normalizeText(value: string) {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isJobType(value: string): value is JobType {
  return ["tow", "replacement_vehicle", "onsite_assistance", "vehicle_recovery"].includes(value);
}

function isCustomerContactRole(value: string): value is CustomerContactRole {
  return ["primary_customer", "driver", "owner", "company", "assistance", "partner", "police", "family", "billing", "other"].includes(value);
}

function isVehicleConditionFlag(value: string): value is VehicleConditionFlag {
  return ["driveable", "immobile", "locked", "no_keys", "blocked_wheel", "after_accident", "overturned", "in_ditch"].includes(value);
}

function isIncidentType(value: unknown): value is IncidentDetails["type"] {
  return typeof value === "string" && ["traffic_accident", "breakdown", "flat_tire", "dead_battery", "wrong_fuel", "locked_keys", "overheating", "fire", "other"].includes(value);
}

function isDamageArea(value: string): value is DamageArea {
  return ["front", "rear", "left_side", "right_side", "roof", "undercarriage", "wheel", "glass", "engine"].includes(value);
}

function isPlaceType(value: unknown): value is CaseLocationDetails["placeType"] {
  return typeof value === "string" && ["road", "highway", "parking_lot", "garage_outdoor", "garage_underground", "company_site", "field", "forest"].includes(value);
}

function isAccessComplication(value: string): value is AccessComplication {
  return ["narrow_road", "parallel_parking", "difficult_access", "mud", "snow", "low_clearance"].includes(value);
}

function isReplacementPreference(value: string): value is ReplacementVehiclePreference {
  return ["manual", "automatic", "suv", "wagon", "van", "ev"].includes(value);
}

function deriveMetrics(calls: CallRow[], dispatchCases: DispatchCase[]) {
  const answeredCalls = calls.filter((call) => call.status === "answered" || Boolean(call.answered_at)).length;
  const missedCalls = calls.filter((call) => call.status === "missed" || call.status === "abandoned_queue" || call.status === "failed").length;
  const openTasks = dispatchCases.reduce((count, caseItem) => count + caseItem.tasks.filter(isTaskOpen).length, 0);
  const answeredOrMissed = answeredCalls + missedCalls;
  const serviceLevelCalls = calls.filter((call) => (call.wait_seconds ?? Number.MAX_SAFE_INTEGER) <= 30).length;

  return {
    totalCalls: calls.length,
    answeredCalls,
    missedCalls,
    newCases: dispatchCases.length,
    openTasks,
    futileTrips: dispatchCases.filter((caseItem) => caseItem.status === "futile_trip").length,
    answerRate: answeredOrMissed > 0 ? Math.round((answeredCalls / answeredOrMissed) * 100) : 0,
    serviceLevel: calls.length > 0 ? Math.round((serviceLevelCalls / calls.length) * 100) : 0,
  };
}

function toCallStatus(status: CallRow["status"]): CallStatus {
  if (status === "abandoned_queue" || status === "failed") {
    return status === "abandoned_queue" ? "missed" : "ended";
  }

  return status;
}

function toCaseStatus(status: CaseRow["status"]): CaseStatus {
  return status;
}

function toCasePriority(priority: CaseRow["priority"]): CasePriority {
  return priority;
}

function toCaseTaskKind(kind: CaseTaskRow["kind"]): CaseTaskKind {
  return kind;
}

function toFleetAssetKind(kind: FleetAssetRow["kind"]): FleetAssetKind {
  return kind;
}

function priceRuleIdForSource(sourceType: DispatchCase["sourceType"]) {
  if (!sourceType) {
    return undefined;
  }
  if (sourceType === "assistance") {
    return "price-europe";
  }

  if (sourceType === "partner" || sourceType === "internal") {
    return "price-avp";
  }

  return "price-samoplatca";
}

function nextStepForCase(
  status: CaseRow["status"],
  readiness: { hasPickup: boolean; hasPhone: boolean; hasRequiredDestination: boolean },
) {
  if (status === "assigned" || status === "dispatched" || status === "in_progress") {
    return "Sledovať ETA a potvrdiť príchod techniky";
  }

  if (status === "scheduled" || status === "waiting_for_client") {
    return "Potvrdiť termín s klientom";
  }

  if (status === "completed_assisted" || status === "completed_no_assistance") {
    return "Skontrolovať uzatvorenie a report";
  }

  if (!readiness.hasPickup || !readiness.hasPhone || !readiness.hasRequiredDestination) {
    return "Doplniť údaje potrebné pre výjazd";
  }

  return "Poslať lokalizačnú SMS a potvrdiť ETA";
}

function callEventSummary(event: CallEventRow) {
  return `${event.event_type} · ${event.provider}`;
}

function throwOnSupabaseError(result: { error: unknown }, label = "Supabase query") {
  if (result.error) {
    throw new Error(`${label}: ${getErrorMessage(result.error)}`);
  }
}

function warnOnOptionalSupabaseError(result: { error: unknown }, label = "Supabase optional query") {
  if (label === "motorist_notifications" && isOptionalTableSchemaMiss(result.error, "motorist_notifications")) {
    return;
  }

  if (result.error) {
    console.warn(`Optional Supabase data unavailable (${label}):`, getErrorMessage(result.error));
  }
}

function isOptionalTableSchemaMiss(error: unknown, tableName: string) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const { code, message } = error as { code?: string; message?: string };
  const normalized = String(message ?? "").toLowerCase();
  return (
    (code === "PGRST204" || code === "PGRST205" || normalized.includes("schema cache") || normalized.includes("does not exist")) &&
    normalized.includes(tableName)
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }

  return "Unknown Supabase error";
}

function isIntegrationSecretConfigured(provider: IntegrationConnection["provider"]) {
  if (provider === "viptel") {
    return hasUsableEnv("VIPTEL_USERNAME") && hasUsableEnv("VIPTEL_PASSWORD");
  }

  if (provider === "viptel_sms") {
    return hasUsableEnv("VIPTEL_SMS_USERNAME") && hasUsableEnv("VIPTEL_SMS_PASSWORD");
  }

  if (provider === "google_maps") {
    return hasUsableEnv("GOOGLE_MAPS_API_KEY") || hasUsableEnv("NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY");
  }

  if (provider === "fleet") {
    return hasUsableEnv("WEBDISPECINK_COMPANY_CODE") && hasUsableEnv("WEBDISPECINK_USERNAME") && hasUsableEnv("WEBDISPECINK_PASSWORD");
  }

  return false;
}

function hasUsableEnv(name: string) {
  const value = process.env[name]?.trim();

  return Boolean(value && !value.startsWith("replace-with-") && value !== "TODO");
}

function getSupabaseReadTimeout() {
  const configured = Number(process.env.SUPABASE_READ_TIMEOUT_MS);

  if (Number.isFinite(configured) && configured > 0) {
    // Production still carries an old 4500 ms override. The full dispatch
    // snapshot reads many independent tables and can legitimately exceed it
    // under load. Never let that legacy value re-enable a false mock screen.
    return process.env.NODE_ENV === "production"
      ? Math.max(configured, DEFAULT_SUPABASE_READ_TIMEOUT_MS)
      : configured;
  }

  return DEFAULT_SUPABASE_READ_TIMEOUT_MS;
}

function mockDispatchDataOrThrow(mockWarning: string, productionMessage: string): DispatchData {
  if (process.env.NODE_ENV === "production") {
    throw new Error(productionMessage);
  }
  return getMockDispatchData(mockWarning);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Supabase read timed out after ${timeoutMs}ms`)), timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
