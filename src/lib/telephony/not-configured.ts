import type { TelephonyHealthSignal } from "@/lib/telephony/health";

/**
 * Provider-neutral "no telephony provider is wired in" seam.
 *
 * The previous provider was removed wholesale; until the next one lands the
 * dispatch UI keeps its call log, callbacks, directory and outcome tools but
 * every action that would need a live provider reports this state instead.
 */
export const TELEPHONY_NOT_CONFIGURED_MESSAGE = "Telefónia nie je nakonfigurovaná.";
export const TELEPHONY_NOT_CONFIGURED_CODE = "not_configured";

/** A busy lease/provider outage is also 503; only an explicit configuration error disables the phone. */
export function isTelephonyNotConfigured(result: { status: number; body: unknown }): boolean {
  if (result.status !== 503 || !result.body || typeof result.body !== "object") return false;
  const body = result.body as { code?: unknown; error?: unknown };
  // Keep rolling deployments compatible with the previous server's exact message.
  return body.code === TELEPHONY_NOT_CONFIGURED_CODE || (body.code == null && body.error === TELEPHONY_NOT_CONFIGURED_MESSAGE);
}

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
