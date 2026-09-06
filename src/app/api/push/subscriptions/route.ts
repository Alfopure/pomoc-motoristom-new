import { handlePushRoute } from "@/server/push-route";
import { deletePushSubscription, getPushSubscriptionStatus, savePushSubscription, updatePushSound } from "@/server/web-push";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handlePushRoute(request, (supabase, actor) => getPushSubscriptionStatus(supabase, actor, new URL(request.url).searchParams.get("endpoint")));
}

export async function POST(request: Request) {
  return handlePushRoute(request, (supabase, actor, body) => savePushSubscription(supabase, actor, body.subscription, body.soundEnabled));
}

export async function PATCH(request: Request) {
  return handlePushRoute(request, (supabase, actor, body) => updatePushSound(supabase, actor, body.endpoint, body.soundEnabled));
}

export async function DELETE(request: Request) {
  return handlePushRoute(request, (supabase, actor, body) => deletePushSubscription(supabase, actor, body.endpoint));
}
