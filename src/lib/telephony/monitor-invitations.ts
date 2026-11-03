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
/** A colleague call has no customer to listen to; the server refuses it (409 not_supported_internal). */
export function canInviteMonitor(call: { direction: string } | null | undefined): boolean {
  return Boolean(call) && call!.direction !== "internal";
}
