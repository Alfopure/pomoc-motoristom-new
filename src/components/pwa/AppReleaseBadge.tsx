"use client";

import { useRef, useState } from "react";
import { Info, X } from "lucide-react";
import { appEnvironmentLabels, appReleaseDate, type AppRelease } from "@/lib/app-release";

export function AppReleaseBadge({ release }: { release: AppRelease }) {
  // A server refresh must not relabel JavaScript already running in this document.
  const [loadedRelease] = useState(release);
  const dialog = useRef<HTMLDialogElement>(null);
  const date = appReleaseDate(loadedRelease.builtAt);
  const environment = appEnvironmentLabels[loadedRelease.environment];
  const environmentStyle = loadedRelease.environment === "test"
    ? "border-amber-300 bg-amber-100 text-amber-950"
    : loadedRelease.environment === "production"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : "border-zinc-300 bg-zinc-100 text-zinc-700";

  return (
    <div data-testid="app-release" className="border-b border-zinc-200 bg-white text-zinc-700">
      <button type="button" onClick={() => dialog.current?.showModal()}
        aria-label="Zobraziť informácie o verzii aplikácie" aria-haspopup="dialog"
        className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-[11px] hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-zinc-700 sm:px-4 sm:text-xs">
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${environmentStyle}`}>{environment}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <span>{date ? <>Verzia <time dateTime={loadedRelease.builtAt!}>{date}</time></> : "Lokálna zostava"}</span>
          {loadedRelease.code && <><span aria-hidden="true">·</span><span className="font-mono" data-testid="app-release-code">{loadedRelease.code}</span></>}
        </span>
        <Info size={14} className="ml-auto shrink-0" aria-hidden="true" />
      </button>
      <dialog ref={dialog} aria-label="Verzia aplikácie"
        onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}
        className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100vw-2rem)] max-w-sm overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 text-zinc-950 shadow-2xl backdrop:bg-zinc-950/40">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Verzia aplikácie</h2>
          <button type="button" autoFocus onClick={() => dialog.current?.close()} aria-label="Zavrieť informácie o verzii"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-zinc-100"><X size={20} aria-hidden="true" /></button>
        </div>
        <p className="mb-4 text-sm text-zinc-600">Toto je verzia načítaná v tomto zariadení.</p>
        <dl className="space-y-3 text-sm">
          <div><dt className="text-zinc-500">Prostredie</dt><dd className="font-semibold">{environment}</dd></div>
          <div><dt className="text-zinc-500">Kód verzie</dt><dd className="break-all font-mono font-semibold">{loadedRelease.code ?? "Lokálna zostava"}</dd></div>
          {date && <div><dt className="text-zinc-500">Dátum zostavenia</dt><dd>{date}</dd></div>}
          {loadedRelease.commit && <div><dt className="text-zinc-500">Zostava</dt><dd className="font-mono">{loadedRelease.commit.slice(0, 8)}</dd></div>}
        </dl>
        <p className="mt-5 border-t border-zinc-200 pt-4 text-xs leading-5 text-zinc-600">Rovnaký kód verzie na TESTe a v produkcii znamená rovnaký aplikačný kód. Dátum zostavenia môže byť iný. Každé prostredie má vlastné dáta a nastavenia.</p>
      </dialog>
    </div>
  );
}
