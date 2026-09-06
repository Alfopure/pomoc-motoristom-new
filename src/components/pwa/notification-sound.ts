import { readNotificationSound } from "./push-client";

let audioContext: AudioContext | null = null;
let pushSubscribed = false;
const soundedNotifications = new Set<string>();

export function setNativePushActive(active: boolean) {
  pushSubscribed = active;
}

/** Call from a pointer/key gesture; never ask the browser for audio permission. */
export function unlockNotificationSound() {
  if (typeof window === "undefined") return;
  const Audio = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Audio) return;
  try {
    audioContext ??= new Audio();
    if (audioContext.state === "suspended") void audioContext.resume().catch(() => undefined);
  } catch {
    // The device may not have an available audio output.
  }
}

export function shouldPlayNotificationSound(input: { enabled: boolean; visible: boolean; nativePushActive: boolean; alreadyPlayed: boolean }) {
  return input.enabled && input.visible && !input.nativePushActive && !input.alreadyPlayed;
}

/** Native push owns its sound; the foreground fallback must not ring twice. */
export function playNotificationChime(notificationId?: string, preview = false): boolean {
  if (typeof document === "undefined") return false;
  if (!preview && !shouldPlayNotificationSound({
    enabled: readNotificationSound(),
    visible: document.visibilityState === "visible",
    nativePushActive: pushSubscribed,
    alreadyPlayed: Boolean(notificationId && soundedNotifications.has(notificationId)),
  })) return false;
  if (!audioContext || audioContext.state !== "running") return false;
  try {
    const start = audioContext.currentTime;
    for (const [offset, frequency] of [[0, 660], [0.17, 880]]) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start + offset);
      gain.gain.linearRampToValueAtTime(0.12, start + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.2);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.22);
    }
    if (notificationId) {
      soundedNotifications.add(notificationId);
      if (soundedNotifications.size > 200) soundedNotifications.delete(soundedNotifications.values().next().value!);
    }
    return true;
  } catch {
    return false;
  }
}
