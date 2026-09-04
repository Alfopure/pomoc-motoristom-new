"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Coffee,
  Clock3,
  Ear,
  Headphones,
  Loader2,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  PhoneOutgoing,
  Plus,
  Radio,
  Users,
  X,
} from "lucide-react";

import type { PhoneBarCall, PhoneBarModel } from "@/lib/telephony/active-calls-model";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { TelephonyOperatorPresence } from "@/lib/telephony/presence";
import type { SupervisorMode } from "@/lib/telephony/supervisor-mode";

import { callElapsedSeconds, formatCallTimer, phoneBarStateLabel, type PhoneCallAction } from "./phone-bar-model";

export type LiveCallOverviewFilter = "all" | "ringing" | "waiting" | "active";

export type LiveCallOverviewCounts = {
  total: number;
  ringing: number;
  waiting: number;
  active: number;
  onlineOperators: number;
  pausedOperators: number;
  callingOperators: number;
};

export function liveCallOverviewCounts(model: PhoneBarModel, presences: readonly TelephonyOperatorPresence[]): LiveCallOverviewCounts {
  return {
    total: model.teamCalls.length,
    ringing: model.teamCalls.filter((call) => call.kind === "offer").length,
    waiting: model.teamCalls.filter((call) => call.kind === "waiting").length,
    active: model.teamCalls.filter((call) => call.kind === "active").length,
    onlineOperators: presences.filter((presence) => ["available", "ringing", "on_call"].includes(presence.state)).length,
    pausedOperators: presences.filter((presence) => presence.state === "paused").length,
    callingOperators: presences.filter((presence) => presence.state === "on_call").length,
  };
}

export function liveCallOperatorLabel(call: PhoneBarCall): string {
  if (call.operatorName) return call.operatorName;
  const external = call.participants.find((participant) => participant.kind === "operator" && !participant.profileId && participant.answered);
  if (external) return `Externý telefón: ${external.name}`;
  if (call.offeredOperatorNames.length > 0) return `Zvoní: ${call.offeredOperatorNames.join(", ")}`;
  if (call.kind === "waiting") return "Čaká na prevzatie";
  if (call.direction === "outbound") return "Odchádzajúci hovor";
  return "Hľadá operátora";
}

type SharedOverviewProps = {
  model: PhoneBarModel;
  presences: TelephonyOperatorPresence[];
  canManageCalls: boolean;
  busyAction: string | null;
  browserOfferRinging: boolean;
  onAnswer: () => void;
  onRejectOffer: () => void;
  onCallAction: (action: PhoneCallAction, sessionId: string) => void;
  onSupervise: (sessionId: string, mode: SupervisorMode) => void;
  onStopSupervise: (sessionId: string) => void;
};

type WorkspaceOverviewProps = SharedOverviewProps & {
  onNewCase: (call: PhoneBarCall) => void;
  onOpenCase: (caseId: string) => void;
};

export function LiveCallsWorkspace(props: WorkspaceOverviewProps) {
  const [filter, setFilter] = useState<LiveCallOverviewFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const counts = liveCallOverviewCounts(props.model, props.presences);
  const rows = useMemo(() => filterCalls(props.model.teamCalls, filter), [filter, props.model.teamCalls]);

  useLiveCallClock(props.model.teamCalls.length > 0, setNow);

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white" aria-labelledby="live-calls-heading">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`relative flex size-9 shrink-0 items-center justify-center rounded-lg ${counts.total > 0 ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
            <Radio size={17} aria-hidden="true" />
            {counts.ringing > 0 && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-red-500 ring-2 ring-white motion-safe:animate-pulse" />}
          </span>
          <div className="min-w-0">
            <h2 id="live-calls-heading" className="text-sm font-bold text-zinc-950">Živé hovory</h2>
            <p className="text-xs text-zinc-500">Celá ústredňa v jednom pohľade</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <OverviewCount label="Zvoní" value={counts.ringing} tone={counts.ringing > 0 ? "urgent" : "neutral"} />
          <OverviewCount label="Čaká" value={counts.waiting} tone={counts.waiting > 0 ? "warning" : "neutral"} />
          <OverviewCount label="Prebieha" value={counts.active} tone={counts.active > 0 ? "success" : "neutral"} />
        </div>
      </header>

      <div className="flex gap-1 overflow-x-auto border-b border-zinc-200 bg-zinc-50 px-3 py-2" role="tablist" aria-label="Filter živých hovorov">
        {([
          ["all", "Všetky", counts.total],
          ["ringing", "Zvonia", counts.ringing],
          ["waiting", "Čakajú", counts.waiting],
          ["active", "Prebiehajú", counts.active],
        ] as const).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            onClick={() => setFilter(value)}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-bold transition ${filter === value ? "bg-zinc-950 text-white" : "text-zinc-600 hover:bg-zinc-200"}`}
          >
            {label}<span className={`rounded px-1.5 py-0.5 text-[10px] ${filter === value ? "bg-white/15" : "bg-zinc-200 text-zinc-700"}`}>{count}</span>
          </button>
        ))}
      </div>

      <div className="divide-y divide-zinc-100">
        {rows.length === 0 ? (
          <div className="flex min-h-16 items-center gap-3 px-4 py-3 text-sm text-zinc-500">
            <PhoneCall size={17} className="shrink-0 text-zinc-400" aria-hidden="true" />
            {counts.total === 0 ? "Momentálne nikto nevolá ani nečaká." : "V tomto filtri nie je žiadny hovor."}
          </div>
        ) : rows.map((call) => (
          <LiveCallRow
            key={call.sessionId}
            {...props}
            call={call}
            now={now}
            compact={false}
          />
        ))}
      </div>
    </section>
  );
}

export function HeaderLiveCallsMenu(props: SharedOverviewProps) {
  const [now, setNow] = useState(() => Date.now());
  const counts = liveCallOverviewCounts(props.model, props.presences);
  useLiveCallClock(counts.total > 0, setNow);
  const online = props.presences.filter((presence) => ["available", "ringing", "on_call"].includes(presence.state));
  const paused = props.presences.filter((presence) => presence.state === "paused");
  const alerting = counts.ringing + counts.waiting > 0;

  return (
    <details className="group relative">
      <summary
        className={`flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md border px-2 text-xs font-bold outline-none transition focus-visible:ring-2 focus-visible:ring-yellow-300 [&::-webkit-details-marker]:hidden ${alerting ? "border-amber-400 bg-amber-500/15 text-amber-100" : counts.active > 0 ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-100" : "border-white/15 bg-white/10 text-zinc-200"}`}
        aria-label={`Hovory: ${counts.active} prebieha, ${counts.ringing} zvoní, ${counts.waiting} čaká`}
      >
        <PhoneCall size={14} aria-hidden="true" />
        <span className="hidden sm:inline">Hovory</span>
        <span className="rounded bg-white/10 px-1.5 py-0.5" aria-live="polite">{counts.total}</span>
        {alerting && <span className="size-1.5 rounded-full bg-amber-300 motion-safe:animate-pulse" aria-hidden="true" />}
        <ChevronDown size={13} className="transition group-open:rotate-180" aria-hidden="true" />
      </summary>

      <section aria-label="Prehľad živých hovorov" className="absolute right-0 top-[calc(100%+8px)] z-[80] w-[min(28rem,calc(100vw-1rem))] overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-950 shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-zinc-200 px-3 py-2.5">
          <div>
            <h2 className="text-sm font-bold">Živé hovory</h2>
            <p className="text-[11px] text-zinc-500">Zvoní, čaká aj prebieha</p>
          </div>
          <div className="flex gap-1">
            <OverviewCount label="Z" value={counts.ringing} tone={counts.ringing ? "urgent" : "neutral"} compact />
            <OverviewCount label="Č" value={counts.waiting} tone={counts.waiting ? "warning" : "neutral"} compact />
            <OverviewCount label="P" value={counts.active} tone={counts.active ? "success" : "neutral"} compact />
          </div>
        </header>

        <div className="max-h-[min(56vh,30rem)] divide-y divide-zinc-100 overflow-y-auto">
          {props.model.teamCalls.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-4 text-xs font-medium text-zinc-500"><PhoneCall size={15} /> Momentálne neprebieha žiadny hovor.</div>
          ) : props.model.teamCalls.map((call) => (
            <LiveCallRow key={call.sessionId} {...props} call={call} now={now} compact />
          ))}
        </div>

        <footer className="grid grid-cols-3 gap-1 border-t border-zinc-200 bg-zinc-50 p-2 text-center">
          <OperatorMiniCount icon={Users} label="Online" value={online.length} names={online.map((row) => row.operatorName)} tone="success" />
          <OperatorMiniCount icon={PhoneCall} label="Volajú" value={counts.callingOperators} names={online.filter((row) => row.state === "on_call").map((row) => row.operatorName)} tone="info" />
          <OperatorMiniCount icon={Coffee} label="Pauza" value={paused.length} names={paused.map((row) => row.operatorName)} tone="warning" />
        </footer>
      </section>
    </details>
  );
}

function LiveCallRow({
  browserOfferRinging,
  busyAction,
  call,
  canManageCalls,
  compact,
  model,
  now,
  onAnswer,
  onCallAction,
  onNewCase,
  onOpenCase,
  onRejectOffer,
  onStopSupervise,
  onSupervise,
}: SharedOverviewProps & {
  call: PhoneBarCall;
  now: number;
  compact: boolean;
  onNewCase?: (call: PhoneBarCall) => void;
  onOpenCase?: (caseId: string) => void;
}) {
  const state = phoneBarStateLabel(call);
  const timer = formatCallTimer(callElapsedSeconds(call, now));
  const isBusy = busyAction !== null;
  const canAnswer = call.kind === "offer" && call.offeredToMe && browserOfferRinging;
  const canPickup = call.kind === "waiting";
  const pickupBlocked = isBusy || Boolean(model.active) || model.ownPresenceStatus !== "available";
  const supervising = model.supervising?.sessionId === call.sessionId;
  const StateIcon = call.kind === "offer" ? PhoneIncoming : call.kind === "waiting" ? Clock3 : call.direction === "outbound" ? PhoneOutgoing : PhoneCall;
  const surface = state.tone === "ring"
    ? "border-l-red-500 bg-red-50/40"
    : state.tone === "wait"
      ? "border-l-amber-400 bg-amber-50/35"
      : state.tone === "hold"
        ? "border-l-sky-500 bg-sky-50/35"
        : "border-l-emerald-500 bg-white";

  function confirmAndEnd() {
    if (typeof window !== "undefined" && !window.confirm("Naozaj ukončiť tento hovor pre všetkých účastníkov?")) return;
    onCallAction("hangup", call.sessionId);
  }

  return (
    <article className={`grid min-w-0 gap-2 border-l-[3px] ${surface} ${compact ? "px-2.5 py-2" : "px-3 py-2.5 sm:grid-cols-[minmax(0,1.5fr)_minmax(9rem,0.8fr)_auto] sm:items-center"}`}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span className={`relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${state.tone === "ring" ? "bg-red-100 text-red-700" : state.tone === "wait" ? "bg-amber-100 text-amber-800" : state.tone === "hold" ? "bg-sky-100 text-sky-700" : "bg-emerald-100 text-emerald-700"}`}>
          <StateIcon size={15} aria-hidden="true" />
          {state.tone === "ring" && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-500 motion-safe:animate-pulse" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-bold text-zinc-950">{call.callerName || formatPhoneNumberForDisplay(call.number) || "Neznámy volajúci"}</span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${state.tone === "ring" ? "bg-red-100 text-red-700" : state.tone === "wait" ? "bg-amber-100 text-amber-800" : state.tone === "hold" ? "bg-sky-100 text-sky-700" : "bg-emerald-100 text-emerald-700"}`}>{state.label}</span>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] leading-4 text-zinc-500">
            {call.callerName && <span>{formatPhoneNumberForDisplay(call.number) || call.number}</span>}
            <span className="truncate">{call.lineLabel}</span>
            <span className="font-mono font-bold tabular-nums text-zinc-700">{timer}</span>
          </div>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-zinc-700">
        <Headphones size={13} className="shrink-0 text-zinc-400" aria-hidden="true" />
        <span className="truncate" title={liveCallOperatorLabel(call)}>{liveCallOperatorLabel(call)}</span>
      </div>

      <div className={`flex flex-wrap items-center gap-1.5 ${compact ? "pl-10" : "sm:justify-end"}`}>
        {canAnswer && <ActionButton icon={PhoneCall} label="Prijať" tone="accept" onClick={onAnswer} />}
        {call.kind === "offer" && call.offeredToMe && browserOfferRinging && <ActionButton icon={X} label="Odmietnuť" tone="danger-outline" onClick={onRejectOffer} />}
        {canPickup && <ActionButton busy={busyAction === "pickup"} disabled={pickupBlocked} icon={PhoneIncoming} label={pickupBlocked ? (model.active ? "Najprv odlož hovor" : "Najprv sa nastav dostupný") : "Prevziať"} tone="accept" onClick={() => onCallAction("pickup", call.sessionId)} />}
        {call.kind === "active" && call.mine && <ActionButton busy={busyAction === "hangup"} disabled={isBusy && busyAction !== "hangup"} icon={PhoneOff} label="Ukončiť" tone="danger" onClick={confirmAndEnd} />}
        {call.kind === "active" && !call.mine && Boolean(call.operatorProfileId) && canManageCalls && !supervising && (
          <>
            <ActionButton busy={busyAction === `supervise:${call.sessionId}`} disabled={isBusy} icon={Ear} label="Počúvať" tone="outline" onClick={() => onSupervise(call.sessionId, "monitor")} />
            <ActionButton busy={busyAction === `supervise:${call.sessionId}`} disabled={isBusy} icon={Users} label="Vstúpiť" tone="outline" onClick={() => onSupervise(call.sessionId, "barge")} />
          </>
        )}
        {call.kind === "active" && !call.mine && Boolean(call.operatorProfileId) && canManageCalls && supervising && <ActionButton busy={busyAction === `stop-supervise:${call.sessionId}`} disabled={isBusy} icon={PhoneOff} label="Ukončiť dozor" tone="warning" onClick={() => onStopSupervise(call.sessionId)} />}
        {call.kind === "active" && !call.mine && !call.operatorProfileId && canManageCalls && <ActionButton busy={busyAction === "hangup"} disabled={isBusy} icon={PhoneOff} label="Ukončiť" tone="danger-outline" onClick={confirmAndEnd} />}
        {canManageCalls && call.kind !== "active" && !call.offeredToMe && <ActionButton busy={busyAction === "hangup"} disabled={isBusy} icon={PhoneOff} label="Zrušiť" tone="danger-outline" onClick={confirmAndEnd} />}
        {!compact && call.caseId && onOpenCase && <ActionButton icon={PhoneCall} label="Prípad" tone="outline" onClick={() => onOpenCase(call.caseId as string)} />}
        {!compact && !call.caseId && onNewCase && <ActionButton icon={Plus} label="Nový prípad" tone="outline" onClick={() => onNewCase(call)} />}
      </div>
    </article>
  );
}

function ActionButton({ busy = false, disabled = false, icon: Icon, label, onClick, tone }: {
  busy?: boolean;
  disabled?: boolean;
  icon: typeof PhoneCall;
  label: string;
  onClick: () => void;
  tone: "accept" | "danger" | "danger-outline" | "outline" | "warning";
}) {
  const colors = tone === "accept"
    ? "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-600"
    : tone === "danger"
      ? "border-red-600 bg-red-600 text-white hover:bg-red-500"
      : tone === "danger-outline"
        ? "border-red-200 bg-white text-red-700 hover:bg-red-50"
        : tone === "warning"
          ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
          : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100";
  return (
    <button type="button" disabled={disabled} onClick={onClick} title={label} className={`inline-flex min-h-7 items-center justify-center gap-1 rounded-md border px-2 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-100 disabled:text-zinc-400 ${colors}`}>
      {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Icon size={12} aria-hidden="true" />}
      <span className={label.length > 16 ? "hidden 2xl:inline" : ""}>{label}</span>
    </button>
  );
}

function OverviewCount({ compact = false, label, tone, value }: { compact?: boolean; label: string; tone: "urgent" | "warning" | "success" | "neutral"; value: number }) {
  const colors = tone === "urgent" ? "bg-red-100 text-red-800" : tone === "warning" ? "bg-amber-100 text-amber-900" : tone === "success" ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600";
  return <span className={`inline-flex items-center gap-1 rounded-md font-bold ${colors} ${compact ? "px-1.5 py-1 text-[10px]" : "px-2 py-1 text-[11px]"}`}><span>{label}</span><span>{value}</span></span>;
}

function OperatorMiniCount({ icon: Icon, label, names, tone, value }: { icon: typeof Users; label: string; names: string[]; tone: "success" | "info" | "warning"; value: number }) {
  const colors = tone === "success" ? "text-emerald-700" : tone === "info" ? "text-sky-700" : "text-amber-800";
  return (
    <div className="min-w-0 rounded-md bg-white px-1.5 py-1.5" title={names.length ? names.join(", ") : `${label}: nikto`}>
      <span className={`flex items-center justify-center gap-1 text-xs font-black ${colors}`}><Icon size={12} /> {value}</span>
      <span className="mt-0.5 block truncate text-[9px] font-bold uppercase tracking-wide text-zinc-500">{label}</span>
    </div>
  );
}

function filterCalls(calls: readonly PhoneBarCall[], filter: LiveCallOverviewFilter): PhoneBarCall[] {
  if (filter === "all") return [...calls];
  const kind = filter === "ringing" ? "offer" : filter === "waiting" ? "waiting" : "active";
  return calls.filter((call) => call.kind === kind);
}

function useLiveCallClock(active: boolean, setNow: (now: number) => void) {
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, setNow]);
}
