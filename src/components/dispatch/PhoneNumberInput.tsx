"use client";

import type { ComponentProps } from "react";
import { normalizeEditablePhone } from "@/lib/telephony/phone-entry";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";

export const PHONE_NUMBER_PLACEHOLDER = "0905 123 456 alebo +420 777 123 456";

type Props = Omit<ComponentProps<"input">, "type" | "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** Keep the typed text in search fields and other non-persistent controls. */
  normalizeOnBlur?: boolean;
  /** Directory entries may address a short internal PBX extension. */
  allowExtension?: boolean;
};

/** One phone input everywhere: local numbers mean Slovakia, +/00 declares another country. */
export function PhoneNumberInput({ value, onChange, onBlur, normalizeOnBlur = true, allowExtension = false, placeholder = PHONE_NUMBER_PLACEHOLDER, autoComplete = "tel", ...props }: Props) {
  return <input
    {...props}
    type="tel"
    inputMode="tel"
    autoComplete={autoComplete}
    placeholder={placeholder}
    value={value}
    onChange={(event) => onChange(event.target.value)}
    onBlur={(event) => {
      let canonical: string | null = null;
      if (normalizeOnBlur) {
        try { canonical = normalizeEditablePhone(event.currentTarget.value, { allowExtension }); }
        catch { /* Leave incomplete or ambiguous text visible for correction. */ }
      }
      if (canonical && canonical !== event.currentTarget.value) onChange(canonical);
      onBlur?.(event);
    }}
  />;
}

export function phoneNumberHint(value: string, allowExtension = false) {
  if (!value.trim()) return "Slovenské číslo stačí zadať ako 0905…; zahraničné začnite + alebo 00 (napr. +420…).";
  let canonical: string | null = null;
  try { canonical = normalizeEditablePhone(value, { allowExtension }); }
  catch { /* Show the same invalid state that storage would reject. */ }
  if (canonical) {
    if (!canonical.startsWith("+")) return `Interná klapka ${canonical}.`;
    const shown = formatPhoneNumberForDisplay(canonical);
    return /^\s*(\+|00)/.test(value)
      ? `Použije sa ${shown}.`
      : `Použije sa ${shown} · predvoľba +421 bola doplnená.`;
  }
  return "Skontrolujte číslo. Pre zahraničie použite + a kód krajiny, napríklad +420…";
}

export function PhoneNumberHint({ value, allowExtension = false, className = "text-xs text-zinc-500" }: { value: string; allowExtension?: boolean; className?: string }) {
  return <span className={className} aria-live="polite">{phoneNumberHint(value, allowExtension)}</span>;
}
