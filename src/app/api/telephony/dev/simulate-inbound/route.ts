import { randomUUID } from "node:crypto";

import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import {
  createTelephonyDeps,
  isProductionDeployment,
  readJsonBody,
  readString,
  telephonyConfiguredOrResponse,
  telephonyErrorResponse,
} from "@/server/telephony/runtime";
import { buildTelnyxEnvelope } from "@/server/telephony/state/events";
import { processTelnyxEvent, type ProcessorResult } from "@/server/telephony/telnyx/event-processor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Developer tool: pushes a synthetic inbound `call.initiated` (+ `call.answered`)
 * through the real webhook processor, so ring plans, business hours and the IVR
 * can be exercised before the DID is approved (design §4 Phase 2, D-2).
 *
 * Admin only and refused on the production deployment — the events it injects
 * create real sessions and issue real Telnyx commands.
 */
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["admin"]);

    if (isProductionDeployment()) {
      return Response.json({ error: "Simulácia hovoru nie je v produkcii dostupná." }, { status: 403 });
    }

    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const body = await readJsonBody<{ from?: unknown; to?: unknown; callControlId?: unknown; callSessionId?: unknown; answer?: unknown }>(request);
    const to = readString(body.to);
    if (!to) {
      return Response.json({ error: "Chýba volané číslo (to)." }, { status: 400 });
    }
    const from = readString(body.from) ?? "+421900000000";
    const callControlId = readString(body.callControlId) ?? `sim-${randomUUID()}`;
    const callSessionId = readString(body.callSessionId) ?? `sim-session-${randomUUID()}`;

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId, sweepAfterEvent: false });
    const connectionId = deps.config.configured ? (deps.config.callControlAppId ?? undefined) : undefined;

    const send = (type: string, payload: Record<string, unknown>): Promise<ProcessorResult> =>
      processTelnyxEvent(
        deps,
        buildTelnyxEnvelope({
          id: `sim-${randomUUID()}`,
          type,
          payload: {
            call_control_id: callControlId,
            call_leg_id: `sim-leg-${callControlId}`,
            call_session_id: callSessionId,
            connection_id: connectionId,
            from,
            to,
            direction: "incoming",
            ...payload,
          },
        }),
      );

    const results: ProcessorResult[] = [await send("call.initiated", { state: "parked" })];
    if (body.answer !== false) {
      results.push(await send("call.answered", { state: "answered" }));
    }

    return Response.json({
      ok: true,
      callControlId,
      callSessionId,
      sessionId: results.find((result) => result.sessionId)?.sessionId ?? null,
      results: results.map((result) => ({ type: result.type, outcome: result.outcome, status: result.status, commands: result.commands.map((command) => `${command.kind}${command.ok ? "" : "!"}`), error: result.error })),
    });
  } catch (error) {
    return telephonyErrorResponse(error, "Simuláciu hovoru sa nepodarilo spustiť.");
  }
}
