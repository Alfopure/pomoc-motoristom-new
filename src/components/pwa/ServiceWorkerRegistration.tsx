"use client";

import { useEffect, useState } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISSED_AT_KEY = "pm-pwa-install-dismissed-at";
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function ServiceWorkerRegistration() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosInstructions, setShowIosInstructions] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    function register() {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((registration) => registration.update())
        .catch(() => {
          // The app must stay usable even when the browser blocks service workers.
        });
    }

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });

    return () => {
      window.removeEventListener("load", register);
    };
  }, []);

  useEffect(() => {
    if (window.location.pathname.startsWith("/l/") || isStandalone() || recentlyDismissed()) return;

    const handlePrompt = (event: Event) => {
      event.preventDefault();
      setShowIosInstructions(false);
      setInstallPrompt(event as InstallPromptEvent);
    };
    const handleInstalled = () => {
      setInstallPrompt(null);
      setShowIosInstructions(false);
      localStorage.removeItem(DISMISSED_AT_KEY);
    };

    window.addEventListener("beforeinstallprompt", handlePrompt);
    window.addEventListener("appinstalled", handleInstalled);
    const iosTimer = window.setTimeout(() => {
      if (isIosDevice() && !isStandalone()) setShowIosInstructions(true);
    }, 1_200);

    return () => {
      window.clearTimeout(iosTimer);
      window.removeEventListener("beforeinstallprompt", handlePrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  if (!installPrompt && !showIosInstructions) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_AT_KEY, String(Date.now()));
    } catch {
      // Private browsing may block storage; dismissing must still work.
    }
    setInstallPrompt(null);
    setShowIosInstructions(false);
  };

  const install = async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } catch {
      // The browser may invalidate a deferred prompt after a navigation.
    } finally {
      setInstallPrompt(null);
    }
  };

  return (
    <aside
      aria-label="Inštalácia aplikácie"
      className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-[100] w-[min(92vw,390px)] -translate-x-1/2 rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-white shadow-2xl sm:left-auto sm:right-4 sm:translate-x-0"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#FCD703] text-sm font-black text-zinc-950">PM</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Pomoc Motoristom ako aplikácia</p>
          <p className="mt-0.5 text-xs leading-5 text-zinc-300">
            {showIosInstructions
              ? "V Safari otvor Zdieľať a vyber Pridať na plochu."
              : "Nainštaluj si dispečing do počítača alebo telefónu."}
          </p>
          {!showIosInstructions && (
            <button
              type="button"
              onClick={() => void install()}
              className="mt-2 inline-flex h-8 items-center rounded-md bg-[#FCD703] px-3 text-xs font-semibold text-zinc-950 transition hover:bg-yellow-300"
            >
              Nainštalovať aplikáciu
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
          aria-label="Zavrieť ponuku inštalácie"
          title="Zavrieť"
        >
          <span aria-hidden="true" className="text-xl leading-none">×</span>
        </button>
      </div>
    </aside>
  );
}

function isStandalone() {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
}

function isIosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function recentlyDismissed() {
  try {
    const dismissedAt = Number(localStorage.getItem(DISMISSED_AT_KEY));
    return Number.isFinite(dismissedAt) && Date.now() - dismissedAt < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}
