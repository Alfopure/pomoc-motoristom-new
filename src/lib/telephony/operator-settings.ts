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

export const PAUSE_ROUTING_MODES = ["none", "default_mobile", "external_number", "operator"] as const;

export type PauseRoutingMode = (typeof PAUSE_ROUTING_MODES)[number];

export type OperatorTelephonySettings = {
  defaultFromLineId: string | null;
  wrapUpSeconds: number;
  autoAnswerOutbound: boolean;
  ringDeviceVolume: number;
  /** Number offered as the one-click "my mobile" destination while pausing. */
  defaultMobileNumber: string | null;
  /** Last pause-routing choice. It is consulted only while presence is `paused`. */
  pauseRoutingMode: PauseRoutingMode;
  /** Substitute operator for `pauseRoutingMode === "operator"`. */
  pauseForwardProfileId: string | null;
  /** Ad-hoc PSTN destination for `pauseRoutingMode === "external_number"`. */
  pauseForwardNumber: string | null;
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
  defaultMobileNumber: null,
  pauseRoutingMode: "none",
  pauseForwardProfileId: null,
  pauseForwardNumber: null,
};
