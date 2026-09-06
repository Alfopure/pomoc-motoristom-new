"use client";

import { useEffect } from "react";
import { PUSH_SETTINGS_EVENT, PUSH_SOUND_KEY, pushEnrollmentState, reconcilePushDeviceState, rememberNotificationSound, syncNotificationSoundFromStorage } from "./push-client";
import { setNativePushActive, unlockNotificationSound } from "./notification-sound";

/** Reads this device's existing enrollment; mounting never opts anyone in. */
export function PushNotificationSync({ profileId }: { profileId?: string }) {
  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    let refreshAgain = false;
    const refresh = async () => {
      if (disposed || !profileId || document.visibilityState !== "visible") return;
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      const enrollment = pushEnrollmentState();
      if (enrollment.pending) return;
      refreshing = true;
      try {
        const state = await reconcilePushDeviceState(enrollment.version, () => !disposed);
        if (disposed) return;
        const currentEnrollment = pushEnrollmentState();
        if (currentEnrollment.pending || currentEnrollment.version !== enrollment.version) {
          // A stale GET must not revoke an endpoint created while it was in
          // flight. Enrollment completion emits its own refresh event.
          if (!currentEnrollment.pending) refreshAgain = true;
          return;
        }
        setNativePushActive(state.subscribed);
        rememberNotificationSound(state.soundEnabled);
      } catch {
        // Existing push keeps working during a temporary connectivity failure.
      } finally {
        refreshing = false;
        // A toggle in this or another tab must not be lost while the previous
        // status request is in flight.
        if (refreshAgain && !disposed) {
          refreshAgain = false;
          void refresh();
        }
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === PUSH_SOUND_KEY) {
        syncNotificationSoundFromStorage(event.newValue);
        void refresh();
      }
    };
    void refresh();
    document.addEventListener("pointerdown", unlockNotificationSound);
    document.addEventListener("keydown", unlockNotificationSound);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener(PUSH_SETTINGS_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      disposed = true;
      setNativePushActive(false);
      document.removeEventListener("pointerdown", unlockNotificationSound);
      document.removeEventListener("keydown", unlockNotificationSound);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener(PUSH_SETTINGS_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, [profileId]);
  return null;
}
