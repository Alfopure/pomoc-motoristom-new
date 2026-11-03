import type { MobileDraftScope } from "./mobile-api";

export type MobileCallContextTarget = { kind: "call" | "session"; id: string };
export type MobileCallContext = MobileDraftScope & {
  target: MobileCallContextTarget;
  call: {
    id: string | null;
    sessionId: string | null;
    direction: "inbound" | "outbound" | "internal";
    status: string;
    number: string | null;
    name: string | null;
    lineLabel: string | null;
    operatorName: string | null;
    startedAt: string;
    answeredAt: string | null;
    endedAt: string | null;
    durationSeconds: number | null;
  };
  linkedCase: {
    id: string;
    caseNumber: string;
    status: string;
    statusLabel: string;
    summary: string;
    contactName: string | null;
    licensePlate: string | null;
    ownerName: string | null;
  } | null;
  linkState: "linked" | "unlinked" | "unavailable";
};
