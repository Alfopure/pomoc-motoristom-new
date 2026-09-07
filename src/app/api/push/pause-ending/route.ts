import { handlePushRoute } from "@/server/push-route";
import { materializePauseEndingNotification } from "@/server/telephony/pause-ending-notifications";
import { getPauseEndingNotificationPreference, setPauseEndingNotificationPreference } from "@/server/web-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handlePushRoute(request, (supabase, actor) => getPauseEndingNotificationPreference(supabase, actor));
}

export async function PATCH(request: Request) {
  return handlePushRoute(request, (supabase, actor, body) => setPauseEndingNotificationPreference(supabase, actor, body.enabled));
}

export async function POST(request: Request) {
  return handlePushRoute(request, (supabase, actor, body) => materializePauseEndingNotification(supabase, {
    organizationId: actor.organizationId,
    profileId: actor.profileId,
    expectedPauseStartedAt: typeof body.pauseStartedAt === "string" ? body.pauseStartedAt : null,
  }));
}
