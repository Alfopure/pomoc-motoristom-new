import { logAppError, readAppErrorReport } from "@/server/mobile/app-status";
import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";

export const runtime = "nodejs";
/** Error reports of the signed-in app; only a masked runtime log line is kept. */
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    logAppError(actor, readAppErrorReport(await readMobileJsonBody(request)));
    return mobileJson({ ...mobileScope(actor), received: true });
  } catch (error) { return mobileError(error, "Hlásenie chyby sa nepodarilo prijať."); }
}
