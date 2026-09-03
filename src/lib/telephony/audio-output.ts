/**
 * Audio output (speaker) choice of the browser phone.
 *
 * The Telnyx SDK plays the remote leg through one hidden `<audio>` element
 * (`telnyx-webphone.ts`), so choosing a speaker means calling `setSinkId` on
 * that element. Only Chromium exposes it; Firefox and Safari keep the system
 * default, and the panel has to say so instead of offering a dead control.
 *
 * The choice is kept in `localStorage` rather than in the database: it belongs
 * to this computer, not to the operator's profile — the same person on the
 * dispatch desk and on a laptop wants two different headsets. `MyPhonePanel`
 * applies it to the live element immediately and the webphone re-applies it to
 * every element it creates afterwards.
 */

export const AUDIO_OUTPUT_STORAGE_KEY = "pm.telephony.audio-output";

/** Id of the hidden element the SDK renders the remote leg into. */
export const REMOTE_AUDIO_ELEMENT_ID = "pm-telnyx-remote-audio";

/** "System default": an empty sink id is what `setSinkId("")` means too. */
export const DEFAULT_AUDIO_OUTPUT_ID = "";

export type AudioOutputOption = { deviceId: string; label: string };

/** Minimal shape of `MediaDeviceInfo` this module needs. */
export type AudioDeviceLike = { deviceId: string; kind: string; label?: string };

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type SinkCapableElement = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };

/**
 * Speakers only, deduplicated, with a Slovak fallback label.
 *
 * Before the operator has granted microphone permission the browser returns
 * empty labels, so a numbered placeholder keeps the list selectable instead of
 * showing a column of blanks.
 */
export function audioOutputOptions(devices: readonly AudioDeviceLike[]): AudioOutputOption[] {
  const seen = new Set<string>();
  const options: AudioOutputOption[] = [];
  let index = 0;
  for (const device of devices) {
    if (device.kind !== "audiooutput") continue;
    if (seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    index += 1;
    const label = (device.label ?? "").trim();
    if (device.deviceId === "default") {
      options.push({ deviceId: device.deviceId, label: label || "Predvolené zariadenie systému" });
      continue;
    }
    options.push({ deviceId: device.deviceId, label: label || `Zvukový výstup ${index}` });
  }
  return options;
}

/**
 * The id the `<select>` should show: the stored device if it is still plugged
 * in, otherwise the system default. A headset that was unplugged must not leave
 * the control pointing at a device the browser no longer knows.
 */
export function selectedAudioOutput(options: readonly AudioOutputOption[], storedDeviceId: string | null): string {
  if (!storedDeviceId) return DEFAULT_AUDIO_OUTPUT_ID;
  return options.some((option) => option.deviceId === storedDeviceId) ? storedDeviceId : DEFAULT_AUDIO_OUTPUT_ID;
}

/** True when the stored device is gone — the panel says so rather than lying. */
export function audioOutputMissing(options: readonly AudioOutputOption[], storedDeviceId: string | null): boolean {
  if (!storedDeviceId) return false;
  return !options.some((option) => option.deviceId === storedDeviceId);
}

export function readStoredAudioOutput(storage: StorageLike | null | undefined = safeStorage()): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(AUDIO_OUTPUT_STORAGE_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function storeAudioOutput(deviceId: string | null, storage: StorageLike | null | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    if (!deviceId) storage.removeItem(AUDIO_OUTPUT_STORAGE_KEY);
    else storage.setItem(AUDIO_OUTPUT_STORAGE_KEY, deviceId);
  } catch {
    // A private window with storage disabled keeps the system default; the
    // choice simply does not survive a reload.
  }
}

function safeStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Chromium exposes `setSinkId`; elsewhere the operator uses the OS mixer. */
export function audioOutputSupported(scope: { HTMLMediaElement?: unknown; navigator?: { mediaDevices?: unknown } } = globalThis): boolean {
  const prototype = (scope.HTMLMediaElement as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  return Boolean(prototype && "setSinkId" in prototype && scope.navigator?.mediaDevices);
}

/** Best effort: a refused or unknown sink id must never break a live call. */
export async function applyAudioOutput(element: SinkCapableElement | null, deviceId: string | null): Promise<boolean> {
  if (!element || typeof element.setSinkId !== "function") return false;
  try {
    await element.setSinkId(deviceId ?? DEFAULT_AUDIO_OUTPUT_ID);
    return true;
  } catch {
    return false;
  }
}

/** Applies the stored choice to the element the webphone just created. */
export function applyStoredAudioOutput(element: SinkCapableElement | null): void {
  const deviceId = readStoredAudioOutput();
  if (!deviceId) return;
  void applyAudioOutput(element, deviceId);
}

/** The live remote-audio element, when the webphone has already created one. */
export function remoteAudioElement(): SinkCapableElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById(REMOTE_AUDIO_ELEMENT_ID) as SinkCapableElement | null;
}

export async function listAudioOutputs(mediaDevices?: MediaDevices | null): Promise<AudioOutputOption[]> {
  const devices = mediaDevices ?? (typeof navigator === "undefined" ? null : navigator.mediaDevices);
  if (!devices?.enumerateDevices) return [];
  const list = await devices.enumerateDevices();
  return audioOutputOptions(list);
}
