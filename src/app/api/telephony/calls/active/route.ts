import { after } from "next/server";

import { requireDefaultMotoristActor } from "@/server/api-auth";
import { loadActiveCalls } from "@/server/telephony/active-calls";
import { recoverOwnEndedSessionPresence } from "@/server/telephony/presence-recovery";
import { sweepOverdueRingSteps } from "@/server/telephony/routing/ring-plan";
import { createTelephonyDeps, TELEPHONY_ROUTE_ROLES, telephonyConfiguredOrResponse, telephonyErrorResponse, type TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import { runSessionEvent } from "@/server/telephony/session-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Includes the bounded sweep and call push after the response.
export const maxDuration = 60;

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

    // Terminal sessions are absent from this snapshot, so browser-leg recovery
    // cannot clear their stale owner. Repair the authenticated operator before
    // returning presence, without waiting for cron or contacting Telnyx.
    try {
      const recovery = await recoverOwnEndedSessionPresence(deps, actor.profileId);
      for (const failure of recovery.errors) {
        deps.logger?.({ level: "warn", scope: "presence_recovery", source: "calls/active", ...failure });
      }
    } catch (error) {
      deps.logger?.({ level: "warn", scope: "presence_recovery", source: "calls/active", error: error instanceof Error ? error.message : String(error) });
    }

    const snapshot = await loadActiveCalls(
      { admin: deps.admin, organizationId: deps.organizationId, environment: deps.environment, configured: deps.config.configured, now: deps.now },
      { profileId: actor.profileId, canManageAssignments: actor.role === "manager" || actor.role === "admin" || actor.role === "senior_dispatcher" },
    );
    // A single session can outlast the sweep's start budget while waiting for
    // its lease or provider. Send the snapshot before any sweep work begins.
    after(() => maybeSweep(deps));

    return Response.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "Aktívne hovory sa nepodarilo načítať.");
  }
}
