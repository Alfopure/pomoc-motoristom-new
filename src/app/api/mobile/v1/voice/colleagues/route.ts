import type { MobileVoiceColleagues } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { getMobileVoiceColleagues, readColleagueQuery } from "@/server/mobile/voice-colleagues";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const q = readColleagueQuery(new URL(request.url).searchParams);
    const body: MobileVoiceColleagues = { ...mobileScope(actor), ...await getMobileVoiceColleagues(actor, q) };
    return mobileJson(body);
  } catch (error) {
    return mobileError(error, "Kolegov sa nepodarilo načítať.");
  }
}
