import { requireDefaultMotoristActor } from "@/server/api-auth";
import { loadActiveCalls } from "@/server/telephony/active-calls";
import { sweepOverdueRingSteps } from "@/server/telephony/routing/ring-plan";
import { createTelephonyDeps, TELEPHONY_ROUTE_ROLES, telephonyConfiguredOrResponse, telephonyErrorResponse, type TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import { runSessionEvent } from "@/server/telephony/session-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Console poll target (design §2.4): active sessions, their open legs, ring
 * offers and operator presence in one flat round trip.
 *
 * It is also sweeper trigger (b) from design §2.3 item 9 — but the console
 * polls at 1 s per open tab, so the sweep is throttled per serverless instance
 * instead of running on every request.
 */
export const ACTIVE_SWEEP_INTERVAL_MS = 5_000;
/**
 * The poll must answer fast, so this trigger is bounded: after an outage there
 * can be up to 200 overdue sessions and driving them all through a lease + a
 * reducer + Telnyx commands would blow the function limit and take the
 * operator's snapshot down with it. The cron pass runs unbounded.
 */
export const ACTIVE_SWEEP_LIMIT = 4;
export const ACTIVE_SWEEP_BUDGET_MS = 2_000;

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
      limit: ACTIVE_SWEEP_LIMIT,
      budgetMs: ACTIVE_SWEEP_BUDGET_MS,
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

    const snapshot = await loadActiveCalls(
      { admin: deps.admin, organizationId: deps.organizationId, environment: deps.environment, configured: deps.config.configured },
      { profileId: actor.profileId, canManageAssignments: actor.role === "manager" || actor.role === "admin" || actor.role === "senior_dispatcher" },
    );
    // After the snapshot: the sweep must never delay the answer the console is
    // waiting for (a slow one only shifts the next poll's data by one tick).
    await maybeSweep(deps);

    return Response.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "Aktívne hovory sa nepodarilo načítať.");
  }
}
