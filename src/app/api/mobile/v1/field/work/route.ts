import type { MobileFieldWork } from "@/lib/mobile-api";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, loadFieldOperations, loadFieldTowing } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";
/** Moja práca: own open jazdy/odvozy/presuny (`deliver`) and own odťahy (`drive`).
 * One source failing does not hide the other; it is named in `unavailable`. */
export async function GET(request: Request) {
  try {
    const actor = await requireMobileMember(request);
    if (!actor.capabilities.includes("deliver") && !actor.capabilities.includes("drive")) throw new MutationError("Nemáte pridelenú prácu v teréne.", 403, "mobile_no_work_access");
    const [operations, towing] = await Promise.allSettled([loadFieldOperations(actor), loadFieldTowing(actor)]);
    if (operations.status === "rejected" && towing.status === "rejected") throw operations.reason;
    const unavailable = [...(operations.status === "rejected" ? ["operations" as const] : []), ...(towing.status === "rejected" ? ["towing" as const] : [])];
    if (unavailable.length) console.warn(JSON.stringify({ event: "mobile.work", unavailable }));
    const payload: MobileFieldWork = { ...fieldScope(actor), operations: operations.status === "fulfilled" ? operations.value : null,
      towing: towing.status === "fulfilled" ? towing.value : null, unavailable };
    return mobileJson(payload);
  } catch (error) { return mobileError(asMobileError(error), "Prácu sa nepodarilo načítať."); }
}
