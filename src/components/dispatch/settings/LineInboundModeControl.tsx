"use client";

import type { ReactNode } from "react";
import { ChevronDown, Settings2 } from "lucide-react";

import type { LineInboundMode } from "@/server/telephony/state/types";
import type { LineDoc } from "@/server/telephony/config-service";
import { settingsInputClass } from "./settings-ui";

type Mode = LineInboundMode | null;

export function LineInboundModeControl({ line, defaultMode, canEdit, onChange, available, children }: {
  line: LineDoc;
  children?: ReactNode;
  defaultMode: "ring_first" | "queue_first" | null;
  canEdit: boolean;
  available: boolean;
  onChange: (mode: Mode) => void;
}) {
  const selection = line.inboundCallMode ?? null;

  const inherited = defaultMode === "queue_first" ? "teraz rovno do čakárne" : defaultMode === "ring_first" ? "teraz podľa plánu zvonenia" : "nastavenie organizácie";
  const effectiveMode = selection ?? defaultMode;
  const explanation = effectiveMode === "queue_first"
    ? "Hovor čaká bez automatického zvonenia. Operátor ho vyberie ručne v aplikácii s pripojeným telefónom. Kroky plánu ani jeho záložná akcia sa nespustia."
    : effectiveMode === "ring_all"
      ? "V každom kroku zvonia dostupní členovia naraz. Tento spôsob platí pre všetky plány vybranej linky, aj keď majú uložené postupné zvonenie."
      : effectiveMode === "ring_ordered"
        ? "V každom kroku zvonia dostupní členovia po jednom, v poradí zoznamu. Tento spôsob platí pre všetky plány vybranej linky."
        : effectiveMode === "ring_first"
          ? "Hovor prejde krokmi plánu. V každom kroku si zvolíš, komu a akým spôsobom sa má zvoniť."
          : "Linka preberá nastavenie organizácie. Predvolený režim sa v tejto odpovedi nepodarilo zistiť.";
  const modeLabel = effectiveMode === "queue_first" ? "Ručné prevzatie v čakárni"
    : effectiveMode === "ring_all" ? "Vždy všetkým naraz"
      : effectiveMode === "ring_ordered" ? "Vždy postupne"
        : effectiveMode === "ring_first" ? "Automaticky podľa plánu" : "Podľa nastavenia organizácie";
  return (
    <div className="mt-2">
      <details className="group/mode">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 [&::-webkit-details-marker]:hidden">
          <Settings2 size={14} aria-hidden="true" />
          <span>Režim linky:</span><span className="font-medium text-zinc-800">{modeLabel}</span>
          <span className="ml-auto inline-flex min-h-8 items-center gap-1 font-medium text-zinc-600">{canEdit && available ? "Zmeniť režim" : "Podrobnosti režimu"}<ChevronDown size={13} className="transition group-open/mode:rotate-180" aria-hidden="true" /></span>
        </summary>
        <div className="mt-2 rounded-lg bg-zinc-50 p-3 sm:p-4">
      <label className="grid max-w-xl gap-1 text-sm font-semibold text-zinc-950">
        Čo sa stane s hovorom na číslo {line.phoneNumber}
        <select
          className={settingsInputClass}
          disabled={!canEdit || !available}
          value={selection ?? ""}
          onChange={event => onChange((event.target.value || null) as Mode)}
        >
          <option value="">Podľa predvoľby ({inherited})</option>
          <option value="ring_first">Najprv zvoniť podľa plánu</option>
          <option value="ring_all">Najprv zvoniť všetkým naraz</option>
          <option value="ring_ordered">Najprv zvoniť postupne</option>
          <option value="queue_first">Rovno do čakárne</option>
        </select>
      </label>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">{explanation}</p>
      <p className="mt-2 text-xs leading-5 text-zinc-500">Platí po úvodnej hláške, otváracích hodinách a prípadnom hlasovom menu. <span className="font-medium text-zinc-700">{available ? "Režim sa uloží spolu s ostatnými zmenami tlačidlom Uložiť všetky zmeny." : "Režim môžeš zmeniť v nastavení čísla."}</span></p>
          {children}
        </div>
      </details>

    </div>
  );
}
