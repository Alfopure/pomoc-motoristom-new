import { serializeViptelError } from "@/lib/integrations/viptel/client";
import { MutationError } from "@/server/motorist-mutations";
import { readWorkplaceLeaseFence, requireTelephonyActor } from "@/server/telephony-access";
import { enqueueHangupCommand } from "@/server/telephony/call-commands";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireTelephonyActor(request);
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const leaseFence = body.leaseId === undefined ? undefined : readWorkplaceLeaseFence(body);
    const command = await enqueueHangupCommand(actor, id, leaseFence, {
      incomingQueueDecline: body.intent === "decline_incoming_queue",
    });
    return Response.json({ ok: true, command: { id: command.id, status: "queued" } }, { status: 202 });
  } catch (error) {
    if (error instanceof MutationError) return Response.json(
      { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) },
      { status: error.status },
    );
    const serialized = serializeViptelError(error);
    return Response.json({ ok: false, error: serialized.message }, { status: serialized.status });
  }
}
