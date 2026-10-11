import type { MobileCaseDetail } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { getMobileCase } from "@/server/mobile/cases";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request);
    const { id } = await context.params;
    const body: MobileCaseDetail = { ...mobileScope(actor), case: await getMobileCase(actor, id, request.signal) };
    return mobileJson(body);
  } catch (error) { return mobileError(error, "Prípad sa nepodarilo načítať."); }
}
