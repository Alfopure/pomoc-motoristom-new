import "server-only";

import { assertSameOriginRequest, requireDefaultMotoristActor, type MotoristActor } from "@/server/api-auth";

import { createTelephonyDeps, telephonyErrorResponse, telephonyLogger } from "../runtime";
import { AiDemoMigrationMissingError } from "./attempts";
import { AiDemoError, type AiDemoDeps } from "./orchestrator";

/**
 * Shared body of the `/api/telephony/ai-demo/*` routes.
 *
 * Admin only, every one of them, including the reads: the timeline names a
 * scenario and a masked number, and "who may look at the AI experiment" is the
 * same question as "who may run it".
 *
 * Mutations assert the origin before the session guard so a cross-site request
 * is refused without ever reaching the demo logic — the same order the rest of
 * the telephony routes use.
 */

export const AI_DEMO_ROLES = ["admin"] as const;

export type AiDemoRouteContext = { actor: MotoristActor; deps: AiDemoDeps };

function respondError(error: unknown, fallback: string): Response {
  if (error instanceof AiDemoError) {
    return Response.json(
      { error: error.message, code: error.code, ...(error.missing && error.missing.length > 0 ? { missing: error.missing } : {}) },
      { status: error.status },
    );
  }
  if (error instanceof AiDemoMigrationMissingError) {
    return Response.json({ error: "Databázová migrácia AI dema nie je aplikovaná.", code: "ai_demo_migration_missing" }, { status: 503 });
  }
  return telephonyErrorResponse(error, fallback);
}

export async function handleAiDemoRead(run: (context: AiDemoRouteContext) => Promise<Response>, fallback: string): Promise<Response> {
  try {
    const actor = await requireDefaultMotoristActor([...AI_DEMO_ROLES]);
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId, logger: telephonyLogger });
    return await run({ actor, deps });
  } catch (error) {
    return respondError(error, fallback);
  }
}

export async function handleAiDemoWrite(
  request: Request,
  run: (context: AiDemoRouteContext & { body: Record<string, unknown> }) => Promise<Response>,
  fallback: string,
): Promise<Response> {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor([...AI_DEMO_ROLES]);
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId, logger: telephonyLogger });
    const parsed = await request.json().catch(() => null);
    const body = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    return await run({ actor, deps, body });
  } catch (error) {
    return respondError(error, fallback);
  }
}
