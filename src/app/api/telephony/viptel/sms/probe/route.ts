import { probeViptelSms, serializeViptelSmsError } from "@/lib/integrations/viptel/sms-client";
import { motoristAccessGuard } from "@/server/api-auth";

export const runtime = "nodejs";

export async function GET() {
  const denied = await motoristAccessGuard({ roles: ["admin"] });
  if (denied) return denied;

  try {
    const probe = await probeViptelSms();

    return Response.json({
      ok: true,
      sms: {
        baseUrl: probe.baseUrl,
        credit: probe.credit.credit,
        identityCount: probe.identityCount,
        identities: probe.identities,
      },
      liveSend: {
        enabled: probe.liveSendsEnabled,
        ready: probe.liveSendReady,
        missing: probe.missingForLiveSend,
        selectedFromIdentity: probe.selectedFromIdentity,
        testMsisdnConfigured: probe.testMsisdnConfigured,
      },
    });
  } catch (error) {
    const serialized = serializeViptelSmsError(error);

    return Response.json(
      {
        ok: false,
        error: serialized.message,
        providerStatus: serialized.providerStatus,
        providerResponseSummary: serialized.providerResponseSummary,
      },
      { status: serialized.status },
    );
  }
}
