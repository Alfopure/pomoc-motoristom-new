import type { MobileVoiceReadiness, MobileVoiceTuning } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { getNativeVoiceReadiness } from "@/server/mobile/voice-readiness";
import { envLatencyFlags, mobileVoiceTuning, readLatencyFlags, type LatencyFlags } from "@/server/telephony/latency-flags";
import { withTelephonyDatabaseBudget } from "@/server/telephony/ownership";

export const runtime = "nodejs";
const READINESS_FLAGS_BUDGET_MS = 1_500;

/**
 * The organisation's phone switches, within a fixed budget: a slow or failed
 * read yields env defaults. The race also bounds a shared in-flight read that
 * another request started without this budget.
 */
async function readinessTuning(organizationId: string): Promise<MobileVoiceTuning> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<LatencyFlags>((resolve) => { timer = setTimeout(() => resolve(envLatencyFlags()), READINESS_FLAGS_BUDGET_MS); });
  try {
    return mobileVoiceTuning(await Promise.race([fallback,
      withTelephonyDatabaseBudget(READINESS_FLAGS_BUDGET_MS, () => readLatencyFlags(createSupabaseAdminClient(), organizationId))]));
  } finally { clearTimeout(timer); }
}

export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const readiness = getNativeVoiceReadiness();
    // Only a phone that may call reads the switches; never a provider dependency.
    const voiceTuning = readiness.nativeCallingEnabled ? await readinessTuning(actor.organizationId) : undefined;
    const body: MobileVoiceReadiness = { ...mobileScope(actor), ...readiness, ...(voiceTuning ? { voiceTuning } : {}) };
    return mobileJson(body);
  } catch (error) {
    return mobileError(error, "Nastavenie mobilného telefonovania sa nepodarilo overiť.");
  }
}
