import { parseIvrMenus, replaceIvrMenus } from "@/server/telephony/config-service";
import { documentResponse, handleConfigRead, handleConfigWrite, readExpectedVersion } from "@/server/telephony/config-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleConfigRead({ fallback: "IVR menu sa nepodarilo načítať." });
}

export async function PUT(request: Request) {
  return handleConfigWrite(request, {
    fallback: "IVR menu sa nepodarilo uložiť.",
    run: async ({ deps, actor, configActor, body, organizationId }) => {
      const ivrMenus = parseIvrMenus(body.ivrMenus);
      const { document, warning } = await replaceIvrMenus(deps, { organizationId, actor: configActor, ivrMenus, expectedVersion: readExpectedVersion(body) });
      return documentResponse(actor, document, warning);
    },
  });
}
