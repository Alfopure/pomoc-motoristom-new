import { generateAnnouncementAudio } from "@/server/telephony/announcements-service";
import { handleConfigWrite } from "@/server/telephony/config-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Generates a preview asset. Only the explicit configuration save activates it. */
export async function POST(request: Request) {
  return handleConfigWrite(request, {
    fallback: "Zvuk sa nepodarilo vytvoriť.",
    run: async ({ deps, body, organizationId }) => {
      const generated = await generateAnnouncementAudio(deps, { ...body, organizationId });
      return Response.json(generated, { headers: { "Cache-Control": "private, no-store" } });
    },
  });
}
