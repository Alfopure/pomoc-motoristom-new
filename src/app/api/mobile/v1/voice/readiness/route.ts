import type { MobileVoiceReadiness } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { getNativeVoiceReadiness } from "@/server/mobile/voice-readiness";
import { mobileVoiceTuning, readLatencyFlags } from "@/server/telephony/latency-flags";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const readiness = getNativeVoiceReadiness();
    // Only a phone that may call reads the organisation's switches; the read
    // never fails readiness and never constructs provider dependencies.
    const voiceTuning = readiness.nativeCallingEnabled
      ? mobileVoiceTuning(await readLatencyFlags(createSupabaseAdminClient(), actor.organizationId)) : undefined;
    const body: MobileVoiceReadiness = { ...mobileScope(actor), ...readiness, ...(voiceTuning ? { voiceTuning } : {}) };
    return mobileJson(body);
  } catch (error) {
    return mobileError(error, "Nastavenie mobilného telefonovania sa nepodarilo overiť.");
  }
}
