"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";

import type { CallParticipant, PhoneBarCall, PhoneBarModel } from "@/lib/telephony/active-calls-model";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { SUPERVISOR_MODE_HINTS, SUPERVISOR_MODE_LABELS, SUPERVISOR_MODE_ORDER, type SupervisorMode } from "@/lib/telephony/supervisor-mode";
import type { WebphoneSnapshot } from "@/lib/telephony/telnyx-webphone";

import { CallTransferPicker, type TransferPickerMode, type TransferRequest } from "./CallTransferPicker";
import {
  callElapsedSeconds,
  DTMF_KEYS,
  formatCallTimer,
  partyBusyKey,
  phoneBarCapabilities,
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
  onUnlockAudio: () => void;
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
  const [transferMode, setTransferMode] = useState<TransferPickerMode | null>(null);
  const [partiesOpen, setPartiesOpen] = useState(false);
  const [superviseOpen, setSuperviseOpen] = useState(false);
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
        {capabilities.addParty && (
          <BarButton
            tone="default"
            icon={UserPlus}
            label={PHONE_ACTION_LABELS["add-party"]}
            disabled={busy}
            compact
            onClick={() => setTransferMode((mode) => (mode === "add-party" ? null : "add-party"))}
          />
        )}
        {focus?.kind === "active" && focus.participants.length > 2 && (
          <BarButton
            tone={partiesOpen ? "warn" : "default"}
            icon={Users}
            label={`Účastníci (${focus.participants.length})`}
            compact
            onClick={() => setPartiesOpen((open) => !open)}
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
            onClick={() => setSuperviseOpen((open) => !open)}
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
        {capabilities.hangup && (
          <BarButton
            tone="danger"
            icon={PhoneOff}
            label={focus?.kind === "offer" ? "Odmietnuť" : PHONE_ACTION_LABELS.hangup}
            busy={props.busyAction === "hangup"}
            disabled={busy && props.busyAction !== "hangup"}
            onClick={() => (focus?.kind === "offer" ? props.onHangupBrowser() : focus ? runAction("hangup") : props.onHangupBrowser())}
          />
        )}
      </div>

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
      className="absolute right-3 top-[calc(100%+6px)] z-50 w-80 max-w-[calc(100vw-24px)] rounded-xl border border-zinc-200 bg-white p-3 text-zinc-950 shadow-2xl"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">Účastníci hovoru</h3>
        <button type="button" onClick={onClose} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100" aria-label="Zavrieť">
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
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-50 ${
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
      className="absolute right-3 top-[calc(100%+6px)] z-50 w-96 max-w-[calc(100vw-24px)] rounded-xl border border-zinc-200 bg-white p-3 text-zinc-950 shadow-2xl"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">Dozor nad hovorom</h3>
        <button type="button" onClick={onClose} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100" aria-label="Zavrieť">
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
