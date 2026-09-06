import { requireDefaultMotoristActor } from "@/server/api-auth";
import {
  announcementGenerationAvailable,
  getAnnouncementLines,
  saveLineAnnouncements,
} from "@/server/telephony/announcements-service";
import {
  CONFIG_READ_ROLES,
  canEditConfig,
  configDeps,
  configErrorResponse,
  handleConfigWrite,
} from "@/server/telephony/config-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(CONFIG_READ_ROLES);
    const lines = await getAnnouncementLines(configDeps(), actor.organizationId);
    return Response.json(
      { lines, canEdit: canEditConfig(actor.role), generationAvailable: announcementGenerationAvailable() },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return configErrorResponse(error, "Hlásenia sa nepodarilo načítať.");
  }
}

export async function PUT(request: Request) {
  return handleConfigWrite(request, {
    fallback: "Hlásenia sa nepodarilo uložiť.",
    run: async ({ deps, configActor, body, organizationId }) => {
      const line = await saveLineAnnouncements(deps, { ...body, organizationId, actor: configActor });
      return Response.json(line, { headers: { "Cache-Control": "private, no-store" } });
    },
  });
}
