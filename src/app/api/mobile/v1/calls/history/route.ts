import type { MobileHistory } from "@/lib/mobile-api";
import { parseCallHistoryQuery } from "@/lib/telephony/call-history-query";
import { MutationError } from "@/server/mutation-error";
import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { mobileHistoryCall } from "@/server/mobile/read-model";
import { searchTelephonyCallHistory } from "@/server/telephony/call-history";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const params = new URL(request.url).searchParams;
    if (!params.has("limit")) params.set("limit", "25");
    const result = await searchTelephonyCallHistory(actor, parseCallHistoryQuery(params));
    // A missing authorized search RPC must not turn filtered history into an
    // unfiltered organization snapshot and claim the filter succeeded.
    if (!result.searchAvailable) throw new MutationError("Vyhľadávanie histórie momentálne nie je dostupné.", 503);
    const payload: MobileHistory = { ...mobileScope(actor), calls: result.calls.map(mobileHistoryCall), nextCursor: result.nextCursor };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Históriu hovorov sa nepodarilo načítať."); }
}
