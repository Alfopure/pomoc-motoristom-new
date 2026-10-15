import type { MobileVoiceReadiness } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { getNativeVoiceReadiness } from "@/server/mobile/voice-readiness";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const body: MobileVoiceReadiness = { ...mobileScope(actor), ...getNativeVoiceReadiness() };
    return mobileJson(body);
  } catch (error) {
    return mobileError(error, "Nastavenie mobilného telefonovania sa nepodarilo overiť.");
  }
}
