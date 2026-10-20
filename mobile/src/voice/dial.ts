import { createContext, useContext } from "react";
import type { DispatchPhone, PhoneState } from "./phone";

/** Why a new call cannot start now, or null when the phone is ready. */
export function dialBlockedReason(phone: DispatchPhone | null, state: PhoneState, missingPhone = "Volanie z mobilu bude možné v natívnej aplikácii s pripojeným telefónom."): string | null {
  if (!phone) return missingPhone;
  if (state.registration !== "registered") return "Telefón nie je pripojený k ústredni. Pripojte ho v Ústredni.";
  if (state.microphonePermission === "denied") return "Na volanie povoľte prístup k mikrofónu.";
  if (state.call || state.termination) return "Počas hovoru nemožno začať ďalší.";
  if (state.retryTarget) return "Najprv v Ústredni dokončite nepotvrdené volanie.";
  if (state.dialing || state.cancelingAttempt) return "Telefón práve vytáča.";
  return null;
}

/** Calling a number from a case, a call or the history. When the phone is not
 * ready the number goes to Ústredňa instead, where the reason is shown. A call
 * placed from a case names it and is filed with that case. */
export type CallCase = { id: string; caseNumber: string };
export type CallAction = { ready: boolean; call: (number: string, name?: string | null, fromCase?: CallCase) => void };
export const CallActionContext = createContext<CallAction>({ ready: false, call: () => undefined });
export const useCallAction = () => useContext(CallActionContext);
