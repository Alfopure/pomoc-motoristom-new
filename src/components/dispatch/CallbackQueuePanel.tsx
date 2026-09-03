"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Clock3, Loader2, PhoneOutgoing, RefreshCw, UserRound, X } from "lucide-react";

import { TELEPHONY_TIMEOUT_MS, telephonyJson } from "@/lib/telephony/client-request";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { callbackPollDelayMs } from "@/lib/telephony/poll-schedule";
import {
  callbackPermissions,
  callbackQueueSummary,
  callbackUrgency,
  callbackWaitSeconds,
  CALLBACK_OVERDUE_MINUTES,
  CALLBACK_SOURCE_LABELS,
  CALLBACK_STATUS_LABELS,
  EMPTY_CALLBACK_QUEUE,
  formatCallbackWait,
  sortCallbackQueue,
  type CallbackQueuePayload,
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
 * It polls the queue itself rather than riding the 1 s/5 s `calls/active` loop:
 * these rows change on the scale of minutes, and the console's poll is sized
 * for live call control. The cadence comes from `poll-schedule.ts` like every
 * other telephony reader, so a console left open behind another window all
 * night drops to one poll every two minutes and a failing endpoint backs off
 * instead of being hit at full rate forever. The one action that touches the
 * phone (ringing the caller back) is delegated to the console through
 * `onCallBack`, so the browser answers its own leg exactly as it does for the
 * dialer.
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
  onCallBack,
  onChanged,
}: {
  configured: boolean;
  /** Console-owned outbound path: rings the caller and arms the browser phone. */
  onCallBack?: (requestId: string) => Promise<void>;
  /** Lets the console refresh its own surfaces once a request changed. */
  onChanged?: () => void;
}) {
  const [queue, setQueue] = useState<CallbackQueuePayload>(EMPTY_CALLBACK_QUEUE);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const failures = useRef(0);
  // Ageing is re-derived against the browser's own clock: the answer on screen
  // is up to a poll interval old, and a request must not look fresher than it
  // is just because the last poll was 29 seconds ago.
  const clock = useTickingClock(15_000);
  // Before hydration there is no clock: the snapshot's own timestamp stands in,
  // so nothing is ever measured against an unparsable date.
  const checkedAt = Date.parse(queue.checkedAt);
  const now = clock?.getTime() ?? (Number.isFinite(checkedAt) ? checkedAt : 0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
    const controller = new AbortController();

    const load = async () => {
      const result = await telephonyJson<CallbackQueuePayload & { error?: string }>("/api/telephony/callbacks", {
        label: "fronta spätných volaní",
        signal: controller.signal,
        timeoutMs: TELEPHONY_TIMEOUT_MS.read,
      }).catch(() => null);
      if (cancelled) return;
      if (!result?.ok || !result.body) {
        failures.current += 1;
        setError(result?.body?.error ?? "Frontu spätných volaní sa nepodarilo načítať.");
        setLoaded(true);
        return;
      }
      failures.current = 0;
      setQueue(result.body);
      setError(null);
      setLoaded(true);
    };

    // One chain at a time, generation-counted: a tab that becomes visible while
    // the previous tick is still awaiting its response would otherwise leave
    // that tick to schedule a second chain, and every hide/show cycle would
    // double the poll rate.
    let chain = 0;

    const schedule = (generation: number) => {
      if (cancelled || generation !== chain) return;
      timeoutId = window.setTimeout(async () => {
        await load();
        schedule(generation);
      }, callbackPollDelayMs({ documentHidden: document.visibilityState === "hidden", consecutiveFailures: failures.current }));
    };

    const restart = () => {
      if (cancelled) return;
      chain += 1;
      const generation = chain;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      void load().then(() => schedule(generation));
    };

    const onVisibility = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      restart();
    };

    restart();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [reloadToken]);

  const open = useMemo(() => sortCallbackQueue(queue.open), [queue.open]);
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
        await onCallBack(request.id);
        setNotice(`Volanie na ${formatPhoneNumberForDisplay(request.callerNumber)} bolo spustené.`);
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
    <section className="rounded-md border border-zinc-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
          <Clock3 size={17} />
          Fronta spätných volaní
        </div>
        <div className="flex items-center gap-1.5">
          {summary.overdue > 0 && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-800">
              {summary.overdue} po termíne
            </span>
          )}
          <span className="rounded-full bg-zinc-950 px-2 py-0.5 text-[11px] font-bold text-white" aria-live="polite">
            {summary.total}
          </span>
          <button
            type="button"
            onClick={reload}
            aria-label="Obnoviť frontu spätných volaní"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 transition hover:bg-zinc-100"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {summary.total > 0 && (
        <p className="border-b border-zinc-100 bg-zinc-50 px-3 py-1.5 text-[11px] font-medium text-zinc-600">
          {summary.unclaimed} voľných · {summary.mine} mojich · najdlhšie čaká {formatCallbackWait(summary.longestWaitSeconds)}
          {" · sľub je "}
          {CALLBACK_OVERDUE_MINUTES} min
        </p>
      )}

      {notice && <p className="border-b border-blue-100 bg-blue-50 px-3 py-1.5 text-[11px] font-medium text-blue-900">{notice}</p>}
      {error && <p className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] font-medium text-amber-900">{error}</p>}
      {loaded && !queue.configured && !error && (
        <p className="border-b border-zinc-100 bg-zinc-50 px-3 py-1.5 text-[11px] font-medium text-zinc-600">
          {TELEPHONY_NOT_CONFIGURED_MESSAGE} Požiadavky sa dajú uzavrieť, volať sa z nich nedá.
        </p>
      )}

      <div className="grid gap-2 p-3">
        {open.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-200 px-3 py-4 text-center text-xs font-medium text-zinc-500">
            {loaded ? "Nikto nečaká na spätné volanie." : "Načítavam frontu…"}
          </div>
        ) : (
          open.map((request) => (
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

  return (
    <article className={`rounded-md border px-3 py-2 ${URGENCY_ROW_CLASS[urgency]}`}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-sm font-bold text-zinc-950">
          {request.callerName ?? formatPhoneNumberForDisplay(request.callerNumber)}
        </span>
        <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-bold ${URGENCY_WAIT_CLASS[urgency]}`}>
          <Clock3 size={12} aria-hidden="true" />
          {formatCallbackWait(wait)}
        </span>
      </div>

      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-600">
        {request.callerName && <span className="truncate">{formatPhoneNumberForDisplay(request.callerNumber)}</span>}
        <span className="truncate">{request.lineLabel ?? request.partnerName ?? "Neznáma linka"}</span>
        <span className="truncate">{CALLBACK_SOURCE_LABELS[request.source]}</span>
      </div>

      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
            request.status === "scheduled" ? "bg-sky-100 text-sky-900" : "bg-zinc-100 text-zinc-700"
          }`}
        >
          {CALLBACK_STATUS_LABELS[request.status]}
        </span>
        {request.claimedByName && (
          <span className="inline-flex min-w-0 items-center gap-1 text-[11px] font-medium text-zinc-600">
            <UserRound size={11} aria-hidden="true" />
            <span className="truncate">{request.claimedByName}</span>
          </span>
        )}
        {urgency === "overdue" && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-800">Sľub prekročený</span>
        )}
      </div>

      {permissions.blockedReason ? (
        <p className="mt-1.5 text-[11px] font-medium leading-4 text-zinc-500">{permissions.blockedReason}</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {permissions.canClaim && (
            <ActionButton
              busy={running("claim")}
              disabled={locked}
              icon={UserRound}
              label="Prevziať"
              onClick={() => onAction("claim")}
              tone="primary"
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
            label="Vybavené"
            onClick={() => onAction("done")}
            tone="ghost"
          />
          <ActionButton
            busy={running("cancel")}
            disabled={locked || !permissions.canResolve}
            icon={X}
            label="Zrušiť"
            onClick={() => onAction("cancel")}
            tone="ghost"
          />
        </div>
      )}
    </article>
  );
}

function ActionButton({
  busy,
  disabled,
  icon: Icon,
  label,
  onClick,
  title,
  tone,
}: {
  busy: boolean;
  disabled: boolean;
  icon: typeof Check;
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
      title={title}
      className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-bold outline-none transition focus-visible:ring-2 focus-visible:ring-yellow-400 disabled:cursor-not-allowed ${
        tone === "primary"
          ? "bg-zinc-950 text-white hover:bg-zinc-800 disabled:bg-zinc-200 disabled:text-zinc-500"
          : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:text-zinc-400"
      }`}
    >
      {busy ? <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon size={12} aria-hidden="true" />}
      {label}
    </button>
  );
}
