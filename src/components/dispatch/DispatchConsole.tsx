"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BellRing,
  CalendarDays,
  ChevronDown,
  Headphones,
  GripHorizontal,
  LayoutDashboard,
  Link2,
  Loader2,
  PhoneCall,
  PhoneForwarded,
  PhoneIncoming,
  PhoneOff,
  Plus,
  Settings2,
  Table2,
  Truck,
  X,
} from "lucide-react";
import { AttendanceModule } from "./AttendanceModule";
import { CallCenterModule, customerNumberForCall, presentCallForBrowser } from "./CallCenterModule";
import { ActiveCallBar, RemoteAudio, describePhoneState, useDraggableFloatingPanel } from "./webphone-ui";
import { CallTransferPicker } from "./CallTransferPicker";
import { CaseDirectory } from "./CaseDirectory";
import { CaseList, type CaseFilters } from "./CaseList";
import { DashboardPhone } from "./DashboardPhone";
import type { CaseSortState } from "./CaseTable";
import { FleetModule } from "./FleetModule";
import { ExpandedCasePanel } from "./ExpandedCasePanel";
import { IntegrationSettings } from "./IntegrationSettings";
import { MapWorkspace, type CenterView, type WorkspaceKind, type WorkspaceMode } from "./MapWorkspace";
import type { SaveCaseDraft } from "./NewCaseDrawer";
import { WorkplaceTakeoverDialog } from "./WorkplaceTakeoverDialog";
import { getQueueCoverage, type QueueCoverage } from "./queue-coverage";
import { ReportDashboard } from "./ReportDashboard";
import { HeaderNotificationMenu } from "./HeaderNotificationMenu";
import { NotificationToastStack } from "./NotificationToastStack";
import { TaskPanel, type TaskCreateInput, type TaskDeleteInput, type TaskUpdateInput } from "./TaskPanel";
import {
  buildTakeoverPhoneHandshakeResult,
  type WorkplaceSelectionActionResult,
  type WorkplaceSelectionInput,
  type WorkplaceSelectionSnapshot,
} from "./WorkplaceView";
import type { CallerMatch, CallCenterCall, DispatchData } from "@/data/dispatch-types";
import { isNotificationForProfile, isNotificationUnread, notificationStatusLabel } from "@/domain/notifications";
import { casePriorityLabels, caseStatusLabels } from "@/domain/statuses";
import { isTaskOpen, taskPriorityLabels } from "@/domain/tasks";
import type { Branch, CallStatus, CaseTask, CustomerSharedLocation, DispatchCall, DispatchCase, DispatchNotification, FleetAsset, NotificationStatus, Operator, TimelineEvent } from "@/domain/types";
import { requiresTowDestination } from "@/domain/case-card";
import { caseAssistanceServiceName } from "@/lib/dispatch-calculations";
import { createDispatchMapModel } from "@/lib/map-adapter";
import {
  useViptelBrowserWebphone,
  type WorkplaceWebphoneSessionFence,
} from "@/lib/telephony/webphone-client";
import { formatPhoneNumberForDisplay, isDialablePhoneInput } from "@/lib/telephony/phone";
import {
  callIsRingingAtTelephonyStation,
  mergeProviderCallsWithHistory,
  partitionLiveTelephonyCalls,
  resolveIncomingBrowserProviderCall,
  resolveOutboundBrowserProviderCall,
  resolveUniqueCurrentTelephonyCall,
  sameTelephonyCallIdentity,
  type TelephonyExtensionIdentity,
} from "@/lib/telephony/call-endpoints";
import { telephonyTransferTransport, terminateQueuedIncomingCall } from "@/lib/telephony/call-control";
import { browserCallSessionKey, sameBrowserCallSession, type BrowserCallSessionFence } from "@/lib/telephony/browser-call-session";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import {
  activeCallPollDelayMs,
  supportPollDelayMs,
  takeoverPollDelayMs,
  telephonyPollActivity,
} from "@/lib/telephony/poll-schedule";
import { CallQueuePanel } from "./CallQueuePanel";
import { useWaitingCallPickup } from "./use-waiting-call-pickup";
import { buildWorkplaceStations, buildWorkplaceWaitingRoom } from "./workplace-model";
import {
  WorkplaceDocumentLeader,
  classifyWorkplaceMutationResponse,
  classifyWorkplacePresenceResponse,
  clearWorkplacePendingMutation,
  clearWorkplacePendingResume,
  clearWorkplaceResumeCredential,
  createWorkplaceBrowserInstanceId,
  normalizeWorkplaceLease,
  readWorkplacePendingMutation,
  readWorkplacePendingResume,
  readWorkplaceResumeCredential,
  startWorkplaceHeartbeatLoop,
  storeWorkplacePendingMutation,
  storeWorkplacePendingResume,
  storeWorkplaceResumeCredential,
  type WorkplaceDocumentLeaderState,
  type WorkplaceLease,
  type WorkplacePendingMutation,
  type WorkplacePendingResume,
} from "@/lib/telephony/workplace-lease-client";
import {
  confirmAuditedBrowserSipCall,
  requireConfirmedTelephonyCommand,
  runAuditedBrowserSipInvite,
  waitForTelephonyCommand,
  type TelephonyRedirectDestination,
} from "@/lib/telephony/commands";
import {
  isViptelWebphoneReadyForBrowser,
  type ViptelTelephonyIdentity,
  type ViptelWebphoneConfig,
} from "@/lib/telephony/webphone";
import { assertHotdeskWebphoneDisconnectConfirmed } from "@/lib/telephony/webphone-unregister";
import { disconnectOrCancelRecoveredPhoneTransition } from "@/lib/telephony/workplace-phone-recovery";
import type { TelephonyHealthSignal } from "@/lib/telephony/health";
import {
  deriveTelephonyOperatorPresences,
  type TelephonyAvailabilityAction,
  type TelephonyOperatorPresenceState,
  type TelephonyPresenceSnapshot,
} from "@/lib/telephony/presence";
import type { ViptelQueueStatus } from "@/lib/integrations/viptel/client";
import type { WorkplaceTakeoverSnapshot } from "@/lib/telephony/workplace-takeover";

type View = "dispatch" | "tasks" | "cases" | "call-center" | "attendance" | "fleet" | "reports" | "settings";

type DispatchWorkspaceState = {
  kind: WorkspaceKind;
  mode: WorkspaceMode;
};

type ActorDispatchRouting = {
  queue: "601" | "602" | "603";
  revision: number;
};

type TelephonyPresenceRefreshMode = "poll" | "provider" | "provider_fresh" | "stored";

type TelephonyPresenceRequest = {
  controller: AbortController;
  kind: "provider" | "stored";
  promise: Promise<TelephonyPresenceSnapshot | undefined>;
  token: symbol;
};

type WorkplaceSelectionRefreshMode = "fresh" | "poll";

type LocationUpdatesResponse = {
  checkedAt?: string;
  error?: string;
  notifications?: DispatchNotification[];
  updates?: Array<{
    caseId: string;
    event: TimelineEvent;
    location: CustomerSharedLocation;
  }>;
};

type WorkplaceSelectionRequest = {
  controller: AbortController;
  promise: Promise<WorkplaceSelectionSnapshot>;
  token: symbol;
};

type WorkplaceSelectionMutationAction =
  | "cancel_seat_change"
  | "claim_priority"
  | "claim_seat"
  | "confirm_seat_change"
  | "leave_seat"
  | "recover_priority"
  | "release_priority"
  | "release_seat"
  | "release_occupied_seat"
  | "select_seat"
  | "takeover_seat";

type WorkplaceSelectionMutationResponse = {
  code?: string;
  error?: string;
  ok?: boolean;
  result?: {
    message?: string;
    operationId?: string;
    state?: "confirmed" | "disconnect_required" | "draft" | "pending" | "warning";
  };
  lease?: WorkplaceLease;
  resumeSecret?: string;
  workplace?: WorkplaceSelectionSnapshot;
};

type WorkplaceMutationResult = WorkplaceSelectionActionResult & {
  lease?: WorkplaceLease;
  operationId?: string;
  resumeCredentialPersisted?: boolean;
  workplace?: WorkplaceSelectionSnapshot;
};

type IncomingPopupCall = DispatchCall & { viptelUniqueId?: string };

type WorkplaceTakeoverMutationResponse = {
  error?: string;
  message?: string;
  ok?: boolean;
  snapshot?: WorkplaceTakeoverSnapshot;
};

type WorkplaceResumeResult =
  | {
      credentialPersisted: boolean;
      kind: "confirmed";
      lease: WorkplaceLease;
    }
  | {
      kind: "lease_lost";
      message: string;
    };

class WorkplaceMutationTransportError extends Error {}

class WorkplaceMutationContinuityError extends Error {}

class WorkplaceMutationProviderPendingError extends Error {}

class WorkplaceMutationTerminalError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

class WorkplaceMutationConvergenceError extends WorkplaceMutationContinuityError {}

type TakeoverPhoneHandshake = {
  extension: string;
  resolve: (result: WorkplaceSelectionActionResult) => void;
  serverMessage?: string;
  timeoutId: number;
};

/**
 * A call ending is reported by the provider slightly before it lands in
 * history, so the history read is repeated once shortly after.
 * Poll cadences themselves now live in `poll-schedule.ts`.
 */
const CALL_HISTORY_RETRY_MS = 1_000;

/**
 * Bounds for the automatic accept/claim of an approved workplace handover.
 * These paths run the full release and claim machinery, so they must not be
 * allowed to repeat forever when the server never advances the request.
 */
const WORKPLACE_TAKEOVER_AUTO_RETRY_MS = 10_000;
const WORKPLACE_TAKEOVER_AUTO_MAX_ATTEMPTS = 3;

/**
 * The auto-recovery guard map is keyed per routing operation and lease, so it
 * only ever grows over the lifetime of a page. Keep it bounded; Map preserves
 * insertion order, so the oldest entries go first.
 */
const WORKPLACE_AUTO_RECOVERY_KEY_LIMIT = 20;

function pruneAutoRecoveryKeys(keys: Map<string, number>) {
  while (keys.size >= WORKPLACE_AUTO_RECOVERY_KEY_LIMIT) {
    const oldest = keys.keys().next();
    if (oldest.done) return;
    keys.delete(oldest.value);
  }
}

type WorkplaceTakeoverAutoAttempt = {
  attemptedAt: number;
  requestId: string;
  attempts: number;
  exhausted?: boolean;
};
const TELEPHONY_PROBE_STALE_AFTER_MS = 30_000;
const TELEPHONY_READ_TIMEOUT_MS = 8_000;
const TAKEOVER_PHONE_REGISTRATION_TIMEOUT_MS = 15_000;
const WORKPLACE_EXACT_REQUEST_MAX_ATTEMPTS = 6;
const WORKPLACE_EXACT_REQUEST_ATTEMPTS_PER_RUN = 3;
const WORKPLACE_RECOVERY_RETRY_MAX_DELAY_MS = 15_000;
const WORKPLACE_AVAILABILITY_RECHECK_DELAYS_MS = [0, 500, 1_000, 2_000, 3_500, 5_000, 8_000] as const;
const defaultCaseFilters: CaseFilters = {
  assistanceService: "all",
  ownerId: "all",
  priority: "all",
  sourceType: "all",
  status: "all",
};

const priorityRank: Record<DispatchCase["priority"], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const statusRank: Record<DispatchCase["status"], number> = {
  new: 0,
  triage: 1,
  open: 2,
  waiting_for_client: 3,
  scheduled: 4,
  assigned: 5,
  dispatched: 6,
  in_progress: 7,
  waiting_for_docs: 8,
  completed_assisted: 9,
  completed_no_assistance: 10,
  rejected: 11,
  cancelled: 12,
  futile_trip: 13,
};

const terminalCaseStatuses = new Set<DispatchCase["status"]>([
  "completed_assisted",
  "completed_no_assistance",
  "rejected",
  "cancelled",
  "futile_trip",
]);

function isActiveDispatchCase(caseItem: DispatchCase) {
  return !terminalCaseStatuses.has(caseItem.status);
}

const sourceLabels: Record<NonNullable<DispatchCase["sourceType"]>, string> = {
  client: "Klient",
  assistance: "Asistenčka",
  samoplatca: "Samoplatca",
  partner: "Partner",
  internal: "Interné",
};

export function DispatchConsole({
  initialData,
  viewerOrganizationId,
  viewerProfileId,
}: {
  initialData: DispatchData;
  viewerOrganizationId?: string;
  viewerProfileId?: string;
}) {
  const [dispatchData, setDispatchData] = useState(initialData);
  const {
    attendance,
    branches,
    callCenterCalls,
    commanderVehicles,
    commanderGpsLastSuccessAt,
    commanderGpsLatestRunAt,
    commanderGpsLatestStatus,
    dispatchCases,
    fleetAssets,
    incomingCall,
    metrics,
    notifications,
    operators,
    partnerDirectory,
    priceRules,
    source,
    users,
    warning,
  } = dispatchData;
  const dataSourceLabel = source === "supabase" ? "Supabase live" : "Mock fallback";
  const [activeView, setActiveView] = useState<View>("dispatch");
  const [activeCaseId, setActiveCaseId] = useState(dispatchCases.find(isActiveDispatchCase)?.id ?? "");
  const [workspace, setWorkspace] = useState<DispatchWorkspaceState>({ kind: "cockpit", mode: "split" });
  const [newCaseCall, setNewCaseCall] = useState(incomingCall);
  const [callStatus, setCallStatus] = useState<CallStatus>(incomingCall.status);
  const [liveCalls, setLiveCalls] = useState<CallCenterCall[] | null>(null);
  const [dismissedIncomingCallId, setDismissedIncomingCallId] = useState<string | null>(null);
  const [isAssigning, setIsAssigning] = useState(false);
  const [isSendingCaseSms, setIsSendingCaseSms] = useState(false);
  const [isDashboardDialing, setIsDashboardDialing] = useState(false);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);
  const [dismissedWarning, setDismissedWarning] = useState<string | null>(null);
  const [centerView, setCenterView] = useState<CenterView>("map");
  const [caseSearch, setCaseSearch] = useState("");
  const [caseFilters, setCaseFilters] = useState<CaseFilters>(defaultCaseFilters);
  const [caseSort, setCaseSort] = useState<CaseSortState>({ key: "updatedAt", direction: "desc" });
  const [focusedTaskId, setFocusedTaskId] = useState<string | undefined>(undefined);
  const [priorityChangeCaseId, setPriorityChangeCaseId] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isCaseSaveLocked, setIsCaseSaveLocked] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [leaveDialogSaving, setLeaveDialogSaving] = useState(false);
  const [leaveDialogError, setLeaveDialogError] = useState<string | null>(null);
  const [leaveAfterSave, setLeaveAfterSave] = useState(false);
  const pendingNavigationRef = useRef<(() => void) | null>(null);
  const saveCaseDraftRef = useRef<SaveCaseDraft | null>(null);
  const leaveObservedSavingRef = useRef(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const topBarsRef = useRef<HTMLDivElement>(null);
  const returnViewRef = useRef<View>("dispatch");
  const [markingNotificationId, setMarkingNotificationId] = useState<string | null>(null);
  const [isNotificationSyncing, setIsNotificationSyncing] = useState(false);
  const [lastNotificationSyncAt, setLastNotificationSyncAt] = useState<string | undefined>(undefined);
  const notificationSyncInFlight = useRef(false);
  const locationUpdateCursorRef = useRef(new Date(Date.now() - 30_000).toISOString());
  const locationUpdatePollInFlight = useRef(false);
  const callHistoryRefreshInFlight = useRef(false);
  const liveCallIdentityRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    consoleRef.current?.setAttribute("data-hydrated", "true");
  }, []);

  useEffect(() => {
    const topBars = topBarsRef.current;
    const consoleElement = consoleRef.current;

    if (!topBars || !consoleElement) {
      return;
    }

    const updateFixedTop = () => {
      consoleElement.style.setProperty("--dispatch-fixed-top", `${Math.ceil(topBars.getBoundingClientRect().bottom)}px`);
    };
    const observer = new ResizeObserver(updateFixedTop);

    updateFixedTop();
    observer.observe(topBars);
    window.addEventListener("resize", updateFixedTop);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateFixedTop);
    };
  }, []);

  // Browser telefón (webphone) žije na úrovni celej konzoly, takže je pripojený a
  // vie prijať hovor v ktoromkoľvek pohľade, nielen v Ústredni.
  const [webphoneConfig, setWebphoneConfig] = useState<ViptelWebphoneConfig | null>(null);
  const [telephonyIdentity, setTelephonyIdentity] = useState<ViptelTelephonyIdentity | null>(null);
  const [telephonyPresence, setTelephonyPresence] = useState<TelephonyPresenceSnapshot | null>(null);
  const [workplaceSelection, setWorkplaceSelection] = useState<WorkplaceSelectionSnapshot | null>(null);
  const [workplaceSelectionError, setWorkplaceSelectionError] = useState<string | null>(null);
  const [workplaceTakeover, setWorkplaceTakeover] = useState<WorkplaceTakeoverSnapshot | null>(null);
  const [workplaceTakeoverError, setWorkplaceTakeoverError] = useState<string | null>(null);
  const [workplaceTakeoverResponsePending, setWorkplaceTakeoverResponsePending] = useState<"accept" | "decline" | null>(null);
  const [workplaceBrowserInstanceId] = useState(() => createWorkplaceBrowserInstanceId());
  const [workplaceLease, setWorkplaceLease] = useState<WorkplaceLease | null>(null);
  const [workplaceLeaseSessionReady, setWorkplaceLeaseSessionReady] = useState(false);
  /**
   * Mirror of `workplaceLeaseSessionReady` for the heartbeat effect.
   *
   * That effect both reads and writes this flag. Having it in the dependency
   * array made every write tear the effect down and rebuild it -- including the
   * heartbeat Worker, which pulses immediately on start, so each flip cost an
   * extra `POST /api/telephony/workplace-presence`. Reading through a ref keeps
   * the value current without restarting the loop.
   */
  const workplaceLeaseSessionReadyRef = useRef(false);
  const [workplaceLeaderElectionEnabled, setWorkplaceLeaderElectionEnabled] = useState(false);
  const [workplaceLeaderRecoveryArmed, setWorkplaceLeaderRecoveryArmed] = useState(false);
  const [workplacePendingRecoveryComplete, setWorkplacePendingRecoveryComplete] = useState(false);
  const [workplaceInitialRecoverySettled, setWorkplaceInitialRecoverySettled] = useState(false);
  const [workplacePhoneTransitionActive, setWorkplacePhoneTransitionActive] = useState(false);
  const [workplaceAutoConnectSuppressed, setWorkplaceAutoConnectSuppressed] = useState(false);
  const [workplaceLeaderBinding, setWorkplaceLeaderBinding] = useState<{
    leaseId: string | null;
    state: WorkplaceDocumentLeaderState;
  }>({ leaseId: null, state: "stopped" });
  const [workplaceLeaseNotice, setWorkplaceLeaseNotice] = useState<string | null>(null);
  const [workplaceRecoveryRequired, setWorkplaceRecoveryRequired] = useState(false);
  const workplaceActorProfileId = viewerProfileId ?? telephonyPresence?.actorProfileId ?? "";
  const workplaceLeaderRef = useRef<WorkplaceDocumentLeader | null>(null);
  const workplaceLeaseIdRef = useRef<string | null>(null);
  const workplaceHeartbeatLeaseRef = useRef<WorkplaceLease | null>(null);
  const workplaceHeartbeatSuspendedRef = useRef(false);
  const workplaceDurableMutationRef = useRef(false);
  const workplaceAvailabilityRecoveryRef = useRef<Promise<void> | null>(null);
  const workplacePriorityAutoRecoveryRef = useRef(new Map<string, number>());
  const workplaceAutoConnectSuppressionDepthRef = useRef(0);
  const workplaceRecoveryStartedRef = useRef(false);
  const workplaceTakeoverRefreshInFlightRef = useRef(false);
  /**
   * Read by the takeover poll's timer callback to decide its cadence. Held in a
   * ref so a status change re-times the next tick without restarting the whole
   * polling effect on every snapshot.
   */
  const workplaceTakeoverIsOpenRef = useRef(false);
  const workplaceTakeoverAutoClaimRef = useRef<WorkplaceTakeoverAutoAttempt | null>(null);
  const workplaceTakeoverAutoReleaseRef = useRef<WorkplaceTakeoverAutoAttempt | null>(null);
  const workplaceAutoAvailabilityRef = useRef(new Set<string>());
  const workplaceSelectionRequestRef = useRef<WorkplaceSelectionRequest | null>(null);
  const incomingDeclineRequestRef = useRef<Promise<void> | null>(null);
  const [incomingDeclinePending, setIncomingDeclinePending] = useState(false);
  const activeWorkplaceLeaseId = workplaceLease?.leaseId;
  // Leadership belongs to one exact server lease. During a same-seat reclaim
  // `activeWorkplaceLeaseId` changes one render before the old leader effect is
  // torn down. Never let that stale `leader` value authorize a phone session,
  // heartbeat, or recovery decision for the newly issued lease.
  const workplaceLeaderState: WorkplaceDocumentLeaderState = activeWorkplaceLeaseId
    ? workplaceLeaderBinding.leaseId === activeWorkplaceLeaseId
      ? workplaceLeaderBinding.state
      : "starting"
    : "stopped";
  const beginWorkplaceAutoConnectSuppression = useCallback(() => {
    workplaceAutoConnectSuppressionDepthRef.current += 1;
    if (workplaceAutoConnectSuppressionDepthRef.current === 1) {
      setWorkplaceAutoConnectSuppressed(true);
    }
  }, []);
  const endWorkplaceAutoConnectSuppression = useCallback(() => {
    workplaceAutoConnectSuppressionDepthRef.current = Math.max(
      0,
      workplaceAutoConnectSuppressionDepthRef.current - 1,
    );
    if (workplaceAutoConnectSuppressionDepthRef.current === 0) {
      setWorkplaceAutoConnectSuppressed(false);
    }
  }, []);
  workplaceHeartbeatLeaseRef.current = workplaceLease;
  const [presenceProbe, setPresenceProbe] = useState<TelephonyHealthSignal>({
    state: "checking",
    detail: "Kontrolujem registrácie a dostupnosť operátorov.",
  });
  const actorOwnedNumbers = new Set(
    (telephonyPresence?.extensions ?? [])
      .filter((extension) => extension.profileId === telephonyPresence?.actorProfileId)
      .map((extension) => extension.extension),
  );
  const actorOwnershipKey = [...actorOwnedNumbers].sort((left, right) => left.localeCompare(right, "en", { numeric: true })).join(",");
  const hotdeskContractActive = Boolean(workplaceSelection?.seats.some((seat) =>
    ["free", "stale", "active", "transitioning", "unknown"].includes(seat.status),
  ));
  const workplaceLeaseOwnsSelection = Boolean(
    workplacePendingRecoveryComplete &&
    workplaceLease &&
    workplaceLease.extension === workplaceSelection?.selection.extension &&
    workplaceLeaseSessionReady &&
    workplaceLeaderState === "leader",
  );
  useEffect(() => {
    if (!hotdeskContractActive || !workplaceSelection?.selection.extension || workplaceLeaseOwnsSelection) {
      setWorkplaceRecoveryRequired(false);
    }
  }, [hotdeskContractActive, workplaceLeaseOwnsSelection, workplaceSelection?.selection.extension]);
  const webphoneExtensions = (webphoneConfig?.extensions ?? []).filter(
    (extension) =>
      (!telephonyPresence || actorOwnedNumbers.has(extension.extension)) &&
      (!workplaceSelection || extension.extension === workplaceSelection.selection.extension) &&
      (!hotdeskContractActive || workplaceLeaseOwnsSelection),
  );
  const effectiveWebphoneConfig = useMemo<ViptelWebphoneConfig | null>(
    () => webphoneConfig ? { ...webphoneConfig, extensions: webphoneExtensions } : null,
    // `actorOwnershipKey` captures ownership changes without depending on the newly-created Set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actorOwnershipKey, hotdeskContractActive, webphoneConfig, workplaceLeaseOwnsSelection, workplaceSelection?.selection.extension],
  );
  // Browser používa iba kanonickú klapku priradenú prihlásenému profilu.
  const canonicalDefaultExtension = [...actorOwnedNumbers].sort((left, right) => left.localeCompare(right, "en", { numeric: true }))[0];
  const selectedWebphoneExtension =
    webphoneExtensions.find((extension) => extension.extension === canonicalDefaultExtension)?.extension ??
    webphoneExtensions[0]?.extension ??
    "";
  const workplacePhoneMutationPending = hotdeskContractActive && (
    workplaceAutoConnectSuppressed ||
    workplacePhoneTransitionActive ||
    !workplacePendingRecoveryComplete
  );
  const webphoneAvailable = isViptelWebphoneReadyForBrowser(effectiveWebphoneConfig, selectedWebphoneExtension);
  const defaultExtension = selectedWebphoneExtension || canonicalDefaultExtension || telephonyIdentity?.defaultExtension || "";
  const workplaceDefaultExtension = workplaceSelection
    ? workplaceSelection.selection.extension ?? ""
    : defaultExtension;
  const [activeCallsProbe, setActiveCallsProbe] = useState<TelephonyHealthSignal>({
    state: "checking",
    detail: "Kontrolujem VIPTel active-calls REST API.",
  });
  const workplaceWebphoneFence = useMemo(
    () => workplaceLeaseOwnsSelection && workplaceLease
      ? {
          assignmentGeneration: workplaceLease.assignmentGeneration,
          browserInstanceId: workplaceBrowserInstanceId,
          leaderEpoch: workplaceLease.leaderEpoch,
          leaseId: workplaceLease.leaseId,
          leaseVersion: workplaceLease.leaseVersion,
        }
      : undefined,
    [workplaceBrowserInstanceId, workplaceLease, workplaceLeaseOwnsSelection],
  );
  const browserWebphone = useViptelBrowserWebphone(
    effectiveWebphoneConfig,
    selectedWebphoneExtension,
    workplaceWebphoneFence,
    { suspendExtensionSelection: workplacePhoneMutationPending },
  );
  const connectBrowserWebphone = browserWebphone.connect;
  const disconnectBrowserWebphone = browserWebphone.disconnect;
  const disconnectAllBrowserWebphone = browserWebphone.disconnectAll;
  const disconnectWorkplaceBrowserWebphone = useCallback(async () => {
    const outcome = await disconnectAllBrowserWebphone();
    assertHotdeskWebphoneDisconnectConfirmed(outcome);
    return outcome;
  }, [disconnectAllBrowserWebphone]);
  const browserRegistrationStatus = browserWebphone.registrationStatus;
  const autoConnectExtensionRef = useRef<string | null>(null);
  const [takeoverPhoneExtension, setTakeoverPhoneExtension] = useState<string | null>(null);
  const takeoverPhoneHandshakeRef = useRef<TakeoverPhoneHandshake | null>(null);

  // Jeden potvrdený vlastník dostane iba jeden automatický pokus o SIP session.
  // Ref zámerne neresetujeme pri dočasnom výpadku config/presence: inak by polling
  // po chybe nevedomky spustil retry. Reset nastane až po skutočnom uvoľnení miesta.
  useEffect(() => {
    if (!workplaceSelection?.selection.extension) {
      autoConnectExtensionRef.current = null;
    }
  }, [workplaceSelection?.selection.extension]);

  useEffect(() => {
    const confirmedExtension = workplaceSelection?.selection.extension ?? "";
    if (
      !selectedWebphoneExtension ||
      confirmedExtension !== selectedWebphoneExtension ||
      !webphoneAvailable ||
      workplacePhoneTransitionActive ||
      workplaceAutoConnectSuppressed ||
      browserRegistrationStatus !== "idle" ||
      autoConnectExtensionRef.current === selectedWebphoneExtension
    ) {
      return;
    }

    autoConnectExtensionRef.current = selectedWebphoneExtension;
    void connectBrowserWebphone();
  }, [
    browserRegistrationStatus,
    connectBrowserWebphone,
    selectedWebphoneExtension,
    webphoneAvailable,
    workplaceAutoConnectSuppressed,
    workplacePhoneTransitionActive,
    workplaceSelection?.selection.extension,
  ]);

  const refreshWebphoneConfig = useCallback(async (signal?: AbortSignal) => {
    const response = await telephonyFetch("/api/telephony/webphone/config", {
      label: "konfigurácia telefónu",
      signal,
      timeoutMs: TELEPHONY_TIMEOUT_MS.read,
    });
    const result = (await response.json().catch(() => null)) as {
      error?: string;
      ok?: boolean;
      config?: ViptelWebphoneConfig;
      identity?: ViptelTelephonyIdentity;
    } | null;
    if (!response.ok || !result?.ok || !result.config) {
      throw new Error(result?.error ?? "Konfiguráciu telefónu v prehliadači sa nepodarilo obnoviť.");
    }
    setWebphoneConfig(result.config);
    setTelephonyIdentity(result.identity ?? null);
    return result.config;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshWebphoneConfig(controller.signal).catch(() => {
      // Bez konfigurácie ostane browser telefón bezpečne nedostupný.
    });
    return () => controller.abort();
  }, [actorOwnershipKey, refreshWebphoneConfig]);

  const phone = describePhoneState(browserWebphone.registrationStatus, browserWebphone.callStatus, browserWebphone.mode);

  // Rad operátora vždy určuje serverový plán osobných klapiek, nie poradie položiek z VIPTel API.
  const [actorRouting, setActorRouting] = useState<ActorDispatchRouting | null>(null);
  const [routingDiagnostic, setRoutingDiagnostic] = useState<string | null>(null);
  const [queueStatus, setQueueStatus] = useState<ViptelQueueStatus | null>(null);
  const [queueCommandPending, setQueueCommandPending] = useState(false);
  const [queueCommandTarget, setQueueCommandTarget] = useState<TelephonyAvailabilityAction | null>(null);
  const queueCommandPendingRef = useRef(false);
  const presenceRequestRef = useRef<TelephonyPresenceRequest | null>(null);
  const latestAcceptedPresenceAt = useRef(0);

  const refreshTelephonyPresence = useCallback((mode: TelephonyPresenceRefreshMode = "poll") => {
    const forceProviderRefresh = mode === "provider_fresh";
    const requestKind = mode === "provider" || forceProviderRefresh ? "provider" : "stored";
    const currentRequest = presenceRequestRef.current;
    if (currentRequest) {
      const canReuseCurrent = !forceProviderRefresh && (mode === "poll" || (
        currentRequest.kind === "provider" && (mode === "provider" || mode === "stored")
      ));
      if (canReuseCurrent) {
        return currentRequest.promise;
      }

      presenceRequestRef.current = null;
      currentRequest.controller.abort();
    }

    const controller = new AbortController();
    const token = Symbol(`telephony-presence-${requestKind}`);
    const timeoutId = window.setTimeout(() => controller.abort(), TELEPHONY_READ_TIMEOUT_MS);
    const isCurrentRequest = () => presenceRequestRef.current?.token === token;
    const showNotice = requestKind === "provider";

    const promise = Promise.resolve().then(async () => {
      try {
        const requestProviderRefresh = requestKind === "provider";
        const response = await fetch(
          forceProviderRefresh ? "/api/telephony/presence?fresh=1" : "/api/telephony/presence",
          {
            method: requestProviderRefresh ? "POST" : "GET",
            headers: requestProviderRefresh ? { "Content-Type": "application/json" } : undefined,
            signal: controller.signal,
          },
        );
        const result = (await response.json().catch(() => null)) as {
          error?: string;
          ok?: boolean;
          source?: "provider_refresh" | "stored";
          snapshot?: TelephonyPresenceSnapshot;
          actorRouting?: ActorDispatchRouting | null;
          routingDiagnostic?: string | null;
        } | null;

        if (!response.ok || !result?.ok || !result.snapshot) {
          throw new Error(result?.error ?? (requestProviderRefresh
            ? "VIPTel registrácie a rady sa nepodarilo obnoviť."
            : "Uložený stav VIPTel registrácií a radov sa nepodarilo načítať."));
        }
        if (!isCurrentRequest()) return;

        const snapshot = result.snapshot;
        const snapshotTime = Date.parse(snapshot.checkedAt);
        const latestAcceptedTime = latestAcceptedPresenceAt.current;
        const olderThanAccepted = result.source === "stored" && latestAcceptedTime > 0 && (
          !Number.isFinite(snapshotTime) || snapshotTime < latestAcceptedTime
        );
        if (olderThanAccepted) {
          if (Date.now() - latestAcceptedTime > TELEPHONY_PROBE_STALE_AFTER_MS) {
            setPresenceProbe((current) => ({
              state: "stale",
              detail: "Posledný overený VIPTel stav je starší než 30 sekúnd. Pred uložením ho obnovte.",
              checkedAt: new Date().toISOString(),
              lastSuccessAt: current.lastSuccessAt,
            }));
          }
          return;
        }
        const storedSnapshotStale = result.source === "stored" && (
          !Number.isFinite(snapshotTime) ||
          Date.now() - snapshotTime > TELEPHONY_PROBE_STALE_AFTER_MS
        );
        if (Number.isFinite(snapshotTime)) {
          latestAcceptedPresenceAt.current = Math.max(latestAcceptedTime, snapshotTime);
        }
        setTelephonyPresence(snapshot);
        setActorRouting(result.actorRouting ?? null);
        setRoutingDiagnostic(result.routingDiagnostic ?? null);
        setQueueStatus(
          result.actorRouting
            ? snapshot.queueStatuses.find((status) => status.queue === result.actorRouting?.queue) ?? null
            : null,
        );
        setPresenceProbe({
          state: storedSnapshotStale ? "stale" : "live",
          detail: storedSnapshotStale
            ? "Zobrazený je posledný uložený VIPTel stav; živé obnovenie nie je aktuálne."
            : result.source === "stored"
              ? "Uložený VIPTel stav je čerstvý."
              : "Registrácie, vlastníctvo klapiek a rady sú aktuálne.",
          checkedAt: snapshot.checkedAt,
          lastSuccessAt: snapshot.checkedAt,
        });
        if (showNotice) {
          setMutationNotice("VIPTel klapky, registrácie a rady boli obnovené.");
        }
        return snapshot;
      } catch (error) {
        if (!isCurrentRequest()) return;
        const checkedAt = new Date().toISOString();
        const detail = isAbortError(error)
          ? "Načítanie VIPTel registrácií a radov prekročilo časový limit. Skúsime to znova automaticky."
          : error instanceof Error
            ? error.message
            : "VIPTel registrácie a rady sa nepodarilo načítať.";
        setActorRouting(null);
        setRoutingDiagnostic(detail);
        setQueueStatus(null);
        setPresenceProbe((current) => ({
          state: failedProbeState(current, checkedAt),
          detail,
          checkedAt,
          lastSuccessAt: current.lastSuccessAt,
        }));
        if (showNotice) {
          setMutationNotice(detail);
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (isCurrentRequest()) {
          presenceRequestRef.current = null;
        }
      }
    });

    presenceRequestRef.current = { controller, kind: requestKind, promise, token };
    return promise;
  }, []);

  const refreshWorkplaceSelection = useCallback((mode: WorkplaceSelectionRefreshMode = "poll") => {
    const currentRequest = workplaceSelectionRequestRef.current;
    if (currentRequest && mode === "poll") return currentRequest.promise;
    if (currentRequest) {
      workplaceSelectionRequestRef.current = null;
      currentRequest.controller.abort();
    }

    const controller = new AbortController();
    const token = Symbol("workplace-selection");
    const timeoutId = window.setTimeout(() => controller.abort(), TELEPHONY_READ_TIMEOUT_MS);
    const isCurrentRequest = () => workplaceSelectionRequestRef.current?.token === token;
    const promise = Promise.resolve().then(async () => {
      try {
        const response = await fetch("/api/telephony/workplace-selection", {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = (await response.json().catch(() => null)) as {
          error?: string;
          ok?: boolean;
          workplace?: WorkplaceSelectionSnapshot;
        } | null;
        if (!response.ok || !result?.ok || !result.workplace) {
          throw new Error(result?.error ?? "Dostupnosť pracovných miest sa nepodarilo načítať.");
        }
        if (!isCurrentRequest()) return result.workplace;

        setWorkplaceSelection(result.workplace);
        const lease = normalizeWorkplaceLease(result.workplace.lease);
        if (lease) {
          setWorkplaceLeaderElectionEnabled(true);
          if (workplaceLeaseIdRef.current !== lease.leaseId) {
            workplaceLeaseIdRef.current = lease.leaseId;
            setWorkplaceLeaseSessionReady(false);
          }
          workplaceHeartbeatLeaseRef.current = lease;
          setWorkplaceLease(lease);
        } else if (
          !result.workplace.selection.extension ||
          result.workplace.seats.some((seat) => ["free", "stale", "active", "transitioning", "unknown"].includes(seat.status))
        ) {
          setWorkplaceLease(null);
          workplaceLeaseIdRef.current = null;
          workplaceHeartbeatLeaseRef.current = null;
          setWorkplaceLeaseSessionReady(false);
        }
        setWorkplaceSelectionError(null);
        return result.workplace;
      } catch (error) {
        if (!isCurrentRequest()) throw error;
        const message = isAbortError(error)
          ? "Načítanie pracovných miest prekročilo časový limit. Skúsime to znova automaticky."
          : error instanceof Error
            ? error.message
            : "Dostupnosť pracovných miest sa nepodarilo načítať.";
        setWorkplaceSelectionError(message);
        throw error;
      } finally {
        window.clearTimeout(timeoutId);
        if (isCurrentRequest()) workplaceSelectionRequestRef.current = null;
      }
    });

    workplaceSelectionRequestRef.current = { controller, promise, token };
    return promise;
  }, []);

  const refreshWorkplaceTakeover = useCallback(async () => {
    if (workplaceTakeoverRefreshInFlightRef.current) return;
    workplaceTakeoverRefreshInFlightRef.current = true;
    try {
      const response = await telephonyFetch("/api/telephony/workplace-takeover", {
        label: "žiadosti o pracoviská",
        timeoutMs: TELEPHONY_TIMEOUT_MS.read,
      });
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        ok?: boolean;
        takeover?: WorkplaceTakeoverSnapshot;
      } | null;
      if (!response.ok || !result?.ok || !result.takeover) {
        throw new Error(result?.error ?? "Žiadosti o pracoviská sa nepodarilo načítať.");
      }
      setWorkplaceTakeover(result.takeover);
      setWorkplaceTakeoverError(null);
      return result.takeover;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Žiadosti o pracoviská sa nepodarilo načítať.";
      setWorkplaceTakeoverError(message);
      throw error;
    } finally {
      workplaceTakeoverRefreshInFlightRef.current = false;
    }
  }, []);

  const mutateWorkplaceTakeover = useCallback(async (
    action: "cancel" | "complete" | "request" | "respond",
    input: { decision?: "accept" | "decline"; extension?: string; requestId?: string } = {},
  ) => {
    const response = await telephonyFetch("/api/telephony/workplace-takeover", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...input }),
      label: "žiadosť o pracovné miesto",
      timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
    });
    const result = (await response.json().catch(() => null)) as WorkplaceTakeoverMutationResponse | null;
    if (!response.ok || !result?.ok || !result.snapshot) {
      throw new Error(result?.error ?? "Žiadosť o pracovné miesto sa nepodarilo spracovať.");
    }
    setWorkplaceTakeover(result.snapshot);
    setWorkplaceTakeoverError(null);
    return result;
  }, []);

  const executePendingWorkplaceResume = useCallback(async (
    initialPending: WorkplacePendingResume,
  ): Promise<WorkplaceResumeResult> => {
    let pending = initialPending;
    let lastMessage = "Obnovenie relácie pracoviska čaká na potvrdenie servera.";
    for (let localAttempt = 0; localAttempt < WORKPLACE_EXACT_REQUEST_ATTEMPTS_PER_RUN; localAttempt += 1) {
      const stored = readWorkplacePendingResume();
      if (stored && sameWorkplacePendingResume(stored, pending)) pending = stored;
      if (pending.attempts >= WORKPLACE_EXACT_REQUEST_MAX_ATTEMPTS) {
        throw new WorkplaceMutationContinuityError(
          "Reláciu pracoviska sa nepodarilo bezpečne obnoviť ani po opakovaní. Nevyberaj miesto znova; obnov stránku alebo kontaktuj správcu.",
        );
      }
      pending = { ...pending, attempts: pending.attempts + 1 };
      storeWorkplacePendingResume(pending);

      try {
        const response = await telephonyFetch("/api/telephony/workplace-presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(workplacePendingResumeInput(pending)),
          label: "obnovenie relácie pracoviska",
          timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
        });
        const result = await response.json().catch(() => null) as unknown;
        const outcome = classifyWorkplacePresenceResponse(response.status, result);
        if (outcome.kind === "lease_lost") {
          clearWorkplacePendingResume();
          return { kind: "lease_lost", message: outcome.message };
        }
        if (outcome.kind === "confirmed" && outcome.lease && outcome.resumeSecret) {
          const credentialPersisted = storeWorkplaceResumeCredential(
            outcome.lease.leaseId,
            pending.browserInstanceId,
            outcome.resumeSecret,
          );
          workplaceLeaseIdRef.current = outcome.lease.leaseId;
          workplaceHeartbeatLeaseRef.current = outcome.lease;
          setWorkplaceLease(outcome.lease);
          setWorkplaceLeaseSessionReady(pending.browserInstanceId === workplaceBrowserInstanceId);
          setWorkplaceLeaseNotice(null);
          clearWorkplacePendingResume({ persistent: credentialPersisted });
          if (credentialPersisted) clearWorkplacePendingMutation();
          return { credentialPersisted, kind: "confirmed", lease: outcome.lease };
        }
        lastMessage = outcome.kind === "confirmed"
          ? "Server nepotvrdil úplné údaje obnovenej relácie pracoviska."
          : outcome.message;
      } catch (error) {
        lastMessage = error instanceof Error
          ? error.message
          : "Odpoveď servera pri obnove relácie sa stratila.";
      }

      if (localAttempt + 1 < WORKPLACE_EXACT_REQUEST_ATTEMPTS_PER_RUN) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250 * (localAttempt + 1)));
      }
    }
    throw new WorkplaceMutationContinuityError(
      `${lastMessage} Presná požiadavka zostala uložená; obnov stránku a systém ju zopakuje bez vytvorenia novej relácie.`,
    );
  }, [workplaceBrowserInstanceId]);

  const handleWorkplaceLeaseLost = useCallback(async (leaseId: string, message: string) => {
    clearWorkplacePendingResume();
    clearWorkplaceResumeCredential(leaseId);
    workplaceLeaderRef.current?.announceLeaseLost();
    setWorkplaceLease(null);
    workplaceLeaseIdRef.current = null;
    workplaceHeartbeatLeaseRef.current = null;
    setWorkplaceLeaseSessionReady(false);
    setWorkplaceLeaseNotice(message);
    await disconnectBrowserWebphone();
    await Promise.allSettled([refreshWorkplaceSelection(), refreshWebphoneConfig()]);
  }, [disconnectBrowserWebphone, refreshWebphoneConfig, refreshWorkplaceSelection]);

  useEffect(() => {
    workplaceLeaderRef.current?.stop();
    workplaceLeaderRef.current = null;
    if (!workplaceLeaderElectionEnabled || !activeWorkplaceLeaseId) {
      setWorkplaceLeaderBinding({ leaseId: null, state: "stopped" });
      return;
    }

    const leader = new WorkplaceDocumentLeader({
      browserInstanceId: workplaceBrowserInstanceId,
      leaseId: activeWorkplaceLeaseId,
    });
    workplaceLeaderRef.current = leader;
    const unsubscribe = leader.subscribe((state) => {
      if (workplaceLeaderRef.current !== leader) return;
      setWorkplaceLeaderBinding((current) => (
        current.leaseId === activeWorkplaceLeaseId && current.state === state
          ? current
          : { leaseId: activeWorkplaceLeaseId, state }
      ));
    });
    leader.start();
    return () => {
      unsubscribe();
      leader.stop();
      if (workplaceLeaderRef.current === leader) workplaceLeaderRef.current = null;
    };
  }, [activeWorkplaceLeaseId, workplaceBrowserInstanceId, workplaceLeaderElectionEnabled]);

  useEffect(() => {
    if (!workplaceLeaderElectionEnabled || !workplaceLeaderRecoveryArmed) return;
    if (!activeWorkplaceLeaseId) {
      setWorkplacePendingRecoveryComplete(true);
      setWorkplaceLeaderRecoveryArmed(false);
      return;
    }
    if (workplaceLeaderState === "leader" || workplaceLeaderState === "follower") {
      setWorkplacePendingRecoveryComplete(true);
      setWorkplaceLeaderRecoveryArmed(false);
    }
  }, [activeWorkplaceLeaseId, workplaceLeaderElectionEnabled, workplaceLeaderRecoveryArmed, workplaceLeaderState]);

  useEffect(() => {
    if (
      !hotdeskContractActive ||
      !workplaceSelection?.selection.extension ||
      workplaceLeaderState !== "follower" ||
      browserWebphone.registrationStatus === "idle"
    ) {
      return;
    }
    void disconnectBrowserWebphone();
  }, [browserWebphone.registrationStatus, disconnectBrowserWebphone, hotdeskContractActive, workplaceLeaderState, workplaceSelection?.selection.extension]);

  useEffect(() => {
    if (
      !workplacePendingRecoveryComplete ||
      !activeWorkplaceLeaseId ||
      workplaceLeaderState !== "leader" ||
      workplaceHeartbeatSuspendedRef.current
    ) return;
    const leaseAtStart = workplaceHeartbeatLeaseRef.current;
    if (!leaseAtStart || leaseAtStart.leaseId !== activeWorkplaceLeaseId) return;
    let stopped = false;
    let inFlight = false;

    const sendPresence = async () => {
      if (stopped || inFlight || workplaceHeartbeatSuspendedRef.current) return;
      let currentLease = workplaceHeartbeatLeaseRef.current;
      if (!currentLease || currentLease.leaseId !== activeWorkplaceLeaseId) return;
      inFlight = true;
      try {
        for (let resumeStep = 0; resumeStep < 2; resumeStep += 1) {
          const credential = readWorkplaceResumeCredential(activeWorkplaceLeaseId);
          let pendingResume = readWorkplacePendingResume();
          if (pendingResume && !workplacePendingBelongsToViewer(
            pendingResume,
            workplaceActorProfileId,
            viewerOrganizationId,
          )) {
            clearWorkplaceResumeCredential(pendingResume.leaseId);
            clearWorkplacePendingResume();
            pendingResume = null;
            setWorkplaceLeaseSessionReady(false);
            setWorkplaceLeaseNotice(
              "Rozpracované obnovenie patrilo inému používateľovi. Telefón zostáva bezpečne odpojený.",
            );
            await disconnectBrowserWebphone();
            return;
          }
          const needsResume = Boolean(
            pendingResume ||
            !workplaceLeaseSessionReadyRef.current ||
            (credential && credential.browserInstanceId !== workplaceBrowserInstanceId),
          );
          if (!needsResume) break;
          if (!pendingResume) {
            if (!credential) {
              setWorkplaceLeaseSessionReady(false);
              setWorkplaceRecoveryRequired(true);
              setWorkplaceLeaseNotice(
                "Predchádzajúce okno zostalo priradené k pracovnému miestu. Obnov ho jedným kliknutím; telefón dovtedy zostáva bezpečne odpojený.",
              );
              await disconnectBrowserWebphone();
              return;
            }
            if (!workplaceActorProfileId) {
              setWorkplaceLeaseSessionReady(false);
              setWorkplaceLeaseNotice("Prihláseného operátora sa nepodarilo overiť. Telefón zostáva bezpečne odpojený.");
              await disconnectBrowserWebphone();
              return;
            }
            pendingResume = {
              actorProfileId: workplaceActorProfileId,
              assignmentGeneration: currentLease.assignmentGeneration,
              attempts: 0,
              browserInstanceId: workplaceBrowserInstanceId,
              createdAt: Date.now(),
              idempotencyKey: workplaceBrowserInstanceId,
              leaderEpoch: currentLease.leaderEpoch,
              leaseId: activeWorkplaceLeaseId,
              leaseVersion: currentLease.leaseVersion,
              ...(viewerOrganizationId ? { organizationId: viewerOrganizationId } : {}),
              resumeSecret: credential.resumeSecret,
            };
            storeWorkplacePendingResume(pendingResume);
          }
          const exactPendingResume = pendingResume;
          const resumed = await executePendingWorkplaceResume(exactPendingResume);
          if (resumed.kind === "lease_lost") {
            await handleWorkplaceLeaseLost(activeWorkplaceLeaseId, resumed.message);
            return;
          }
          currentLease = resumed.lease;
          if (stopped || exactPendingResume.browserInstanceId === workplaceBrowserInstanceId) return;
        }

        const body = {
          assignmentGeneration: currentLease.assignmentGeneration,
          browserInstanceId: workplaceBrowserInstanceId,
          leaderEpoch: currentLease.leaderEpoch,
          leaseId: activeWorkplaceLeaseId,
          leaseVersion: currentLease.leaseVersion,
        };
        const response = await telephonyFetch("/api/telephony/workplace-presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          label: "heartbeat pracoviska",
          // Must finish well inside the 15 s heartbeat interval so a stalled
          // beat cannot pile up behind the next one.
          timeoutMs: TELEPHONY_TIMEOUT_MS.read,
        });
        const result = await response.json().catch(() => null) as unknown;
        if (stopped) return;
        const outcome = classifyWorkplacePresenceResponse(response.status, result);
        if (outcome.kind === "lease_lost") {
          await handleWorkplaceLeaseLost(activeWorkplaceLeaseId, outcome.message);
          return;
        }
        if (outcome.kind === "transitioning") {
          setWorkplaceLeaseNotice(outcome.message);
          return;
        }
        if (outcome.kind === "retryable") {
          setWorkplaceLeaseNotice(outcome.message);
          return;
        }
        setWorkplaceLeaseNotice(null);
        setWorkplaceLeaseSessionReady(true);
        autoConnectExtensionRef.current = null;
        if (outcome.lease) {
          workplaceLeaseIdRef.current = outcome.lease.leaseId;
          workplaceHeartbeatLeaseRef.current = outcome.lease;
          setWorkplaceLease(outcome.lease);
        }
        if (outcome.resumeSecret) {
          storeWorkplaceResumeCredential(
            outcome.lease?.leaseId ?? activeWorkplaceLeaseId,
            workplaceBrowserInstanceId,
            outcome.resumeSecret,
          );
        }
      } catch {
        if (!stopped) {
          setWorkplaceLeaseNotice("Prítomnosť pracovného miesta sa dočasne nepodarilo obnoviť. Skúsime to znova automaticky.");
        }
      } finally {
        inFlight = false;
      }
    };

    const stopHeartbeat = startWorkplaceHeartbeatLoop({
      intervalMs: leaseAtStart.heartbeatIntervalMs,
      pulse: () => void sendPresence(),
    });
    const onVisibilityChange = () => {
      // Renew once while the tab is being hidden as well as when it returns.
      // The worker clock then keeps the regular cadence without relying on
      // background-window timers, which browsers may throttle past the lease.
      void sendPresence();
    };
    const onPageAvailable = () => void sendPresence();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onPageAvailable);
    window.addEventListener("pageshow", onPageAvailable);
    return () => {
      stopped = true;
      stopHeartbeat();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onPageAvailable);
      window.removeEventListener("pageshow", onPageAvailable);
    };
  }, [
    disconnectBrowserWebphone,
    executePendingWorkplaceResume,
    handleWorkplaceLeaseLost,
    activeWorkplaceLeaseId,
    refreshWebphoneConfig,
    refreshWorkplaceSelection,
    workplaceBrowserInstanceId,
    // `workplaceLeaseSessionReady` is deliberately absent: this effect writes
    // it, so depending on it made the effect restart itself. It is read
    // through `workplaceLeaseSessionReadyRef` instead.
    workplaceLeaderState,
    workplacePendingRecoveryComplete,
    workplaceActorProfileId,
    viewerOrganizationId,
  ]);

  const finishTakeoverPhoneHandshake = useCallback((result: WorkplaceSelectionActionResult) => {
    const handshake = takeoverPhoneHandshakeRef.current;
    if (!handshake) return;
    window.clearTimeout(handshake.timeoutId);
    takeoverPhoneHandshakeRef.current = null;
    setTakeoverPhoneExtension((current) => current === handshake.extension ? null : current);
    handshake.resolve(result);
  }, []);

  const waitForTakenOverPhone = useCallback((extension: string, serverMessage?: string) => {
    const previous = takeoverPhoneHandshakeRef.current;
    if (previous) {
      window.clearTimeout(previous.timeoutId);
      previous.resolve(buildTakeoverPhoneHandshakeResult({
        extension: previous.extension,
        outcome: "failed",
      }));
    }

    return new Promise<WorkplaceSelectionActionResult>((resolve) => {
      const handshake: TakeoverPhoneHandshake = {
        extension,
        resolve,
        serverMessage,
        timeoutId: 0,
      };
      handshake.timeoutId = window.setTimeout(() => {
        if (takeoverPhoneHandshakeRef.current !== handshake) return;
        finishTakeoverPhoneHandshake(buildTakeoverPhoneHandshakeResult({
          extension,
          outcome: "timeout",
        }));
      }, TAKEOVER_PHONE_REGISTRATION_TIMEOUT_MS);
      takeoverPhoneHandshakeRef.current = handshake;
      setTakeoverPhoneExtension(extension);
    });
  }, [finishTakeoverPhoneHandshake]);

  useEffect(() => () => {
    const handshake = takeoverPhoneHandshakeRef.current;
    if (!handshake) return;
    window.clearTimeout(handshake.timeoutId);
    takeoverPhoneHandshakeRef.current = null;
    handshake.resolve(buildTakeoverPhoneHandshakeResult({
      extension: handshake.extension,
      outcome: "failed",
    }));
  }, []);

  useEffect(() => {
    const handshake = takeoverPhoneHandshakeRef.current;
    if (!handshake || handshake.extension !== takeoverPhoneExtension) return;
    if (
      workplaceSelection?.selection.extension !== handshake.extension ||
      selectedWebphoneExtension !== handshake.extension ||
      !webphoneAvailable
    ) {
      return;
    }

    if (
      browserRegistrationStatus === "failed" &&
      autoConnectExtensionRef.current === handshake.extension
    ) {
      finishTakeoverPhoneHandshake(buildTakeoverPhoneHandshakeResult({
        detail: browserWebphone.notice ?? undefined,
        extension: handshake.extension,
        outcome: "failed",
      }));
      return;
    }
    if (browserRegistrationStatus !== "registered") return;

    // SIP registration already finished with an accepted registrar response.
    // Do not block the workplace flow on a second REST snapshot of the same
    // fact. The routing operation performs its own fresh provider proof before
    // changing queues, while the normal presence effect refreshes the display.
    finishTakeoverPhoneHandshake(buildTakeoverPhoneHandshakeResult({
      extension: handshake.extension,
      outcome: "confirmed",
      serverMessage: handshake.serverMessage,
    }));
  }, [
    browserRegistrationStatus,
    browserWebphone.notice,
    finishTakeoverPhoneHandshake,
    selectedWebphoneExtension,
    takeoverPhoneExtension,
    webphoneAvailable,
    workplaceSelection?.selection.extension,
  ]);

  const mutateWorkplaceSelection = useCallback(async (
    action: WorkplaceSelectionMutationAction,
    input: {
      browserInstanceId?: string;
      assignmentGeneration?: string;
      expectedVersion?: string;
      extension?: string;
      idempotencyKey?: string;
      leaderEpoch?: number;
      leaseId?: string;
      leaseVersion?: number;
      operationId?: string;
      queue?: WorkplaceSelectionInput["queue"];
    } = {},
    options: { credentialBrowserInstanceId?: string } = {},
  ): Promise<WorkplaceMutationResult> => {
    // A periodic GET that started before this mutation must not be allowed to
    // repaint the UI with the old seat/lease after the PATCH has committed.
    const pendingRead = workplaceSelectionRequestRef.current;
    if (pendingRead) {
      workplaceSelectionRequestRef.current = null;
      pendingRead.controller.abort();
    }
    let response: Response;
    try {
      response = await telephonyFetch("/api/telephony/workplace-selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...input }),
        label: "zmena pracoviska",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
    } catch {
      // A timeout lands here on purpose. It is a lost response, not a failed
      // mutation: the server may have committed the seat change. The transport
      // error keeps the exact-request journal in charge of the safe replay,
      // which is why this must never be reported as terminal.
      throw new WorkplaceMutationTransportError("Odpoveď servera sa stratila. Bezpečne opakujeme tú istú požiadavku.");
    }
    const result = (await response.json().catch(() => null)) as WorkplaceSelectionMutationResponse | null;
    const overlappingRead = workplaceSelectionRequestRef.current;
    if (overlappingRead) {
      workplaceSelectionRequestRef.current = null;
      overlappingRead.controller.abort();
    }
    const disposition = classifyWorkplaceMutationResponse(response.status, result);
    if (disposition.kind === "transport_ambiguous") {
      throw new WorkplaceMutationTransportError(
        disposition.message ?? "Server nepotvrdil výsledok zmeny. Bezpečne opakujeme tú istú požiadavku.",
      );
    }
    if (disposition.kind === "convergence_pending") {
      throw new WorkplaceMutationProviderPendingError(
        disposition.message ?? "VIPTel ešte dokončuje odpojenie telefónu.",
      );
    }
    if (disposition.kind === "terminal" || !response.ok || !result?.ok) {
      await refreshWorkplaceSelection("fresh").catch(() => undefined);
      throw new WorkplaceMutationTerminalError(
        (disposition.kind === "terminal" ? disposition.message : undefined) ??
        result?.error ??
        "Pracovné miesto sa nepodarilo zmeniť.",
        disposition.kind === "terminal" ? disposition.code : undefined,
      );
    }
    if (result.workplace) {
      setWorkplaceSelection(result.workplace);
      setWorkplaceSelectionError(null);
    }
    const lease = normalizeWorkplaceLease(result.lease ?? result.workplace?.lease) ?? undefined;
    const credentialBrowserInstanceId = options.credentialBrowserInstanceId ?? workplaceBrowserInstanceId;
    let resumeCredentialPersisted: boolean | undefined;
    if (lease) {
      setWorkplaceLeaderElectionEnabled(true);
      workplaceLeaseIdRef.current = lease.leaseId;
      workplaceHeartbeatLeaseRef.current = lease;
      setWorkplaceLease(lease);
      setWorkplaceLeaseSessionReady(credentialBrowserInstanceId === workplaceBrowserInstanceId);
      setWorkplaceLeaseNotice(null);
      if (result.resumeSecret) {
        resumeCredentialPersisted = storeWorkplaceResumeCredential(
          lease.leaseId,
          credentialBrowserInstanceId,
          result.resumeSecret,
        );
      } else {
        resumeCredentialPersisted = false;
      }
    } else if (result.workplace && !result.workplace.selection.extension) {
      workplaceLeaseIdRef.current = null;
      workplaceHeartbeatLeaseRef.current = null;
      setWorkplaceLease(null);
      setWorkplaceLeaseSessionReady(false);
    }

    if (result.result?.state === "disconnect_required") {
      return {
        message: result.result.message,
        operationId: result.result.operationId,
        lease,
        resumeCredentialPersisted,
        state: "disconnect_required" as const,
        workplace: result.workplace,
      };
    }

    if (response.status === 202) {
      const workplace = result.workplace;
      if (workplace?.routingStatus.state === "blocked") {
        throw new Error(workplace.routingStatus.message || "Poradie zvonenia sa nepodarilo aktivovať.");
      }
      if (workplace?.routingStatus.state === "active") {
        return {
          message: workplace.routingStatus.message || result.result?.message,
          state: "confirmed" as const,
          workplace,
        };
      }
      return {
        message: result.result?.message ?? "Zmena je uložená a VIPTel ju stále aktivuje. Stav sa bude ďalej automaticky obnovovať.",
        state: "pending" as const,
        workplace,
      };
    }

    return {
      message: result.result?.message,
      operationId: result.result?.operationId,
      lease,
      resumeCredentialPersisted,
      state: result.result?.state ?? "confirmed" as const,
      workplace: result.workplace,
    };
  }, [refreshWorkplaceSelection, workplaceBrowserInstanceId]);

  const recoverWorkplacePriority = useCallback(async (operationId: string) => {
    if (!workplaceWebphoneFence) {
      throw new Error("Aktívna relácia tohto pracovného miesta už nie je platná. Obnov pracovisko.");
    }
    const result = await mutateWorkplaceSelection("recover_priority", {
      operationId,
      ...workplaceWebphoneFence,
    });
    await Promise.allSettled([
      refreshWorkplaceSelection(),
      refreshTelephonyPresence("stored"),
    ]);
    return {
      message: result.message ?? "Obnova poradia bola spustená.",
      state: result.state,
    };
  }, [mutateWorkplaceSelection, refreshTelephonyPresence, refreshWorkplaceSelection, workplaceWebphoneFence]);

  // Primitives, so the auto-recovery effect below is not rescheduled by the
  // fresh routingStatus object that arrives with every poll.
  const routingStatusState = workplaceSelection?.routingStatus.state;
  const routingStatusCanRecover = workplaceSelection?.routingStatus.canRecover;
  const routingStatusOperationId = workplaceSelection?.routingStatus.operationId;

  useEffect(() => {
    if (
      routingStatusState !== "blocked" || !routingStatusCanRecover || !routingStatusOperationId ||
      !workplaceWebphoneFence || browserRegistrationStatus !== "registered"
    ) return;
    const recoveryKey = `${routingStatusOperationId}:${workplaceWebphoneFence.leaseId}`;
    if (workplacePriorityAutoRecoveryRef.current.has(recoveryKey)) return;
    const timeoutId = window.setTimeout(() => {
      if (workplacePriorityAutoRecoveryRef.current.has(recoveryKey)) return;
      pruneAutoRecoveryKeys(workplacePriorityAutoRecoveryRef.current);
      workplacePriorityAutoRecoveryRef.current.set(recoveryKey, 0);
      void (async () => {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          workplacePriorityAutoRecoveryRef.current.set(recoveryKey, attempt);
          try {
            await recoverWorkplacePriority(routingStatusOperationId);
            return;
          } catch {
            const latest = await refreshWorkplaceSelection().catch(() => null);
            if (
              attempt >= 2 || latest?.routingStatus.state !== "blocked" ||
              !latest.routingStatus.canRecover || latest.routingStatus.operationId !== routingStatusOperationId
            ) return;
            await new Promise<void>((resolve) => window.setTimeout(resolve, 1_500));
          }
        }
      })();
    }, 500);
    return () => window.clearTimeout(timeoutId);
  }, [
    browserRegistrationStatus,
    recoverWorkplacePriority,
    refreshWorkplaceSelection,
    // Primitives rather than the routingStatus object, which is replaced on
    // every poll and so rescheduled this timer continuously.
    routingStatusState,
    routingStatusCanRecover,
    routingStatusOperationId,
    workplaceWebphoneFence,
  ]);

  const executePendingWorkplaceMutation = useCallback(async (
    initialPending: WorkplacePendingMutation,
    options: { convergenceAttempts?: number } = {},
  ): Promise<WorkplaceMutationResult> => {
    let pending = initialPending;
    const convergenceAttempts = Math.max(
      1,
      Math.min(
        WORKPLACE_EXACT_REQUEST_ATTEMPTS_PER_RUN,
        options.convergenceAttempts ?? WORKPLACE_EXACT_REQUEST_ATTEMPTS_PER_RUN,
      ),
    );
    for (let localAttempt = 0; localAttempt < WORKPLACE_EXACT_REQUEST_ATTEMPTS_PER_RUN; localAttempt += 1) {
      const stored = readWorkplacePendingMutation();
      if (stored && sameWorkplacePendingRequest(stored, pending)) pending = stored;
      if (pending.attempts >= WORKPLACE_EXACT_REQUEST_MAX_ATTEMPTS) {
        throw new WorkplaceMutationContinuityError(
          "Výsledok zmeny sa nepodarilo bezpečne potvrdiť ani po opakovaní. Nevyberaj miesto znova; obnov stránku alebo kontaktuj správcu.",
        );
      }
      pending = { ...pending, attempts: pending.attempts + 1 };
      storeWorkplacePendingMutation(pending);
      try {
        return await mutateWorkplaceSelection(
          pending.action,
          workplacePendingMutationInput(pending),
          { credentialBrowserInstanceId: pending.browserInstanceId },
        );
      } catch (error) {
        if (error instanceof WorkplaceMutationProviderPendingError) {
          // A parsed 423 proves that the exact operation still exists and only
          // registrar convergence is pending. It is not a lost response and
          // must not consume the ambiguity retry budget stored in the journal.
          pending = { ...pending, attempts: Math.max(0, pending.attempts - 1) };
          storeWorkplacePendingMutation(pending);
          if (localAttempt + 1 >= convergenceAttempts) {
            throw new WorkplaceMutationConvergenceError(error.message);
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
          continue;
        }
        if (!(error instanceof WorkplaceMutationTransportError)) throw error;
        if (localAttempt + 1 >= WORKPLACE_EXACT_REQUEST_ATTEMPTS_PER_RUN) {
          throw new WorkplaceMutationContinuityError(
            "Odpoveď servera sa stratila. Presná požiadavka je bezpečne uložená; obnov stránku a dokončenie sa skontroluje bez novej zmeny.",
          );
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250 * (localAttempt + 1)));
      }
    }
    throw new WorkplaceMutationContinuityError("Výsledok zmeny pracovného miesta zostal nepotvrdený.");
  }, [mutateWorkplaceSelection]);

  const finishPendingWorkplaceMutation = useCallback((
    pending: WorkplacePendingMutation,
    result: WorkplaceMutationResult,
  ) => {
    if (pending.kind === "leave" && !result.workplace?.selection.extension && result.state === "confirmed") {
      clearWorkplacePendingMutation();
      return;
    }
    if (result.lease && result.state !== "disconnect_required") {
      clearWorkplacePendingMutation({ persistent: result.resumeCredentialPersisted === true });
    }
  }, []);

  const beginPendingWorkplaceMutation = useCallback((pending: WorkplacePendingMutation) => {
    const existing = readWorkplacePendingMutation();
    if (existing && !sameWorkplacePendingRequest(existing, pending)) {
      throw new WorkplaceMutationContinuityError(
        "Predchádzajúca zmena pracovného miesta ešte čaká na bezpečné potvrdenie. Obnov stránku; nevytváraj novú požiadavku.",
      );
    }
    storeWorkplacePendingMutation(existing ?? pending);
    return existing ?? pending;
  }, []);

  const refreshWorkplaceState = useCallback(async () => {
    const [workplaceResult] = await Promise.allSettled([
      refreshWorkplaceSelection(),
      refreshTelephonyPresence("stored"),
    ]);
    if (workplaceResult.status === "rejected") throw workplaceResult.reason;
    return workplaceResult.value;
  }, [refreshTelephonyPresence, refreshWorkplaceSelection]);

  const ensureWorkplaceMutationRecoveryReady = useCallback(async () => {
    if (workplacePendingRecoveryComplete && workplaceActorProfileId) {
      return { actorProfileId: workplaceActorProfileId, workplace: workplaceSelection };
    }
    if (
      workplaceDurableMutationRef.current ||
      readWorkplacePendingMutation() ||
      readWorkplacePendingResume()
    ) {
      throw new Error("Najprv počkaj na bezpečné obnovenie predchádzajúcej relácie pracoviska.");
    }

    // This is only a client hydration gate. The mutation endpoint performs
    // the authoritative fresh VIPTel proof under its resource lock, so doing
    // another live capture here duplicated latency without adding safety.
    const [storedPresence, workplace] = await Promise.all([
      refreshTelephonyPresence("stored"),
      refreshWorkplaceSelection(),
    ]);
    const currentActorProfileId = viewerProfileId ?? storedPresence?.actorProfileId;
    if (!storedPresence || !currentActorProfileId) {
      throw new Error("Aktuálny stav pracovísk sa nepodarilo overiť. Obnov dostupnosť a skús to znova.");
    }

    // No durable request existed and both authoritative reads completed. The
    // same first click may now continue instead of failing during the short
    // hydration/recovery window. An existing lease is reclaimed below through
    // the normal exact-once select flow.
    setWorkplacePendingRecoveryComplete(true);
    setWorkplaceLeaseNotice(null);
    return { actorProfileId: currentActorProfileId, workplace };
  }, [
    refreshTelephonyPresence,
    refreshWorkplaceSelection,
    viewerProfileId,
    workplaceActorProfileId,
    workplacePendingRecoveryComplete,
    workplaceSelection,
  ]);

  const claimHotdeskWorkplaceSeat = useCallback(async (
    extension: string,
    verifiedActorProfileId = workplaceActorProfileId,
    authoritativeWorkplace = workplaceSelection,
  ) => {
    let seat = authoritativeWorkplace?.seats.find((candidate) => candidate.extension === extension);
    let idempotencyKey = createWorkplaceBrowserInstanceId();
    let pending = beginPendingWorkplaceMutation({
      action: "select_seat",
      actorProfileId: verifiedActorProfileId,
      attempts: 0,
      browserInstanceId: workplaceBrowserInstanceId,
      createdAt: Date.now(),
      expectedVersion: seat?.version,
      extension,
      idempotencyKey,
      kind: "select",
      ...(viewerOrganizationId ? { organizationId: viewerOrganizationId } : {}),
      phase: "prepare",
    });
    workplaceDurableMutationRef.current = true;
    setWorkplacePendingRecoveryComplete(false);
    let result: WorkplaceMutationResult;
    try {
      result = await executePendingWorkplaceMutation(pending);
    } catch (error) {
      if (error instanceof WorkplaceMutationTerminalError && error.code === "workplace_precommit_aborted") {
        // This exact operation is proven rolled back. A fresh version/key can
        // safely complete the operator's original click once, without asking
        // them to repeat a request which no longer exists on the server.
        clearWorkplacePendingMutation();
        const refreshed = await refreshWorkplaceSelection("fresh");
        seat = refreshed.seats.find((candidate) => candidate.extension === extension);
        idempotencyKey = createWorkplaceBrowserInstanceId();
        pending = beginPendingWorkplaceMutation({
          action: "select_seat",
          actorProfileId: verifiedActorProfileId,
          attempts: 0,
          browserInstanceId: workplaceBrowserInstanceId,
          createdAt: Date.now(),
          expectedVersion: seat?.version,
          extension,
          idempotencyKey,
          kind: "select",
          ...(viewerOrganizationId ? { organizationId: viewerOrganizationId } : {}),
          phase: "prepare",
        });
        try {
          result = await executePendingWorkplaceMutation(pending);
        } catch (retryError) {
          if (!(retryError instanceof WorkplaceMutationContinuityError)) clearWorkplacePendingMutation();
          autoConnectExtensionRef.current = null;
          setWorkplacePendingRecoveryComplete(true);
          workplaceDurableMutationRef.current = false;
          throw retryError;
        }
      } else {
        if (!(error instanceof WorkplaceMutationContinuityError)) clearWorkplacePendingMutation();
        if (!(error instanceof WorkplaceMutationContinuityError)) {
          autoConnectExtensionRef.current = null;
          setWorkplacePendingRecoveryComplete(true);
        }
        workplaceDurableMutationRef.current = false;
        throw error;
      }
    }

    if (result.state === "disconnect_required") {
      if (!result.operationId) {
        clearWorkplacePendingMutation();
        setWorkplacePendingRecoveryComplete(true);
        workplaceDurableMutationRef.current = false;
        throw new Error("Server nepotvrdil bezpečný presun pracovného miesta. Pôvodné miesto zostalo bez zmeny.");
      }
      const operationId = result.operationId;
      pending = {
        ...pending,
        action: "confirm_seat_change",
        attempts: 0,
        operationId,
        phase: "finalize",
      };
      storeWorkplacePendingMutation(pending);
      workplaceHeartbeatSuspendedRef.current = true;
      setWorkplacePhoneTransitionActive(true);
      try {
        const browserDisconnectOutcome = await disconnectWorkplaceBrowserWebphone();
        pending = { ...pending, browserDisconnectOutcome };
        storeWorkplacePendingMutation(pending);
        result = await executePendingWorkplaceMutation(pending);
      } catch (error) {
        workplaceHeartbeatSuspendedRef.current = false;
        if (!(error instanceof WorkplaceMutationContinuityError)) {
          await mutateWorkplaceSelection("cancel_seat_change", {
            browserInstanceId: workplaceBrowserInstanceId,
            idempotencyKey,
            operationId,
          }).then(() => clearWorkplacePendingMutation()).catch(() => undefined);
        }
        autoConnectExtensionRef.current = null;
        await Promise.allSettled([refreshWorkplaceSelection(), refreshWebphoneConfig()]);
        if (!(error instanceof WorkplaceMutationContinuityError)) setWorkplacePendingRecoveryComplete(true);
        workplaceDurableMutationRef.current = false;
        throw error;
      } finally {
        workplaceHeartbeatSuspendedRef.current = false;
        setWorkplacePhoneTransitionActive(false);
      }
    }
    finishPendingWorkplaceMutation(pending, result);
    setWorkplacePendingRecoveryComplete(true);
    workplaceDurableMutationRef.current = false;
    return result;
  }, [
    beginPendingWorkplaceMutation,
    disconnectWorkplaceBrowserWebphone,
    executePendingWorkplaceMutation,
    finishPendingWorkplaceMutation,
    mutateWorkplaceSelection,
    refreshWebphoneConfig,
    refreshWorkplaceSelection,
    viewerOrganizationId,
    workplaceActorProfileId,
    workplaceBrowserInstanceId,
    workplaceSelection,
  ]);

  const takeoverWorkplace = useCallback(async (extension: string) => {
    if (!hotdeskContractActive) {
      const result = await mutateWorkplaceSelection("takeover_seat", { extension });
      try {
        await refreshWorkplaceSelection();
        await refreshTelephonyPresence("stored");
        autoConnectExtensionRef.current = null;
        await refreshWebphoneConfig();
      } catch (error) {
        return buildTakeoverPhoneHandshakeResult({
          detail: error instanceof Error ? error.message : "Stav telefónu sa nepodarilo obnoviť.",
          extension,
          outcome: "refresh_failed",
        });
      }
      return waitForTakenOverPhone(extension, result.message);
    }
    if (browserWebphone.hasActiveCall) {
      throw new Error("Najprv ukonči prebiehajúci hovor. Počas hovoru sa pracovné miesto nedá zmeniť.");
    }
    if (workplaceDurableMutationRef.current) {
      throw new Error("Predchádzajúca zmena pracovného miesta sa ešte bezpečne dokončuje.");
    }
    // A same-seat reclaim replaces the lease id. Keep automatic SIP startup
    // closed until the claim and every authoritative refresh agree on the new
    // lease; otherwise a render can issue credentials with an intermediate
    // fence while the old document leader is being replaced.
    beginWorkplaceAutoConnectSuppression();
    let autoConnectSuppressionHeld = true;
    try {
      const recovery = await ensureWorkplaceMutationRecoveryReady();
      const verifiedActorProfileId = recovery?.actorProfileId;
      if (!verifiedActorProfileId) {
        throw new Error("Prihláseného operátora sa nepodarilo overiť. Obnov stránku a skús to znova.");
      }
      let authoritativeWorkplace = recovery.workplace ?? workplaceSelection;
      const currentExtension = authoritativeWorkplace?.selection.extension;
      if (currentExtension && currentExtension !== extension && !workplaceLeaseOwnsSelection) {
        const reclaimed = await claimHotdeskWorkplaceSeat(
          currentExtension,
          verifiedActorProfileId,
          authoritativeWorkplace,
        );
        if (!reclaimed.lease || reclaimed.lease.extension !== currentExtension) {
          throw new Error(`Reláciu pracovného miesta ${currentExtension} sa v tomto prehliadači nepodarilo obnoviť.`);
        }
        authoritativeWorkplace = reclaimed.workplace ?? await refreshWorkplaceSelection("fresh");
      }
      const result = await claimHotdeskWorkplaceSeat(
        extension,
        verifiedActorProfileId,
        authoritativeWorkplace,
      );

      try {
        const workplace = result.workplace ?? await refreshWorkplaceSelection();
        if (workplace.selection.extension !== extension) {
          throw new Error("Server nepotvrdil nové pracovné miesto.");
        }
        // The seat mutation already persisted canonical ownership. Reload that
        // cheap stored assignment before filtering the new webphone config;
        // a provider capture here is both slower and unnecessary.
        await refreshTelephonyPresence("stored");
        await refreshWebphoneConfig();
      } catch (error) {
        return buildTakeoverPhoneHandshakeResult({
          detail: error instanceof Error ? error.message : "Stav telefónu sa nepodarilo obnoviť.",
          extension,
          outcome: "refresh_failed",
        });
      }

      autoConnectExtensionRef.current = null;
      endWorkplaceAutoConnectSuppression();
      autoConnectSuppressionHeld = false;
      return waitForTakenOverPhone(extension, result.message);
    } catch (error) {
      if (error instanceof WorkplaceMutationContinuityError) {
        setWorkplaceLeaseNotice(error.message);
      }
      if (error instanceof WorkplaceMutationConvergenceError) {
        return {
          message: "Pôvodný telefón sa vo VIPTel ešte odpája. Presun pracovného miesta bezpečne dokončíme automaticky.",
          state: "pending" as const,
        };
      }
      throw error;
    } finally {
      if (autoConnectSuppressionHeld) endWorkplaceAutoConnectSuppression();
    }
  }, [
    beginWorkplaceAutoConnectSuppression,
    browserWebphone.hasActiveCall,
    claimHotdeskWorkplaceSeat,
    ensureWorkplaceMutationRecoveryReady,
    endWorkplaceAutoConnectSuppression,
    hotdeskContractActive,
    mutateWorkplaceSelection,
    refreshTelephonyPresence,
    refreshWebphoneConfig,
    refreshWorkplaceSelection,
    waitForTakenOverPhone,
    workplaceLeaseOwnsSelection,
    workplaceSelection,
  ]);

  const releaseOccupiedWorkplace = useCallback(async (extension: string) => {
    const result = await mutateWorkplaceSelection("release_occupied_seat", { extension });
    try {
      await refreshWorkplaceSelection();
      await refreshTelephonyPresence("stored");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Stav pracoviska sa nepodarilo obnoviť.";
      return {
        message: `Pracovné miesto ${extension} je uvoľnené, ale obrazovku sa nepodarilo obnoviť. Obnov dostupnosť. ${detail}`,
        state: "pending" as const,
      };
    }
    return {
      message: result.message ?? `Pracovné miesto ${extension} je uvoľnené.`,
      state: result.state,
    };
  }, [mutateWorkplaceSelection, refreshTelephonyPresence, refreshWorkplaceSelection]);

  const prepareLegacyWorkplaceSeatRelease = useCallback(async (extension: string) => {
    if (browserWebphone.hasActiveCall) {
      throw new Error("Najprv ukonči prebiehajúci hovor. Počas hovoru sa pracovné miesto nedá zmeniť.");
    }
    await disconnectWorkplaceBrowserWebphone();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const snapshot = await refreshTelephonyPresence("provider");
      const releasedExtension = snapshot?.extensions.find((candidate) => candidate.extension === extension);
      if (releasedExtension?.registered === false) return;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
    }
    throw new Error(`Interná linka ${extension} sa vo VIPTel ešte neodpojila. Po chvíli skús zmenu znova.`);
  }, [browserWebphone.hasActiveCall, disconnectWorkplaceBrowserWebphone, refreshTelephonyPresence]);

  const waitForLegacyWorkplacePhoneRegistration = useCallback(async (extension: string) => {
    if (
      selectedWebphoneExtension === extension &&
      browserRegistrationStatus === "idle" &&
      webphoneAvailable
    ) {
      autoConnectExtensionRef.current = extension;
      await connectBrowserWebphone();
    }

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const snapshot = await refreshTelephonyPresence("provider");
      const selectedExtension = snapshot?.extensions.find((candidate) => candidate.extension === extension);
      if (selectedExtension?.registered === true) return;
      if (attempt < 15) await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
    }
    throw new Error(
      `Telefón pracovného miesta ${extension} sa ešte nepripojil. Povoľ mikrofón a skontroluj internetové pripojenie; pracovné miesto zostalo bezpečne priradené.`,
    );
  }, [browserRegistrationStatus, connectBrowserWebphone, refreshTelephonyPresence, selectedWebphoneExtension, webphoneAvailable]);

  const setWorkplaceAvailable = useCallback(async (
    extension: string,
    fence: WorkplaceWebphoneSessionFence | undefined,
    currentPresence?: TelephonyPresenceSnapshot,
  ) => {
    if (currentPresence && extensionHasAvailableQueueMembership(currentPresence, extension)) {
      return { alreadyAvailable: true };
    }
    if (queueCommandPendingRef.current) {
      throw new Error("Predchádzajúca zmena dostupnosti sa ešte potvrdzuje.");
    }

    queueCommandPendingRef.current = true;
    setQueueCommandPending(true);
    setQueueCommandTarget("available");
    try {
      const response = await telephonyFetch("/api/telephony/queues/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "available", extension, ...(fence ?? {}) }),
        label: "nastavenie dostupnosti",
        timeoutMs: TELEPHONY_TIMEOUT_MS.control,
      });
      const result = (await response.json().catch(() => null)) as {
        command?: { id?: string; status?: string };
        error?: string;
        noOp?: boolean;
        ok?: boolean;
        queue?: string;
      } | null;
      if (!response.ok || !result?.ok || (!result.noOp && !result.command?.id)) {
        throw new Error(result?.error ?? "Stav Dostupný sa nepodarilo nastaviť.");
      }
      if (result.command?.id) {
        requireConfirmedTelephonyCommand(await waitForTelephonyCommand(result.command.id));
      }
      await refreshTelephonyPresence("stored");
      return { alreadyAvailable: Boolean(result.noOp), queue: result.queue };
    } finally {
      queueCommandPendingRef.current = false;
      setQueueCommandPending(false);
      setQueueCommandTarget(null);
    }
  }, [refreshTelephonyPresence]);

  const claimWorkplacePriorityWithRecovery = useCallback(async (
    queue: WorkplaceSelectionInput["queue"],
    fence: WorkplaceWebphoneSessionFence | undefined,
  ) => {
    try {
      return await mutateWorkplaceSelection("claim_priority", { queue, ...(fence ?? {}) });
    } catch (claimError) {
      let latest = await refreshWorkplaceSelection().catch(() => null);
      if (latest?.routingStatus.state === "active" && workplacePriorityMatchesSelection(latest, queue)) {
        return {
          message: latest.routingStatus.message,
          state: "confirmed" as const,
          workplace: latest,
        };
      }
      if (latest?.routingStatus.state === "activating" && latest.selection.queue === queue) {
        return {
          message: "Poradie sa vo VIPTel bezpečne dokončuje. Nie je potrebné nič stláčať.",
          state: "pending" as const,
          workplace: latest,
        };
      }
      if (
        !fence || latest?.routingStatus.state !== "blocked" ||
        !latest.routingStatus.canRecover || !latest.routingStatus.operationId
      ) {
        throw claimError;
      }

      const operationId = latest.routingStatus.operationId;
      const recoveryKey = `${operationId}:${fence.leaseId}`;
      workplacePriorityAutoRecoveryRef.current.set(recoveryKey, 0);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        workplacePriorityAutoRecoveryRef.current.set(recoveryKey, attempt + 1);
        try {
          const recovered = await mutateWorkplaceSelection("recover_priority", {
            operationId,
            ...fence,
          });
          if (
            recovered.workplace?.routingStatus.state === "active" &&
            workplacePriorityMatchesSelection(recovered.workplace, queue)
          ) {
            return { ...recovered, state: "confirmed" as const };
          }
          return recovered;
        } catch (recoveryError) {
          latest = await refreshWorkplaceSelection().catch(() => null);
          if (latest?.routingStatus.state === "active" && workplacePriorityMatchesSelection(latest, queue)) {
            return {
              message: latest.routingStatus.message,
              state: "confirmed" as const,
              workplace: latest,
            };
          }
          if (latest?.routingStatus.state === "activating" && latest.selection.queue === queue) {
            return {
              message: "Poradie sa vo VIPTel bezpečne dokončuje. Nie je potrebné nič stláčať.",
              state: "pending" as const,
              workplace: latest,
            };
          }
          const stillRecoverable = latest?.routingStatus.state === "blocked" &&
            latest.routingStatus.canRecover && latest.routingStatus.operationId === operationId;
          if (!stillRecoverable || attempt === 1) {
            if (stillRecoverable) {
              return {
                message: "Poradie sa automaticky obnovuje. Pracovné miesto aj telefón zostávajú pripravené.",
                state: "pending" as const,
                workplace: latest ?? undefined,
              };
            }
            throw recoveryError;
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
        }
      }
      throw claimError;
    }
  }, [mutateWorkplaceSelection, refreshWorkplaceSelection]);

  const finishWorkplaceSelectionAsAvailable = useCallback(async (
    extension: string,
    fence: WorkplaceWebphoneSessionFence | undefined,
    priorityResult: WorkplaceMutationResult,
  ): Promise<WorkplaceSelectionActionResult> => {
    if (priorityResult.state !== "confirmed") {
      const recoveryKey = fence ? `${extension}:${fence.leaseId}` : null;
      if (fence && recoveryKey && !workplaceAutoAvailabilityRef.current.has(recoveryKey)) {
        workplaceAutoAvailabilityRef.current.add(recoveryKey);
        void (async () => {
          try {
            let workplace = priorityResult.workplace ?? null;
            let lastAvailabilityError: unknown = null;
            for (const delayMs of WORKPLACE_AVAILABILITY_RECHECK_DELAYS_MS) {
              if (!workplace || delayMs > 0) {
                if (delayMs > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
                workplace = await refreshWorkplaceSelection("fresh").catch(() => null);
              }
              const selectedPriority = workplace?.priorities.find((priority) =>
                priority.activeExtension === extension,
              );
              if (
                workplace?.selection.extension === extension &&
                workplace.routingStatus.state === "active" && selectedPriority
              ) {
                const currentLease = normalizeWorkplaceLease(workplace.lease);
                const currentFence = currentLease?.extension === extension
                  ? {
                      assignmentGeneration: currentLease.assignmentGeneration,
                      browserInstanceId: workplaceBrowserInstanceId,
                      leaderEpoch: currentLease.leaderEpoch,
                      leaseId: currentLease.leaseId,
                      leaseVersion: currentLease.leaseVersion,
                    }
                  : fence;
                try {
                  await setWorkplaceAvailable(extension, currentFence);
                  return;
                } catch (error) {
                  // A queue command still in flight makes this fail
                  // transiently, and the recheck budget exists for exactly
                  // that. Keep the reason and try again rather than reporting
                  // a failure the next attempt would not have suffered.
                  lastAvailabilityError = error;
                }
              }
              workplace = null;
            }
            setMutationNotice(lastAvailabilityError instanceof Error
              ? `Pracovné miesto ${extension} je pripojené, ale stav Dostupný sa nepotvrdil: ${lastAvailabilityError.message}`
              : `Pracovné miesto ${extension} je pripojené, ale stav Dostupný sa ešte nepotvrdil. Obnov stav.`);
          } catch (error) {
            setMutationNotice(
              error instanceof Error
                ? `Pracovné miesto ${extension} je pripojené, ale stav Dostupný sa nepotvrdil: ${error.message}`
                : `Pracovné miesto ${extension} je pripojené, ale stav Dostupný sa nepotvrdil.`,
            );
          } finally {
            workplaceAutoAvailabilityRef.current.delete(recoveryKey);
          }
        })();
      }
      return {
        message: priorityResult.message ?? "Poradie sa bezpečne dokončuje. Dostupnosť sa nastaví po jeho potvrdení.",
        state: priorityResult.state,
      };
    }
    try {
      await setWorkplaceAvailable(extension, fence);
      return {
        message: `Pracovné miesto ${extension} je pripravené a tvoj stav je Dostupný.`,
        state: "confirmed",
      };
    } catch (error) {
      return {
        message: `Pracovné miesto ${extension} je pripravené. Stav Dostupný sa zatiaľ nepotvrdil: ${
          error instanceof Error ? error.message : "obnov stav a skús to znova"
        }`,
        state: "warning",
      };
    }
  }, [refreshWorkplaceSelection, setWorkplaceAvailable, workplaceBrowserInstanceId]);

  const selectWorkplace = useCallback(async (selection: WorkplaceSelectionInput) => {
    if (workplaceSelection?.routingStatus.state === "activating") {
      return {
        message: "VIPTel ešte potvrdzuje predchádzajúcu zmenu poradia. Nové miesto vyber po jej dokončení.",
        state: "pending" as const,
      };
    }
    if (!hotdeskContractActive) {
      if (workplaceSelection?.routingStatus.state === "blocked") {
        throw new Error(workplaceSelection.routingStatus.message);
      }
      let currentExtension = workplaceSelection?.selection.extension ?? (defaultExtension || null);
      let currentQueue = workplaceSelection?.selection.queue ?? actorRouting?.queue ?? null;
      let priorityReleased = false;
      let seatClaimed = currentExtension === selection.extension;
      try {
        if (currentQueue && currentExtension !== selection.extension) {
          const releaseResult = await mutateWorkplaceSelection("release_priority", workplaceWebphoneFence);
          if (releaseResult.state === "pending") {
            await Promise.allSettled([refreshWorkplaceSelection(), refreshTelephonyPresence("stored")]);
            return {
              message: releaseResult.message ?? "VIPTel odstraňuje pôvodnú prioritu. Nové miesto vyber po potvrdení zmeny.",
              state: "pending" as const,
            };
          }
          priorityReleased = true;
          currentQueue = null;
          await refreshWorkplaceState();
        }
        if (currentExtension !== selection.extension) {
          if (currentExtension) await prepareLegacyWorkplaceSeatRelease(currentExtension);
          await mutateWorkplaceSelection("claim_seat", { extension: selection.extension });
          seatClaimed = true;
          currentExtension = selection.extension;
          await refreshWorkplaceState();
        }
        const activePriority = workplaceSelection?.priorities.find((priority) => priority.queue === selection.queue);
        if (
          currentQueue === selection.queue &&
          workplaceSelection?.routingStatus.state === "active" &&
          activePriority?.activeExtension === selection.extension
        ) {
          await refreshWorkplaceState();
          return finishWorkplaceSelectionAsAvailable(selection.extension, workplaceWebphoneFence, {
            message: "Pracovné miesto aj poradie už používaš.",
            state: "confirmed",
          });
        }
        await waitForLegacyWorkplacePhoneRegistration(selection.extension);
        const priorityResult = await claimWorkplacePriorityWithRecovery(selection.queue, workplaceWebphoneFence);
        return finishWorkplaceSelectionAsAvailable(selection.extension, workplaceWebphoneFence, priorityResult);
      } catch (error) {
        await Promise.allSettled([refreshWorkplaceSelection(), refreshTelephonyPresence("stored")]);
        const detail = error instanceof Error ? error.message : "Zmenu sa nepodarilo dokončiť.";
        if (seatClaimed && currentQueue !== selection.queue) {
          throw new Error(`Pracovné miesto ${selection.extension} zostalo priradené, ale poradie sa nepodarilo nastaviť. ${detail}`);
        }
        if (priorityReleased && !seatClaimed) {
          throw new Error(`Pôvodné pracovné miesto zostalo priradené, ale bez poradia zvonenia. ${detail}`);
        }
        throw error;
      }
    }
    const currentExtension = workplaceSelection?.selection.extension ?? (defaultExtension || null);
    let activeWorkplaceSnapshot = workplaceSelection;
    let activeWorkplaceFence = workplaceWebphoneFence;
    if (
      hotdeskContractActive && (
        currentExtension !== selection.extension ||
        !workplaceLeaseOwnsSelection ||
        browserRegistrationStatus !== "registered"
      )
    ) {
      const reclaimed = await takeoverWorkplace(selection.extension);
      if (reclaimed.state !== "confirmed") return reclaimed;
      const reclaimedWorkplace = await refreshWorkplaceSelection();
      activeWorkplaceSnapshot = reclaimedWorkplace;
      const reclaimedLease = normalizeWorkplaceLease(reclaimedWorkplace.lease);
      if (!reclaimedLease || reclaimedLease.extension !== selection.extension) {
        throw new Error("Server po obnovení nepotvrdil platnú reláciu pracovného miesta.");
      }
      activeWorkplaceFence = {
        assignmentGeneration: reclaimedLease.assignmentGeneration,
        browserInstanceId: workplaceBrowserInstanceId,
        leaderEpoch: reclaimedLease.leaderEpoch,
        leaseId: reclaimedLease.leaseId,
        leaseVersion: reclaimedLease.leaseVersion,
      };
    }

    const currentQueue = activeWorkplaceSnapshot?.selection.queue ?? actorRouting?.queue ?? null;
    const activePriority = activeWorkplaceSnapshot?.priorities.find((priority) => priority.queue === selection.queue);
    if (
      currentQueue === selection.queue &&
      activeWorkplaceSnapshot?.routingStatus.state === "active" &&
      activePriority?.activeExtension === selection.extension
    ) {
      return finishWorkplaceSelectionAsAvailable(selection.extension, activeWorkplaceFence, {
        message: activeWorkplaceSnapshot.routingStatus.message || "Poradie tohto pracovného miesta je už potvrdené.",
        state: "confirmed",
      });
    }

    try {
      const priorityResult = await claimWorkplacePriorityWithRecovery(selection.queue, activeWorkplaceFence);
      return finishWorkplaceSelectionAsAvailable(selection.extension, activeWorkplaceFence, priorityResult);
    } catch (error) {
      await Promise.allSettled([refreshWorkplaceSelection(), refreshTelephonyPresence("stored")]);
      const detail = error instanceof Error ? error.message : "Poradie sa nepodarilo potvrdiť.";
      throw new Error(`Pracovné miesto je pripojené, ale príjem hovorov sa nepodarilo bezpečne dokončiť. ${detail}`);
    }
  }, [actorRouting?.queue, browserRegistrationStatus, claimWorkplacePriorityWithRecovery, defaultExtension, finishWorkplaceSelectionAsAvailable, hotdeskContractActive, mutateWorkplaceSelection, prepareLegacyWorkplaceSeatRelease, refreshTelephonyPresence, refreshWorkplaceSelection, refreshWorkplaceState, takeoverWorkplace, waitForLegacyWorkplacePhoneRegistration, workplaceBrowserInstanceId, workplaceLeaseOwnsSelection, workplaceSelection, workplaceWebphoneFence]);

  const releaseWorkplace = useCallback(async () => {
    if (!hotdeskContractActive) {
      if (workplaceSelection?.routingStatus.state === "activating") {
        return {
          message: "VIPTel ešte potvrdzuje zmenu poradia. Pracovné miesto zostáva priradené až do jej dokončenia.",
          state: "pending" as const,
        };
      }
      if (workplaceSelection?.routingStatus.state === "blocked") {
        throw new Error(workplaceSelection.routingStatus.message);
      }
      const legacyExtension = workplaceSelection?.selection.extension ?? (defaultExtension || null);
      const legacyQueue = workplaceSelection?.selection.queue ?? actorRouting?.queue ?? null;
      if (!legacyExtension) return { message: "Nemáš vybrané žiadne pracovné miesto.", state: "confirmed" as const };
      let priorityReleased = false;
      try {
        if (legacyQueue) {
          const releaseResult = await mutateWorkplaceSelection("release_priority", workplaceWebphoneFence);
          if (releaseResult.state === "pending") {
            await Promise.allSettled([refreshWorkplaceSelection(), refreshTelephonyPresence("stored")]);
            return {
              message: releaseResult.message ?? "VIPTel odstraňuje prioritu. Pracovné miesto zostáva priradené až do potvrdenia.",
              state: "pending" as const,
            };
          }
          priorityReleased = true;
          await refreshWorkplaceState();
        }
        await prepareLegacyWorkplaceSeatRelease(legacyExtension);
        await mutateWorkplaceSelection("release_seat");
        await refreshWorkplaceState();
        return { message: `Pracovné miesto ${legacyExtension} je uvoľnené.`, state: "confirmed" as const };
      } catch (error) {
        await Promise.allSettled([refreshWorkplaceSelection(), refreshTelephonyPresence("stored")]);
        const detail = error instanceof Error ? error.message : "Pracovné miesto sa nepodarilo uvoľniť.";
        if (priorityReleased) {
          throw new Error(`Poradie zvonenia je uvoľnené, ale pracovné miesto ${legacyExtension} zostalo priradené. ${detail}`);
        }
        throw error;
      }
    }
    const currentExtension = workplaceSelection?.selection.extension ?? (defaultExtension || null);
    if (!currentExtension) return { message: "Nemáš vybrané žiadne pracovné miesto.", state: "confirmed" as const };
    if (browserWebphone.hasActiveCall) {
      throw new Error("Najprv ukonči prebiehajúci hovor. Počas hovoru sa pracovné miesto nedá opustiť.");
    }
    if (workplaceDurableMutationRef.current) {
      throw new Error("Predchádzajúca zmena pracovného miesta sa ešte bezpečne dokončuje.");
    }
    beginWorkplaceAutoConnectSuppression();
    try {
      const recovery = await ensureWorkplaceMutationRecoveryReady();
      const verifiedActorProfileId = recovery?.actorProfileId;
      if (!verifiedActorProfileId) {
        throw new Error("Prihláseného operátora sa nepodarilo overiť. Obnov stránku a skús to znova.");
      }
      let authoritativeWorkplace = recovery.workplace ?? workplaceSelection;
      if (!workplaceLeaseOwnsSelection) {
        const reclaimed = await claimHotdeskWorkplaceSeat(
          currentExtension,
          verifiedActorProfileId,
          authoritativeWorkplace,
        );
        if (!reclaimed.lease || reclaimed.lease.extension !== currentExtension) {
          throw new Error(`Reláciu pracovného miesta ${currentExtension} sa v tomto prehliadači nepodarilo obnoviť.`);
        }
        authoritativeWorkplace = reclaimed.workplace ?? await refreshWorkplaceSelection("fresh");
      }
      const seat = authoritativeWorkplace?.seats.find((candidate) => candidate.extension === currentExtension);
      const idempotencyKey = createWorkplaceBrowserInstanceId();
      const oldLeaseId = normalizeWorkplaceLease(authoritativeWorkplace?.lease)?.leaseId ?? workplaceLease?.leaseId;
      let pendingOperationId: string | undefined;
      let pending = beginPendingWorkplaceMutation({
        action: "leave_seat",
        actorProfileId: verifiedActorProfileId,
        attempts: 0,
        browserInstanceId: workplaceBrowserInstanceId,
        createdAt: Date.now(),
        expectedVersion: seat?.version,
        extension: currentExtension,
        idempotencyKey,
        kind: "leave",
        ...(viewerOrganizationId ? { organizationId: viewerOrganizationId } : {}),
        phase: "prepare",
      });
      let result: WorkplaceMutationResult;
      workplaceDurableMutationRef.current = true;
      setWorkplacePendingRecoveryComplete(false);
      try {
        result = await executePendingWorkplaceMutation(pending);
        if (result.state === "disconnect_required") {
          if (!result.operationId) {
            clearWorkplacePendingMutation();
            throw new Error("Server nepotvrdil bezpečné odhlásenie. Pracovné miesto zostalo bez zmeny.");
          }
          pendingOperationId = result.operationId;
          pending = {
            ...pending,
            action: "confirm_seat_change",
            attempts: 0,
            operationId: pendingOperationId,
            phase: "finalize",
          };
          storeWorkplacePendingMutation(pending);
          workplaceHeartbeatSuspendedRef.current = true;
          setWorkplacePhoneTransitionActive(true);
          const browserDisconnectOutcome = await disconnectWorkplaceBrowserWebphone();
          pending = { ...pending, browserDisconnectOutcome };
          storeWorkplacePendingMutation(pending);
          result = await executePendingWorkplaceMutation(pending);
        }
        finishPendingWorkplaceMutation(pending, result);
        setWorkplacePendingRecoveryComplete(true);
        workplaceHeartbeatSuspendedRef.current = false;
        if (oldLeaseId) clearWorkplaceResumeCredential(oldLeaseId);
        workplaceLeaseIdRef.current = null;
        workplaceHeartbeatLeaseRef.current = null;
        setWorkplaceLease(null);
        setWorkplaceLeaseSessionReady(false);
        const confirmedMessage = result.message ??
          `Pracovné miesto ${currentExtension} je voľné pre ďalšieho operátora. Poradie stoličky sa nezmenilo.`;
        let refreshWarning: string | undefined;
        try {
          // The server already performed the post-commit provider sync. Read
          // that stored result without blocking the completed release on a
          // second identical VIPTel snapshot. A fresh display convergence can
          // continue independently after the operator regains control.
          await Promise.all([
            result.workplace ? Promise.resolve(result.workplace) : refreshWorkplaceSelection("fresh"),
            refreshWebphoneConfig(),
            refreshTelephonyPresence("stored"),
          ]);
          void refreshTelephonyPresence("provider_fresh").then((snapshot) => {
            if (snapshot) return refreshWorkplaceSelection("fresh").catch(() => undefined);
          });
        } catch (refreshError) {
          // Ownership is already committed. A display refresh must never enter
          // the pre-commit cancellation path or describe the release as failed.
          await Promise.allSettled([refreshWorkplaceSelection("fresh"), refreshWebphoneConfig()]);
          const detail = refreshError instanceof Error
            ? refreshError.message
            : "Aktuálny stav pracoviska sa nepodarilo obnoviť.";
          refreshWarning = `${confirmedMessage} Aktuálny stav sa nepodarilo obnoviť; použi tlačidlo Obnoviť stav. ${detail}`;
        }
        return {
          message: refreshWarning ?? confirmedMessage,
          state: refreshWarning ? "warning" as const : result.state,
        };
      } catch (error) {
        workplaceHeartbeatSuspendedRef.current = false;
        autoConnectExtensionRef.current = null;
        if (error instanceof WorkplaceMutationContinuityError) {
          setWorkplaceLeaseNotice(error.message);
        }
        if (pendingOperationId && !(error instanceof WorkplaceMutationContinuityError)) {
          await mutateWorkplaceSelection("cancel_seat_change", {
            browserInstanceId: workplaceBrowserInstanceId,
            idempotencyKey,
            operationId: pendingOperationId,
          }).then(() => clearWorkplacePendingMutation()).catch(() => undefined);
        } else if (!pendingOperationId && !(error instanceof WorkplaceMutationContinuityError)) {
          clearWorkplacePendingMutation();
        }
        await Promise.allSettled([refreshWorkplaceSelection(), refreshTelephonyPresence("stored")]);
        await refreshWebphoneConfig().catch(() => undefined);
        if (!(error instanceof WorkplaceMutationContinuityError)) setWorkplacePendingRecoveryComplete(true);
        if (error instanceof WorkplaceMutationConvergenceError) {
          return {
            message: `Telefón pracovného miesta ${currentExtension} sa vo VIPTel ešte odpája. Uvoľnenie bezpečne dokončíme automaticky; nič nestláčaj opakovane.`,
            state: "pending" as const,
          };
        }
        if (
          error instanceof WorkplaceMutationTerminalError &&
          error.code === "provider_snapshot_unavailable" &&
          oldLeaseId
        ) {
          // Leaving must never be weaker than closing the tab. VIPTel cannot
          // be reached to prove the phone idle, so instead of stranding the
          // operator on the seat, drop this browser's lease exactly the way a
          // closed tab would: heartbeats stop, the lease expires, the sweeper
          // reaps it, and the seat becomes takeable. Ownership is not touched
          // -- no provider claim is made without provider proof.
          await handleWorkplaceLeaseLost(
            oldLeaseId,
            "VIPTel je momentálne nedostupný, preto sa pracovisko odhlásilo núdzovo.",
          );
          return {
            message: `VIPTel je momentálne nedostupný, preto sa pracovisko ${currentExtension} odhlásilo núdzovo. ` +
              "Relácia tohto prehliadača je ukončená a miesto sa uvoľní automaticky do približne dvoch minút.",
            state: "warning" as const,
          };
        }
        throw error;
      } finally {
        workplaceDurableMutationRef.current = false;
        setWorkplacePhoneTransitionActive(false);
      }
    } finally {
      endWorkplaceAutoConnectSuppression();
    }
  }, [actorRouting?.queue, beginPendingWorkplaceMutation, beginWorkplaceAutoConnectSuppression, browserWebphone.hasActiveCall, claimHotdeskWorkplaceSeat, defaultExtension, disconnectWorkplaceBrowserWebphone, endWorkplaceAutoConnectSuppression, ensureWorkplaceMutationRecoveryReady, executePendingWorkplaceMutation, finishPendingWorkplaceMutation, handleWorkplaceLeaseLost, hotdeskContractActive, mutateWorkplaceSelection, prepareLegacyWorkplaceSeatRelease, refreshTelephonyPresence, refreshWebphoneConfig, refreshWorkplaceSelection, refreshWorkplaceState, viewerOrganizationId, workplaceBrowserInstanceId, workplaceLease?.leaseId, workplaceLeaseOwnsSelection, workplaceSelection, workplaceWebphoneFence]);

  const requestOnlineWorkplaceTakeover = useCallback(async (extension: string) => {
    setWorkplaceTakeoverError(null);
    const result = await mutateWorkplaceTakeover("request", { extension });
    return { message: result.message, state: "pending" as const };
  }, [mutateWorkplaceTakeover]);

  const cancelOnlineWorkplaceTakeover = useCallback(async (requestId: string) => {
    setWorkplaceTakeoverError(null);
    const result = await mutateWorkplaceTakeover("cancel", { requestId });
    return { message: result.message, state: "confirmed" as const };
  }, [mutateWorkplaceTakeover]);

  const respondToOnlineWorkplaceTakeover = useCallback(async (decision: "accept" | "decline") => {
    const request = workplaceTakeover?.incoming;
    if (!request || workplaceTakeoverResponsePending) return;
    setWorkplaceTakeoverResponsePending(decision);
    setWorkplaceTakeoverError(null);
    try {
      if (decision === "decline") {
        const result = await mutateWorkplaceTakeover("respond", {
          decision,
          requestId: request.requestId,
        });
        setMutationNotice(result.message ?? "Žiadosť o pracovné miesto bola odmietnutá.");
        return;
      }
      if (request.status === "pending") {
        await mutateWorkplaceTakeover("respond", {
          decision,
          requestId: request.requestId,
        });
      }
      const released = await releaseWorkplace();
      setMutationNotice(
        released.message ?? `Pracovné miesto ${request.extension} je pripravené pre ${request.requesterName}.`,
      );
      await Promise.allSettled([refreshWorkplaceTakeover(), refreshWorkplaceSelection()]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Pracovisko sa nepodarilo bezpečne odovzdať.";
      setWorkplaceTakeoverError(
        decision === "accept"
          ? `Odovzdanie nebolo dokončené. Tvoje pracovisko sa bez bezpečného uvoľnenia nikomu nepriradilo. ${detail}`
          : detail,
      );
    } finally {
      setWorkplaceTakeoverResponsePending(null);
    }
  }, [
    mutateWorkplaceTakeover,
    refreshWorkplaceSelection,
    refreshWorkplaceTakeover,
    releaseWorkplace,
    workplaceTakeover?.incoming,
    workplaceTakeoverResponsePending,
  ]);

  useEffect(() => {
    const request = workplaceTakeover?.incoming;
    if (!request || request.status !== "accepted") {
      workplaceTakeoverAutoReleaseRef.current = null;
      return;
    }
    if (
      workplaceTakeoverResponsePending || browserWebphone.hasActiveCall ||
      workplaceDurableMutationRef.current
    ) return;
    const previousAttempt = workplaceTakeoverAutoReleaseRef.current;
    if (
      previousAttempt?.requestId === request.requestId &&
      Date.now() - previousAttempt.attemptedAt < WORKPLACE_TAKEOVER_AUTO_RETRY_MS
    ) return;
    const attempts = previousAttempt?.requestId === request.requestId ? previousAttempt.attempts : 0;
    if (attempts >= WORKPLACE_TAKEOVER_AUTO_MAX_ATTEMPTS) {
      // Without a cap this re-ran the whole release machinery every 10 s for as
      // long as the request stayed accepted -- indefinitely, if the server
      // never advanced it.
      if (!previousAttempt?.exhausted) {
        workplaceTakeoverAutoReleaseRef.current = { ...previousAttempt!, exhausted: true };
        setWorkplaceTakeoverError(
          "Odovzdanie pracoviska sa nedokončilo automaticky. Skús ho potvrdiť ručne alebo obnov stav.",
        );
      }
      return;
    }
    workplaceTakeoverAutoReleaseRef.current = {
      attemptedAt: Date.now(),
      requestId: request.requestId,
      attempts: attempts + 1,
    };
    void respondToOnlineWorkplaceTakeover("accept");
    // `checkedAt` is deliberately absent: it changes on every poll and existed
    // only to re-trigger this effect.
  }, [
    browserWebphone.hasActiveCall,
    respondToOnlineWorkplaceTakeover,
    workplaceTakeover?.incoming,
    workplaceTakeoverResponsePending,
  ]);

  useEffect(() => {
    const request = workplaceTakeover?.outgoing;
    if (!request || request.status !== "accepted") {
      workplaceTakeoverAutoClaimRef.current = null;
      return;
    }
    if (workplaceSelection?.selection.extension === request.extension) {
      void mutateWorkplaceTakeover("complete", { requestId: request.requestId })
        .then((result) => setMutationNotice(result.message ?? `Pracovné miesto ${request.extension} je odovzdané.`))
        .catch(() => undefined);
      return;
    }
    if (browserWebphone.hasActiveCall || workplaceDurableMutationRef.current) return;
    const previousAttempt = workplaceTakeoverAutoClaimRef.current;
    if (
      previousAttempt?.requestId === request.requestId &&
      Date.now() - previousAttempt.attemptedAt < WORKPLACE_TAKEOVER_AUTO_RETRY_MS
    ) return;
    const attempts = previousAttempt?.requestId === request.requestId ? previousAttempt.attempts : 0;
    if (attempts >= WORKPLACE_TAKEOVER_AUTO_MAX_ATTEMPTS) {
      if (!previousAttempt?.exhausted) {
        workplaceTakeoverAutoClaimRef.current = { ...previousAttempt!, exhausted: true };
        setWorkplaceTakeoverError(
          "Schválené pracovné miesto sa nepodarilo obsadiť automaticky. Obsaď ho ručne alebo obnov stav.",
        );
      }
      return;
    }
    workplaceTakeoverAutoClaimRef.current = {
      attemptedAt: Date.now(),
      requestId: request.requestId,
      attempts: attempts + 1,
    };
    setWorkplaceTakeoverError(null);
    void takeoverWorkplace(request.extension)
      .then(async (result) => {
        const completed = await mutateWorkplaceTakeover("complete", { requestId: request.requestId });
        setMutationNotice(completed.message ?? result.message ?? `Pracovné miesto ${request.extension} je odovzdané.`);
      })
      .catch((error) => {
        setWorkplaceTakeoverError(
          error instanceof Error
            ? error.message
            : "Schválené pracovné miesto sa zatiaľ nepodarilo obsadiť. Aplikácia to skúsi znova.",
        );
      });
  }, [
    browserWebphone.hasActiveCall,
    mutateWorkplaceTakeover,
    takeoverWorkplace,
    workplaceSelection,
    workplaceTakeover?.outgoing,
  ]);

  const recoverPendingWorkplaceMutation = useCallback(async (initialPending: WorkplacePendingMutation) => {
    let pending = initialPending;
    const previousLeaseId = workplaceLeaseIdRef.current;
    let result: WorkplaceMutationResult;
    workplaceDurableMutationRef.current = true;
    workplaceHeartbeatSuspendedRef.current = true;
    setWorkplacePhoneTransitionActive(true);
    try {
      if (pending.phase === "finalize") {
        const phoneRecovery = await disconnectOrCancelRecoveredPhoneTransition({
          cancelTransition: async (operationId) => {
            await mutateWorkplaceSelection("cancel_seat_change", {
              browserInstanceId: workplaceBrowserInstanceId,
              idempotencyKey: pending.idempotencyKey,
              operationId,
            });
          },
          disconnectPhone: disconnectWorkplaceBrowserWebphone,
          pending,
        });
        if (phoneRecovery.kind === "transition_cancelled") {
          clearWorkplacePendingMutation();
          throw new Error(phoneRecovery.message);
        }
        if (phoneRecovery.kind === "continuity_blocked") {
          throw new WorkplaceMutationContinuityError(phoneRecovery.message);
        }
        pending = {
          ...pending,
          browserDisconnectOutcome: phoneRecovery.outcome,
        };
        storeWorkplacePendingMutation(pending);
      }
      result = await executePendingWorkplaceMutation(pending, { convergenceAttempts: 1 });
      if (result.state === "disconnect_required") {
        if (!result.operationId) {
          throw new WorkplaceMutationContinuityError(
            "Server nepotvrdil identifikátor rozpracovanej zmeny. Presná požiadavka zostala uložená.",
          );
        }
        pending = {
          ...pending,
          action: "confirm_seat_change",
          attempts: 0,
          operationId: result.operationId,
          phase: "finalize",
        };
        storeWorkplacePendingMutation(pending);
        const phoneRecovery = await disconnectOrCancelRecoveredPhoneTransition({
          cancelTransition: async (operationId) => {
            await mutateWorkplaceSelection("cancel_seat_change", {
              browserInstanceId: workplaceBrowserInstanceId,
              idempotencyKey: pending.idempotencyKey,
              operationId,
            });
          },
          disconnectPhone: disconnectWorkplaceBrowserWebphone,
          pending,
        });
        if (phoneRecovery.kind === "transition_cancelled") {
          clearWorkplacePendingMutation();
          throw new Error(phoneRecovery.message);
        }
        if (phoneRecovery.kind === "continuity_blocked") {
          throw new WorkplaceMutationContinuityError(phoneRecovery.message);
        }
        pending = {
          ...pending,
          browserDisconnectOutcome: phoneRecovery.outcome,
        };
        storeWorkplacePendingMutation(pending);
        result = await executePendingWorkplaceMutation(pending, { convergenceAttempts: 1 });
      }
      finishPendingWorkplaceMutation(pending, result);
      if (pending.kind === "leave" && result.state === "confirmed") {
        if (previousLeaseId) clearWorkplaceResumeCredential(previousLeaseId);
        workplaceLeaseIdRef.current = null;
        workplaceHeartbeatLeaseRef.current = null;
        setWorkplaceLease(null);
        setWorkplaceLeaseSessionReady(false);
      }
      return result;
    } catch (error) {
      if (!(error instanceof WorkplaceMutationContinuityError)) {
        clearWorkplacePendingMutation();
      }
      throw error;
    } finally {
      workplaceHeartbeatSuspendedRef.current = false;
      workplaceDurableMutationRef.current = false;
      setWorkplacePhoneTransitionActive(false);
    }
  }, [disconnectWorkplaceBrowserWebphone, executePendingWorkplaceMutation, finishPendingWorkplaceMutation, mutateWorkplaceSelection, workplaceBrowserInstanceId]);

  const performWorkplaceAvailabilityRecovery = useCallback(async () => {
    setWorkplaceLeaseNotice("Obnovujem rozpracovanú zmenu a čerstvý stav pracovísk.");
    setWorkplacePendingRecoveryComplete(false);
    try {
      // Recover the exact durable request before an unrelated presence refresh.
      // A temporary snapshot failure must not indefinitely strand a request
      // which the server can already identify and complete idempotently.
      let authoritativePresence: TelephonyPresenceSnapshot | undefined;
      let currentActorProfileId = viewerProfileId;
      if (!currentActorProfileId) {
        authoritativePresence = await refreshTelephonyPresence("provider");
        currentActorProfileId = authoritativePresence?.actorProfileId;
      }
      if (!currentActorProfileId) {
        throw new WorkplaceMutationContinuityError(
          "Prihláseného operátora sa nepodarilo overiť. Rozpracovaná požiadavka zostala uložená.",
        );
      }

      let pendingMutation = readWorkplacePendingMutation();
      if (pendingMutation && !workplacePendingBelongsToViewer(
        pendingMutation,
        currentActorProfileId,
        viewerOrganizationId,
      )) {
        clearWorkplacePendingMutation();
        pendingMutation = null;
      }
      if (pendingMutation) {
        if (pendingMutation.attempts >= WORKPLACE_EXACT_REQUEST_MAX_ATTEMPTS) {
          pendingMutation = { ...pendingMutation, attempts: 0 };
          storeWorkplacePendingMutation(pendingMutation);
        }
        try {
          await recoverPendingWorkplaceMutation(pendingMutation);
        } catch (error) {
          if (error instanceof WorkplaceMutationContinuityError) throw error;
          // A parsed terminal response proves that this exact journal must not
          // be replayed. recoverPendingWorkplaceMutation already removed it.
        }
      }

      authoritativePresence = await refreshTelephonyPresence("provider");
      if (!authoritativePresence) {
        throw new WorkplaceMutationContinuityError(
          "VIPTel nevrátil čerstvý stav pracovísk. Presná rozpracovaná požiadavka zostala uložená.",
        );
      }
      await refreshWorkplaceSelection();
      let pendingResume = readWorkplacePendingResume();
      if (pendingResume && !workplacePendingBelongsToViewer(
        pendingResume,
        currentActorProfileId,
        viewerOrganizationId,
      )) {
        clearWorkplaceResumeCredential(pendingResume.leaseId);
        clearWorkplacePendingResume();
        pendingResume = null;
      }
      if (pendingResume) {
        if (pendingResume.attempts >= WORKPLACE_EXACT_REQUEST_MAX_ATTEMPTS) {
          pendingResume = { ...pendingResume, attempts: 0 };
          storeWorkplacePendingResume(pendingResume);
        }
        const resumed = await executePendingWorkplaceResume(pendingResume);
        if (resumed.kind === "lease_lost") {
          await handleWorkplaceLeaseLost(pendingResume.leaseId, resumed.message);
        }
      }

      const workplace = await refreshWorkplaceSelection();
      await refreshWebphoneConfig();
      setWorkplaceLeaseNotice(null);
      if (normalizeWorkplaceLease(workplace.lease)) {
        setWorkplaceLeaderElectionEnabled(true);
        setWorkplaceLeaderRecoveryArmed(true);
      } else {
        setWorkplacePendingRecoveryComplete(true);
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Dostupnosť pracovísk sa nepodarilo bezpečne obnoviť.";
      setWorkplaceLeaseSessionReady(false);
      setWorkplaceLeaseNotice(message);
      if (!(error instanceof WorkplaceMutationContinuityError)) {
        setWorkplacePendingRecoveryComplete(true);
      }
      throw error;
    }
  }, [
    executePendingWorkplaceResume,
    handleWorkplaceLeaseLost,
    recoverPendingWorkplaceMutation,
    refreshTelephonyPresence,
    refreshWebphoneConfig,
    refreshWorkplaceSelection,
    viewerOrganizationId,
    viewerProfileId,
  ]);

  const retryWorkplaceAvailability = useCallback(() => {
    const activeRecovery = workplaceAvailabilityRecoveryRef.current;
    if (activeRecovery) return activeRecovery;

    const recovery = performWorkplaceAvailabilityRecovery();
    workplaceAvailabilityRecoveryRef.current = recovery;
    void recovery.then(
      () => {
        if (workplaceAvailabilityRecoveryRef.current === recovery) {
          workplaceAvailabilityRecoveryRef.current = null;
        }
      },
      () => {
        if (workplaceAvailabilityRecoveryRef.current === recovery) {
          workplaceAvailabilityRecoveryRef.current = null;
        }
      },
    );
    return recovery;
  }, [performWorkplaceAvailabilityRecovery]);

  useEffect(() => {
    if (workplaceRecoveryStartedRef.current) return;
    workplaceRecoveryStartedRef.current = true;

    void (async () => {
      let pendingMutation = readWorkplacePendingMutation();
      let pendingResumeAtStart = readWorkplacePendingResume();
      if (pendingMutation || pendingResumeAtStart) {
        setWorkplaceLeaseNotice("Bezpečne dokončujeme predchádzajúcu zmenu pracovného miesta.");
      }
      try {
        let authoritativePresence: TelephonyPresenceSnapshot | undefined;
        try {
          [, authoritativePresence] = await Promise.all([
            refreshWorkplaceSelection(),
            refreshTelephonyPresence("stored"),
          ]);
        } catch {
          throw new WorkplaceMutationContinuityError(
            "Aktuálne pracovisko sa nepodarilo bezpečne overiť. Telefón zostáva odpojený; obnov stránku.",
          );
        }
        const currentActorProfileId = viewerProfileId ?? authoritativePresence?.actorProfileId;
        if (!currentActorProfileId) {
          throw new WorkplaceMutationContinuityError(
            "Prihláseného operátora sa nepodarilo bezpečne overiť. Telefón zostáva odpojený; obnov stránku.",
          );
        }

        let quarantinedForeignRequest = false;
        if (pendingMutation && !workplacePendingBelongsToViewer(
          pendingMutation,
          currentActorProfileId,
          viewerOrganizationId,
        )) {
          clearWorkplacePendingMutation();
          pendingMutation = null;
          quarantinedForeignRequest = true;
        }
        if (pendingResumeAtStart && !workplacePendingBelongsToViewer(
          pendingResumeAtStart,
          currentActorProfileId,
          viewerOrganizationId,
        )) {
          clearWorkplaceResumeCredential(pendingResumeAtStart.leaseId);
          clearWorkplacePendingResume();
          pendingResumeAtStart = null;
          quarantinedForeignRequest = true;
        }

        if (pendingMutation) await recoverPendingWorkplaceMutation(pendingMutation);
        try {
          await refreshWorkplaceSelection();
        } catch {
          throw new WorkplaceMutationContinuityError(
            "Po obnovenej zmene sa nepodarilo potvrdiť aktuálne pracovisko. Telefón zostáva odpojený; obnov stránku.",
          );
        }

        const pendingResume = readWorkplacePendingResume();
        if (pendingResume && !workplacePendingBelongsToViewer(
          pendingResume,
          currentActorProfileId,
          viewerOrganizationId,
        )) {
          clearWorkplaceResumeCredential(pendingResume.leaseId);
          clearWorkplacePendingResume();
          quarantinedForeignRequest = true;
        }

        await Promise.allSettled([
          refreshWebphoneConfig(),
        ]);
        if (workplaceHeartbeatLeaseRef.current) {
          setWorkplaceLeaderElectionEnabled(true);
          setWorkplaceLeaderRecoveryArmed(true);
        } else {
          if (pendingResume) {
            clearWorkplaceResumeCredential(pendingResume.leaseId);
            clearWorkplacePendingResume();
          }
          setWorkplacePendingRecoveryComplete(true);
        }
        if (quarantinedForeignRequest) {
          setWorkplaceLeaseNotice(
            "Uložená rozpracovaná zmena patrila inému prihlásenému používateľovi, preto sa nespustila.",
          );
        } else {
          setWorkplaceLeaseNotice((notice) =>
            notice === "Bezpečne dokončujeme predchádzajúcu zmenu pracovného miesta." ? null : notice,
          );
        }
      } catch (error) {
        let finalError = error;
        if (error instanceof WorkplaceMutationContinuityError) {
          for (const delayMs of [750, 1_500, 3_000]) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
            try {
              await retryWorkplaceAvailability();
              return;
            } catch (retryError) {
              finalError = retryError;
              // A parsed terminal result cleared the exact journal and the
              // retry handler already unlocked/refreshed the workplace.
              if (!(retryError instanceof WorkplaceMutationContinuityError)) return;
            }
          }
        }
        const message = finalError instanceof Error
          ? finalError.message
          : "Predchádzajúcu zmenu pracovného miesta sa nepodarilo bezpečne obnoviť.";
        setWorkplaceLeaseSessionReady(false);
        setWorkplaceLeaseNotice(message);
        if (!(finalError instanceof WorkplaceMutationContinuityError)) {
          await Promise.allSettled([refreshWorkplaceSelection(), refreshWebphoneConfig()]);
          setWorkplacePendingRecoveryComplete(true);
        }
      }
    })().finally(() => {
      setWorkplaceInitialRecoverySettled(true);
    });
  }, [
    recoverPendingWorkplaceMutation,
    refreshTelephonyPresence,
    refreshWebphoneConfig,
    refreshWorkplaceSelection,
    retryWorkplaceAvailability,
    workplaceBrowserInstanceId,
    viewerOrganizationId,
    viewerProfileId,
  ]);

  useEffect(() => {
    if (!workplaceInitialRecoverySettled || workplacePendingRecoveryComplete) return;

    let cancelled = false;
    let retryCount = 0;
    let timeoutId: number | undefined;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      timeoutId = window.setTimeout(() => void recover(), delayMs);
    };
    const recover = async () => {
      if (cancelled) return;
      if (workplaceDurableMutationRef.current) {
        schedule(500);
        return;
      }
      try {
        await retryWorkplaceAvailability();
      } catch (error) {
        if (cancelled || !(error instanceof WorkplaceMutationContinuityError)) return;
        const delayMs = Math.min(
          1_000 * (2 ** Math.min(retryCount, 4)),
          WORKPLACE_RECOVERY_RETRY_MAX_DELAY_MS,
        );
        retryCount += 1;
        schedule(delayMs);
      }
    };

    // A normal mutation gets its own bounded immediate retries first. If all
    // of them lose their response, continue the exact stored request without
    // requiring a reload or a manual click. The shared recovery promise also
    // prevents the button and this timer from creating parallel replays.
    schedule(750);
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [
    retryWorkplaceAvailability,
    workplaceInitialRecoverySettled,
    workplacePendingRecoveryComplete,
  ]);

  useEffect(() => {
    // Self-rescheduling rather than a flat interval, so a hidden tab can slow
    // down and a visible one speeds straight back up.
    let cancelled = false;
    let timeoutId: number | undefined;
    const schedule = () => {
      if (cancelled) return;
      timeoutId = window.setTimeout(async () => {
        await refreshTelephonyPresence();
        schedule();
      }, supportPollDelayMs({ documentHidden: document.visibilityState === "hidden" }));
    };
    const onVisible = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      void refreshTelephonyPresence();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      const request = presenceRequestRef.current;
      presenceRequestRef.current = null;
      request?.controller.abort();
    };
  }, [refreshTelephonyPresence]);

  useEffect(() => {
    // Note: this read is also what currently drives server-side recovery of
    // expired workplace operations, so it stays on the support cadence rather
    // than being slowed further. A durable server-side sweeper is the proper
    // home for that and would let this become a pure read.
    let cancelled = false;
    let timeoutId: number | undefined;
    const schedule = () => {
      if (cancelled) return;
      timeoutId = window.setTimeout(async () => {
        await refreshWorkplaceSelection().catch(() => undefined);
        schedule();
      }, supportPollDelayMs({ documentHidden: document.visibilityState === "hidden" }));
    };
    const onVisible = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      void refreshWorkplaceSelection().catch(() => undefined);
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [refreshWorkplaceSelection]);

  useEffect(() => {
    // A handover is a 30-second decision, so this stays fast while a request is
    // live. With nothing in flight it is only a "has anything appeared?" check
    // and used to run at a flat 4 s, which was the second-noisiest poll here.
    let cancelled = false;
    let timeoutId: number | undefined;
    const schedule = () => {
      if (cancelled) return;
      timeoutId = window.setTimeout(async () => {
        await refreshWorkplaceTakeover().catch(() => undefined);
        schedule();
      }, takeoverPollDelayMs({
        hasOpenRequest: workplaceTakeoverIsOpenRef.current,
        documentHidden: document.visibilityState === "hidden",
      }));
    };
    const onVisible = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      void refreshWorkplaceTakeover().catch(() => undefined);
      schedule();
    };
    void refreshWorkplaceTakeover().catch(() => undefined);
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [refreshWorkplaceTakeover]);

  useEffect(() => {
    workplaceLeaseSessionReadyRef.current = workplaceLeaseSessionReady;
  }, [workplaceLeaseSessionReady]);

  useEffect(() => {
    const isOpen = (status?: string) => status === "pending" || status === "accepted";
    workplaceTakeoverIsOpenRef.current =
      isOpen(workplaceTakeover?.incoming?.status) || isOpen(workplaceTakeover?.outgoing?.status);
  }, [workplaceTakeover?.incoming?.status, workplaceTakeover?.outgoing?.status]);

  const providerRefreshAfterRegistrationRef = useRef<string | null>(null);
  useEffect(() => {
    if (browserRegistrationStatus !== "registered" || !selectedWebphoneExtension) {
      if (browserRegistrationStatus !== "registered") {
        providerRefreshAfterRegistrationRef.current = null;
      }
      return;
    }
    if (providerRefreshAfterRegistrationRef.current === selectedWebphoneExtension) return;
    providerRefreshAfterRegistrationRef.current = selectedWebphoneExtension;
    void refreshTelephonyPresence("provider");
  }, [browserRegistrationStatus, refreshTelephonyPresence, selectedWebphoneExtension]);

  const operatorPresenceHealth = useMemo<TelephonyHealthSignal>(() => {
    return presenceProbe;
  }, [presenceProbe]);
  const actorQueueHealth = useMemo<TelephonyHealthSignal>(() => {
    if (operatorPresenceHealth.state !== "live" || actorRouting) return operatorPresenceHealth;
    return {
      state: "degraded",
      detail: routingDiagnostic ?? "Osobná klapka nie je zaradená v aktuálnom pláne 601–603.",
      checkedAt: operatorPresenceHealth.checkedAt,
      lastSuccessAt: operatorPresenceHealth.lastSuccessAt,
    };
  }, [actorRouting, operatorPresenceHealth, routingDiagnostic]);

  const operatorPresences = useMemo(
    () =>
      deriveTelephonyOperatorPresences({
        operators,
        snapshot: telephonyPresence,
        activeCalls: liveCalls ?? [],
        health: operatorPresenceHealth,
      }),
    [liveCalls, operatorPresenceHealth, operators, telephonyPresence],
  );
  const effectiveOperators = useMemo(() => {
    const presenceByProfile = new Map(operatorPresences.map((presence) => [presence.profileId, presence]));
    return operators.map((operator) => {
      const presence = presenceByProfile.get(operator.id);
      return presence
        ? {
            ...operator,
            extension: presence.primaryExtension ?? "-",
            status: operatorStatusFromPresence(presence.state),
          }
        : { ...operator, status: "offline" as const };
    });
  }, [operatorPresences, operators]);
  const queueCoverage = useMemo(
    () => getQueueCoverage(
      telephonyPresence?.queueStatuses.length ? telephonyPresence.queueStatuses : queueStatus,
      operatorPresences,
    ),
    [operatorPresences, queueStatus, telephonyPresence?.queueStatuses],
  );

  const onQueueAvailabilityAction = useCallback(
    async (target: TelephonyAvailabilityAction) => {
      if (queueCommandPendingRef.current) return;
      if (!defaultExtension) {
        setMutationNotice("Najprv musí byť profilu priradená aktívna osobná VIPTel klapka.");
        return;
      }
      if (!actorRouting) {
        setMutationNotice(routingDiagnostic ?? "Osobná klapka nie je zaradená v aktuálnom pláne 601–603.");
        return;
      }

      try {
        queueCommandPendingRef.current = true;
        setQueueCommandPending(true);
        setQueueCommandTarget(target);
        const response = await telephonyFetch("/api/telephony/queues/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: target, extension: defaultExtension, ...workplaceWebphoneFence }),
          label: "zmena dostupnosti",
          timeoutMs: TELEPHONY_TIMEOUT_MS.control,
        });
        const result = (await response.json().catch(() => null)) as {
          command?: { id: string; status: string };
          error?: string;
          noOp?: boolean;
          ok?: boolean;
          queue?: string;
          routingRevision?: number;
        } | null;
        if (!response.ok || !result?.ok || (!result.noOp && !result.command?.id)) {
          throw new Error(result?.error ?? "Stav v rade sa nepodarilo zmeniť.");
        }
        if (result.noOp) {
          await refreshTelephonyPresence("stored");
          setMutationNotice(
            target === "available"
              ? "VIPTel už potvrdzuje stav Dostupný."
              : target === "pause"
                ? "VIPTel už potvrdzuje stav Pauza."
                : "VIPTel už potvrdzuje stav Offline.",
          );
          return;
        }
        setMutationNotice(`Zmena dostupnosti v rade ${result.queue ?? actorRouting.queue} čaká na potvrdenie VIPTel.`);
        requireConfirmedTelephonyCommand(await waitForTelephonyCommand(result.command!.id));
        await refreshTelephonyPresence("stored");
        setMutationNotice(
          target === "available"
            ? "Stav je Dostupný."
            : target === "pause"
              ? "Stav je Pauza."
              : "Stav je Offline.",
        );
      } catch (error) {
        setMutationNotice(error instanceof Error ? error.message : "Stav v rade sa nepodarilo zmeniť.");
        void refreshTelephonyPresence("stored");
      } finally {
        queueCommandPendingRef.current = false;
        setQueueCommandPending(false);
        setQueueCommandTarget(null);
      }
    },
    [actorRouting, defaultExtension, refreshTelephonyPresence, routingDiagnostic, workplaceWebphoneFence],
  );

  const visibleCallCenterCalls = useMemo(
    () => mergeProviderCallsWithHistory(callCenterCalls, liveCalls),
    [callCenterCalls, liveCalls],
  );
  const telephonyCallStations = useMemo(() => {
    const stations: TelephonyExtensionIdentity[] = (telephonyPresence?.extensions ?? [])
      .filter((extension) => extension.active)
      .map((extension) => ({ extension: extension.extension, profileId: extension.profileId }));
    if (defaultExtension && !stations.some((station) => station.extension === defaultExtension)) {
      stations.push({
        extension: defaultExtension,
        profileId: telephonyPresence?.actorProfileId ?? viewerProfileId,
      });
    }
    return stations;
  }, [defaultExtension, telephonyPresence?.actorProfileId, telephonyPresence?.extensions, viewerProfileId]);
  const currentCallStation = telephonyCallStations.find((station) => station.extension === defaultExtension);

  // The waiting room is owned here, not inside the call-centre view, so it can
  // be shown on every view and so exactly one pickup can be in flight per
  // browser regardless of which surface started it.
  const liveActiveCalls = useMemo(
    () => partitionLiveTelephonyCalls(liveCalls ?? []).active,
    [liveCalls],
  );
  const waitingRoomStations = useMemo(
    () => buildWorkplaceStations({
      activeCalls: liveCalls ?? [],
      health: operatorPresenceHealth,
      operators: effectiveOperators,
      operatorPresences,
      snapshot: telephonyPresence,
    }),
    [effectiveOperators, liveCalls, operatorPresenceHealth, operatorPresences, telephonyPresence],
  );
  const waitingRoomCalls = useMemo(
    () => buildWorkplaceWaitingRoom(liveCalls ?? [], waitingRoomStations),
    [liveCalls, waitingRoomStations],
  );
  const callRingsAtCurrentStation = useCallback((call: CallCenterCall) => Boolean(
    currentCallStation && callIsRingingAtTelephonyStation(call, currentCallStation, telephonyCallStations),
  ), [currentCallStation, telephonyCallStations]);
  const inboundBrowserProviderCall = useMemo(() => {
    if (!browserWebphone.hasActiveCall || browserWebphone.callDirection !== "inbound") return undefined;
    return resolveIncomingBrowserProviderCall(liveCalls ?? [], currentCallStation, telephonyCallStations);
  }, [browserWebphone.callDirection, browserWebphone.hasActiveCall, currentCallStation, liveCalls, telephonyCallStations]);
  const browserControlledCall = useMemo(() => {
    if (browserWebphone.callDirection === "inbound") return inboundBrowserProviderCall;
    if (browserWebphone.callDirection === "outbound") {
      return resolveOutboundBrowserProviderCall(
        visibleCallCenterCalls,
        currentCallStation,
        telephonyCallStations,
        browserWebphone.activeCallTarget,
      );
    }
    return resolveUniqueCurrentTelephonyCall(
      visibleCallCenterCalls,
      currentCallStation,
      telephonyCallStations,
    );
  }, [browserWebphone.activeCallTarget, browserWebphone.callDirection, currentCallStation, inboundBrowserProviderCall, telephonyCallStations, visibleCallCenterCalls]);
  const browserCallDirection = browserWebphone.callDirection ?? (
    browserControlledCall?.direction === "inbound" || browserControlledCall?.direction === "outbound"
      ? browserControlledCall.direction
      : null
  );
  const browserPresentedCall = presentCallForBrowser(browserControlledCall, browserWebphone);
  // Provider polling can briefly lose a call while SIP remains in the same
  // ringing/connected session. Retain the last persisted row for that session
  // so case and transfer controls do not flicker or disappear between polls.
  const stableBrowserCallRef = useRef<{
    call: CallCenterCall;
    direction: "inbound" | "outbound" | null;
    sipCall: BrowserCallSessionFence;
    target: string;
  } | null>(null);
  const currentBrowserSipCall = browserWebphone.captureCallSession();
  const browserCallTargetKey = browserCallDirection === "outbound"
    ? browserCallIdentity(browserWebphone.activeCallTarget ?? browserPresentedCall?.calledNumber ?? "")
    : browserCallIdentity(browserPresentedCall?.callerNumber ?? "");
  useEffect(() => {
    if (!browserWebphone.hasActiveCall) {
      stableBrowserCallRef.current = null;
      return;
    }
    if (browserPresentedCall && looksLikeUuid(browserPresentedCall.id)) {
      const cached = stableBrowserCallRef.current;
      const currentSessionCache = cached && sameBrowserCallSession(cached.sipCall, currentBrowserSipCall)
        ? cached
        : null;
      if (
        currentSessionCache &&
        !sameTelephonyCallIdentity(currentSessionCache.call, browserPresentedCall)
      ) {
        // A polling response must not silently replace the call attached to an
        // already-running SIP dialog. This is especially important when two
        // provider events arrive in the same millisecond.
        return;
      }
      stableBrowserCallRef.current = {
        call: currentSessionCache
          ? preserveStableCallPresentation(currentSessionCache.call, browserPresentedCall)
          : browserPresentedCall,
        direction: browserCallDirection,
        sipCall: currentBrowserSipCall as BrowserCallSessionFence,
        target: browserCallTargetKey,
      };
      return;
    }
    const cached = stableBrowserCallRef.current;
    if (
      cached &&
      (!sameBrowserCallSession(cached.sipCall, currentBrowserSipCall) ||
        cached.direction !== browserCallDirection ||
        (browserCallDirection === "outbound" && browserCallTargetKey && cached.target && cached.target !== browserCallTargetKey))
    ) {
      stableBrowserCallRef.current = null;
    }
  }, [browserCallDirection, browserCallTargetKey, browserPresentedCall, browserWebphone.hasActiveCall, currentBrowserSipCall]);
  const cachedBrowserCallCandidate = stableBrowserCallRef.current;
  const cachedBrowserCall = cachedBrowserCallCandidate &&
    sameBrowserCallSession(cachedBrowserCallCandidate.sipCall, currentBrowserSipCall)
    ? cachedBrowserCallCandidate
    : null;
  const cachedBrowserCallMatchesSession = Boolean(
    browserWebphone.hasActiveCall &&
    cachedBrowserCall &&
    sameBrowserCallSession(cachedBrowserCall.sipCall, currentBrowserSipCall) &&
    cachedBrowserCall.direction === browserCallDirection &&
    (browserCallDirection === "inbound" || !browserCallTargetKey || !cachedBrowserCall.target || cachedBrowserCall.target === browserCallTargetKey),
  );
  const presentedCallMatchesCached = Boolean(
    !cachedBrowserCall || (browserPresentedCall && sameTelephonyCallIdentity(cachedBrowserCall.call, browserPresentedCall)),
  );
  const browserActionCall = browserPresentedCall && looksLikeUuid(browserPresentedCall.id) && presentedCallMatchesCached
    ? cachedBrowserCall
      ? preserveStableCallPresentation(cachedBrowserCall.call, browserPresentedCall)
      : browserPresentedCall
    : cachedBrowserCallMatchesSession ? cachedBrowserCall?.call : undefined;
  const stableCallCenterCalls = useMemo(() => {
    if (!browserWebphone.hasActiveCall || !browserActionCall) return visibleCallCenterCalls;
    const existingIndex = visibleCallCenterCalls.findIndex((call) => sameTelephonyCallIdentity(call, browserActionCall));
    if (existingIndex < 0) return [browserActionCall, ...visibleCallCenterCalls];
    return visibleCallCenterCalls.map((call, index) => index === existingIndex ? browserActionCall : call);
  }, [browserActionCall, browserWebphone.hasActiveCall, visibleCallCenterCalls]);
  const browserPartyNumber = browserCallDirection === "outbound"
    ? browserWebphone.activeCallTarget ?? browserActionCall?.calledNumber
    : browserActionCall?.callerNumber;
  const browserPartyName = browserCallDirection === "inbound" ? browserActionCall?.callerName : undefined;
  const providerOnlyActionCall = !browserWebphone.hasActiveCall && browserActionCall &&
    (browserActionCall.status === "answered" || browserActionCall.status === "outbound")
    ? browserActionCall
    : undefined;
  const floatingActionCall = browserWebphone.hasActiveCall ? browserActionCall : providerOnlyActionCall;
  const floatingCallDirection = browserWebphone.hasActiveCall
    ? browserCallDirection
    : providerOnlyActionCall?.direction ?? null;
  const floatingTransferTransport = telephonyTransferTransport(
    floatingCallDirection,
    browserWebphone.hasActiveCall,
  );
  const floatingPartyNumber = browserWebphone.hasActiveCall
    ? browserPartyNumber
    : providerOnlyActionCall
      ? customerNumberForCall(providerOnlyActionCall)
      : undefined;
  const floatingPartyName = browserWebphone.hasActiveCall
    ? browserPartyName
    : providerOnlyActionCall?.direction === "inbound"
      ? providerOnlyActionCall.callerName
      : undefined;
  const browserControlledCallRef = useRef(browserActionCall);
  browserControlledCallRef.current = browserActionCall;
  const popupCall = useMemo(() => {
    if (
      browserWebphone.callStatus === "incoming" &&
      inboundBrowserProviderCall &&
      inboundBrowserProviderCall.id !== dismissedIncomingCallId
    ) {
      return toDispatchCall(inboundBrowserProviderCall);
    }
    return liveIncomingCall(liveCalls ?? [], dismissedIncomingCallId, callRingsAtCurrentStation);
  }, [browserWebphone.callStatus, callRingsAtCurrentStation, dismissedIncomingCallId, inboundBrowserProviderCall, liveCalls]);
  const incomingPopupCall = popupCall ?? {
    ...incomingCall,
    id: "webphone-incoming",
    status: "incoming" as const,
    callerName: undefined,
    callerNumber: "Prichádzajúci hovor",
    waitSeconds: 0,
  };
  const callsByCaseId = useMemo(() => latestCallByCaseId(visibleCallCenterCalls), [visibleCallCenterCalls]);
  const filteredCases = useMemo(() => {
    const branchesById = new Map(branches.map((branch) => [branch.id, branch]));
    const assetsById = new Map(fleetAssets.map((asset) => [asset.id, asset]));
    const operatorsById = new Map(effectiveOperators.map((operator) => [operator.id, operator]));

    return dispatchCases
      .filter((caseItem) => caseMatchesFilters(caseItem, caseFilters))
      .filter((caseItem) =>
        caseMatchesSearch({
          assetsById,
          branchesById,
          call: callsByCaseId.get(caseItem.id),
          caseItem,
          operatorsById,
          search: caseSearch,
        }),
      )
      .sort((left, right) => compareCases(left, right, caseSort, callsByCaseId, operatorsById, branchesById, assetsById));
  }, [branches, callsByCaseId, caseFilters, caseSearch, caseSort, dispatchCases, effectiveOperators, fleetAssets]);
  const filteredActiveCases = useMemo(() => filteredCases.filter(isActiveDispatchCase), [filteredCases]);
  const activeCasesTotal = useMemo(() => dispatchCases.filter(isActiveDispatchCase).length, [dispatchCases]);
  const activeFilterCount = [
    caseSearch.trim(),
    caseFilters.status !== "all",
    caseFilters.priority !== "all",
    caseFilters.ownerId !== "all",
    caseFilters.sourceType !== "all",
    caseFilters.assistanceService !== "all",
  ].filter(Boolean).length;
  const assistanceServiceOptions = useMemo(
    () => [...new Set(dispatchCases.map(caseAssistanceServiceName).filter(Boolean))].sort((left, right) => left.localeCompare(right, "sk")),
    [dispatchCases],
  );
  const visibleWarning = warning && warning !== dismissedWarning ? warning : null;
  const visibleMutationError = mutationNotice && isGlobalErrorNotice(mutationNotice) ? mutationNotice : null;
  const openTaskCount = useMemo(
    () => dispatchCases.reduce((count, caseItem) => count + caseItem.tasks.filter(isTaskOpen).length, 0),
    [dispatchCases],
  );
  const viewerNotifications = useMemo(
    () => notifications.filter((notification) => isNotificationForProfile(notification, viewerProfileId)),
    [notifications, viewerProfileId],
  );
  const unreadNotificationCount = useMemo(
    () => viewerNotifications.filter(isNotificationUnread).length,
    [viewerNotifications],
  );
  const taskAttentionCount = openTaskCount + unreadNotificationCount;
  const activeCase =
    dispatchCases.find((caseItem) => caseItem.id === activeCaseId && isActiveDispatchCase(caseItem)) ??
    dispatchCases.find(isActiveDispatchCase);
  const selectedCase = dispatchCases.find((caseItem) => caseItem.id === activeCaseId);
  const workspaceCase = workspace.kind === "detail" ? selectedCase ?? activeCase : activeCase;
  const workspaceCasePrimaryContact = workspaceCase?.customerDetails.contacts?.find((contact) => contact.isPrimary) ?? workspaceCase?.customerDetails.contacts?.[0];
  const dashboardSmsCaseContext = workspaceCase
    ? {
        caseNumber: workspaceCase.caseNumber,
        id: workspaceCase.id,
        phone: workspaceCasePrimaryContact?.phone || workspaceCase.contact.phone,
      }
    : undefined;
  const visibleActiveCaseId = activeCase?.id ?? "";
  const activePriceRule = workspaceCase?.priceRuleId
    ? priceRules.find((rule) => rule.id === workspaceCase.priceRuleId)
    : undefined;
  const mapModel = useMemo(
    () => (workspaceCase ? createDispatchMapModel(workspaceCase, branches, fleetAssets, activePriceRule) : undefined),
    [activePriceRule, branches, fleetAssets, workspaceCase],
  );
  const refreshCallHistory = useCallback(async () => {
    if (callHistoryRefreshInFlight.current) return;
    callHistoryRefreshInFlight.current = true;

    try {
      const response = await telephonyFetch("/api/telephony/calls/history", {
        label: "história hovorov",
        timeoutMs: TELEPHONY_TIMEOUT_MS.read,
      });
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        ok?: boolean;
        calls?: CallCenterCall[];
      } | null;

      if (!response.ok || !result?.ok || !Array.isArray(result.calls)) {
        throw new Error(result?.error ?? "Históriu hovorov sa nepodarilo obnoviť.");
      }

      setDispatchData((current) => ({ ...current, callCenterCalls: result.calls ?? current.callCenterCalls }));
    } catch (error) {
      console.warn("Telephony call history refresh failed:", error instanceof Error ? error.message : error);
    } finally {
      callHistoryRefreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    // History is the least time-critical read here: a call that ended while the
    // tab was hidden is equally interesting a few seconds later.
    let cancelled = false;
    let timeoutId: number | undefined;
    const schedule = () => {
      if (cancelled) return;
      timeoutId = window.setTimeout(async () => {
        await refreshCallHistory();
        schedule();
      }, supportPollDelayMs({ documentHidden: document.visibilityState === "hidden" }));
    };
    const onVisible = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      void refreshCallHistory();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [refreshCallHistory]);

  async function requestProviderHangup(
    call: CallCenterCall,
    options: { incomingQueueDecline?: boolean } = {},
  ) {
    if (!looksLikeUuid(call.id) || !call.viptelUniqueId) {
      throw new Error("Hovor ešte nemá bezpečný VIPTel identifikátor pre ukončenie.");
    }
    setMutationNotice("Ukončenie hovoru čaká na potvrdenie VIPTel.");
    const response = await telephonyFetch(`/api/telephony/calls/${encodeURIComponent(call.id)}/hangup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(workplaceWebphoneFence ?? {}),
        ...(options.incomingQueueDecline ? { intent: "decline_incoming_queue" } : {}),
      }),
      label: "ukončenie hovoru",
      timeoutMs: TELEPHONY_TIMEOUT_MS.control,
    });
    const result = (await response.json().catch(() => null)) as { command?: { id: string }; error?: string } | null;
    if (!response.ok || !result?.command?.id) {
      throw new Error(result?.error ?? "Hovor sa nepodarilo ukončiť cez VIPTel.");
    }
    requireConfirmedTelephonyCommand(await waitForTelephonyCommand(result.command.id));
    setMutationNotice("VIPTel potvrdil ukončenie hovoru.");
    void refreshCallHistory();
  }

  async function resolveCurrentIncomingCall() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const url = attempt === 0 ? "/api/telephony/calls/active" : "/api/telephony/calls/active?fresh=1";
      const response = await fetch(url, { cache: "no-store" });
      const result = (await response.json().catch(() => null)) as {
        calls?: CallCenterCall[];
        error?: string;
        ok?: boolean;
      } | null;
      if (!response.ok || !result?.ok || !Array.isArray(result.calls)) {
        throw new Error(result?.error ?? "Aktuálny hovor sa nepodarilo načítať.");
      }
      setLiveCalls(result.calls);
      const current = resolveIncomingBrowserProviderCall(
        result.calls,
        currentCallStation,
        telephonyCallStations,
      );
      if (current) return current;
    }
    return undefined;
  }

  async function declineBrowserIncomingCall() {
    const currentRequest = incomingDeclineRequestRef.current;
    if (currentRequest) return currentRequest;

    const request = (async () => {
      setMutationNotice("Ukončujem prichádzajúci hovor vo VIPTel.");
      const capturedSipCall = browserWebphone.captureCallSession();
      const mappedCall = inboundBrowserProviderCall ?? (
        browserActionCall?.direction === "inbound" ? browserActionCall : undefined
      ) ?? (
        looksLikeUuid(incomingPopupCall.id) && incomingPopupCall.viptelUniqueId
          ? visibleCallCenterCalls.find((call) => call.id === incomingPopupCall.id)
          : undefined
      );
      try {
        const call = mappedCall ?? await resolveCurrentIncomingCall();
        if (!call) {
          throw new Error("VIPTel hovor sa nepodarilo bezpečne priradiť k tejto zvoniacej klapke.");
        }
        // The provider command targets the logical queue parent. Rejecting the
        // local SIP invitation first would advance the still-live caller to the
        // next workstation and create the phantom ringing reported in practice.
        await terminateQueuedIncomingCall(
          () => requestProviderHangup(call, { incomingQueueDecline: true }),
          async () => {
            if (capturedSipCall) await browserWebphone.declineCapturedCall(capturedSipCall);
          },
        );
      } catch (error) {
        // Never reject only the local queue leg. That would move the still-live
        // caller to the next dispatcher, which is not what "Odmietnuť" means.
        const message = error instanceof Error ? error.message : "VIPTel nepotvrdil ukončenie hovoru.";
        setMutationNotice(`${message} Hovor som lokálne neodmietol, pretože by sa posunul ďalšiemu dispečerovi. Skús ukončenie znova po obnovení stavu.`);
        throw error;
      }
    })();

    incomingDeclineRequestRef.current = request;
    setIncomingDeclinePending(true);
    try {
      await request;
    } finally {
      if (incomingDeclineRequestRef.current === request) {
        incomingDeclineRequestRef.current = null;
        setIncomingDeclinePending(false);
      }
    }
  }

  async function hangupBrowserCall() {
    let call = browserActionCall;
    setMutationNotice("Ukončujem hovor…");
    const capturedSipCall = browserWebphone.captureCallSession();
    if (!call && browserCallDirection === "inbound") {
      // Never turn an inbound queue hangup into a local SIP-only BYE. That
      // closes merely the current agent leg and leaves the caller alive in
      // the PBX. Resolve the exact logical queue call before touching SIP.
      call = await resolveCurrentIncomingCall();
      if (!call) {
        throw new Error("VIPTel hovor sa nepodarilo bezpečne identifikovať. Hovor som lokálne neukončil, aby volajúci nezostal visieť v rade.");
      }
    }
    if (!call) {
      if (!capturedSipCall) throw new Error("Aktívny SIP hovor sa už nenašiel.");
      await browserWebphone.hangupCapturedCall(capturedSipCall);
      setMutationNotice("Hovor bol ukončený. História sa obnoví po udalosti VIPTel.");
      void refreshCallHistory();
      return;
    }

    // End the exact provider call first. A local BYE can close only the agent
    // leg while a queued caller remains alive, and after confirmation a new
    // SIP invitation may already be present. The captured-session fence makes
    // sure cleanup can never hang up that next call.
    await requestProviderHangup(call);
    if (capturedSipCall) await browserWebphone.hangupCapturedCall(capturedSipCall);
    setMutationNotice("VIPTel potvrdil ukončenie hovoru. Telefón je pripravený na ďalší hovor.");
    void refreshCallHistory();
  }

  async function hangupProviderCall(call: CallCenterCall) {
    try {
      await requestProviderHangup(call);
    } catch (error) {
      setMutationNotice(error instanceof Error ? error.message : "Hovor sa nepodarilo ukončiť.");
    }
  }

  async function transferBrowserSipCall(
    call: CallCenterCall,
    destination: TelephonyRedirectDestination,
  ): Promise<boolean> {
    if (!looksLikeUuid(call.id) || !call.viptelUniqueId) {
      throw new Error("Hovor ešte nemá bezpečný VIPTel identifikátor pre auditované prepojenie.");
    }

    const sessionFence = browserWebphone.captureSipReferSession(call.id, call.viptelUniqueId);
    const endpoint = `/api/telephony/calls/${encodeURIComponent(call.id)}/sip-transfer`;
    setMutationNotice("Overujem cieľ a pripravujem bezpečné prepojenie hovoru.");
    const intentResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...destination, ...workplaceWebphoneFence }),
    });
    const intent = (await intentResponse.json().catch(() => null)) as {
      authorizedTarget?: unknown;
      authorizedViptelUniqueId?: unknown;
      command?: { id?: string };
      error?: string;
    } | null;
    if (
      !intentResponse.ok ||
      !intent?.command?.id ||
      typeof intent.authorizedTarget !== "string" ||
      typeof intent.authorizedViptelUniqueId !== "string"
    ) {
      const message = intent?.error ?? "Auditované SIP prepojenie sa nepodarilo pripraviť.";
      setMutationNotice(message);
      throw new Error(message);
    }

    let reportBody: { commandId: string; error?: string; outcome: "accepted" | "failed"; sipStatus?: number };
    let transferError: Error | undefined;
    try {
      const result = await browserWebphone.sendSipReferTransfer(
        intent.authorizedTarget,
        sessionFence,
        intent.authorizedTarget,
        intent.authorizedViptelUniqueId,
        () => {
          const current = browserControlledCallRef.current;
          return current && looksLikeUuid(current.id) && current.viptelUniqueId
            ? { callId: current.id, viptelUniqueId: current.viptelUniqueId }
            : undefined;
        },
      );
      reportBody = {
        commandId: intent.command.id,
        outcome: "accepted",
        sipStatus: result.statusCode,
      };
    } catch (error) {
      transferError = error instanceof Error ? error : new Error("SIP prepojenie sa nepodarilo odoslať.");
      reportBody = {
        commandId: intent.command.id,
        error: transferError.message,
        outcome: "failed",
      };
    }

    let auditWarning: string | undefined;
    try {
      const reportResponse = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reportBody),
      });
      const report = (await reportResponse.json().catch(() => null)) as { error?: string; ok?: boolean } | null;
      if (!reportResponse.ok || !report?.ok) {
        auditWarning = report?.error ?? "Výsledok SIP prepojenia sa nepodarilo uložiť do auditu.";
      }
    } catch (error) {
      auditWarning = error instanceof Error ? error.message : "Výsledok SIP prepojenia sa nepodarilo uložiť do auditu.";
    }

    if (transferError) {
      const message = auditWarning ? `${transferError.message} Audit: ${auditWarning}` : transferError.message;
      setMutationNotice(message);
      throw new Error(message);
    }

    setMutationNotice(auditWarning
      ? `VIPTel prijal prepojenie, ale audit sa nepotvrdil: ${auditWarning}`
      : "VIPTel prijal prepojenie hovoru.");
    void refreshCallHistory();
    return true;
  }

  async function redirectTelephonyCall(
    call: Pick<CallCenterCall, "id" | "viptelUniqueId">,
    destination: TelephonyRedirectDestination,
  ): Promise<boolean> {
    if (!looksLikeUuid(call.id) || !call.viptelUniqueId) {
      throw new Error("Hovor ešte nemá bezpečný VIPTel identifikátor pre prepojenie.");
    }

    setMutationNotice("Prepojenie čaká na potvrdenie VIPTel.");
    const response = await telephonyFetch(`/api/telephony/calls/${encodeURIComponent(call.id)}/redirect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...destination, ...workplaceWebphoneFence }),
      label: "prepojenie hovoru",
      timeoutMs: TELEPHONY_TIMEOUT_MS.control,
    });
    const result = (await response.json().catch(() => null)) as { command?: { id?: string }; error?: string } | null;
    if (!response.ok || !result?.command?.id) {
      const message = result?.error ?? "Hovor sa nepodarilo prepojiť.";
      setMutationNotice(message);
      throw new Error(message);
    }

    try {
      requireConfirmedTelephonyCommand(await waitForTelephonyCommand(result.command.id));
      setMutationNotice("VIPTel potvrdil prepojenie hovoru.");
      void refreshCallHistory();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "VIPTel prepojenie nepotvrdil.";
      setMutationNotice(message);
      throw error;
    }
  }

  const navItems: Array<{ badgeCount?: number; icon: LucideIcon; label: string; shortLabel: string; view: View }> = [
    { icon: LayoutDashboard, label: "Dispečing", shortLabel: "Dispeč.", view: "dispatch" },
    { badgeCount: taskAttentionCount, icon: BellRing, label: "Úlohy", shortLabel: "Úlohy", view: "tasks" },
    { icon: Table2, label: "Prípady", shortLabel: "Prípady", view: "cases" },
    { icon: Headphones, label: "Ústredňa", shortLabel: "Ústredňa", view: "call-center" },
    { icon: CalendarDays, label: "Dochádzka", shortLabel: "Doch.", view: "attendance" },
    { icon: Truck, label: "Flotila", shortLabel: "Flotila", view: "fleet" },
    { icon: BarChart3, label: "Reporty", shortLabel: "Reporty", view: "reports" },
    { icon: Settings2, label: "Nastavenia", shortLabel: "Nastav.", view: "settings" },
  ];

  // Živé hovory sa sledujú na každom pohľade, aby popup prichádzajúceho hovoru
  // (a možnosť ho prijať) nezostal viditeľný len v Ústredni.
  useEffect(() => {
    let cancelled = false;
    let historyRetryId: number | undefined;
    let pollTimeoutId: number | undefined;
    let requestInFlight = false;
    let requestController: AbortController | null = null;
    let consecutiveFailures = 0;

    function scheduleNextPoll() {
      if (cancelled) return;
      if (pollTimeoutId !== undefined) window.clearTimeout(pollTimeoutId);
      const delay = activeCallPollDelayMs({
        activity: telephonyPollActivity({
          hasBrowserCall: browserWebphone.hasActiveCall,
          liveCallCount: liveCallIdentityRef.current.size,
        }),
        documentHidden: typeof document !== "undefined" && document.visibilityState === "hidden",
        consecutiveFailures,
      });
      pollTimeoutId = window.setTimeout(() => void refreshActiveCalls(), delay);
    }

    async function refreshActiveCalls() {
      if (requestInFlight) return;
      requestInFlight = true;
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), TELEPHONY_READ_TIMEOUT_MS);
      requestController = controller;

      try {
        const response = await fetch("/api/telephony/calls/active", {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = (await response.json().catch(() => null)) as {
          checkedAt?: string;
          error?: string;
          ok?: boolean;
          calls?: CallCenterCall[];
          providerVerified?: boolean;
          warning?: string;
        } | null;

        if (!cancelled && response.ok && result?.ok && Array.isArray(result.calls)) {
          consecutiveFailures = 0;
          const nextIdentities = new Set(result.calls.flatMap(callIdentityKeys));
          const callEnded = [...liveCallIdentityRef.current].some((identity) => !nextIdentities.has(identity));
          liveCallIdentityRef.current = nextIdentities;
          setLiveCalls(result.calls);
          const providerVerified = result.providerVerified !== false;
          setActiveCallsProbe((current) => ({
            state: providerVerified ? "live" : "degraded",
            detail: providerVerified
              ? "VIPTel active-calls REST API odpovedá."
              : result.warning ?? "Zobrazené sú čerstvé hovory z listenera; VIPTel REST overenie sa obnovuje.",
            checkedAt: result.checkedAt,
            lastSuccessAt: providerVerified ? result.checkedAt : current.lastSuccessAt,
          }));
          if (callEnded) {
            void refreshCallHistory();
            if (historyRetryId !== undefined) window.clearTimeout(historyRetryId);
            historyRetryId = window.setTimeout(() => void refreshCallHistory(), CALL_HISTORY_RETRY_MS);
          }
        } else if (!cancelled) {
          consecutiveFailures += 1;
          setActiveCallsProbe((current) => ({
            state: failedProbeState(current, result?.checkedAt ?? new Date().toISOString()),
            detail: result?.error ?? "VIPTel active-calls REST API neodpovedá.",
            checkedAt: result?.checkedAt ?? new Date().toISOString(),
            lastSuccessAt: current.lastSuccessAt,
          }));
        }
      } catch (error) {
        if (!cancelled) {
          consecutiveFailures += 1;
          const checkedAt = new Date().toISOString();
          setActiveCallsProbe((current) => ({
            state: failedProbeState(current, checkedAt),
            detail: isAbortError(error)
              ? "Načítanie aktívnych hovorov prekročilo časový limit. Skúsime to znova automaticky."
              : error instanceof Error
                ? error.message
                : "VIPTel active-calls REST API neodpovedá.",
            checkedAt,
            lastSuccessAt: current.lastSuccessAt,
          }));
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (requestController === controller) {
          requestController = null;
        }
        requestInFlight = false;
        scheduleNextPoll();
      }
    }

    // Becoming visible again must not wait out a 15-second hidden interval:
    // the operator is looking at the console now.
    function onVisibilityChange() {
      if (cancelled || document.visibilityState !== "visible") return;
      void refreshActiveCalls();
    }

    void refreshActiveCalls();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (pollTimeoutId !== undefined) window.clearTimeout(pollTimeoutId);
      requestController?.abort();
      if (historyRetryId !== undefined) window.clearTimeout(historyRetryId);
    };
  }, [browserWebphone.hasActiveCall, refreshCallHistory]);

  // Stable so it does not invalidate the call-centre effects that depend on it;
  // as an inline arrow it was a new function on every render.
  const handleTelephonyChanged = useCallback(() => {
    void refreshTelephonyPresence("stored");
    void refreshCallHistory();
  }, [refreshCallHistory, refreshTelephonyPresence]);

  // One shared clock for every waiting-call timer, ticking only while somebody
  // is actually waiting.
  const [queueClockNow, setQueueClockNow] = useState(() => Date.now());
  const waitingCallCount = waitingRoomCalls.length;
  useEffect(() => {
    if (waitingCallCount === 0) return;
    const timer = window.setInterval(() => setQueueClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [waitingCallCount]);

  const waitingPickup = useWaitingCallPickup({
    activeCalls: liveActiveCalls,
    browserWebphone,
    controlStations: telephonyCallStations,
    currentControlStation: currentCallStation,
    defaultExtension,
    workplaceFence: workplaceWebphoneFence,
    workplacePhoneMutationPending,
    onNotice: setMutationNotice,
    onTelephonyChanged: handleTelephonyChanged,
  });

  const handleSaveDraftChange = useCallback((saveDraft: SaveCaseDraft | null) => {
    saveCaseDraftRef.current = saveDraft;
  }, []);

  const finishPendingNavigation = useCallback(() => {
    const navigate = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    setLeaveDialogOpen(false);
    setLeaveDialogSaving(false);
    setLeaveDialogError(null);
    setLeaveAfterSave(false);
    leaveObservedSavingRef.current = false;
    setHasUnsavedChanges(false);
    setIsCaseSaveLocked(false);
    navigate?.();
  }, []);

  const requestNavigation = useCallback((navigate: () => void) => {
    if (!hasUnsavedChanges && !isCaseSaveLocked) {
      navigate();
      return true;
    }

    pendingNavigationRef.current = navigate;
    setLeaveDialogError(null);
    setLeaveDialogOpen(true);
    return false;
  }, [hasUnsavedChanges, isCaseSaveLocked]);

  const cancelPendingNavigation = useCallback(() => {
    pendingNavigationRef.current = null;
    setLeaveDialogOpen(false);
    setLeaveDialogError(null);
    setLeaveAfterSave(false);
    leaveObservedSavingRef.current = false;
  }, []);

  function discardAndLeave() {
    if (isCaseSaveLocked || leaveDialogSaving) return;
    finishPendingNavigation();
  }

  async function saveAndLeave() {
    if (leaveDialogSaving) return;

    if (isCaseSaveLocked) {
      setLeaveAfterSave(true);
      setLeaveDialogError(null);
      return;
    }

    const saveDraft = saveCaseDraftRef.current;
    if (!saveDraft) {
      setLeaveDialogError("Karta ešte nie je pripravená na uloženie. Skúste to znova.");
      return;
    }

    setLeaveDialogSaving(true);
    setLeaveDialogError(null);
    const saved = await saveDraft();
    setLeaveDialogSaving(false);

    if (saved) {
      finishPendingNavigation();
      return;
    }

    setLeaveDialogError("Rozpracovaný prípad sa nepodarilo uložiť. Údaje zostali vo formulári.");
  }

  function selectCase(caseId: string) {
    return requestNavigation(() => {
      setActiveCaseId(caseId);
      setFocusedTaskId(undefined);
      setWorkspace({ kind: "cockpit", mode: "split" });
    });
  }

  function openCase(caseId: string) {
    requestNavigation(() => {
      setActiveCaseId(caseId);
      setFocusedTaskId(undefined);
      setWorkspace({ kind: "cockpit", mode: "split" });
      setActiveView("dispatch");
    });
  }

  function openCaseDetail(caseId: string) {
    requestNavigation(() => {
      setActiveCaseId(caseId);
      setFocusedTaskId(undefined);
      returnViewRef.current = activeView;
      if (activeView !== "cases") {
        setActiveView("dispatch");
      }
      setWorkspace({ kind: "detail", mode: "expanded" });
    });
  }

  function openTask(taskId: string, caseId: string) {
    requestNavigation(() => {
      acknowledgeTaskNotifications(taskId);
      returnViewRef.current = activeView;
      setActiveCaseId(caseId);
      setActiveView("dispatch");
      setFocusedTaskId(taskId);
      setWorkspace({ kind: "detail", mode: "expanded" });
    });
  }

  function acknowledgeTaskNotifications(taskId: string) {
    const notificationIds = viewerNotifications
      .filter((notification) => notification.taskId === taskId && isNotificationUnread(notification))
      .map((notification) => notification.id);

    if (notificationIds.length === 0) return;

    const acknowledgedAt = new Date().toISOString();
    const notificationIdSet = new Set(notificationIds);
    setDispatchData((current) => ({
      ...current,
      notifications: current.notifications.map((notification) =>
        notificationIdSet.has(notification.id)
          ? { ...notification, status: "read", readAt: acknowledgedAt, updatedAt: acknowledgedAt }
          : notification,
      ),
    }));

    void Promise.all(notificationIds.map(async (notificationId) => {
      const response = await fetch(`/api/notifications/${encodeURIComponent(notificationId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "read" }),
      });
      if (!response.ok) throw new Error(`Notification ${notificationId} acknowledgement failed.`);
    })).catch((error) => console.warn("Task notification acknowledgement failed:", error));
  }

  useEffect(() => {
    if (!leaveAfterSave) {
      leaveObservedSavingRef.current = false;
      return;
    }

    if (isCaseSaveLocked) {
      leaveObservedSavingRef.current = true;
      return;
    }

    if (!hasUnsavedChanges) {
      finishPendingNavigation();
      return;
    }

    if (leaveObservedSavingRef.current) {
      leaveObservedSavingRef.current = false;
      setLeaveAfterSave(false);
      setLeaveDialogError("Automatické uloženie sa nepodarilo dokončiť. Údaje zostali vo formulári; môžete skúsiť uloženie znova alebo zostať v editácii.");
    }
  }, [finishPendingNavigation, hasUnsavedChanges, isCaseSaveLocked, leaveAfterSave]);

  const syncDueNotifications = useCallback(
    async (silent = true) => {
      if (source !== "supabase" || notificationSyncInFlight.current) {
        return;
      }

      notificationSyncInFlight.current = true;
      setIsNotificationSyncing(true);

      try {
        const response = await fetch("/api/notifications", { cache: "no-store" });
        const result = (await response.json()) as {
          error?: string;
          notifications?: DispatchData["notifications"];
        };

        if (!response.ok || !result.notifications) {
          throw new Error(result.error ?? "Notifikácie sa nepodarilo obnoviť.");
        }

        setDispatchData((current) => ({ ...current, notifications: result.notifications ?? current.notifications }));
        setLastNotificationSyncAt(new Date().toISOString());

        if (!silent) {
          setMutationNotice("Notifikácie sú aktuálne.");
        }
      } catch (error) {
        if (silent) {
          console.warn("Notification sync failed:", error);
        } else {
          setMutationNotice(error instanceof Error ? error.message : "Notifikácie sa nepodarilo obnoviť.");
        }
      } finally {
        notificationSyncInFlight.current = false;
        setIsNotificationSyncing(false);
      }
    },
    [source],
  );

  useEffect(() => {
    if (source !== "supabase") {
      return;
    }

    void syncDueNotifications(true);
    const interval = window.setInterval(() => {
      void syncDueNotifications(true);
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [source, syncDueNotifications]);

  const pollCustomerLocationUpdates = useCallback(async () => {
    if (source !== "supabase" || locationUpdatePollInFlight.current) return;
    locationUpdatePollInFlight.current = true;

    try {
      const params = new URLSearchParams({ since: locationUpdateCursorRef.current });
      const response = await fetch(`/api/cases/location-updates?${params.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = (await response.json().catch(() => null)) as LocationUpdatesResponse | null;

      if (!response.ok || !result?.checkedAt) {
        throw new Error(result?.error ?? "Nové polohy klientov sa nepodarilo obnoviť.");
      }

      locationUpdateCursorRef.current = result.checkedAt;
      if ((result.updates?.length ?? 0) > 0 || (result.notifications?.length ?? 0) > 0) {
        setDispatchData((current) => mergeCustomerLocationUpdates(current, result));
      }
    } catch (error) {
      console.warn("Customer location update poll failed:", error);
    } finally {
      locationUpdatePollInFlight.current = false;
    }
  }, [source]);

  useEffect(() => {
    if (source !== "supabase") return;

    void pollCustomerLocationUpdates();
    const interval = window.setInterval(() => void pollCustomerLocationUpdates(), 10_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void pollCustomerLocationUpdates();
    };

    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [pollCustomerLocationUpdates, source]);

  async function markNotificationRead(notificationId: string) {
    await updateNotificationStatusFromPanel(notificationId, "read");
  }

  async function updateNotificationStatusFromPanel(notificationId: string, status: NotificationStatus) {
    if (markingNotificationId) {
      return;
    }

    setMarkingNotificationId(notificationId);
    setMutationNotice(null);

    if (source === "mock") {
      setDispatchData((current) => applyMockNotificationStatus(current, notificationId, status));
      setMutationNotice(`Notifikácia: ${notificationStatusLabel(status)}. Mock dáta boli upravené iba lokálne.`);
      setMarkingNotificationId(null);
      return;
    }

    try {
      const response = await fetch(`/api/notifications/${encodeURIComponent(notificationId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const result = (await response.json()) as { notifications?: DispatchData["notifications"]; error?: string };

      if (!response.ok || !result.notifications) {
        throw new Error(result.error ?? "Notifikáciu sa nepodarilo upraviť.");
      }

      setDispatchData((current) => ({ ...current, notifications: result.notifications ?? current.notifications }));
      setMutationNotice(`Notifikácia: ${notificationStatusLabel(status)}.`);
    } catch (error) {
      setMutationNotice(error instanceof Error ? error.message : "Notifikáciu sa nepodarilo upraviť.");
    } finally {
      setMarkingNotificationId(null);
    }
  }

  async function changeCasePriority(caseId: string, priority: DispatchCase["priority"]) {
    if (priorityChangeCaseId) {
      return;
    }

    setMutationNotice(null);

    if (source === "mock") {
      setDispatchData((current) => ({
        ...current,
        dispatchCases: current.dispatchCases.map((caseItem) => (caseItem.id === caseId ? { ...caseItem, priority } : caseItem)),
      }));
      setMutationNotice(`Priorita upravená na ${casePriorityLabels[priority]}. Mock dáta boli upravené iba lokálne.`);
      return;
    }

    setPriorityChangeCaseId(caseId);

    try {
      const response = await fetch(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority }),
      });
      const result = (await response.json()) as { dispatchData?: DispatchData; error?: string; refreshRequired?: boolean };

      if (!response.ok) {
        throw new Error(result.error ?? "Prioritu sa nepodarilo zmeniť.");
      }

      if (result.dispatchData) {
        setDispatchData(result.dispatchData);
      }

      setMutationNotice(`Priorita prípadu upravená na ${casePriorityLabels[priority]}.`);
    } catch (error) {
      setMutationNotice(error instanceof Error ? error.message : "Prioritu sa nepodarilo zmeniť.");
    } finally {
      setPriorityChangeCaseId(null);
    }
  }

  async function createTaskFromPanel(input: TaskCreateInput) {
    await runTaskPanelAction(
      input.caseId,
      {
        action: "create_task",
        assignedTo: input.assignedTo,
        taskDueAt: input.taskDueAt,
        taskPriority: input.taskPriority,
        taskReminderChannels: input.taskReminderChannels,
        taskTitle: input.taskTitle,
      },
      "Úloha vytvorená.",
    );
  }

  async function updateTaskFromPanel(input: TaskUpdateInput) {
    await runTaskPanelAction(
      input.caseId,
      {
        action: "update_task",
        assignedTo: input.assignedTo,
        note: input.note,
        taskDueAt: input.taskDueAt,
        taskId: input.taskId,
        taskPriority: input.taskPriority,
        taskStatus: input.taskStatus,
        taskTitle: input.taskTitle,
      },
      "Úloha upravená.",
    );
  }

  async function deleteTaskFromPanel(input: TaskDeleteInput) {
    await runTaskPanelAction(
      input.caseId,
      {
        action: "delete_task",
        note: input.note,
        taskId: input.taskId,
      },
      "Úloha vymazaná.",
    );
  }

  async function runTaskPanelAction(caseId: string, payload: Record<string, unknown>, successMessage: string) {
    setMutationNotice(null);

    if (source === "mock") {
      setDispatchData((current) => applyMockTaskAction(current, caseId, payload));
      setMutationNotice(`${successMessage} Mock dáta boli upravené iba lokálne.`);
      return;
    }

    try {
      const response = await fetch(`/api/cases/${caseId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as { dispatchData?: DispatchData; error?: string };

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Úlohu sa nepodarilo upraviť.");
      }

      setDispatchData(result.dispatchData);
      setMutationNotice(successMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Úlohu sa nepodarilo upraviť.";
      setMutationNotice(message);
      throw new Error(message);
    }
  }

  function clearCaseFilters() {
    setCaseFilters(defaultCaseFilters);
    setCaseSearch("");
  }

  function switchCenterView(view: CenterView) {
    requestNavigation(() => setCenterView(view));
  }

  function switchView(view: View) {
    requestNavigation(() => setActiveView(view));
  }

  function startNewCase(call?: DispatchCall) {
    requestNavigation(() => startNewCaseNow(call));
  }

  function startNewCaseNow(call?: DispatchCall) {
    returnViewRef.current = activeView;
    // Generická nová karta (bez explicitného hovoru) štartuje čistá — nedediť
    // meno/číslo z posledného alebo mock `incomingCall`. Prefill sa deje len cez
    // startNewCaseFromCall(realCall).
    const blankCall: DispatchCall = {
      ...incomingCall,
      id: "call-idle",
      status: "ended",
      callerNumber: "Bez aktívneho hovoru",
      callerName: undefined,
      waitSeconds: 0,
    };
    setNewCaseCall(call ?? blankCall);
    setFocusedTaskId(undefined);
    setActiveView("dispatch");
    setCenterView("map");
    setWorkspace({ kind: "new", mode: "expanded" });
  }

  function startNewCaseFromCall(call?: DispatchCall | CallCenterCall) {
    const nextCall = call ? toDispatchCall(call) : { ...incomingCall, status: callStatus };
    requestNavigation(() => {
      setCallStatus(nextCall.status === "missed" || nextCall.status === "ended" ? nextCall.status : "answered");
      setActiveView("dispatch");
      setCenterView("map");
      startNewCaseNow(nextCall);
    });
  }

  function handleCaseCreated(nextData: DispatchData, caseId: string, notice?: string) {
    setDispatchData(nextData);
    setActiveCaseId(caseId);
    setActiveView("dispatch");
    setCenterView("map");
    setFocusedTaskId(undefined);
    setHasUnsavedChanges(false);
    setWorkspace({ kind: "detail", mode: "expanded" });
    setMutationNotice(notice ?? "Nový prípad je uložený v Supabase a zobrazený na mape.");

    if (newCaseCall.id !== "call-idle" && looksLikeUuid(newCaseCall.id)) {
      void linkCreatedCaseToCall(newCaseCall.id, caseId);
    }
  }

  async function linkCreatedCaseToCall(callId: string, caseId: string) {
    try {
      const response = await telephonyFetch(`/api/telephony/calls/${encodeURIComponent(callId)}/link-case`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId }),
        label: "priradenie hovoru k prípadu",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      const result = (await response.json().catch(() => null)) as { dispatchData?: DispatchData; error?: string } | null;

      if (!response.ok || !result?.dispatchData) {
        throw new Error(result?.error ?? "Hovor sa nepodarilo priradiť k prípadu.");
      }

      setDispatchData(result.dispatchData);
      setMutationNotice("Nový prípad je uložený a hovor je priradený k timeline.");
    } catch (error) {
      setMutationNotice(error instanceof Error ? `Prípad je uložený, ale hovor sa nepriradil: ${error.message}` : "Prípad je uložený, ale hovor sa nepriradil.");
    }
  }

  async function dialFromDashboard(toNumber: string, context?: unknown) {
    const caseId = typeof context === "string" ? context : undefined;
    if (isDashboardDialing) return;
    if (
      hotdeskContractActive && (
        workplaceAutoConnectSuppressionDepthRef.current > 0 ||
        workplaceDurableMutationRef.current ||
        workplacePhoneTransitionActive ||
        !workplacePendingRecoveryComplete
      )
    ) {
      throw new Error("Najprv dokonči zmenu pracovného miesta. Telefón počas presunu nezačne nový hovor.");
    }
    if (!defaultExtension) {
      throw new Error("Tvoj profil nemá priradenú aktívnu VIPTel klapku.");
    }
    if (browserWebphone.hasActiveCall) {
      throw new Error("Najprv ukončite alebo odmietnite aktuálny browser hovor.");
    }

    setIsDashboardDialing(true);
    try {
      const fromExtension = selectedWebphoneExtension || defaultExtension;
      if (webphoneAvailable) {
        if (!browserWebphone.isRegistered) {
          throw new Error("Browser telefón ešte nie je pripojený. Vyberte alebo pripojte klapku.");
        }
        if (browserWebphone.mode === "mock") {
          browserWebphone.simulateOutgoing(toNumber);
          setMutationNotice(`Mock hovor spustený na ${toNumber}.`);
          return;
        }
        if (effectiveWebphoneConfig?.dialMode === "sip_invite") {
          const intentResponse = await telephonyFetch("/api/telephony/call/create", {
            label: "autorizácia hovoru",
            timeoutMs: TELEPHONY_TIMEOUT_MS.control,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "browser_sip",
              fromExtension,
              webphoneExtension: fromExtension,
              toNumber,
              caseId,
              ...workplaceWebphoneFence,
            }),
          });
          const intent = (await intentResponse.json().catch(() => null)) as { command?: { id: string }; error?: string } | null;
          if (!intentResponse.ok || !intent?.command?.id) {
            throw new Error(intent?.error ?? "Browser hovor sa nepodarilo bezpečne zapísať.");
          }
          const attempt = await runAuditedBrowserSipInvite(
            intent.command.id,
            () => browserWebphone.startDirectCall(toNumber),
          );
          setMutationNotice("Browser hovor čaká na potvrdenie VIPTel.");
          await confirmAuditedBrowserSipCall(intent.command.id, attempt);
          setMutationNotice(`VIPTel potvrdil browser hovor z klapky ${fromExtension}.`);
          return;
        }
      }

      const mode = webphoneAvailable ? "webphone" : "extension_callback";
      const response = await telephonyFetch("/api/telephony/call/create", {
        label: "vytvorenie hovoru",
        timeoutMs: TELEPHONY_TIMEOUT_MS.control,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          fromExtension,
          webphoneExtension: mode === "webphone" ? fromExtension : undefined,
          toNumber,
          caseId,
          ...workplaceWebphoneFence,
        }),
      });
      const result = (await response.json().catch(() => null)) as { command?: { id: string }; error?: string } | null;
      if (!response.ok || !result?.command?.id) {
        throw new Error(result?.error ?? "Hovor sa nepodarilo spustiť.");
      }
      setMutationNotice("Hovor čaká na potvrdenie VIPTel.");
      requireConfirmedTelephonyCommand(await waitForTelephonyCommand(result.command.id));
      setMutationNotice(`VIPTel potvrdil hovor na ${toNumber}.`);
    } finally {
      setIsDashboardDialing(false);
    }
  }

  async function handleSendCaseSms(template: "location_request" | "eta_update") {
    if (isSendingCaseSms) {
      return;
    }
    if (!activeCase) {
      setMutationNotice("Najprv vyberte aktívny prípad.");
      return;
    }
    if (!activeCase.contact.phone.trim()) {
      setMutationNotice("Pred odoslaním SMS doplňte telefón zákazníka.");
      return;
    }
    if (template === "eta_update" && !activeCase.pickup) {
      setMutationNotice("Pred odoslaním ETA SMS doplňte miesto incidentu.");
      return;
    }

    const task = activeCase.tasks.find((candidate) => {
      const title = candidate.title.toLowerCase();
      return candidate.status === "open" && (template === "eta_update" ? title.includes("eta") : title.includes("lokaliza") && title.includes("sms"));
    });

    setIsSendingCaseSms(true);
    setMutationNotice(null);

    try {
      const response = await fetch(`/api/cases/${activeCase.id}/sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task?.id, template }),
      });
      const result = (await response.json().catch(() => null)) as { dispatchData?: DispatchData; sms?: { reused?: boolean }; error?: string } | null;

      if (!response.ok || !result?.dispatchData) {
        throw new Error(result?.error ?? "SMS sa nepodarilo odoslať.");
      }

      setDispatchData(result.dispatchData);
      const smsLabel = template === "eta_update" ? "ETA SMS" : "Lokalizačná SMS";
      setMutationNotice(result.sms?.reused ? `${smsLabel} už bola odoslaná, znovu ju neposielam.` : `${smsLabel} bola odoslaná klientovi.`);
    } catch (error) {
      setMutationNotice(error instanceof Error ? error.message : "SMS sa nepodarilo odoslať.");
    } finally {
      setIsSendingCaseSms(false);
    }
  }

  async function handleAssignAsset(assetId: string) {
    if (isAssigning) {
      return;
    }
    if (!activeCase) {
      setMutationNotice("Najprv vyberte aktívny prípad.");
      return;
    }
    if (!activeCase.pickup) {
      setMutationNotice("Pred vyslaním techniky doplňte miesto incidentu.");
      return;
    }
    if (requiresTowDestination(activeCase.jobTypes) && !activeCase.destination) {
      setMutationNotice("Pred vyslaním odťahu doplňte cieľ.");
      return;
    }

    setIsAssigning(true);
    setMutationNotice(null);

    try {
      let allowOccupiedOverride = false;
      let allowUnverifiedOverride = false;

      while (true) {
        const response = await fetch(`/api/cases/${activeCase.id}/assign`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assetId, allowOccupiedOverride, allowUnverifiedOverride }),
        });
        const result = (await response.json()) as { caseId?: string; code?: string; dispatchData?: DispatchData; error?: string };

        if (response.status === 409 && result.code === "OCCUPIED_ASSET_CONFIRMATION_REQUIRED" && !allowOccupiedOverride) {
          const confirmed = window.confirm(`${result.error ?? "Vozidlo je podľa SWHouse obsadené."}\n\nChceš ho napriek tomu priradiť?`);
          if (confirmed) {
            allowOccupiedOverride = true;
            continue;
          }
          setMutationNotice("Priradenie obsadeného vozidla bolo zrušené.");
          return;
        }

        if (response.status === 409 && result.code === "UNVERIFIED_ASSET_CONFIRMATION_REQUIRED" && !allowUnverifiedOverride) {
          const confirmed = window.confirm(
            `${result.error ?? "Dostupnosť vozidla nie je v SWHouse overená."}\n\nOveril si dostupnosť manuálne a chceš pokračovať?`,
          );
          if (confirmed) {
            allowUnverifiedOverride = true;
            continue;
          }
          setMutationNotice("Priradenie vozidla bez overenej dostupnosti bolo zrušené.");
          return;
        }

        if (!response.ok || !result.dispatchData) {
          throw new Error(result.error ?? "Techniku sa nepodarilo priradiť.");
        }

        setDispatchData(result.dispatchData);
        setActiveCaseId(result.caseId ?? activeCase.id);
        setMutationNotice("Technika je priradená, asset je označený ako assigned a SMS úloha je pripravená.");
        return;
      }
    } catch (error) {
      setMutationNotice(error instanceof Error ? error.message : "Techniku sa nepodarilo priradiť.");
    } finally {
      setIsAssigning(false);
    }
  }

  function returnToCockpit() {
    requestNavigation(() => {
      setFocusedTaskId(undefined);
      if (returnViewRef.current !== "dispatch") {
        setActiveView(returnViewRef.current);
        setWorkspace({ kind: "cockpit", mode: "split" });
        returnViewRef.current = "dispatch";
        return;
      }
      setWorkspace({ kind: "cockpit", mode: "split" });
    });
  }

  function collapseWorkspace() {
    requestNavigation(() => {
      setFocusedTaskId(undefined);
      setWorkspace({ kind: "cockpit", mode: "collapsed" });
    });
  }

  function restoreCockpit() {
    setWorkspace({ kind: "cockpit", mode: "split" });
  }

  function expandCockpit() {
    setWorkspace({ kind: "cockpit", mode: "expanded" });
  }

  useEffect(() => {
    const caseDirectoryDetailOpen = activeView === "cases" && workspace.kind === "detail";
    if (activeView !== "dispatch" && !caseDirectoryDetailOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      if (leaveDialogOpen) {
        event.preventDefault();
        cancelPendingNavigation();
        return;
      }

      if (workspace.mode === "expanded") {
        event.preventDefault();
        requestNavigation(() => {
          setFocusedTaskId(undefined);
          if (caseDirectoryDetailOpen) {
            setWorkspace({ kind: "cockpit", mode: "split" });
            returnViewRef.current = "dispatch";
            return;
          }
          if (returnViewRef.current !== "dispatch") {
            setActiveView(returnViewRef.current);
            returnViewRef.current = "dispatch";
          }
          setWorkspace({ kind: "cockpit", mode: "split" });
        });
        return;
      }

      if (workspace.mode === "split") {
        event.preventDefault();
        requestNavigation(() => {
          setFocusedTaskId(undefined);
          setWorkspace({ kind: "cockpit", mode: "collapsed" });
        });
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeView, cancelPendingNavigation, leaveDialogOpen, requestNavigation, workspace]);

  return (
    <div
      className={`isolate flex flex-col bg-zinc-100 text-zinc-950 ${
        activeView === "settings" || activeView === "reports"
          ? "min-h-dvh overflow-visible pb-[calc(68px+env(safe-area-inset-bottom))] sm:pb-0"
          : "h-svh overflow-hidden pb-[calc(68px+env(safe-area-inset-bottom))] sm:h-auto sm:min-h-dvh sm:overflow-visible sm:pb-0 lg:h-dvh lg:min-h-[720px]"
      }`}
      data-hydrated="false"
      data-testid="dispatch-console"
      ref={consoleRef}
    >
      <div className="relative z-50 shrink-0" ref={topBarsRef}>
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-950 px-3 py-2 text-white sm:px-4 sm:py-0">
        <div className="flex min-w-0 shrink-0 items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[#FCD703] font-black text-zinc-950">PM</div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Linka pomoci motoristom</div>
            <div className="truncate text-xs text-zinc-400">Dispečing · pilotný deň · {dataSourceLabel}</div>
          </div>
        </div>
        <nav className="hidden min-w-0 items-center gap-1 sm:mt-0 sm:flex sm:overflow-x-auto sm:pb-0" aria-label="Hlavná navigácia">
          {navItems.map((item) => (
            <NavButton
              key={item.view}
              active={activeView === item.view}
              label={item.label}
              icon={item.icon}
              badgeCount={item.badgeCount}
              onClick={() => switchView(item.view)}
            />
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          <HeaderNotificationMenu
            cases={dispatchCases}
            notifications={viewerNotifications}
            onMarkRead={(notificationId) => void markNotificationRead(notificationId)}
            onOpenCase={openCase}
            onOpenTask={openTask}
          />
          <div className="hidden sm:block">
            <QueueCoveragePill
              coverage={queueCoverage}
              health={operatorPresenceHealth}
              presences={operatorPresences}
            />
          </div>
          <div className="hidden sm:block">
            <CallQueuePanel
              calls={waitingRoomCalls}
              now={queueClockNow}
              onPickup={(call) => void waitingPickup.pickupWaitingCall(call)}
              pickupState={waitingPickup.waitingCallPickupState}
              variant="header"
            />
          </div>
          <button
            type="button"
            onClick={() => startNewCase()}
            className="hidden h-9 shrink-0 items-center gap-2 rounded-md bg-[#FCD703] px-3 text-sm font-semibold text-zinc-950 shadow-sm transition hover:bg-yellow-300 disabled:cursor-wait disabled:bg-zinc-700 disabled:text-zinc-400 sm:inline-flex"
          >
            <Plus size={16} />
            Nový prípad
          </button>
        </div>
      </header>

      {visibleWarning && (
        <div role="alert" className="relative z-40 flex min-h-[42px] shrink-0 items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 sm:px-4">
          <span className="min-w-0 break-words">{visibleWarning}</span>
          <button type="button" onClick={() => setDismissedWarning(visibleWarning)} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-amber-800 hover:bg-amber-100" aria-label="Zavrieť upozornenie" title="Zavrieť">
            <X size={15} />
          </button>
        </div>
      )}
      {visibleMutationError && (
        <div role="alert" className="flex min-h-[42px] items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-900 sm:px-4">
          <span className="min-w-0 break-words">{visibleMutationError}</span>
          <button type="button" onClick={() => setMutationNotice(null)} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-red-800 hover:bg-red-100" aria-label="Zavrieť chybu" title="Zavrieť">
            <X size={15} />
          </button>
        </div>
      )}
      </div>

      {activeView === "cases" && (
        workspace.kind === "detail" ? (
          <main className="min-h-0 flex-1 overflow-hidden bg-zinc-100 p-2 pb-[calc(76px+env(safe-area-inset-bottom))] sm:p-3 sm:pb-3">
            <ExpandedCasePanel
              key={`cases:${selectedCase?.id ?? "empty"}`}
              assets={fleetAssets}
              branches={branches}
              call={newCaseCall}
              caseItem={selectedCase}
              commanderVehicles={commanderVehicles}
              focusedTaskId={focusedTaskId}
              kind="detail"
              onBackToCockpit={returnToCockpit}
              onCaseCreated={handleCaseCreated}
              onDataChange={setDispatchData}
              onDirtyChange={setHasUnsavedChanges}
              onSaveDraftChange={handleSaveDraftChange}
              onSavingChange={setIsCaseSaveLocked}
              operators={effectiveOperators}
              partnerDirectory={partnerDirectory}
              priceRule={activePriceRule}
              viewerProfileId={viewerProfileId}
              workplaceFence={workplaceWebphoneFence}
            />
          </main>
        ) : (
          <CaseDirectory
            activeCaseId={activeCaseId}
            activeFilterCount={activeFilterCount}
            assets={fleetAssets}
            assistanceServices={assistanceServiceOptions}
            branches={branches}
            calls={visibleCallCenterCalls}
            cases={filteredCases}
            filters={caseFilters}
            onClearFilters={clearCaseFilters}
            onFiltersChange={setCaseFilters}
            onNewCase={() => startNewCase()}
            onOpenDetails={openCaseDetail}
            onSearchChange={setCaseSearch}
            onSortChange={setCaseSort}
            operators={effectiveOperators}
            search={caseSearch}
            sort={caseSort}
            totalCases={dispatchCases.length}
          />
        )
      )}

      {activeView === "dispatch" && (
        <main
          className="relative z-0 isolate grid h-full min-h-0 min-w-0 flex-1 grid-cols-1 overflow-x-hidden overflow-y-auto lg:h-auto lg:grid-rows-[auto_minmax(0,1fr)] lg:overflow-hidden lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-rows-[minmax(0,1fr)] xl:grid-cols-[330px_minmax(0,1fr)_330px] 2xl:grid-cols-[340px_minmax(0,1fr)_330px]"
        >
          <div className="min-w-0 p-2 lg:col-span-2 xl:hidden">
            <DashboardPhone caseContext={dashboardSmsCaseContext} disabled={workplacePhoneMutationPending} isDialing={isDashboardDialing} onDataChange={setDispatchData} onDial={dialFromDashboard} />
          </div>
          <CaseList
            activeCaseId={visibleActiveCaseId}
            activeFilterCount={activeFilterCount}
            assistanceServices={assistanceServiceOptions}
            centerView={centerView}
            cases={filteredActiveCases}
            filters={caseFilters}
            onChangePriority={(caseId, priority) => void changeCasePriority(caseId, priority)}
            onClearFilters={clearCaseFilters}
            onFiltersChange={setCaseFilters}
            onOpenDetails={openCaseDetail}
            onSearchChange={setCaseSearch}
            onSelect={selectCase}
            onSortChange={setCaseSort}
            onToggleCenterView={() => switchCenterView(centerView === "map" ? "table" : "map")}
            operators={effectiveOperators}
            priorityChangeCaseId={priorityChangeCaseId}
            search={caseSearch}
            sort={caseSort}
            totalCases={activeCasesTotal}
          />
          <MapWorkspace
            activeCaseId={visibleActiveCaseId}
            assets={fleetAssets}
            branches={branches}
            call={newCaseCall}
            caseItem={workspaceCase}
            commanderVehicles={commanderVehicles}
            cases={filteredActiveCases}
            centerView={centerView}
            focusedTaskId={focusedTaskId}
            mapModel={mapModel}
            operators={effectiveOperators}
            partnerDirectory={partnerDirectory}
            priceRule={activePriceRule}
            sort={caseSort}
            totalCases={activeCasesTotal}
            visibleCalls={visibleCallCenterCalls}
            viewerProfileId={viewerProfileId}
            workspaceKind={workspace.kind}
            workspaceMode={workspace.mode}
            workplaceFence={workplaceWebphoneFence}
            onAssignAsset={(assetId) => void handleAssignAsset(assetId)}
            onBackToCockpit={returnToCockpit}
            onCaseCreated={handleCaseCreated}
            onCollapse={collapseWorkspace}
            onDataChange={setDispatchData}
            onDirtyChange={setHasUnsavedChanges}
            onSaveDraftChange={handleSaveDraftChange}
            onSavingChange={setIsCaseSaveLocked}
            onExpand={expandCockpit}
            onOpenDetail={openCaseDetail}
            onRestore={restoreCockpit}
            onSendEtaSms={() => void handleSendCaseSms("eta_update")}
            onSendLocationSms={() => void handleSendCaseSms("location_request")}
            onSortChange={setCaseSort}
          />
          <div className="hidden min-h-0 min-w-0 flex-col border-l border-zinc-200 bg-white xl:flex">
            <DashboardPhone caseContext={dashboardSmsCaseContext} className="shrink-0" disabled={workplacePhoneMutationPending} isDialing={isDashboardDialing} onDataChange={setDispatchData} onDial={dialFromDashboard} variant="rail" />
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="dashboard-task-panel-shell">
              <TaskPanel
                activeTaskId={focusedTaskId}
                cases={dispatchCases}
                isNotificationSyncing={isNotificationSyncing}
                lastNotificationSyncAt={lastNotificationSyncAt}
                markingNotificationId={markingNotificationId}
                notifications={notifications}
                onCreateTask={createTaskFromPanel}
                onDeleteTask={deleteTaskFromPanel}
                onMarkNotificationRead={(notificationId) => void markNotificationRead(notificationId)}
                onOpenTask={openTask}
                onRefreshNotifications={() => void syncDueNotifications(false)}
                onUpdateTask={updateTaskFromPanel}
                onUpdateNotificationStatus={updateNotificationStatusFromPanel}
                operators={effectiveOperators}
                notificationSyncEnabled={source === "supabase"}
                viewerProfileId={viewerProfileId}
              />
            </div>
          </div>
        </main>
      )}

      {activeView === "tasks" && (
        <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-zinc-100 p-2 pb-[calc(88px+env(safe-area-inset-bottom))] sm:p-4">
          <div className="mx-auto min-h-full w-full min-w-0 max-w-7xl">
            <TaskPanel
              activeTaskId={focusedTaskId}
              cases={dispatchCases}
              isNotificationSyncing={isNotificationSyncing}
              lastNotificationSyncAt={lastNotificationSyncAt}
              markingNotificationId={markingNotificationId}
              notifications={notifications}
              onCreateTask={createTaskFromPanel}
              onDeleteTask={deleteTaskFromPanel}
              onMarkNotificationRead={(notificationId) => void markNotificationRead(notificationId)}
              onOpenTask={openTask}
              onRefreshNotifications={() => void syncDueNotifications(false)}
              onUpdateTask={updateTaskFromPanel}
              onUpdateNotificationStatus={updateNotificationStatusFromPanel}
              operators={effectiveOperators}
              notificationSyncEnabled={source === "supabase"}
              variant="page"
              viewerProfileId={viewerProfileId}
            />
          </div>
        </main>
      )}

      {activeView === "call-center" && (
        <CallCenterModule
          activeCallsHealth={activeCallsProbe}
          availabilityPending={queueCommandPending}
          availabilityTarget={queueCommandTarget}
          browserWebphone={browserWebphone}
          calls={stableCallCenterCalls}
          cases={dispatchCases}
          currentOperatorId={telephonyPresence?.actorProfileId ?? viewerProfileId}
          dataSource={source}
          defaultExtension={workplaceDefaultExtension}
          metrics={metrics}
          onDataChange={setDispatchData}
          onDial={dialFromDashboard}
          operatorPresences={operatorPresences}
          operators={effectiveOperators}
          queueStatus={queueStatus}
          queueHealth={actorQueueHealth}
          selectedWebphoneExtension={selectedWebphoneExtension}
          telephonyPresence={telephonyPresence}
          telephonyPresenceHealth={operatorPresenceHealth}
          workplaceSelection={workplaceSelection}
          workplaceSelectionError={workplaceSelectionError}
          workplaceSessionNotice={workplaceLeaseNotice}
          workplaceRecoveryRequired={workplaceRecoveryRequired}
          workplaceTakeover={workplaceTakeover}
          workplaceTakeoverError={workplaceTakeoverError}
          workplacePhoneMutationPending={workplacePhoneMutationPending}
          waitingPickup={waitingPickup}
          workplaceFence={workplaceWebphoneFence}
          webphoneConfig={effectiveWebphoneConfig}
          onNewCase={startNewCaseFromCall}
          onOpenCase={openCase}
          onAvailabilityAction={onQueueAvailabilityAction}
          onRefreshWorkplace={retryWorkplaceAvailability}
          onRecoverWorkplacePriority={recoverWorkplacePriority}
          onReleaseOccupiedWorkplace={releaseOccupiedWorkplace}
          onReleaseWorkplace={releaseWorkplace}
          onCancelWorkplaceTakeover={cancelOnlineWorkplaceTakeover}
          onRequestWorkplaceTakeover={requestOnlineWorkplaceTakeover}
          onSelectWorkplace={selectWorkplace}
          onTakeoverWorkplace={takeoverWorkplace}
          onTelephonyChanged={handleTelephonyChanged}
        />
      )}

      {activeView === "attendance" && <AttendanceModule attendance={attendance} operators={effectiveOperators} onDataChange={setDispatchData} />}
      {activeView === "reports" && <ReportDashboard />}
      {activeView === "fleet" && (
        <FleetModule
          branches={branches}
          assets={fleetAssets}
          cases={dispatchCases}
          commanderLastSuccessAt={commanderGpsLastSuccessAt}
          commanderLatestRunAt={commanderGpsLatestRunAt}
          commanderLatestStatus={commanderGpsLatestStatus}
          commanderVehicles={commanderVehicles}
          onDataChange={setDispatchData}
        />
      )}
      {activeView === "settings" && (
        <IntegrationSettings
          branches={branches}
          partnerDirectory={partnerDirectory}
          telephonyPresence={telephonyPresence}
          telephonyPresenceHealth={presenceProbe}
          users={users}
          onDataChange={setDispatchData}
          onRefreshTelephonyPresence={async () => {
            await refreshTelephonyPresence("provider");
          }}
        />
      )}

      <NotificationToastStack
        notifications={viewerNotifications}
        onMarkRead={(notificationId) => void markNotificationRead(notificationId)}
        onOpenCase={openCase}
        onOpenTask={openTask}
      />

      <nav className="fixed inset-x-0 bottom-0 z-[2147483000] border-t border-zinc-200 bg-white/95 px-2 pt-1.5 pb-[calc(8px+env(safe-area-inset-bottom))] shadow-[0_-10px_30px_rgba(24,24,27,0.12)] backdrop-blur sm:hidden" aria-label="Mobilná navigácia">
        <div className="flex gap-1 overflow-x-auto">
          {navItems.map((item) => (
            <MobileTabButton
              key={item.view}
              active={activeView === item.view}
              badgeCount={item.badgeCount}
              icon={item.icon}
              label={item.label}
              shortLabel={item.shortLabel}
              onClick={() => switchView(item.view)}
            />
          ))}
        </div>
      </nav>

      {leaveDialogOpen && (
        <UnsavedCaseDialog
          error={leaveDialogError}
          isNewCase={workspace.kind === "new"}
          saving={leaveDialogSaving || isCaseSaveLocked}
          waitingForAutosave={leaveAfterSave}
          onCancel={cancelPendingNavigation}
          onDiscard={discardAndLeave}
          onSave={() => void saveAndLeave()}
        />
      )}

      <WorkplaceTakeoverDialog
        key={workplaceTakeover?.incoming?.requestId ?? "no-workplace-takeover"}
        error={workplaceTakeoverError}
        pending={workplaceTakeoverResponsePending}
        request={workplaceTakeover?.incoming}
        onAccept={() => void respondToOnlineWorkplaceTakeover("accept")}
        onDecline={() => void respondToOnlineWorkplaceTakeover("decline")}
        onRefresh={() => void refreshWorkplaceTakeover().catch(() => undefined)}
      />

      {/* Rendered on every view: a dispatcher working in Dispečing or Prípady
          could previously not see who was waiting without switching to
          Ústredňa, let alone choose between two simultaneous callers. On sm and
          up this lives in the header beside the coverage pill; the floating
          rail stays for narrow screens, where that whole header group is
          hidden and there would otherwise be no waiting room at all. */}
      <div className="sm:hidden">
        <CallQueuePanel
          calls={waitingRoomCalls}
          now={queueClockNow}
          onPickup={(call) => void waitingPickup.pickupWaitingCall(call)}
          pickupState={waitingPickup.waitingCallPickupState}
          variant="rail"
        />
      </div>

      <RemoteAudio audioRef={browserWebphone.remoteAudioRef} />

      {(browserWebphone.hasActiveCall && browserWebphone.callStatus !== "incoming" || providerOnlyActionCall) && (
        <ActiveCallBar
          // The browser session generation is stable for one SIP dialog and
          // changes on the next one, so consecutive calls to the same party
          // remount while a mid-call provider-identity update does not. The
          // stored id only takes over for a provider-only call that this
          // browser never had a dialog for. Keying by party number instead
          // let per-call state leak into the next identical call.
          key={browserCallSessionKey(currentBrowserSipCall) ?? floatingActionCall?.id ?? "browser-call"}
          callId={floatingActionCall && looksLikeUuid(floatingActionCall.id) && floatingActionCall.viptelUniqueId
            ? floatingActionCall.id
            : undefined}
          caseLabel={floatingActionCall?.caseNumber
            ? `Otvoriť prípad ${floatingActionCall.caseNumber}`
            : undefined}
          direction={floatingCallDirection}
          label={browserWebphone.hasActiveCall ? phone.label : "Hovor cez pracovisko"}
          partyName={floatingPartyName}
          partyNumber={floatingPartyNumber}
          inCall={browserWebphone.hasActiveCall ? browserWebphone.callStatus === "in_call" : Boolean(providerOnlyActionCall)}
          isMuted={browserWebphone.isMuted}
          onToggleMute={browserWebphone.hasActiveCall ? browserWebphone.toggleMute : undefined}
          onHangup={browserWebphone.hasActiveCall
            ? hangupBrowserCall
            : providerOnlyActionCall
              ? () => hangupProviderCall(providerOnlyActionCall)
              : async () => undefined}
          // Last-resort local end, offered only after a provider hangup fails.
          // The bar itself withholds it for inbound calls, where a local BYE
          // would close this leg and advance a still-live caller.
          onLocalHangup={currentBrowserSipCall
            ? async () => {
              await browserWebphone.hangupCapturedCall(currentBrowserSipCall);
            }
            : undefined}
          onDtmf={browserWebphone.hasActiveCall ? (tone) => void browserWebphone.sendDtmf(tone) : undefined}
          transferTransport={floatingTransferTransport}
          onRedirect={floatingTransferTransport && floatingActionCall && looksLikeUuid(floatingActionCall.id) && floatingActionCall.viptelUniqueId
            ? (destination) => {
              const destinationKind = destination.destinationNumber !== undefined ? "phone" : "operator";
              const transport = telephonyTransferTransport(
                floatingCallDirection,
                browserWebphone.hasActiveCall,
                destinationKind,
              );
              return transport === "browser_sip_refer"
                ? transferBrowserSipCall(floatingActionCall, destination)
                : redirectTelephonyCall(floatingActionCall, destination);
            }
            : undefined}
          onNewCase={floatingActionCall && !floatingActionCall.caseId && looksLikeUuid(floatingActionCall.id)
            ? () => startNewCaseFromCall(floatingActionCall)
            : undefined}
          onOpenCase={floatingActionCall?.caseId
            ? () => openCase(floatingActionCall.caseId as string)
            : undefined}
          avoidRightRail={activeView === "dispatch"}
        />
      )}

      {(
        browserWebphone.callStatus === "incoming" ||
        (popupCall && browserWebphone.callStatus !== "in_call" && browserWebphone.callStatus !== "outgoing")
      ) && (
        <IncomingCallPopup
          key={`${incomingPopupCall.id}:${incomingPopupCall.callerNumber}`}
          call={incomingPopupCall}
          declinePending={incomingDeclinePending}
          defaultExtension={defaultExtension}
          webphoneRinging={browserWebphone.callStatus === "incoming"}
          onAnswer={() => void browserWebphone.answer()}
          onDeclineCall={declineBrowserIncomingCall}
          onClose={() => {
            if (popupCall) {
              setDismissedIncomingCallId(popupCall.id);
            } else {
              void declineBrowserIncomingCall().catch(() => undefined);
            }
          }}
          onDataChange={setDispatchData}
          onNewCase={startNewCaseFromCall}
          onOpenCase={openCase}
          onRedirect={(destination) => redirectTelephonyCall(incomingPopupCall, destination)}
          avoidRightRail={activeView === "dispatch"}
        />
      )}
    </div>
  );
}

function QueueCoveragePill({
  coverage,
  health,
  presences,
}: {
  coverage: QueueCoverage;
  health: TelephonyHealthSignal;
  presences: Array<{
    operatorName: string;
    primaryExtension?: string;
    profileId: string;
    state: TelephonyOperatorPresenceState;
  }>;
}) {
  const verified = health.state === "live";
  const tone = !verified
    ? "border-amber-400/60 bg-amber-500/15 text-amber-100"
    : coverage.needsOperator
      ? "border-red-400 bg-red-500/15 text-red-100"
      : coverage.available > 0
      ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-100"
      : "border-white/15 bg-white/10 text-zinc-200";

  const sortedPresences = [...presences].sort((left, right) => {
    const rank = (state: TelephonyOperatorPresenceState) => {
      if (state === "available") return 0;
      if (state === "ringing") return 1;
      if (state === "on_call") return 2;
      if (state === "paused") return 3;
      return 4;
    };
    return rank(left.state) - rank(right.state) || left.operatorName.localeCompare(right.operatorName, "sk");
  });

  return (
    <details className="group relative">
      <summary
        className={`flex h-9 min-w-[124px] cursor-pointer list-none items-center justify-center gap-2 rounded-md border px-2 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-emerald-300 [&::-webkit-details-marker]:hidden ${tone}`}
        title={verified ? "Zobraziť stav operátorov" : `${health.detail} Posledný úspech: ${health.lastSuccessAt ?? "žiadny"}`}
      >
        <Headphones size={14} className="shrink-0" />
        <span>{verified ? `Voľní ${coverage.available}/${coverage.total}` : "Voľní —/—"}</span>
        {verified && coverage.waiting > 0 && <span className="rounded bg-white/15 px-1.5 py-0.5">{coverage.waiting} čaká</span>}
        <ChevronDown size={13} className="shrink-0 transition group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="absolute right-0 top-[calc(100%+8px)] z-[80] w-80 overflow-hidden rounded-xl border border-emerald-200 bg-white text-zinc-950 shadow-2xl">
        <div className="border-b border-emerald-100 bg-emerald-50 px-3 py-2.5">
          <p className="text-xs font-bold text-emerald-950">Stav dispečerov</p>
          <p className="mt-0.5 text-[11px] text-emerald-800">Živé údaje pracovísk a príjmu hovorov</p>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {sortedPresences.length === 0 ? (
            <p className="px-2 py-3 text-xs text-zinc-500">Zatiaľ nie je dostupný žiadny stav operátora.</p>
          ) : sortedPresences.map((presence) => {
            const presentation = queuePresencePresentation(presence.state);
            return (
              <div key={presence.profileId} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 hover:bg-zinc-50">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${presentation.dot}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-bold text-zinc-900">{presence.operatorName}</span>
                  <span className="block truncate text-[11px] text-zinc-500">
                    {presence.primaryExtension ? `Pracovisko ${presence.primaryExtension}` : "Bez pracoviska"}
                  </span>
                </span>
                <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${presentation.badge}`}>
                  {presentation.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}

function queuePresencePresentation(state: TelephonyOperatorPresenceState) {
  if (state === "available") return { label: "Dostupný", dot: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-800" };
  if (state === "ringing") return { label: "Zvoní", dot: "bg-amber-500 motion-safe:animate-pulse", badge: "bg-amber-100 text-amber-900" };
  if (state === "on_call") return { label: "Na hovore", dot: "bg-violet-500", badge: "bg-violet-100 text-violet-800" };
  if (state === "paused") return { label: "Pauza", dot: "bg-orange-500", badge: "bg-orange-100 text-orange-800" };
  if (state === "unregistered") return { label: "Odpojený", dot: "bg-red-500", badge: "bg-red-100 text-red-800" };
  if (state === "offline") return { label: "Mimo radu", dot: "bg-zinc-400", badge: "bg-zinc-100 text-zinc-700" };
  if (state === "unassigned") return { label: "Bez miesta", dot: "bg-zinc-300", badge: "bg-zinc-100 text-zinc-600" };
  if (state === "stale") return { label: "Neaktuálne", dot: "bg-amber-400", badge: "bg-amber-100 text-amber-900" };
  return { label: "Chyba", dot: "bg-red-500", badge: "bg-red-100 text-red-800" };
}

function NavButton({
  active,
  badgeCount,
  disabled = false,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  badgeCount?: number;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  const hasBadge = typeof badgeCount === "number" && badgeCount > 0;

  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      disabled={disabled}
      className={`relative inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs font-semibold transition sm:px-3 sm:text-sm ${
        active ? "bg-white text-zinc-950" : "text-zinc-300 hover:bg-zinc-800 hover:text-white"
      } ${disabled ? "cursor-wait opacity-50" : ""}`}
    >
      <Icon size={16} />
      <span>{label}</span>
      {hasBadge && (
        <span className={`ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${active ? "bg-zinc-950 text-white" : "bg-[#FCD703] text-zinc-950"}`}>
          {formatBadgeCount(badgeCount)}
        </span>
      )}
    </button>
  );
}

function MobileTabButton({
  active,
  badgeCount,
  disabled = false,
  icon: Icon,
  label,
  onClick,
  shortLabel,
}: {
  active: boolean;
  badgeCount?: number;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  shortLabel: string;
}) {
  const hasBadge = typeof badgeCount === "number" && badgeCount > 0;

  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      disabled={disabled}
      className={`relative flex h-14 w-[74px] shrink-0 flex-col items-center justify-center gap-1 rounded-md px-1 text-[10px] font-semibold transition ${
        active ? "bg-zinc-950 text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950"
      } ${disabled ? "cursor-wait opacity-50" : ""}`}
    >
      {hasBadge && (
        <span className={`absolute right-2 top-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${active ? "bg-[#FCD703] text-zinc-950" : "bg-zinc-950 text-white"}`}>
          {formatBadgeCount(badgeCount)}
        </span>
      )}
      <Icon size={19} strokeWidth={2.2} />
      <span className="max-w-full truncate leading-none">{shortLabel}</span>
    </button>
  );
}

function UnsavedCaseDialog({
  error,
  isNewCase,
  onCancel,
  onDiscard,
  onSave,
  saving,
  waitingForAutosave,
}: {
  error: string | null;
  isNewCase: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
  waitingForAutosave: boolean;
}) {
  const busy = saving || waitingForAutosave;

  return (
    <div className="fixed inset-0 z-[2147483600] grid place-items-center bg-zinc-950/55 p-4 backdrop-blur-[2px]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-case-title"
        aria-describedby="unsaved-case-description"
        className="w-full max-w-md overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4">
          <div>
            <h2 id="unsaved-case-title" className="text-base font-semibold text-zinc-950">
              {isNewCase ? "Rozpracovaný prípad nie je uložený" : "Na karte sú neuložené zmeny"}
            </h2>
            <p id="unsaved-case-description" className="mt-1 text-sm leading-5 text-zinc-600">
              {isNewCase
                ? "Môžete ho uložiť aj neúplný a doplniť neskôr, alebo odísť bez uloženia."
                : "Zmeny sa ukladajú automaticky. Môžete počkať na uloženie alebo ich zahodiť."}
            </p>
          </div>
          <button type="button" onClick={onCancel} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950" aria-label="Zostať vo formulári">
            <X size={18} />
          </button>
        </div>

        {error && <div role="alert" className="mx-5 mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{error}</div>}

        <div className="grid gap-2 px-5 py-4 sm:grid-cols-2">
          <button type="button" onClick={onCancel} className="h-10 rounded-md border border-zinc-200 px-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-50">
            Zostať vo formulári
          </button>
          <button type="button" onClick={onDiscard} disabled={saving} className="h-10 rounded-md border border-red-200 px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
            Odísť bez uloženia
          </button>
          <button type="button" onClick={onSave} disabled={busy} className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:bg-zinc-300 disabled:text-zinc-600 sm:col-span-2">
            {busy && <Loader2 size={15} className="animate-spin" />}
            {waitingForAutosave ? "Čakám na automatické uloženie…" : saving ? "Ukladám…" : "Uložiť a odísť"}
          </button>
        </div>
      </section>
    </div>
  );
}

function formatBadgeCount(count: number) {
  return count > 99 ? "99+" : String(count);
}

function applyMockTaskAction(current: DispatchData, caseId: string, payload: Record<string, unknown>): DispatchData {
  const now = new Date().toISOString();
  const action = typeof payload.action === "string" ? payload.action : "";
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const nextCases = current.dispatchCases.map((caseItem) => {
    if (caseItem.id !== caseId) {
      return caseItem;
    }

    if (action === "create_task") {
      const task: CaseTask = {
        id: `mock-task-${safeRandomId()}`,
        caseId,
        title: stringPayload(payload.taskTitle) ?? "Nová úloha",
        assignedTo: taskAssigneePayload(payload.assignedTo, caseItem.ownerId),
        dueAt: stringPayload(payload.taskDueAt) ?? now,
        status: "open",
        priority: taskPriorityPayload(payload.taskPriority),
        kind: taskKindPayload(payload.taskKind),
        createdBy: caseItem.ownerId,
      };

      return {
        ...caseItem,
        tasks: [...caseItem.tasks, task],
        timeline: [...caseItem.timeline, mockTaskEvent(caseId, now, "Úloha vytvorená", task.title)],
        updatedAt: now,
      };
    }

    if (action === "update_task") {
      let changedTask: CaseTask | undefined;
      const tasks = caseItem.tasks.map((task) => {
        if (task.id !== taskId) {
          return task;
        }

        const nextStatus = taskStatusPayload(payload.taskStatus, task.status);
        changedTask = {
          ...task,
          title: stringPayload(payload.taskTitle) ?? task.title,
          assignedTo: hasPayload(payload, "assignedTo") ? taskAssigneePayload(payload.assignedTo, "unassigned") : task.assignedTo,
          dueAt: stringPayload(payload.taskDueAt) ?? task.dueAt,
          status: nextStatus,
          priority: hasPayload(payload, "taskPriority") ? taskPriorityPayload(payload.taskPriority, task.priority) : task.priority,
          kind: hasPayload(payload, "taskKind") ? taskKindPayload(payload.taskKind, task.kind) : task.kind,
          completedAt: nextStatus === "done" ? now : undefined,
          completedBy: nextStatus === "done" ? caseItem.ownerId : undefined,
        };
        return changedTask;
      });

      return {
        ...caseItem,
        tasks,
        timeline: changedTask ? [...caseItem.timeline, mockTaskEvent(caseId, now, "Úloha upravená", changedTask.title)] : caseItem.timeline,
        updatedAt: changedTask ? now : caseItem.updatedAt,
      };
    }

    if (action === "delete_task") {
      const deletedTask = caseItem.tasks.find((task) => task.id === taskId);
      const tasks = caseItem.tasks.filter((task) => task.id !== taskId);

      return {
        ...caseItem,
        tasks,
        timeline: deletedTask ? [...caseItem.timeline, mockTaskEvent(caseId, now, "Úloha vymazaná", deletedTask.title)] : caseItem.timeline,
        updatedAt: deletedTask ? now : caseItem.updatedAt,
      };
    }

    return caseItem;
  });

  return {
    ...current,
    dispatchCases: nextCases,
    notifications: applyMockNotificationsForTaskAction(current, taskId, action, payload, now),
    metrics: {
      ...current.metrics,
      openTasks: nextCases.reduce((count, caseItem) => count + caseItem.tasks.filter(isTaskOpen).length, 0),
    },
  };
}

function applyMockNotificationsForTaskAction(current: DispatchData, taskId: string, action: string, payload: Record<string, unknown>, now: string) {
  if (!taskId) {
    return current.notifications;
  }

  if (action === "delete_task") {
    return current.notifications.map((notification) =>
      notification.taskId === taskId
        ? {
            ...notification,
            status: "archived" as const,
            archivedAt: now,
            updatedAt: now,
          }
        : notification,
    );
  }

  if (action === "update_task" && payload.taskStatus === "done") {
    return current.notifications.map((notification) =>
      notification.taskId === taskId && notification.status === "unread"
        ? {
            ...notification,
            status: "read" as const,
            readAt: now,
            updatedAt: now,
          }
        : notification,
    );
  }

  return current.notifications;
}

function applyMockNotificationStatus(current: DispatchData, notificationId: string, status: NotificationStatus): DispatchData {
  const now = new Date().toISOString();

  return {
    ...current,
    notifications: current.notifications.map((notification) => {
      if (notification.id !== notificationId) {
        return notification;
      }

      return {
        ...notification,
        status,
        readAt: status === "read" ? now : status === "unread" ? undefined : notification.readAt,
        archivedAt: status === "archived" ? now : status === "unread" || status === "read" ? undefined : notification.archivedAt,
        updatedAt: now,
      };
    }),
  };
}

function mergeCustomerLocationUpdates(current: DispatchData, result: LocationUpdatesResponse): DispatchData {
  const latestByCaseId = new Map<string, NonNullable<LocationUpdatesResponse["updates"]>[number]>();

  for (const update of result.updates ?? []) {
    const previous = latestByCaseId.get(update.caseId);
    if (!previous || dateValue(update.location.submittedAt) > dateValue(previous.location.submittedAt)) {
      latestByCaseId.set(update.caseId, update);
    }
  }

  const dispatchCases = current.dispatchCases.map((caseItem) => {
    const update = latestByCaseId.get(caseItem.id);
    if (!update || dateValue(caseItem.customerSharedLocation?.submittedAt) >= dateValue(update.location.submittedAt)) {
      return caseItem;
    }

    return {
      ...caseItem,
      customerSharedLocation: update.location,
      timeline: caseItem.timeline.some((event) => event.id === update.event.id)
        ? caseItem.timeline
        : [...caseItem.timeline, update.event],
    };
  });
  const existingNotificationIds = new Set(current.notifications.map((notification) => notification.id));
  const newNotifications = (result.notifications ?? []).filter((notification) => !existingNotificationIds.has(notification.id));

  return {
    ...current,
    dispatchCases,
    notifications: [...newNotifications, ...current.notifications],
  };
}

function mockTaskEvent(caseId: string, time: string, title: string, body: string): TimelineEvent {
  return {
    id: `mock-event-${safeRandomId()}`,
    actor: "Systém",
    body,
    caseId,
    time,
    title,
  };
}

function hasPayload(payload: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function stringPayload(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function taskAssigneePayload(value: unknown, fallback: string) {
  if (value === "unassigned") {
    return "unassigned";
  }

  const assignedTo = stringPayload(value);
  return assignedTo ?? fallback;
}

function taskStatusPayload(value: unknown, fallback: CaseTask["status"]): CaseTask["status"] {
  return value === "open" || value === "done" || value === "overdue" ? value : fallback;
}

function taskPriorityPayload(value: unknown, fallback: CaseTask["priority"] = "normal"): CaseTask["priority"] {
  return value === "urgent" || value === "high" || value === "normal" || value === "low" ? value : fallback;
}

function taskKindPayload(value: unknown, fallback: CaseTask["kind"] = "other"): CaseTask["kind"] {
  return value === "callback" || value === "sms" || value === "dispatch" || value === "documents" || value === "billing" || value === "handover" || value === "other" ? value : fallback;
}

function safeRandomId() {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function IncomingCallPopup({
  call,
  declinePending,
  defaultExtension,
  webphoneRinging,
  onAnswer,
  onDeclineCall,
  onClose,
  onDataChange,
  onNewCase,
  onOpenCase,
  onRedirect,
  avoidRightRail,
}: {
  call: IncomingPopupCall;
  declinePending: boolean;
  defaultExtension: string;
  webphoneRinging: boolean;
  onAnswer: () => void;
  onDeclineCall: () => Promise<void>;
  onClose: () => void;
  onDataChange: (dispatchData: DispatchData) => void;
  onNewCase: (call: DispatchCall) => void;
  onOpenCase: (caseId: string) => void;
  onRedirect: (destination: TelephonyRedirectDestination) => Promise<boolean>;
  avoidRightRail: boolean;
}) {
  const [matches, setMatches] = useState<CallerMatch[]>([]);
  const [linkingCaseId, setLinkingCaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const {
    panelRef: floatingPanelRef,
    style: floatingPanelStyle,
    dragHandleProps: floatingPanelDragHandleProps,
  } = useDraggableFloatingPanel("motorist-incoming-call-panel-position-v1");
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const canLink = looksLikeUuid(call.id);
  const canRedirect = canLink && Boolean(call.viptelUniqueId);
  const callerNumber = formatPhoneNumberForDisplay(call.callerNumber);
  const callerName = call.callerName?.trim() && call.callerName !== call.callerNumber
    ? call.callerName.trim()
    : undefined;

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);

  function closePopup() {
    const returnFocus = returnFocusRef.current;
    onClose();
    window.requestAnimationFrame(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
    });
  }

  useEffect(() => {
    // The SIP phone can ring a fraction earlier than the provider snapshot.
    // During that window the popup deliberately uses a human placeholder,
    // which must never be sent to the phone-number matching endpoint.
    if (!isDialablePhoneInput(call.callerNumber)) {
      return;
    }

    let cancelled = false;

    telephonyFetch(`/api/telephony/calls/match?number=${encodeURIComponent(call.callerNumber)}`, {
      label: "vyhľadanie volajúceho",
      timeoutMs: TELEPHONY_TIMEOUT_MS.read,
    })
      .then(async (response) => {
        const result = (await response.json().catch(() => null)) as { ok?: boolean; matches?: CallerMatch[]; error?: string } | null;
        if (!response.ok || !result?.ok) {
          throw new Error(result?.error ?? "Vyhľadanie volajúceho zlyhalo.");
        }
        if (!cancelled) {
          setMatches(result.matches ?? []);
          setError(null);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setMatches([]);
          setError(caught instanceof Error ? caught.message : "Vyhľadanie volajúceho zlyhalo.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [call.callerNumber, call.id]);

  async function linkCase(caseId: string) {
    if (!canLink || linkingCaseId) {
      return;
    }

    setLinkingCaseId(caseId);
    setError(null);

    try {
      const response = await telephonyFetch(`/api/telephony/calls/${encodeURIComponent(call.id)}/link-case`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId }),
        label: "priradenie hovoru",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      const result = (await response.json().catch(() => null)) as { dispatchData?: DispatchData; error?: string } | null;

      if (!response.ok || !result?.dispatchData) {
        throw new Error(result?.error ?? "Hovor sa nepodarilo priradiť.");
      }

      onDataChange(result.dispatchData);
      onOpenCase(caseId);
      closePopup();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Hovor sa nepodarilo priradiť.");
    } finally {
      setLinkingCaseId(null);
    }
  }

  return (
    <div
      ref={floatingPanelRef}
      style={floatingPanelStyle}
      role="dialog"
      aria-labelledby="incoming-call-popup-title"
      aria-describedby="incoming-call-popup-description"
      onKeyDown={(event) => {
        if (event.key === "Escape") closePopup();
      }}
      className={`fixed inset-x-2 bottom-[calc(78px+env(safe-area-inset-bottom))] z-[2147483500] max-h-[calc(100dvh-96px)] overflow-y-auto overflow-x-hidden overscroll-contain rounded-2xl border border-zinc-200 bg-white shadow-2xl outline-none sm:left-auto sm:right-4 sm:bottom-4 sm:max-h-[calc(100dvh-32px)] sm:w-[min(420px,calc(100vw-32px))] ${avoidRightRail ? "xl:right-[346px]" : ""}`}
    >
      <div {...floatingPanelDragHandleProps} className="flex touch-none select-none items-start justify-between gap-3 border-b border-zinc-200 bg-zinc-950 p-4 text-white sm:cursor-move">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-400/20 text-amber-300">
            <PhoneIncoming size={20} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-amber-300">
              <span className="h-2 w-2 rounded-full bg-amber-400 motion-safe:animate-pulse" />
              Prichádzajúci hovor
            </div>
            <div id="incoming-call-popup-title" className="mt-1 break-words text-base font-bold leading-5">{callerName ?? callerNumber ?? "Neznáme číslo"}</div>
            <div id="incoming-call-popup-description" className="mt-0.5 break-words text-sm text-zinc-300">
              {callerName && callerNumber ? `${callerNumber} · ` : ""}čaká {call.waitSeconds}s
            </div>
            <div className="mt-1 text-xs font-semibold text-zinc-400">
              {webphoneRinging ? "Zvoní v prehliadači" : defaultExtension ? `Zvoní na klapke ${defaultExtension}` : "Bez aktívnej klapky"}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <GripHorizontal size={18} className="hidden text-zinc-500 sm:block" aria-hidden="true" />
          <button type="button" onClick={closePopup} className="rounded-lg p-2 text-zinc-400 hover:bg-white/10 hover:text-white" aria-label="Skryť okno prichádzajúceho hovoru" title="Skryť okno">
            <X size={17} />
          </button>
        </div>
      </div>
      <div className="grid gap-3 p-3">
        {webphoneRinging && (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={declinePending}
              onClick={() => {
                if (declinePending) return;
                setError(null);
                void onDeclineCall()
                  .catch((caught) => {
                    setError(caught instanceof Error ? caught.message : "Hovor sa nepodarilo ukončiť vo VIPTel.");
                  });
              }}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-red-600 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-wait disabled:bg-red-400"
            >
              {declinePending ? <Loader2 size={18} className="animate-spin" /> : <PhoneOff size={18} />}
              {declinePending ? "Ukončujem…" : "Odmietnuť"}
            </button>
            <button
              type="button"
              disabled={declinePending}
              onClick={onAnswer}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-wait disabled:bg-emerald-300"
            >
              <PhoneCall size={18} />
              Zdvihnúť
            </button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            aria-expanded={transferOpen}
            disabled={!canRedirect}
            title={canRedirect ? "Prepojiť hovor bez zdvihnutia" : "Prepojenie sa pripravuje"}
            onClick={() => setTransferOpen((open) => !open)}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-bold text-zinc-800 hover:bg-zinc-50 disabled:text-zinc-400"
          >
            <PhoneForwarded size={16} />
            Prepojiť
          </button>
          <button
            type="button"
            onClick={() => onNewCase(call)}
            disabled={!canLink}
            title={canLink ? undefined : "Prípad bude možné vytvoriť po bezpečnom uložení hovoru."}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#FCD703] px-3 text-sm font-bold text-zinc-950 hover:bg-yellow-300 disabled:cursor-wait disabled:bg-zinc-100 disabled:text-zinc-500"
          >
            <Plus size={16} />
            {canLink ? "Nový prípad" : "Ukladám hovor…"}
          </button>
        </div>
        {transferOpen && canRedirect && (
          <CallTransferPicker
            callId={call.id}
            onRedirect={onRedirect}
            onTransferred={() => {
              setTransferOpen(false);
              setNotice("VIPTel potvrdil prepojenie. Okno sa zavrie po obnovení stavu hovoru.");
            }}
          />
        )}
        {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{error}</div>}
        {notice && <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900">{notice}</div>}
        {matches.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-zinc-200">
            <button
              type="button"
              aria-expanded={contextOpen}
              onClick={() => setContextOpen((open) => !open)}
              className="flex h-10 w-full items-center justify-between gap-2 bg-zinc-50 px-3 text-left text-xs font-bold text-zinc-700 hover:bg-zinc-100"
            >
              Nájdené súvislosti ({matches.length})
              <span aria-hidden="true">{contextOpen ? "−" : "+"}</span>
            </button>
            {contextOpen && (
              <div className="grid gap-2 border-t border-zinc-200 p-2">
                {matches.slice(0, 3).map((match) => (
                  <div key={match.id} className="rounded-lg bg-zinc-50 p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-zinc-950">{match.label}</div>
                        <div className="truncate text-xs text-zinc-600">{matchLabel(match)}{match.phone ? ` · ${formatPhoneNumberForDisplay(match.phone)}` : ""}</div>
                      </div>
                      <StatusChip label={match.confidence} />
                    </div>
                    {match.caseId && (
                      <div className="mt-2 flex gap-2">
                        <button type="button" onClick={() => onOpenCase(match.caseId!)} className="inline-flex h-8 items-center rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50">
                          Otvoriť
                        </button>
                        {canLink && match.caseId !== call.caseId && (
                          <button
                            type="button"
                            onClick={() => void linkCase(match.caseId!)}
                            disabled={linkingCaseId === match.caseId}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-950 px-2.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:bg-zinc-300"
                          >
                            {linkingCaseId === match.caseId ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
                            Priradiť
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusChip({ label }: { label: CallerMatch["confidence"] }) {
  const className = label === "high" ? "bg-emerald-100 text-emerald-800" : label === "medium" ? "bg-amber-100 text-amber-900" : "bg-zinc-100 text-zinc-700";
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-normal ${className}`}>{label}</span>;
}

function matchLabel(match: CallerMatch) {
  if (match.type === "open_case") return `Otvorený prípad ${match.caseNumber ?? ""}`.trim();
  if (match.type === "recent_case") return `Starší prípad ${match.caseNumber ?? ""}`.trim();
  if (match.type === "previous_call") return "Predošlý hovor";
  return match.subtitle ?? "Kontakt";
}

function caseMatchesFilters(caseItem: DispatchCase, filters: CaseFilters) {
  if (filters.status !== "all" && caseItem.status !== filters.status) {
    return false;
  }
  if (filters.priority !== "all" && caseItem.priority !== filters.priority) {
    return false;
  }
  if (filters.ownerId !== "all" && caseItem.ownerId !== filters.ownerId) {
    return false;
  }
  if (filters.sourceType !== "all" && caseItem.sourceType !== filters.sourceType) {
    return false;
  }
  if (filters.assistanceService !== "all" && caseAssistanceServiceName(caseItem) !== filters.assistanceService) {
    return false;
  }

  return true;
}

function caseMatchesSearch({
  assetsById,
  branchesById,
  call,
  caseItem,
  operatorsById,
  search,
}: {
  assetsById: Map<string, FleetAsset>;
  branchesById: Map<string, Branch>;
  call?: CallCenterCall;
  caseItem: DispatchCase;
  operatorsById: Map<string, Operator>;
  search: string;
}) {
  const query = normalizeSearch(search);

  if (!query) {
    return true;
  }

  const owner = operatorsById.get(caseItem.ownerId);
  const branch = caseItem.branchId ? branchesById.get(caseItem.branchId) : undefined;
  const asset = caseItem.selectedAssetId ? assetsById.get(caseItem.selectedAssetId) : undefined;
  const latestTimeline = [...caseItem.timeline].sort((left, right) => new Date(right.time).getTime() - new Date(left.time).getTime())[0];
  const haystack = [
    caseItem.caseNumber,
    caseItem.status,
    caseStatusLabels[caseItem.status],
    caseItem.priority,
    casePriorityLabels[caseItem.priority],
    caseItem.sourceType,
    caseItem.sourceType ? sourceLabels[caseItem.sourceType] : undefined,
    caseItem.caseType,
    caseItem.summary,
    caseItem.mainNote,
    caseItem.nextStep,
    caseItem.createdAt,
    caseItem.updatedAt,
    caseItem.contact.name,
    caseItem.contact.phone,
    caseItem.contact.email,
    caseItem.customerDetails.assistanceServiceName,
    caseItem.customerDetails.assistanceReference,
    caseItem.vehicle.licensePlate,
    caseItem.vehicle.make,
    caseItem.vehicle.model,
    caseItem.vehicle.category,
    caseItem.vehicle.issue,
    caseItem.vehicle.specifics,
    caseItem.pickup?.label,
    caseItem.pickup?.address,
    caseItem.destination?.label,
    caseItem.destination?.address,
    owner?.name,
    owner?.extension,
    branch?.name,
    branch?.address,
    asset?.label,
    asset?.licensePlate,
    call?.callerName,
    call?.callerNumber,
    call?.calledNumber,
    call?.lineLabel,
    call?.queueLabel,
    call?.operatorName,
    call?.startedAt,
    call?.answeredAt,
    call?.endedAt,
    ...caseItem.tasks.flatMap((task) => [task.title, task.dueAt, task.status, task.priority, taskPriorityLabels[task.priority]]),
    latestTimeline?.actor,
    latestTimeline?.title,
    latestTimeline?.body,
  ];

  // Interné číslo prípadu aj externé číslo asistenčnej služby sa hľadajú bez ohľadu na formát
  // (pomlčky, lomky, medzery) — porovnáva sa iba alfanumerický zvyšok (P-06).
  const caseNumberQuery = compactSearch(search);
  const externalReference = caseItem.customerDetails.assistanceReference;
  const caseNumberMatches =
    caseNumberQuery.length > 0 &&
    (compactSearch(caseItem.caseNumber).includes(caseNumberQuery) ||
      (externalReference ? compactSearch(externalReference).includes(caseNumberQuery) : false));

  return caseNumberMatches || normalizeSearch(haystack.filter(Boolean).join(" ")).includes(query);
}

function compareCases(
  left: DispatchCase,
  right: DispatchCase,
  sort: CaseSortState,
  callsByCaseId: Map<string, CallCenterCall>,
  operatorsById: Map<string, Operator>,
  branchesById: Map<string, Branch>,
  assetsById: Map<string, FleetAsset>,
) {
  // Urgentné prípady majú vždy prednosť pred zvoleným zoradením (P-09).
  const urgentTier = Number(right.priority === "urgent") - Number(left.priority === "urgent");

  if (urgentTier !== 0) {
    return urgentTier;
  }

  const result = compareSortValues(
    sortValue(left, sort.key, callsByCaseId.get(left.id), operatorsById, branchesById, assetsById),
    sortValue(right, sort.key, callsByCaseId.get(right.id), operatorsById, branchesById, assetsById),
  );
  const directed = sort.direction === "asc" ? result : -result;

  if (directed !== 0) {
    return directed;
  }

  return dateValue(right.updatedAt) - dateValue(left.updatedAt) || left.caseNumber.localeCompare(right.caseNumber, "sk", { numeric: true });
}

function sortValue(
  caseItem: DispatchCase,
  key: CaseSortState["key"],
  call: CallCenterCall | undefined,
  operatorsById: Map<string, Operator>,
  branchesById: Map<string, Branch>,
  assetsById: Map<string, FleetAsset>,
) {
  if (key === "caseNumber") {
    return caseItem.caseNumber;
  }
  if (key === "status") {
    return statusRank[caseItem.status];
  }
  if (key === "priority") {
    return priorityRank[caseItem.priority];
  }
  if (key === "createdAt") {
    return dateValue(caseItem.createdAt);
  }
  if (key === "updatedAt") {
    return dateValue(caseItem.updatedAt);
  }
  if (key === "callStartedAt") {
    return dateValue(call?.startedAt);
  }
  if (key === "answeredAt") {
    return dateValue(call?.answeredAt ?? call?.endedAt);
  }
  if (key === "caller") {
    return call?.callerName ?? call?.callerNumber ?? caseItem.contact.name;
  }
  if (key === "owner") {
    return operatorsById.get(caseItem.ownerId)?.name ?? "Nepriradené";
  }
  if (key === "caseType") {
    return `${caseItem.caseType ?? ""} ${caseItem.sourceType ? sourceLabels[caseItem.sourceType] : ""}`;
  }
  if (key === "pickup") {
    return caseItem.pickup ? `${caseItem.pickup.label} ${caseItem.pickup.address}` : "Poloha nezadaná";
  }
  if (key === "destination") {
    return caseItem.destination ? `${caseItem.destination.label} ${caseItem.destination.address}` : "Cieľ nezadaný";
  }
  if (key === "branch") {
    return caseItem.branchId ? branchesById.get(caseItem.branchId)?.name ?? "Bez pobočky" : "Bez pobočky";
  }
  if (key === "asset") {
    return caseItem.selectedAssetId ? assetsById.get(caseItem.selectedAssetId)?.label ?? "Neznáma technika" : "Nepriradené";
  }
  if (key === "nextStep") {
    return caseItem.nextStep;
  }
  if (key === "openTasks") {
    return caseItem.tasks.filter(isTaskOpen).length;
  }
  if (key === "latestActivityAt") {
    return dateValue(latestTimelineTime(caseItem));
  }

  return `${caseItem.vehicle.licensePlate} ${caseItem.vehicle.make} ${caseItem.vehicle.model}`;
}

function compareSortValues(left: string | number, right: string | number) {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return String(left).localeCompare(String(right), "sk", { numeric: true, sensitivity: "base" });
}

function latestTimelineTime(caseItem: DispatchCase) {
  return [...caseItem.timeline].sort((left, right) => dateValue(right.time) - dateValue(left.time))[0]?.time;
}

function liveIncomingCall(
  calls: CallCenterCall[],
  dismissedCallId: string | null,
  canControlCall: (call: CallCenterCall) => boolean,
) {
  const activeCall = calls.find((call) =>
    ["incoming", "ringing_agent"].includes(call.status) &&
    call.id !== dismissedCallId &&
    canControlCall(call),
  );

  if (activeCall) {
    return toDispatchCall(activeCall);
  }

  return null;
}

function toDispatchCall(call: DispatchCall | CallCenterCall): IncomingPopupCall {
  const outbound = inCallCenterCall(call) && call.direction === "outbound";
  return {
    id: call.id,
    status: toDispatchCallStatus(call.status),
    callerNumber: outbound ? call.destinationNumber ?? call.calledNumber : call.callerNumber,
    callerName: outbound ? undefined : call.callerName,
    calledNumber: call.calledNumber,
    receivedNumber: call.receivedNumber,
    destinationNumber: call.destinationNumber,
    lineId: call.lineId,
    lineLabel: call.lineLabel,
    queueLabel: call.queueLabel,
    startedAt: call.startedAt,
    waitSeconds: call.waitSeconds,
    caseId: call.caseId,
    history: call.history,
    ...(inCallCenterCall(call) ? { viptelUniqueId: call.viptelUniqueId } : {}),
  };
}

function browserCallIdentity(value: string) {
  return value.replace(/[^\d]/g, "").slice(-9);
}

function inCallCenterCall(call: DispatchCall | CallCenterCall): call is CallCenterCall {
  return "viptelUniqueId" in call;
}

function toDispatchCallStatus(status: DispatchCall["status"] | CallCenterCall["status"]): DispatchCall["status"] {
  if (status === "abandoned_queue" || status === "failed") {
    return "missed";
  }

  return status;
}

function callIdentityKeys(call: CallCenterCall) {
  return [
    call.id,
    call.providerCallId ? `provider:${call.providerCallId}` : "",
    call.viptelUniqueId ? `viptel:${call.viptelUniqueId}` : "",
    call.fromQueueUniqueId ? `viptel:${call.fromQueueUniqueId}` : "",
  ].filter(Boolean);
}

function preserveStableCallPresentation(previous: CallCenterCall, current: CallCenterCall): CallCenterCall {
  return {
    ...previous,
    ...current,
    callerName: meaningfulCallText(current.callerName) ?? previous.callerName,
    callerNumber: meaningfulCallNumber(current.callerNumber) ?? previous.callerNumber,
    calledNumber: meaningfulCallNumber(current.calledNumber) ?? previous.calledNumber,
    destinationNumber: meaningfulCallNumber(current.destinationNumber) ?? previous.destinationNumber,
    lineLabel: meaningfulCallText(current.lineLabel) ?? previous.lineLabel,
    receivedNumber: meaningfulCallNumber(current.receivedNumber) ?? previous.receivedNumber,
  };
}

function meaningfulCallNumber(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized || normalized === "-" || normalized === "Neznáme číslo" || normalized === "Prichádzajúci hovor") {
    return undefined;
  }
  return normalized;
}

function meaningfulCallText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function extensionHasAvailableQueueMembership(snapshot: TelephonyPresenceSnapshot, extension: string) {
  return snapshot.queueStatuses.some((queue) =>
    queue.members.some((member) => member.extension === extension && !member.paused),
  );
}

function workplacePriorityMatchesSelection(
  workplace: WorkplaceSelectionSnapshot,
  queue: WorkplaceSelectionInput["queue"],
) {
  const extension = workplace.selection.extension;
  return Boolean(extension && workplace.priorities.some((priority) =>
    priority.queue === queue && priority.activeExtension === extension,
  ));
}

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sameWorkplacePendingRequest(left: WorkplacePendingMutation, right: WorkplacePendingMutation) {
  return left.action === right.action &&
    left.actorProfileId === right.actorProfileId &&
    left.browserInstanceId === right.browserInstanceId &&
    left.expectedVersion === right.expectedVersion &&
    left.extension === right.extension &&
    left.idempotencyKey === right.idempotencyKey &&
    left.kind === right.kind &&
    left.operationId === right.operationId &&
    left.organizationId === right.organizationId &&
    left.phase === right.phase;
}

function workplacePendingMutationInput(pending: WorkplacePendingMutation) {
  return {
    browserInstanceId: pending.browserInstanceId,
    idempotencyKey: pending.idempotencyKey,
    ...(pending.action === "confirm_seat_change" && pending.browserDisconnectOutcome
      ? { browserDisconnectOutcome: pending.browserDisconnectOutcome }
      : {}),
    ...(pending.expectedVersion ? { expectedVersion: pending.expectedVersion } : {}),
    ...(pending.action === "select_seat" && pending.extension ? { extension: pending.extension } : {}),
    ...(pending.operationId ? { operationId: pending.operationId } : {}),
  };
}

function workplacePendingBelongsToViewer(
  pending: { actorProfileId: string; organizationId?: string },
  actorProfileId: string,
  organizationId?: string,
) {
  if (pending.actorProfileId !== actorProfileId) return false;
  return !pending.organizationId || pending.organizationId === organizationId;
}

function sameWorkplacePendingResume(left: WorkplacePendingResume, right: WorkplacePendingResume) {
  return left.actorProfileId === right.actorProfileId &&
    left.assignmentGeneration === right.assignmentGeneration &&
    left.browserInstanceId === right.browserInstanceId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.leaderEpoch === right.leaderEpoch &&
    left.leaseId === right.leaseId &&
    left.leaseVersion === right.leaseVersion &&
    left.organizationId === right.organizationId &&
    left.resumeSecret === right.resumeSecret;
}

function workplacePendingResumeInput(pending: WorkplacePendingResume) {
  return {
    action: "resume" as const,
    assignmentGeneration: pending.assignmentGeneration,
    browserInstanceId: pending.browserInstanceId,
    idempotencyKey: pending.idempotencyKey,
    leaderEpoch: pending.leaderEpoch,
    leaseId: pending.leaseId,
    leaseVersion: pending.leaseVersion,
    resumeSecret: pending.resumeSecret,
  };
}

function latestCallByCaseId(calls: CallCenterCall[]) {
  const callsByCaseId = new Map<string, CallCenterCall>();

  calls.forEach((call) => {
    if (!call.caseId) {
      return;
    }

    const previous = callsByCaseId.get(call.caseId);

    if (!previous || dateValue(call.startedAt) > dateValue(previous.startedAt)) {
      callsByCaseId.set(call.caseId, call);
    }
  });

  return callsByCaseId;
}

function dateValue(value: string | undefined) {
  if (!value) {
    return 0;
  }

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function normalizeSearch(value: string) {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function compactSearch(value: string) {
  return normalizeSearch(value).replace(/[^a-z0-9]/g, "");
}

function failedProbeState(current: TelephonyHealthSignal, checkedAt: string): "degraded" | "stale" {
  if (!current.lastSuccessAt) return "degraded";
  const age = Date.parse(checkedAt) - Date.parse(current.lastSuccessAt);
  return Number.isFinite(age) && age >= TELEPHONY_PROBE_STALE_AFTER_MS ? "stale" : "degraded";
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function isGlobalErrorNotice(message: string) {
  const normalized = normalizeSearch(message);
  return [
    "nepodar",
    "zlyh",
    "chyba",
    "nema",
    "nemoz",
    "nie je",
    "neplat",
    "najprv",
    "treba",
    "skontrol",
    "prerus",
    "zastar",
    "neodpoved",
    "prekrocil",
    "zostalo",
    "nezhod",
    "odmiet",
    "blok",
    "bezpec",
    "obnov stav",
  ].some((fragment) => normalized.includes(fragment));
}

function operatorStatusFromPresence(state: TelephonyOperatorPresenceState): Operator["status"] {
  if (state === "available" || state === "ringing" || state === "on_call" || state === "paused") {
    return state;
  }
  return "offline";
}
