import type { MonitorInvitationView } from "@/lib/telephony/monitor-invitations";
import { type CallActionDeps, type CallActor, listTransferTargets } from "./call-actions";
import { monitorInvitationsEnabled } from "./monitor-invitation-gate";
import { CallActionError } from "./service-errors";
import { ACTIVE_SESSION_STATES, type SessionMeta } from "./state/types";

export async function listMonitorInvitations(deps: CallActionDeps, actor: CallActor) {
  const enabled = await monitorInvitationsEnabled(deps);
  const [queries, legs] = await Promise.all([
    Promise.all([
      deps.admin.from("motorist_call_sessions").select("id, metadata, ended_at, state").eq("organization_id", deps.organizationId).is("ended_at", null).contains("metadata", { monitorInviteRecipients: [actor.profileId] }),
      deps.admin.from("motorist_call_sessions").select("id, metadata, ended_at, state").eq("organization_id", deps.organizationId).is("ended_at", null).contains("metadata", { monitorInviteActors: [actor.profileId] }),
    ]),
    deps.admin.from("motorist_call_legs").select("session_id, metadata").eq("organization_id", deps.organizationId)
      .eq("role", "supervisor").is("ended_at", null).neq("state", "ended").neq("state", "failed"),
  ]);
  if (queries.some(result => result.error)) throw new CallActionError("Pozvánky sa nepodarilo načítať.", 503);
  if (legs.error) throw new CallActionError("Stav odpojenia poslucháča sa nepodarilo načítať.", 503);
  const sessions = new Map(queries.flatMap(result => result.data ?? []).map(row => [row.id, row]));
  const openInvitations = new Set<string>();
  const additionalSessions = new Set<string>();
  for (const leg of legs.data ?? []) {
    const invitationId = (leg.metadata as { monitor_invitation_id?: string } | null)?.monitor_invitation_id;
    if (!invitationId) continue;
    openInvitations.add(`${leg.session_id}:${invitationId}`);
    if (!sessions.has(leg.session_id)) additionalSessions.add(leg.session_id);
  }
  // A session can end before its final provider hangup succeeds. Only look up
  // those still-open monitor legs, retaining the same inbox identity filters.
  if (additionalSessions.size) {
    const pending = await Promise.all(["monitorInviteRecipients", "monitorInviteActors"].map(key =>
      deps.admin.from("motorist_call_sessions").select("id, metadata, ended_at, state").eq("organization_id", deps.organizationId)
        .in("id", [...additionalSessions]).contains("metadata", { [key]: [actor.profileId] })));
    if (pending.some(result => result.error)) throw new CallActionError("Stav odpojenia poslucháča sa nepodarilo načítať.", 503);
    for (const session of pending.flatMap(result => result.data ?? [])) sessions.set(session.id, session);
  }
  const now = (deps.now?.() ?? new Date()).getTime();
  const invitations: MonitorInvitationView[] = [];
  for (const session of sessions.values()) {
    const meta = session.metadata as SessionMeta;
    for (const invitation of Object.values(meta.monitorInvitations ?? {})) {
      if (invitation.recipientProfileId !== actor.profileId && invitation.inviterProfileId !== actor.profileId) continue;
      const active = ACTIVE_SESSION_STATES.has(session.state);
      const connected = openInvitations.has(`${session.id}:${invitation.id}`);
      if (!active && !connected) continue;
      const disconnecting = connected && (invitation.revokedAt || invitation.disconnectRequestedAt || !active);
      const status = disconnecting ? "disconnecting" : invitation.revokedAt ? "revoked" : invitation.acceptedAt ? connected || meta.supervise?.[invitation.recipientProfileId]?.invitationId === invitation.id ? "listening" : "ended" : Date.parse(invitation.expiresAt) <= now ? "expired" : "pending";
      invitations.push({ ...invitation, mine: invitation.inviterProfileId === actor.profileId, status });
    }
  }
  const targets = enabled ? (await listTransferTargets(deps, actor)).filter(target => target.deviceLive && ["dispatcher", "senior_dispatcher"].includes(target.role)) : [];
  return { enabled, invitations, targets };
}
