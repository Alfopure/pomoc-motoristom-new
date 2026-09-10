/** Invitations are persisted in the call's metadata under its existing lease/CAS. */
export type MonitorInvitation = {
  id: string;
  sessionId: string;
  inviterProfileId: string;
  inviterName: string;
  recipientProfileId: string;
  recipientName: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  disconnectRequestedAt?: string;
};
export type MonitorInvitationView = MonitorInvitation & { mine: boolean; status: "pending" | "listening" | "disconnecting" | "ended" | "expired" | "revoked" };
export const MONITOR_INVITATION_TTL_MS = 120_000;
