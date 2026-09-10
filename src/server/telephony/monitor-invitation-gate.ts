import type { CallActionDeps } from "./call-actions";
import { CallActionError } from "./service-errors";
import { telephonyStabilityEnabled } from "./stability";

/** Database authority defaults off until the physical three-party audio check. */
export async function monitorInvitationsEnabled(deps: Pick<CallActionDeps, "admin" | "organizationId">): Promise<boolean> {
  // A revoked monitor must be disconnected even if the provider request fails.
  // Do not activate the durable contract on otherwise legacy calls implicitly.
  if (!telephonyStabilityEnabled()) return false;
  const { data, error } = await deps.admin.from("motorist_telephony_settings").select("monitor_invites_enabled").eq("organization_id", deps.organizationId).maybeSingle();
  return !error && data?.monitor_invites_enabled === true;
}
export async function requireMonitorInvitations(deps: Pick<CallActionDeps, "admin" | "organizationId">): Promise<void> {
  if (!await monitorInvitationsEnabled(deps)) throw new CallActionError("Pozvané počúvanie zatiaľ nie je aktivované.", 503, "monitor_invites_disabled");
}
