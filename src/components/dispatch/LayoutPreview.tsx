"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PanelsTopLeft } from "lucide-react";
import { layoutPreviewStorageKey, parseLayoutPreviewMode, type LayoutPreviewMode } from "./layout-preview-policy";

const PreviewContext = createContext<{ enabled: boolean; mode: LayoutPreviewMode; setMode: (mode: LayoutPreviewMode) => void }>({ enabled: false, mode: "classic", setMode: () => {} });

/** Always mounted: changing appearance never recreates editors, stores or the webphone. */
export function LayoutPreviewProvider({ enabled, actorKey, children }: { enabled: boolean; actorKey: string; children: ReactNode }) {
  const [selection, setSelection] = useState<{ key: string; mode: LayoutPreviewMode } | null>(null);
  const key = layoutPreviewStorageKey(actorKey);
  const mode = enabled ? selection?.key === key ? selection.mode : "modern" : "classic";
  useEffect(() => {
    if (!enabled) return;
    const frame = requestAnimationFrame(() => {
      try {
        const storedMode = parseLayoutPreviewMode(localStorage.getItem(key));
        setSelection(current => current?.key === key ? current : { key, mode: storedMode });
      }
      catch { /* Appearance remains usable in memory when browser storage is denied. */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, key]);
  function setMode(next: LayoutPreviewMode) {
    if (!enabled) return;
    setSelection({ key, mode: next });
    try { localStorage.setItem(key, next); } catch { /* Do not interrupt ongoing work. */ }
  }
  return <PreviewContext.Provider value={{ enabled, mode, setMode }}>{children}</PreviewContext.Provider>;
}

export const useLayoutPreview = () => useContext(PreviewContext);

export function LayoutPreviewToolbar({ live }: { live: boolean }) {
  const { enabled, mode, setMode } = useLayoutPreview();
  if (!enabled) return null;
  return <div className="layout-preview-toolbar" role="region" aria-label="Vzhľad pracoviska">
    <div className="layout-preview-description"><PanelsTopLeft size={15} aria-hidden="true" /><strong>Vzhľad pracoviska</strong><span>{live ? "Spoločné údaje · uložené zmeny sú reálne" : "Testovacie údaje"}</span></div>
    <div className="layout-preview-options" role="group" aria-label="Vzhľad aplikácie">
      <button type="button" aria-pressed={mode === "modern"} onClick={() => setMode("modern")}>Nový vzhľad</button>
      <button type="button" aria-pressed={mode === "classic"} onClick={() => setMode("classic")}>Pôvodný vzhľad</button>
    </div>
  </div>;
}
