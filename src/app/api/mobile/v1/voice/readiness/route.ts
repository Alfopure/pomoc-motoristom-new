import type { MobileVoiceReadiness } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { getNativeVoiceReadiness } from "@/server/mobile/voice-readiness";
import { mobileVoiceTuning, readLatencyFlags } from "@/server/telephony/latency-flags";
import { withTelephonyDatabaseBudget } from "@/server/telephony/ownership";

export const runtime = "nodejs";
const READINESS_FLAGS_BUDGET_MS = 1_500;

export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const readiness = getNativeVoiceReadiness();
    // Only a phone that may call reads the organisation's switches. The read is
    // bounded, never fails readiness (a slow or failed one yields env defaults)
    // and constructs no provider dependencies.
    const voiceTuning = readiness.nativeCallingEnabled
      ? mobileVoiceTuning(await withTelephonyDatabaseBudget(READINESS_FLAGS_BUDGET_MS, () => readLatencyFlags(createSupabaseAdminClient(), actor.organizationId)))
      : undefined;
    const body: MobileVoiceReadiness = { ...mobileScope(actor), ...readiness, ...(voiceTuning ? { voiceTuning } : {}) };
    return mobileJson(body);
  } catch (error) {
    return mobileError(error, "Nastavenie mobilného telefonovania sa nepodarilo overiť.");
  }
}
