type CallWakeLockScope = {
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  navigator?: { wakeLock?: Pick<WakeLock, "request"> };
};

/**
 * Keep a visible, active call on screen where the browser allows it. This does
 * not keep the PWA running in the background. Call the returned cleanup when the
 * call ends; a late browser permission response cannot outlive that cleanup.
 */
export function acquireCallWakeLock(scope: CallWakeLockScope = globalThis): () => void {
  const page = scope.document;
  const wakeLock = scope.navigator?.wakeLock;
  if (!page || typeof wakeLock?.request !== "function") return () => undefined;

  let stopped = false;
  let generation = 0;
  let requesting = false;
  let held: WakeLockSentinel | null = null;

  async function release(lock: WakeLockSentinel): Promise<void> {
    try {
      await lock.release();
    } catch {
      // Battery policy or a browser release must never interrupt the call.
    }
  }

  async function request(): Promise<void> {
    if (stopped || page!.visibilityState !== "visible" || requesting || (held && !held.released)) return;
    const requestedGeneration = generation;
    requesting = true;
    try {
      const lock = await wakeLock!.request("screen");
      if (stopped || page!.visibilityState !== "visible" || requestedGeneration !== generation) {
        await release(lock);
      } else {
        held = lock;
      }
    } catch {
      // Unsupported browser policy and low battery are normal refusals.
    } finally {
      requesting = false;
      // Visibility may have changed while request/release was pending. Retry
      // only for that new visible period, never continuously after a refusal.
      if (!stopped && page!.visibilityState === "visible" && requestedGeneration !== generation) {
        void request();
      }
    }
  }

  function onVisibilityChange(): void {
    if (page!.visibilityState === "visible") {
      void request();
      return;
    }
    generation += 1;
    if (held) {
      const lock = held;
      held = null;
      void release(lock);
    }
  }

  page.addEventListener("visibilitychange", onVisibilityChange);
  void request();

  return () => {
    if (stopped) return;
    stopped = true;
    page.removeEventListener("visibilitychange", onVisibilityChange);
    if (held) {
      const lock = held;
      held = null;
      void release(lock);
    }
  };
}
