"use client";
import { mergeCaseDetail } from "@/data/case-detail";

import { CallMonitorInvitations } from "./CallMonitorInvitations";
import { requestCallbackTargetConfirmation } from "@/lib/telephony/callback-target-client";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  ArrowLeft,
  BellRing,
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  NotebookPen,
  PanelLeftOpen,
  PanelRightOpen,
  Wrench,
  Headphones,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  MapPinned,
  Maximize2,
  Minimize2,
  PhoneOff,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Settings2,
  Table2,
  Truck,
  UserRound,
  X,
} from "lucide-react";
import { AttendanceModule } from "./AttendanceModule";
import { CallCenterModule } from "./CallCenterModule";
import { HeaderLiveCallsMenu } from "./LiveCallOverview";
import { CaseDirectory } from "./CaseDirectory";
import { CaseList, type CaseFilters } from "./CaseList";
import { SmsComposerDialog } from "./SmsComposerDialog";
import { DashboardPhone } from "./DashboardPhone";
import type { CaseSortState } from "./CaseTable";
import { FleetModule } from "./FleetModule";
import { mergeFleetData, useFleetRefresh } from "./useFleetRefresh";
import { IntegrationSettings } from "./IntegrationSettings";
import { MapWorkspace, type CenterView, type WorkspaceKind, type WorkspaceMode } from "./MapWorkspace";
import type { SaveCaseDraft } from "./NewCaseDrawer";
import { ReportDashboard } from "./ReportDashboard";
import { HeaderNotificationMenu } from "./HeaderNotificationMenu";
import { HeaderPhoneStatusMenu } from "./HeaderPhoneStatusMenu";
import { NotificationToastStack } from "./NotificationToastStack";
import { PauseRoutingDialog } from "./PauseRoutingDialog";
import { PhoneBar } from "./PhoneBar";
import { phoneBarVisible, type PhoneCallAction } from "./phone-bar-model";
import { isMobileApp } from "@/lib/telephony/phone-platform";
import { TELEPHONY_STALE_MESSAGE, useTelephonyConsole } from "./useTelephonyConsole";
import { TaskPanel, type TaskCreateInput, type TaskDeleteInput, type TaskUpdateInput } from "./TaskPanel";
import { hasLiveUpdates, mergeLiveUpdates, type LiveUpdatesResponse } from "./live-updates";
import {
  DEFAULT_MOBILE_NAVIGATION_SHORTCUTS,
  DEFAULT_PINNED_NAVIGATION_VIEWS,
  MAX_MOBILE_NAVIGATION_SHORTCUTS,
  MAX_PINNED_NAVIGATION_VIEWS,
  isPinnableNavigationView,
  mobileNavigationPreferenceStorageKey,
  navigationPreferenceStorageKey,
  parseMobileNavigationShortcuts,
  parsePinnedNavigationViews,
  toggleMobileNavigationShortcut,
  togglePinnedNavigationView,
  type MobileNavigationShortcut,
  type PinnableNavigationView,
} from "./navigation-preferences";
import { WidgetHost } from "./WidgetHost";
import { CalculatorWidget } from "./CalculatorWidget";
import { WorkspacePlaceSearch } from "./WorkspacePlaceSearch";
import { WorkspaceSearchWidget } from "./WorkspaceSearchWidget";
import { fleetWidgetStatus } from "./workspace-search";
import { defaultWorkspacePreferences, parseWorkspacePreferences, workspacePreferenceStorageKey, type WorkspacePreferences, type WidgetId } from "./workspace-preferences";
import { NotebookPanel, NotebookProvider } from "./NotebookPanel";
import { RoutePlannerProvider } from "./map/RoutePlannerProvider";
import { RoutePlanner } from "./map/RoutePlanner";
import { TaskWorkspaceProvider, useTaskWorkspace } from "./TaskWorkspaceProvider";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { unavailableWorkspaceCapabilities } from "@/domain/workspace-capabilities";
import { useDraftEditors, type DraftEditorState } from "./useDraftEditors";
import { createNotificationNavigationReceiver } from "@/components/pwa/notification-navigation";
import "./workspace-tools.css";
import { signOutCurrentSession } from "@/components/auth/sign-out";
import { PushNotificationSync } from "@/components/pwa/PushNotificationSync";
import { PauseEndingNotificationSync } from "@/components/pwa/PauseEndingNotificationSync";
import { useAppUpdate } from "@/components/pwa/useAppUpdate";
import { isAppRefreshBlocked } from "@/components/pwa/app-refresh-policy";
import { notificationTarget } from "@/components/pwa/notification-target";
import { navigateAfterDraftApproval } from "@/lib/draft-unload";
import type { CallCenterCall, DispatchData } from "@/data/dispatch-types";
import { formatNotificationReminderTime, isNotificationForProfile, isNotificationUnread, notificationStatusLabel } from "@/domain/notifications";
import { casePriorityLabels, caseStatusLabels } from "@/domain/statuses";
import { isTaskOpen, taskPriorityLabels } from "@/domain/tasks";
import type { AppRole, Branch, CallStatus, CaseTask, DispatchCall, DispatchCase, FleetAsset, NotificationStatus, Operator, TimelineEvent } from "@/domain/types";
import { requiresTowDestination } from "@/domain/case-card";
import { caseAssistanceServiceName } from "@/lib/dispatch-calculations";
import { createDispatchMapModel } from "@/lib/map-adapter";
import { mergeCallCenterCalls, type PhoneBarCall } from "@/lib/telephony/active-calls-model";
import type { CallNotificationFocus } from "@/lib/telephony/call-notification-target";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { supportPollDelayMs } from "@/lib/telephony/poll-schedule";
import { canSuperviseRole } from "@/lib/telephony/supervisor-mode";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE, TelephonyNotConfiguredError } from "@/lib/telephony/not-configured";
import { pausePlan } from "@/lib/telephony/pause-ending";
import type { TelephonyAvailabilityAction } from "@/lib/telephony/presence";

type View = "dispatch" | PinnableNavigationView;

type NavigationOptions = {
  beforeNavigate?: () => boolean;
  documentNavigation?: boolean;
};

type NavigationGroup = "daily" | "operations" | "management";

type NavigationItem = {
  badgeCount?: number;
  group?: NavigationGroup;
  icon: LucideIcon;
  label: string;
  shortLabel: string;
  view: View;
};

type MobileShortcutItem = {
  active: boolean;
  badgeCount?: number;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  shortcut: MobileNavigationShortcut;
  shortLabel: string;
};

type DispatchWorkspaceState = {
  kind: WorkspaceKind;
  mode: WorkspaceMode;
};

const defaultCaseFilters: CaseFilters = {
  assistanceService: "all",
  ownerId: "all",
  priority: "all",
  sourceType: "all",
  status: "all",
};

type DashboardColumnSide = "left" | "right";

type DashboardColumnWidths = {
  left: number;
  right: number;
};

const DEFAULT_DASHBOARD_COLUMNS: DashboardColumnWidths = { left: 330, right: 330 };
const DASHBOARD_LEFT_MIN = 260;
const DASHBOARD_LEFT_MAX = 480;
const DASHBOARD_RIGHT_MIN = 280;
const DASHBOARD_RIGHT_MAX = 480;
const DASHBOARD_CENTER_MIN = 480;

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

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function fitDashboardColumns(columns: DashboardColumnWidths, gridWidth: number, rightVisible: boolean): DashboardColumnWidths {
  let left = clampNumber(columns.left, DASHBOARD_LEFT_MIN, DASHBOARD_LEFT_MAX, DEFAULT_DASHBOARD_COLUMNS.left);
  let right = clampNumber(columns.right, DASHBOARD_RIGHT_MIN, DASHBOARD_RIGHT_MAX, DEFAULT_DASHBOARD_COLUMNS.right);

  if (!rightVisible) {
    left = Math.min(left, Math.max(DASHBOARD_LEFT_MIN, gridWidth - DASHBOARD_CENTER_MIN));
    return { left, right };
  }

  const availableForRails = Math.max(
    DASHBOARD_LEFT_MIN + DASHBOARD_RIGHT_MIN,
    gridWidth - DASHBOARD_CENTER_MIN,
  );
  let overflow = Math.max(0, left + right - availableForRails);
  const rightReduction = Math.min(overflow, right - DASHBOARD_RIGHT_MIN);
  right -= rightReduction;
  overflow -= rightReduction;
  left -= Math.min(overflow, left - DASHBOARD_LEFT_MIN);

  return { left, right };
}

function resizeDashboardColumn(
  columns: DashboardColumnWidths,
  side: DashboardColumnSide,
  requestedWidth: number,
  gridWidth: number,
  rightVisible: boolean,
): DashboardColumnWidths {
  const fitted = fitDashboardColumns(columns, gridWidth, rightVisible);
  const minimum = side === "left" ? DASHBOARD_LEFT_MIN : DASHBOARD_RIGHT_MIN;
  const hardMaximum = side === "left" ? DASHBOARD_LEFT_MAX : DASHBOARD_RIGHT_MAX;
  const otherWidth = side === "left" ? (rightVisible ? fitted.right : 0) : fitted.left;
  const viewportMaximum = Math.max(minimum, gridWidth - DASHBOARD_CENTER_MIN - otherWidth);
  const width = clampNumber(requestedWidth, minimum, Math.min(hardMaximum, viewportMaximum), fitted[side]);

  return { ...fitted, [side]: width };
}

const sourceLabels: Record<NonNullable<DispatchCase["sourceType"]>, string> = {
  client: "Klient",
  assistance: "Asistenčka",
  samoplatca: "Samoplatca",
  partner: "Partner",
  internal: "Interné",
};

export function DispatchConsole(props: Parameters<typeof DispatchConsoleContent>[0]) {
  return <RoutePlannerProvider key={`${props.viewerOrganizationId ?? "demo"}:${props.viewerProfileId ?? "local-browser"}`}><DispatchConsoleContent {...props} /></RoutePlannerProvider>;
}

function DispatchConsoleContent({
  initialData,
  appVersion = "development",
  viewerDisplayName,
  viewerEmail,
  viewerOrganizationId,
  viewerProfileId,
  viewerRole,
}: {
  initialData: DispatchData;
  appVersion?: string;
  viewerDisplayName?: string;
  viewerEmail?: string;
  viewerOrganizationId?: string;
  viewerProfileId?: string;
  /** The signed-in profile's role; only supervision is gated on it in the console. */
  viewerRole?: AppRole;
}) {
  const updateAvailable = useAppUpdate(appVersion);
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
  const capabilities = dispatchData.workspaceCapabilities ?? unavailableWorkspaceCapabilities;
  const notificationViewerProfileId = viewerProfileId ?? (source === "mock" ? operators[0]?.id : undefined);
  const signedInName =
    viewerDisplayName?.trim() ||
    users.find((user) => user.id === viewerProfileId)?.name ||
    operators.find((operator) => operator.id === viewerProfileId)?.name ||
    users[0]?.name ||
    "Prihlásený používateľ";
  const [activeView, setActiveView] = useState<View>("dispatch");
  const [mobilePane, setMobilePane] = useState<"cases" | "workspace">("cases");
  const pushDeepLinkHandled = useRef(false);
  const [attendanceLoaded, setAttendanceLoaded] = useState(source !== "supabase");
  const [attendanceError, setAttendanceError] = useState<string | null>(null);
  useEffect(() => {
    if (activeView !== "attendance" || source !== "supabase") return;
    const controller = new AbortController();
    const originalAttendance = attendance;
    void fetch("/api/attendance", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]) }).then(async response => {
      const body = await response.json();
      if (!response.ok || !body.attendance) throw new Error(body.error ?? "Dochádzka je nedostupná.");
      if (!controller.signal.aborted) {
        setDispatchData(current => current.attendance === originalAttendance ? { ...current, attendance: body.attendance } : current);
        setAttendanceLoaded(true); setAttendanceError(null);
      }
    }).catch(error => { if (!controller.signal.aborted) setAttendanceError(error instanceof Error ? error.message : "Dochádzka je nedostupná."); });
    return () => controller.abort();
    // Opening this module starts one bounded read; mutations own subsequent state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, source]);
  const fleetRefresh = useFleetRefresh(source === "supabase" && ["dispatch", "fleet", "cases"].includes(activeView), setDispatchData);
  const [pinnedNavigationViews, setPinnedNavigationViews] = useState<PinnableNavigationView[]>([
    ...DEFAULT_PINNED_NAVIGATION_VIEWS,
  ]);
  const [mobileNavigationShortcuts, setMobileNavigationShortcuts] = useState<MobileNavigationShortcut[]>([
    ...DEFAULT_MOBILE_NAVIGATION_SHORTCUTS,
  ]);
  const [navigationPinNotice, setNavigationPinNotice] = useState<string | null>(null);
  const [mobileNavigationNotice, setMobileNavigationNotice] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [activeCaseId, setActiveCaseId] = useState(dispatchCases.find(isActiveDispatchCase)?.id ?? "");
  const [workspace, setWorkspace] = useState<DispatchWorkspaceState>({ kind: "cockpit", mode: "split" });
  const [newCaseCall, setNewCaseCall] = useState(incomingCall);
  const [callStatus, setCallStatus] = useState<CallStatus>(incomingCall.status);
  const [isAssigning, setIsAssigning] = useState(false);
  const [caseSmsComposer, setCaseSmsComposer] = useState<{ id: string; caseNumber: string; template: "location_request" | "eta_update"; open: boolean } | null>(null);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);
  const [pauseRoutingOpen, setPauseRoutingOpen] = useState(false);
  const [dismissedWarning, setDismissedWarning] = useState<string | null>(null);
  const actorKey = `${viewerOrganizationId ?? "demo"}:${viewerProfileId ?? "local-browser"}`;
  const [workspacePreferences, setWorkspacePreferences] = useState(defaultWorkspacePreferences);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [widgetSettingsOpen, setWidgetSettingsOpen] = useState(false);
  const toolsReturnFocusRef = useRef<HTMLElement | null>(null);
  const [visitedWidgets, setVisitedWidgets] = useState<Set<WidgetId>>(() => new Set(["phone", "tasks"]));
  const drafts = useDraftEditors();
  const registerDraft = drafts.register;
  const handleTaskEditor = useCallback((editor: DraftEditorState | null) => registerDraft("Úlohy a chat", editor), [registerDraft]);
  const handleWorkspaceTasks = useCallback((tasks: WorkspaceTask[]) => {
    setDispatchData(current => ({ ...current, tasks, dispatchCases: current.dispatchCases.map(item => ({ ...item, tasks: tasks.filter(task => task.caseIds.includes(item.id)) })), metrics: { ...current.metrics, openTasks: tasks.filter(isTaskOpen).length } }));
  }, []);
  const handleNotebookEditor = useCallback((editor: DraftEditorState) => registerDraft("Poznámky", editor), [registerDraft]);
  const centerView = workspacePreferences.centerView;
  const workspaceStorageKey = workspacePreferenceStorageKey(viewerOrganizationId, viewerProfileId);
  const currentSessionKeyRef = useRef<string | null>(actorKey);
  useEffect(() => {
    currentSessionKeyRef.current = actorKey;
    let userId: string | undefined;
    try {
      const client = createSupabaseBrowserClient();
      const { data } = client.auth.onAuthStateChange((event, session) => {
        if (!session || event === "SIGNED_OUT" || (userId && userId !== session.user.id)) currentSessionKeyRef.current = null;
        if (session?.user.id) userId = session.user.id;
      });
      return () => { currentSessionKeyRef.current = null; data.subscription.unsubscribe(); };
    } catch { /* The isolated demo has no authentication client. */ }
  }, [actorKey]);
  function updateWorkspacePreferences(next: WorkspacePreferences) {
    setWorkspacePreferences(next);
    setVisitedWidgets(current => new Set([...current, ...next.widgets.filter(item => item.visible).map(item => item.id)]));
    try { window.localStorage.setItem(workspaceStorageKey, JSON.stringify(next)); } catch { /* Layout works without storage. */ }
  }
  function setCenterView(view: CenterView) {
    updateWorkspacePreferences({ ...workspacePreferences, centerView: view });
  }
  useEffect(() => {
    const load = (raw: string | null) => {
      const next = parseWorkspacePreferences(raw);
      setWorkspacePreferences(next);
      setVisitedWidgets(current => new Set([...current, ...next.widgets.filter(item => item.visible).map(item => item.id)]));
    };
    const frame = window.requestAnimationFrame(() => {
      try { load(window.localStorage.getItem(workspaceStorageKey)); } catch { load(null); }
    });
    const sync = (event: StorageEvent) => { if (event.key === workspaceStorageKey) load(event.newValue); };
    window.addEventListener("storage", sync);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("storage", sync); };
  }, [workspaceStorageKey]);
  const [caseSearch, setCaseSearch] = useState("");
  const [caseFilters, setCaseFilters] = useState<CaseFilters>(defaultCaseFilters);
  const [caseSort, setCaseSort] = useState<CaseSortState>({ key: "updatedAt", direction: "desc" });
  const [focusedTaskId, setFocusedTaskId] = useState<string | undefined>(undefined);
  const [taskOpenVersion, setTaskOpenVersion] = useState(0);
  const [callNotificationFocus, setCallNotificationFocus] = useState<CallNotificationFocus | null>(null);
  const [priorityChangeCaseId, setPriorityChangeCaseId] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [caseEditorRevision, setCaseEditorRevision] = useState(0);
  const caseDirtyRef = useRef(false);
  const caseSavingRef = useRef(false);
  const handleCaseDirtyChange = useCallback((dirty: boolean) => { caseDirtyRef.current = dirty; setHasUnsavedChanges(dirty); }, []);
  const handleCaseSavingChange = useCallback((saving: boolean) => { caseSavingRef.current = saving; setIsCaseSaveLocked(saving); }, []);
  const [isCaseSaveLocked, setIsCaseSaveLocked] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [leaveDialogSaving, setLeaveDialogSaving] = useState(false);
  const [leaveDialogError, setLeaveDialogError] = useState<string | null>(null);
  const [leaveAfterSave, setLeaveAfterSave] = useState(false);
  const pendingNavigationRef = useRef<(() => void) | null>(null);
  const pendingNavigationOptionsRef = useRef<NavigationOptions>({});
  const saveCaseDraftRef = useRef<SaveCaseDraft | null>(null);
  const leaveObservedSavingRef = useRef(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const topBarsRef = useRef<HTMLDivElement>(null);
  const returnViewRef = useRef<View>("dispatch");
  const [markingNotificationId, setMarkingNotificationId] = useState<string | null>(null);
  const [isNotificationSyncing, setIsNotificationSyncing] = useState(false);
  const [lastNotificationSyncAt, setLastNotificationSyncAt] = useState<string | undefined>(undefined);
  const [notificationNow, setNotificationNow] = useState(() => Date.now());
  const notificationSyncInFlight = useRef(false);
  const notificationSyncAgain = useRef(false);
  const locationUpdateCursorRef = useRef(new Date(Date.now() - 30_000).toISOString());
  const locationUpdatePollInFlight = useRef(false);
  const callHistoryRefreshInFlight = useRef(false);
  const dashboardGridRef = useRef<HTMLElement | null>(null);
  const dashboardColumnsRef = useRef<DashboardColumnWidths>(DEFAULT_DASHBOARD_COLUMNS);
  const dashboardResizeRef = useRef<{
    pointerId: number;
    side: DashboardColumnSide;
    startWidth: number;
    startX: number;
  } | null>(null);
  const [dashboardColumns, setDashboardColumns] = useState<DashboardColumnWidths>(DEFAULT_DASHBOARD_COLUMNS);
  const dashboardColumnStorageKey = `motorist:dashboard-columns:v2:${actorKey}`;
  const navigationStorageKey = navigationPreferenceStorageKey(actorKey);
  const mobileNavigationStorageKey = mobileNavigationPreferenceStorageKey(actorKey);

  useEffect(() => {
    consoleRef.current?.setAttribute("data-hydrated", "true");
  }, []);

  useEffect(() => {
    // Resolve only against data the signed-in viewer is allowed to load.
    // A push link survives the login form because it keeps the current URL.
    if (pushDeepLinkHandled.current) return;
    const frame = window.requestAnimationFrame(() => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("task") && !url.searchParams.has("call")) return;
      pushDeepLinkHandled.current = true;
      handleInitialPushOpen(url.href);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let frameId: number | undefined;

    const applyStoredPreference = (raw: string | null) => {
      const parsed = parsePinnedNavigationViews(raw);
      frameId = window.requestAnimationFrame(() => setPinnedNavigationViews(parsed));
    };

    try {
      applyStoredPreference(window.localStorage.getItem(navigationStorageKey));
    } catch {
      // Browser storage is only an enhancement; the practical defaults remain usable.
    }

    const syncAcrossTabs = (event: StorageEvent) => {
      if (event.key === navigationStorageKey) applyStoredPreference(event.newValue);
    };
    window.addEventListener("storage", syncAcrossTabs);

    return () => {
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      window.removeEventListener("storage", syncAcrossTabs);
    };
  }, [navigationStorageKey]);

  useEffect(() => {
    let frameId: number | undefined;

    const applyStoredPreference = (raw: string | null) => {
      const parsed = parseMobileNavigationShortcuts(raw);
      frameId = window.requestAnimationFrame(() => setMobileNavigationShortcuts(parsed));
    };

    try {
      applyStoredPreference(window.localStorage.getItem(mobileNavigationStorageKey));
    } catch {
      // The default cases/tasks/map footer remains available without storage.
    }

    const syncAcrossTabs = (event: StorageEvent) => {
      if (event.key === mobileNavigationStorageKey) applyStoredPreference(event.newValue);
    };
    window.addEventListener("storage", syncAcrossTabs);

    return () => {
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      window.removeEventListener("storage", syncAcrossTabs);
    };
  }, [mobileNavigationStorageKey]);

  useEffect(() => {
    let frameId: number | undefined;

    try {
      const stored = window.localStorage.getItem(dashboardColumnStorageKey);
      if (!stored) return;
      const parsed = JSON.parse(stored) as Partial<DashboardColumnWidths>;
      const next = {
        left: clampNumber(parsed.left, DASHBOARD_LEFT_MIN, DASHBOARD_LEFT_MAX, DEFAULT_DASHBOARD_COLUMNS.left),
        right: clampNumber(parsed.right, DASHBOARD_RIGHT_MIN, DASHBOARD_RIGHT_MAX, DEFAULT_DASHBOARD_COLUMNS.right),
      };
      frameId = window.requestAnimationFrame(() => {
        dashboardColumnsRef.current = next;
        setDashboardColumns(next);
      });
    } catch {
      // A malformed local preference must never prevent the dashboard from opening.
    }

    return () => {
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
    };
  }, [dashboardColumnStorageKey]);

  useEffect(() => {
    const clampColumnsToViewport = () => {
      const gridWidth = dashboardGridRef.current?.clientWidth;
      if (!gridWidth) return;

      setDashboardColumns((current) => {
        const rightVisible = window.matchMedia("(min-width: 1280px)").matches;
        const next = fitDashboardColumns(current, gridWidth, rightVisible);
        dashboardColumnsRef.current = next;
        return next.left === current.left && next.right === current.right ? current : next;
      });
    };

    clampColumnsToViewport();
    window.addEventListener("resize", clampColumnsToViewport);
    return () => window.removeEventListener("resize", clampColumnsToViewport);
  }, []);

  function updateDashboardColumn(side: DashboardColumnSide, requestedWidth: number, persist = false) {
    const gridWidth = dashboardGridRef.current?.clientWidth ?? window.innerWidth;
    const rightVisible = window.matchMedia("(min-width: 1280px)").matches;
    const current = dashboardColumnsRef.current;
    const next = resizeDashboardColumn(current, side, requestedWidth, gridWidth, rightVisible);

    dashboardColumnsRef.current = next;
    setDashboardColumns(next);
    if (persist) {
      persistDashboardColumns(next);
    }
  }

  function persistDashboardColumns(columns: DashboardColumnWidths) {
    try {
      window.localStorage.setItem(dashboardColumnStorageKey, JSON.stringify(columns));
    } catch {
      // Resizing remains available even when the browser blocks local storage.
    }
  }

  function beginDashboardColumnResize(side: DashboardColumnSide, event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dashboardResizeRef.current = {
      pointerId: event.pointerId,
      side,
      startWidth: dashboardColumnsRef.current[side],
      startX: event.clientX,
    };
    dashboardGridRef.current?.setAttribute("data-resizing", "true");
  }

  function moveDashboardColumnResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = dashboardResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;

    const pointerDelta = event.clientX - resize.startX;
    const widthDelta = resize.side === "left" ? pointerDelta : -pointerDelta;
    dashboardGridRef.current?.setAttribute("data-collapse-candidate", resize.startWidth + widthDelta < 120 ? resize.side : "");
    updateDashboardColumn(resize.side, resize.startWidth + widthDelta);
  }

  function finishDashboardColumnResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = dashboardResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;

    dashboardResizeRef.current = null;
    const collapseSide = dashboardGridRef.current?.getAttribute("data-collapse-candidate");
    dashboardGridRef.current?.removeAttribute("data-resizing");
    dashboardGridRef.current?.removeAttribute("data-collapse-candidate");
    if (collapseSide === resize.side) {
      dashboardColumnsRef.current = { ...dashboardColumnsRef.current, [resize.side]: resize.startWidth };
      setDashboardColumns(dashboardColumnsRef.current);
      updateWorkspacePreferences({ ...workspacePreferences, [resize.side === "left" ? "leftCollapsed" : "rightCollapsed"]: true });
    }
    persistDashboardColumns(dashboardColumnsRef.current);
  }

  function handleDashboardColumnKeyDown(side: DashboardColumnSide, event: ReactKeyboardEvent<HTMLButtonElement>) {
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!direction) return;

    event.preventDefault();
    const delta = side === "left" ? direction * 10 : direction * -10;
    updateDashboardColumn(side, dashboardColumnsRef.current[side] + delta, true);
  }

  function resetDashboardColumn(side: DashboardColumnSide) {
    updateDashboardColumn(side, DEFAULT_DASHBOARD_COLUMNS[side], true);
  }

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

  // Telefónia (Telnyx): browser phone, `calls/active` polling, prezencia a
  // akcie hovoru žijú v `useTelephonyConsole`. Kým poskytovateľ nie je
  // nakonfigurovaný (503 z token/active route), hook vráti `configured=false`
  // a konzola ostáva v pôvodnom režime „Telefónia nie je nakonfigurovaná".
  const isOperator = Boolean(viewerProfileId && operators.some((operator) => operator.id === viewerProfileId));
  // Supervision of a colleague's live call is a manager/admin tool; the server
  // enforces it again in `call-actions.ts` (a dispatcher gets 403 either way).
  const viewerCanSupervise = canSuperviseRole(viewerRole);
  const telephony = useTelephonyConsole({ profileId: viewerProfileId ?? "", enabled: isOperator, operators });
  const appRefreshBlocked = isAppRefreshBlocked(telephony);
  const appRefreshBlockedRef = useRef(appRefreshBlocked);
  useLayoutEffect(() => {
    appRefreshBlockedRef.current = appRefreshBlocked;
  }, [appRefreshBlocked]);
  // `null` means "not answered yet"; only an explicit 503 parks the surface, so a
  // transient `calls/active` outage keeps the console (and the phone) usable.
  const telephonyConfigured = telephony.configured !== false;
  const operatorPresences = telephony.presences;
  const effectiveOperators = operators;
  const onQueueAvailabilityAction = useCallback(
    (action: TelephonyAvailabilityAction) => {
      if (!telephonyConfigured) {
        setMutationNotice(TELEPHONY_NOT_CONFIGURED_MESSAGE);
        return;
      }
      if (action === "pause") {
        telephony.refreshPauseReasons();
        setPauseRoutingOpen(true);
        return;
      }
      telephony.availabilityAction(action);
    },
    [telephony, telephonyConfigured],
  );
  // Timed pause: when it should end and whether the operator is past it. Shown
  // in the header; presence itself never changes without the operator's click.
  const ownPausePlan = useMemo(() => {
    const own = telephony.snapshot.ownPresence;
    if (!own) return null;
    const reason = telephony.pauseReasons.find((entry) => entry.id === own.pauseReasonId);
    return pausePlan({ status: own.status, statusSince: own.statusSince, maxMinutes: reason?.maxMinutes }, new Date(notificationNow));
  }, [notificationNow, telephony.pauseReasons, telephony.snapshot.ownPresence]);
  const visibleCallCenterCalls = useMemo(
    () => (telephonyConfigured ? mergeCallCenterCalls(telephony.liveCalls, callCenterCalls) : callCenterCalls),
    [callCenterCalls, telephony.liveCalls, telephonyConfigured],
  );
  const callLinkCandidates = useMemo(
    () => telephony.phoneBar.teamCalls.filter((call) => call.direction === "inbound" && !call.caseId),
    [telephony.phoneBar.teamCalls],
  );

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
    () => (dispatchData.tasks ?? [...new Map(dispatchCases.flatMap(item => item.tasks).map(task => [task.id, task])).values()]).filter(isTaskOpen).length,
    [dispatchCases, dispatchData.tasks],
  );
  const viewerNotifications = useMemo(
    () => notifications.filter((notification) => isNotificationForProfile(notification, notificationViewerProfileId)),
    [notificationViewerProfileId, notifications],
  );
  const taskAttentionCount = openTaskCount;
  const selectedCase = dispatchCases.find((caseItem) => caseItem.id === activeCaseId);
  // Saving a terminal status must not replace the mounted editor while a newer
  // draft is waiting for its next save. Selection changes are explicit/guarded.
  const activeCase = selectedCase ?? dispatchCases.find(isActiveDispatchCase);
  const workspaceCase = workspace.kind === "detail" ? selectedCase ?? activeCase : activeCase;
  const dashboardSmsCaseContext = workspace.kind === "detail" && selectedCase
    ? { caseNumber: selectedCase.caseNumber, id: selectedCase.id, phone: selectedCase.contact.phone }
    : undefined;
  const visibleActiveCaseId = activeCase?.id ?? "";
  const activePriceRule = workspaceCase?.priceRuleId
    ? priceRules.find((rule) => rule.id === workspaceCase.priceRuleId)
    : undefined;
  const mapModel = useMemo(
    () => (workspaceCase ? createDispatchMapModel(workspaceCase, branches, fleetAssets, activePriceRule) : undefined),
    [activePriceRule, branches, fleetAssets, workspaceCase],
  );
  const visibleCaseId = workspaceCase?.id;
  useEffect(() => {
    if (source !== "supabase" || !visibleCaseId || activeView !== "dispatch") return;
    const controller = new AbortController();
    void fetch(`/api/cases/${visibleCaseId}`, { headers: { "x-case-response": "detail-v2" }, cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]) }).then(async response => {
      const body = await response.json();
      if (!response.ok || body.caseDetail?.id !== visibleCaseId) throw new Error("Aktuálny detail a históriu prípadu sa nepodarilo načítať.");
      if (!controller.signal.aborted) setDispatchData(current => mergeCaseDetail(current, body.caseDetail));
    }).catch(error => { if (!controller.signal.aborted) setMutationNotice(error instanceof Error ? error.message : "Detail prípadu je nedostupný."); });
    return () => controller.abort();
  }, [visibleCaseId, source, activeView]);
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
    if (source !== "supabase" || activeView !== "call-center") return;
    const initialHistoryRead = window.setTimeout(() => void refreshCallHistory(), 0);
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
      window.clearTimeout(initialHistoryRead);
      document.removeEventListener("visibilitychange", onVisible);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [refreshCallHistory, activeView, source]);

  const navItems: NavigationItem[] = [
    { icon: LayoutDashboard, label: "Nástenka", shortLabel: "Nástenka", view: "dispatch" },
    { badgeCount: taskAttentionCount, group: "daily", icon: BellRing, label: "Úlohy", shortLabel: "Úlohy", view: "tasks" },
    { group: "daily", icon: NotebookPen, label: "Poznámky", shortLabel: "Poznámky", view: "notes" },
    { group: "daily", icon: Wrench, label: "Nástroje", shortLabel: "Nástroje", view: "tools" },
    { group: "daily", icon: Table2, label: "Prípady", shortLabel: "Prípady", view: "cases" },
    { group: "daily", icon: Headphones, label: "Ústredňa", shortLabel: "Ústredňa", view: "call-center" },
    { group: "operations", icon: CalendarDays, label: "Dochádzka", shortLabel: "Doch.", view: "attendance" },
    { group: "operations", icon: Truck, label: "Flotila", shortLabel: "Flotila", view: "fleet" },
    { group: "management", icon: BarChart3, label: "Reporty", shortLabel: "Reporty", view: "reports" },
    { group: "management", icon: Settings2, label: "Nastavenia", shortLabel: "Nastav.", view: "settings" },
  ];
  const dashboardNavItem = navItems.find((item) => item.view === "dispatch")!;
  const secondaryNavItems = navItems.filter(
    (item): item is NavigationItem & { view: PinnableNavigationView } => isPinnableNavigationView(item.view),
  );
  const pinnedNavItems = pinnedNavigationViews
    .map((view) => secondaryNavItems.find((item) => item.view === view))
    .filter((item): item is NavigationItem & { view: PinnableNavigationView } => Boolean(item));
  const secondaryBadgeCount = secondaryNavItems.reduce((total, item) => total + (item.badgeCount ?? 0), 0);
  const mobileShortcutItems: MobileShortcutItem[] = [
    {
      active: activeView === "cases" || activeView === "dispatch" && !toolsOpen && !focusedTaskId && (mobilePane === "cases" || centerView === "map" && (workspace.kind !== "cockpit" || workspace.mode === "expanded")),
      icon: Table2,
      label: "Prípady",
      onSelect: showMobileCases,
      shortcut: "dispatch-cases",
      shortLabel: "Prípady",
    },
    {
      active: activeView === "tasks",
      badgeCount: taskAttentionCount,
      icon: BellRing,
      label: "Úlohy",
      onSelect: () => switchView("tasks"),
      shortcut: "tasks",
      shortLabel: "Úlohy",
    },
    {
      active: activeView === "dispatch" && !toolsOpen && centerView === "map" && mobilePane === "workspace" && workspace.kind === "cockpit" && workspace.mode !== "expanded" && !focusedTaskId,
      icon: MapPinned,
      label: "Mapa",
      onSelect: showMobileMap,
      shortcut: "dispatch-map",
      shortLabel: "Mapa",
    },
    ...secondaryNavItems
      .filter((item) => item.view !== "tasks" && item.view !== "cases")
      .map((item): MobileShortcutItem => ({
        active: item.view === "tools" ? toolsOpen : activeView === item.view,
        badgeCount: item.badgeCount,
        icon: item.icon,
        label: item.label,
        onSelect: () => switchView(item.view),
        shortcut: item.view as MobileNavigationShortcut,
        shortLabel: item.shortLabel,
      })),
  ];
  const visibleMobileShortcutItems = mobileNavigationShortcuts
    .map((shortcut) => mobileShortcutItems.find((item) => item.shortcut === shortcut))
    .filter((item): item is MobileShortcutItem => Boolean(item));

  function toggleNavigationPin(view: PinnableNavigationView) {
    const result = togglePinnedNavigationView(pinnedNavigationViews, view);

    if (result.limitReached) {
      setNavigationPinNotice(`V hornej lište môžu byť najviac ${MAX_PINNED_NAVIGATION_VIEWS} skratky. Najprv jednu odopni.`);
      return;
    }

    setPinnedNavigationViews(result.views);
    setNavigationPinNotice(null);
    try {
      window.localStorage.setItem(navigationStorageKey, JSON.stringify(result.views));
    } catch {
      // The shortcut still works for this session if storage is unavailable.
    }
  }

  function toggleMobileShortcut(shortcut: MobileNavigationShortcut) {
    const result = toggleMobileNavigationShortcut(mobileNavigationShortcuts, shortcut);
    if (result.limitReached) {
      setMobileNavigationNotice(`V spodnej lište môžu byť najviac ${MAX_MOBILE_NAVIGATION_SHORTCUTS} skratky. Najprv jednu odopni.`);
      return;
    }

    setMobileNavigationShortcuts(result.shortcuts);
    setMobileNavigationNotice(null);
    try {
      window.localStorage.setItem(mobileNavigationStorageKey, JSON.stringify(result.shortcuts));
    } catch {
      // The customised footer remains usable for this session.
    }
  }

  // Stable so it does not invalidate the call-centre effects that depend on it;
  // as an inline arrow it was a new function on every render.
  const handleTelephonyChanged = useCallback(() => {
    void refreshCallHistory();
  }, [refreshCallHistory]);

  const handleSaveDraftChange = useCallback((saveDraft: SaveCaseDraft | null) => {
    saveCaseDraftRef.current = saveDraft;
  }, []);

  const finishPendingNavigation = useCallback(() => {
    // A call can arrive while the save/discard dialog is open. Recheck before
    // clearing the dirty marker or closing the document's phone connection.
    const options = pendingNavigationOptionsRef.current;
    if (options.beforeNavigate?.() === false) {
      setLeaveDialogSaving(false);
      setLeaveAfterSave(false);
      setLeaveDialogError("Aplikáciu môžeš obnoviť po skončení hovoru alebo pripájania. Rozpracované údaje zostávajú otvorené.");
      return;
    }
    const navigate = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    pendingNavigationOptionsRef.current = {};
    setLeaveDialogOpen(false);
    setLeaveDialogSaving(false);
    setLeaveDialogError(null);
    setLeaveAfterSave(false);
    leaveObservedSavingRef.current = false;
    if (options.documentNavigation) {
      // Preserve the dirty state if a browser or another unload listener stops
      // navigation. The document will disappear on a successful reload.
      if (navigate) navigateAfterDraftApproval(navigate);
    } else {
      setHasUnsavedChanges(false);
      setIsCaseSaveLocked(false);
      navigate?.();
    }
  }, []);

  const requestNavigation = useCallback((navigate: () => void, options: NavigationOptions = {}) => {
    if (options.beforeNavigate?.() === false) return false;
    if (!hasUnsavedChanges && !isCaseSaveLocked && !drafts.dirty && !drafts.saving) {
      if (options.documentNavigation) navigateAfterDraftApproval(navigate);
      else navigate();
      return true;
    }

    pendingNavigationRef.current = navigate;
    pendingNavigationOptionsRef.current = options;
    setLeaveDialogError(null);
    setLeaveDialogOpen(true);
    return false;
  }, [hasUnsavedChanges, isCaseSaveLocked, drafts.dirty, drafts.saving]);

  const cancelPendingNavigation = useCallback(() => {
    pendingNavigationRef.current = null;
    pendingNavigationOptionsRef.current = {};
    setLeaveDialogOpen(false);
    setLeaveDialogError(null);
    setLeaveAfterSave(false);
    leaveObservedSavingRef.current = false;
  }, []);

  function requestAppRefresh() {
    requestNavigation(() => window.location.reload(), {
      beforeNavigate: () => !appRefreshBlockedRef.current,
      documentNavigation: true,
    });
  }

  function discardAndLeave() {
    if (isCaseSaveLocked || caseSavingRef.current || leaveDialogSaving || !drafts.discard()) return;
    if (caseDirtyRef.current) {
      // The case stays mounted across views. Explicit discard resets that
      // editor and cancels its pending autosave before the next view opens.
      setCaseEditorRevision(revision => revision + 1);
      caseDirtyRef.current = false;
      saveCaseDraftRef.current = null;
    }
    finishPendingNavigation();
  }

  async function saveAndLeave() {
    if (leaveDialogSaving) return;

    if (isCaseSaveLocked) {
      setLeaveAfterSave(true);
      setLeaveDialogError(null);
      return;
    }

    setLeaveDialogSaving(true);
    const failedEditor = await drafts.save();
    if (failedEditor) {
      setLeaveDialogSaving(false);
      setLeaveDialogError(`${failedEditor}: uloženie sa nepodarilo. Rozpracovaný obsah zostáva otvorený.`);
      return;
    }
    if (caseSavingRef.current) {
      setLeaveDialogSaving(false);
      setLeaveAfterSave(true);
      return;
    }
    if (!caseDirtyRef.current) { finishPendingNavigation(); return; }
    const saveDraft = saveCaseDraftRef.current;
    if (!saveDraft) {
      setLeaveDialogSaving(false);
      setLeaveDialogError("Karta ešte nie je pripravená na uloženie. Skúste to znova.");
      return;
    }

    setLeaveDialogSaving(true);
    setLeaveDialogError(null);
    const saved = await saveDraft();
    setLeaveDialogSaving(false);

    if (saved) {
      const pendingEditor = drafts.pendingLabel();
      if (pendingEditor) { setLeaveDialogError(`${pendingEditor}: pribudli neuložené zmeny. Uložte ich pred odchodom.`); return; }
      finishPendingNavigation();
      return;
    }

    setLeaveDialogError("Rozpracovaný prípad sa nepodarilo uložiť. Údaje zostali vo formulári.");
  }

  function selectCase(caseId: string) {
    return requestNavigation(() => {
      setCenterView("map");
      setToolsOpen(false);
      setActiveCaseId(caseId);
      setMobilePane("workspace");
      setFocusedTaskId(undefined);
      setWorkspace({ kind: "cockpit", mode: window.matchMedia("(max-width: 1023px)").matches ? "expanded" : "split" });
    });
  }

  function openCase(caseId: string) {
    requestNavigation(() => {
      setCenterView("map");
      setToolsOpen(false);
      const caseItem = dispatchCases.find((item) => item.id === caseId);
      const active = caseItem && isActiveDispatchCase(caseItem);
      setActiveCaseId(caseId);
      setMobilePane("workspace");
      setFocusedTaskId(undefined);
      setWorkspace({ kind: active ? "cockpit" : "detail", mode: !active || window.matchMedia("(max-width: 1023px)").matches ? "expanded" : "split" });
      setActiveView("dispatch");
    });
  }

  function openCaseDetail(caseId: string) {
    requestNavigation(() => {
      setCenterView("map");
      setToolsOpen(false);
      setActiveCaseId(caseId);
      setMobilePane("workspace");
      setFocusedTaskId(undefined);
      returnViewRef.current = activeView;
      setActiveView("dispatch");
      setWorkspace({ kind: "detail", mode: "expanded" });
    });
  }

  function openTask(taskId: string, caseId: string, fromPush = false) {
    if (capabilities.tasks) {
      requestNavigation(() => {
        // TaskProvider authorizes this exact ID, including a task with no case.
        acknowledgeTaskNotifications(taskId);
        setFocusedTaskId(taskId);
        setTaskOpenVersion(version => version + 1);
        switchView("tasks");
        if (fromPush) {
          const url = new URL(window.location.href); url.searchParams.delete("task");
          window.history.replaceState(window.history.state, "", url);
        }
      });
      return;
    }
    const needsDocument = !dispatchCases.some((item) => item.id === caseId && item.tasks.some((task) => task.id === taskId));
    requestNavigation(() => {
      if (needsDocument) {
        window.location.assign(`/?task=${encodeURIComponent(taskId)}`);
        return;
      }
      acknowledgeTaskNotifications(taskId);
      returnViewRef.current = fromPush ? "tasks" : activeView;
      if (fromPush) {
        const url = new URL(window.location.href);
        url.searchParams.delete("task");
        window.history.replaceState(window.history.state, "", url);
      }
      setActiveCaseId(caseId);
      setMobilePane("workspace");
      setActiveView("dispatch");
      setFocusedTaskId(taskId);
      setCenterView("map");
      setToolsOpen(false);
      setWorkspace({ kind: "detail", mode: "expanded" });
    }, { documentNavigation: needsDocument });
  }

  const handleInitialPushOpen = useEffectEvent((rawUrl: string) => {
    const target = notificationTarget(rawUrl, window.location.origin);
    if (!target || target.kind === "settings") return;
    if (target.kind === "call") { openCallNotification(target.id); return; }
    const taskId = target.id;
    if (taskId && capabilities.tasks) { openTask(taskId, "", true); return; }
    const caseItem = taskId && dispatchCases.find((item) => item.tasks.some((task) => task.id === taskId));
    if (taskId && caseItem) openTask(taskId, caseItem.id, true);
    else {
      switchView("tasks");
      setMutationNotice("Úloha už nie je dostupná. Skontroluj zoznam úloh.");
    }
  });

  const handlePushOpen = useEffectEvent((rawUrl: unknown) => {
    const target = notificationTarget(rawUrl, window.location.origin);
    if (!target) return;
    if (target.kind === "call") { openCallNotification(target.id); return; }
    const taskId = target.kind === "task" ? target.id : null;
    if (taskId && capabilities.tasks) { openTask(taskId, "", true); return; }
    const caseItem = taskId && dispatchCases.find((item) => item.tasks.some((task) => task.id === taskId));
    if (taskId && caseItem) openTask(taskId, caseItem.id, true);
    else if (!taskId) switchView("settings");
    // A newly assigned task might not exist in this tab's older snapshot.
    // Reload only after the normal save/discard guard has protected the draft.
    else requestNavigation(() => window.location.assign(`/?task=${encodeURIComponent(taskId)}`), { documentNavigation: true });
  });

  function openCallNotification(sessionId: string) {
    requestNavigation(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("call");
      url.searchParams.delete("task");
      window.history.replaceState(window.history.state, "", url);
      setFocusedTaskId(undefined);
      setWorkspace({ kind: "cockpit", mode: "split" });
      setCallNotificationFocus({ sessionId, snapshotAtOpen: telephony.phoneBar.checkedAt });
      setActiveView("call-center");
      telephony.refresh();
    });
  }

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const receive = createNotificationNavigationReceiver({
      origin: window.location.origin,
      sessionKey: actorKey,
      currentSessionKey: () => currentSessionKeyRef.current,
      open: handlePushOpen,
      acknowledge: requestId => navigator.serviceWorker.controller?.postMessage({ type: "PM_NOTIFICATION_ACK", requestId }),
    });
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "PM_CLIENT_CONTEXT") { event.ports[0]?.postMessage({ mobileApp: isMobileApp() }); return; }
      receive(event.data, event.ports[0]);
    };
    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleMessage);
  }, [actorKey]);

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

  const resumePendingEditorSave = useEffectEvent(() => { void saveAndLeave(); });

  useEffect(() => {
    if (!leaveAfterSave) {
      leaveObservedSavingRef.current = false;
      return;
    }

    if (isCaseSaveLocked) {
      leaveObservedSavingRef.current = true;
      return;
    }

    // Autosave has settled. Finishing (or abandoning) the pending navigation
    // updates state, so it runs from a scheduled callback rather than
    // synchronously inside the effect body.
    const timer = window.setTimeout(() => {
      if (!hasUnsavedChanges) {
        setLeaveAfterSave(false);
        resumePendingEditorSave();
        return;
      }

      if (leaveObservedSavingRef.current) {
        leaveObservedSavingRef.current = false;
        setLeaveAfterSave(false);
        setLeaveDialogError("Automatické uloženie sa nepodarilo dokončiť. Údaje zostali vo formulári; môžete skúsiť uloženie znova alebo zostať v editácii.");
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [finishPendingNavigation, hasUnsavedChanges, isCaseSaveLocked, leaveAfterSave, drafts.dirty, drafts.saving]);

  const syncDueNotifications = useCallback(
    async (silent = true) => {
      if (source !== "supabase" || notificationSyncInFlight.current) {
        if (source === "supabase" && notificationSyncInFlight.current) notificationSyncAgain.current = true;
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
        if (notificationSyncAgain.current) {
          notificationSyncAgain.current = false;
          window.setTimeout(() => void syncDueNotifications(true), 0);
        }
      }
    },
    [source],
  );

  useEffect(() => {
    if (source !== "supabase") {
      return;
    }

    // The first sync is scheduled rather than awaited inline: it flips the
    // syncing flag, and state writes belong in callbacks, not effect bodies.
    const initial = window.setTimeout(() => {
      void syncDueNotifications(true);
    }, 0);
    const interval = window.setInterval(() => {
      void syncDueNotifications(true);
    }, 60_000);

    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [source, syncDueNotifications]);

  // Customer locations, their notifications and colleagues' task changes: the
  // case snapshot is otherwise only reloaded by this tab's own actions.
  const pollLiveUpdates = useCallback(async () => {
    if (source !== "supabase" || locationUpdatePollInFlight.current) return;
    locationUpdatePollInFlight.current = true;

    try {
      const params = new URLSearchParams({ since: locationUpdateCursorRef.current });
      const response = await fetch(`/api/cases/location-updates?${params.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.timeout(8_000),
      });
      const result = (await response.json().catch(() => null)) as LiveUpdatesResponse | null;

      if (!response.ok || !result?.checkedAt) {
        throw new Error(result?.error ?? "Nové polohy klientov sa nepodarilo obnoviť.");
      }

      locationUpdateCursorRef.current = result.checkedAt;
      if (hasLiveUpdates(result)) {
        setDispatchData((current) => mergeLiveUpdates(current, result));
      }
    } catch (error) {
      console.warn("Live update poll failed:", error);
    } finally {
      locationUpdatePollInFlight.current = false;
    }
  }, [source]);

  useEffect(() => {
    if (source !== "supabase") return;

    let stopped = false;
    let polling = false;
    let timer: number;
    const tick = async () => {
      window.clearTimeout(timer);
      if (stopped || polling) return;
      polling = true;
      try { if (document.visibilityState === "visible") await pollLiveUpdates(); } finally { polling = false; }
      if (!stopped) timer = window.setTimeout(tick, 10_000 + Math.random() * 1_000);
    };
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void tick(); };
    void tick();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("online", refreshWhenVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
    };
  }, [pollLiveUpdates, source]);

  useEffect(() => {
    const refreshNotificationClock = () => setNotificationNow(Date.now());
    const interval = window.setInterval(refreshNotificationClock, 15_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshNotificationClock();
    };

    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshNotificationClock);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshNotificationClock);
    };
  }, []);

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

  async function snoozeNotificationFromPanel(notificationId: string, snoozedUntil: string) {
    if (markingNotificationId) {
      return false;
    }

    setMarkingNotificationId(notificationId);
    setMutationNotice(null);

    if (source === "mock") {
      setDispatchData((current) => applyMockNotificationSnooze(current, notificationId, snoozedUntil));
      setMutationNotice(`Pripomenutie nastavené na ${formatNotificationReminderTime(snoozedUntil)}. Mock dáta boli upravené iba lokálne.`);
      setMarkingNotificationId(null);
      return true;
    }

    try {
      const response = await fetch(`/api/notifications/${encodeURIComponent(notificationId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snoozedUntil }),
      });
      const result = (await response.json()) as { notifications?: DispatchData["notifications"]; error?: string };

      if (!response.ok || !result.notifications) {
        throw new Error(result.error ?? "Pripomenutie sa nepodarilo nastaviť.");
      }

      setDispatchData((current) => ({ ...current, notifications: result.notifications ?? current.notifications }));
      setMutationNotice(`Pripomenutie nastavené na ${formatNotificationReminderTime(snoozedUntil)}.`);
      return true;
    } catch (error) {
      setMutationNotice(error instanceof Error ? error.message : "Pripomenutie sa nepodarilo nastaviť.");
      return false;
    } finally {
      setMarkingNotificationId(null);
    }
  }

  async function changeCasePriority(caseId: string, priority: DispatchCase["priority"]) {
    if (caseId === activeCaseId && (hasUnsavedChanges || isCaseSaveLocked)) {
      setMutationNotice("Prioritu sa nepodarilo zmeniť v zozname: zmeňte ju v hlavičke otvoreného prípadu, kde sa uloží spolu s rozpracovanými údajmi.");
      return;
    }
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
        body: JSON.stringify({ priority, expectedUpdatedAt: dispatchCases.find(item => item.id === caseId)?.updatedAt }),
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
        body: JSON.stringify({ ...payload, ...(typeof payload.taskId === "string" ? { taskExpectedRevision: dispatchData.tasks?.find(task => task.id === payload.taskId)?.revision } : {}) }),
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
    // Local tabs replace only the map area. The case and side panels stay in place.
    setCenterView(view);
    setToolsOpen(false);
    setWidgetSettingsOpen(false);
    setActiveView("dispatch");
    setMobilePane("workspace");
    setWorkspace(current => ({ ...current, mode: window.matchMedia("(max-width: 1023px)").matches ? "collapsed" : current.mode === "expanded" ? "split" : current.mode }));
  }

  function openTools() {
    toolsReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setToolsOpen(true);
    setWidgetSettingsOpen(true);
    setActiveView("dispatch");
    setVisitedWidgets(current => new Set([...current, ...workspacePreferences.widgets.filter(item => item.visible).map(item => item.id)]));
    updateWorkspacePreferences({ ...workspacePreferences, rightCollapsed: false });
  }

  function closeTools() {
    setToolsOpen(false);
    setWidgetSettingsOpen(false);
    updateWorkspacePreferences({ ...workspacePreferences, rightCollapsed: true });
    window.requestAnimationFrame(() => {
      const trigger = toolsReturnFocusRef.current;
      if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
    });
  }

  function toggleTools() {
    if (toolsOpen) closeTools();
    else openTools();
  }

  function switchView(view: View) {
    if (view === "tools") { toggleTools(); return; }
    const navigate = () => {
      setToolsOpen(false);
      setWidgetSettingsOpen(false);
      setActiveView(view);
      if (view === "dispatch") setMobilePane("workspace");
    };
    // These pages share mounted case editors and the same task/notebook stores.
    // A page change therefore preserves drafts without requiring a save/discard.
    if (["dispatch", "tasks", "notes"].includes(view) && ["dispatch", "tasks", "notes"].includes(activeView)) navigate();
    else requestNavigation(navigate);
  }

  function showMobileMap() {
    setToolsOpen(false);
    setActiveView("dispatch");
    setMobilePane("workspace");
    setCenterView("map");
    setFocusedTaskId(undefined);
    setWorkspace(current => ({ ...current, mode: "collapsed" }));
  }

  function restoreMobileCase() {
    setToolsOpen(false);
    setCenterView("map");
    setActiveView("dispatch");
    setMobilePane("workspace");
    setWorkspace(current => ({ ...current, mode: "expanded" }));
  }

  function showMobileCases() {
    setToolsOpen(false);
    requestNavigation(() => {
      setActiveView("dispatch");
      setMobilePane("cases");
      setFocusedTaskId(undefined);
      setWorkspace({ kind: "cockpit", mode: "split" });
    });
  }

  async function signOut() {
    if (isSigningOut) return;

    setIsSigningOut(true);
    setMutationNotice(null);

    currentSessionKeyRef.current = null;
    try {
      await signOutCurrentSession();
    } catch {
      currentSessionKeyRef.current = actorKey;
      setIsSigningOut(false);
      setMutationNotice("Odhlásenie sa nepodarilo. Skontroluj pripojenie a skús to znova.");
    }
  }

  function requestSignOut() {
    if (isSigningOut) return;
    requestNavigation(() => void signOut());
  }

  function startNewCase(call?: DispatchCall) {
    requestNavigation(() => startNewCaseNow(call));
  }

  function startNewCaseNow(call?: DispatchCall) {
    setMobilePane("workspace");
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

  async function persistCallCaseLink(callId: string, caseId: string) {
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
    telephony.refresh();
  }

  async function linkCreatedCaseToCall(callId: string, caseId: string) {
    try {
      await persistCallCaseLink(callId, caseId);
      setMutationNotice("Nový prípad je uložený a hovor je priradený k timeline.");
    } catch (error) {
      setMutationNotice(error instanceof Error ? `Prípad je uložený, ale hovor sa nepriradil: ${error.message}` : "Prípad je uložený, ale hovor sa nepriradil.");
    }
  }

  /** Click-to-call from the dashboard phone, a case card or the call log. */
  async function dialNumber(phone: string, caseId?: string): Promise<void> {
    if (!telephonyConfigured || !phone) {
      setMutationNotice(TELEPHONY_NOT_CONFIGURED_MESSAGE);
      throw new TelephonyNotConfiguredError();
    }

    const target = await requestCallbackTargetConfirmation(phone);
    if (!target) return;
    await telephony.dial(phone, caseId, { callbackTargetVerificationId: target.verificationId });
    setMutationNotice(`Volanie na ${target.dialNumber} bolo spustené.`);
  }

  /** "Môj telefón" test call: a normal outbound dial from a chosen line. */
  async function testCall(input: { to: string; lineId: string | null }): Promise<void> {
    if (!telephonyConfigured) {
      setMutationNotice(TELEPHONY_NOT_CONFIGURED_MESSAGE);
      throw new TelephonyNotConfiguredError();
    }
    const target = await requestCallbackTargetConfirmation(input.to);
    if (!target) return;
    await telephony.dial(input.to, undefined, { lineId: input.lineId, callbackTargetVerificationId: target.verificationId });
    setMutationNotice(`Skúšobný hovor na ${target.dialNumber} bol spustený.`);
  }

  /** Links a live or logged call to the case the console currently shows. */
  async function linkPhoneCallToCase(call: PhoneBarCall, requestedCaseId?: string): Promise<boolean> {
    const caseId = requestedCaseId ?? call.caseId ?? workspaceCase?.id;
    if (!call.callId) {
      setMutationNotice("Hovor sa dá priradiť až po tom, čo je zapísaný v call logu.");
      return false;
    }
    if (!caseId) {
      setMutationNotice("Najprv otvorte prípad, ku ktorému sa má hovor priradiť.");
      return false;
    }
    try {
      await persistCallCaseLink(call.callId, caseId);
      setMutationNotice("Hovor je ručne priradený k prípadu a zapísaný v timeline.");
      return true;
    } catch (error) {
      setMutationNotice(error instanceof Error ? error.message : "Hovor sa nepodarilo priradiť k prípadu.");
      return false;
    }
  }

  function startNewCaseFromPhoneBar(call: PhoneBarCall) {
    // The live row is normally already in the merged list; the fallback keeps a
    // brand-new session from prefilling the card with the placeholder call.
    const logged = visibleCallCenterCalls.find((row) => row.providerSessionId === call.sessionId);
    startNewCaseFromCall(logged ?? {
      id: call.callId ?? call.sessionId,
      providerSessionId: call.sessionId,
      status: call.answered ? "answered" : "incoming",
      direction: call.direction,
      callerNumber: call.direction === "inbound" ? call.number : "",
      calledNumber: call.direction === "inbound" ? "" : call.number,
      ...(call.callerName ? { callerName: call.callerName } : {}),
      ...(call.caseId ? { caseId: call.caseId } : {}),
      lineLabel: call.lineLabel,
      startedAt: call.timerSince,
      waitSeconds: 0,
      recordingStatus: "not_requested",
      transcriptStatus: "not_requested",
      history: [],
    });
  }

  function runPhoneCallAction(action: PhoneCallAction, sessionId: string, target?: { profileId?: string; number?: string }) {
    void telephony.callAction(action, sessionId, target);
  }

  function handleSendCaseSms(template: "location_request" | "eta_update") {
    if (workspace.kind === "new" || !selectedCase) {
      setMutationNotice("Najprv výslovne vyberte a uložte prípad.");
      return;
    }
    setCaseSmsComposer({ id: selectedCase.id, caseNumber: selectedCase.caseNumber, template, open: true });
  }

  async function handleAssignAsset(assetId: string) {
    if (isAssigning) {
      return;
    }
    if (!activeCase || !isActiveDispatchCase(activeCase)) {
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
      setMobilePane("cases");
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

  const keepWorkspaceVisibleOnMobile = useEffectEvent(() => {
    // Preserve the selected local tool when the desktop split no longer fits.
    // The map view keeps the case visible; its mounted editor retains all drafts.
    if (activeView === "dispatch" && workspace.kind === "cockpit" && workspace.mode === "split"
      && (mobilePane === "workspace" || hasUnsavedChanges || isCaseSaveLocked)) {
      setMobilePane("workspace");
      setWorkspace({ kind: "cockpit", mode: centerView === "map" ? "expanded" : "collapsed" });
    }
  });

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 1023px)");
    function onBreakpointChange(event: MediaQueryListEvent) {
      if (event.matches) keepWorkspaceVisibleOnMobile();
    }
    mobile.addEventListener("change", onBreakpointChange);
    return () => mobile.removeEventListener("change", onBreakpointChange);
  }, []);

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

      if (centerView !== "map" && !caseDirectoryDetailOpen) return;

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
  }, [activeView, cancelPendingNavigation, centerView, leaveDialogOpen, requestNavigation, workspace]);

  function renderTasks(variant: "page" | "sidebar") {
    return <TaskPanel
                taskWorkspaceEnabled={capabilities.tasks}
                tasks={dispatchData.tasks}
                onOpenCase={openCase}
                activeTaskId={focusedTaskId}
                cases={dispatchCases}
                isNotificationSyncing={isNotificationSyncing}
                lastNotificationSyncAt={lastNotificationSyncAt}
                markingNotificationId={markingNotificationId}
                notificationNow={notificationNow}
                notificationViewerProfileId={notificationViewerProfileId}
                notifications={notifications}
                onCreateTask={createTaskFromPanel}
                onDeleteTask={deleteTaskFromPanel}
                onMarkNotificationRead={(notificationId) => void markNotificationRead(notificationId)}
                onOpenTask={openTask}
                onRefreshNotifications={() => void syncDueNotifications(false)}
                onSnoozeNotification={snoozeNotificationFromPanel}
                onUpdateTask={updateTaskFromPanel}
                onUpdateNotificationStatus={updateNotificationStatusFromPanel}
                operators={effectiveOperators}
                notificationSyncEnabled={source === "supabase"}
                viewerProfileId={viewerProfileId}
                variant={variant}
              />;
  }
  function renderWidget(id: WidgetId, visible: boolean) {
    if (!visitedWidgets.has(id)) return null;
    if (id === "phone") return <DashboardPhone onCreateCase={() => startNewCase()} caseContext={dashboardSmsCaseContext} isDialing={telephony.outboundPending} onDataChange={setDispatchData} onDial={(phone) => dialNumber(phone, dashboardSmsCaseContext?.id)} variant="rail" />;
    if (id === "tasks") return centerView === "tasks" && !toolsOpen ? <button type="button" className="min-h-11 p-3 text-sm" onClick={() => switchCenterView("tasks")}>{taskAttentionCount} úloh na pozornosť · otvorené v strede</button> : <div data-testid="dashboard-task-panel-shell">{renderTasks("sidebar")}</div>;
    if (id === "notes") return <><NotebookPanel active={visible && (centerView !== "notes" || toolsOpen)} compact /><button type="button" className="min-h-11 px-3 text-sm underline" onClick={() => switchCenterView("notes")}>Otvoriť poznámky v strede</button></>;
    if (id === "calculator") return <CalculatorWidget />;
    if (id === "route") return <RoutePlanner embedded active={visible} />;
    if (id === "search") return <WorkspaceSearchWidget cases={dispatchCases} contacts={partnerDirectory} fleet={fleetAssets} onOpenCase={openCase} onOpenFleet={() => switchView("fleet")} onDial={telephonyConfigured ? dialNumber : undefined} places={<WorkspacePlaceSearch active={visible} />} />;
    return <div className="space-y-2 p-3">{fleetAssets.slice(0, 12).map(asset => <div key={asset.id} className="rounded-lg border border-zinc-200 p-2 text-sm"><p className="font-medium">{asset.licensePlate} · {asset.label}</p><p>{fleetWidgetStatus(asset)}</p><p className="text-xs text-zinc-500">{asset.positionKnown === false || !asset.gps ? "GPS neoverené" : asset.gps.stale ? "GPS neaktuálne" : "GPS aktuálne"}</p></div>)}<button type="button" className="min-h-11 text-sm underline" onClick={() => switchView("fleet")}>Otvoriť celú flotilu ({fleetAssets.length})</button></div>;
  }

  return (
    <NotebookProvider actorKey={actorKey} viewerProfileId={viewerProfileId} enabled={capabilities.notes} onEditorStateChange={handleNotebookEditor}>
    <TaskWorkspaceProvider actorKey={actorKey} enabled={capabilities.tasks} initialTasks={dispatchData.tasks} viewerProfileId={viewerProfileId} onEditorStateChange={handleTaskEditor} onTasksChange={handleWorkspaceTasks}>
    <TaskFocusBridge requestVersion={taskOpenVersion} taskId={focusedTaskId} enabled={capabilities.tasks} />
    <div
      className={`dispatch-app-shell isolate flex flex-col bg-zinc-100 text-zinc-950 ${
        activeView === "settings" || activeView === "reports"
          ? "min-h-dvh overflow-visible"
          : "h-svh overflow-hidden sm:h-auto sm:min-h-dvh sm:overflow-visible lg:h-dvh lg:min-h-[720px]"
      }`}
      data-hydrated="false"
      data-testid="dispatch-console"
      data-mobile-pane={mobilePane}
      data-active-view={activeView}
      ref={consoleRef}
    >
      {caseSmsComposer && <SmsComposerDialog caseId={caseSmsComposer.id} caseNumber={caseSmsComposer.caseNumber}
        initialTemplate={caseSmsComposer.template} open={caseSmsComposer.open} onClose={() => setCaseSmsComposer((current) => current ? { ...current, open: false } : null)}
        onCreateCase={() => startNewCase()} onSent={(result) => { if (result.dispatchData) setDispatchData(result.dispatchData); }} />}
      <div className="relative z-50 shrink-0" ref={topBarsRef}>
      <header className="dispatch-app-header flex min-h-14 items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-950 px-3 py-2 text-white sm:px-4 sm:py-0">
        <AccountMenu
          displayName={signedInName}
          email={viewerEmail}
          role={viewerRole}
          signingOut={isSigningOut}
          onSignOut={requestSignOut}
          onRefresh={requestAppRefresh}
          refreshBlocked={appRefreshBlocked}
          updateAvailable={updateAvailable}
        />
        <nav className="hidden min-w-0 flex-1 items-center justify-center gap-1 lg:flex" aria-label="Hlavná navigácia">
          <NavButton
            active={activeView === dashboardNavItem.view}
            label={dashboardNavItem.label}
            icon={dashboardNavItem.icon}
            badgeCount={dashboardNavItem.badgeCount}
            onClick={() => switchView(dashboardNavItem.view)}
          />
          <div className="hidden items-center gap-1 xl:flex" aria-label="Pripnuté obrazovky">
            {pinnedNavItems.map((item) => (
              <NavButton
                key={item.view}
                active={activeView === item.view}
                label={item.label}
                icon={item.icon}
                badgeCount={item.badgeCount}
                onClick={() => switchView(item.view)}
                responsiveShortcut
              />
            ))}
          </div>
          <NavigationMenu
            activeView={activeView}
            badgeCount={secondaryBadgeCount}
            items={secondaryNavItems}
            pinNotice={navigationPinNotice}
            pinnedViews={pinnedNavigationViews}
            onSelect={switchView}
            onTogglePin={toggleNavigationPin}
            variant="header"
          />
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          {telephonyConfigured ? (
            <HeaderPhoneStatusMenu
              busy={telephony.presenceBusy}
              onChange={telephony.changePresence}
              onRequestPause={() => {
                telephony.refreshPauseReasons();
                setPauseRoutingOpen(true);
              }}
              onDismissNotice={telephony.dismissNotice}
              onTakeover={telephony.takeoverPhone}
              notice={telephony.notice}
              phone={telephony.phone}
              status={telephony.phoneBar.ownPresenceStatus}
              pausePlan={ownPausePlan}
              readiness={telephony.readiness}
              onPreparePhone={telephony.preparePhone}
              outboundPending={telephony.outboundPending}
            />
          ) : (
            <div className="hidden lg:block">
              <TelephonyNotConfiguredPill />
            </div>
          )}
          <HeaderNotificationMenu
            cases={dispatchCases}
            notifications={viewerNotifications}
            now={notificationNow}
            onMarkRead={(notificationId) => void markNotificationRead(notificationId)}
            onArchive={(notificationId) => void updateNotificationStatusFromPanel(notificationId, "archived")}
            onOpenCase={openCase}
            onOpenTask={openTask}
            onSnooze={snoozeNotificationFromPanel}
          />
          {telephonyConfigured && telephony.stale ? (
            <div className="hidden xl:block">
              <TelephonyStalePill />
            </div>
          ) : null}
          {telephonyConfigured ? (
            <div>
              <HeaderLiveCallsMenu
                model={telephony.phoneBar}
                presences={operatorPresences}
                canManageCalls={viewerCanSupervise}
                busyAction={telephony.busyAction}
                phone={telephony.phone}
                stale={telephony.stale}
                onAnswer={telephony.answer}
                onRejectOffer={telephony.hangupBrowser}
                onCallAction={(action, sessionId) => void runPhoneCallAction(action, sessionId)}
                onSupervise={(sessionId, mode) => void telephony.supervise(sessionId, mode)}
                onStopSupervise={(sessionId) => void telephony.stopSupervise(sessionId)}
                onMakeAvailable={() => void telephony.changePresence({ status: "available" })}
              />
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => startNewCase()}
            className="hidden h-9 shrink-0 items-center gap-2 rounded-md bg-[#FCD703] px-3 text-sm font-semibold text-zinc-950 shadow-sm transition hover:bg-yellow-300 disabled:cursor-wait disabled:bg-zinc-700 disabled:text-zinc-400 md:inline-flex"
          >
            <Plus size={16} />
            Nový prípad
          </button>
        </div>
      </header>

      {updateAvailable && (
        <div role="status" data-testid="app-update-notice" className="flex items-center justify-between gap-2 border-b border-yellow-200 bg-yellow-50 px-3 text-xs text-zinc-800 sm:px-4">
          <span className="py-1.5">
            {appRefreshBlocked
              ? "Nová verzia je pripravená. Obnov ju po skončení hovoru alebo pripájania."
              : "Nová verzia je pripravená."}
          </span>
          <button type="button" aria-label="Obnoviť aplikáciu" onClick={requestAppRefresh} disabled={appRefreshBlocked} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 font-semibold hover:bg-yellow-100 disabled:cursor-not-allowed disabled:opacity-50">
            <RefreshCw size={14} aria-hidden="true" /> Obnoviť
          </button>
        </div>
      )}

      {telephonyConfigured && <CallMonitorInvitations key={actorKey} sessionId={telephony.phoneBar.active?.sessionId ?? null}
        listeningSessionId={telephony.phoneBar.supervising?.sessionId ?? null}
        onStop={sessionId => void telephony.stopSupervise(sessionId)} onAccept={telephony.acceptMonitorInvitation} />}

      <div className={activeView === "tasks" ? "hidden" : "mobile-workspace-heading flex min-h-16 items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-2.5 lg:hidden"}>
        <div className="flex min-w-0 items-center gap-2">
          {(activeView === "dispatch" && mobilePane === "workspace") || (activeView === "cases" && workspace.kind === "detail") ? (
            <button type="button" onClick={() => activeView === "cases" ? returnToCockpit() : showMobileCases()} aria-label="Späť na prípady" className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white">
              <ArrowLeft size={20} aria-hidden="true" />
            </button>
          ) : null}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold tracking-tight">
              {activeView === "dispatch" ? toolsOpen ? "Nástroje" : mobilePane === "workspace" && centerView !== "map" ? ({ table: "Tabuľka prípadov", tasks: "Úlohy", notes: "Poznámky" })[centerView] : mobilePane === "cases" ? "Prípady" : workspace.kind === "new" ? "Nový prípad" : workspace.kind === "detail" || workspace.mode === "expanded" ? workspaceCase?.caseNumber ?? "Detail prípadu" : "Mapa zásahov" : activeView === "cases" && workspace.kind === "detail" ? workspaceCase?.caseNumber ?? "Detail prípadu" : navItems.find((item) => item.view === activeView)?.label}
              {activeView === "dispatch" && mobilePane === "cases" ? <span className="ml-1.5 font-medium text-zinc-500">{activeCasesTotal}</span> : null}
            </h1>
          </div>
        </div>
        {activeView === "dispatch" && mobilePane === "cases" ? (
          <button type="button" onClick={() => startNewCase()} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl bg-[#FCD703] px-3 text-sm font-semibold text-zinc-950">
            <Plus size={18} aria-hidden="true" /> Nový prípad
          </button>
        ) : null}
        {(selectedCase || workspace.kind === "new") && !toolsOpen && (activeView === "dispatch" && mobilePane === "workspace" && centerView === "map" || activeView === "cases" && workspace.kind === "detail") ? (
          <button
            type="button"
            onClick={() => workspace.mode === "expanded" ? showMobileMap() : restoreMobileCase()}
            aria-label={workspace.mode === "expanded" ? "Zobraziť mapu na celú plochu" : "Skryť mapu a zobraziť prípad"}
            title={workspace.mode === "expanded" ? "Zobraziť mapu" : "Zobraziť prípad"}
            className="mobile-map-toggle flex size-11 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700"
          >
            {workspace.mode === "expanded" ? <Maximize2 size={17} aria-hidden="true" /> : <Minimize2 size={17} aria-hidden="true" />}
          </button>
        ) : null}
      </div>

      {(telephonyConfigured || Boolean(telephony.phone.call)) &&
        phoneBarVisible({
          status: telephony.phone.status,
          hasCall: Boolean(telephony.phoneBar.active || telephony.phone.call || telephony.outboundPending),
          hasOffer: telephony.phoneBar.offers.length > 0 || Boolean(telephony.phone.call?.ringing),
        }) && (
          <PhoneBar
            model={telephony.phoneBar}
            phone={telephony.phone}
            degradedSessionIds={telephony.degradedSessionIds}
            busyAction={telephony.busyAction}
            notice={telephony.notice}
            onDismissNotice={telephony.dismissNotice}
            onCallAction={runPhoneCallAction}
            onPartyAction={(action, sessionId, legId) => void telephony.partyAction(action, sessionId, legId)}
            canSupervise={viewerCanSupervise}
            onSupervise={(sessionId, mode) => void telephony.supervise(sessionId, mode)}
            onStopSupervise={(sessionId) => void telephony.stopSupervise(sessionId)}
            onAnswer={telephony.answer}
            onHangupBrowser={telephony.hangupBrowser}
            onToggleMute={telephony.toggleMute}
            onDtmf={telephony.sendDtmf}
            onNewCase={startNewCaseFromPhoneBar}
            onLinkCase={(call) => void linkPhoneCallToCase(call)}
            onOpenCase={openCase}
            onResumeAudio={telephony.resumeAudio}
            outboundPending={telephony.outboundPending}
          />
        )}

      {telephonyConfigured && !telephony.stale && !telephony.snapshot.ownPresence && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 sm:px-4">
          <span>Na prijímanie hovorov najprv nastavte svoju dostupnosť.</span>
          <button type="button" disabled={telephony.presenceBusy} onClick={() => void telephony.changePresence({ status: "available" })} className="min-h-10 rounded-md bg-zinc-950 px-3 font-semibold text-white disabled:opacity-50">{telephony.presenceBusy ? "Ukladám…" : "Som dostupný"}</button>
          {telephony.notice && <p role="alert" className="basis-full text-sm font-semibold">{telephony.notice}</p>}
        </div>
      )}

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
      )}

      <main
          ref={dashboardGridRef}
          data-console-hidden={activeView !== "dispatch"}
          data-left-collapsed={workspacePreferences.leftCollapsed}
          data-right-collapsed={workspacePreferences.rightCollapsed}
          data-tools-open={toolsOpen}
          inert={activeView !== "dispatch"}
          style={{
            "--dashboard-left-width": `${workspacePreferences.leftCollapsed ? 44 : dashboardColumns.left}px`,
            "--dashboard-right-width": `${workspacePreferences.rightCollapsed ? 44 : dashboardColumns.right}px`,
          } as CSSProperties}
          className="dispatch-dashboard relative z-0 isolate grid h-full min-h-0 min-w-0 flex-1 grid-cols-1 overflow-x-hidden overflow-y-auto lg:h-auto lg:grid-rows-[auto_minmax(0,1fr)] lg:overflow-hidden lg:grid-cols-[var(--dashboard-left-width)_minmax(0,1fr)] xl:grid-rows-[minmax(0,1fr)] xl:grid-cols-[var(--dashboard-left-width)_minmax(0,1fr)_var(--dashboard-right-width)]"
        >
          <button
            type="button"
            role="separator"
            aria-label="Zmeniť šírku stĺpca prípadov"
            aria-orientation="vertical"
            aria-valuemin={DASHBOARD_LEFT_MIN}
            aria-valuemax={DASHBOARD_LEFT_MAX}
            aria-valuenow={Math.round(dashboardColumns.left)}
            title="Potiahnutím zmeňte šírku stĺpca prípadov, dvojklik obnoví pôvodnú šírku"
            onDoubleClick={() => resetDashboardColumn("left")}
            onKeyDown={(event) => handleDashboardColumnKeyDown("left", event)}
            onPointerDown={(event) => beginDashboardColumnResize("left", event)}
            onPointerMove={moveDashboardColumnResize}
            onPointerUp={finishDashboardColumnResize}
            onPointerCancel={finishDashboardColumnResize}
            className="dashboard-resize-left group absolute bottom-0 left-[var(--dashboard-left-width)] top-0 z-30 hidden w-3 -translate-x-1/2 touch-none cursor-col-resize items-center justify-center outline-none lg:flex"
          >
            <span aria-hidden="true" className="h-14 w-1 rounded-full bg-zinc-300 shadow-sm transition group-hover:bg-yellow-400 group-focus-visible:bg-yellow-400" />
          </button>
          <button
            type="button"
            role="separator"
            aria-label="Zmeniť šírku stĺpca úloh a upozornení"
            aria-orientation="vertical"
            aria-valuemin={DASHBOARD_RIGHT_MIN}
            aria-valuemax={DASHBOARD_RIGHT_MAX}
            aria-valuenow={Math.round(dashboardColumns.right)}
            title="Potiahnutím zmeňte šírku stĺpca úloh, dvojklik obnoví pôvodnú šírku"
            onDoubleClick={() => resetDashboardColumn("right")}
            onKeyDown={(event) => handleDashboardColumnKeyDown("right", event)}
            onPointerDown={(event) => beginDashboardColumnResize("right", event)}
            onPointerMove={moveDashboardColumnResize}
            onPointerUp={finishDashboardColumnResize}
            onPointerCancel={finishDashboardColumnResize}
            className="dashboard-resize-right group absolute bottom-0 right-[var(--dashboard-right-width)] top-0 z-30 hidden w-3 translate-x-1/2 touch-none cursor-col-resize items-center justify-center outline-none xl:flex"
          >
            <span aria-hidden="true" className="h-14 w-1 rounded-full bg-zinc-300 shadow-sm transition group-hover:bg-yellow-400 group-focus-visible:bg-yellow-400" />
          </button>
          <div className="dashboard-tablet-phone hidden min-w-0 p-2 lg:col-span-2 lg:block xl:hidden">
            <DashboardPhone onCreateCase={() => startNewCase()} caseContext={dashboardSmsCaseContext} isDialing={telephony.outboundPending} onDataChange={setDispatchData} onDial={(phone) => dialNumber(phone, dashboardSmsCaseContext?.id)} />
          </div>
          {workspacePreferences.leftCollapsed && <button type="button" className="hidden min-h-11 items-center justify-center border-r border-zinc-200 bg-white lg:flex" aria-label="Obnoviť panel prípadov" onClick={() => updateWorkspacePreferences({ ...workspacePreferences, leftCollapsed: false })}><PanelLeftOpen size={20} /></button>}
          <div className="mobile-dispatch-cases lg:contents">
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
          </div>
          <div className="mobile-dispatch-workspace lg:contents">
          <MapWorkspace
            active={activeView === "dispatch" && !toolsOpen}
            actorKey={actorKey}
            onCenterViewChange={switchCenterView}
            onOpenTools={toggleTools}
            toolsOpen={toolsOpen}
            onToggleLeft={() => updateWorkspacePreferences({ ...workspacePreferences, leftCollapsed: !workspacePreferences.leftCollapsed })}
            centerContent={<><div hidden={centerView !== "tasks"} className="h-full overflow-y-auto">{renderTasks("page")}</div><div hidden={centerView !== "notes"} className="h-full overflow-y-auto"><NotebookPanel active={activeView === "dispatch" && centerView === "notes" && !toolsOpen} /></div></>}
            activeCaseId={visibleActiveCaseId}
            assets={fleetAssets}
            branches={branches}
            call={newCaseCall}
            caseItem={workspaceCase}
            callLinkCandidates={callLinkCandidates}
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
            onAssignAsset={(assetId) => void handleAssignAsset(assetId)}
            onBackToCockpit={returnToCockpit}
            onCaseCreated={handleCaseCreated}
            onCollapse={collapseWorkspace}
            onDataChange={setDispatchData}
            onCaseChange={(detail) => setDispatchData(current => mergeCaseDetail(current, detail))}
            onDial={telephonyConfigured ? dialNumber : undefined}
            onLinkCall={linkPhoneCallToCase}
            caseEditorRevision={caseEditorRevision}
            onDirtyChange={handleCaseDirtyChange}
            onSaveDraftChange={handleSaveDraftChange}
            onSavingChange={handleCaseSavingChange}
            onExpand={expandCockpit}
            onOpenDetail={openCaseDetail}
            onRestore={restoreCockpit}
            onSendEtaSms={() => void handleSendCaseSms("eta_update")}
            onSendLocationSms={() => void handleSendCaseSms("location_request")}
            onSortChange={setCaseSort}
          />
          </div>
          {workspacePreferences.rightCollapsed && <button type="button" className="hidden min-h-11 items-center justify-center border-l border-zinc-200 bg-white xl:flex" aria-label="Obnoviť panel nástrojov" onClick={openTools}><PanelRightOpen size={20} /></button>}
          <WidgetHost preferences={workspacePreferences} onChange={updateWorkspacePreferences} renderWidget={renderWidget} expanded={toolsOpen} settingsOpen={widgetSettingsOpen} onSettingsChange={setWidgetSettingsOpen} active={activeView === "dispatch" && (toolsOpen || !workspacePreferences.rightCollapsed)} onClose={closeTools} />

        </main>

      <main data-testid="standalone-tasks-page" className="dispatch-standalone-workspace" hidden={activeView !== "tasks"} inert={activeView !== "tasks"}>
        {renderTasks("page")}
      </main>
      <main data-testid="standalone-notes-page" className="dispatch-standalone-workspace" hidden={activeView !== "notes"} inert={activeView !== "notes"}>
        <NotebookPanel active={activeView === "notes"} />
      </main>

      {activeView === "call-center" && (
        <CallCenterModule
          notificationFocus={callNotificationFocus}
          notificationStateStale={telephony.stale}
          outboundPending={telephony.outboundPending}
          onDismissCallNotification={() => setCallNotificationFocus(null)}
          onReconnectPhone={telephony.takeoverPhone}
          activeSnapshot={telephonyConfigured ? telephony.phoneBar : undefined}
          busyCallAction={telephony.busyAction}
          calls={visibleCallCenterCalls}
          onCallAction={(action, sessionId) => void runPhoneCallAction(action, sessionId)}
          onAnswer={telephony.answer}
          onRejectOffer={telephony.hangupBrowser}
          canManageCalls={viewerCanSupervise}
          onSupervise={(sessionId, mode) => void telephony.supervise(sessionId, mode)}
          onStopSupervise={(sessionId) => void telephony.stopSupervise(sessionId)}
          phone={telephony.phone}
          telephonyConfigured={telephonyConfigured}
          cases={dispatchCases}
          currentOperatorId={viewerProfileId}
          dataSource={source}
          metrics={metrics}
          onDataChange={setDispatchData}
          onDial={dialNumber}
          operatorPresences={operatorPresences}
          operators={effectiveOperators}
          onNewCase={startNewCaseFromCall}
          onNewCaseFromLiveCall={startNewCaseFromPhoneBar}
          onOpenCase={openCase}
          onAvailabilityAction={onQueueAvailabilityAction}
          onCallbackCall={telephony.callBackRequest}
          onTelephonyChanged={handleTelephonyChanged}
        />
      )}

      {activeView === "attendance" && (attendanceLoaded ? <AttendanceModule attendance={attendance} operators={effectiveOperators} onDataChange={setDispatchData} /> : <p role="status">{attendanceError ?? "Načítavam dochádzku…"}</p>)}
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
          integrations={dispatchData.integrations}
          webdispecinkVehicles={dispatchData.fleetProviderVehicles}
          onRefresh={fleetRefresh.refresh}
          refreshing={fleetRefresh.refreshing}
          refreshMessage={fleetRefresh.refreshMessage}
          onDataChange={(incoming) => setDispatchData((current) => mergeFleetData(current, incoming))}
        />
      )}
      {activeView === "settings" && (
        <IntegrationSettings
          branches={branches}
          partnerDirectory={partnerDirectory}
          users={users}
          onDataChange={setDispatchData}
          onTestCall={telephonyConfigured ? testCall : undefined}
          onDial={telephonyConfigured ? (phone) => dialNumber(phone) : undefined}
          viewerRole={viewerRole}
          pushEnabled={source === "supabase"}
        />
      )}

      <PushNotificationSync profileId={source === "supabase" ? notificationViewerProfileId : undefined} />
      <PauseEndingNotificationSync
        enabled={source === "supabase" && telephonyConfigured}
        pauseReasonId={telephony.snapshot.ownPresence?.pauseReasonId}
        status={telephony.snapshot.ownPresence?.status}
        statusSince={telephony.snapshot.ownPresence?.statusSince}
        onDelivered={() => void syncDueNotifications(true)}
      />
      <NotificationToastStack
        notifications={viewerNotifications}
        now={notificationNow}
        onMarkRead={(notificationId) => void markNotificationRead(notificationId)}
        onOpenCase={openCase}
        onOpenTask={openTask}
        onSnooze={snoozeNotificationFromPanel}
      />

      <PauseRoutingDialog
        open={pauseRoutingOpen}
        profileId={viewerProfileId}
        operators={effectiveOperators}
        presences={operatorPresences}
        pauseReasons={telephony.pauseReasons}
        busy={telephony.presenceBusy}
        onClose={() => setPauseRoutingOpen(false)}
        onActivate={({ pauseReasonId }) => telephony.changePresence({ status: "paused", pauseReasonId })}
      />

      <nav className="dispatch-mobile-nav z-[2147483000] border-t border-zinc-200 bg-white/95 px-2 shadow-[0_-4px_20px_rgba(24,24,27,0.06)] backdrop-blur lg:hidden" aria-label="Mobilná navigácia">
        <div
          className="mx-auto grid max-w-xl gap-1"
          style={{ gridTemplateColumns: `repeat(${visibleMobileShortcutItems.length + 1}, minmax(0, 1fr))` }}
        >
          {visibleMobileShortcutItems.map((item) => (
            <MobileTabButton
              key={item.shortcut}
              active={item.active}
              badgeCount={item.badgeCount}
              icon={item.icon}
              label={item.label}
              shortLabel={item.shortLabel}
              onClick={item.onSelect}
            />
          ))}
          <NavigationMenu
            activeView={activeView}
            items={secondaryNavItems}
            badgeCount={0}
            mobileShortcutItems={mobileShortcutItems}
            mobileShortcuts={mobileNavigationShortcuts}
            pinNotice={mobileNavigationNotice}
            pinnedViews={pinnedNavigationViews}
            onSelect={switchView}
            onToggleMobileShortcut={toggleMobileShortcut}
            onTogglePin={toggleNavigationPin}
            variant="mobile"
          />
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
    </div>
    </TaskWorkspaceProvider>
    </NotebookProvider>
  );
}

const accountRoleLabels: Record<AppRole, string> = {
  admin: "Administrátor",
  dispatcher: "Dispečer",
  manager: "Manažér",
  senior_dispatcher: "Senior dispečer",
};

function TaskFocusBridge({ taskId, enabled, requestVersion }: { taskId?: string; enabled: boolean; requestVersion: number }) {
  const { store } = useTaskWorkspace();
  useEffect(() => { if (enabled && taskId) void store.open(taskId); }, [enabled, store, taskId, requestVersion]);
  return null;
}

function AccountMenu({
  displayName,
  email,
  onSignOut,
  onRefresh,
  refreshBlocked,
  updateAvailable,
  role,
  signingOut,
}: {
  displayName: string;
  email?: string;
  onSignOut: () => void;
  onRefresh: () => void;
  refreshBlocked: boolean;
  updateAvailable: boolean;
  role?: AppRole;
  signingOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function handleSignOut() {
    setOpen(false);
    onSignOut();
  }

  return (
    <div ref={rootRef} className="relative min-w-0 shrink">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Účet ${displayName}`}
        title="Účet a odhlásenie"
        onClick={() => setOpen((current) => !current)}
        disabled={signingOut}
        className="dispatch-account-trigger group flex h-10 min-w-0 items-center gap-2 rounded-lg px-1.5 text-left transition hover:bg-white/10 disabled:cursor-wait sm:gap-2.5"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#FCD703] text-sm font-black text-zinc-950">PM</span>
        <span
          data-testid="signed-in-user-name"
          className="min-w-0 max-w-28 truncate text-sm font-semibold sm:max-w-24 md:max-w-36 lg:max-w-48"
        >
          {displayName}
        </span>
        {signingOut ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-zinc-300" aria-label="Odhlasujem" />
        ) : (
          <ChevronDown
            size={14}
            className={`shrink-0 text-zinc-400 transition-transform group-hover:text-white ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Používateľský účet"
          className="absolute left-0 top-[calc(100%+0.55rem)] z-[2147483500] w-[min(19rem,calc(100vw-1rem))] overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-950 shadow-2xl"
        >
          <div className="flex items-start gap-3 p-3.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600">
              <UserRound size={19} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-zinc-950">{displayName}</span>
              {email ? <span className="mt-0.5 block truncate text-xs text-zinc-500">{email}</span> : null}
              {role ? (
                <span className="mt-2 inline-flex rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-zinc-600">
                  {accountRoleLabels[role]}
                </span>
              ) : null}
            </span>
          </div>
          <div className="border-t border-zinc-200 p-2">
            <a
              href="/navod"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100"
            >
              <NotebookPen size={16} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block">Návod</span>
                <span className="mt-0.5 block text-[11px] font-normal text-zinc-500">Postupy, telefonovanie a pomoc · nová karta</span>
              </span>
            </a>
            <a
              href="https://dispecing-testovanie.vercel.app"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100"
            >
              <ClipboardCheck size={16} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block">Testovanie</span>
                <span className="mt-0.5 block text-[11px] font-normal text-zinc-500">Scenáre, výsledky a história tímu · nové okno</span>
              </span>
            </a>
            <button
              type="button"
              onClick={() => { setOpen(false); onRefresh(); }}
              aria-label="Obnoviť aplikáciu"
              disabled={refreshBlocked || signingOut}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={16} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block">Obnoviť aplikáciu</span>
                {refreshBlocked ? <span className="mt-0.5 block text-[11px] font-normal text-zinc-500">Po skončení hovoru alebo pripájania</span> : updateAvailable ? <span className="mt-0.5 block text-[11px] font-normal text-zinc-500">Nová verzia je pripravená</span> : null}
              </span>
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-semibold text-red-700 transition hover:bg-red-50 hover:text-red-800"
            >
              <LogOut size={16} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block">Odhlásiť sa</span>
                <span className="mt-0.5 block text-[11px] font-normal text-zinc-500">Len z tohto zariadenia</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TelephonyNotConfiguredPill() {
  return (
    <span
      className="inline-flex h-9 items-center gap-2 rounded-md border border-white/15 bg-white/10 px-2 text-xs font-semibold text-zinc-200"
      title={TELEPHONY_NOT_CONFIGURED_MESSAGE}
      data-testid="telephony-not-configured"
    >
      <PhoneOff size={14} className="shrink-0" aria-hidden="true" />
      <span>Telefónia nie je nakonfigurovaná</span>
    </span>
  );
}

function TelephonyStalePill() {
  return (
    <span
      className="inline-flex h-9 items-center gap-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 text-xs font-semibold text-amber-200"
      title={TELEPHONY_STALE_MESSAGE}
      data-testid="telephony-stale"
    >
      <PhoneOff size={14} className="shrink-0" aria-hidden="true" />
      <span>{TELEPHONY_STALE_MESSAGE}</span>
    </span>
  );
}

function NavigationMenu({
  activeView,
  badgeCount,
  items,
  mobileShortcutItems,
  mobileShortcuts,
  pinNotice,
  pinnedViews,
  onSelect,
  onToggleMobileShortcut,
  onTogglePin,
  variant,
}: {
  activeView: View;
  badgeCount: number;
  items: Array<NavigationItem & { view: PinnableNavigationView }>;
  mobileShortcutItems?: MobileShortcutItem[];
  mobileShortcuts?: MobileNavigationShortcut[];
  pinNotice: string | null;
  pinnedViews: PinnableNavigationView[];
  onSelect: (view: View) => void;
  onToggleMobileShortcut?: (shortcut: MobileNavigationShortcut) => void;
  onTogglePin: (view: PinnableNavigationView) => void;
  variant: "header" | "mobile";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hasActiveItem = items.some((item) => item.view === activeView) && !(variant === "mobile" && (activeView === "tasks" || activeView === "cases"));
  const hasBadge = badgeCount > 0;
  const activeItemIsPinned = isPinnableNavigationView(activeView) && pinnedViews.includes(activeView);
  const pinnedItems = pinnedViews
    .map((view) => items.find((item) => item.view === view))
    .filter((item): item is NavigationItem & { view: PinnableNavigationView } => Boolean(item));
  const unpinnedItems = items.filter((item) => !pinnedViews.includes(item.view));
  const unpinnedBadgeCount = unpinnedItems.reduce((total, item) => total + (item.badgeCount ?? 0), 0);
  const selectedMobileItems = (mobileShortcuts ?? [])
    .map((shortcut) => mobileShortcutItems?.find((item) => item.shortcut === shortcut))
    .filter((item): item is MobileShortcutItem => Boolean(item));
  const availableMobileItems = (mobileShortcutItems ?? []).filter((item) => !(mobileShortcuts ?? []).includes(item.shortcut));

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function select(view: View) {
    setOpen(false);
    onSelect(view);
  }

  const mobile = variant === "mobile";
  const menuHighlighted = open || (hasActiveItem && !activeItemIsPinned);
  const headerTriggerStyle = menuHighlighted
    ? "bg-white text-zinc-950"
    : activeItemIsPinned
      ? "bg-white text-zinc-950 xl:bg-transparent xl:text-zinc-300 xl:hover:bg-zinc-800 xl:hover:text-white"
      : "text-zinc-300 hover:bg-zinc-800 hover:text-white";

  return (
    <div ref={rootRef} className={`relative min-w-0 ${mobile ? "w-full" : "shrink-0"}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Menu"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={
          mobile
            ? `relative flex h-14 w-full flex-col items-center justify-center gap-1 rounded-md px-1 text-[10px] font-semibold transition ${hasActiveItem || open ? "bg-zinc-950 text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950"}`
            : `relative inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs font-semibold transition sm:px-3 sm:text-sm ${headerTriggerStyle}`
        }
      >
        <Menu size={mobile ? 19 : 16} strokeWidth={mobile ? 2.2 : 2} aria-hidden="true" />
        <span>Menu</span>
        {!mobile && <ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />}
        {hasBadge && (
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${mobile ? "absolute right-[calc(50%-28px)] top-1 bg-[#FCD703] text-zinc-950" : `${menuHighlighted || activeItemIsPinned ? "bg-zinc-950 text-white" : "bg-[#FCD703] text-zinc-950"} xl:hidden`}`}>
            {formatBadgeCount(badgeCount)}
          </span>
        )}
        {!mobile && unpinnedBadgeCount > 0 && (
          <span className={`hidden rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none xl:inline-flex ${menuHighlighted ? "bg-zinc-950 text-white" : "bg-[#FCD703] text-zinc-950"}`}>
            {formatBadgeCount(unpinnedBadgeCount)}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Obrazovky aplikácie"
          className={`absolute z-[2147483500] max-h-[min(34rem,calc(100dvh-6rem))] w-[min(26rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-3 text-zinc-950 shadow-2xl ${mobile ? "bottom-[calc(100%+0.65rem)] right-0" : "left-0 top-[calc(100%+0.55rem)]"}`}
        >
          <div className="flex items-start justify-between gap-3 px-1 pb-2.5">
            <div>
              <p className="text-sm font-semibold text-zinc-950">Obrazovky</p>
              <p className="mt-0.5 text-[11px] leading-4 text-zinc-500">
                {mobile ? "Vyber si tri skratky do spodnej lišty. Mapa aj všetky obrazovky ostanú dostupné tu." : "Pripni si najpoužívanejšie do hornej lišty."}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-bold text-zinc-600">
              {mobile ? selectedMobileItems.length : pinnedItems.length} z {mobile ? MAX_MOBILE_NAVIGATION_SHORTCUTS : MAX_PINNED_NAVIGATION_VIEWS} skratiek
            </span>
          </div>

          {pinNotice ? (
            <p role="status" className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] font-medium leading-4 text-amber-900">
              {pinNotice}
            </p>
          ) : null}

          {mobile ? (
            <section aria-labelledby="mobile-shortcuts-title">
              <p id="mobile-shortcuts-title" className="px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">
                Skratky v spodnej lište
              </p>
              {selectedMobileItems.length > 0 ? (
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  {selectedMobileItems.map((item) => (
                    <MobileShortcutMenuItem key={item.shortcut} item={item} pinned onSelect={() => { setOpen(false); item.onSelect(); }} onToggle={onToggleMobileShortcut} />
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 rounded-lg border border-dashed border-zinc-200 px-3 py-2 text-xs text-zinc-500">Vyber si skratky zo zoznamu nižšie. Menu zostáva vždy dostupné.</p>
              )}
              {availableMobileItems.length > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  {availableMobileItems.map((item) => (
                    <MobileShortcutMenuItem
                      key={item.shortcut}
                      item={item}
                      pinned={false}
                      pinDisabled={selectedMobileItems.length >= MAX_MOBILE_NAVIGATION_SHORTCUTS}
                      onSelect={() => { setOpen(false); item.onSelect(); }}
                      onToggle={onToggleMobileShortcut}
                    />
                  ))}
                </div>
              )}
            </section>
          ) : (
          <section aria-labelledby={`${variant}-pinned-navigation-title`}>
            <p id={`${variant}-pinned-navigation-title`} className="px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">
              Pripnuté
            </p>
            {pinnedItems.length > 0 ? (
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                {pinnedItems.map((item) => (
                  <NavigationMenuItem
                    key={item.view}
                    active={item.view === activeView}
                    item={item}
                    pinned
                    pinDisabled={false}
                    onSelect={select}
                    onTogglePin={onTogglePin}
                  />
                ))}
              </div>
            ) : (
              <p className="mt-1.5 rounded-lg border border-dashed border-zinc-200 px-3 py-2 text-xs text-zinc-500">
                Zatiaľ nič. Pripni položku ikonou špendlíka.
              </p>
            )}
          </section>
          )}

          <div className="my-3 border-t border-zinc-200" />

          {mobile && <p className="px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">Všetky obrazovky</p>}

          {([
            ["daily", "Každodenná práca"],
            ["operations", "Prevádzka"],
            ["management", "Prehľady a správa"],
          ] as Array<[NavigationGroup, string]>).map(([group, label]) => {
            const groupItems = (mobile ? items : unpinnedItems).filter((item) => item.group === group);
            if (groupItems.length === 0) return null;

            return (
              <section key={group} className="mt-2 first:mt-0" aria-labelledby={`${variant}-${group}-navigation-title`}>
                <p id={`${variant}-${group}-navigation-title`} className="px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">
                  {label}
                </p>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  {groupItems.map((item) => (
                    <NavigationMenuItem
                      key={item.view}
                      active={item.view === activeView}
                      item={item}
                      pinned={false}
                      pinDisabled={pinnedItems.length >= MAX_PINNED_NAVIGATION_VIEWS}
                      showPinAction={!mobile}
                      onSelect={select}
                      onTogglePin={onTogglePin}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MobileShortcutMenuItem({
  item,
  onSelect,
  onToggle,
  pinDisabled = false,
  pinned,
}: {
  item: MobileShortcutItem;
  onSelect: () => void;
  onToggle?: (shortcut: MobileNavigationShortcut) => void;
  pinDisabled?: boolean;
  pinned: boolean;
}) {
  const ItemIcon = item.icon;
  const PinIcon = pinned ? PinOff : Pin;
  const pinAction = pinned ? "Odobrať zo spodnej lišty" : "Pridať do spodnej lišty";
  return (
    <div className={`group relative min-w-0 overflow-hidden rounded-lg border transition ${item.active ? "border-zinc-950 bg-zinc-950" : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50"}`}>
      <button
        type="button"
        aria-current={item.active ? "page" : undefined}
        aria-label={`${item.label} – skratka spodnej lišty`}
        onClick={onSelect}
        className={`flex min-h-11 w-full items-center gap-2 px-2.5 py-2 pr-10 text-left text-xs font-semibold ${item.active ? "text-white" : "text-zinc-700 group-hover:text-zinc-950"}`}
      >
        <ItemIcon size={16} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </button>
      <button
        type="button"
        aria-label={pinDisabled ? `Spodná lišta je plná. Najprv jednu skratku odober, potom môžeš pridať ${item.label}` : `${pinAction}: ${item.label}`}
        aria-pressed={pinned}
        data-testid={`mobile-navigation-shortcut-${item.shortcut}`}
        title={pinDisabled ? "Najprv odober jednu z troch skratiek" : `${pinAction}: ${item.label}`}
        onClick={() => onToggle?.(item.shortcut)}
        className={`absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md transition ${item.active ? "text-zinc-300 hover:bg-white/15 hover:text-[#FCD703]" : "text-zinc-400 hover:bg-zinc-200 hover:text-zinc-950"} ${pinDisabled ? "opacity-50" : ""}`}
      >
        <PinIcon size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

function NavigationMenuItem({
  active,
  item,
  onSelect,
  onTogglePin,
  pinDisabled,
  pinned,
  showPinAction = true,
}: {
  active: boolean;
  item: NavigationItem & { view: PinnableNavigationView };
  onSelect: (view: PinnableNavigationView) => void;
  onTogglePin: (view: PinnableNavigationView) => void;
  pinDisabled: boolean;
  pinned: boolean;
  showPinAction?: boolean;
}) {
  const ItemIcon = item.icon;
  const PinIcon = pinned ? PinOff : Pin;
  const itemHasBadge = typeof item.badgeCount === "number" && item.badgeCount > 0;
  const pinAction = pinned ? "Odopnúť" : "Pripnúť";

  return (
    <div className={`group relative min-w-0 overflow-hidden rounded-lg border transition ${active ? "border-zinc-950 bg-zinc-950" : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50"}`}>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(item.view)}
        className={`flex min-h-11 w-full items-center gap-2 px-2.5 py-2 text-left text-xs font-semibold transition ${showPinAction ? "pr-10" : "pr-2.5"} ${active ? "text-white" : "text-zinc-700 group-hover:text-zinc-950"}`}
      >
        <ItemIcon size={16} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {itemHasBadge ? (
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${active ? "bg-[#FCD703] text-zinc-950" : "bg-zinc-950 text-white"}`}>
            {formatBadgeCount(item.badgeCount ?? 0)}
          </span>
        ) : null}
      </button>
      {showPinAction && <button
        type="button"
        aria-label={pinDisabled ? `Limit skratiek je plný. Najprv jednu odopni, potom môžeš pripnúť ${item.label}` : `${pinAction} ${item.label}`}
        aria-pressed={pinned}
        data-testid={`navigation-pin-${item.view}`}
        title={pinDisabled ? `Najprv odopni jednu z ${MAX_PINNED_NAVIGATION_VIEWS} skratiek` : `${pinAction} ${item.label.toLocaleLowerCase("sk")}`}
        onClick={() => onTogglePin(item.view)}
        className={`absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md transition ${active ? "text-zinc-300 hover:bg-white/15 hover:text-[#FCD703]" : "text-zinc-400 hover:bg-zinc-200 hover:text-zinc-950"} ${pinDisabled ? "opacity-50" : ""}`}
      >
        <PinIcon size={14} aria-hidden="true" />
      </button>}
    </div>
  );
}

function NavButton({
  active,
  badgeCount,
  disabled = false,
  icon: Icon,
  label,
  onClick,
  responsiveShortcut = false,
}: {
  active: boolean;
  badgeCount?: number;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  responsiveShortcut?: boolean;
}) {
  const hasBadge = typeof badgeCount === "number" && badgeCount > 0;

  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      disabled={disabled}
      title={responsiveShortcut ? label : undefined}
      className={`relative inline-flex h-9 shrink-0 items-center gap-2 rounded-md text-xs font-semibold transition sm:text-sm ${responsiveShortcut ? "px-2 2xl:px-3" : "px-2.5 sm:px-3"} ${
        active ? "bg-white text-zinc-950" : "text-zinc-300 hover:bg-zinc-800 hover:text-white"
      } ${disabled ? "cursor-wait opacity-50" : ""}`}
    >
      <Icon size={16} aria-hidden="true" />
      <span className={responsiveShortcut ? "hidden 2xl:inline" : undefined}>{label}</span>
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
      className={`relative flex h-14 w-full min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 text-[10px] font-semibold transition ${
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

function applyMockNotificationSnooze(current: DispatchData, notificationId: string, snoozedUntil: string): DispatchData {
  const now = new Date().toISOString();

  return {
    ...current,
    notifications: current.notifications.map((notification) =>
      notification.id === notificationId
        ? {
            ...notification,
            status: "unread" as const,
            snoozedUntil,
            readAt: undefined,
            archivedAt: undefined,
            updatedAt: now,
          }
        : notification,
    ),
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

function toDispatchCall(call: DispatchCall | CallCenterCall): DispatchCall {
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
  };
}

function inCallCenterCall(call: DispatchCall | CallCenterCall): call is CallCenterCall {
  return "direction" in call;
}

function toDispatchCallStatus(status: DispatchCall["status"] | CallCenterCall["status"]): DispatchCall["status"] {
  if (status === "abandoned_queue" || status === "failed") {
    return "missed";
  }

  return status;
}

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
