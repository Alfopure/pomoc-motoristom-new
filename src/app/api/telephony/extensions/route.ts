import { serializeViptelError } from "@/lib/integrations/viptel/client";
import { MutationError } from "@/server/motorist-mutations";
import { listOwnedTelephonyExtensions, requireTelephonyActor } from "@/server/telephony-access";
import { requestViptelProviderSnapshot } from "@/server/telephony/provider-snapshot-bridge";

export const runtime = "nodejs";

export async function GET() {
  try {
    const actor = await requireTelephonyActor();
    const ownedExtensions = await listOwnedTelephonyExtensions(actor);
    const ownedNumbers = new Set(ownedExtensions.map((extension) => extension.extension));
    const extensions = (
      await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, { maxAgeMs: 4_000 })
    ).extensions.filter((extension) => ownedNumbers.has(extension.extension));

    return Response.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      extensions: extensions.map((extension) => ({
        extension: extension.extension,
        name: extension.name,
        outboundCid: extension.outboundCid,
        callForwarding: extension.callForwarding,
        isRegistered: extension.isRegistered,
        isViptelPhoneActive: extension.isViptelPhoneActive,
        allowedChanges: extension.allowedChanges,
      })),
    });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ ok: false, error: error.message }, { status: error.status });
    }

    const serialized = serializeViptelError(error);
    return Response.json({ ok: false, error: serialized.message, providerStatus: serialized.providerStatus }, { status: serialized.status });
  }
}
