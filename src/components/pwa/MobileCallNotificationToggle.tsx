"use client";

import { useEffect, useRef, useState } from "react";
import { PUSH_SETTINGS_EVENT, pushRequest } from "./push-client";

type Settings = { enabled: boolean; mobileApps: number };

/** Same authenticated account preference in the phone menu and personal settings. */
export function MobileCallNotificationToggle() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const saving = useRef(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (saving.current) return;
      const version = ++sequence.current;
      try {
        const value = await pushRequest<Settings>("/api/push/mobile-calls");
        if (alive && version === sequence.current) { setSettings(value); setError(null); }
      } catch { if (alive && version === sequence.current) setError("Nastavenie sa nepodarilo načítať."); }
    };
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    void load();
    window.addEventListener(PUSH_SETTINGS_EVENT, load);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("pm:mobile-call-settings") : null;
    if (channel) channel.onmessage = () => void load();
    return () => { alive = false; sequence.current++; channel?.close(); window.removeEventListener(PUSH_SETTINGS_EVENT, load); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, []);

  async function toggle() {
    if (!settings || saving.current) return;
    saving.current = true; sequence.current++; setBusy(true); setError(null);
    try {
      setSettings(await pushRequest<Settings>("/api/push/mobile-calls", "PATCH", { enabled: !settings.enabled }));
      window.dispatchEvent(new Event(PUSH_SETTINGS_EVENT));
      if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel("pm:mobile-call-settings"); channel.postMessage("changed"); channel.close(); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Nastavenie sa nepodarilo uložiť."); }
    finally { saving.current = false; setBusy(false); }
  }

  return (
    <div className="space-y-1.5" data-testid="mobile-call-notifications">
      <button type="button" role="switch" aria-checked={settings?.enabled ?? false} aria-label="Upozorniť na hovory aj v mobilnej appke" disabled={!settings || busy} onClick={() => void toggle()} className="flex min-h-11 w-full items-center justify-between gap-3 text-left text-xs font-bold text-zinc-900 disabled:opacity-60">
        <span>Upozorniť na hovory aj v mobilnej appke</span>
        <span aria-hidden="true" className={`flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors ${settings?.enabled ? "bg-emerald-600" : "bg-zinc-300"}`}><span className={`size-5 rounded-full bg-white shadow-sm transition-transform ${settings?.enabled ? "translate-x-4" : ""}`} /></span>
      </button>
      <p className="text-[11px] leading-4 text-zinc-600">Na mobil príde push upozornenie. Hovor prijmete po otvorení appky; nejde o volanie na mobilné číslo.</p>
      {settings?.enabled && settings.mobileApps === 0 && <p className="text-[11px] leading-4 text-amber-800">Najprv v mobilnej appke povoľte upozornenia na hovory.</p>}
      {error && <p role="alert" className="text-xs leading-4 text-red-700">{error}</p>}
    </div>
  );
}
