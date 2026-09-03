"use client";

import { AlertTriangle } from "lucide-react";

/**
 * Permanent reminder that the browser phone is not an emergency line.
 *
 * Telnyx numbers used here are ordinary SK DIDs and the outbound allowlist is
 * SK/CZ mobile and landline ranges: 112, 150, 155 and 158 are *not* reachable
 * from this phone, and an operator must never assume they are. The notice is
 * intentionally always visible (design KB §8 / risk register), never a toast
 * that can be dismissed and forgotten.
 */
export function EmergencyNotice({ variant = "bar" }: { variant?: "bar" | "inline" }) {
  const text = "Tiesňové čísla (112, 150, 155, 158) nie sú z telefónu v prehliadači dostupné — volajte z mobilu.";

  if (variant === "inline") {
    return (
      <p className="flex items-start gap-1.5 text-[11px] font-semibold leading-4 text-amber-900" data-testid="emergency-notice">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{text}</span>
      </p>
    );
  }

  return (
    <div
      role="note"
      data-testid="emergency-notice"
      className="flex items-center gap-1.5 rounded-md border border-amber-300/60 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold leading-4 text-amber-100"
      title={text}
    >
      <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
      <span className="hidden xl:inline">Tiesňové čísla nie sú dostupné</span>
      <span className="xl:hidden">112 ✕</span>
    </div>
  );
}
