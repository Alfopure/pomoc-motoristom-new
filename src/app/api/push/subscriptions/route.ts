import { handlePushRoute } from "@/server/push-route";
import { deletePushSubscription, getPushSubscriptionStatus, savePushSubscription, updatePushPreferences } from "@/server/web-push";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handlePushRoute(request, (supabase, actor) => getPushSubscriptionStatus(supabase, actor, new URL(request.url).searchParams.get("endpoint")));
}

export async function POST(request: Request) {
  return handlePushRoute(request, (supabase, actor, body) => savePushSubscription(supabase, actor, body.subscription, body.soundEnabled, body));
}

export async function PATCH(request: Request) {
  return handlePushRoute(request, (supabase, actor, body) => updatePushPreferences(supabase, actor, body.endpoint, body));
}

export async function DELETE(request: Request) {
  return handlePushRoute(request, (supabase, actor, body) => deletePushSubscription(supabase, actor, body.endpoint));
}
