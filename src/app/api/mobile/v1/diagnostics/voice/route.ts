import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { logVoiceDiagnostics, readVoiceDiagnostics, takeVoiceDiagnosticsToken, voiceDiagnosticsEnabled } from "@/server/mobile/voice-diagnostics";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";
/** The iPhone's sanitized voice device log; only one runtime log line per batch is kept. */
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    if (!voiceDiagnosticsEnabled()) throw new MutationError("Diagnostika telefónu je vypnutá.", 403, "voice_diagnostics_disabled");
    if (!takeVoiceDiagnosticsToken(actor.profileId)) throw new MutationError("Diagnostiky telefónu je priveľa naraz. Skúste neskôr.", 429, "voice_diagnostics_rate_limited");
    const batch = readVoiceDiagnostics(await readMobileJsonBody(request));
    logVoiceDiagnostics(actor, batch);
    return mobileJson({ ...mobileScope(actor), received: batch.events.length });
  } catch (error) { return mobileError(error, "Diagnostiku telefónu sa nepodarilo prijať."); }
}
