import type { MobileBranchWorkspace } from "@/lib/mobile-api";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { loadFieldBranch } from "@/server/mobile/field-branch";
import { asMobileError } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** Pobočka: requests and running work of the member's own lead groups (`view` open|queue|active|done). */
export async function GET(request: Request) {
  try {
    const actor = await requireMobileMember(request);
    const payload: MobileBranchWorkspace = { ...fieldScope(actor), ...await loadFieldBranch(actor, new URL(request.url)) };
    return mobileJson(payload);
  } catch (error) { return mobileError(asMobileError(error), "Pobočku sa nepodarilo načítať."); }
}
