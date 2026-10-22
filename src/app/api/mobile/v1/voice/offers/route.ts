import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { authorizeNativeOffer, nativeVoiceDeps } from "@/server/mobile/voice";
import { readJsonBody } from "@/server/telephony/runtime";

export const runtime = "nodejs";

/** Provider IDs only (no tokens or numbers): which identity the phone sent and how it ended. */
function logOffer(body: unknown, outcome: Record<string, unknown>) {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const leg = typeof value.providerLegId === "string" ? value.providerLegId.slice(0, 64) : null;
  console.info(JSON.stringify({ scope: "native-offer", providerLegId: leg, upperCase: leg ? leg !== leg.toLowerCase() : null,
    hasControlId: typeof value.callControlId === "string", ...outcome }));
}

export async function POST(request: Request) {
  let body: unknown = null;
  try {
    const actor = await requireMobileActor(request); const deps = await nativeVoiceDeps(actor);
    body = await readJsonBody(request);
    const result = await authorizeNativeOffer(deps, actor, body as Record<string, unknown>);
    logOffer(body, { outcome: "authorized", sessionId: result.sessionId, direction: result.direction, role: result.role });
    return mobileJson({ ...mobileScope(actor), ...result });
  } catch (error) {
    const detail = error as { code?: unknown; status?: unknown; message?: unknown };
    logOffer(body, { outcome: "refused", code: detail?.code ?? null, status: detail?.status ?? null, message: typeof detail?.message === "string" ? detail.message.slice(0, 160) : null });
    return mobileError(error, "Ponuku hovoru sa nepodarilo overiť.");
  }
}
