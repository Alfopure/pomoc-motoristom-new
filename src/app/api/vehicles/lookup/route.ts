import { lookupIdentityConflict, parseVehicleLookupInput } from "@/lib/vehicle-lookup";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { lookupVehicle, VehicleLookupError } from "@/server/vehicle-lookup/service";

export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    if (Number(request.headers.get("content-length")) > 2048) return Response.json({ error: "Požiadavka je príliš veľká." }, { status: 413, headers });
    const body = await request.text();
    if (body.length > 2048) return Response.json({ error: "Požiadavka je príliš veľká." }, { status: 413, headers });
    let parsed;
    try { parsed = parseVehicleLookupInput(JSON.parse(body)); }
    catch (error) { return Response.json({ error: error instanceof SyntaxError ? "Neplatná požiadavka." : (error as Error).message }, { status: 400, headers }); }
    const result = await lookupVehicle(parsed.query, actor);
    return Response.json({ ...result, conflict: lookupIdentityConflict(result.snapshot.result, parsed.knownIdentity) }, { headers });
  } catch (error) {
    if (error instanceof MutationError || error instanceof VehicleLookupError) return Response.json({ error: error.message }, { status: error.status, headers: { ...headers, ...(error instanceof VehicleLookupError && error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) } });
    console.error("vehicle_lookup_failed");
    return Response.json({ error: "Dohľadávanie sa nepodarilo dokončiť. Údaje môžete vyplniť ručne." }, { status: 503, headers });
  }
}
