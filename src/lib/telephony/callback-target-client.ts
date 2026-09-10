import { confirmedCallbackTarget, type CallbackTargetResolution } from "./callback-target";
import { telephonyJson, TELEPHONY_TIMEOUT_MS } from "./client-request";
import { formatPhoneNumberForDisplay } from "./phone";

export async function requestCallbackTargetConfirmation(number: string): Promise<{ dialNumber: string; verificationId?: string } | null> {
  const response = await telephonyJson<{ target?: CallbackTargetResolution; error?: string }>(`/api/telephony/callback-target?number=${encodeURIComponent(number)}`, {
    label: "overenie čísla na spätné volanie", timeoutMs: TELEPHONY_TIMEOUT_MS.read,
  });
  if (!response.ok || !response.body?.target) throw new Error(response.body?.error ?? "Číslo na spätné volanie sa nepodarilo overiť.");
  const target = response.body.target;
  if (target.status === "blocked") throw new Error("Na prijaté číslo sa nedá volať späť. V kontakte najprv overte náhradné číslo.");
  if (target.status === "original") return { dialNumber: target.originalNumber };
  const dialNumber = confirmedCallbackTarget(target, target.verificationId);
  if (!dialNumber || !target.verificationId) throw new Error("Overené náhradné číslo už nie je dostupné.");
  const accepted = window.confirm(`Na pôvodné číslo ${formatPhoneNumberForDisplay(target.originalNumber)}${target.sourceName ? ` (${target.sourceName})` : ""} sa nedá volať späť.\n\nZavolať na overené číslo ${formatPhoneNumberForDisplay(dialNumber)}${target.targetName ? ` (${target.targetName})` : ""}?\n\nPôvodné číslo ostane v histórii.`);
  return accepted ? { dialNumber, verificationId: target.verificationId } : null;
}
