import { handlePushRoute } from "@/server/push-route";
import { getMobileCallPushSettings, setMobileCallPushSettings } from "@/server/web-push";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handlePushRoute(request, (supabase, actor) => getMobileCallPushSettings(supabase, actor));
}

export async function PATCH(request: Request) {
  return handlePushRoute(request, (supabase, actor, body) => setMobileCallPushSettings(supabase, actor, body.enabled));
}
