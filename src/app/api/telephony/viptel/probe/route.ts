import { sameDialNumber } from "@/lib/telephony/phone";
import { requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { requestViptelProviderSnapshot } from "@/server/telephony/provider-snapshot-bridge";
import { VIPTEL_NEUTRAL_OUTBOUND_CID } from "@/server/telephony/viptel-line-catalog";

export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    const actor = await requireDefaultMotoristActor(["admin"]);
    const searchParams = new URL(request.url).searchParams;
    const snapshot = await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, { maxAgeMs: 2_000 });
    const requestedExtension = searchParams.get("extension")?.trim() || snapshot.personalExtensions[0];
    const extension = snapshot.extensions.find((candidate) => candidate.extension === requestedExtension);
    const callerId = searchParams.get("callerId")?.trim() || VIPTEL_NEUTRAL_OUTBOUND_CID;
    const callerIdAllowed = snapshot.extensions.some(
      (candidate) => candidate.outboundCid && sameDialNumber(candidate.outboundCid, callerId),
    );

    return Response.json({
      ok: Boolean(extension) && callerIdAllowed,
      checkedAt: snapshot.capturedAt,
      rest: {
        transport: "hetzner_listener_snapshot_bridge",
        extensionCount: snapshot.extensions.length,
        activeCallCount: snapshot.activeCalls.length,
        queueCount: snapshot.queueStatuses.length,
      },
      websocket: {
        loginProbe: "VIPTel WebSocket drží always-on Hetzner listener; Vercel route overuje jeho čerstvý REST snapshot.",
      },
      extension,
      extensionFound: Boolean(extension),
      callerId,
      callerIdAllowed,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const status = error instanceof MutationError ? error.status : 500;
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "VIPTel snapshot probe sa nepodarilo vykonať.",
    }, { status, headers: NO_STORE_HEADERS });
  }
}
