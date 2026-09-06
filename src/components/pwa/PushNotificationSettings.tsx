"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Check, LoaderCircle, Send, Smartphone, Volume2 } from "lucide-react";
import {
  browserPushSupport,
  disableCurrentDevicePush,
  enableDevicePush,
  PUSH_SETTINGS_EVENT,
  pushRequest,
  readNotificationSound,
  readPushDeviceState,
  storeNotificationSound,
  type PushDeviceState,
} from "./push-client";
import { playNotificationChime, setNativePushActive, unlockNotificationSound } from "./notification-sound";

const buttonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";

export function PushNotificationSettings({ enabled = true }: { enabled?: boolean }) {
  const [state, setState] = useState<PushDeviceState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testCooldown, setTestCooldown] = useState(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const next = await readPushDeviceState();
      setState(next);
      setNativePushActive(next.subscribed);
      setError(null);
    } catch (failure) {
      setState((current) => current ?? {
        support: browserPushSupport(),
        permission: typeof Notification === "undefined" ? "default" : Notification.permission,
        configured: false,
        publicKey: null,
        subscription: null,
        subscribed: false,
        soundEnabled: readNotificationSound(),
      });
      setError(failure instanceof Error ? failure.message : "Stav upozornení sa nepodarilo načítať.");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void refresh(); });
    return () => { disposed = true; };
  }, [refresh]);

  useEffect(() => {
    if (testCooldown <= 0) return;
    const timer = window.setTimeout(() => setTestCooldown((current) => Math.max(0, current - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [testCooldown]);

  async function togglePush() {
    if (!state || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (state.subscribed) {
        await disableCurrentDevicePush();
        setState({ ...state, subscribed: false, subscription: null });
        setNativePushActive(false);
        setNotice("Push upozornenia sú na tomto zariadení vypnuté.");
      } else {
        // Keep the permission call in the click event's activation chain.
        const subscription = await enableDevicePush(state);
        setState({ ...state, subscribed: true, subscription, permission: "granted" });
        setNativePushActive(true);
        setNotice("Push upozornenia sú zapnuté. Vyskúšaj doručenie testovacím upozornením.");
      }
    } catch (failure) {
      setState((current) => current ? { ...current, permission: typeof Notification === "undefined" ? "default" : Notification.permission } : current);
      setError(failure instanceof Error ? failure.message : "Nastavenie upozornení sa nepodarilo zmeniť.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleSound() {
    if (!state || busy) return;
    const soundEnabled = !state.soundEnabled;
    unlockNotificationSound();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (state.subscribed && state.subscription) {
        await pushRequest("/api/push/subscriptions", "PATCH", { endpoint: state.subscription.endpoint, soundEnabled });
      }
      storeNotificationSound(soundEnabled);
      setState({ ...state, soundEnabled });
      setNotice(soundEnabled ? "Zvuk upozornení je zapnutý." : "Zvuk upozornení je vypnutý.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Zvuk sa nepodarilo nastaviť.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    if (!state?.subscription || !state.subscribed || busy || testCooldown > 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await pushRequest("/api/push/test", "POST", { endpoint: state.subscription.endpoint });
      setTestCooldown(30);
      setNotice("Test bol odoslaný na toto zariadenie. Skontroluj centrum upozornení; pri zapnutom zvuku aj hlasitosť a režim Nerušiť.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Testovacie upozornenie sa nepodarilo odoslať.");
      // An expired push endpoint is removed by the server. Reflect that state
      // so the user can enroll again instead of repeating a doomed test.
      const next = await readPushDeviceState().catch(() => null);
      if (next) {
        setState(next);
        setNativePushActive(next.subscribed);
      }
    } finally {
      setBusy(false);
    }
  }

  const denied = state?.permission === "denied";
  const canEnable = state?.support === "supported" && state.configured && !denied;
  const unavailable = !enabled
    ? "Push upozornenia sú dostupné po prihlásení do dispečingu."
    : state?.support === "install-ios"
      ? "Na iPhone alebo iPade otvor Zdieľať → Pridať na plochu. Potom spusti aplikáciu z plochy a zapni upozornenia tu (iOS 16.4 alebo novší)."
      : state?.support === "insecure"
        ? "Upozornenia potrebujú zabezpečené pripojenie. Otvor aplikáciu cez HTTPS."
        : state?.support === "unsupported"
          ? "Tento prehliadač nepodporuje push upozornenia. Otvor aplikáciu v aktuálnom Chrome, Edge, Firefoxe alebo Safari."
          : denied
            ? "Prehliadač blokuje upozornenia. V nastaveniach tejto stránky alebo aplikácie povoľ upozornenia a potom obnov stav."
            : state && !state.configured && !error
              ? "Push upozornenia ešte nie sú pripravené. Kontaktuj správcu aplikácie."
              : null;

  return (
    <section aria-labelledby="push-settings-heading" className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-yellow-100 text-zinc-900"><Bell size={21} /></span>
        <div className="min-w-0 flex-1">
          <h3 id="push-settings-heading" className="text-base font-bold text-zinc-950">Upozornenia a zvuk</h3>
          <p className="mt-1 text-sm leading-6 text-zinc-500">Nová úloha aj pri zatvorenej aplikácii. Nastavenie platí pre tento telefón alebo počítač.</p>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-4 rounded-xl bg-zinc-50 p-3 sm:p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-zinc-900">Push upozornenia</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
            {loading ? <LoaderCircle size={13} className="animate-spin" /> : state?.subscribed ? <Check size={13} className="text-emerald-600" /> : <BellOff size={13} />}
            {loading ? "Overujem zariadenie…" : state?.subscribed ? "Zapnuté na tomto zariadení" : "Vypnuté na tomto zariadení"}
          </p>
        </div>
        <button type="button" role="switch" aria-checked={Boolean(state?.subscribed)} aria-label="Push upozornenia na tomto zariadení"
          disabled={loading || busy || !enabled || (!state?.subscribed && !canEnable)}
          onClick={() => void togglePush()}
          className="relative inline-flex min-h-11 w-14 shrink-0 items-center rounded-xl transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-40">
          <span aria-hidden="true" className={`flex h-8 w-14 items-center rounded-full p-1 ${state?.subscribed ? "bg-emerald-600" : "bg-zinc-300"}`}><span className={`inline-block size-6 rounded-full bg-white shadow-sm transition-transform ${state?.subscribed ? "translate-x-6" : "translate-x-0"}`} /></span>
        </button>
      </div>

      {unavailable && <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-900"><Smartphone size={17} className="mt-0.5 shrink-0" /><span>{unavailable}</span></p>}

      <div className="mt-3 flex items-center justify-between gap-4 px-1 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-zinc-900"><Volume2 size={16} />Zvuk upozornení</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">V aplikácii aj pri push upozornení. Zvuk na pozadí riadi systém zariadenia.</p>
        </div>
        <button type="button" role="switch" aria-checked={state?.soundEnabled ?? true} aria-label="Zvuk upozornení"
          disabled={loading || busy || !enabled || !state} onClick={() => void toggleSound()}
          className="relative inline-flex min-h-11 w-14 shrink-0 items-center rounded-xl transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-900 disabled:opacity-40">
          <span aria-hidden="true" className={`flex h-8 w-14 items-center rounded-full p-1 ${state?.soundEnabled ? "bg-emerald-600" : "bg-zinc-300"}`}><span className={`inline-block size-6 rounded-full bg-white shadow-sm transition-transform ${state?.soundEnabled ? "translate-x-6" : "translate-x-0"}`} /></span>
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 border-t border-zinc-100 pt-4">
        <button type="button" disabled={!state?.subscribed || busy || loading || testCooldown > 0} onClick={() => void sendTest()} className={buttonClass}><Send size={15} />{testCooldown > 0 ? `Ďalší test o ${testCooldown} s` : "Poslať test"}</button>
        <button type="button" disabled={!enabled || !state?.soundEnabled || busy} className={buttonClass}
          onClick={() => {
            unlockNotificationSound();
            window.setTimeout(() => {
              const played = playNotificationChime(undefined, true);
              setNotice(played ? "Skúšobný zvuk bol prehratý. Ak ho nepočuješ, skontroluj hlasitosť zariadenia." : "Prehliadač zatiaľ blokuje zvuk. Skús tlačidlo stlačiť znova a skontroluj hlasitosť.");
            }, 100);
          }}><Volume2 size={15} />Vyskúšať zvuk</button>
        <button type="button" disabled={busy || loading || !enabled} onClick={() => { window.dispatchEvent(new Event(PUSH_SETTINGS_EVENT)); void refresh(); }} className={buttonClass}>Obnoviť stav</button>
      </div>
      {notice && <p role="status" className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm leading-6 text-emerald-800">{notice}</p>}
      {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm leading-6 text-red-700">{error}</p>}
    </section>
  );
}
