import type { MobileBranchReceipt } from "@/lib/mobile-api";
import { readMobileJsonBody } from "@/server/mobile/body";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { commandFieldBranch } from "@/server/mobile/field-branch";
import { asMobileError } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** Prevziať, Uvoľniť, Prideliť (materialize/operate) or Znovu otvoriť a request of an own lead group. */
export async function POST(request: Request) {
  try {
    const actor = await requireMobileMember(request);
    const payload: MobileBranchReceipt = { ...fieldScope(actor), ...await commandFieldBranch(actor, await readMobileJsonBody(request)) };
    return mobileJson(payload);
  } catch (error) { return mobileError(asMobileError(error), "Krok pobočky sa nepodarilo potvrdiť. Zopakujte ho."); }
}
