import { parseRingGroups, replaceRingGroups } from "@/server/telephony/config-service";
import { documentResponse, handleConfigRead, handleConfigWrite, readExpectedVersion } from "@/server/telephony/config-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whole routing document (groups, plans, hours, pause reasons, lines, operators). */
export async function GET() {
  return handleConfigRead({ fallback: "Skupiny zvonenia sa nepodarilo načítať." });
}

/** Replaces every ring group and its members in one transaction. */
export async function PUT(request: Request) {
  return handleConfigWrite(request, {
    fallback: "Skupiny zvonenia sa nepodarilo uložiť.",
    run: async ({ deps, actor, configActor, body, organizationId }) => {
      const groups = parseRingGroups(body.groups);
      const { document, warning } = await replaceRingGroups(deps, { organizationId, actor: configActor, groups, expectedVersion: readExpectedVersion(body) });
      return documentResponse(actor, document, warning);
    },
  });
}
