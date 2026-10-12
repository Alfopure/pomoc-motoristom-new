import type { MobileMyTasks } from "@/lib/mobile-api";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { listMobileMyTasks, parseMobileMyTaskQuery } from "@/server/mobile/tasks";
import { requireMobileUser } from "@/server/mobile/user";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { actor, client } = await requireMobileUser(request);
    const query = parseMobileMyTaskQuery(new URL(request.url).searchParams);
    const result = await listMobileMyTasks(actor, query, client);
    const body: MobileMyTasks = { ...mobileScope(actor), ...result };
    return mobileJson(body);
  } catch (error) {
    return mobileError(error, "Vaše úlohy sa nepodarilo načítať.");
  }
}
