"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BookUser,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  History,
  Link2,
  Loader2,
  LogOut,
  Pause,
  PhoneCall,
  PhoneForwarded,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Plus,
  Search,
  Star,
  UserRound,
  X,
} from "lucide-react";
import type { CallCenterCall, CallOutcome, DispatchData } from "@/data/dispatch-types";
import type { DispatchCase, DispatchMetrics, Operator } from "@/domain/types";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import { callStatusLabels } from "@/domain/statuses";
import { CallbackQueuePanel } from "./CallbackQueuePanel";
import { CallDetailDrawer } from "./CallDetailDrawer";
import { CallQueuePanel } from "./CallQueuePanel";
import { callElapsedSeconds, formatCallTimer, phoneBarStateLabel, type PhoneCallAction } from "./phone-bar-model";
import type {
  TelephonyDirectoryContact,
  TelephonyDirectoryResponse,
  TelephonyFavoriteCreateResponse,
  TelephonyFavoriteMutationResponse,
  TelephonyFavoritesResponse,
} from "@/lib/telephony/directory";
import type { PhoneBarModel, WaitingRoomRow } from "@/lib/telephony/active-calls-model";
import type { WebphoneSnapshot } from "@/lib/telephony/telnyx-webphone";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";
import type {
  TelephonyAvailabilityAction,
  TelephonyOperatorPresence,
  TelephonyOperatorPresenceState,
} from "@/lib/telephony/presence";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";

type CallCenterModuleProps = {
  /** Live telephony surface; `undefined` while no provider is configured. */
  activeSnapshot?: PhoneBarModel;
  /** Waiting room rows (`CallCenterCall` plus who parked the caller). */
  waitingCalls?: WaitingRoomRow[];
  telephonyConfigured?: boolean;
  /** Browser-phone registration, shown next to the operator's own status. */
  phone?: WebphoneSnapshot;
  busyCallAction?: string | null;
  onCallAction?: (action: PhoneCallAction, sessionId: string) => void;
  calls: CallCenterCall[];
  cases: DispatchCase[];
  dataSource: DispatchData["source"];
  currentOperatorId?: string;
  metrics: DispatchMetrics;
  operatorPresences: TelephonyOperatorPresence[];
  operators: Operator[];
  onDataChange: (data: DispatchData) => void;
  onDial: (phone: string, caseId?: string) => Promise<void>;
  onNewCase: (call?: CallCenterCall) => void;
  onOpenCase: (caseId: string) => void;
  onAvailabilityAction: (action: TelephonyAvailabilityAction) => void;
  /** Console-owned outbound path for the callback queue (arms the browser phone). */
  onCallbackCall?: (requestId: string) => Promise<void>;
  onTelephonyChanged: () => void;
};

type HistoryFilter = "all" | "inbound" | "outbound" | "answered" | "missed" | "callback";
const CALLBACK_PAGE_SIZE = 3;
const HISTORY_PAGE_SIZE = 8;

/**
 * Scopes for the module's "an action is running" lock. Only actions that
 * contend for the same resource block each other: `phone` for dialling and
 * `call:<id>` for per-call bookkeeping (outcome, case link).
 */
type BusyActionScope = "phone" | `call:${string}`;

const BUSY_ACTION_DEADLINE_MS: Record<"phone" | "call", number> = {
  phone: 20_000,
  call: 25_000,
};

function busyActionScope(key: string | null): BusyActionScope | null {
  if (!key) return null;
  if (key.startsWith("quick:")) return "phone";
  const separator = key.lastIndexOf(":");
  if (separator <= 0) return null;
  const callId = key.slice(0, separator);
  const action = key.slice(separator + 1);
  if (action === "call_back") return "phone";
  return `call:${callId}`;
}

function busyActionDeadlineMs(scope: BusyActionScope | null) {
  if (!scope) return 0;
  return scope === "phone" ? BUSY_ACTION_DEADLINE_MS.phone : BUSY_ACTION_DEADLINE_MS.call;
}

/** True when a dial is already in flight. */
function phoneScopeBusy(key: string | null) {
  return busyActionScope(key) === "phone";
}

/** Whether starting `next` must wait for `current`: same scope blocks, others never do. */
function busyActionBlocks(current: string | null, next: string) {
  const currentScope = busyActionScope(current);
  if (!currentScope) return false;
  return currentScope === busyActionScope(next);
}

const LIVE_CALL_STATUSES = new Set<CallCenterCall["status"]>(["incoming", "ringing_agent", "answered", "outbound"]);

function partitionLiveCalls(calls: CallCenterCall[]) {
  return {
    active: calls.filter((call) => LIVE_CALL_STATUSES.has(call.status)),
    completed: calls.filter((call) => !LIVE_CALL_STATUSES.has(call.status)),
  };
}

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

export function CallCenterModule({
  activeSnapshot,
  waitingCalls = [],
  telephonyConfigured = false,
  phone,
  busyCallAction = null,
  onCallAction,
  calls,
  cases,
  dataSource,
  currentOperatorId,
  metrics,
  operatorPresences,
  onDataChange,
  onDial,
  onNewCase,
  onOpenCase,
  onAvailabilityAction,
  onCallbackCall,
  onTelephonyChanged,
  operators,
}: CallCenterModuleProps) {
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [detailCall, setDetailCall] = useState<CallCenterCall | null>(null);
  // Status is the authoritative lifecycle marker. Without a provider nothing
  // is live, but a stale row must still not be mistaken for history.
  const partitionedCalls = useMemo(() => partitionLiveCalls(calls), [calls]);
  // Durations are measured against the snapshot the rows came from, so the list
  // stays consistent with the data instead of drifting between renders.
  const waitingRoomNow = useMemo(() => {
    const parsed = Date.parse(activeSnapshot?.checkedAt ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  }, [activeSnapshot?.checkedAt]);
  const activeCalls = partitionedCalls.active;
  const storedCalls = useMemo(
    () => (dataSource === "supabase" ? partitionedCalls.completed : []),
    [dataSource, partitionedCalls],
  );
  const missedCalls = storedCalls.filter((call) => ["missed", "abandoned_queue", "failed"].includes(call.status) || call.outcome === "callback");
  const filteredHistoryCalls = filterHistoryCalls(storedCalls, historyFilter);
  const primaryQueueWait = activeCalls.filter((call) => call.status === "incoming" || call.status === "ringing_agent").length;
  const currentPresence = currentOperatorId
    ? operatorPresences.find((presence) => presence.profileId === currentOperatorId)
    : undefined;
  const currentOperator = currentOperatorId
    ? operators.find((operator) => operator.id === currentOperatorId)
    : undefined;
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

  /** Returns true when the dial was accepted (the dialer keeps the number otherwise). */
  async function startQuickCall(entry: PhonebookEntry): Promise<boolean> {
    if (busyActionBlocks(busyAction, `quick:${entry.id}`) || !entry.phone.trim()) {
      return false;
    }

    const busyKey = `quick:${entry.id}`;
    setBusyAction(busyKey);
    setActionNotice(null);

    try {
      await onDial(entry.phone);
      setActionNotice(`Volanie na ${entry.label} bolo spustené.`);
      onTelephonyChanged();
      return true;
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : "Hovor sa nepodarilo spustiť.");
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-zinc-50 p-3 sm:p-4 xl:flex xl:flex-col xl:overflow-y-hidden">
      <OperatorAvailabilityPanel
        configured={telephonyConfigured}
        phone={phone}
        currentOperatorName={currentPresence?.operatorName ?? currentOperator?.name}
        myPresence={currentPresence}
        onAction={onAvailabilityAction}
      />

      {telephonyConfigured && activeSnapshot && (
        <LiveCallsPanel
          busyAction={busyCallAction}
          model={activeSnapshot}
          onAction={onCallAction}
          onNewCase={onNewCase}
          onOpenCase={onOpenCase}
        />
      )}

      {telephonyConfigured && (
        <div className="mb-4 overflow-hidden rounded-md border border-amber-200">
          <CallQueuePanel
            calls={waitingCalls}
            now={waitingRoomNow}
            onPickup={(call) => onCallAction?.("pickup", call.providerSessionId ?? call.id)}
            pickupState={() => ({
              disabled: busyCallAction !== null || Boolean(activeSnapshot?.active),
              label: busyCallAction === "pickup" ? "Preberám…" : "Prevziať hovor",
              ...(activeSnapshot?.active ? { reason: "Najprv ukončite alebo odložte prebiehajúci hovor." } : {}),
            })}
            variant="embedded"
          />
        </div>
      )}

      {actionNotice && <div className="mb-3 shrink-0 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900">{actionNotice}</div>}

      <div className="xl:min-h-0 xl:flex-1">
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
              activeCount={activeCalls.length}
              busy={phoneScopeBusy(busyAction)}
              configured={telephonyConfigured}
              metrics={metrics}
              missedCount={missedCalls.length}
              onDial={(phone) => startQuickCall({ id: "manual", detail: phone, label: phone, phone, type: "contact" })}
              primaryQueueWait={primaryQueueWait}
            />
            <CallbackQueuePanel
              configured={telephonyConfigured}
              onCallBack={onCallbackCall}
              onChanged={onTelephonyChanged}
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

      <CallDetailDrawer call={detailCall} open={Boolean(detailCall)} onClose={() => setDetailCall(null)} onNewCase={onNewCase} />
    </main>
  );
}

/**
 * Dialer. Every control is disabled until a telephony provider is configured;
 * the panel keeps its place in the layout either way, so the module reads the
 * same in both modes.
 */
function CallCommandPanel({
  activeCount,
  busy,
  configured,
  metrics,
  missedCount,
  onDial,
  primaryQueueWait,
}: {
  activeCount: number;
  busy: boolean;
  configured: boolean;
  metrics: DispatchMetrics;
  missedCount: number;
  /** Resolves true when the dial was accepted; the number is kept on failure. */
  onDial: (phone: string) => Promise<boolean>;
  primaryQueueWait: number;
}) {
  const [toNumber, setToNumber] = useState("");

  return (
    <section className="rounded-md border border-zinc-200 bg-white" aria-label="Odchádzajúci hovor">
      <div className="border-b border-zinc-200 p-3">
        <div className="flex min-w-0 items-start gap-2">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${configured ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-600"}`}>
            {configured ? <PhoneOutgoing size={18} aria-hidden="true" /> : <PhoneOff size={18} aria-hidden="true" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-zinc-950">Odchádzajúci hovor</span>
              <StatusBadge label={configured ? "pripravené" : "nenakonfigurované"} tone={configured ? "ok" : "neutral"} />
            </div>
            <div className="mt-1 text-xs font-medium leading-5 text-zinc-600">
              {configured
                ? "Hovor sa najprv spojí s tvojím telefónom v prehliadači, potom sa vytočí zákazník."
                : `${TELEPHONY_NOT_CONFIGURED_MESSAGE} Volať bude možné po zapojení telefónneho poskytovateľa.`}
            </div>
          </div>
        </div>
      </div>

      <form
        className="grid gap-3 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!configured || busy || !toNumber.trim()) return;
          // The dial can be refused (kill switch, allowlist, offline phone):
          // keep the number so the operator can retry, and never float the
          // promise (the parent handler renders the reason).
          void onDial(toNumber.trim())
            .then((accepted) => {
              if (accepted) setToNumber("");
            })
            .catch(() => setToNumber(toNumber.trim()));
        }}
      >
        <div className="grid min-w-0 gap-2">
          <input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={toNumber}
            onChange={(event) => setToNumber(event.target.value)}
            placeholder="+421 900 000 000"
            aria-label="Číslo"
            disabled={!configured}
            className="h-11 min-w-0 rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none ring-yellow-300 transition focus:ring-2 disabled:bg-zinc-50 disabled:text-zinc-400"
          />
          <div>
            <button
              type="submit"
              disabled={!configured || busy || toNumber.trim().length === 0}
              title={configured ? undefined : TELEPHONY_NOT_CONFIGURED_MESSAGE}
              className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:bg-zinc-300 disabled:text-zinc-600"
            >
              {busy ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" /> : <PhoneOutgoing size={15} />}
              Volať
            </button>
          </div>
          {!configured && (
            <div role="status" aria-live="polite" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-950">
              {TELEPHONY_NOT_CONFIGURED_MESSAGE}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <CommandMetric icon={PhoneIncoming} label="Prebieha" value={configured ? String(activeCount) : "—"} tone={configured ? (activeCount > 0 ? "warn" : "ok") : "neutral"} />
          <CommandMetric icon={Clock3} label="Čaká" value={configured ? String(primaryQueueWait) : "—"} tone={configured ? (primaryQueueWait > 0 ? "warn" : "ok") : "neutral"} />
          <CommandMetric icon={PhoneMissed} label="Spätné" value={String(missedCount)} tone={missedCount > 0 ? "warn" : "ok"} />
          <CommandMetric icon={CheckCircle2} label="Úspešnosť" value={`${metrics.answerRate}%`} tone="neutral" />
        </div>
      </form>
    </section>
  );
}

/**
 * Live calls of the whole team (design §2.4): what is ringing, who is on which
 * line and how long. The operator's own call is controlled from the top call
 * bar; here every row can at least be opened, turned into a case, or — for the
 * operator who owns it — hung up.
 */
function LiveCallsPanel({
  busyAction,
  model,
  onAction,
  onNewCase,
  onOpenCase,
}: {
  busyAction: string | null;
  model: PhoneBarModel;
  onAction?: (action: PhoneCallAction, sessionId: string) => void;
  onNewCase: (call?: CallCenterCall) => void;
  onOpenCase: (caseId: string) => void;
}) {
  const rows = [...(model.active ? [model.active] : []), ...model.offers];
  const now = useMemo(() => {
    const parsed = Date.parse(model.checkedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [model.checkedAt]);

  return (
    <section className="mb-4 shrink-0 rounded-md border border-zinc-200 bg-white" aria-label="Prebiehajúce hovory">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
          <PhoneCall size={17} aria-hidden="true" />
          Moje hovory
        </div>
        {model.otherActiveCount > 0 && <StatusBadge label={`Kolegovia: ${model.otherActiveCount}`} tone="neutral" />}
      </div>
      <div className="grid gap-2 p-3">
        {rows.length === 0 && (
          <EmptyState icon={PhoneCall} title="Žiadny prebiehajúci hovor" body="Prichádzajúci hovor sa zobrazí tu aj v hornej lište." compact />
        )}
        {rows.map((row) => {
          const state = phoneBarStateLabel(row);
          return (
            <div key={row.sessionId} className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-zinc-200 px-3 py-2">
              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-bold text-zinc-700">{state.label}</span>
              <span className="shrink-0 rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] font-semibold text-zinc-600">{row.lineLabel}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-950">
                {row.callerName ? `${row.callerName} · ${formatPhoneNumberForDisplay(row.number)}` : formatPhoneNumberForDisplay(row.number) || row.number}
              </span>
              <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-zinc-600">{formatCallTimer(callElapsedSeconds(row, now))}</span>
              {row.caseId ? (
                <button type="button" onClick={() => onOpenCase(row.caseId as string)} className="shrink-0 rounded-md bg-[#FCD703] px-2 py-1 text-[11px] font-bold text-zinc-950">
                  Otvoriť prípad
                </button>
              ) : (
                <button type="button" onClick={() => onNewCase()} className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-[11px] font-bold text-zinc-800 hover:bg-zinc-50">
                  Nový prípad
                </button>
              )}
              {row.kind === "active" && onAction && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => onAction("hangup", row.sessionId)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-red-500 disabled:bg-zinc-300 disabled:text-zinc-600"
                >
                  <PhoneOff size={12} aria-hidden="true" />
                  Zavesiť
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function OperatorAvailabilityPanel({
  configured,
  currentOperatorName,
  myPresence,
  onAction,
  phone,
}: {
  configured: boolean;
  currentOperatorName?: string;
  myPresence?: TelephonyOperatorPresence;
  onAction: (action: TelephonyAvailabilityAction) => void;
  phone?: WebphoneSnapshot;
}) {
  const state: TelephonyOperatorPresenceState = myPresence?.state ?? "unassigned";
  // Presence cannot be changed without a provider, and not while a call is up
  // (the server refuses it with 409); the buttons stay visible either way so
  // the layout is stable.
  const controlsEnabled = configured && state !== "ringing" && state !== "on_call";
  const workingState = state === "ringing" || state === "on_call";
  const stateSurface = state === "available"
    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
    : workingState || state === "paused" || state === "unassigned"
      ? "border-amber-300 bg-amber-50 text-amber-800"
      : "border-red-300 bg-red-50 text-red-800";

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
            <div className="mt-1 text-sm font-medium text-zinc-700">{myPresence?.detail ?? TELEPHONY_NOT_CONFIGURED_MESSAGE}</div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Môj pracovný stav</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {configured && phone && (
                <StatusBadge
                  label={`Telefón: ${phone.registration.label}`}
                  tone={phone.registration.tone === "ok" ? "ok" : phone.registration.tone === "error" ? "warn" : "neutral"}
                />
              )}
              <StatusBadge
                label={configured ? presenceStateLabel[state] : "Telefónia nenakonfigurovaná"}
                tone={configured ? (state === "available" ? "ok" : "warn") : "neutral"}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-md bg-zinc-100 p-1">
            <AvailabilityButton
              active={configured && state === "available"}
              disabled={!controlsEnabled}
              icon={Check}
              label="Dostupný"
              pending={false}
              onClick={() => onAction("available")}
            />
            <AvailabilityButton
              active={configured && myPresence?.paused === true}
              disabled={!controlsEnabled}
              icon={Pause}
              label="Pauza"
              pending={false}
              onClick={() => onAction("pause")}
            />
            <AvailabilityButton
              active={configured && state === "offline"}
              disabled={!controlsEnabled}
              icon={LogOut}
              label="Mimo radu"
              pending={false}
              onClick={() => onAction("offline")}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-900 sm:px-4">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {configured
              ? "Hovory zvonia len v tomto okne prehliadača. Otvorenie ďalšieho okna odhlási toto."
              : `${TELEPHONY_NOT_CONFIGURED_MESSAGE} Dostupnosť a prichádzajúce hovory budú fungovať po zapojení telefónneho poskytovateľa.`}
          </span>
        </div>
      </div>
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
              key={call.id}
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
                key={call.id}
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
    ? call.callerNumber
    : call.destinationNumber ?? call.calledNumber;
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
  const displayedStartedAt = historyDisplayStartedAt(call);

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
