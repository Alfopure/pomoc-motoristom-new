import type { MobileTaskColleagues } from "@/lib/mobile-api";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { listMobileTaskColleagues } from "@/server/mobile/tasks";
import { requireMobileUser } from "@/server/mobile/user";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { actor, client } = await requireMobileUser(request);
    const body: MobileTaskColleagues = { ...mobileScope(actor), colleagues: await listMobileTaskColleagues(actor, client) };
    return mobileJson(body);
  } catch (error) { return mobileError(error, "Kolegov sa nepodarilo načítať."); }
}
