import { parseSettingsPatch, updateTelephonySettings } from "@/server/telephony/config-service";
import { CONFIG_ADMIN_ROLES, handleConfigRead, handleConfigWrite } from "@/server/telephony/config-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Organisation telephony settings: the DB kill switches, the destination
 * allowlist and the park limit. Admin only — these decide whether the system
 * may place a call at all.
 */
export async function GET() {
  return handleConfigRead({ roles: CONFIG_ADMIN_ROLES, fallback: "Nastavenia telefónie sa nepodarilo načítať." });
}

export async function PATCH(request: Request) {
  return handleConfigWrite(request, {
    roles: CONFIG_ADMIN_ROLES,
    fallback: "Nastavenia telefónie sa nepodarilo uložiť.",
    run: async ({ deps, configActor, body, organizationId }) => {
      const settings = await updateTelephonySettings(deps, { organizationId, actor: configActor, patch: parseSettingsPatch(body.patch ?? body) });
      return Response.json({ ok: true, settings });
    },
  });
}
