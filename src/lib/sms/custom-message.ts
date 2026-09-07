import { smsSegments } from "./segments";

export const MAX_CUSTOM_SMS_LENGTH = 1200;

export type CustomSmsDraft = {
  message: string;
  toNumber: string;
};

export function validateCustomSmsDraft(input: { message?: unknown; toNumber?: unknown }): CustomSmsDraft {
  const toNumber = String(input.toNumber ?? "").trim();
  const message = String(input.message ?? "").trim();

  if (!toNumber) {
    throw new Error("Zadajte telefónne číslo príjemcu.");
  }

  if (!message) {
    throw new Error("Napíšte text SMS správy.");
  }

  if (message.length > MAX_CUSTOM_SMS_LENGTH) {
    throw new Error(`SMS správa môže mať najviac ${MAX_CUSTOM_SMS_LENGTH} znakov.`);
  }

  if (/\{[^{}]+\}/.test(message)) throw new Error("Doplňte všetky premenné v texte SMS.");
  if (smsSegments(message).segments > 10) throw new Error("SMS môže mať najviac 10 segmentov. Skráťte text.");

  return { message, toNumber };
}
