"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Grid3x3,
  Link2,
  Loader2,
  Mic,
  MicOff,
  Pause,
  PauseCircle,
  Phone,
  PhoneCall,
  PhoneForwarded,
  PhoneIncoming,
  PhoneOff,
  PlayCircle,
  Plus,
  Users,
} from "lucide-react";

import type { PhoneBarCall, PhoneBarModel } from "@/lib/telephony/active-calls-model";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { WebphoneSnapshot } from "@/lib/telephony/telnyx-webphone";

import { CallTransferPicker, type TransferRequest } from "./CallTransferPicker";
import { EmergencyNotice } from "./EmergencyNotice";
import {
  callElapsedSeconds,
  DTMF_KEYS,
  formatCallTimer,
  phoneBarCapabilities,
  phoneBarStateLabel,
  PHONE_ACTION_LABELS,
  type PhoneCallAction,
} from "./phone-bar-model";

export type PhonePauseReason = { id: string; code: string; label: string };
export type PhonePresenceAction = { status: "available" | "paused" | "offline"; pauseReasonId?: string };

export type PhoneBarProps = {
  model: PhoneBarModel;
  phone: WebphoneSnapshot;
  /** Sessions whose conference promotion failed: advanced actions are refused. */
  degradedSessionIds: ReadonlySet<string>;
  pauseReasons: PhonePauseReason[];
  presenceBusy: boolean;
  busyAction: string | null;
  notice: string | null;
  onDismissNotice: () => void;
  onPresenceChange: (action: PhonePresenceAction) => void;
  onCallAction: (action: PhoneCallAction, sessionId: string, target?: TransferRequest) => void;
  onAnswer: () => void;
  onHangupBrowser: () => void;
  onToggleMute: () => void;
  onDtmf: (digit: string) => void;
  onNewCase: (call: PhoneBarCall) => void;
  onLinkCase: (call: PhoneBarCall) => void;
  onOpenCase: (caseId: string) => void;
  onUnlockAudio: () => void;
};

const REGISTRATION_TONES: Record<"ok" | "warn" | "error" | "neutral", string> = {
  ok: "border-emerald-400/50 bg-emerald-500/15 text-emerald-100",
  warn: "border-amber-400/50 bg-amber-500/15 text-amber-100",
  error: "border-red-400/50 bg-red-500/15 text-red-100",
  neutral: "border-white/15 bg-white/10 text-zinc-200",
};

const STATE_TONES: Record<"live" | "hold" | "ring" | "wait", string> = {
  live: "bg-emerald-400 text-emerald-950",
  hold: "bg-amber-300 text-amber-950",
  ring: "bg-yellow-300 text-zinc-950",
  wait: "bg-zinc-300 text-zinc-900",
};

/**
 * The top call bar (knowledge base §8 "Horná call lišta").
 *
 * It is the one surface that must be true at a glance during a call: which
 * line the caller dialled (partner!), who they are, whether we already know
 * their case, how long this has been going on, and the controls for the call.
 * All of its decisions come from `phone-bar-model.ts`, which is unit-tested;
 * this file only renders them.
 */
export function PhoneBar(props: PhoneBarProps) {
  const { model, phone } = props;
  const [now, setNow] = useState(() => Date.now());
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [transferMode, setTransferMode] = useState<"transfer" | "consult" | null>(null);
  const [dtmfLog, setDtmfLog] = useState("");
  const unlockedRef = useRef(false);

  const active = model.active;
  const offer = model.offers[0] ?? null;
  const focus = active ?? offer;
  const degraded = focus ? props.degradedSessionIds.has(focus.sessionId) : false;

  const capabilities = useMemo(
    () =>
      phoneBarCapabilities({
        call: focus,
        browserCallActive: phone.call?.active ?? false,
        browserCallRinging: phone.call?.ringing ?? false,
        degraded,
      }),
    [degraded, focus, phone.call?.active, phone.call?.ringing],
  );

  // One shared second-tick for the timer; it only runs while something is live,
  // so an idle console does not re-render every second for nothing.
  useEffect(() => {
    if (!focus && model.waiting.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [focus, model.waiting.length]);

  // The ringtone's AudioContext and the Notification permission both need a
  // user gesture; the first interaction anywhere in the console is a fine one.
  const onUnlockAudio = props.onUnlockAudio;
  useEffect(() => {
    if (unlockedRef.current) return;
    const unlock = () => {
      if (unlockedRef.current) return;
      unlockedRef.current = true;
      onUnlockAudio();
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [onUnlockAudio]);

  function runAction(action: PhoneCallAction) {
    if (!focus) return;
    props.onCallAction(action, focus.sessionId);
  }

  const busy = props.busyAction !== null;

  return (
    <div
      data-testid="phone-bar"
      className="relative z-40 flex min-h-12 flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-white sm:px-4"
    >
      <RegistrationChip phone={phone} />
      <PresenceSelector
        status={model.ownPresenceStatus}
        pauseReasons={props.pauseReasons}
        busy={props.presenceBusy}
        onChange={props.onPresenceChange}
      />

      {focus ? (
        <CallSummary call={focus} degraded={degraded} now={now} onOpenCase={props.onOpenCase} />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-400">
          {model.waiting.length > 0
            ? `V čakárni čaká ${model.waiting.length} ${model.waiting.length === 1 ? "hovor" : model.waiting.length < 5 ? "hovory" : "hovorov"}.`
            : "Žiadny prebiehajúci hovor."}
        </span>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {capabilities.answer && (
          <BarButton tone="accept" icon={PhoneCall} label="Prijať" onClick={props.onAnswer} />
        )}
        {capabilities.unhold && (
          <BarButton tone="default" icon={PlayCircle} label={PHONE_ACTION_LABELS.unhold} busy={props.busyAction === "unhold"} disabled={busy} onClick={() => runAction("unhold")} />
        )}
        {capabilities.hold && (
          <BarButton tone="default" icon={PauseCircle} label={PHONE_ACTION_LABELS.hold} busy={props.busyAction === "hold"} disabled={busy} onClick={() => runAction("hold")} />
        )}
        {capabilities.mute && (
          <BarButton
            tone={phone.call?.muted ? "warn" : "default"}
            icon={phone.call?.muted ? MicOff : Mic}
            label={phone.call?.muted ? "Zapnúť mikrofón" : "Stlmiť"}
            onClick={props.onToggleMute}
            compact
          />
        )}
        {capabilities.dtmf && (
          <BarButton tone={keypadOpen ? "warn" : "default"} icon={Grid3x3} label="Klávesnica" onClick={() => setKeypadOpen((open) => !open)} compact />
        )}
        {capabilities.transfer && (
          <BarButton
            tone="default"
            icon={PhoneForwarded}
            label={PHONE_ACTION_LABELS.transfer}
            disabled={busy}
            onClick={() => setTransferMode((mode) => (mode === "transfer" ? null : "transfer"))}
          />
        )}
        {capabilities.consult && (
          <BarButton
            tone="default"
            icon={Users}
            label={PHONE_ACTION_LABELS.consult}
            disabled={busy}
            onClick={() => setTransferMode((mode) => (mode === "consult" ? null : "consult"))}
          />
        )}
        {capabilities.completeTransfer && (
          <BarButton tone="accept" icon={PhoneForwarded} label={PHONE_ACTION_LABELS["complete-transfer"]} busy={props.busyAction === "complete-transfer"} disabled={busy} onClick={() => runAction("complete-transfer")} />
        )}
        {capabilities.cancelConsult && (
          <BarButton tone="default" icon={PhoneOff} label={PHONE_ACTION_LABELS["cancel-consult"]} busy={props.busyAction === "cancel-consult"} disabled={busy} onClick={() => runAction("cancel-consult")} />
        )}
        {capabilities.park && (
          <BarButton tone="default" icon={Pause} label={PHONE_ACTION_LABELS.park} busy={props.busyAction === "park"} disabled={busy} onClick={() => runAction("park")} />
        )}
        {capabilities.newCase && focus && (
          <BarButton tone="default" icon={Plus} label="Nový prípad" onClick={() => props.onNewCase(focus)} />
        )}
        {capabilities.linkCase && focus && (
          <BarButton tone="default" icon={Link2} label="Pripojiť ku prípadu" onClick={() => props.onLinkCase(focus)} compact />
        )}
        {capabilities.hangup && (
          <BarButton
            tone="danger"
            icon={PhoneOff}
            label={PHONE_ACTION_LABELS.hangup}
            busy={props.busyAction === "hangup"}
            disabled={busy && props.busyAction !== "hangup"}
            onClick={() => (focus ? runAction("hangup") : props.onHangupBrowser())}
          />
        )}
      </div>

      <EmergencyNotice />

      {model.offers.length > 1 && (
        <span className="rounded-md border border-yellow-300/40 bg-yellow-300/15 px-2 py-1 text-[11px] font-bold text-yellow-100">
          Ďalšie zvoniace hovory: {model.offers.length - 1}
        </span>
      )}

      {model.offers.length > 0 && !active && (
        <RingingPanel
          answerable={phone.call?.ringing ?? false}
          now={now}
          offers={model.offers}
          onAnswer={props.onAnswer}
          onNewCase={props.onNewCase}
          onOpenCase={props.onOpenCase}
        />
      )}

      {props.notice && (
        <button
          type="button"
          onClick={props.onDismissNotice}
          className="min-w-0 max-w-full basis-full truncate rounded-md border border-amber-300/40 bg-amber-500/15 px-2 py-1 text-left text-[11px] font-semibold text-amber-100"
          title="Skryť správu"
        >
          {props.notice}
        </button>
      )}

      {keypadOpen && capabilities.dtmf && (
        <div className="absolute right-3 top-[calc(100%+6px)] z-50 w-52 rounded-xl border border-zinc-200 bg-white p-2 text-zinc-950 shadow-2xl">
          <div className="mb-1.5 h-6 truncate rounded bg-zinc-100 px-2 text-sm font-mono leading-6" aria-live="polite">
            {dtmfLog || " "}
          </div>
          <div className="grid grid-cols-3 gap-1">
            {DTMF_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  props.onDtmf(key);
                  setDtmfLog((log) => (log + key).slice(-16));
                }}
                className="h-9 rounded-md border border-zinc-200 text-sm font-bold transition hover:bg-zinc-100"
              >
                {key}
              </button>
            ))}
          </div>
        </div>
      )}

      {transferMode && focus && (
        <div className="absolute right-3 top-[calc(100%+6px)] z-50">
          <CallTransferPicker
            sessionId={focus.sessionId}
            mode={transferMode}
            busy={busy}
            onCancel={() => setTransferMode(null)}
            onSubmit={(target) => {
              props.onCallAction(transferMode === "transfer" ? "transfer" : "consult", focus.sessionId, target);
              setTransferMode(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The incoming-offer panel: everything the operator needs before deciding to
 * pick up — which line was dialled, who is calling and whether we already know
 * them. `Prijať` answers the browser invite, not the server session: the ring
 * engine has already reserved the operator by then.
 */
function RingingPanel({
  answerable,
  now,
  offers,
  onAnswer,
  onNewCase,
  onOpenCase,
}: {
  answerable: boolean;
  now: number;
  offers: PhoneBarCall[];
  onAnswer: () => void;
  onNewCase: (call: PhoneBarCall) => void;
  onOpenCase: (caseId: string) => void;
}) {
  return (
    <section
      aria-label="Prichádzajúci hovor"
      data-testid="phone-bar-ringing"
      className="absolute left-3 top-[calc(100%+6px)] z-50 w-80 max-w-[calc(100vw-24px)] rounded-xl border border-yellow-300 bg-white p-3 text-zinc-950 shadow-2xl"
    >
      {offers.map((call) => (
        <div key={call.sessionId} className="border-b border-zinc-100 pb-2 last:border-0 last:pb-0 [&+&]:pt-2">
          <div className="flex items-center gap-2">
            <PhoneIncoming size={15} className="shrink-0 motion-safe:animate-pulse text-yellow-600" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-sm font-bold">
              {call.callerName ?? formatPhoneNumberForDisplay(call.number) ?? call.number}
            </span>
            <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-zinc-600">
              {formatCallTimer(callElapsedSeconds(call, now))}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-zinc-600">
            <span className="rounded border border-zinc-200 px-1.5 py-0.5">{call.lineLabel}</span>
            {call.callerName && <span className="truncate">{formatPhoneNumberForDisplay(call.number) || call.number}</span>}
            {call.match?.caseNumber && (
              <button
                type="button"
                onClick={() => call.match?.caseId && onOpenCase(call.match.caseId)}
                className="rounded bg-[#FCD703] px-1.5 py-0.5 font-bold text-zinc-950"
              >
                {call.match.caseNumber}
              </button>
            )}
          </div>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={onAnswer}
              disabled={!answerable}
              title={answerable ? undefined : "Hovor ešte len zvoní na telefóne."}
              className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-500 text-xs font-bold text-emerald-950 transition hover:bg-emerald-400 disabled:bg-zinc-200 disabled:text-zinc-500"
            >
              <PhoneCall size={14} aria-hidden="true" />
              Prijať
            </button>
            <button
              type="button"
              onClick={() => onNewCase(call)}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-zinc-300 px-2 text-xs font-bold text-zinc-800 transition hover:bg-zinc-50"
            >
              <Plus size={14} aria-hidden="true" />
              Nový prípad
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function CallSummary({
  call,
  degraded,
  now,
  onOpenCase,
}: {
  call: PhoneBarCall;
  degraded: boolean;
  now: number;
  onOpenCase: (caseId: string) => void;
}) {
  const state = phoneBarStateLabel(call);
  const elapsed = formatCallTimer(callElapsedSeconds(call, now));
  const number = formatPhoneNumberForDisplay(call.number) || call.number || "Neznáme číslo";

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-bold ${STATE_TONES[state.tone]}`}>{state.label}</span>
      <span className="shrink-0 rounded-md border border-white/15 bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-zinc-100" title="Volaná linka">
        {call.lineLabel}
      </span>
      <span className="min-w-0 truncate text-sm font-bold">
        {call.callerName ? `${call.callerName} · ${number}` : number}
      </span>
      {call.match && call.matchCount > 1 && (
        <span className="shrink-0 text-[11px] font-medium text-zinc-400">+{call.matchCount - 1} ďalšie zhody</span>
      )}
      {call.caseId ? (
        <button
          type="button"
          onClick={() => onOpenCase(call.caseId as string)}
          className="shrink-0 rounded-md bg-[#FCD703] px-2 py-0.5 text-[11px] font-bold text-zinc-950 transition hover:bg-yellow-300"
          title="Otvoriť priradený prípad"
        >
          {call.match?.caseNumber ?? "Prípad"}
        </button>
      ) : call.match?.caseId ? (
        <button
          type="button"
          onClick={() => onOpenCase(call.match?.caseId as string)}
          className="shrink-0 rounded-md border border-yellow-300/50 bg-yellow-300/15 px-2 py-0.5 text-[11px] font-bold text-yellow-100"
          title="Nájdená zhoda podľa čísla"
        >
          {call.match.caseNumber ?? call.match.label}
        </button>
      ) : null}
      <span className="shrink-0 font-mono text-xs font-semibold text-zinc-200 tabular-nums" aria-label="Dĺžka hovoru">
        {elapsed}
      </span>
      {degraded && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300/50 bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-100"
          title="Konferenciu sa nepodarilo vytvoriť: hovor beží ďalej, ale podržanie a konzultácia nie sú dostupné."
        >
          <AlertTriangle size={12} aria-hidden="true" />
          Rozšírené funkcie nedostupné
        </span>
      )}
    </div>
  );
}

function RegistrationChip({ phone }: { phone: WebphoneSnapshot }) {
  return (
    <span
      data-testid="phone-registration"
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-bold ${REGISTRATION_TONES[phone.registration.tone]}`}
      title={phone.registration.detail}
    >
      {phone.registration.tone === "ok" ? <Phone size={12} aria-hidden="true" /> : <PhoneOff size={12} aria-hidden="true" />}
      {phone.registration.label}
    </span>
  );
}

const PRESENCE_LABELS: Record<string, string> = {
  available: "Dostupný",
  ringing: "Zvoní",
  on_call: "Na hovore",
  after_call_work: "Dopisuje",
  paused: "Pauza",
  offline: "Odhlásený",
};

function PresenceSelector({
  busy,
  onChange,
  pauseReasons,
  status,
}: {
  busy: boolean;
  onChange: (action: PhonePresenceAction) => void;
  pauseReasons: PhonePauseReason[];
  status: string | null;
}) {
  const label = status ? PRESENCE_LABELS[status] ?? status : "Neznámy stav";
  const tone = status === "available" ? "ok" : status === "paused" || status === "after_call_work" ? "warn" : status === "offline" || !status ? "neutral" : "warn";

  return (
    <details className="group relative shrink-0">
      <summary
        className={`flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-md border px-2 text-[11px] font-bold outline-none [&::-webkit-details-marker]:hidden ${REGISTRATION_TONES[tone as keyof typeof REGISTRATION_TONES]}`}
        title="Zmeniť dostupnosť"
      >
        {busy ? <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden="true" /> : <PhoneIncoming size={12} aria-hidden="true" />}
        {label}
      </summary>
      <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-56 rounded-xl border border-zinc-200 bg-white p-2 text-zinc-950 shadow-2xl">
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange({ status: "available" })}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold hover:bg-zinc-100 disabled:text-zinc-400"
        >
          <PhoneCall size={13} aria-hidden="true" />
          Dostupný
        </button>
        {pauseReasons.map((reason) => (
          <button
            key={reason.id}
            type="button"
            disabled={busy}
            onClick={() => onChange({ status: "paused", pauseReasonId: reason.id })}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold hover:bg-zinc-100 disabled:text-zinc-400"
          >
            <Pause size={13} aria-hidden="true" />
            Pauza · {reason.label}
          </button>
        ))}
        {pauseReasons.length === 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onChange({ status: "paused" })}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold hover:bg-zinc-100 disabled:text-zinc-400"
          >
            <Pause size={13} aria-hidden="true" />
            Pauza
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange({ status: "offline" })}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold hover:bg-zinc-100 disabled:text-zinc-400"
        >
          <PhoneOff size={13} aria-hidden="true" />
          Odhlásiť z telefónie
        </button>
        <p className="mt-1 border-t border-zinc-200 pt-1.5 text-[11px] font-medium leading-4 text-zinc-500">
          Stav sa nedá zmeniť počas hovoru.
        </p>
      </div>
    </details>
  );
}

function BarButton({
  busy = false,
  compact = false,
  disabled = false,
  icon: Icon,
  label,
  onClick,
  tone,
}: {
  busy?: boolean;
  compact?: boolean;
  disabled?: boolean;
  icon: typeof Phone;
  label: string;
  onClick: () => void;
  tone: "default" | "accept" | "danger" | "warn";
}) {
  const tones: Record<typeof tone, string> = {
    default: "border-white/15 bg-white/10 text-white hover:bg-white/20",
    accept: "border-emerald-400 bg-emerald-500 text-emerald-950 hover:bg-emerald-400",
    danger: "border-red-400 bg-red-500 text-white hover:bg-red-400",
    warn: "border-amber-300 bg-amber-400 text-amber-950 hover:bg-amber-300",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={label}
      aria-label={label}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]}`}
    >
      {busy ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon size={13} aria-hidden="true" />}
      {!compact && <span className="hidden lg:inline">{label}</span>}
    </button>
  );
}
