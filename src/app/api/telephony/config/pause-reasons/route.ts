import { parsePauseReasons, replacePauseReasons } from "@/server/telephony/config-service";
import { documentResponse, handleConfigRead, handleConfigWrite, readExpectedVersion } from "@/server/telephony/config-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleConfigRead({ fallback: "Dôvody pauzy sa nepodarilo načítať." });
}

export async function PUT(request: Request) {
  return handleConfigWrite(request, {
    fallback: "Dôvody pauzy sa nepodarilo uložiť.",
    run: async ({ deps, actor, configActor, body, organizationId }) => {
      const pauseReasons = parsePauseReasons(body.pauseReasons);
      const { document, warning } = await replacePauseReasons(deps, { organizationId, actor: configActor, pauseReasons, expectedVersion: readExpectedVersion(body) });
      return documentResponse(actor, document, warning);
    },
  });
}
