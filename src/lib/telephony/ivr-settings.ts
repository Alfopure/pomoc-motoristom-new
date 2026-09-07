/** Shared IVR schema bounds for browser validation and server routing. */
export const IVR_ACTIONS = ["ring_plan", "callback", "external_number", "waiting_room", "repeat", "hangup"] as const;
export type IvrAction = (typeof IVR_ACTIONS)[number];

/** The twelve digits a DTMF keypad can send. */
export const IVR_DIGITS = "0123456789*#";
export const MAX_OPTIONS_PER_MENU = 12;
export const MIN_IVR_TRIES = 1;
export const MAX_IVR_TRIES = 5;
export const MIN_IVR_TIMEOUT_SECS = 1;
export const MAX_IVR_TIMEOUT_SECS = 30;
export const MAX_TTS_LENGTH = 600;

/** Old seeds put the invitation on a callback action, which already saves the request. */
export function callbackConfirmationMedia(file: string | null | undefined): string | null {
  return file === "callback-offer.mp3" || file === "/telephony/callback-offer.mp3" ? "callback-confirmed.mp3" : file || null;
}
