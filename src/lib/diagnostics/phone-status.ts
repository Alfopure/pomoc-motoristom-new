/** Aggregates only: never serialize device credentials or provider metadata. */
export type DiagnosticPhoneCounts = {
  source: 'available' | 'unavailable';
  total: number;
  ready: number;
  pushReachable: number;
  error: number;
  registering: number;
  unregistered: number;
  stale: number;
  unknown: number;
  lastSeenAt: string | null;
  truncated: boolean;
};

export type DiagnosticPhoneStatus = {
  checkedAt: string;
  environment: 'production' | 'test' | 'development';
  heartbeatWindowMs: number;
  browser: DiagnosticPhoneCounts;
  mobile: DiagnosticPhoneCounts;
};
