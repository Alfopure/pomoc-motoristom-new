"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Ear,
  Grid3x3,
  Headphones,
  Link2,
  LogOut,
  Loader2,
  Megaphone,
  Mic,
  MicOff,
  Minimize2,
  MoreHorizontal,
  Pause,
  PauseCircle,
  Phone,
  PhoneCall,
  PhoneForwarded,
  PhoneIncoming,
  PhoneOff,
  PlayCircle,
  Plus,
  UserPlus,
  UserX,
  Users,
  Volume2,
  X,
} from "lucide-react";

import type { CallParticipant, PhoneBarCall, PhoneBarModel } from "@/lib/telephony/active-calls-model";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { SUPERVISOR_MODE_HINTS, SUPERVISOR_MODE_LABELS, SUPERVISOR_MODE_ORDER, type SupervisorMode } from "@/lib/telephony/supervisor-mode";
import type { WebphoneSnapshot } from "@/lib/telephony/telnyx-webphone";

import { CallTransferPicker, type TransferPickerMode, type TransferRequest } from "./CallTransferPicker";
import { CallRecordingControls } from "./recordings/CallRecordingControls";
import { CallRecordingIndicator } from "./recordings/CallRecordingIndicator";
import styles from "./PhoneBar.module.css";
import {
  callElapsedSeconds,
  DTMF_KEYS,
  formatCallTimer,
  partyBusyKey,
  phoneBarCapabilities,
  phoneBarFocusedCall,
  phoneBarStateLabel,
  PHONE_ACTION_LABELS,
  type PhoneCallAction,
  type PhonePartyAction,
} from "./phone-bar-model";

export type PhoneBarProps = {
  model: PhoneBarModel;
  phone: WebphoneSnapshot;
  /** Sessions whose conference promotion failed: advanced actions are refused. */
  degradedSessionIds: ReadonlySet<string>;
  busyAction: string | null;
  notice: string | null;
  onDismissNotice: () => void;
  onCallAction: (action: PhoneCallAction, sessionId: string, target?: TransferRequest) => void;
  /** Mute / unmute / disconnect one added participant of the conference. */
  onPartyAction: (action: PhonePartyAction, sessionId: string, legId: string) => void;
  /** Manager and admin only: supervision of a colleague's live call. */
  canSupervise: boolean;
  onSupervise: (sessionId: string, mode: SupervisorMode) => void;
  onStopSupervise: (sessionId: string) => void;
  onAnswer: () => void;
  onHangupBrowser: () => void;
  onToggleMute: () => void;
  onDtmf: (digit: string) => void;
  onNewCase: (call: PhoneBarCall) => void;
  onLinkCase: (call: PhoneBarCall) => void;
  onOpenCase: (caseId: string) => void;
  onResumeAudio?: () => void;
  outboundPending?: boolean;
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
  // A finished call must not leave its keypad or destination picker open for
  // the next caller. Prefer the browser ID while the server catches up.
  const callKey = props.phone.call?.id ?? props.model.active?.sessionId ?? props.model.offers[0]?.sessionId ?? "idle";
  return <PhoneBarControls key={callKey} {...props} />;
}

function PhoneBarControls(props: PhoneBarProps) {
  const { model, phone } = props;
  const [now, setNow] = useState(() => Date.now());
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [transferMode, setTransferMode] = useState<TransferPickerMode | null>(null);
  const [partiesOpen, setPartiesOpen] = useState(false);
  const [superviseOpen, setSuperviseOpen] = useState(false);
  const [dtmfLog, setDtmfLog] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [minimizedOfferId, setMinimizedOfferId] = useState<string | null>(null);
  const secondaryId = useId();
  const keypadId = useId();
  const recordingId = useId();
  const recordingTriggerRef = useRef<HTMLButtonElement>(null);
  const recordingCloseRef = useRef<HTMLButtonElement>(null);
  const keypadTriggerRef = useRef<HTMLButtonElement>(null);
  const keypadCloseRef = useRef<HTMLButtonElement>(null);

  const focus = phoneBarFocusedCall(model, phone.call);
  const degraded = focus ? props.degradedSessionIds.has(focus.sessionId) : false;
  const recordingCallId = focus?.kind === "active" && focus.mine ? focus.callId : null;

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

  useEffect(() => {
    if (keypadOpen) keypadCloseRef.current?.focus();
  }, [keypadOpen]);

  useEffect(() => {
    if (recordingOpen) recordingCloseRef.current?.focus();
  }, [recordingOpen]);

  useEffect(() => {
    if (!keypadOpen && !moreOpen && !transferMode && !partiesOpen && !superviseOpen && !recordingOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setKeypadOpen(false);
      setMoreOpen(false);
      setTransferMode(null);
      setPartiesOpen(false);
      setSuperviseOpen(false);
      setRecordingOpen(false);
      if (keypadOpen) keypadTriggerRef.current?.focus();
      if (recordingOpen) recordingTriggerRef.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [keypadOpen, moreOpen, transferMode, partiesOpen, superviseOpen, recordingOpen]);

  function runAction(action: PhoneCallAction) {
    if (!focus) return;
    props.onCallAction(action, focus.sessionId);
  }

  const busy = props.busyAction !== null;
  const secondaryAvailable = capabilities.hold || capabilities.unhold || capabilities.transfer || capabilities.consult
    || capabilities.completeTransfer || capabilities.cancelConsult || capabilities.addParty || capabilities.leaveConference
    || capabilities.park || capabilities.newCase || capabilities.linkCase
    || (focus?.kind === "active" && focus.participants.length > 2)
    || (props.canSupervise && (model.others.length > 0 || Boolean(model.supervising)));

  function closeKeypad() {
    setKeypadOpen(false);
    keypadTriggerRef.current?.focus();
  }

  function openTransfer(mode: TransferPickerMode) {
    setTransferMode((current) => current === mode ? null : mode);
    setMoreOpen(false);
    setKeypadOpen(false);
    setPartiesOpen(false);
    setSuperviseOpen(false);
    setRecordingOpen(false);
  }

  return (
    <div
      data-testid="phone-bar"
      className="relative z-40 flex min-h-12 shrink-0 flex-wrap items-center gap-1.5 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-white sm:px-4 lg:gap-2"
    >
      {focus ? (
        <CallSummary call={focus} degraded={degraded} now={now} onOpenCase={props.onOpenCase}
          recordingIndicator={recordingCallId && <CallRecordingIndicator key={recordingCallId} callId={recordingCallId}
            buttonRef={recordingTriggerRef} expanded={recordingOpen} controls={recordingId}
            onClick={() => {
              setRecordingOpen((open) => !open);
              setKeypadOpen(false); setMoreOpen(false); setTransferMode(null); setPartiesOpen(false); setSuperviseOpen(false);
            }} />} />
      ) : phone.call ? (
        <BrowserCallSummary call={phone.call} />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-400">
          {props.outboundPending ? "Spájam hovor…" : model.waiting.length > 0
            ? `V čakárni čaká ${model.waiting.length} ${model.waiting.length === 1 ? "hovor" : model.waiting.length < 5 ? "hovory" : "hovorov"}.`
            : "Žiadny prebiehajúci hovor."}
        </span>
      )}

      <div className="flex w-full shrink-0 flex-wrap items-center gap-1.5 lg:w-auto">
        {capabilities.answer && (
          <BarButton tone="accept" icon={PhoneCall} label={phone.answering ? "Prijímam…" : "Prijať"} busy={phone.answering} onClick={props.onAnswer} />
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
          <BarButton
            tone={keypadOpen ? "warn" : "default"}
            icon={Grid3x3}
            label="Klávesnica"
            buttonRef={keypadTriggerRef}
            expanded={keypadOpen}
            controls={keypadId}
            onClick={() => {
              setKeypadOpen((open) => !open);
              setTransferMode(null);
              setPartiesOpen(false);
              setSuperviseOpen(false);
              setRecordingOpen(false);
              setMoreOpen(false);
            }}
            compact
          />
        )}
        {capabilities.hangup && (
          <BarButton
            tone="danger"
            icon={PhoneOff}
            label={focus?.kind === "offer" || phone.call?.ringing ? "Odmietnuť" : PHONE_ACTION_LABELS.hangup}
            busy={props.busyAction === "hangup"}
            disabled={busy && props.busyAction !== "hangup"}
            onClick={() => (focus?.kind === "offer" || phone.call?.ringing ? props.onHangupBrowser() : focus ? runAction("hangup") : props.onHangupBrowser())}
          />
        )}
        {secondaryAvailable && (
          <BarButton
            tone={moreOpen ? "warn" : "default"}
            icon={MoreHorizontal}
            label="Viac"
            expanded={moreOpen}
            controls={secondaryId}
            className="ml-auto lg:hidden"
            onClick={() => {
              setMoreOpen((open) => !open);
              setKeypadOpen(false);
              setTransferMode(null);
              setPartiesOpen(false);
              setSuperviseOpen(false);
              setRecordingOpen(false);
            }}
          />
        )}
      </div>

      <div id={secondaryId} className={`${styles.secondaryActions} ${moreOpen ? "flex" : "hidden"} w-full flex-wrap items-center gap-1.5 border-t border-white/15 pt-1.5 lg:flex lg:w-auto lg:border-0 lg:pt-0`}>
        <div className="flex w-full items-center justify-between lg:hidden">
          <span className="text-xs font-bold">Ďalšie možnosti hovoru</span>
          <button type="button" className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-white/10" aria-label="Zavrieť možnosti hovoru" onClick={() => setMoreOpen(false)}><X size={18} aria-hidden="true" /></button>
        </div>
        {capabilities.unhold && (
          <BarButton tone="default" icon={PlayCircle} label={PHONE_ACTION_LABELS.unhold} busy={props.busyAction === "unhold"} disabled={busy} onClick={() => runAction("unhold")} />
        )}
        {capabilities.hold && (
          <BarButton tone="default" icon={PauseCircle} label={PHONE_ACTION_LABELS.hold} busy={props.busyAction === "hold"} disabled={busy} onClick={() => runAction("hold")} />
        )}
        {capabilities.transfer && (
          <BarButton
            tone="default"
            icon={PhoneForwarded}
            label={PHONE_ACTION_LABELS.transfer}
            disabled={busy}
            onClick={() => openTransfer("transfer")}
          />
        )}
        {capabilities.consult && (
          <BarButton
            tone="default"
            icon={Users}
            label={PHONE_ACTION_LABELS.consult}
            disabled={busy}
            onClick={() => openTransfer("consult")}
          />
        )}
        {capabilities.completeTransfer && (
          <BarButton tone="accept" icon={PhoneForwarded} label={PHONE_ACTION_LABELS["complete-transfer"]} busy={props.busyAction === "complete-transfer"} disabled={busy} onClick={() => runAction("complete-transfer")} />
        )}
        {capabilities.cancelConsult && (
          <BarButton tone="default" icon={PhoneOff} label={PHONE_ACTION_LABELS["cancel-consult"]} busy={props.busyAction === "cancel-consult"} disabled={busy} onClick={() => runAction("cancel-consult")} />
        )}
        {capabilities.addParty && (
          <BarButton
            tone="default"
            icon={UserPlus}
            label={PHONE_ACTION_LABELS["add-party"]}
            disabled={busy}
            compact
            onClick={() => openTransfer("add-party")}
          />
        )}
        {focus?.kind === "active" && focus.participants.length > 2 && (
          <BarButton
            tone={partiesOpen ? "warn" : "default"}
            icon={Users}
            label={`Účastníci (${focus.participants.length})`}
            compact
            onClick={() => { setPartiesOpen((open) => !open); setMoreOpen(false); setSuperviseOpen(false); setTransferMode(null); setRecordingOpen(false); }}
          />
        )}
        {capabilities.leaveConference && (
          <BarButton tone="default" icon={LogOut} label={PHONE_ACTION_LABELS.leave} busy={props.busyAction === "leave"} disabled={busy} onClick={() => runAction("leave")} />
        )}
        {props.canSupervise && (model.others.length > 0 || model.supervising) && (
          <BarButton
            tone={model.supervising ? "warn" : "default"}
            icon={Headphones}
            label={model.supervising ? "Dozor prebieha" : "Dozor"}
            compact={!model.supervising}
            onClick={() => { setSuperviseOpen((open) => !open); setMoreOpen(false); setPartiesOpen(false); setTransferMode(null); setRecordingOpen(false); }}
          />
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
      </div>

      {phone.audioBlocked && props.onResumeAudio && (
        <button type="button" onClick={props.onResumeAudio} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-amber-300 bg-amber-400 px-3 text-xs font-bold text-amber-950 lg:min-h-8 lg:w-auto">
          <Volume2 size={16} aria-hidden="true" />
          Zapnúť zvuk hovoru
        </button>
      )}

      {model.offers.length > 1 && (
        <span className="rounded-md border border-yellow-300/40 bg-yellow-300/15 px-2 py-1 text-[11px] font-bold text-yellow-100">
          Ďalšie zvoniace hovory: {model.offers.length - 1}
        </span>
      )}

      {focus?.kind === "offer" && minimizedOfferId === focus.sessionId && (
        <BarButton tone="default" icon={PhoneIncoming} label="Zobraziť prichádzajúci hovor" onClick={() => setMinimizedOfferId(null)} />
      )}
      {focus?.kind === "offer" && minimizedOfferId !== focus.sessionId && (
        <RingingPanel
          answerable={Boolean(phone.call?.ringing && !phone.answering)}
          now={now}
          offers={[focus]}
          onAnswer={props.onAnswer}
          onNewCase={props.onNewCase}
          onOpenCase={props.onOpenCase}
          onMinimize={() => setMinimizedOfferId(focus.sessionId)}
        />
      )}

      {focus?.audioConnection?.status === "failed" && <p role="alert" className="basis-full rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-950">Spojenie zvuku sa nepodarilo potvrdiť. Ak sa hovor nespojí, ukončite ho a zavolajte znova.</p>}

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

      {recordingOpen && recordingCallId && (
        <section id={recordingId} aria-label="Možnosti nahrávania" className={`${styles.popup} z-50 w-72 rounded-xl border border-zinc-200 bg-white p-3 text-zinc-950 shadow-2xl`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-bold">Nahrávanie hovoru</h3>
            <button ref={recordingCloseRef} type="button" className="inline-flex size-11 items-center justify-center rounded-md hover:bg-zinc-100"
              aria-label="Zavrieť možnosti nahrávania" onClick={() => { setRecordingOpen(false); recordingTriggerRef.current?.focus(); }}><X size={18} aria-hidden="true" /></button>
          </div>
          <CallRecordingControls key={recordingCallId} callId={recordingCallId} />
        </section>
      )}

      {keypadOpen && capabilities.dtmf && (
        <section id={keypadId} aria-label="Klávesnica počas hovoru" className={`${styles.popup} ${styles.keypad} z-50 w-64 rounded-xl border border-zinc-200 bg-white p-2 text-zinc-950 shadow-2xl`}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-bold">Klávesnica počas hovoru</h3>
            <button ref={keypadCloseRef} type="button" onClick={closeKeypad} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-zinc-100" aria-label="Zavrieť klávesnicu"><X size={18} aria-hidden="true" /></button>
          </div>
          <div className="mb-1.5 h-6 truncate rounded bg-zinc-100 px-2 text-sm font-mono leading-6" aria-label="Odoslané číslice" aria-live="polite">
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
                className="h-12 rounded-md border border-zinc-200 text-base font-bold transition hover:bg-zinc-100 active:bg-yellow-100"
              >
                {key}
              </button>
            ))}
          </div>
        </section>
      )}

      {transferMode && focus && (
        <div className={`${styles.popup} z-50 w-80`}>
          <CallTransferPicker
            sessionId={focus.sessionId}
            mode={transferMode}
            busy={busy}
            onCancel={() => setTransferMode(null)}
            onSubmit={(target) => {
              props.onCallAction(transferMode, focus.sessionId, target);
              setTransferMode(null);
            }}
          />
        </div>
      )}

      {partiesOpen && focus?.kind === "active" && (
        <ParticipantsPanel
          busyAction={props.busyAction}
          call={focus}
          onAction={(action, legId) => props.onPartyAction(action, focus.sessionId, legId)}
          onClose={() => setPartiesOpen(false)}
        />
      )}

      {superviseOpen && props.canSupervise && (
        <SupervisePanel
          busyAction={props.busyAction}
          model={model}
          now={now}
          onClose={() => setSuperviseOpen(false)}
          onStopSupervise={props.onStopSupervise}
          onSupervise={props.onSupervise}
        />
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
  onMinimize,
}: {
  answerable: boolean;
  now: number;
  offers: PhoneBarCall[];
  onAnswer: () => void;
  onNewCase: (call: PhoneBarCall) => void;
  onOpenCase: (caseId: string) => void;
  onMinimize: () => void;
}) {
  return (
    <section
      aria-label="Prichádzajúci hovor"
      data-testid="phone-bar-ringing"
      className="absolute left-3 top-[calc(100%+6px)] z-50 hidden w-80 max-w-[calc(100vw-24px)] rounded-xl border border-yellow-300 bg-white p-3 text-zinc-950 shadow-2xl lg:block"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-zinc-600">Prichádzajúci hovor</span>
        <button type="button" onClick={onMinimize} aria-label="Minimalizovať prichádzajúci hovor" className="inline-flex size-8 items-center justify-center rounded-md hover:bg-zinc-100"><Minimize2 size={16} aria-hidden="true" /></button>
      </div>
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

/**
 * Who is on the call right now.
 *
 * Only the third parties the operator added can be muted or thrown out
 * (`controllable`); the caller and the operator's own leg are listed for
 * orientation. A supervisor is shown with the mode they are in, because an
 * operator being coached should not have to guess whether they are alone.
 */
function ParticipantsPanel({
  busyAction,
  call,
  onAction,
  onClose,
}: {
  busyAction: string | null;
  call: PhoneBarCall;
  onAction: (action: PhonePartyAction, legId: string) => void;
  onClose: () => void;
}) {
  return (
    <section
      aria-label="Účastníci hovoru"
      data-testid="phone-bar-participants"
      className={`${styles.popup} z-50 w-80 rounded-xl border border-zinc-200 bg-white p-3 text-zinc-950 shadow-2xl`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">Účastníci hovoru</h3>
        <button type="button" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 lg:h-7 lg:w-7" aria-label="Zavrieť účastníkov">
          ×
        </button>
      </div>
      <ul className="mt-2 grid gap-1">
        {call.participants.map((participant) => (
          <li key={participant.legId} className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-200 px-2 py-1.5">
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-bold">
                <span className="truncate">{participant.name}</span>
                {participant.self && <span className="shrink-0 text-[10px] font-bold text-zinc-500">(ty)</span>}
                {participant.muted && <MicOff size={12} className="shrink-0 text-amber-600" aria-label="Stlmený" />}
              </span>
              <span className="mt-0.5 block truncate text-[11px] font-medium text-zinc-500">
                {participantSubtitle(participant)}
              </span>
            </span>
            {participant.controllable && (
              <span className="flex shrink-0 items-center gap-1">
                <PartyButton
                  busy={busyAction === partyBusyKey(participant.muted ? "unmute" : "mute", call.sessionId, participant.legId)}
                  disabled={busyAction !== null}
                  icon={participant.muted ? Mic : MicOff}
                  label={participant.muted ? "Odtlmiť" : "Stlmiť"}
                  onClick={() => onAction(participant.muted ? "unmute" : "mute", participant.legId)}
                />
                <PartyButton
                  busy={busyAction === partyBusyKey("kick", call.sessionId, participant.legId)}
                  disabled={busyAction !== null}
                  danger
                  icon={UserX}
                  label="Odpojiť"
                  onClick={() => onAction("kick", participant.legId)}
                />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function participantSubtitle(participant: CallParticipant): string {
  if (participant.kind === "supervisor") {
    const mode = participant.supervisorMode as SupervisorMode | null;
    return mode ? `Dozor · ${SUPERVISOR_MODE_LABELS[mode]}` : "Dozor · pripája sa";
  }
  if (!participant.answered) return participant.kind === "party" ? "Zvoní…" : "Pripája sa…";
  if (participant.kind === "caller") return participant.detail ?? "Volajúci";
  if (participant.kind === "consult") return "Konzultácia";
  return participant.detail ?? (participant.kind === "party" ? "Pridaný účastník" : "Operátor");
}

function PartyButton({
  busy,
  danger = false,
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  busy: boolean;
  danger?: boolean;
  disabled: boolean;
  icon: typeof Phone;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-50 lg:h-7 lg:w-7 ${
        danger ? "border-red-200 text-red-700 hover:bg-red-50" : "border-zinc-200 text-zinc-700 hover:bg-zinc-100"
      }`}
    >
      {busy ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon size={13} aria-hidden="true" />}
    </button>
  );
}

/**
 * Supervision (manager and admin only): pick a colleague's live call and the
 * mode. Every press writes an audit row server-side, so the panel names the
 * consequence of each mode instead of hiding it behind an icon.
 */
function SupervisePanel({
  busyAction,
  model,
  now,
  onClose,
  onStopSupervise,
  onSupervise,
}: {
  busyAction: string | null;
  model: PhoneBarModel;
  now: number;
  onClose: () => void;
  onStopSupervise: (sessionId: string) => void;
  onSupervise: (sessionId: string, mode: SupervisorMode) => void;
}) {
  const supervising = model.supervising;
  return (
    <section
      aria-label="Dozor nad hovorom"
      data-testid="phone-bar-supervise"
      className={`${styles.popup} z-50 w-96 rounded-xl border border-zinc-200 bg-white p-3 text-zinc-950 shadow-2xl`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">Dozor nad hovorom</h3>
        <button type="button" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 lg:h-7 lg:w-7" aria-label="Zavrieť dozor">
          ×
        </button>
      </div>

      {supervising && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5">
          <p className="text-[11px] font-bold text-amber-900">
            {supervising.pending ? "Dozor sa pripája…" : `Prebieha dozor · ${SUPERVISOR_MODE_LABELS[(supervising.mode ?? "monitor") as SupervisorMode]}`}
          </p>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => onStopSupervise(supervising.sessionId)}
            className="mt-1.5 inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-300 px-2 text-xs font-bold text-zinc-800 transition hover:bg-white disabled:opacity-50"
          >
            <PhoneOff size={13} aria-hidden="true" />
            Ukončiť dozor
          </button>
        </div>
      )}

      <div className="mt-2 grid max-h-64 gap-2 overflow-y-auto pr-1">
        {model.others.length === 0 && <p className="px-1 py-2 text-xs font-medium text-zinc-500">Žiadny kolega práve netelefonuje.</p>}
        {model.others.map((call) => {
          const operator = call.participants.find((participant) => participant.kind === "operator");
          const current = supervising?.sessionId === call.sessionId ? ((supervising.mode ?? null) as SupervisorMode | null) : null;
          return (
            <div key={call.sessionId} className="rounded-md border border-zinc-200 p-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-bold">{operator?.name ?? "Operátor"}</span>
                <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-zinc-600">{formatCallTimer(callElapsedSeconds(call, now))}</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] font-medium text-zinc-500">
                {call.lineLabel} · {call.callerName ?? (formatPhoneNumberForDisplay(call.number) || call.number || "Neznáme číslo")}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {SUPERVISOR_MODE_ORDER.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={busyAction !== null || current === mode}
                    title={SUPERVISOR_MODE_HINTS[mode]}
                    onClick={() => onSupervise(call.sessionId, mode)}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      current === mode ? "border-amber-400 bg-amber-100 text-amber-900" : "border-zinc-200 text-zinc-800 hover:bg-zinc-100"
                    }`}
                  >
                    {mode === "monitor" ? <Ear size={13} aria-hidden="true" /> : mode === "whisper" ? <Megaphone size={13} aria-hidden="true" /> : <PhoneCall size={13} aria-hidden="true" />}
                    {SUPERVISOR_MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 border-t border-zinc-200 pt-1.5 text-[11px] font-medium leading-4 text-zinc-500">
        Každý dozor sa zapisuje do auditu spolu s režimom a hovorom. Ak hovor ešte nie je v konferencii, volajúci môže pri spustení dozoru počuť krátke ticho.
      </p>
    </section>
  );
}

function CallSummary({
  call,
  degraded,
  now,
  onOpenCase,
  recordingIndicator,
}: {
  call: PhoneBarCall;
  degraded: boolean;
  now: number;
  onOpenCase: (caseId: string) => void;
  recordingIndicator?: React.ReactNode;
}) {
  const state = phoneBarStateLabel(call);
  const elapsed = formatCallTimer(callElapsedSeconds(call, now));
  const number = formatPhoneNumberForDisplay(call.number) || call.number || "Neznáme číslo";

  return (
    <div className="flex min-w-0 flex-1 basis-full items-center gap-2 lg:basis-auto">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold leading-5 lg:text-sm" title={call.callerName ? `${call.callerName} · ${number}` : number}>
          {call.callerName ? `${call.callerName} · ${number}` : number}
        </p>
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] lg:text-[11px]">
          <span className={`shrink-0 rounded px-1.5 py-0.5 font-bold ${STATE_TONES[state.tone]}`}>{state.label}</span>
          <span className="min-w-0 truncate font-semibold text-zinc-300" title={`Volaná linka: ${call.lineLabel}`}>{call.lineLabel}</span>
          <span className="shrink-0 font-mono font-semibold tabular-nums text-zinc-200" aria-label="Dĺžka hovoru">{elapsed}</span>
          {call.match && call.matchCount > 1 && <span className="hidden shrink-0 text-zinc-400 lg:inline">+{call.matchCount - 1} ďalšie zhody</span>}
          {degraded && <AlertTriangle size={14} className="shrink-0 text-amber-300" aria-label="Rozšírené funkcie nedostupné" />}
        </div>
      </div>
      {recordingIndicator}
      {(call.caseId || call.match?.caseId) && (
        <button
          type="button"
          onClick={() => onOpenCase((call.caseId || call.match?.caseId) as string)}
          className={`inline-flex min-h-11 max-w-28 shrink-0 items-center rounded-md px-2 text-[10px] font-bold lg:min-h-8 lg:text-[11px] ${call.caseId ? "bg-[#FCD703] text-zinc-950 hover:bg-yellow-300" : "border border-yellow-300/50 bg-yellow-300/15 text-yellow-100"}`}
          title={call.caseId ? "Otvoriť priradený prípad" : "Nájdená zhoda podľa čísla"}
        >
          <span className="truncate">{call.match?.caseNumber ?? (call.caseId ? "Prípad" : call.match?.label)}</span>
        </button>
      )}
    </div>
  );
}

function BrowserCallSummary({ call }: { call: NonNullable<WebphoneSnapshot["call"]> }) {
  const number = formatPhoneNumberForDisplay(call.number) || call.number || "Neznáme číslo";
  return (
    <div className="min-w-0 flex-1 basis-full lg:basis-auto" data-testid="phone-bar-browser-call">
      <p className="truncate text-xs font-bold leading-5 lg:text-sm" title={call.callerName ? `${call.callerName} · ${number}` : number}>
        {call.callerName ? `${call.callerName} · ${number}` : number}
      </p>
      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${STATE_TONES[call.ringing ? "ring" : "live"]}`}>
        {call.ringing ? "Prichádzajúci hovor" : call.active ? "Prebieha" : "Pripájam hovor…"}
      </span>
    </div>
  );
}

function BarButton({
  busy = false,
  buttonRef,
  className = "",
  controls,
  expanded,
  compact = false,
  disabled = false,
  icon: Icon,
  label,
  onClick,
  tone,
}: {
  busy?: boolean;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
  className?: string;
  controls?: string;
  expanded?: boolean;
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
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      data-compact={compact || undefined}
      className={`inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50 lg:h-8 lg:min-w-0 ${tones[tone]} ${className}`}
    >
      {busy ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon size={13} aria-hidden="true" />}
      {<span className={compact ? "hidden" : undefined}>{label}</span>}
    </button>
  );
}
