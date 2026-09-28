import { readNotificationSound, type PushDeviceState } from "./push-client";

let audioContext: AudioContext | null = null;
let pushSubscribed = false;
let availableCallPushSubscribed = false;
const soundedNotifications = new Set<string>();
const soundedWaitingCalls = new Set<string>();
const WAITING_SOUND_HISTORY_KEY = "pm:waiting-room-sounded:v1";
const WAITING_SOUND_HISTORY_MS = 60 * 60 * 1_000;

export function setNativePushActive(active: boolean) {
  pushSubscribed = active;
}

export function setNativeAvailableCallPushActive(active: boolean) {
  availableCallPushSubscribed = active;
}

/** Older push subscriptions can be enrolled without call-notification support. */
export function hasNativeAvailableCallPush(state: Pick<PushDeviceState, "configured" | "callNotificationsConfigured" | "subscribed" | "availableCallsEnabled">): boolean {
  return state.configured && state.callNotificationsConfigured && state.subscribed && state.availableCallsEnabled;
}

/** Call from a pointer/key gesture; never ask the browser for audio permission. */
export async function unlockNotificationSound(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const Audio = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Audio) return false;
  try {
    if (!audioContext || audioContext.state === "closed") audioContext = new Audio();
    // iOS can also report an interrupted context after another application owns audio.
    if (audioContext.state !== "running") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const resumed = await Promise.race([
          audioContext.resume().then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
        ]);
        if (!resumed) return false;
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    return audioContext.state === "running";
  } catch {
    // The device may not have an available audio output.
    return false;
  }
}

/** Start from the user's gesture, then wait for actual readiness instead of a fixed delay. */
export async function previewNotificationSound(): Promise<boolean> {
  return await unlockNotificationSound() && playNotificationChime(undefined, true);
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

/** One short, descending queue cue. A browser invite keeps its own ringtone. */
export async function playWaitingRoomChimeOnce(sessionId: string): Promise<boolean> {
  if (typeof document === "undefined" || typeof navigator === "undefined" ||
    !readNotificationSound() || document.visibilityState !== "visible" ||
    availableCallPushSubscribed || !audioContext || audioContext.state !== "running") return false;

  const playIfNew = () => {
    if (soundedWaitingCalls.has(sessionId)) return false;
    const now = Date.now();
    let history: Record<string, number> = {};
    try {
      const stored = JSON.parse(window.localStorage.getItem(WAITING_SOUND_HISTORY_KEY) ?? "{}");
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        history = Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, number] =>
          typeof entry[1] === "number" && now - entry[1] < WAITING_SOUND_HISTORY_MS && now >= entry[1]));
      }
    } catch { /* Storage may be unavailable. */ }
    if (sessionId in history) { soundedWaitingCalls.add(sessionId); return false; }

    try {
      const start = audioContext!.currentTime;
      for (const [offset, frequency] of [[0, 784], [0.14, 523]]) {
        const oscillator = audioContext!.createOscillator();
        const gain = audioContext!.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start + offset);
        gain.gain.linearRampToValueAtTime(0.1, start + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.18);
        oscillator.connect(gain);
        gain.connect(audioContext!.destination);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + 0.2);
      }
    } catch { return false; }

    soundedWaitingCalls.add(sessionId);
    if (soundedWaitingCalls.size > 100) soundedWaitingCalls.delete(soundedWaitingCalls.values().next().value!);
    try {
      history[sessionId] = now;
      window.localStorage.setItem(WAITING_SOUND_HISTORY_KEY, JSON.stringify(
        Object.fromEntries(Object.entries(history).slice(-100)),
      ));
    } catch { /* The current tab still remembers the cue. */ }
    return true;
  };

  // The lock makes a read/claim atomic between open tabs; storage preserves it
  // across a refresh. On browsers without Web Locks the same storage still
  // prevents ordinary sequential duplicate polls.
  try {
    return navigator.locks?.request
      ? await navigator.locks.request("pm:waiting-room-chime:v1", playIfNew)
      : playIfNew();
  } catch { return false; }
}
