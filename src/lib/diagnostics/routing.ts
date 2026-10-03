/** Safe routing evidence. No phone numbers, SIP identities or provider payloads. */
export type RoutingDiagnosticMember = {
  memberId: string | null;
  profileId: string | null;
  endpoint: "sip" | "pstn";
  outcome: "selected" | "skipped";
  reason: string | null;
  presence: string | null;
  registration: string | null;
  heartbeatAgeMs: number | null;
  openOffer: boolean;
};

export type RoutingDiagnostic = {
  version: 1;
  at: string;
  kind: "selection" | "completed" | "fallback";
  step: number | null;
  strategy: "all" | "ordered" | null;
  ringSecs: number | null;
  startedAt: string | null;
  /** Recovery deadline, including the existing webhook grace period. */
  deadlineAt: string | null;
  reason: string | null;
  selectedCount: number;
  skippedCount: number;
  omittedMembers: number;
  activeLegCount: number;
  maxConcurrentLegs: number;
  maxFanout: number;
  members: RoutingDiagnosticMember[];
};
