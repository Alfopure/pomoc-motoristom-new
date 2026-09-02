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

export type TelephonyInfrastructureHealth = {
  checkedAt: string;
  websocket: TelephonyHealthSignal;
  reconciliation: TelephonyHealthSignal;
  lastEventAt?: string;
  lastReconcileAt?: string;
};

export type TelephonyUiHealth = {
  rest: TelephonyHealthSignal;
  browserSip: TelephonyHealthSignal;
  websocket: TelephonyHealthSignal;
  reconciliation: TelephonyHealthSignal;
  lastEventAt?: string;
  lastReconcileAt?: string;
};
