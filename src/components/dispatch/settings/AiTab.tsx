"use client";

import { useState } from "react";

import { AiAgentSettingsPanel } from "./AiAgentSettingsPanel";
import { AiDemoPanel } from "./AiDemoPanel";

/**
 * The AI tab has two halves and they are used at different rates.
 *
 * "Prevádzka" is what somebody opens to watch a call or read what happened.
 * "Nastavenia" is opened once and then rarely. Running is therefore the
 * default view.
 */
type AiView = "operations" | "settings";

const VIEWS: Array<{ value: AiView; label: string }> = [
  { value: "operations", label: "Prevádzka" },
  { value: "settings", label: "Nastavenia" },
];

export function AiTab({ onNavigateToSettings }: { onNavigateToSettings?: () => void }) {
  const [view, setView] = useState<AiView>("operations");

  return (
    <div className="grid gap-4">
      <div className="flex gap-2" role="tablist" aria-label="Zobrazenie AI">
        {VIEWS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            onClick={() => setView(value)}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
              view === value
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "operations" ? <AiDemoPanel onNavigateToSettings={onNavigateToSettings} /> : <AiAgentSettingsPanel />}
    </div>
  );
}
