import type { MobileTaskDetail } from "@/lib/mobile-api";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { getMobileTask } from "@/server/mobile/tasks";
import { requireMobileUser } from "@/server/mobile/user";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { actor, client } = await requireMobileUser(request);
    const { id } = await context.params;
    const result = await getMobileTask(actor, id, client);
    const body: MobileTaskDetail = { ...mobileScope(actor), ...result };
    return mobileJson(body);
  } catch (error) { return mobileError(error, "Úlohu sa nepodarilo načítať."); }
}
