import { serializeViptelError } from "@/lib/integrations/viptel/client";
import { MutationError } from "@/server/motorist-mutations";
import { readWorkplaceLeaseFence, requireTelephonyActor } from "@/server/telephony-access";
import { enqueueRedirectCommand } from "@/server/telephony/call-commands";

export const runtime = "nodejs";

type RedirectBody = {
  assignmentGeneration?: unknown;
  browserInstanceId?: unknown;
  destinationNumber?: unknown;
  destinationProfileId?: unknown;
  leaderEpoch?: unknown;
  leaseId?: unknown;
  leaseVersion?: unknown;
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireTelephonyActor(request);
    const body = (await request.json().catch(() => null)) as RedirectBody | null;
    const { id } = await context.params;
    const leaseFence = body?.leaseId === undefined ? undefined : readWorkplaceLeaseFence(body);
    const command = await enqueueRedirectCommand(actor, id, {
      destinationNumber: body?.destinationNumber,
      destinationProfileId: body?.destinationProfileId,
    }, leaseFence);
    return Response.json({ ok: true, command: { id: command.id, status: "queued" } }, { status: 202 });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json(
        { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status },
      );
    }
    const serialized = serializeViptelError(error);
    return Response.json({ ok: false, error: serialized.message }, { status: serialized.status });
  }
}
