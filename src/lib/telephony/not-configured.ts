import type { TelephonyHealthSignal } from "@/lib/telephony/health";

/**
 * Provider-neutral "no telephony provider is wired in" seam.
 *
 * The previous provider was removed wholesale; until the next one lands the
 * dispatch UI keeps its call log, callbacks, directory and outcome tools but
 * every action that would need a live provider reports this state instead.
 */
export const TELEPHONY_NOT_CONFIGURED_MESSAGE = "Telefónia nie je nakonfigurovaná.";

export const SMS_NOT_CONFIGURED_MESSAGE = "SMS nie je nakonfigurované.";

export const TELEPHONY_NOT_CONFIGURED_HEALTH: TelephonyHealthSignal = {
  state: "disabled",
  detail: TELEPHONY_NOT_CONFIGURED_MESSAGE,
};

export class TelephonyNotConfiguredError extends Error {
  constructor(message = TELEPHONY_NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = "TelephonyNotConfiguredError";
  }
}
