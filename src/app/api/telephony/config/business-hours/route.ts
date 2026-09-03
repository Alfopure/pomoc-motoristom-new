import { parseBusinessHours, replaceBusinessHours } from "@/server/telephony/config-service";
import { documentResponse, handleConfigRead, handleConfigWrite, readExpectedVersion } from "@/server/telephony/config-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleConfigRead({ fallback: "Otváracie hodiny sa nepodarilo načítať." });
}

/** Replaces the schedules with their intervals and exceptions in one transaction. */
export async function PUT(request: Request) {
  return handleConfigWrite(request, {
    fallback: "Otváracie hodiny sa nepodarilo uložiť.",
    run: async ({ deps, actor, configActor, body, organizationId }) => {
      const businessHours = parseBusinessHours(body.businessHours);
      const { document, warning } = await replaceBusinessHours(deps, { organizationId, actor: configActor, businessHours, expectedVersion: readExpectedVersion(body) });
      return documentResponse(actor, document, warning);
    },
  });
}
