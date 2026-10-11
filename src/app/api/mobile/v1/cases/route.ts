import type { MobileCaseCreated, MobileCases } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { createMobileCase, listMobileCases, parseMobileCaseQuery, readMobileCaseCreate } from "@/server/mobile/cases";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const result = await listMobileCases(actor, parseMobileCaseQuery(new URL(request.url).searchParams), request.signal);
    const body: MobileCases = { ...mobileScope(actor), ...result };
    return mobileJson(body);
  } catch (error) { return mobileError(error, "Prípady sa nepodarilo načítať."); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const result = await createMobileCase(actor, await readMobileCaseCreate(request));
    const body: MobileCaseCreated = { ...mobileScope(actor), ...result };
    return mobileJson(body, 201);
  } catch (error) {
    return mobileError(error, "Uloženie sa nepodarilo potvrdiť. Pred ďalším pokusom skontrolujte zoznam prípadov.");
  }
}
