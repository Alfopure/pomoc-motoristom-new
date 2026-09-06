import { handlePushRoute } from "@/server/push-route";
import { sendTestPush } from "@/server/web-push";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handlePushRoute(request, (supabase, actor, body) => sendTestPush(supabase, actor, body.endpoint));
}
