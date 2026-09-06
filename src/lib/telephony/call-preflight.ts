import type { WebphoneSnapshot } from "./telnyx-webphone";

export type PhoneReadiness = {
  status: "idle" | "checking" | "ready" | "error";
  message: string | null;
};

export function browserCallStartError(phone: WebphoneSnapshot | undefined): string | null {
  if (!phone || phone.status !== "registered") return "Telefón ešte nie je pripojený. Počkajte na pripojenie alebo skontrolujte stav telefónu.";
  if (phone.call || (phone.pendingOperatorLegs ?? 0) > 0) return "Najprv dokončite rozpracovaný hovor.";
  return null;
}

export function microphoneErrorMessage(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Mikrofón je zablokovaný. Povoľte ho v nastaveniach tejto stránky alebo aplikácie a skúste znova.";
  if (name === "NotFoundError") return "Mikrofón sa nenašiel. Pripojte slúchadlá s mikrofónom alebo skontrolujte zariadenie.";
  if (name === "NotReadableError" || name === "AbortError") return "Mikrofón sa nedá použiť. Ukončite iný hovor a skúste znova.";
  return "Mikrofón sa nepodarilo overiť. Skontrolujte jeho povolenie a skúste znova.";
}

/** A local permission check only: never records or uploads audio. Even a late
 * permission grant after cancellation must immediately release every track. */
export function checkMicrophone(options: {
  signal: AbortSignal;
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  timeoutMs?: number;
}): Promise<void> {
  const devices = options.mediaDevices ?? (typeof navigator === "undefined" ? undefined : navigator.mediaDevices);
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) { reject(new Error("Kontrola mikrofónu bola zrušená.")); return; }
    if (!devices?.getUserMedia) { reject(new Error("Volanie potrebuje prehliadač s podporou mikrofónu a zabezpečené pripojenie HTTPS.")); return; }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish(new Error("Kontrola mikrofónu bola zrušená."));
    const timer = setTimeout(() => finish(new Error("Povolenie mikrofónu nebolo potvrdené. Povoľte mikrofón a spustite volanie znova.")), options.timeoutMs ?? 20_000);
    options.signal.addEventListener("abort", cancel, { once: true });
    // Call synchronously in the user's gesture, not in a later effect.
    try {
      void devices.getUserMedia({ audio: true, video: false }).then((stream) => {
        const usable = stream.getAudioTracks().some((track) => track.readyState === "live");
        stream.getTracks().forEach((track) => track.stop());
        finish(usable ? undefined : new Error("Mikrofón neposkytuje zvuk. Skontrolujte zariadenie a skúste znova."));
      }, (error: unknown) => finish(new Error(microphoneErrorMessage(error))));
    } catch (error) {
      finish(new Error(microphoneErrorMessage(error)));
    }
  });
}
