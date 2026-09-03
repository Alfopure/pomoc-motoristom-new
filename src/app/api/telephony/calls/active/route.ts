import { requireDefaultMotoristActor } from "@/server/api-auth";
import { loadActiveCalls } from "@/server/telephony/active-calls";
import { sweepOverdueRingSteps } from "@/server/telephony/routing/ring-plan";
import { createTelephonyDeps, TELEPHONY_ROUTE_ROLES, telephonyConfiguredOrResponse, telephonyErrorResponse, type TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import { runSessionEvent } from "@/server/telephony/session-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Console poll target (design §2.4): active sessions, their open legs, ring
 * offers and operator presence in one flat round trip.
 *
 * It is also sweeper trigger (b) from design §2.3 item 9 — but the console
 * polls at 1 s per open tab, so the sweep is throttled per serverless instance
 * instead of running on every request.
 */
export const ACTIVE_SWEEP_INTERVAL_MS = 5_000;

let lastSweepAt = 0;

async function maybeSweep(deps: TelephonyRuntimeDeps): Promise<void> {
  if (!deps.telnyx) return;
  const now = Date.now();
  if (now - lastSweepAt < ACTIVE_SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  try {
    await sweepOverdueRingSteps({
      admin: deps.admin,
      organizationId: deps.organizationId,
      runSessionEvent: (sessionId, event) => runSessionEvent(deps, sessionId, event),
    });
  } catch (error) {
    deps.logger?.({ level: "warn", scope: "sweep", source: "calls/active", error: error instanceof Error ? error.message : String(error) });
  }
}

export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    await maybeSweep(deps);

    const snapshot = await loadActiveCalls(
      { admin: deps.admin, organizationId: deps.organizationId, environment: deps.environment, configured: deps.config.configured },
      { profileId: actor.profileId, canManageAssignments: actor.role === "manager" || actor.role === "admin" || actor.role === "senior_dispatcher" },
    );

    return Response.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "Aktívne hovory sa nepodarilo načítať.");
  }
}
