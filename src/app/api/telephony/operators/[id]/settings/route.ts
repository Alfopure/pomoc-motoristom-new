import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { parseOperatorSettingsPatch, updateOperatorTelephonySettings } from "@/server/telephony/config-service";
import { canEditConfig, configDeps, configErrorResponse, toConfigActor } from "@/server/telephony/config-route";
import { readJsonBody, TELEPHONY_ROUTE_ROLES } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-operator telephony settings (default outbound line/mobile, wrap-up,
 * auto-answer, ring volume and the fallback used while paused). An operator
 * may change their own; a manager or admin may change anyone's.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const { id } = await context.params;
    if (id !== actor.profileId && !canEditConfig(actor.role)) {
      return Response.json({ error: "Nastavenia iného operátora môže meniť len manažér alebo admin." }, { status: 403 });
    }

    const body = await readJsonBody(request);
    const settings = await updateOperatorTelephonySettings(configDeps(), {
      organizationId: actor.organizationId,
      actor: toConfigActor(actor),
      profileId: id,
      patch: parseOperatorSettingsPatch(body.patch ?? body),
    });
    return Response.json({ ok: true, profileId: id, settings });
  } catch (error) {
    return configErrorResponse(error, "Nastavenia operátora sa nepodarilo uložiť.");
  }
}
