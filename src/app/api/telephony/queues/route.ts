import { serializeViptelError } from "@/lib/integrations/viptel/client";
import { MutationError } from "@/server/motorist-mutations";
import { requireTelephonyActor } from "@/server/telephony-access";
import { requestViptelProviderSnapshot } from "@/server/telephony/provider-snapshot-bridge";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const checkedAt = new Date().toISOString();

  try {
    const actor = await requireTelephonyActor();
    const requested = new URL(request.url).searchParams.get("queue") ?? undefined;
    const snapshot = await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, { maxAgeMs: 4_000 });
    const queues = snapshot.queues;
    const queueId = requested && queues.some((queue) => queue.id === requested) ? requested : queues[0]?.id;
    const status = queueId ? snapshot.queueStatuses.find((candidate) => candidate.queue === queueId) ?? null : null;

    return Response.json({ ok: true, checkedAt, queues, status });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ ok: false, checkedAt, error: error.message }, { status: error.status });
    }

    const serialized = serializeViptelError(error);
    return Response.json(
      { ok: false, checkedAt, error: serialized.message, providerStatus: serialized.providerStatus },
      { status: serialized.status },
    );
  }
}
