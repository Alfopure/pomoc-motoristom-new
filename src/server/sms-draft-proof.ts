import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requireSupabaseServiceEnv } from "@/lib/supabase/env";
import type { PreparedSms } from "@/lib/sms/contracts";

// Domain separation: this MAC is only a proof for this application's SMS draft.
export function signSmsDraft(draft: PreparedSms, secret = requireSupabaseServiceEnv().serviceKey) {
  return createHmac("sha256", secret).update("motorist:sms-draft:v1\n").update(JSON.stringify(draft)).digest("hex");
}
export function verifySmsDraft(draft: PreparedSms, proof: string, secret?: string) {
  if (!/^[a-f0-9]{64}$/.test(proof)) return false;
  const expected = signSmsDraft(draft, secret);
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex"));
}
