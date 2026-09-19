"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BookUser,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  History,
  Link2,
  Loader2,
  PhoneCall,
  PhoneIncoming,
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
import { CallNotificationFocus } from "./CallNotificationFocus";
import { CallCenterTeam } from "./CallCenterTeam";
import { LiveCallsWorkspace } from "./LiveCallOverview";
import type { PhoneCallAction } from "./phone-bar-model";
import type {
  TelephonyDirectoryContact,
  TelephonyDirectoryResponse,
  TelephonyFavoriteCreateResponse,
  TelephonyFavoriteMutationResponse,
  TelephonyFavoritesResponse,
} from "@/lib/telephony/directory";
import type { PhoneBarCall, PhoneBarModel } from "@/lib/telephony/active-calls-model";
import type { WebphoneSnapshot } from "@/lib/telephony/telnyx-webphone";
import type { CallNotificationFocus as NotificationFocus } from "@/lib/telephony/call-notification-target";
import type {
  TelephonyAvailabilityAction,
  TelephonyOperatorPresence,
} from "@/lib/telephony/presence";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { SupervisorMode } from "@/lib/telephony/supervisor-mode";
import styles from "./CallCenterModule.module.css";

type CallCenterModuleProps = {
  callbackScopeKey?: string;
  organizationId?: string;
  routingSummary?: ReactNode;
  notificationFocus?: NotificationFocus | null;
  notificationStateStale?: boolean;
  outboundPending?: boolean;
  onDismissCallNotification?: () => void;
  onReconnectPhone?: () => void;
  /** Live telephony surface; `undefined` while no provider is configured. */
  activeSnapshot?: PhoneBarModel;
  telephonyConfigured?: boolean;
  /** Browser-phone registration, shown next to the operator's own status. */
  phone?: WebphoneSnapshot;
  busyCallAction?: string | null;
  onCallAction: (action: PhoneCallAction, sessionId: string) => void;
  onAnswer: () => void;
  onAnswerOffer?: (sessionId: string, callControlId: string | null) => void;
  onRejectOfferIdentity?: (sessionId: string, callControlId: string | null) => void;
  onRejectOffer: () => void;
  canManageCalls: boolean;
  onSupervise: (sessionId: string, mode: SupervisorMode) => void;
  onStopSupervise: (sessionId: string) => void;
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
  onNewCaseFromLiveCall: (call: PhoneBarCall) => void;
  onOpenCase: (caseId: string) => void;
  onAvailabilityAction: (action: TelephonyAvailabilityAction) => void;
  /** Console-owned outbound path for the callback queue (arms the browser phone). */
  onCallbackCall?: (requestId: string, verificationId?: string) => Promise<void>;
  onTelephonyChanged: () => void;
};


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
  callbackScopeKey,
  organizationId,
  routingSummary,
  notificationFocus,
  notificationStateStale = false,
  outboundPending = false,
  onDismissCallNotification,
  onReconnectPhone,
  activeSnapshot,
  telephonyConfigured = false,
  phone,
  busyCallAction = null,
  onCallAction,
  onAnswer,
  onAnswerOffer,
  onRejectOffer,
  onRejectOfferIdentity,
  canManageCalls,
  onSupervise,
  onStopSupervise,
  calls,
  cases,
  dataSource,
  currentOperatorId,
  operatorPresences,
  onDataChange,
  onDial,
  onNewCase,
  onNewCaseFromLiveCall,
  onOpenCase,
  onAvailabilityAction,
  onCallbackCall,
  onTelephonyChanged,
  operators,
}: CallCenterModuleProps) {
  const [phonebookOpen, setPhonebookOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [detailCall, setDetailCall] = useState<CallCenterCall | null>(null);
  const [historyAuthorized, setHistoryAuthorized] = useState(false);
  const clearCallDetail = useCallback(() => { setDetailCall(null); setHistoryAuthorized(false); }, []);
  const authorizeHistory = useCallback(() => setHistoryAuthorized(true), []);
  // Status is the authoritative lifecycle marker. Without a provider nothing
  // is live, but a stale row must still not be mistaken for history.
  const partitionedCalls = useMemo(() => partitionLiveCalls(calls), [calls]);
  const storedCalls = useMemo(
    () => (dataSource === "supabase" ? partitionedCalls.completed : []),
    [dataSource, partitionedCalls],
  );
  const [callbackSchedulingEnabled, setCallbackSchedulingEnabled] = useState(false);
  const [scheduledCallId, setScheduledCallId] = useState("");
  const [callbackRefresh, setCallbackRefresh] = useState(0);
  const callbackActions = useRef(new Map<string, string>());
  const callbackInFlight = useRef(new Set<string>());
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

    if (outcome === "callback" && callbackInFlight.current.has(call.id)) return;
    if (outcome === "callback") {
      callbackInFlight.current.add(call.id);
      if (!callbackActions.current.has(call.id)) callbackActions.current.set(call.id, crypto.randomUUID());
    }
    setBusyAction(busyKey);
    setActionNotice(null);

    try {
      const response = await telephonyFetch(`/api/telephony/calls/${encodeURIComponent(call.id)}/outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, callbackMinutes, callbackActionId: callbackActions.current.get(call.id) }),
        label: "výsledok hovoru",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      const result = (await response.json().catch(() => null)) as { dispatchData?: DispatchData; error?: string } | null;

      if (!response.ok || !result?.dispatchData) {
        throw new Error(result?.error ?? "Výsledok hovoru sa nepodarilo uložiť.");
      }

      onDataChange(result.dispatchData);
      if (outcome === "callback") {
        callbackActions.current.delete(call.id);
        setCallbackRefresh((value) => value + 1);
      }
      setActionNotice(outcome === "callback" ? "Spätné volanie je naplánované." : "Výsledok hovoru je uložený.");
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : "Výsledok hovoru sa nepodarilo uložiť.");
    } finally {
      callbackInFlight.current.delete(call.id);
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
    <main className={`${styles.module} min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-zinc-50 p-3 sm:p-4`}>
      {notificationFocus && <CallNotificationFocus
        focus={notificationFocus}
        model={activeSnapshot}
        phone={phone}
        configured={telephonyConfigured && Boolean(activeSnapshot?.configured)}
        stale={notificationStateStale}
        busy={busyCallAction !== null}
        outboundPending={outboundPending}
        onRefresh={onTelephonyChanged}
        onDismiss={() => onDismissCallNotification?.()}
        onReconnect={() => onReconnectPhone?.()}
        onAnswer={onAnswer}
        onAnswerOffer={onAnswerOffer}
        onPickup={(sessionId) => onCallAction("pickup", sessionId)}
      />}
      <header className={styles.moduleHeading}>
        <div><h1>Ústredňa</h1></div>
        <div className={styles.headingActions}><button type="button" aria-expanded={phonebookOpen} onClick={() => setPhonebookOpen((value) => !value)}><BookUser size={15} />Adresár</button>
          <CompactDialer busy={phoneScopeBusy(busyAction)} configured={telephonyConfigured} onDial={(phoneNumber) => startQuickCall({ id: "manual", detail: phoneNumber, label: phoneNumber, phone: phoneNumber, type: "contact" })} />
        </div>
      </header>
      {routingSummary}
      <CallCenterTeam operators={operators} presences={operatorPresences} />
      {phonebookOpen && <div className={styles.phonebookPopover}><PhonebookPanel busyAction={busyAction} onQuickCall={(entry) => void startQuickCall(entry)} /><button type="button" onClick={() => setPhonebookOpen(false)} className="mt-2 min-h-9 px-3 text-xs font-semibold">Zavrieť adresár</button></div>}

      {telephonyConfigured && activeSnapshot && activeSnapshot.waiting.length > 0 && (
        <div className="mb-3">
        <LiveCallsWorkspace
          busyAction={busyCallAction}
          model={activeSnapshot}
          presences={operatorPresences}
          canManageCalls={canManageCalls}
          phone={phone ?? null}
          stale={notificationStateStale}
          onAnswer={onAnswer}
          onAnswerOffer={onAnswerOffer}
          onRejectOffer={onRejectOffer}
          onRejectOfferIdentity={onRejectOfferIdentity}
          onCallAction={onCallAction}
          onSupervise={onSupervise}
          onStopSupervise={onStopSupervise}
          onMakeAvailable={() => onAvailabilityAction("available")}
          onNewCase={onNewCaseFromLiveCall}
          onOpenCase={onOpenCase}
        />
        </div>
      )}

      {actionNotice && <div className="mb-3 shrink-0 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900">{actionNotice}</div>}

      <div>
        <div className={styles.contentGrid}>
          <HistoryPanel
            busyAction={busyAction}
            calls={storedCalls}
            cases={cases}
            scopeKey={callbackScopeKey ?? currentOperatorId ?? "legacy"}
            onCallBack={callBack}
            onLinkCall={linkCallToCase}
            onNewCase={onNewCase}
            onOpenCase={onOpenCase}
            onOpenDetail={setDetailCall}
            onAuthorizationLost={clearCallDetail}
            onAuthorized={authorizeHistory}
          />

          <aside className={`${styles.callbackArea} grid min-w-0 max-w-full content-start gap-3 [&>*]:min-w-0`}>
            <CallbackQueuePanel
              configured={telephonyConfigured}
              scopeKey={callbackScopeKey ?? currentOperatorId ?? "legacy"}
              organizationId={organizationId}
              onCallBack={onCallbackCall}
              onChanged={onTelephonyChanged}
              onSchedulingEnabled={setCallbackSchedulingEnabled}
              refreshToken={callbackRefresh}
            />
            {callbackSchedulingEnabled && historyAuthorized && <div className="rounded-md border border-zinc-200 bg-white p-3">
              <label className="block text-xs font-semibold" htmlFor="schedule-callback-call">Naplánovať spätné volanie</label>
              <select id="schedule-callback-call" value={scheduledCallId} onChange={(event) => setScheduledCallId(event.target.value)} className="my-2 w-full rounded border border-zinc-300 p-2 text-xs">
                <option value="">Vyber hovor z histórie</option>
                {storedCalls.filter((call) => looksLikeUuid(call.id)).slice(0, 100).map((call) => <option key={call.id} value={call.id}>{formatPhoneNumberForDisplay(customerNumberForCall(call))} · {formatTime(historyDisplayStartedAt(call))}</option>)}
              </select>
              <button type="button" disabled={!scheduledCallId || Boolean(busyAction)} className="rounded bg-zinc-950 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40" onClick={() => {
                const call = storedCalls.find((item) => item.id === scheduledCallId);
                if (call) void postCallOutcome(call, "callback", 30);
              }}>Naplánovať o 30 minút</button>
            </div>}
            <p className="px-3 text-xs text-zinc-500">Staršie samostatné úlohy na spätné volanie zostávajú v prehľade úloh.</p>
          </aside>
        </div>
      </div>

      <CallDetailDrawer call={detailCall} open={Boolean(detailCall)} onClose={() => setDetailCall(null)} onNewCase={onNewCase} />
    </main>
  );
}

function CompactDialer({ busy, configured, onDial }: { busy: boolean; configured: boolean; onDial: (phone: string) => Promise<boolean> }) {
  const [number, setNumber] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !configured || !number.trim()) return;
    void onDial(number.trim()).then((accepted) => { if (accepted) setNumber(""); });
  }
  return <form className={styles.compactDialer} onSubmit={submit}><label className="sr-only" htmlFor="call-center-dial-number">Telefónne číslo</label><input id="call-center-dial-number" type="tel" value={number} onChange={(event) => setNumber(event.target.value)} placeholder="Telefónne číslo" disabled={!configured} /><button type="submit" disabled={!configured || busy || !number.trim()}>{busy ? <Loader2 size={15} className="animate-spin" /> : <PhoneOutgoing size={15} />}Volať</button></form>;
}


type HistoryView = { q: string; from: string; to: string; direction: string; outcome: string; operatorId: string; lineId: string; cursors: (string | null)[]; page: number };
const DEFAULT_HISTORY_VIEW: HistoryView = { q: "", from: "", to: "", direction: "", outcome: "", operatorId: "", lineId: "", cursors: [null], page: 0 };
type HistoryResponse = { searchAvailable?: boolean; calls: CallCenterCall[]; nextCursor: string | null; checkedAt?: string; error?: string; filters?: { lines: { id: string; label: string }[]; operators: { id: string; name: string }[] } };

function HistoryPanel({ busyAction, cases, scopeKey, onCallBack, onLinkCall, onNewCase, onOpenCase, onOpenDetail, onAuthorizationLost, onAuthorized }: {
  busyAction: string | null; calls: CallCenterCall[]; cases: DispatchCase[]; scopeKey: string; onAuthorizationLost: () => void; onAuthorized: () => void;
  onCallBack: (call: CallCenterCall) => void; onLinkCall: (call: CallCenterCall, caseId: string) => void;
  onNewCase: (call: CallCenterCall) => void; onOpenCase: (caseId: string) => void; onOpenDetail: (call: CallCenterCall) => void;
}) {
  const [view, setView] = useState<HistoryView>(() => {
    if (typeof window === "undefined") return DEFAULT_HISTORY_VIEW;
    try { const saved = JSON.parse(sessionStorage.getItem(`call-history-view:${scopeKey}`) ?? "null"); return saved && Array.isArray(saved.cursors) ? { ...DEFAULT_HISTORY_VIEW, ...saved } : DEFAULT_HISTORY_VIEW; } catch { return DEFAULT_HISTORY_VIEW; }
  });
  const [query, setQuery] = useState(view.q);
  const [result, setResult] = useState<HistoryResponse>({ calls: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newResult, setNewResult] = useState<HistoryResponse | null>(null);
  const [retry, setRetry] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const displayedIds = useRef("");
  const historyLease = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authorizedUntil = useRef(0);
  const privateGeneration = useRef(0);
  const clearPrivateHistory = useCallback((reason: string) => {
    privateGeneration.current += 1;
    authorizedUntil.current = 0;
    if (historyLease.current) clearTimeout(historyLease.current);
    historyLease.current = null;
    displayedIds.current = "";
    setResult({ calls: [], nextCursor: null });
    setNewResult(null);
    setError(reason);
    onAuthorizationLost();
  }, [onAuthorizationLost]);
  // This authorization lease belongs to the mounted reader, not to one query.
  // Changing a filter or retrying must never extend private data's lifetime.
  useEffect(() => () => {
    privateGeneration.current += 1;
    if (historyLease.current) clearTimeout(historyLease.current);
  }, []);
  const scrollKey = `call-history-scroll:${scopeKey}`;
  useEffect(() => {
    const timer = window.setTimeout(() => setView((current) => current.q === query.trim() ? current : { ...current, q: query.trim(), cursors: [null], page: 0 }), 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => { try { sessionStorage.setItem(`call-history-view:${scopeKey}`, JSON.stringify(view)); } catch { /* Storage can be unavailable in private browsing. */ } }, [scopeKey, view]);
  const requestKey = JSON.stringify({ q: view.q, from: view.from, to: view.to, direction: view.direction, outcome: view.outcome, operatorId: view.operatorId, lineId: view.lineId, cursor: view.cursors[view.page] ?? "", limit: "25" });
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let poll: ReturnType<typeof setTimeout>;
    let initial = true;
    const load = async () => {
      const startedAt = Date.now();
      const requestGeneration = privateGeneration.current;
      let denied = false;
      if (initial) { setLoading(true); setNewResult(null); }
      try {
        const params = new URLSearchParams(JSON.parse(requestKey) as Record<string, string>);
        const response = await telephonyFetch(`/api/telephony/calls/history?${params}`, { label: "história hovorov", signal: controller.signal, timeoutMs: TELEPHONY_TIMEOUT_MS.read });
        const body = await response.json() as HistoryResponse;
        if (stopped || requestGeneration !== privateGeneration.current) return;
        if (!response.ok || !Array.isArray(body.calls)) {
          if (response.status === 401 || response.status === 403) { denied = true; clearPrivateHistory("Prístup k histórii už nie je dostupný."); }
          throw new Error(body.error ?? "Históriu sa nepodarilo načítať.");
        }
        onAuthorized();
        const ids = body.calls.map((call) => call.id).join(",");
        if (!initial && ids !== displayedIds.current) setNewResult(body);
        else { setResult(body); setNewResult(null); displayedIds.current = ids; }
        if (initial) requestAnimationFrame(() => { if (!stopped && listRef.current) { try { listRef.current.scrollTop = Number(sessionStorage.getItem(scrollKey) ?? 0); } catch {} } });
        setError(null);
        if (historyLease.current) clearTimeout(historyLease.current);
        authorizedUntil.current = startedAt + 30_000;
        historyLease.current = setTimeout(() => clearPrivateHistory("Prístup k histórii sa overuje. Údaje sa obnovia po spojení."), Math.max(0, authorizedUntil.current - Date.now()));
      } catch (loadError) { if (!stopped) setError(messageFromError(loadError, "Históriu sa nepodarilo načítať.")); }
      finally { if (!stopped) { initial = false; setLoading(false); poll = setTimeout(() => void load(), !denied && requestGeneration !== privateGeneration.current ? 0 : 25_000); } }
    };
    void load();
    return () => { stopped = true; controller.abort(); clearTimeout(poll); };
  }, [requestKey, retry, scrollKey, clearPrivateHistory, onAuthorized]);
  function filter(key: "from" | "to" | "direction" | "outcome" | "operatorId" | "lineId", value: string) {
    setView((current) => ({ ...current, [key]: value, cursors: [null], page: 0 }));
  }
  const visibleCalls = result.calls;
  const searchAvailable = result.searchAvailable !== false;
  return <section data-testid="call-center-history" className={styles.historyPanel}>
    <header className={styles.historyHeading}><h2><History size={16} />Prehľad hovorov</h2><span>{loading ? "Vyhľadávam…" : `Strana ${view.page + 1}`}</span></header>
    <div className={styles.historySearch}>
      <label className={styles.historySearchInput}><Search size={16} /><span className="sr-only">Hľadať v celej histórii</span><input type="search" value={searchAvailable ? query : ""} disabled={!searchAvailable} maxLength={160} onChange={(event) => setQuery(event.target.value)} placeholder="Meno, zákazník, telefón, prípad alebo EČV" /></label>
      {searchAvailable && <details className={styles.historyAdvanced}><summary>Filtre{Object.values({ from: view.from, to: view.to, direction: view.direction, outcome: view.outcome, operatorId: view.operatorId, lineId: view.lineId }).filter(Boolean).length ? " · aktívne" : ""}<ChevronDown size={13} /></summary><div>
        <label>Od<input type="date" value={view.from} onChange={(event) => filter("from", event.target.value)} /></label>
        <label>Do<input type="date" value={view.to} onChange={(event) => filter("to", event.target.value)} /></label>
        <label>Smer<select value={view.direction} onChange={(event) => filter("direction", event.target.value)}><option value="">Všetky smery</option><option value="inbound">Prichádzajúce</option><option value="outbound">Odchádzajúce</option><option value="internal">Interné</option></select></label>
        <label>Výsledok<select value={view.outcome} onChange={(event) => filter("outcome", event.target.value)}><option value="">Všetky výsledky</option><option value="answered">Prijaté</option><option value="missed">Zmeškané</option><option value="failed">Neúspešné</option><option value="callback">Spätné volanie</option></select></label>
        <label>Operátor<select value={view.operatorId} onChange={(event) => filter("operatorId", event.target.value)}><option value="">Všetci operátori</option>{result.filters?.operators.map((operator) => <option key={operator.id} value={operator.id}>{operator.name}</option>)}</select></label>
        <label>Linka<select value={view.lineId} onChange={(event) => filter("lineId", event.target.value)}><option value="">Všetky linky</option>{result.filters?.lines.map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}</select></label>
        <p>Dátumy zahŕňajú celý deň v časovom pásme Bratislavy.</p>
        <button type="button" onClick={() => { setView(DEFAULT_HISTORY_VIEW); setQuery(""); }}>Vymazať filtre</button>
      </div></details>}
    </div>
    {!searchAvailable && <p role="status" className="border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">Vyhľadávanie v celej histórii zatiaľ nie je dostupné. Zobrazené sú posledné hovory.</p>}
    {error && <p role="status" className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{error} <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>Skúsiť znova</button></p>}
    {newResult && <button type="button" className="min-h-9 bg-sky-50 px-3 text-left text-xs font-semibold text-sky-900" onClick={() => { if (Date.now() >= authorizedUntil.current) { clearPrivateHistory("Prístup k histórii sa overuje."); return; } setResult(newResult); displayedIds.current = newResult.calls.map((call) => call.id).join(","); setNewResult(null); }}>Nové zmeny v histórii · zobraziť</button>}
    <div className={styles.historyColumnHeadings}><span>Čas / výsledok</span><span>Volajúci / zákazník</span><span>Operátor / linka</span><span>Prípad</span><span>Akcie</span></div>
    <div className={styles.historyRows} ref={listRef} aria-busy={loading} onScroll={(event) => { try { sessionStorage.setItem(scrollKey, String(event.currentTarget.scrollTop)); } catch {} }}>
      {visibleCalls.map((call) => <HistoryCallRow key={call.id} busyAction={busyAction} call={call} cases={cases} onCallBack={onCallBack} onLinkCall={onLinkCall} onNewCase={onNewCase} onOpenCase={onOpenCase} onOpenDetail={onOpenDetail} />)}
      {!visibleCalls.length && <EmptyState icon={History} title={loading ? "Načítavam hovory…" : "Žiadne nájdené hovory"} body={view.q || view.from || view.to || view.outcome ? "Skúste iný výraz alebo širšie obdobie." : "História sa zobrazí po prvom hovore."} />}
    </div>
    <footer className={styles.historyPagination}><span>{visibleCalls.length} na strane · časy Bratislava</span><nav aria-label="Stránkovanie histórie hovorov"><button type="button" disabled={loading || !searchAvailable || view.page === 0} aria-label="Predchádzajúca strana" onClick={() => setView((current) => ({ ...current, page: Math.max(0, current.page - 1) }))}><ChevronLeft size={16} /></button><span>{view.page + 1}</span><button type="button" disabled={loading || !searchAvailable || !result.nextCursor} aria-label="Nasledujúca strana" onClick={() => setView((current) => ({ ...current, page: current.page + 1, cursors: [...current.cursors.slice(0, current.page + 1), result.nextCursor] }))}><ChevronRight size={16} /></button></nav></footer>
  </section>;
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
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const customerNumber = call.direction === "outbound" ? call.calledNumber : call.callerNumber;
  const customerName = call.direction === "outbound" ? undefined : call.callerName;
  // Some linked call records use "case number · job type" as callerName.
  // The case already has its own link below; keep the full value in details.
  const customerSummary = call.caseNumber && customerName?.startsWith(`${call.caseNumber} · `)
    ? customerName.slice(call.caseNumber.length + 3)
    : customerName === call.caseNumber ? undefined : customerName;
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
  const duration = Number.isFinite(call.durationSeconds) && (call.durationSeconds ?? 0) >= 0
    ? `${Math.floor((call.durationSeconds ?? 0) / 60)}:${String(Math.floor((call.durationSeconds ?? 0) % 60)).padStart(2, "0")}` : null;

  return (
    <div data-testid="call-history-row" className="min-w-0 hover:bg-zinc-50">
      <div className={styles.mobileHistoryRow}>
        <div className={styles.mobileMeta}>
          <DirectionIcon size={13} aria-label={directionLabel[call.direction]} />
          <time dateTime={displayedStartedAt} title={`${formatShortDate(displayedStartedAt)} ${formatTime(displayedStartedAt)}`}>
            <strong>{formatTime(displayedStartedAt)}</strong><span> · {formatShortDate(displayedStartedAt)}</span>
          </time>
          <CallStatusPill status={call.status} />
        </div>
        <div className={styles.mobileIdentity}>
          <button type="button" onClick={() => onOpenDetail(call)} className={styles.customerButton} aria-label={`Otvoriť detail hovoru ${formatPhoneNumberForDisplay(customerNumber)}`}>
            <strong>{formatPhoneNumberForDisplay(customerNumber)}</strong>
            {customerSummary && <span title={customerName}>{customerSummary}</span>}
          </button>
          <button type="button" onClick={() => onCallBack(call)} disabled={phoneScopeBusy(busyAction)} className={styles.callButton} aria-label={`Volať ${formatPhoneNumberForDisplay(customerNumber)}`}>
            {busyAction === `${call.id}:call_back` ? <Loader2 size={13} className="animate-spin" /> : <PhoneOutgoing size={13} />}
            Volať
          </button>
        </div>
        <div className={styles.mobileContext}>
          {call.caseId ? (
            <button type="button" onClick={() => onOpenCase(call.caseId!)} className={styles.caseButton} title={call.caseNumber ?? "Otvoriť prípad"}>
              <Link2 size={12} /><span>{call.caseNumber ?? "Prípad"}</span>
            </button>
          ) : (
            <button type="button" onClick={() => onNewCase(call)} className={styles.caseButton}><Plus size={12} />Nový prípad</button>
          )}
          {call.operatorName && <span className={styles.mobileOperator} title={call.operatorName}><UserRound size={11} /><span>{call.operatorName}</span></span>}
          <button type="button" className={styles.detailsButton} aria-expanded={mobileDetailsOpen} aria-controls={`mobile-call-details-${call.id}`} onClick={() => setMobileDetailsOpen(!mobileDetailsOpen)}>
            Detail<ChevronDown size={12} className={mobileDetailsOpen ? "rotate-180" : undefined} />
          </button>
        </div>
        {mobileDetailsOpen && (
          <div id={`mobile-call-details-${call.id}`} className={styles.mobileDetails}>
            <dl>
              <dt>Smer</dt><dd>{directionLabel[call.direction]}</dd>
              {customerName && <><dt>{customerLabel}</dt><dd>{customerName}</dd></>}
              <dt>{operatorLabel}</dt><dd>{operatorName}</dd>
              <dt>{call.direction === "outbound" ? "Volané z" : call.direction === "internal" ? "Volaná klapka" : "Finálny cieľ"}</dt><dd>{employeeEndpoint}</dd>
              <dt>Linka</dt><dd>{call.lineLabel}</dd>
              {call.endedAt && <><dt>Ukončený</dt><dd>{formatShortDate(call.endedAt)} {formatTime(call.endedAt)}</dd></>}
              {call.receivedNumber && <><dt>Volané číslo</dt><dd>{call.receivedNumber}</dd></>}
              {call.queueLabel && <><dt>Rad</dt><dd>{call.queueLabel}</dd></>}
            </dl>
            {!call.caseId && <CaseLinkControl call={call} cases={cases} disabled={busyAction === `${call.id}:link`} onLink={(caseId) => onLinkCall(call, caseId)} />}
            <button type="button" onClick={() => onOpenDetail(call)} className={styles.detailDrawerButton}>Otvoriť celý detail hovoru<ChevronRight size={13} /></button>
          </div>
        )}
      </div>
      <div className={styles.desktopHistoryRow}>
        <div className={styles.historyTime}><strong title={call.endedAt ? `Ukončený ${formatShortDate(call.endedAt)} ${formatTime(call.endedAt)}` : undefined}><DirectionIcon size={12} aria-label={directionLabel[call.direction]} />{formatTime(displayedStartedAt)}{call.endedAt ? `–${formatTime(call.endedAt)}` : ""}{duration && <small aria-label={`Dĺžka hovoru ${duration}`}>{duration}</small>}</strong><span className={styles.historyTimeMeta}><time dateTime={displayedStartedAt}>{formatShortDate(displayedStartedAt)}</time><span className={styles.historyStatus} title={callCenterStatusLabel[call.status]}>{callCenterStatusLabel[call.status]}</span></span></div>
        <button type="button" onClick={() => onOpenDetail(call)} className={styles.historyCustomer} title={`${customerName ?? ""} ${formatPhoneNumberForDisplay(customerNumber)}`}><strong>{customerSummary || formatPhoneNumberForDisplay(customerNumber) || "Neznáme číslo"}</strong><span>{customerSummary ? formatPhoneNumberForDisplay(customerNumber) : callCenterStatusLabel[call.status]}</span></button>
        <div className={styles.historyOperator}><strong title={operatorName}>{operatorName}</strong><span title={`${employeeEndpointLabel} · ${call.lineLabel}`}>{call.lineLabel}</span></div>
        <div className={styles.historyCase}>{call.caseId ? <button type="button" onClick={() => onOpenCase(call.caseId!)} title={`Otvoriť prípad ${call.caseNumber ?? ""}`}><Link2 size={12} /><span>{call.caseNumber ?? "Otvoriť prípad"}</span></button> : <details onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary><Plus size={12} />Prípad</summary><div><button type="button" onClick={() => onNewCase(call)}><Plus size={13} />Nový prípad</button><CaseLinkControl call={call} cases={cases} disabled={busyAction === `${call.id}:link`} onLink={(caseId) => onLinkCall(call, caseId)} /></div></details>}</div>
        <button type="button" onClick={() => onCallBack(call)} disabled={phoneScopeBusy(busyAction)} className={styles.historyCallAction} title="Volať späť">{busyAction === `${call.id}:call_back` ? <Loader2 size={14} className="animate-spin" /> : <PhoneOutgoing size={14} />}Volať</button>
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


function StatusBadge({ label, tone }: { label: string; tone: "ok" | "warn" | "neutral" | "bad" }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass[tone]}`}>{label}</span>;
}

function CallStatusPill({ status }: { status: CallCenterCall["status"] }) {
  return <StatusBadge label={callCenterStatusLabel[status]} tone={callTone(status)} />;
}

function formatTime(value: string) {
  if (!Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("sk-SK", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
  }).format(new Date(value));
}

function formatShortDate(value: string) {
  if (!Number.isFinite(Date.parse(value))) return "Neznámy čas";
  return new Intl.DateTimeFormat("sk-SK", {
    day: "2-digit",
    month: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
    year: "numeric",
  }).format(new Date(value));
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
