import { serializeViptelError } from "@/lib/integrations/viptel/client";
import { MutationError } from "@/server/motorist-mutations";
import { requireTelephonyActor } from "@/server/telephony-access";
import { listAvailableTransferTargets } from "@/server/telephony/call-commands";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireTelephonyActor();
    const { id } = await context.params;
    const targets = await listAvailableTransferTargets(actor, id);
    return Response.json({ ok: true, targets }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof MutationError) return Response.json({ ok: false, error: error.message }, { status: error.status });
    const serialized = serializeViptelError(error);
    return Response.json({ ok: false, error: serialized.message }, { status: serialized.status });
  }
}
