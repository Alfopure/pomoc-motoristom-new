import { assertSameOriginRequest, requireDefaultMotoristOrgMember } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { assertDrivingRouteConfigured, computeDrivingRoute } from "@/server/driving-route";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgMember();
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Route authorization failed:", error);
    return Response.json({ error: "Oprávnenie sa nepodarilo overiť." }, { status: 500 });
  }

  try {
    assertDrivingRouteConfigured();
    const body = await request.json().catch(() => null);
    return Response.json(await computeDrivingRoute(body, { signal: request.signal }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof MutationError ? error.message : "Výpočet trasy nie je dostupný alebo trvá príliš dlho. Skúste to znova." }, { status: error instanceof MutationError ? error.status : 502 });
  }
}
