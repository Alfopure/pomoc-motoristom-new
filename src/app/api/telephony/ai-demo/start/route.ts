import { handleAiDemoWrite } from "@/server/telephony/ai-demo/http";
import { describeAttempt, startAiDemo } from "@/server/telephony/ai-demo/orchestrator";
import { isUuid } from "@/lib/telephony/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Starts one demo call.
 *
 * `requestId` is the client's idempotency key: a double click, a retried fetch
 * or a browser that resends after a timeout must all resolve to the same
 * attempt rather than two calls to the same phone.
 */
export async function POST(request: Request) {
  return handleAiDemoWrite(
    request,
    async ({ deps, actor, body }) => {
      const requestId = typeof body.requestId === "string" && isUuid(body.requestId) ? body.requestId : null;
      const result = await startAiDemo(deps, {
        actorProfileId: actor.profileId,
        requestId,
        to: typeof body.to === "string" ? body.to : "",
        scenario: body.scenario,
        context: body.context,
        voice: body.voice,
      });
      return Response.json({ attempt: describeAttempt(result.attempt), reused: result.reused }, { status: result.reused ? 200 : 201 });
    },
    "AI demo sa nepodarilo spustiť.",
  );
}
