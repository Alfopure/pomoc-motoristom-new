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
    endLabel: terminating ? "Zopakovať ukončenie" : ringing ? "Odmietnuť" : "Ukončiť",
  };
}
