import type { MobileCaseOwnerAssigned, MobileCaseOwnerContext } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { assignMobileCaseOwner, getMobileCaseOwner, readMobileCaseOwner } from "@/server/mobile/case-owner";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request);
    const { id } = await context.params;
    const result: MobileCaseOwnerContext = { ...mobileScope(actor), ...await getMobileCaseOwner(actor, id, request.signal) };
    return mobileJson(result);
  } catch (error) { return mobileError(error, "Priradenie sa nepodarilo načítať."); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request);
    const { id } = await context.params;
    const result: MobileCaseOwnerAssigned = { ...mobileScope(actor), ...await assignMobileCaseOwner(actor, id, await readMobileCaseOwner(request)) };
    return mobileJson(result);
  } catch (error) { return mobileError(error, "Výsledok priradenia nie je potvrdený. Overte tú istú požiadavku znova."); }
}
