import { formatNumber } from "../lib/display";
import type { PhoneState } from "../voice/phone";

/** What the call screen shows for the phone's own call; null without one. */
export type CallView = {
  title: string; status: string; tone: "ringing" | "active" | "held" | "working";
  ringing: boolean; connected: boolean;
  /** Answer and decline instead of the in-call controls. */
  showAnswer: boolean;
  /** Mute, speaker, hold and keypad. */
  showControls: boolean;
  canHold: boolean; holdPending: boolean; held: boolean; holdUncertain: boolean; canKeypad: boolean;
  /** Blind transfer to a colleague; not while a hold change is being confirmed. */
  canTransfer: boolean;
  endLabel: "Odmietnuť" | "Ukončiť" | "Zopakovať ukončenie";
};

export function callView(state: PhoneState): CallView | null {
  if (!state.call && !state.termination) return null;
  const call = state.call;
  const ringing = call?.state === "RINGING" && !call.outgoing;
  const recovering = call?.state === "DROPPED" || call?.state === "RECONNECTING";
  const holdPending = state.nativeSyncPending || state.holdPhase !== "idle" || call?.media?.state === "pending";
  const held = call?.media?.state === "held" && !holdPending;
  const connected = Boolean(call?.connected);
  const terminating = Boolean(state.termination);
  const status = terminating ? "Ukončujem hovor…" : recovering ? "Obnovujem spojenie…" : ringing ? "Prichádzajúci hovor" : holdPending ? "Overujem stav podržania…"
    : held ? "Hovor je podržaný" : connected ? "Prebieha hovor" : "Spájam hovor…";
  const showControls = connected && !recovering && !terminating;
  return {
    title: call ? call.displayName || formatNumber(call.number) : "Hovor",
    status, tone: ringing ? "ringing" : held ? "held" : connected && !recovering && !terminating && !holdPending ? "active" : "working",
    ringing, connected, showAnswer: ringing && !terminating, showControls,
    canHold: showControls && Boolean(call?.media?.canHold || holdPending), holdPending, held,
    holdUncertain: showControls && state.holdPhase === "uncertain",
    canKeypad: showControls && call?.media?.state !== "held" && !holdPending,
    canTransfer: showControls && !holdPending,
    endLabel: terminating ? "Zopakovať ukončenie" : ringing ? "Odmietnuť" : "Ukončiť",
  };
}

/** The recorder line of the call screen; null when the call is not recorded or not connected. */
export type RecordingView = {
  label: string; tone: "red" | "orange" | "gray";
  /** Zastaviť nahrávanie, or a retry of an unconfirmed stop. */
  canStop: boolean; retry: boolean;
  /** A stop was sent but the provider has not confirmed it yet. */
  unconfirmed: boolean;
};
const RECORDING: Record<string, Omit<RecordingView, "canStop"> & { stoppable: boolean }> = {
  notice: { label: "Prehráva sa oznámenie o nahrávaní", tone: "orange", stoppable: true, retry: false, unconfirmed: false },
  starting: { label: "Nahrávanie sa spúšťa", tone: "orange", stoppable: true, retry: false, unconfirmed: false },
  recording: { label: "Nahráva sa", tone: "red", stoppable: true, retry: false, unconfirmed: false },
  stopping: { label: "Zastavenie čaká na potvrdenie", tone: "orange", stoppable: false, retry: false, unconfirmed: true },
  stopped: { label: "Nahrávanie zastavené", tone: "gray", stoppable: false, retry: false, unconfirmed: false },
  failed: { label: "Nahrávanie zlyhalo", tone: "orange", stoppable: true, retry: true, unconfirmed: false },
  unknown: { label: "Stav nahrávania nie je potvrdený", tone: "orange", stoppable: true, retry: true, unconfirmed: false },
};
export function recordingView(state: PhoneState, view: CallView | null): RecordingView | null {
  const recording = state.call?.connected ? state.call.recording : null;
  const known = recording ? RECORDING[recording.state] : undefined;
  if (!view || !known) return null;
  const { stoppable, ...rest } = known;
  return { ...rest, label: recording?.state === "stopped" && recording.suppressed ? "Nahrávanie zastavené, už sa neobnoví" : rest.label, canStop: stoppable && view.showControls };
}
