"use client";

import { useEffect, useRef, useState } from "react";
import { pushRequest } from "./push-client";

type Settings = { enabled: boolean };
const CHANNEL_NAME = "pm:pause-ending-settings";

/** Account-wide switch: it gates both the in-app row and every Web Push delivery. */
export function PauseEndingNotificationToggle() {
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
        const value = await pushRequest<Settings>("/api/push/pause-ending");
        if (alive && version === sequence.current) { setSettings(value); setError(null); }
      } catch {
        if (alive && version === sequence.current) setError("Nastavenie upozornenia na pauzu sa nepodarilo načítať.");
      }
    };
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    void load();
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
    if (channel) channel.onmessage = () => void load();
    return () => {
      alive = false;
      channel?.close();
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  async function toggle() {
    if (!settings || saving.current) return;
    saving.current = true;
    sequence.current++;
    setBusy(true);
    setError(null);
    try {
      const next = await pushRequest<Settings>("/api/push/pause-ending", "PATCH", { enabled: !settings.enabled });
      setSettings(next);
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel(CHANNEL_NAME);
        channel.postMessage("changed");
        channel.close();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Nastavenie upozornenia na pauzu sa nepodarilo uložiť.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5" data-testid="pause-ending-notifications">
      <button type="button" role="switch" aria-checked={settings?.enabled ?? true} aria-label="Upozornenie pred koncom pauzy" disabled={!settings || busy} onClick={() => void toggle()} className="flex min-h-11 w-full items-center justify-between gap-3 text-left text-sm font-semibold text-zinc-900 disabled:opacity-60">
        <span>Upozornenie pred koncom pauzy</span>
        <span aria-hidden="true" className={`flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors ${settings?.enabled !== false ? "bg-emerald-600" : "bg-zinc-300"}`}><span className={`size-5 rounded-full bg-white shadow-sm transition-transform ${settings?.enabled !== false ? "translate-x-4" : ""}`} /></span>
      </button>
      <p className="text-xs leading-5 text-zinc-500">1 minútu pred plánovaným koncom príde upozornenie v aplikácii aj push na zapnuté zariadenia. Platí pre celý účet.</p>
      {error && <p role="alert" className="text-xs leading-4 text-red-700">{error}</p>}
    </div>
  );
}
