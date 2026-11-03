import type { MobileCaseDetail, MobileCaseUpdated } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { getMobileCase, readMobileCaseUpdate, updateMobileCase } from "@/server/mobile/cases";
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

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request);
    const { id } = await context.params;
    const result = await updateMobileCase(actor, id, await readMobileCaseUpdate(request));
    const body: MobileCaseUpdated = { ...mobileScope(actor), ...result };
    return mobileJson(body);
  } catch (error) { return mobileError(error, "Výsledok uloženia sa nepodarilo overiť. Overte tú istú požiadavku znova."); }
}
