"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BookUser,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Headphones,
  History,
  Link2,
  List,
  Loader2,
  LogOut,
  Pause,
  PhoneCall,
  PhoneForwarded,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Plus,
  RadioTower,
  RefreshCw,
  Search,
  Star,
  UserRound,
  X,
} from "lucide-react";
import type { CallCenterCall, CallOutcome, DispatchData } from "@/data/dispatch-types";
import type { DispatchCase, DispatchMetrics, Operator } from "@/domain/types";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import { callStatusLabels } from "@/domain/statuses";
import { CallDetailDrawer } from "./CallDetailDrawer";
import { describePhoneState } from "./webphone-ui";
import { getQueueCoverage } from "./queue-coverage";
import type {
  ViptelBrowserWebphone,
  WorkplaceWebphoneSessionFence,
} from "@/lib/telephony/webphone-client";
import { isViptelWebphoneReadyForBrowser, type ViptelWebphoneConfig } from "@/lib/telephony/webphone";
import type { TelephonyHealthSignal } from "@/lib/telephony/health";
import type { ViptelQueueStatus } from "@/lib/integrations/viptel/client";
import type { WorkplaceTakeoverSnapshot } from "@/lib/telephony/workplace-takeover";
import type {
  TelephonyDirectoryContact,
  TelephonyDirectoryResponse,
  TelephonyFavoriteCreateResponse,
  TelephonyFavoriteMutationResponse,
  TelephonyFavoritesResponse,
} from "@/lib/telephony/directory";
import {
  confirmAuditedBrowserSipCall,
  requireConfirmedTelephonyCommand,
  runAuditedBrowserSipInvite,
  waitForTelephonyCommand,
} from "@/lib/telephony/commands";
import type {
  TelephonyAvailabilityAction,
  TelephonyOperatorPresence,
  TelephonyOperatorPresenceState,
  TelephonyPresenceSnapshot,
} from "@/lib/telephony/presence";
import {
  WorkplaceView,
  type WorkplaceSelectionActionResult,
  type WorkplaceSelectionInput,
  type WorkplaceSelectionSnapshot,
} from "./WorkplaceView";
import {
  callIsCurrentAtTelephonyStation,
  partitionLiveTelephonyCalls,
  resolveIncomingBrowserProviderCall,
  resolveOutboundBrowserProviderCall,
  resolveUniqueCurrentTelephonyCall,
  sameTelephonyCallIdentity,
  telephonyCallReactKey,
  type TelephonyExtensionIdentity,
} from "@/lib/telephony/call-endpoints";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import type { WaitingCallPickupController } from "./use-waiting-call-pickup";
import {
  busyActionBlocks,
  busyActionDeadlineMs,
  busyActionScope,
  phoneScopeBusy,
} from "./busy-actions";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";

type CallCenterModuleProps = {
  activeCallsHealth: TelephonyHealthSignal;
  availabilityPending: boolean;
  availabilityTarget: TelephonyAvailabilityAction | null;
  browserWebphone: ViptelBrowserWebphone;
  calls: CallCenterCall[];
  cases: DispatchCase[];
  dataSource: DispatchData["source"];
  defaultExtension: string;
  currentOperatorId?: string;
  metrics: DispatchMetrics;
  operatorPresences: TelephonyOperatorPresence[];
  operators: Operator[];
  queueStatus: ViptelQueueStatus | null;
  queueHealth: TelephonyHealthSignal;
  selectedWebphoneExtension: string;
  telephonyPresence: TelephonyPresenceSnapshot | null;
  telephonyPresenceHealth: TelephonyHealthSignal;
  workplaceSelection: WorkplaceSelectionSnapshot | null;
  workplaceSelectionError: string | null;
  workplaceSessionNotice: string | null;
  workplaceRecoveryRequired: boolean;
  workplaceTakeover: WorkplaceTakeoverSnapshot | null;
  workplaceTakeoverError: string | null;
  workplacePhoneMutationPending: boolean;
  workplaceFence?: WorkplaceWebphoneSessionFence;
  /**
   * Owned by DispatchConsole so the waiting room works on every view and so
   * only one pickup can be in flight per browser.
   */
  waitingPickup: WaitingCallPickupController;
  webphoneConfig: ViptelWebphoneConfig | null;
  onDataChange: (data: DispatchData) => void;
  onDial: (phone: string, caseId?: string) => Promise<void>;
  onNewCase: (call?: CallCenterCall) => void;
  onOpenCase: (caseId: string) => void;
  onAvailabilityAction: (action: TelephonyAvailabilityAction) => void;
  onRefreshWorkplace: () => Promise<void>;
  onRecoverWorkplacePriority: (operationId: string) => Promise<WorkplaceSelectionActionResult | void>;
  onCancelWorkplaceTakeover: (requestId: string) => Promise<WorkplaceSelectionActionResult | void>;
  onRequestWorkplaceTakeover: (extension: string) => Promise<WorkplaceSelectionActionResult | void>;
  onReleaseOccupiedWorkplace: (extension: string) => Promise<WorkplaceSelectionActionResult | void>;
  onReleaseWorkplace: () => Promise<WorkplaceSelectionActionResult | void>;
  onSelectWorkplace: (selection: WorkplaceSelectionInput) => Promise<WorkplaceSelectionActionResult | void>;
  onTakeoverWorkplace: (extension: string) => Promise<WorkplaceSelectionActionResult | void>;
  onTelephonyChanged: () => void;
};

type HistoryFilter = "all" | "inbound" | "outbound" | "answered" | "missed" | "callback";
type CallDialMode = "extension_callback" | "webphone";
const CALLBACK_PAGE_SIZE = 3;
const HISTORY_PAGE_SIZE = 8;

type EnqueuedCommandResponse = {
  command?: { id: string; status: string };
  error?: string;
  ok?: boolean;
  requestId?: string;
};


type PhonebookEntry = {
  id: string;
  detail: string;
  label: string;
  phone: string;
  type: "contact";
};

export function customerNumberForCall(call: Pick<CallCenterCall, "calledNumber" | "callerNumber" | "direction">) {
  return call.direction === "outbound" ? call.calledNumber : call.callerNumber;
}

export function presentCallForBrowser(
  call: CallCenterCall | undefined,
  browser: Pick<ViptelBrowserWebphone, "activeCallTarget" | "callDirection" | "hasActiveCall">,
) {
  if (!call || !browser.hasActiveCall || browser.callDirection !== "outbound") return call;
  const target = browser.activeCallTarget?.trim() || call.destinationNumber || call.calledNumber;
  return {
    ...call,
    calledNumber: target,
    callerName: undefined,
    destinationNumber: target,
    direction: "outbound" as const,
    status: call.status === "incoming" || call.status === "ringing_agent" ? "outbound" as const : call.status,
  };
}

async function confirmEnqueuedCommand(result: EnqueuedCommandResponse) {
  if (!result.command?.id) throw new Error(result.error ?? "Telefónny príkaz sa nevytvoril.");
  return requireConfirmedTelephonyCommand(await waitForTelephonyCommand(result.command.id));
}

export function CallCenterModule({
  activeCallsHealth,
  availabilityPending,
  availabilityTarget,
  browserWebphone,
  calls,
  cases,
  dataSource,
  defaultExtension,
  currentOperatorId,
  metrics,
  operatorPresences,
  onDataChange,
  onDial,
  onNewCase,
  onOpenCase,
  onAvailabilityAction,
  onRefreshWorkplace,
  onRecoverWorkplacePriority,
  onCancelWorkplaceTakeover,
  onRequestWorkplaceTakeover,
  onReleaseOccupiedWorkplace,
  onReleaseWorkplace,
  onSelectWorkplace,
  onTakeoverWorkplace,
  onTelephonyChanged,
  operators,
  queueStatus,
  queueHealth,
  selectedWebphoneExtension,
  telephonyPresence,
  telephonyPresenceHealth,
  workplaceSelection,
  workplaceSelectionError,
  workplaceSessionNotice,
  workplaceRecoveryRequired,
  workplaceTakeover,
  workplaceTakeoverError,
  workplacePhoneMutationPending,
  workplaceFence,
  waitingPickup,
  webphoneConfig,
}: CallCenterModuleProps) {
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [detailCall, setDetailCall] = useState<CallCenterCall | null>(null);
  const [moduleView, setModuleView] = useState<"overview" | "workplace">("workplace");
  const overviewTabRef = useRef<HTMLButtonElement>(null);
  const workplaceTabRef = useRef<HTMLButtonElement>(null);
  // The active endpoint already merges the provider snapshot with provisional
  // listener rows. Status is the authoritative lifecycle marker; filtering by
  // a presentation label used to hide calls exactly while VIPTel handed them
  // from one queue member to another, leaving the waiting room empty.
  // Memoised because the auto-answer effect below depends on them. Rebuilt in
  // the render body, they were new arrays on every render, so that effect
  // re-evaluated at the active-call poll cadence rather than when its inputs
  // actually changed.
  const partitionedCalls = useMemo(() => partitionLiveTelephonyCalls(calls), [calls]);
  const activeCalls = partitionedCalls.active;
  const storedCalls = useMemo(
    () => (dataSource === "supabase" ? partitionedCalls.completed : []),
    [dataSource, partitionedCalls],
  );
  const controlStations = useMemo<TelephonyExtensionIdentity[]>(() => {
    const stations = (telephonyPresence?.extensions ?? [])
      .filter((extension) => extension.active)
      .map((extension) => ({ extension: extension.extension, profileId: extension.profileId }));
    if (defaultExtension && !stations.some((station) => station.extension === defaultExtension)) {
      stations.push({ extension: defaultExtension, profileId: currentOperatorId });
    }
    return stations;
  }, [currentOperatorId, defaultExtension, telephonyPresence?.extensions]);
  const currentControlStation = controlStations.find((station) => station.extension === defaultExtension);
  const canControlCall = (call: CallCenterCall) => Boolean(
    currentControlStation && callIsCurrentAtTelephonyStation(call, currentControlStation, controlStations),
  );
  const providerActiveCall = browserWebphone.hasActiveCall
    ? browserWebphone.callDirection === "inbound"
      ? resolveIncomingBrowserProviderCall(activeCalls, currentControlStation, controlStations)
      : browserWebphone.callDirection === "outbound"
        ? resolveOutboundBrowserProviderCall(
            activeCalls,
            currentControlStation,
            controlStations,
            browserWebphone.activeCallTarget,
          )
        : resolveUniqueCurrentTelephonyCall(activeCalls, currentControlStation, controlStations)
    : resolveUniqueCurrentTelephonyCall(activeCalls, currentControlStation, controlStations);
  const activeCall = presentCallForBrowser(providerActiveCall, browserWebphone);
  const presentedActiveCalls = activeCall && providerActiveCall
    ? activeCalls.map((call) => sameTelephonyCallIdentity(call, providerActiveCall) ? activeCall : call)
    : activeCalls;
  const missedCalls = storedCalls.filter((call) => ["missed", "abandoned_queue", "failed"].includes(call.status) || call.outcome === "callback");
  const filteredHistoryCalls = filterHistoryCalls(storedCalls, historyFilter);
  const primaryQueueWait = activeCalls.filter((call) => call.status === "incoming" || call.status === "ringing_agent").length;
  const presenceByProfile = new Map(operatorPresences.map((presence) => [presence.profileId, presence]));
  const currentPresence = currentOperatorId
    ? presenceByProfile.get(currentOperatorId)
    : operatorPresences.find((presence) => presence.extensions.includes(defaultExtension));
  const currentOperator = currentOperatorId
    ? operators.find((operator) => operator.id === currentOperatorId)
    : operators.find((operator) => operator.extension === defaultExtension);
  const workplaceRecoveryPending = busyAction === "workplace:recover";
  useEffect(() => {
    if (!busyAction) return;
    // Every lock surrenders eventually. Without this, one action whose promise
    // never settles left the module's controls disabled for the rest of the
    // session with nothing on screen explaining why. Released from the timer
    // callback, so no state is written synchronously in the effect body.
    const timer = window.setTimeout(() => {
      setBusyAction(null);
      setActionNotice("Akcia trvá príliš dlho. Ovládanie je znova odomknuté; over stav skôr, než ju zopakuješ.");
    }, busyActionDeadlineMs(busyActionScope(busyAction)));
    return () => window.clearTimeout(timer);
  }, [busyAction]);

  async function recoverCurrentWorkplace() {
    const extension = workplaceSelection?.selection.extension;
    if (!extension || busyActionBlocks(busyAction, "workplace:recover")) return;
    const queue = workplaceSelection.selection.queue ??
      workplaceSelection.priorities.find((priority) =>
        (priority.selectedExtension ?? priority.activeExtension) === extension)?.queue ??
      workplaceSelection.priorities[0]?.queue ??
      "601";
    setBusyAction("workplace:recover");
    setActionNotice(null);
    try {
      const result = await onSelectWorkplace({ extension, queue });
      setActionNotice(result?.message ?? `Pracovné miesto ${extension} je znova pripojené.`);
    } catch (error) {
      setActionNotice(messageFromError(error, "Pracovné miesto sa nepodarilo obnoviť. Skús to znova."));
    } finally {
      setBusyAction(null);
    }
  }

  async function postCallOutcome(call: CallCenterCall, outcome: CallOutcome, callbackMinutes?: number) {
    if (!looksLikeUuid(call.id)) {
      setActionNotice("Výsledok vieme uložiť až po tom, čo je hovor v Supabase call logu.");
      return;
    }

    const busyKey = `${call.id}:${outcome}`;
    if (busyActionBlocks(busyAction, busyKey)) {
      return;
    }

    setBusyAction(busyKey);
    setActionNotice(null);

    try {
      const response = await telephonyFetch(`/api/telephony/calls/${encodeURIComponent(call.id)}/outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, callbackMinutes }),
        label: "výsledok hovoru",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      const result = (await response.json().catch(() => null)) as { dispatchData?: DispatchData; error?: string } | null;

      if (!response.ok || !result?.dispatchData) {
        throw new Error(result?.error ?? "Výsledok hovoru sa nepodarilo uložiť.");
      }

      onDataChange(result.dispatchData);
      setActionNotice(outcome === "callback" ? "Úloha na spätné volanie je pripravená pri priradenom prípade." : "Výsledok hovoru je uložený.");
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : "Výsledok hovoru sa nepodarilo uložiť.");
    } finally {
      setBusyAction(null);
    }
  }

  async function linkCallToCase(call: CallCenterCall, caseId: string) {
    if (!looksLikeUuid(call.id)) {
      setActionNotice("Priradenie funguje pre hovory uložené v Supabase call logu.");
      return;
    }

    const busyKey = `${call.id}:link`;
    if (busyActionBlocks(busyAction, busyKey)) {
      return;
    }

    setBusyAction(busyKey);
    setActionNotice(null);

    try {
      const response = await telephonyFetch(`/api/telephony/calls/${encodeURIComponent(call.id)}/link-case`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId }),
        label: "priradenie hovoru k prípadu",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      const result = (await response.json().catch(() => null)) as { dispatchData?: DispatchData; error?: string } | null;

      if (!response.ok || !result?.dispatchData) {
        throw new Error(result?.error ?? "Hovor sa nepodarilo priradiť.");
      }

      onDataChange(result.dispatchData);
      setActionNotice("Hovor je priradený k prípadu a zapísaný v timeline.");
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : "Hovor sa nepodarilo priradiť.");
    } finally {
      setBusyAction(null);
    }
  }

  async function callBack(call: CallCenterCall) {
    if (busyActionBlocks(busyAction, `${call.id}:call_back`)) {
      return;
    }
    if (workplacePhoneMutationPending) {
      setActionNotice("Najprv dokonči zmenu pracovného miesta. Telefón počas presunu nezačne nový hovor.");
      return;
    }
    if (!defaultExtension) {
      setActionNotice("Najprv si v Pracovisku vyber pracovné miesto.");
      return;
    }

    setBusyAction(`${call.id}:call_back`);
    setActionNotice(null);

    try {
      const destination = customerNumberForCall(call);
      await onDial(destination, call.caseId);
      setActionNotice(`Volanie na ${destination} bolo spustené.`);
      onTelephonyChanged();
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : "Príkaz na spätné volanie zlyhal.");
    } finally {
      setBusyAction(null);
    }
  }

  async function startQuickCall(entry: PhonebookEntry) {
    if (busyActionBlocks(busyAction, `quick:${entry.id}`) || !entry.phone.trim()) {
      return;
    }
    if (workplacePhoneMutationPending) {
      setActionNotice("Najprv dokonči zmenu pracovného miesta. Telefón počas presunu nezačne nový hovor.");
      return;
    }
    if (!defaultExtension) {
      setActionNotice("Tvoj profil nemá priradenú aktívnu VIPTel klapku.");
      return;
    }

    const busyKey = `quick:${entry.id}`;
    setBusyAction(busyKey);
    setActionNotice(null);

    try {
      await onDial(entry.phone);
      setActionNotice(`Volanie na ${entry.label} bolo spustené.`);
      onTelephonyChanged();
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : "Telefónny príkaz VIPTel zlyhal.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main className={`min-h-0 flex-1 overflow-x-hidden bg-zinc-50 p-3 sm:p-4 ${
      moduleView === "overview" ? "overflow-y-auto xl:flex xl:flex-col xl:overflow-y-hidden" : "overflow-y-auto"
    }`}>
      <OperatorAvailabilityPanel
        commandPending={availabilityPending}
        commandTarget={availabilityTarget}
        currentOperatorName={currentPresence?.operatorName ?? currentOperator?.name}
        generalHealth={telephonyPresenceHealth}
        health={queueHealth}
        myExtension={defaultExtension}
        myPresence={currentPresence}
        operatorPresences={operatorPresences}
        recoveryPending={workplaceRecoveryPending}
        sessionNotice={workplaceSessionNotice}
        status={queueStatus}
        statuses={telephonyPresence?.queueStatuses ?? []}
        workplaceRecoveryRequired={workplaceRecoveryRequired}
        onAction={onAvailabilityAction}
        onRecoverWorkplace={() => void recoverCurrentWorkplace()}
      />

      {actionNotice && <div className="mb-3 shrink-0 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900">{actionNotice}</div>}

      <div className="mb-3 flex shrink-0 border-b border-zinc-200" role="tablist" aria-label="Pohľady ústredne">
        <div className="flex min-w-0 gap-1">
          <button
            ref={workplaceTabRef}
            type="button"
            id="call-center-workplace-tab"
            role="tab"
            aria-controls="call-center-workplace-panel"
            aria-selected={moduleView === "workplace"}
            tabIndex={moduleView === "workplace" ? 0 : -1}
            onClick={() => setModuleView("workplace")}
            onKeyDown={(event) => {
              if (["ArrowLeft", "ArrowRight", "End"].includes(event.key)) {
                event.preventDefault();
                setModuleView("overview");
                overviewTabRef.current?.focus();
              }
            }}
            className={`relative inline-flex min-h-10 items-center justify-center gap-2 px-3 text-sm font-bold outline-none transition focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-inset ${
              moduleView === "workplace" ? "text-zinc-950 after:absolute after:inset-x-1 after:bottom-[-1px] after:h-0.5 after:bg-[#F4C900]" : "text-zinc-500 hover:text-zinc-900"
            }`}
          >
            <Building2 size={17} aria-hidden="true" />
            Pracovisko
          </button>
          <button
            ref={overviewTabRef}
            type="button"
            id="call-center-overview-tab"
            role="tab"
            aria-controls="call-center-overview-panel"
            aria-selected={moduleView === "overview"}
            tabIndex={moduleView === "overview" ? 0 : -1}
            onClick={() => setModuleView("overview")}
            onKeyDown={(event) => {
              if (["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) {
                event.preventDefault();
                setModuleView("workplace");
                workplaceTabRef.current?.focus();
              }
            }}
            className={`relative inline-flex min-h-10 items-center justify-center gap-2 px-3 text-sm font-bold outline-none transition focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-inset ${
              moduleView === "overview" ? "text-zinc-950 after:absolute after:inset-x-1 after:bottom-[-1px] after:h-0.5 after:bg-[#F4C900]" : "text-zinc-500 hover:text-zinc-900"
            }`}
          >
            <List size={17} aria-hidden="true" />
            Prehľad hovorov
          </button>
        </div>
      </div>

      {moduleView === "overview" ? (
        <div id="call-center-overview-panel" className="xl:min-h-0 xl:flex-1" role="tabpanel" aria-labelledby="call-center-overview-tab">
          <div className="grid min-w-0 max-w-full gap-4 xl:h-full xl:min-h-0 xl:grid-cols-[minmax(240px,280px)_minmax(0,1fr)_minmax(280px,320px)] 2xl:grid-cols-[minmax(280px,320px)_minmax(0,1fr)_minmax(300px,340px)]">
            <aside className="grid min-w-0 max-w-full content-start gap-4 overflow-hidden xl:flex xl:h-full xl:min-h-0 xl:flex-col [&>*]:min-w-0">
              <PhonebookPanel
                busyAction={busyAction}
                onQuickCall={(entry) => void startQuickCall(entry)}
              />
            </aside>

            <HistoryPanel
              busyAction={busyAction}
              calls={filteredHistoryCalls}
              cases={cases}
              filter={historyFilter}
              onCallBack={callBack}
              onFilterChange={setHistoryFilter}
              onLinkCall={linkCallToCase}
              onNewCase={onNewCase}
              onOpenCase={onOpenCase}
              onOpenDetail={setDetailCall}
              totalCalls={storedCalls.length}
            />

            <aside className="grid min-w-0 max-w-full content-start gap-4 overflow-hidden xl:h-full xl:min-h-0 xl:grid-cols-1 xl:overflow-y-auto xl:overscroll-contain [&>*]:min-w-0">
              <CallCommandPanel
                activeCall={activeCall}
                activeCount={activeCalls.length}
                browserWebphone={browserWebphone}
                defaultExtension={defaultExtension}
                metrics={metrics}
                missedCount={missedCalls.length}
                primaryQueueWait={primaryQueueWait}
                restHealth={activeCallsHealth}
                selectedWebphoneExtension={selectedWebphoneExtension}
                workplacePhoneMutationPending={workplacePhoneMutationPending}
                workplaceFence={workplaceFence}
                webphoneConfig={webphoneConfig}
                onTelephonyChanged={onTelephonyChanged}
              />
              <CallbackInbox
                busyAction={busyAction}
                calls={missedCalls}
                onCallBack={callBack}
                onComplete={(call) => void postCallOutcome(call, "reached")}
                onNewCase={onNewCase}
                onSchedule={(call) => void postCallOutcome(call, "callback", 30)}
              />
            </aside>
          </div>
        </div>
      ) : (
        <div id="call-center-workplace-panel" role="tabpanel" aria-labelledby="call-center-workplace-tab">
          <WorkplaceView
            activeCalls={presentedActiveCalls}
            browserPhoneStatus={browserWebphone.registrationStatus}
            canControlCall={canControlCall}
            currentExtension={defaultExtension}
            currentOperatorId={currentOperatorId}
            health={telephonyPresenceHealth}
            operatorPresences={operatorPresences}
            operators={operators}
            snapshot={telephonyPresence}
            workplaceSelection={workplaceSelection}
            workplaceSelectionError={workplaceSelectionError}
            workplaceTakeover={workplaceTakeover}
            workplaceTakeoverError={workplaceTakeoverError}
            waitingCallPickupState={waitingPickup.waitingCallPickupState}
            onRefreshWorkplace={onRefreshWorkplace}
            onRecoverWorkplacePriority={onRecoverWorkplacePriority}
            onCancelWorkplaceTakeover={onCancelWorkplaceTakeover}
            onRequestWorkplaceTakeover={onRequestWorkplaceTakeover}
            onReleaseOccupiedWorkplace={onReleaseOccupiedWorkplace}
            onReleaseWorkplace={onReleaseWorkplace}
            onSelectWorkplace={onSelectWorkplace}
            onTakeoverWorkplace={onTakeoverWorkplace}
            onPickupWaitingCall={(call) => void waitingPickup.pickupWaitingCall(call)}
            actions={(selectedWorkplaceCall) => {
              const controlledCall = selectedWorkplaceCall && canControlCall(selectedWorkplaceCall)
                ? selectedWorkplaceCall
                : undefined;
              const presentedControlledCall = controlledCall && activeCall?.id === controlledCall.id
                ? activeCall
                : controlledCall;
              return (
                <>
                {selectedWorkplaceCall && !controlledCall ? (
                  <section className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700">
                    <p className="font-bold text-zinc-950">Hovor je iba na sledovanie</p>
                    <p className="mt-1 leading-5">Prepojiť alebo ukončiť ho môže operátor, ktorému práve patrí. Na ovládanie svojho hovoru vyber jeho značku v pracovisku.</p>
                  </section>
                ) : null}
                <CallCommandPanel
                  activeCall={presentedControlledCall}
                  activeCount={activeCalls.length}
                  browserWebphone={browserWebphone}
                  defaultExtension={defaultExtension}
                  metrics={metrics}
                  missedCount={missedCalls.length}
                  primaryQueueWait={primaryQueueWait}
                  restHealth={activeCallsHealth}
                  selectedWebphoneExtension={selectedWebphoneExtension}
                  workplacePhoneMutationPending={workplacePhoneMutationPending}
                  workplaceFence={workplaceFence}
                  webphoneConfig={webphoneConfig}
                  onTelephonyChanged={onTelephonyChanged}
                />
                </>
              );
            }}
          />
        </div>
      )}

      <CallDetailDrawer call={detailCall} open={Boolean(detailCall)} onClose={() => setDetailCall(null)} onNewCase={onNewCase} />
    </main>
  );
}

function CallCommandPanel({
  activeCall,
  activeCount,
  browserWebphone,
  defaultExtension,
  metrics,
  missedCount,
  primaryQueueWait,
  restHealth,
  selectedWebphoneExtension,
  workplacePhoneMutationPending,
  workplaceFence,
  webphoneConfig,
  onTelephonyChanged,
}: {
  activeCall?: CallCenterCall;
  activeCount: number;
  browserWebphone: ViptelBrowserWebphone;
  defaultExtension: string;
  metrics: DispatchMetrics;
  missedCount: number;
  primaryQueueWait: number;
  restHealth: TelephonyHealthSignal;
  selectedWebphoneExtension: string;
  workplacePhoneMutationPending: boolean;
  workplaceFence?: WorkplaceWebphoneSessionFence;
  webphoneConfig: ViptelWebphoneConfig | null;
  onTelephonyChanged: () => void;
}) {
  const [pickedMode, setPickedMode] = useState<CallDialMode | null>(null);
  const [toNumber, setToNumber] = useState("");
  const [isCalling, setIsCalling] = useState(false);
  const [callFeedback, setCallFeedback] = useState<{ tone: "error" | "success" | "waiting"; message: string } | null>(null);
  const webphoneExtensions = webphoneConfig?.extensions ?? [];
  const webphoneAvailable = isViptelWebphoneReadyForBrowser(webphoneConfig, selectedWebphoneExtension);
  // Default na webphone, len čo je dostupný; voľba operátora má prednosť.
  const dialMode: CallDialMode = pickedMode ?? (webphoneAvailable ? "webphone" : "extension_callback");
  const setDialMode = setPickedMode;
  const activeFromExtension = dialMode === "webphone" ? selectedWebphoneExtension : defaultExtension;
  const browserReadyForCall = dialMode !== "webphone" || browserWebphone.isRegistered;
  const canCall =
    activeFromExtension.trim().length > 0 &&
    toNumber.trim().length > 0 &&
    !isCalling &&
    browserReadyForCall &&
    !workplacePhoneMutationPending &&
    (dialMode !== "webphone" || !browserWebphone.hasActiveCall);
  const phone = describePhoneState(browserWebphone.registrationStatus, browserWebphone.callStatus, browserWebphone.mode);
  const activeCallsVerified = restHealth.state === "live";
  const phonePreparing = Boolean(
    defaultExtension &&
    selectedWebphoneExtension &&
    webphoneAvailable &&
    browserWebphone.registrationStatus === "idle",
  );
  const workplaceStatus = !defaultExtension
    ? { label: "bez pracovného miesta", tone: "neutral" as const }
    : activeCall
      ? { label: "zvoní / prebieha", tone: "warn" as const }
      : browserWebphone.isRegistered
        ? { label: "telefón pripojený", tone: "ok" as const }
        : browserWebphone.registrationStatus === "failed"
          ? { label: "chyba pripojenia", tone: "bad" as const }
          : !webphoneAvailable
            ? { label: "telefón nedostupný", tone: "bad" as const }
          : { label: "pripravuje sa", tone: "neutral" as const };
  const workplaceDetail = !defaultExtension
    ? "V Pracovisku si vyber voľné pracovné miesto a poradie zvonenia."
    : activeCall
      ? `${formatPhoneNumberForDisplay(customerNumberForCall(activeCall))} · hovor na pracovnom mieste ${defaultExtension}`
      : browserWebphone.isRegistered
        ? `Odchádzajúce telefonovanie z pracovného miesta ${defaultExtension} je pripojené.`
        : browserWebphone.registrationStatus === "failed"
          ? "Telefonovanie sa nepodarilo pripraviť. Použi možnosť Skúsiť znova nižšie."
          : !webphoneAvailable
            ? "Telefonovanie v prehliadači nie je pre toto pracovné miesto dostupné."
          : `Pripravujem telefonovanie na pracovnom mieste ${defaultExtension}…`;
  const visibleCallFeedback = browserWebphone.callStatus === "ended" &&
    !isCalling &&
    callFeedback?.tone !== "error"
    ? null
    : callFeedback;

  async function submitCall() {
    if (workplacePhoneMutationPending) {
      setCallFeedback({
        tone: "error",
        message: "Najprv dokonči zmenu pracovného miesta. Telefón počas presunu nezačne nový hovor.",
      });
      return;
    }
    if (!canCall) {
      return;
    }

    setIsCalling(true);
    setCallFeedback(null);

    try {
      if (dialMode === "webphone") {
        if (browserWebphone.hasActiveCall) {
          setCallFeedback({ tone: "error", message: "Najprv ukončite alebo odmietnite aktuálny hovor v prehliadači." });
          return;
        }
        if (!browserWebphone.isRegistered) {
          setCallFeedback({ tone: "error", message: "Telefonovanie sa ešte pripravuje. Počkaj na stav Pripravený volať." });
          return;
        }

        if (browserWebphone.mode === "mock") {
          browserWebphone.simulateOutgoing(toNumber);
          setCallFeedback({ tone: "success", message: `Testovací hovor v prehliadači na ${toNumber}.` });
          return;
        }

        if (webphoneConfig?.dialMode === "sip_invite") {
          const intentResponse = await telephonyFetch("/api/telephony/call/create", {
            label: "autorizácia hovoru",
            timeoutMs: TELEPHONY_TIMEOUT_MS.control,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "browser_sip",
              fromExtension: activeFromExtension,
              webphoneExtension: activeFromExtension,
              toNumber,
              ...workplaceFence,
            }),
          });
          const intent = (await intentResponse.json().catch(() => null)) as EnqueuedCommandResponse | null;
          if (!intentResponse.ok || !intent?.command?.id) {
            throw new Error(intent?.error ?? "Hovor v prehliadači sa nepodarilo bezpečne zapísať.");
          }
          const attempt = await runAuditedBrowserSipInvite(
            intent.command.id,
            () => browserWebphone.startDirectCall(toNumber),
          );
          setCallFeedback({ tone: "waiting", message: "Hovor sa vytáča a čaká na potvrdenie VIPTel." });
          await confirmAuditedBrowserSipCall(intent.command.id, attempt);
          setCallFeedback({ tone: "success", message: `VIPTel potvrdil hovor z pracovného miesta ${activeFromExtension}.` });
          onTelephonyChanged();
          return;
        }
      }

      const response = await telephonyFetch("/api/telephony/call/create", {
        label: "vytvorenie hovoru",
        timeoutMs: TELEPHONY_TIMEOUT_MS.control,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: dialMode,
          fromExtension: activeFromExtension,
          webphoneExtension: dialMode === "webphone" ? activeFromExtension : undefined,
          toNumber,
          ...workplaceFence,
        }),
      });
      const result = (await response.json().catch(() => null)) as EnqueuedCommandResponse | null;

      if (!response.ok || !result?.command?.id) {
        throw new Error(result?.error ?? "Telefónny príkaz VIPTel zlyhal.");
      }

      setCallFeedback({ tone: "waiting", message: "Hovor čaká na potvrdenie VIPTel." });
      await confirmEnqueuedCommand(result);
      setCallFeedback({ tone: "success", message: `VIPTel potvrdil hovor z pracovného miesta ${activeFromExtension}.` });
      onTelephonyChanged();
    } catch (error) {
      setCallFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Telefónny príkaz VIPTel zlyhal.",
      });
    } finally {
      setIsCalling(false);
    }
  }

  return (
    <section className={`rounded-md border bg-white ${activeCall ? "border-amber-300 ring-1 ring-amber-100" : "border-zinc-200"}`}>
      <div className="border-b border-zinc-200 p-3">
        <div className="flex min-w-0 items-start gap-2">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
              !defaultExtension
                ? "bg-zinc-100 text-zinc-600"
                : activeCall
                  ? "bg-amber-100 text-amber-800"
                  : browserWebphone.isRegistered
                    ? "bg-emerald-100 text-emerald-800"
                    : browserWebphone.registrationStatus === "failed"
                      ? "bg-red-100 text-red-800"
                      : "bg-zinc-100 text-zinc-600"
            }`}
          >
            <RadioTower size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-zinc-950">Moje pracovné miesto</span>
              <StatusBadge
                label={workplaceStatus.label}
                tone={workplaceStatus.tone}
              />
            </div>
            <div className="mt-1 text-xs font-medium leading-5 text-zinc-600">{workplaceDetail}</div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 p-3">
        <div className="grid min-w-0 gap-2">
          <div className="grid grid-cols-2 gap-1 rounded-md bg-zinc-100 p-1">
            <CallModeTab active={dialMode === "extension_callback"} icon={PhoneOutgoing} label="Cez linku" onClick={() => setDialMode("extension_callback")} />
            <CallModeTab
              active={dialMode === "webphone"}
              disabled={!webphoneAvailable}
              icon={Headphones}
              label="V prehliadači"
              onClick={() => setDialMode("webphone")}
            />
          </div>
          {dialMode === "webphone" ? (
            webphoneExtensions.length > 0 ? (
              <div className="flex h-11 min-w-0 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm font-semibold text-zinc-700">
                <Headphones size={15} className="shrink-0 text-zinc-400" />
                <span className="shrink-0 text-xs font-medium text-zinc-500">Interná linka</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-800">
                  {selectedWebphoneExtension || "nepriradená"}
                </span>
              </div>
            ) : (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                {defaultExtension
                  ? "Telefonovanie v prehliadači čaká na prístupové údaje od VIPTel."
                  : "Najprv si v Pracovisku vyber pracovné miesto."}
              </div>
            )
          ) : (
            <div className="flex h-11 min-w-0 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm">
              <PhoneOutgoing size={15} className="shrink-0 text-zinc-400" />
              <span className="text-xs font-medium text-zinc-500">Interná linka</span>
              <span className="truncate font-semibold text-zinc-800">{defaultExtension || "nepriradená"}</span>
            </div>
          )}
          <input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={toNumber}
            onChange={(event) => setToNumber(event.target.value)}
            placeholder="+421 900 000 000"
            aria-label="Číslo"
            className="h-11 min-w-0 rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none ring-yellow-300 transition focus:ring-2"
          />
          <div>
            <button
              type="button"
              onClick={() => void submitCall()}
              disabled={!canCall}
              className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:bg-zinc-300 disabled:text-zinc-600"
            >
              {isCalling ? <Loader2 size={15} className="animate-spin" /> : <PhoneOutgoing size={15} />}
              {dialMode === "webphone" ? "Volať" : "Volať z linky"}
            </button>
          </div>
          {visibleCallFeedback && (
            <div
              role={visibleCallFeedback.tone === "error" ? "alert" : "status"}
              aria-live={visibleCallFeedback.tone === "error" ? "assertive" : "polite"}
              className={`rounded-md border px-3 py-2 text-xs font-semibold leading-5 ${
                visibleCallFeedback.tone === "error"
                  ? "border-red-200 bg-red-50 text-red-900"
                  : visibleCallFeedback.tone === "success"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                    : "border-amber-200 bg-amber-50 text-amber-950"
              }`}
            >
              {visibleCallFeedback.message}
            </div>
          )}
        </div>

        {dialMode === "webphone" && (
          <div className="grid gap-2 rounded-md bg-zinc-50 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold text-zinc-700">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${!webphoneAvailable ? "bg-red-500" : phone.dot} ${phone.pulse ? "animate-pulse motion-reduce:animate-none" : ""}`} aria-hidden="true" />
                <span className="truncate" role="status" aria-live="polite" aria-atomic="true">
                  {!webphoneAvailable
                    ? "Telefón v prehliadači nie je dostupný"
                    : phonePreparing
                      ? "Pripravujem telefonovanie…"
                      : phone.label}
                </span>
              </span>
              {browserWebphone.registrationStatus === "failed" && (
                <button
                  type="button"
                  onClick={() => void browserWebphone.connect()}
                  disabled={!webphoneAvailable}
                  aria-describedby={browserWebphone.notice ? "browser-phone-notice" : undefined}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md bg-zinc-950 px-3 text-xs font-semibold text-white outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:bg-zinc-300 disabled:text-zinc-600"
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Skúsiť znova
                </button>
              )}
            </div>
            {browserWebphone.notice && (
              <p
                id="browser-phone-notice"
                role={browserWebphone.registrationStatus === "failed" ? "alert" : "status"}
                aria-live={browserWebphone.registrationStatus === "failed" ? "assertive" : "polite"}
                className={`break-words rounded-md border px-2.5 py-2 text-xs font-medium leading-5 ${
                  browserWebphone.registrationStatus === "failed"
                    ? "border-red-200 bg-red-50 text-red-900"
                    : "border-emerald-200 bg-emerald-50 text-emerald-900"
                }`}
              >
                {browserWebphone.notice}
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-1.5">
          <CommandMetric icon={PhoneIncoming} label="Prebieha" value={activeCallsVerified ? String(activeCount) : "—"} tone={activeCallsVerified ? (activeCount > 0 ? "warn" : "ok") : "bad"} />
          <CommandMetric icon={Clock3} label="Čaká" value={activeCallsVerified ? String(primaryQueueWait) : "—"} tone={activeCallsVerified ? (primaryQueueWait > 0 ? "warn" : "ok") : "bad"} />
          <CommandMetric icon={PhoneMissed} label="Spätné" value={String(missedCount)} tone={missedCount > 0 ? "warn" : "ok"} />
          <CommandMetric icon={CheckCircle2} label="Úspešnosť" value={`${metrics.answerRate}%`} tone="neutral" />
        </div>
      </div>
    </section>
  );
}

function OperatorAvailabilityPanel({
  commandPending,
  commandTarget,
  currentOperatorName,
  generalHealth,
  health,
  myExtension,
  myPresence,
  operatorPresences,
  recoveryPending,
  sessionNotice,
  status,
  statuses,
  workplaceRecoveryRequired,
  onAction,
  onRecoverWorkplace,
}: {
  commandPending: boolean;
  commandTarget: TelephonyAvailabilityAction | null;
  currentOperatorName?: string;
  generalHealth: TelephonyHealthSignal;
  health: TelephonyHealthSignal;
  myExtension: string;
  myPresence?: TelephonyOperatorPresence;
  operatorPresences: TelephonyOperatorPresence[];
  recoveryPending: boolean;
  sessionNotice: string | null;
  status: ViptelQueueStatus | null;
  statuses: ViptelQueueStatus[];
  workplaceRecoveryRequired: boolean;
  onAction: (action: TelephonyAvailabilityAction) => void;
  onRecoverWorkplace: () => void;
}) {
  const members = status?.members ?? [];
  const me = members.find((member) => member.extension === myExtension);
  const inQueue = Boolean(me);
  const paused = me?.paused ?? false;
  const coverage = getQueueCoverage(statuses.length > 0 ? statuses : status, operatorPresences);
  const verified = health.state === "live";
  const generalDataVerified = generalHealth.state === "live";
  const busy = myPresence?.inUse === true;
  const state = myPresence?.state ?? (myExtension ? "stale" : "unassigned");
  const needsAttention = workplaceRecoveryRequired || Boolean(sessionNotice) || !["available", "ringing", "on_call"].includes(state);
  const workingState = state === "ringing" || state === "on_call";
  const stateSurface = workplaceRecoveryRequired
    ? "border-amber-300 bg-amber-50 text-amber-800"
    : state === "available"
    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
    : workingState || state === "paused" || state === "unassigned"
      ? "border-amber-300 bg-amber-50 text-amber-800"
      : "border-red-300 bg-red-50 text-red-800";
  const guidanceSurface = workplaceRecoveryRequired || sessionNotice
    ? "border-amber-200 bg-amber-50 text-amber-950"
    : state === "available"
    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : workingState || state === "paused" || state === "unassigned"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-red-200 bg-red-50 text-red-900";

  return (
    <section className="mb-4 shrink-0 overflow-hidden rounded-md border border-zinc-200 bg-white" aria-label="Môj stav operátora">
      <div className="grid gap-4 p-3 sm:p-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,auto)] xl:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border ${stateSurface}`}>
            {state === "available"
              ? <CheckCircle2 size={20} aria-hidden="true" />
              : state === "paused"
                ? <Pause size={19} aria-hidden="true" />
                : state === "ringing"
                  ? <PhoneIncoming size={19} aria-hidden="true" />
                  : state === "on_call"
                    ? <PhoneCall size={19} aria-hidden="true" />
                    : state === "unassigned" || state === "offline"
                      ? <LogOut size={18} aria-hidden="true" />
                      : <AlertTriangle size={18} aria-hidden="true" />}
            <span className="sr-only">{presenceStateLabel[state]}</span>
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-zinc-950">{currentOperatorName ?? "Prihlásený operátor"}</h1>
            <div className="mt-1 text-sm font-medium text-zinc-700">
              {myExtension ? `Interná linka ${myExtension}` : "Bez priradenej internej linky"}
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Môj pracovný stav</span>
            <div className="flex flex-wrap gap-1.5">
              {generalDataVerified ? (
                <>
                  <StatusBadge label={`Voľní ${coverage.available}/${coverage.total}`} tone={coverage.needsOperator ? "bad" : coverage.available > 0 ? "ok" : "neutral"} />
                  {coverage.waiting > 0 && <StatusBadge label={`${coverage.waiting} čaká`} tone="warn" />}
                </>
              ) : (
                <StatusBadge label="Údaje sa obnovujú" tone="warn" />
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-md bg-zinc-100 p-1">
            <AvailabilityButton
              active={commandPending
                ? commandTarget === "available"
                : verified && myPresence?.available === true}
              disabled={commandPending || workplaceRecoveryRequired || !myExtension || !verified || busy}
              icon={Check}
              label="Dostupný"
              pending={commandPending && commandTarget === "available"}
              onClick={() => onAction("available")}
            />
            <AvailabilityButton
              active={commandPending
                ? commandTarget === "pause"
                : verified && inQueue && paused}
              disabled={commandPending || workplaceRecoveryRequired || !inQueue || !verified}
              icon={Pause}
              label="Pauza"
              pending={commandPending && commandTarget === "pause"}
              onClick={() => onAction("pause")}
            />
            <AvailabilityButton
              active={commandPending
                ? commandTarget === "offline"
                : verified && !inQueue && Boolean(myExtension)}
              disabled={commandPending || workplaceRecoveryRequired || !myExtension || !verified || busy}
              icon={LogOut}
              label="Mimo radu"
              pending={commandPending && commandTarget === "offline"}
              onClick={() => onAction("offline")}
            />
          </div>
          {commandPending && (
            <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-semibold text-zinc-600">
              <Loader2 size={12} className="animate-spin" />
              {commandTarget === "available"
                ? "Nastavujem Dostupný…"
                : commandTarget === "pause"
                  ? "Nastavujem Pauzu…"
                  : commandTarget === "offline"
                    ? "Vyraďujem z radu…"
                    : "Čakám na potvrdenie VIPTel…"}
            </div>
          )}
        </div>
      </div>

      {needsAttention && <div className={`flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2.5 text-xs font-semibold sm:px-4 ${guidanceSurface}`}>
        <div className="flex min-w-0 flex-1 items-start gap-2">
          {needsAttention ? <AlertTriangle size={15} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={15} className="mt-0.5 shrink-0" />}
          <span>{workplaceRecoveryRequired
            ? "Predchádzajúce okno zostalo priradené k tomuto miestu. Obnov pracovisko a telefón sa bezpečne pripojí znova."
            : sessionNotice ?? availabilityGuidance(state, myExtension, busy, verified, coverage.needsOperator)}</span>
        </div>
        {workplaceRecoveryRequired && (
          <button
            type="button"
            onClick={onRecoverWorkplace}
            disabled={recoveryPending}
            className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-zinc-950 px-3 text-xs font-bold text-white outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-zinc-400"
          >
            {recoveryPending && <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />}
            {recoveryPending ? "Obnovujem…" : "Obnoviť pracovisko"}
          </button>
        )}
      </div>}
    </section>
  );
}

function CallbackInbox({
  busyAction,
  calls,
  onCallBack,
  onComplete,
  onNewCase,
  onSchedule,
}: {
  busyAction: string | null;
  calls: CallCenterCall[];
  onCallBack: (call: CallCenterCall) => void;
  onComplete: (call: CallCenterCall) => void;
  onNewCase: (call: CallCenterCall) => void;
  onSchedule: (call: CallCenterCall) => void;
}) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(calls.length / CALLBACK_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const firstVisibleIndex = (currentPage - 1) * CALLBACK_PAGE_SIZE;
  const visibleCalls = calls.slice(firstVisibleIndex, firstVisibleIndex + CALLBACK_PAGE_SIZE);

  return (
    <section className="rounded-md border border-zinc-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
          <PhoneMissed size={17} />
          Spätné volania
        </div>
        {calls.length > 0 && <StatusBadge label={`${calls.length}`} tone="warn" />}
      </div>
      <div className="grid gap-2 p-3">
        {calls.length > 0 ? (
          visibleCalls.map((call) => (
            <CallbackRow
              key={telephonyCallReactKey(call)}
              busyAction={busyAction}
              call={call}
              onCallBack={() => onCallBack(call)}
              onComplete={() => onComplete(call)}
              onNewCase={() => onNewCase(call)}
              onSchedule={() => onSchedule(call)}
            />
          ))
        ) : (
          <EmptyState icon={CheckCircle2} title="Žiadne callbacky" body="Zmeškané a callback hovory sa zobrazia po zápise v call logu." compact />
        )}
      </div>
      {calls.length > CALLBACK_PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 bg-zinc-50 px-3 py-2">
          <span className="text-[11px] font-medium text-zinc-600">
            {firstVisibleIndex + 1}–{Math.min(firstVisibleIndex + CALLBACK_PAGE_SIZE, calls.length)} z {calls.length}
          </span>
          <nav className="flex items-center gap-1" aria-label="Stránkovanie callbackov">
            <button
              type="button"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              aria-label="Predchádzajúce callbacky"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="min-w-12 text-center text-[11px] font-semibold text-zinc-700">{currentPage} / {pageCount}</span>
            <button
              type="button"
              onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
              disabled={currentPage === pageCount}
              aria-label="Nasledujúce callbacky"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
            >
              <ChevronRight size={14} />
            </button>
          </nav>
        </div>
      )}
    </section>
  );
}

function HistoryPanel({
  busyAction,
  calls,
  cases,
  filter,
  onCallBack,
  onFilterChange,
  onLinkCall,
  onNewCase,
  onOpenCase,
  onOpenDetail,
  totalCalls,
}: {
  busyAction: string | null;
  calls: CallCenterCall[];
  cases: DispatchCase[];
  filter: HistoryFilter;
  onCallBack: (call: CallCenterCall) => void;
  onFilterChange: (filter: HistoryFilter) => void;
  onLinkCall: (call: CallCenterCall, caseId: string) => void;
  onNewCase: (call: CallCenterCall) => void;
  onOpenCase: (caseId: string) => void;
  onOpenDetail: (call: CallCenterCall) => void;
  totalCalls: number;
}) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(calls.length / HISTORY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const firstVisibleIndex = (currentPage - 1) * HISTORY_PAGE_SIZE;
  const visibleCalls = calls.slice(firstVisibleIndex, firstVisibleIndex + HISTORY_PAGE_SIZE);

  function selectFilter(nextFilter: HistoryFilter) {
    setPage(1);
    onFilterChange(nextFilter);
  }

  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-zinc-200 bg-white @container xl:flex xl:h-full xl:min-h-0 xl:flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
          <History size={17} />
          Prehľad hovorov
        </div>
        <span className="text-xs font-semibold text-zinc-500">{totalCalls} záznamov</span>
      </div>
      <div className="border-b border-zinc-200 p-3">
        <div className="flex flex-wrap gap-1">
          {historyFilterOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => selectFilter(option.value)}
              aria-pressed={filter === option.value}
              className={`inline-flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-semibold transition ${
                filter === option.value ? "bg-zinc-950 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {calls.length > 0 ? (
        <div className="xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
          <div className="hidden grid-cols-[100px_minmax(150px,1fr)_minmax(140px,1fr)_130px_170px] gap-3 border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 @4xl:grid">
            <div>Hovor</div>
            <div>Zákazník / volajúci</div>
            <div>Operátor / linka</div>
            <div>Prípad</div>
            <div className="text-right">Akcie</div>
          </div>
          <div className="divide-y divide-zinc-100 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
            {visibleCalls.map((call) => (
              <HistoryCallRow
                key={telephonyCallReactKey(call)}
                busyAction={busyAction}
                call={call}
                cases={cases}
                onCallBack={onCallBack}
                onLinkCall={onLinkCall}
                onNewCase={onNewCase}
                onOpenCase={onOpenCase}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 bg-zinc-50 px-3 py-2.5">
            <span className="text-xs font-medium text-zinc-600">
              {firstVisibleIndex + 1}–{Math.min(firstVisibleIndex + HISTORY_PAGE_SIZE, calls.length)} z {calls.length}
            </span>
            <nav className="flex items-center gap-1" aria-label="Stránkovanie histórie hovorov">
              <button
                type="button"
                onClick={() => setPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                aria-label="Predchádzajúca strana"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
              >
                <ChevronLeft size={15} />
              </button>
              <span className="min-w-16 text-center text-xs font-semibold text-zinc-700">
                {currentPage} / {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
                disabled={currentPage === pageCount}
                aria-label="Nasledujúca strana"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
              >
                <ChevronRight size={15} />
              </button>
            </nav>
          </div>
        </div>
      ) : (
        <EmptyState icon={History} title="Zatiaľ žiadne hovory" body="História čaká na prvý zapísaný hovor." />
      )}
    </section>
  );
}

function HistoryCallRow({
  busyAction,
  call,
  cases,
  onCallBack,
  onLinkCall,
  onNewCase,
  onOpenCase,
  onOpenDetail,
}: {
  busyAction: string | null;
  call: CallCenterCall;
  cases: DispatchCase[];
  onCallBack: (call: CallCenterCall) => void;
  onLinkCall: (call: CallCenterCall, caseId: string) => void;
  onNewCase: (call: CallCenterCall) => void;
  onOpenCase: (caseId: string) => void;
  onOpenDetail: (call: CallCenterCall) => void;
}) {
  const customerNumber = call.direction === "outbound" ? call.calledNumber : call.callerNumber;
  const customerName = call.direction === "outbound" ? undefined : call.callerName;
  const employeeEndpoint = call.direction === "outbound"
    ? call.callerExtension ?? call.callerNumber
    : call.destinationExtension ?? call.destinationNumber ?? call.calledNumber;
  const customerLabel = call.direction === "internal" ? "Volajúci" : "Zákazník";
  const operatorLabel = call.direction === "internal" ? "Volaný / operátor" : "Operátor";
  const operatorName = call.operatorName
    ?? (call.status === "missed" || call.status === "abandoned_queue" || call.status === "failed"
      ? "Nikto neprevzal"
      : call.status === "incoming" || call.status === "ringing_agent"
        ? "Čaká na operátora"
        : "Operátor nezaznamenaný");
  const employeeEndpointLabel = call.direction === "outbound"
    ? `Volané z ${employeeEndpoint}`
    : call.direction === "internal"
      ? `Volaná klapka ${employeeEndpoint}`
      : `Finálny cieľ ${employeeEndpoint}`;
  const DirectionIcon = call.direction === "outbound" ? PhoneOutgoing : call.direction === "internal" ? PhoneCall : PhoneIncoming;
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingState, setRecordingState] = useState<"idle" | "loading" | "error">("idle");
  const hasRecording = call.recordingStatus === "available" && Boolean(call.recordingId);
  const displayedStartedAt = historyDisplayStartedAt(call);

  const toggleRecording = async () => {
    if (recordingUrl) {
      setRecordingUrl(null);
      setRecordingState("idle");
      return;
    }

    setRecordingState("loading");

    try {
      const response = await telephonyFetch(`/api/telephony/recordings/${call.recordingId}/url`, {
        label: "odkaz na nahrávku",
        timeoutMs: TELEPHONY_TIMEOUT_MS.read,
      });
      const result = (await response.json()) as { signedUrl?: string };

      if (!response.ok || !result.signedUrl) {
        setRecordingState("error");
        return;
      }

      setRecordingUrl(result.signedUrl);
      setRecordingState("idle");
    } catch {
      setRecordingState("error");
    }
  };

  return (
    <div className="min-w-0 hover:bg-zinc-50">
      <div className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-3 p-3 text-sm @md:grid-cols-2 @4xl:grid-cols-[100px_minmax(150px,1fr)_minmax(140px,1fr)_130px_170px] @4xl:items-center">
        <div className="flex min-w-0 items-center justify-between gap-3 @md:col-span-2 @4xl:col-span-1 @4xl:block">
          <div className="min-w-0">
            <div className="font-semibold tabular-nums text-zinc-950">{formatTime(displayedStartedAt)}</div>
            <div className="mt-0.5 text-xs tabular-nums text-zinc-500">{formatShortDate(displayedStartedAt)}</div>
            <div className="mt-1 inline-flex max-w-full items-center gap-1 text-xs font-medium text-zinc-600">
              <DirectionIcon size={12} className="shrink-0" />
              <span className="truncate">{directionLabel[call.direction]}</span>
            </div>
          </div>
          <div className="shrink-0 @4xl:mt-2">
            <CallStatusPill status={call.status} />
          </div>
        </div>

        <button type="button" onClick={() => onOpenDetail(call)} className="min-w-0 rounded-md text-left outline-none ring-yellow-300 focus-visible:ring-2" title="Otvoriť detail hovoru">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 @4xl:hidden">{customerLabel}</div>
          <div className="break-all font-semibold text-zinc-950 hover:underline">{formatPhoneNumberForDisplay(customerNumber)}</div>
          <div className="mt-0.5 break-words text-xs leading-5 text-zinc-500">{customerName ?? "Meno nezistené"}</div>
        </button>

        <div className="min-w-0">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 @4xl:hidden">{operatorLabel}</div>
          <div className="break-words font-semibold text-zinc-950">{operatorName}</div>
          <div className="mt-0.5 break-words text-xs leading-5 text-zinc-500">
            {employeeEndpointLabel}
            {` · ${call.lineLabel}`}
            {call.receivedNumber ? ` · volané ${call.receivedNumber}` : ""}
            {call.queueLabel ? ` · rad ${call.queueLabel}` : ""}
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 @4xl:hidden">Prípad</div>
          {call.caseId ? (
            <button
              type="button"
              onClick={() => onOpenCase(call.caseId!)}
              className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
            >
              <Link2 size={13} className="shrink-0" />
              <span className="truncate">{call.caseNumber ?? "Otvoriť"}</span>
            </button>
          ) : (
            <div className="grid min-w-0 gap-1.5">
              <button
                type="button"
                onClick={() => onNewCase(call)}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-yellow-300 px-2 text-xs font-semibold text-zinc-950 hover:bg-yellow-200"
              >
                <PhoneForwarded size={13} className="shrink-0" />
                Nový prípad
              </button>
              <CaseLinkControl call={call} cases={cases} disabled={busyAction === `${call.id}:link`} onLink={(caseId) => onLinkCall(call, caseId)} />
            </div>
          )}
        </div>

        <div className="min-w-0 @md:col-span-2 @4xl:col-span-1">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 @4xl:hidden">Akcie</div>
          <div className="flex min-w-0 flex-wrap gap-1.5 @4xl:justify-end">
            {hasRecording ? (
              <button
                type="button"
                onClick={toggleRecording}
                aria-expanded={Boolean(recordingUrl)}
                title={recordingUrl ? "Skryť nahrávku" : "Prehrať nahrávku"}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
              >
                {recordingState === "loading" ? <Loader2 size={13} className="animate-spin" /> : <Headphones size={13} />}
                Nahrávka
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onCallBack(call)}
              disabled={phoneScopeBusy(busyAction)}
              title="Volať späť"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-300"
            >
              {busyAction === `${call.id}:call_back` ? <Loader2 size={13} className="animate-spin" /> : <PhoneOutgoing size={13} />}
              Volať
            </button>
          </div>
        </div>
      </div>
      {recordingUrl ? (
        <div className="border-t border-zinc-100 bg-zinc-50 px-3 py-3">
          <div className="mb-2 text-xs font-semibold text-zinc-700">Nahrávka hovoru</div>
          <audio controls autoPlay src={recordingUrl} className="h-9 w-full" />
        </div>
      ) : null}
      {recordingState === "error" ? (
        <div className="border-t border-red-100 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">Nahrávku sa nepodarilo načítať. Skús to znova alebo skontroluj oprávnenia.</div>
      ) : null}
    </div>
  );
}

function PhonebookPanel({
  busyAction,
  onQuickCall,
}: {
  busyAction: string | null;
  onQuickCall: (entry: PhonebookEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<"favorites" | "all">("favorites");
  const [contacts, setContacts] = useState<TelephonyDirectoryContact[]>([]);
  const [favorites, setFavorites] = useState<TelephonyDirectoryContact[]>([]);
  const [searchResults, setSearchResults] = useState<TelephonyDirectoryContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [favoritePendingId, setFavoritePendingId] = useState<string | null>(null);
  const [addFavoriteOpen, setAddFavoriteOpen] = useState(false);
  const [favoriteName, setFavoriteName] = useState("");
  const [favoritePhone, setFavoritePhone] = useState("");
  const [createFavoritePending, setCreateFavoritePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedQuery = normalizeSearch(query);
  const searchedContacts = normalizedQuery.length >= 2 ? searchResults : contacts;
  const visibleContacts = (section === "favorites" ? favorites : searchedContacts)
    .filter((contact) => normalizeSearch(`${contact.name} ${contact.phone} ${contact.email ?? ""}`).includes(normalizedQuery));

  useEffect(() => {
    const controller = new AbortController();

    async function loadDirectory() {
      setLoading(true);

      try {
        const [directoryResponse, favoritesResponse] = await Promise.all([
          telephonyFetch("/api/telephony/directory", { label: "adresár", signal: controller.signal, timeoutMs: TELEPHONY_TIMEOUT_MS.read }),
          telephonyFetch("/api/telephony/directory/favorites", { label: "obľúbené kontakty", signal: controller.signal, timeoutMs: TELEPHONY_TIMEOUT_MS.read }),
        ]);
        const directory = await readDirectoryResponse<TelephonyDirectoryResponse>(directoryResponse);
        const savedFavorites = await readDirectoryResponse<TelephonyFavoritesResponse>(favoritesResponse);
        setContacts(directory.contacts);
        setFavorites(savedFavorites.favorites);
        setError(null);
      } catch (loadError) {
        if (!isAbortError(loadError)) {
          setError(messageFromError(loadError, "Telefónny zoznam sa nepodarilo načítať."));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadDirectory();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (normalizedQuery.length < 2 || section !== "all") {
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setSearching(true);

      try {
        const params = new URLSearchParams({ q: query.trim() });
        const response = await telephonyFetch(`/api/telephony/directory?${params.toString()}`, {
          label: "hľadanie v adresári",
          signal: controller.signal,
          timeoutMs: TELEPHONY_TIMEOUT_MS.read,
        });
        const result = await readDirectoryResponse<TelephonyDirectoryResponse>(response);
        setSearchResults(result.contacts);
        setError(null);
      } catch (searchError) {
        if (!isAbortError(searchError)) {
          setSearchResults([]);
          setError(messageFromError(searchError, "Telefónny zoznam sa nepodarilo prehľadať."));
        }
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [normalizedQuery, query, section]);

  async function toggleFavorite(contact: TelephonyDirectoryContact) {
    if (favoritePendingId) return;
    setFavoritePendingId(contact.id);
    setError(null);

    try {
      const response = await telephonyFetch(`/api/telephony/directory/favorites/${encodeURIComponent(contact.id)}`, {
        method: contact.isFavorite ? "DELETE" : "PUT",
        headers: { "Content-Type": "application/json" },
        label: "obľúbený kontakt",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      const result = await readDirectoryResponse<TelephonyFavoriteMutationResponse>(response);
      const updated = { ...(result.contact ?? contact), isFavorite: result.isFavorite };
      const updateContact = (item: TelephonyDirectoryContact) => (item.id === contact.id ? updated : item);

      setContacts((current) => current.map(updateContact));
      setSearchResults((current) => current.map(updateContact));
      setFavorites((current) =>
        result.isFavorite
          ? [updated, ...current.filter((item) => item.id !== contact.id)]
          : current.filter((item) => item.id !== contact.id),
      );
    } catch (favoriteError) {
      setError(messageFromError(favoriteError, "Obľúbený kontakt sa nepodarilo zmeniť."));
    } finally {
      setFavoritePendingId(null);
    }
  }

  async function createFavorite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createFavoritePending) return;

    setCreateFavoritePending(true);
    setError(null);
    try {
      const response = await telephonyFetch("/api/telephony/directory/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: favoriteName, phone: favoritePhone }),
        label: "nový obľúbený kontakt",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      const result = await readDirectoryResponse<TelephonyFavoriteCreateResponse>(response);
      const contact = result.contact;
      const replaceContact = (items: TelephonyDirectoryContact[]) => [
        contact,
        ...items.filter((item) => item.id !== contact.id),
      ];

      setContacts((current) => replaceContact(current).sort((left, right) => left.name.localeCompare(right.name, "sk")));
      setSearchResults((current) => current.map((item) => item.id === contact.id ? contact : item));
      setFavorites((current) => replaceContact(current));
      setFavoriteName("");
      setFavoritePhone("");
      setAddFavoriteOpen(false);
      setSection("favorites");
    } catch (favoriteError) {
      setError(messageFromError(favoriteError, "Obľúbený kontakt sa nepodarilo uložiť."));
    } finally {
      setCreateFavoritePending(false);
    }
  }

  return (
    <section className="min-w-0 max-w-full overflow-hidden rounded-md border border-zinc-200 bg-white xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-200 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
          <BookUser size={17} />
          Telefónny zoznam
        </div>
        <div className="flex items-center gap-1.5">
          <StatusBadge label={`${contacts.length}`} tone="neutral" />
          <button
            type="button"
            onClick={() => {
              setAddFavoriteOpen((current) => !current);
              setError(null);
            }}
            aria-expanded={addFavoriteOpen}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-bold transition ${
              addFavoriteOpen ? "bg-zinc-950 text-white" : "bg-yellow-100 text-zinc-900 hover:bg-yellow-200"
            }`}
          >
            {addFavoriteOpen ? <X size={13} /> : <Plus size={13} />}
            {addFavoriteOpen ? "Zavrieť" : "Pridať"}
          </button>
        </div>
      </div>
      {addFavoriteOpen && (
        <form onSubmit={createFavorite} className="grid gap-2 border-b border-yellow-200 bg-yellow-50/70 p-3" aria-label="Pridať obľúbený kontakt">
          <div>
            <div className="text-xs font-bold text-zinc-900">Nový obľúbený kontakt</div>
            <div className="mt-0.5 text-[11px] leading-4 text-zinc-600">Stačí meno a číslo. Kontakt sa uloží aj do spoločného telefónneho zoznamu.</div>
          </div>
          <label className="grid gap-1 text-[11px] font-semibold text-zinc-700">
            Meno
            <input
              value={favoriteName}
              onChange={(event) => setFavoriteName(event.target.value)}
              required
              maxLength={80}
              autoFocus
              placeholder="Napr. Odťahová služba Martin"
              className="h-9 min-w-0 rounded-md border border-zinc-300 bg-white px-2.5 text-sm font-medium outline-none ring-yellow-300 focus:ring-2"
            />
          </label>
          <label className="grid gap-1 text-[11px] font-semibold text-zinc-700">
            Telefónne číslo
            <input
              type="tel"
              inputMode="tel"
              value={favoritePhone}
              onChange={(event) => setFavoritePhone(event.target.value)}
              required
              placeholder="+421 900 000 000"
              className="h-9 min-w-0 rounded-md border border-zinc-300 bg-white px-2.5 text-sm font-medium outline-none ring-yellow-300 focus:ring-2"
            />
          </label>
          <button
            type="submit"
            disabled={createFavoritePending || !favoriteName.trim() || !favoritePhone.trim()}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-zinc-950 px-3 text-xs font-bold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:bg-zinc-300"
          >
            {createFavoritePending ? <Loader2 size={14} className="animate-spin" /> : <Star size={14} />}
            Uložiť medzi obľúbené
          </button>
        </form>
      )}
      <div className="grid min-w-0 gap-3 p-3 xl:min-h-0 xl:flex xl:flex-1 xl:flex-col">
        <div className="grid grid-cols-2 gap-1 rounded-md bg-zinc-100 p-1">
          <PhonebookTab
            active={section === "favorites"}
            icon={Star}
            label="Obľúbené"
            onClick={() => {
              setSection("favorites");
              setSearching(false);
            }}
          />
          <PhonebookTab active={section === "all"} icon={BookUser} label="Zoznam" onClick={() => setSection("all")} />
        </div>
        <label className="relative block">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              setError(null);
              if (normalizeSearch(nextQuery).length < 2) {
                setSearching(false);
                setSearchResults([]);
              }
            }}
            placeholder="Hľadať číslo alebo kontakt"
            className="h-9 w-full rounded-md border border-zinc-200 bg-white pl-9 pr-9 text-sm outline-none ring-yellow-300 transition focus:ring-2"
          />
          {searching && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-zinc-400" />}
        </label>
        {error && <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs font-medium text-red-800" role="alert">{error}</div>}
        <div className="grid min-w-0 max-w-full max-h-[28rem] content-start gap-2 overflow-x-hidden overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] xl:max-h-none xl:min-h-0 xl:flex-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 rounded-md bg-zinc-50 px-3 py-6 text-sm text-zinc-500">
              <Loader2 size={16} className="animate-spin" />
              Načítavam kontakty…
            </div>
          ) : visibleContacts.length > 0 ? (
            visibleContacts.map((contact) => {
              const entry = phonebookEntryFromContact(contact);
              const busy = busyAction === `quick:${entry.id}`;
              const EntryIcon = phonebookEntryIcon[entry.type];

              return (
                <div key={entry.id} className="min-w-0 rounded-md border border-zinc-200 bg-zinc-50 p-2">
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                    <div className="flex min-w-0 gap-2">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white text-zinc-500 ring-1 ring-zinc-200">
                        <EntryIcon size={14} />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-zinc-950">{entry.label}</div>
                        <div className="truncate text-xs text-zinc-600">{entry.detail}</div>
                        <div className="mt-1 truncate text-xs font-semibold text-zinc-800">{entry.phone}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void toggleFavorite(contact)}
                        disabled={favoritePendingId !== null}
                        aria-label={contact.isFavorite ? `Odobrať ${contact.name} z obľúbených` : `Pridať ${contact.name} medzi obľúbené`}
                        aria-pressed={contact.isFavorite}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white text-zinc-400 ring-1 ring-zinc-200 hover:text-amber-500 disabled:opacity-50"
                      >
                        {favoritePendingId === contact.id ? <Loader2 size={14} className="animate-spin" /> : <Star size={14} className={contact.isFavorite ? "fill-amber-400 text-amber-500" : ""} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => onQuickCall(entry)}
                        disabled={phoneScopeBusy(busyAction)}
                        title={`Volať ${entry.label}`}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-950 text-white hover:bg-zinc-800 disabled:bg-zinc-300"
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <PhoneOutgoing size={13} />}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <EmptyState
              icon={section === "favorites" ? Star : BookUser}
              title={section === "favorites" ? "Zatiaľ bez obľúbených" : "Bez výsledkov"}
              body={section === "favorites" ? "V Zozname označ kontakt hviezdičkou a zobrazí sa tu." : "Nenašli sa žiadne kontakty s telefónnym číslom."}
              compact
            />
          )}
        </div>
      </div>
    </section>
  );
}

function PhonebookTab({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-semibold ${
        active ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-600 hover:text-zinc-950"
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function CallModeTab({
  active,
  disabled = false,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-md text-xs font-semibold ${
        active ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-600 hover:text-zinc-950 disabled:text-zinc-400"
      }`}
    >
      <Icon size={14} />
      <span className="truncate">{label}</span>
    </button>
  );
}

function CommandMetric({ icon: Icon, label, tone, value }: { icon: LucideIcon; label: string; tone: "ok" | "warn" | "neutral" | "bad"; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-zinc-50 px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-normal text-zinc-500">
        <Icon size={13} className={tone === "warn" ? "text-amber-600" : tone === "ok" ? "text-emerald-600" : tone === "bad" ? "text-red-600" : "text-zinc-500"} />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 truncate text-sm font-semibold text-zinc-950">{value}</div>
    </div>
  );
}

function EmptyState({
  body,
  compact = false,
  icon: Icon,
  title,
}: {
  body: string;
  compact?: boolean;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div className={`grid justify-items-center rounded-md bg-zinc-50 px-3 text-center ${compact ? "py-4" : "py-8"}`}>
      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-white text-zinc-500 ring-1 ring-zinc-200">
        <Icon size={19} />
      </div>
      <div className="mt-2 text-sm font-semibold text-zinc-950">{title}</div>
      <div className="mt-1 max-w-[320px] text-xs leading-5 text-zinc-600">{body}</div>
    </div>
  );
}

function CaseLinkControl({
  call,
  cases,
  disabled,
  onLink,
}: {
  call: CallCenterCall;
  cases: DispatchCase[];
  disabled: boolean;
  onLink: (caseId: string) => void;
}) {
  const [caseId, setCaseId] = useState(cases[0]?.id ?? "");
  const canLink = looksLikeUuid(call.id) && caseId && !disabled;

  if (cases.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-[1fr_auto] gap-1">
      <div className="relative min-w-0">
        <select
          value={caseId}
          onChange={(event) => setCaseId(event.target.value)}
          aria-label="Priradiť k existujúcemu prípadu"
          className="h-8 w-full min-w-0 appearance-none truncate rounded-md border border-zinc-200 bg-white pl-2 pr-8 text-xs outline-none ring-yellow-300 transition focus:ring-2"
        >
          {cases.slice(0, 25).map((caseItem) => (
            <option key={caseItem.id} value={caseItem.id}>
              {caseItem.caseNumber}
            </option>
          ))}
        </select>
        <ChevronDown size={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500" />
      </div>
      <button
        type="button"
        onClick={() => onLink(caseId)}
        disabled={!canLink}
        title={looksLikeUuid(call.id) ? "Priradiť hovor k prípadu" : "Hovor ešte nie je uložený v Supabase call logu"}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-300"
      >
        {disabled ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
      </button>
    </div>
  );
}

function AvailabilityButton({
  active,
  disabled,
  icon: Icon,
  label,
  pending,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: LucideIcon;
  label: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold transition ${
        active
          ? "bg-[#FCD703] text-zinc-950 shadow-sm"
          : "bg-white text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
      }`}
    >
      {pending ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Icon size={14} />}
      {label}
    </button>
  );
}

function CallbackRow({
  busyAction,
  call,
  onCallBack,
  onComplete,
  onNewCase,
  onSchedule,
}: {
  busyAction: string | null;
  call: CallCenterCall;
  onCallBack: () => void;
  onComplete: () => void;
  onNewCase: () => void;
  onSchedule: () => void;
}) {
  const busy = busyAction?.startsWith(`${call.id}:`);
  const displayedStartedAt = historyDisplayStartedAt(call);

  return (
    <div className="rounded-md bg-amber-50 px-3 py-2 text-sm">
      <div className="flex items-center gap-2 font-semibold text-zinc-950">
        <AlertTriangle size={14} className="text-amber-700" />
        {formatPhoneNumberForDisplay(call.callerNumber)}
      </div>
      <div className="mt-0.5 text-xs text-zinc-600">{formatTime(displayedStartedAt)} · čakal {call.waitSeconds}s</div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" onClick={onCallBack} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-950 px-2 text-xs font-semibold text-white hover:bg-zinc-800 disabled:bg-zinc-300">
          {busyAction === `${call.id}:call_back` ? <Loader2 size={13} className="animate-spin" /> : <PhoneOutgoing size={13} />}
          Volať späť
        </button>
        <button type="button" onClick={onSchedule} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-200 bg-white px-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:text-zinc-300">
          {busyAction === `${call.id}:callback` ? <Loader2 size={13} className="animate-spin" /> : <Clock3 size={13} />}
          Naplánovať
        </button>
        <button type="button" onClick={onComplete} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-300">
          {busyAction === `${call.id}:reached` ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          Vybavené
        </button>
        <button type="button" onClick={onNewCase} disabled={busy} className="inline-flex h-8 items-center rounded-md border border-zinc-200 bg-white px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-300">
          Nový prípad
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: "ok" | "warn" | "neutral" | "bad" }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass[tone]}`}>{label}</span>;
}

function CallStatusPill({ status }: { status: CallCenterCall["status"] }) {
  return <StatusBadge label={callCenterStatusLabel[status]} tone={callTone(status)} />;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("sk-SK", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
  }).format(new Date(value));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("sk-SK", {
    day: "2-digit",
    month: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
    year: "numeric",
  }).format(new Date(value));
}

function filterHistoryCalls(calls: CallCenterCall[], filter: HistoryFilter) {
  if (filter === "all") {
    return calls;
  }

  if (filter === "inbound") {
    return calls.filter((call) => call.direction === "inbound");
  }

  if (filter === "outbound") {
    return calls.filter((call) => call.direction === "outbound");
  }

  if (filter === "answered") {
    return calls.filter((call) => call.status === "answered" || call.status === "ended" || call.outcome === "reached");
  }

  if (filter === "missed") {
    return calls.filter((call) => call.status === "missed" || call.status === "abandoned_queue" || call.status === "failed" || call.outcome === "not_reached");
  }

  return calls.filter((call) => call.outcome === "callback" || call.callbackMinutes);
}

function phonebookEntryFromContact(contact: TelephonyDirectoryContact): PhonebookEntry {
  return {
    id: `contact:${contact.id}`,
    detail: contactRoleLabel[contact.role],
    label: contact.name,
    phone: contact.phone,
    type: "contact",
  };
}

async function readDirectoryResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;

  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : "Požiadavku sa nepodarilo dokončiť.");
  }

  if (!payload) {
    throw new Error("Server vrátil neplatnú odpoveď.");
  }

  return payload;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function availabilityGuidance(
  state: TelephonyOperatorPresenceState,
  extension: string,
  busy: boolean,
  verified: boolean,
  queueNeedsOperator: boolean,
) {
  if (state === "unassigned") return "Vyber si pracovisko. Po pripojení telefónu ťa systém automaticky nastaví ako Dostupný pre prichádzajúce hovory.";
  if (!verified) return "Tvoj stav sa teraz nedá bezpečne overiť. Po obnovení spojenia sa ovládanie znovu sprístupní.";
  if (state === "available") return "Si dostupný a môžeš prijímať hovory z radu.";
  if (state === "ringing") return `Interná linka ${extension} zvoní — prijmi hovor na telefóne alebo v prehliadači.`;
  if (state === "on_call" || busy) return `Interná linka ${extension} práve vybavuje hovor. Po ukončení sa automaticky vráti do nastaveného pracovného stavu.`;
  if (state === "paused") return "Si na pauze. Keď môžeš prijímať hovory, klikni na Dostupný.";
  if (state === "unregistered") return `Interná linka ${extension} nie je pripojená. Pripoj telefón alebo telefonovanie v prehliadači a potom nastav Dostupný.`;
  if (state === "offline") {
    return queueNeedsOperator
      ? "Si mimo radu a čaká v ňom hovor bez voľného operátora. Ak môžeš pracovať, klikni na Dostupný."
      : "Si mimo radu a hovory z neho k tebe nepôjdu. Keď začneš pracovať, klikni na Dostupný.";
  }
  return "Stav operátora je zastaraný alebo chybný. Počkaj na obnovenie údajov a nemeň stav naslepo.";
}

export function historyDisplayStartedAt(
  call: Pick<CallCenterCall, "createdAt" | "startedAt">,
  now = Date.now(),
) {
  const startedAt = Date.parse(call.startedAt);
  const createdAt = Date.parse(call.createdAt ?? "");
  // Rows reconciled before the parser fix contain the Bratislava wall clock
  // mislabeled as UTC: +1 hour in winter and +2 hours in summer.
  const cdrWallClockSkew = startedAt - createdAt;
  const resemblesLegacyCdrOffset = (
    cdrWallClockSkew >= 55 * 60_000 && cdrWallClockSkew <= 65 * 60_000
  ) || (
    cdrWallClockSkew >= 115 * 60_000 && cdrWallClockSkew <= 125 * 60_000
  );
  if (
    Number.isFinite(startedAt) && Number.isFinite(createdAt) && createdAt <= now + 60_000 &&
    (startedAt > now + 60_000 || resemblesLegacyCdrOffset)
  ) {
    return call.createdAt as string;
  }
  return call.startedAt;
}

function normalizeSearch(value: string) {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const presenceStateLabel: Record<TelephonyOperatorPresenceState, string> = {
  available: "dostupný",
  ringing: "zvoní",
  on_call: "na hovore",
  paused: "pauza",
  unregistered: "neregistrovaný",
  offline: "mimo radu",
  unassigned: "bez pracoviska",
  stale: "zastarané",
  error: "chyba",
};

function callTone(status: CallCenterCall["status"]): "ok" | "warn" | "neutral" | "bad" {
  if (status === "answered" || status === "outbound") {
    return "ok";
  }

  if (status === "incoming" || status === "ringing_agent") {
    return "warn";
  }

  if (status === "missed" || status === "abandoned_queue" || status === "failed") {
    return "bad";
  }

  return "neutral";
}

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const badgeClass = {
  ok: "bg-emerald-100 text-emerald-800",
  warn: "bg-amber-100 text-amber-900",
  neutral: "bg-zinc-100 text-zinc-700",
  bad: "bg-red-100 text-red-800",
};

const phonebookEntryIcon: Record<PhonebookEntry["type"], LucideIcon> = {
  contact: UserRound,
};

const contactRoleLabel: Record<TelephonyDirectoryContact["role"], string> = {
  client: "Klient",
  assistance: "Asistenčná služba",
  branch: "Pobočka",
  partner: "Partner",
};

const callCenterStatusLabel: Record<CallCenterCall["status"], string> = {
  incoming: callStatusLabels.incoming,
  ringing_agent: callStatusLabels.ringing_agent,
  answered: callStatusLabels.answered,
  missed: callStatusLabels.missed,
  abandoned_queue: "opustený rad",
  outbound: callStatusLabels.outbound,
  ended: callStatusLabels.ended,
  failed: "zlyhalo",
};

const directionLabel: Record<CallCenterCall["direction"], string> = {
  inbound: "Prichádzajúci",
  outbound: "Odchádzajúci",
  internal: "Interný",
};

const historyFilterOptions: Array<{ label: string; value: HistoryFilter }> = [
  { label: "Všetky", value: "all" },
  { label: "Prichádzajúce", value: "inbound" },
  { label: "Odchádzajúce", value: "outbound" },
  { label: "Prijaté", value: "answered" },
  { label: "Zmeškané", value: "missed" },
  { label: "Spätné volanie", value: "callback" },
];
