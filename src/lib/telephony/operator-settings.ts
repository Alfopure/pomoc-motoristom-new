/**
 * Per-operator telephony defaults and their bounds.
 *
 * The constants live in `src/lib` because both sides need exactly the same
 * ones: `config-service.ts` validates and stores them, and the operator
 * screens (Phase 3) draft against them. Keeping them here means the browser
 * model imports a pure module instead of pulling the server file — with its
 * `node:crypto` and Supabase client — into the client bundle graph, the same
 * precedent as `device-liveness.ts`.
 */

export type OperatorTelephonySettings = {
  defaultFromLineId: string | null;
  wrapUpSeconds: number;
  autoAnswerOutbound: boolean;
  ringDeviceVolume: number;
};

/** Mirrors the CHECK constraint `wrap_up_seconds between 0 and 600`. */
export const MAX_WRAP_UP_SECONDS = 600;
/** Mirrors the CHECK constraint `ring_device_volume between 0 and 100`. */
export const MAX_RING_DEVICE_VOLUME = 100;

/** Column defaults of `motorist_operator_telephony_settings`. */
export const DEFAULT_OPERATOR_SETTINGS: OperatorTelephonySettings = {
  defaultFromLineId: null,
  wrapUpSeconds: 30,
  autoAnswerOutbound: true,
  ringDeviceVolume: 80,
};
