import { guideChapters, GUIDE_CONTENT_VERSION, GUIDE_UPDATED_AT, GUIDE_SOURCE_REVISION } from "@/content/guide/chapters";
import screenshots from "@/content/guide/screenshots.json";
import { buildGuideKnowledge } from "@/content/guide/knowledge";
import { motoristAccessGuard } from "@/server/api-auth";

export const dynamic = "force-dynamic";

/** Authenticated documentation export for future retrieval, never live state. */
export async function GET() {
  const denied = await motoristAccessGuard();
  if (denied) return denied;
  return Response.json(buildGuideKnowledge(guideChapters, screenshots, {
    version: GUIDE_CONTENT_VERSION,
    updatedAt: GUIDE_UPDATED_AT,
    sourceRevision: GUIDE_SOURCE_REVISION,
  }), { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
