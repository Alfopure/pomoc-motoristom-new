import type { Json } from "@/lib/supabase/database.types";

export const WORKPLACE_TAKEOVER_REQUEST_TYPE = "workplace_takeover_request";
export const WORKPLACE_TAKEOVER_DECISION_SECONDS = 30;
export const WORKPLACE_TAKEOVER_HANDOFF_SECONDS = 300;
export const WORKPLACE_TAKEOVER_REFUSAL_COOLDOWN_SECONDS = 300;

export type WorkplaceTakeoverRequestStatus =
  | "accepted"
  | "cancelled"
  | "completed"
  | "declined"
  | "expired"
  | "pending";

export type WorkplaceTakeoverRequest = {
  requestId: string;
  extensionId: string;
  extension: string;
  leaseId: string;
  requesterProfileId: string;
  requesterName: string;
  ownerProfileId: string;
  ownerName: string;
  requestedAt: string;
  expiresAt: string;
  status: WorkplaceTakeoverRequestStatus;
  respondedAt?: string;
  handoffExpiresAt?: string;
  acceptedBy?: "owner" | "timeout";
  cooldownUntil?: string;
};

export type WorkplaceTakeoverSnapshot = {
  checkedAt: string;
  incoming?: WorkplaceTakeoverRequest;
  outgoing?: WorkplaceTakeoverRequest;
  cooldowns?: Array<{
    extension: string;
    until: string;
  }>;
};

export function isWorkplaceTakeoverPayload(value: Json | null | undefined): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.type === WORKPLACE_TAKEOVER_REQUEST_TYPE,
  );
}
