import { getViptelWebphoneConfig, isViptelBrowserCredentialExposureEnabled } from "@/lib/telephony/webphone";
import { MutationError } from "@/server/motorist-mutations";
import { listOwnedTelephonyExtensions, requireTelephonyActor } from "@/server/telephony-access";

export const runtime = "nodejs";
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    const actor = await requireTelephonyActor();
    const ownedExtensions = await listOwnedTelephonyExtensions(actor);
    const ownedNumbers = new Set(ownedExtensions.map((item) => item.extension));
    const includeSecrets = isViptelBrowserCredentialExposureEnabled();
    const config = getViptelWebphoneConfig(process.env);

    return Response.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      config: {
        ...config,
        extensions: config.extensions.filter((extension) => ownedNumbers.has(extension.extension)),
        credentialsExposure: includeSecrets ? "browser_test" : config.credentialsExposure,
      },
      identity: {
        defaultExtension: ownedExtensions[0]?.extension,
        extensions: ownedExtensions.map((extension) => ({
          extension: extension.extension,
          displayName: extension.display_name ?? undefined,
          registered: extension.is_registered ?? undefined,
          lastSyncedAt: extension.last_synced_at ?? undefined,
        })),
      },
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Webphone konfiguráciu sa nepodarilo načítať.",
      },
      { status: error instanceof MutationError ? error.status : 500, headers: NO_STORE_HEADERS },
    );
  }
}
