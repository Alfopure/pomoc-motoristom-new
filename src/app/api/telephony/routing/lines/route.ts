import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { configureViptelLineCatalog } from "@/server/telephony/viptel-line-catalog-config";
import { telephonyLiveMutationGateStatus } from "@/server/telephony/live-mutation-gate";

export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
  return handleConfiguration(true);
}

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    const parsedBody = await request.json().catch(() => undefined);
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      throw new MutationError("Údaje katalógu liniek musia byť platný JSON objekt.", 400);
    }
    const body = parsedBody as { dryRun?: unknown };
    const dryRun = body.dryRun !== false;
    const result = await configureViptelLineCatalog(actor, dryRun);
    return Response.json({ ok: true, gate: telephonyLiveMutationGateStatus(), ...result }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleConfiguration(dryRun: boolean) {
  try {
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    const result = await configureViptelLineCatalog(actor, dryRun);
    return Response.json({ ok: true, gate: telephonyLiveMutationGateStatus(), ...result }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ ok: false, error: error.message }, { status: error.status, headers: NO_STORE_HEADERS });
  }
  return Response.json(
    { ok: false, error: "VIPTel katalóg liniek sa nepodarilo pripraviť." },
    { status: 500, headers: NO_STORE_HEADERS },
  );
}
