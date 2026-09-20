"use client";

import { requestCallbackTargetConfirmation } from "@/lib/telephony/callback-target-client";
import { useEffect, useMemo, useState } from "react";
import { Check, Clock3, Loader2, PhoneOutgoing, UserRound, X } from "lucide-react";

import { TELEPHONY_TIMEOUT_MS, telephonyJson } from "@/lib/telephony/client-request";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { useCallbackQueue } from "@/lib/telephony/callback-queue-store";
import { callbackOrigin, callbackOriginDetail, CALLBACK_ORIGIN_LABELS, type CallbackOrigin } from "@/lib/telephony/callback-origin";
import {
  callbackPermissions,
  callbackQueueSummary,
  callbackUrgency,
  callbackWaitSeconds,
  CALLBACK_ORDER_LABELS,
  CALLBACK_OVERDUE_MINUTES,
  CALLBACK_QUEUE_ORDERS,
  CALLBACK_SOURCE_LABELS,
  CALLBACK_STATUS_LABELS,
  formatCallbackWait,
  sortCallbackQueue,
  type CallbackQueueOrder,
  type CallbackRequestPayload,
  type CallbackUrgency,
} from "@/lib/telephony/callback-queue";

import { useTickingClock } from "./settings/settings-ui";

/**
 * The callback queue (plan "Fáza 4", fronta spätných volaní).
 *
 * `motorist_callback_requests` rows have been accumulating since Phase 2 — a
 * caller pressing 1 in the IVR, after hours, when the waiting-room limit ran
 * out or when nobody answered — with nothing on screen to work them off. This
 * panel is the dispatcher's half of that promise: who is waiting, from which
 * line, how long, and the four actions that settle a request.
 *
 * The header and panel share one authorized store, realtime invalidation and
 * fallback polling chain. Loaded-page counts are labelled separately from the
 * organization's unresolved total. Phone actions remain console-owned so the
 * browser media leg follows the same guarded path as the dialer.
 */

const URGENCY_ROW_CLASS: Record<CallbackUrgency, string> = {
  fresh: "border-zinc-200 bg-white",
  due: "border-amber-300 bg-amber-50",
  overdue: "border-red-300 bg-red-50",
};

const URGENCY_WAIT_CLASS: Record<CallbackUrgency, string> = {
  fresh: "text-zinc-600",
  due: "text-amber-900",
  overdue: "text-red-800",
};

type CallbackAction = "claim" | "call" | "done" | "cancel";

export function CallbackQueuePanel({
  configured,
  scopeKey = "legacy",
  organizationId,
  onCallBack,
  onChanged,
  onSchedulingEnabled,
  onLiveCount,
  refreshToken = 0,
}: {
  configured: boolean;
  scopeKey?: string;
  organizationId?: string;
  /** Console-owned outbound path: rings the caller and arms the browser phone. */
  onCallBack?: (requestId: string, verificationId?: string) => Promise<void>;
  /** Lets the console refresh its own surfaces once a request changed. */
  onChanged?: () => void;
  onSchedulingEnabled?: (enabled: boolean) => void;
  onLiveCount?: (count: number) => void;
  refreshToken?: number;
}) {
  const { queue, loaded, loading, error, reload, loadMore } = useCallbackQueue(scopeKey, organizationId);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [originFilter, setOriginFilter] = useState<"all" | CallbackOrigin["kind"]>("all");
  const [order, setOrder] = useState<CallbackQueueOrder>("oldest");
  // Ageing is re-derived against the browser's own clock: the answer on screen
  // is up to a poll interval old, and a request must not look fresher than it
  // is just because the last poll was 29 seconds ago.
  const clock = useTickingClock(15_000);
  // Before hydration there is no clock: the snapshot's own timestamp stands in,
  // so nothing is ever measured against an unparsable date.
  const checkedAt = Date.parse(queue.checkedAt);
  const now = clock?.getTime() ?? (Number.isFinite(checkedAt) ? checkedAt : 0);

  useEffect(() => { if (refreshToken) reload(); }, [refreshToken, reload]);
  useEffect(() => {
    if (!loaded) return;
    onSchedulingEnabled?.(queue.schedulingEnabled === true);
    onLiveCount?.(queue.openTotal ?? queue.open.length);
  }, [loaded, queue, onSchedulingEnabled, onLiveCount]);

  const open = useMemo(() => sortCallbackQueue(queue.open, order), [order, queue.open]);
  const totalOpen = queue.openTotal ?? open.length;
  const partialQueue = totalOpen > open.length;
  const visible = open.filter((request) => originFilter === "all" || originOf(request).kind === originFilter);
  const summary = useMemo(
    () => callbackQueueSummary(open, { now, actorProfileId: queue.actorProfileId }),
    [now, open, queue.actorProfileId],
  );
  const actor = useMemo(
    () => ({ profileId: queue.actorProfileId, role: queue.actorRole }),
    [queue.actorProfileId, queue.actorRole],
  );

  async function runAction(request: CallbackRequestPayload, action: CallbackAction) {
    if (busy) return;
    setBusy(`${request.id}:${action}`);
    setNotice(null);
    try {
      if (action === "call") {
        if (!onCallBack) throw new Error("Spätné volanie nie je z tejto obrazovky dostupné.");
        const target = await requestCallbackTargetConfirmation(request.callerNumber);
        if (!target) return;
        await onCallBack(request.id, target.verificationId);
        setNotice(`Volanie na ${formatPhoneNumberForDisplay(target.dialNumber)} bolo spustené.`);
      } else {
        const result = await telephonyJson<{ error?: string }>(
          `/api/telephony/callbacks/${encodeURIComponent(request.id)}/${action}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
            label: "spätné volanie",
            timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
          },
        );
        if (result.status === 503) throw new Error(result.body?.error ?? TELEPHONY_NOT_CONFIGURED_MESSAGE);
        if (!result.ok) throw new Error(result.body?.error ?? "Akciu sa nepodarilo vykonať.");
        setNotice(ACTION_NOTICE[action]);
      }
      onChanged?.();
    } catch (actionError) {
      setNotice(actionError instanceof Error ? actionError.message : "Akciu sa nepodarilo vykonať.");
    } finally {
      setBusy(null);
      reload();
    }
  }

  return (
    <section data-testid="callback-queue" className="overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
          <Clock3 size={17} />
          Spätné volania
        </div>
        <div className="flex items-center gap-1.5">
          {summary.overdue > 0 && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-800">
              {summary.overdue} {partialQueue ? "zo zobrazených po termíne" : "po termíne"}
            </span>
          )}
          <span data-testid="callback-total" className="rounded-md bg-amber-100 px-2.5 py-1 text-sm font-bold text-amber-950" aria-live="polite">
            {totalOpen}
          </span>

        </div>
      </div>

      {summary.total > 0 && (
        <p className="border-b border-zinc-100 bg-zinc-50 px-3 py-1.5 text-[11px] font-medium text-zinc-600">
          {partialQueue ? `Zobrazených ${open.length} z ${totalOpen}: ` : ""}{summary.unclaimed} voľných · {summary.mine} mojich · najdlhšie čaká {formatCallbackWait(summary.longestWaitSeconds)}
          {" · interný termín "}
          {CALLBACK_OVERDUE_MINUTES} min
        </p>
      )}

      {open.length > 0 && (
        <div className="grid gap-2 border-b border-zinc-100 p-3">
          <div className="flex flex-wrap gap-1.5" aria-label="Druh spätného volania">
            {(["all", "requested", "missed", "manual", "unknown"] as const).map((kind) => {
              const count = kind === "all" ? open.length : open.filter((request) => originOf(request).kind === kind).length;
              if (!count && kind !== "all" && kind !== "requested" && kind !== "missed") return null;
              return <button key={kind} type="button" aria-pressed={originFilter === kind} onClick={() => setOriginFilter(kind)}
                className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${originFilter === kind ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-200 text-zinc-700"}`}>
                {kind === "all" ? partialQueue ? "Zobrazené" : "Všetky" : CALLBACK_ORIGIN_LABELS[kind]} ({count})
              </button>;
            })}
          </div>
          {partialQueue && <p className="text-[11px] text-zinc-500">Filtre a poradie sa vzťahujú na načítané požiadavky. Ďalšie nájdete pod zoznamom.</p>}
          <label className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-[11px] font-semibold text-zinc-600">
            Zoradiť
            <select
              value={order}
              onChange={(event) => setOrder(event.target.value as CallbackQueueOrder)}
              className="h-8 min-w-0 rounded-md border border-zinc-200 bg-white px-2 pr-7 text-[11px] font-semibold text-zinc-800 outline-none ring-yellow-300 focus:ring-2"
            >
              {CALLBACK_QUEUE_ORDERS.map((option) => <option key={option} value={option}>{CALLBACK_ORDER_LABELS[option]}</option>)}
            </select>
          </label>
        </div>
      )}

      {notice && <p className="border-b border-blue-100 bg-blue-50 px-3 py-1.5 text-[11px] font-medium text-blue-900">{notice}</p>}
      {error && <p role="status" className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">{error} <button type="button" onClick={reload} className="underline">Skúsiť znova</button></p>}
      {loaded && !queue.configured && !error && (
        <p className="border-b border-zinc-100 bg-zinc-50 px-3 py-1.5 text-[11px] font-medium text-zinc-600">
          {TELEPHONY_NOT_CONFIGURED_MESSAGE} Požiadavky sa dajú uzavrieť, volať sa z nich nedá.
        </p>
      )}

      {/* On wide screens the column scrolls inside itself instead of pushing the
          page down by one tall card per waiting caller. */}
      <div className="grid gap-2 overscroll-contain p-3 xl:max-h-[60vh] xl:overflow-y-auto">
        {visible.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-200 px-3 py-4 text-center text-xs font-medium text-zinc-500">
            {loaded ? open.length ? "V tejto skupine nie sú žiadne požiadavky." : "Nikto nečaká na spätné volanie." : "Načítavam frontu…"}
          </div>
        ) : (
          visible.map((request) => (
            <CallbackQueueRow
              key={request.id}
              busy={busy}
              callable={configured && queue.configured && Boolean(onCallBack)}
              now={now}
              onAction={(action) => void runAction(request, action)}
              permissions={callbackPermissions(request, actor)}
              request={request}
            />
          ))
        )}
      </div>

      {queue.nextCursor && <button type="button" disabled={loading} onClick={loadMore} className="mx-3 mb-3 min-h-9 rounded-md border border-zinc-200 px-3 text-xs font-semibold">{loading ? "Načítavam…" : `Ďalšie požiadavky (${Math.max(0, (queue.openTotal ?? open.length) - open.length)})`}</button>}

      {queue.resolved.length > 0 && (
        <details className="border-t border-zinc-100">
          <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-semibold text-zinc-600 outline-none hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-yellow-400">
            Uzavreté za posledných 24 hodín ({queue.resolved.length})
          </summary>
          <ul className="grid gap-1 px-3 pb-3">
            {queue.resolved.map((request) => (
              <li key={request.id} className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-zinc-600">
                <span className="min-w-0 truncate">
                  {request.callerName ?? formatPhoneNumberForDisplay(request.callerNumber)}
                  {request.claimedByName ? ` · ${request.claimedByName}` : ""}
                  <span className="block">{CALLBACK_ORIGIN_LABELS[originOf(request).kind]}{callbackOriginDetail(originOf(request)) ? ` · ${callbackOriginDetail(originOf(request))}` : ""}</span>
                </span>
                <span className={`shrink-0 font-semibold ${request.status === "done" ? "text-emerald-700" : "text-zinc-500"}`}>
                  {CALLBACK_STATUS_LABELS[request.status]}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const ACTION_NOTICE: Record<Exclude<CallbackAction, "call">, string> = {
  claim: "Požiadavka je prevzatá.",
  done: "Požiadavka je vybavená.",
  cancel: "Požiadavka je zrušená.",
};

function originOf(request: CallbackRequestPayload): CallbackOrigin {
  return request.origin ?? callbackOrigin(request.source, null);
}

function CallbackQueueRow({
  busy,
  callable,
  now,
  onAction,
  permissions,
  request,
}: {
  busy: string | null;
  callable: boolean;
  now: number;
  onAction: (action: CallbackAction) => void;
  permissions: ReturnType<typeof callbackPermissions>;
  request: CallbackRequestPayload;
}) {
  const urgency = callbackUrgency(request, now);
  const wait = callbackWaitSeconds(request, now);
  const running = (action: CallbackAction) => busy === `${request.id}:${action}`;
  const locked = busy !== null;
  const origin = originOf(request);

  const detail = callbackOriginDetail(origin);

  // Three lines per caller: who and how long, where from, then state and
  // actions on one row. The old six-line card made a queue of a few callers
  // run far down the page.
  return (
    <article data-callback-id={request.id} className={`rounded-lg border px-3 py-3 ${URGENCY_ROW_CLASS[urgency]}`}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-sm font-bold text-zinc-950">
          {request.callerName ?? formatPhoneNumberForDisplay(request.callerNumber)}
        </span>
        <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-bold ${URGENCY_WAIT_CLASS[urgency]}`}>
          <Clock3 size={12} aria-hidden="true" />
          {formatCallbackWait(wait)}
        </span>
      </div>

      <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-600">
        {request.callerName && <span>{formatPhoneNumberForDisplay(request.callerNumber)}</span>}
        <span className="truncate">{request.lineLabel ?? request.partnerName ?? "Neznáma linka"}</span>
        <span className="truncate">{origin.kind === "requested" && request.source === "missed" ? "Po zvonení / počas čakania" : CALLBACK_SOURCE_LABELS[request.source]}</span>
        <span className={`font-semibold ${origin.kind === "requested" ? "text-blue-900" : "text-zinc-700"}`} title={detail ?? undefined}>{CALLBACK_ORIGIN_LABELS[origin.kind]}</span>
      </p>

      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
        {request.status === "scheduled" && (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-bold text-sky-900">
            {CALLBACK_STATUS_LABELS[request.status]}
            {request.claimedByName && <span className="truncate font-medium">· {request.claimedByName}</span>}
          </span>
        )}
        {urgency === "overdue" && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-800">Po termíne</span>
        )}
        {permissions.blockedReason ? (
          <span className="text-[11px] font-medium leading-4 text-zinc-500">{permissions.blockedReason}</span>
        ) : (
          <span className="ml-auto flex flex-wrap items-center gap-1">
            {permissions.canClaim && (
              <ActionButton
                busy={running("claim")}
                disabled={locked}
                icon={UserRound}
                label="Prevziať"
                onClick={() => onAction("claim")}
                tone="ghost"
              />
            )}
            <ActionButton
              busy={running("call")}
              disabled={locked || !permissions.canCall || !callable}
              icon={PhoneOutgoing}
              label="Zavolať"
              onClick={() => onAction("call")}
              title={callable ? undefined : TELEPHONY_NOT_CONFIGURED_MESSAGE}
              tone="primary"
            />
            <ActionButton
              busy={running("done")}
              disabled={locked || !permissions.canResolve}
              icon={Check}
              iconOnly
              label="Vybavené"
              onClick={() => onAction("done")}
              tone="ghost"
            />
            <ActionButton
              busy={running("cancel")}
              disabled={locked || !permissions.canResolve}
              icon={X}
              iconOnly
              label="Zrušiť"
              onClick={() => onAction("cancel")}
              tone="ghost"
            />
          </span>
        )}
      </div>
    </article>
  );
}

function ActionButton({
  busy,
  disabled,
  icon: Icon,
  iconOnly = false,
  label,
  onClick,
  title,
  tone,
}: {
  busy: boolean;
  disabled: boolean;
  icon: typeof Check;
  /** Square button with the label as tooltip and accessible name only. */
  iconOnly?: boolean;
  label: string;
  onClick: () => void;
  title?: string;
  tone: "primary" | "ghost";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={title ?? (iconOnly ? label : undefined)}
      aria-label={iconOnly ? label : undefined}
      className={`inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 rounded-md text-[11px] font-bold outline-none transition focus-visible:ring-2 focus-visible:ring-yellow-400 disabled:cursor-not-allowed ${iconOnly ? "w-11 sm:w-9 justify-center" : "px-2.5"} ${
        tone === "primary"
          ? "bg-emerald-700 text-white hover:bg-emerald-600 disabled:bg-zinc-200 disabled:text-zinc-500"
          : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:text-zinc-400"
      }`}
    >
      {busy ? <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon size={iconOnly ? 13 : 12} aria-hidden="true" />}
      {!iconOnly && label}
    </button>
  );
}
