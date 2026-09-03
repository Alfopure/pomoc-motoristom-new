export type TelephonyHealthState =
  | "checking"
  | "live"
  | "configured"
  | "mock"
  | "degraded"
  | "stale"
  | "disabled"
  | "unavailable";

export type TelephonyHealthSignal = {
  state: TelephonyHealthState;
  detail: string;
  checkedAt?: string;
  lastSuccessAt?: string;
};

// The provider-specific health aggregates (websocket, reconciliation, browser
// SIP) were removed with the previous provider; the Telnyx implementation adds
// its own aggregate (webhook freshness, ledger failures, stuck sessions).
