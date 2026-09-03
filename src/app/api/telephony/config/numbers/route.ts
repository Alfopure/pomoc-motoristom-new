import { parseLinePatch, updateTelephonyLine } from "@/server/telephony/config-service";
import { documentResponse, handleConfigRead, handleConfigWrite } from "@/server/telephony/config-route";
import { readString } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lines (DIDs) already provisioned in the database. Buying a number from
 * Telnyx is not part of this phase — a new number is added by an administrator
 * (`docs/operations/telnyx-runbook.md`).
 */
export async function GET() {
  return handleConfigRead({ fallback: "Čísla sa nepodarilo načítať." });
}

/** Label, partner, ring plan, IVR menu, business hours, environment and the active flag of one line. */
export async function PATCH(request: Request) {
  return handleConfigWrite(request, {
    fallback: "Linku sa nepodarilo uložiť.",
    run: async ({ deps, actor, configActor, body, organizationId }) => {
      const lineId = readString(body.lineId);
      if (!lineId) return Response.json({ error: "Chýba identifikátor linky." }, { status: 400 });
      const { document } = await updateTelephonyLine(deps, { organizationId, actor: configActor, lineId, patch: parseLinePatch(body.patch ?? body) });
      return documentResponse(actor, document);
    },
  });
}
