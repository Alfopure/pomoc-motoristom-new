"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BellRing,
  CalendarDays,
  Headphones,
  LayoutDashboard,
  Loader2,
  PhoneOff,
  Plus,
  Settings2,
  Table2,
  Truck,
  X,
} from "lucide-react";
import { AttendanceModule } from "./AttendanceModule";
import { CallCenterModule } from "./CallCenterModule";
import { CallQueuePanel } from "./CallQueuePanel";
import { CaseDirectory } from "./CaseDirectory";
import { CaseList, type CaseFilters } from "./CaseList";
import { DashboardPhone } from "./DashboardPhone";
import type { CaseSortState } from "./CaseTable";
import { FleetModule } from "./FleetModule";
import { ExpandedCasePanel } from "./ExpandedCasePanel";
import { IntegrationSettings } from "./IntegrationSettings";
import { MapWorkspace, type CenterView, type WorkspaceKind, type WorkspaceMode } from "./MapWorkspace";
import type { SaveCaseDraft } from "./NewCaseDrawer";
import { ReportDashboard } from "./ReportDashboard";
import { HeaderNotificationMenu } from "./HeaderNotificationMenu";
import { NotificationToastStack } from "./NotificationToastStack";
import { PhoneBar } from "./PhoneBar";
import { phoneBarVisible, type PhoneCallAction } from "./phone-bar-model";
import { TELEPHONY_STALE_MESSAGE, useTelephonyConsole } from "./useTelephonyConsole";
import { TaskPanel, type TaskCreateInput, type TaskDeleteInput, type TaskUpdateInput } from "./TaskPanel";
import type { CallCenterCall, DispatchData } from "@/data/dispatch-types";
import { isNotificationForProfile, isNotificationUnread, notificationStatusLabel } from "@/domain/notifications";
import { casePriorityLabels, caseStatusLabels } from "@/domain/statuses";
import { isTaskOpen, taskPriorityLabels } from "@/domain/tasks";
import type { Branch, CallStatus, CaseTask, CustomerSharedLocation, DispatchCall, DispatchCase, DispatchNotification, FleetAsset, NotificationStatus, Operator, TimelineEvent } from "@/domain/types";
import { requiresTowDestination } from "@/domain/case-card";
import { caseAssistanceServiceName } from "@/lib/dispatch-calculations";
import { createDispatchMapModel } from "@/lib/map-adapter";
import { mergeCallCenterCalls, type PhoneBarCall } from "@/lib/telephony/active-calls-model";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { supportPollDelayMs } from "@/lib/telephony/poll-schedule";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE, TelephonyNotConfiguredError } from "@/lib/telephony/not-configured";
import type { TelephonyAvailabilityAction } from "@/lib/telephony/presence";

type View = "dispatch" | "tasks" | "cases" | "call-center" | "attendance" | "fleet" | "reports" | "settings";

type DispatchWorkspaceState = {
  kind: WorkspaceKind;
  mode: WorkspaceMode;
};

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
  const [isAssigning, setIsAssigning] = useState(false);
  const [isSendingCaseSms, setIsSendingCaseSms] = useState(false);
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

  // Telefónia (Telnyx): browser phone, `calls/active` polling, prezencia a
  // akcie hovoru žijú v `useTelephonyConsole`. Kým poskytovateľ nie je
  // nakonfigurovaný (503 z token/active route), hook vráti `configured=false`
  // a konzola ostáva v pôvodnom režime „Telefónia nie je nakonfigurovaná".
  const isOperator = Boolean(viewerProfileId && operators.some((operator) => operator.id === viewerProfileId));
  const telephony = useTelephonyConsole({ enabled: isOperator, operators });
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
      telephony.availabilityAction(action);
    },
    [telephony, telephonyConfigured],
  );
  // The waiting room ticks from the snapshot's own timestamp: it is the clock
  // every duration in that snapshot was computed against.
  const waitingRoomNow = useMemo(() => {
    const parsed = Date.parse(telephony.snapshot.checkedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [telephony.snapshot.checkedAt]);
  const waitingPickupState = useCallback(
    () => ({
      disabled: telephony.busyAction !== null || Boolean(telephony.phoneBar.active),
      label: telephony.busyAction === "pickup" ? "Preberám…" : "Prevziať hovor",
      ...(telephony.phoneBar.active ? { reason: "Najprv ukončite alebo odložte prebiehajúci hovor." } : {}),
    }),
    [telephony.busyAction, telephony.phoneBar.active],
  );
  const visibleCallCenterCalls = useMemo(
    () => (telephonyConfigured ? mergeCallCenterCalls(telephony.liveCalls, callCenterCalls) : callCenterCalls),
    [callCenterCalls, telephony.liveCalls, telephonyConfigured],
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

  // Stable so it does not invalidate the call-centre effects that depend on it;
  // as an inline arrow it was a new function on every render.
  const handleTelephonyChanged = useCallback(() => {
    void refreshCallHistory();
  }, [refreshCallHistory]);

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

    // Autosave has settled. Finishing (or abandoning) the pending navigation
    // updates state, so it runs from a scheduled callback rather than
    // synchronously inside the effect body.
    const timer = window.setTimeout(() => {
      if (!hasUnsavedChanges) {
        finishPendingNavigation();
        return;
      }

      if (leaveObservedSavingRef.current) {
        leaveObservedSavingRef.current = false;
        setLeaveAfterSave(false);
        setLeaveDialogError("Automatické uloženie sa nepodarilo dokončiť. Údaje zostali vo formulári; môžete skúsiť uloženie znova alebo zostať v editácii.");
      }
    }, 0);

    return () => window.clearTimeout(timer);
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

  /** Click-to-call from the dashboard phone, a case card or the call log. */
  async function dialNumber(phone: string, caseId?: string): Promise<void> {
    if (!telephonyConfigured || !phone) {
      setMutationNotice(TELEPHONY_NOT_CONFIGURED_MESSAGE);
      throw new TelephonyNotConfiguredError();
    }

    await telephony.dial(phone, caseId);
    setMutationNotice(`Volanie na ${phone} bolo spustené.`);
  }

  /** "Môj telefón" test call: a normal outbound dial from a chosen line. */
  async function testCall(input: { to: string; lineId: string | null }): Promise<void> {
    if (!telephonyConfigured) {
      setMutationNotice(TELEPHONY_NOT_CONFIGURED_MESSAGE);
      throw new TelephonyNotConfiguredError();
    }
    await telephony.dial(input.to, undefined, { lineId: input.lineId });
    setMutationNotice(`Skúšobný hovor na ${input.to} bol spustený.`);
  }

  /** Links a live or logged call to the case the console currently shows. */
  async function linkPhoneCallToCase(call: PhoneBarCall) {
    const caseId = call.caseId ?? workspaceCase?.id;
    if (!call.callId) {
      setMutationNotice("Hovor sa dá priradiť až po tom, čo je zapísaný v call logu.");
      return;
    }
    if (!caseId) {
      setMutationNotice("Najprv otvorte prípad, ku ktorému sa má hovor priradiť.");
      return;
    }
    await linkCreatedCaseToCall(call.callId, caseId);
    telephony.refresh();
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
          {telephonyConfigured && telephony.stale ? (
            <div className="hidden sm:block">
              <TelephonyStalePill />
            </div>
          ) : null}
          {telephonyConfigured ? (
            <div className="hidden sm:block">
              <CallQueuePanel
                calls={telephony.waitingCalls}
                now={waitingRoomNow}
                onPickup={(call) => runPhoneCallAction("pickup", call.providerSessionId ?? call.id)}
                pickupState={waitingPickupState}
                variant="header"
              />
            </div>
          ) : (
            <div className="hidden sm:block">
              <TelephonyNotConfiguredPill />
            </div>
          )}
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

      {telephonyConfigured &&
        phoneBarVisible({
          status: telephony.phone.status,
          hasCall: Boolean(telephony.phoneBar.active),
          hasOffer: telephony.phoneBar.offers.length > 0,
          hasWaiting: telephony.phoneBar.waiting.length > 0,
        }) && (
          <PhoneBar
            model={telephony.phoneBar}
            phone={telephony.phone}
            degradedSessionIds={telephony.degradedSessionIds}
            pauseReasons={telephony.pauseReasons}
            presenceBusy={telephony.presenceBusy}
            busyAction={telephony.busyAction}
            notice={telephony.notice}
            onDismissNotice={telephony.dismissNotice}
            onPresenceChange={telephony.changePresence}
            onCallAction={runPhoneCallAction}
            onAnswer={telephony.answer}
            onHangupBrowser={telephony.hangupBrowser}
            onToggleMute={telephony.toggleMute}
            onDtmf={telephony.sendDtmf}
            onNewCase={startNewCaseFromPhoneBar}
            onLinkCase={(call) => void linkPhoneCallToCase(call)}
            onOpenCase={openCase}
            onUnlockAudio={telephony.unlockAudio}
            onTakeover={telephony.takeoverPhone}
          />
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
              onDial={telephonyConfigured ? dialNumber : undefined}
              onDirtyChange={setHasUnsavedChanges}
              onSaveDraftChange={handleSaveDraftChange}
              onSavingChange={setIsCaseSaveLocked}
              operators={effectiveOperators}
              partnerDirectory={partnerDirectory}
              priceRule={activePriceRule}
              viewerProfileId={viewerProfileId}
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
            <DashboardPhone caseContext={dashboardSmsCaseContext} onDataChange={setDispatchData} onDial={(phone) => dialNumber(phone, dashboardSmsCaseContext?.id)} />
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
            onAssignAsset={(assetId) => void handleAssignAsset(assetId)}
            onBackToCockpit={returnToCockpit}
            onCaseCreated={handleCaseCreated}
            onCollapse={collapseWorkspace}
            onDataChange={setDispatchData}
            onDial={telephonyConfigured ? dialNumber : undefined}
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
            <DashboardPhone caseContext={dashboardSmsCaseContext} className="shrink-0" onDataChange={setDispatchData} onDial={(phone) => dialNumber(phone, dashboardSmsCaseContext?.id)} variant="rail" />
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
          activeSnapshot={telephonyConfigured ? telephony.phoneBar : undefined}
          busyCallAction={telephony.busyAction}
          calls={visibleCallCenterCalls}
          onCallAction={runPhoneCallAction}
          phone={telephony.phone}
          telephonyConfigured={telephonyConfigured}
          waitingCalls={telephony.waitingCalls}
          cases={dispatchCases}
          currentOperatorId={viewerProfileId}
          dataSource={source}
          metrics={metrics}
          onDataChange={setDispatchData}
          onDial={dialNumber}
          operatorPresences={operatorPresences}
          operators={effectiveOperators}
          onNewCase={startNewCaseFromCall}
          onOpenCase={openCase}
          onAvailabilityAction={onQueueAvailabilityAction}
          onCallbackCall={telephony.callBackRequest}
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
          users={users}
          onDataChange={setDispatchData}
          onTestCall={telephonyConfigured ? testCall : undefined}
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
