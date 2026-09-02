import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import {
  loadViptelFallbackSettings,
  updateViptelFallbackSettings,
} from "@/server/telephony/fallback-settings";

export const runtime = "nodejs";

const ALL_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor([...ALL_ROLES]);
    const loaded = await loadViptelFallbackSettings(actor.organizationId);
    return Response.json({
      ok: true,
      canManage: actor.role === "manager" || actor.role === "admin",
      settings: loaded.settings,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new MutationError("Nastavenie záložného presmerovania musí byť platný JSON objekt.", 400);
    }
    const input = body as { destination?: unknown; afterSeconds?: unknown };
    const settings = await updateViptelFallbackSettings(actor, input);
    return Response.json({ ok: true, canManage: true, settings }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ ok: false, error: error.message }, { status: error.status, headers: NO_STORE_HEADERS });
  }
  return Response.json(
    { ok: false, error: "Nastavenie záložného presmerovania sa nepodarilo spracovať." },
    { status: 500, headers: NO_STORE_HEADERS },
  );
}
