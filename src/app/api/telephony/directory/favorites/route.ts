import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import {
  createTelephonyFavorite,
  listTelephonyFavorites,
  TELEPHONY_DIRECTORY_ROLES,
  telephonyDirectoryErrorResponse,
} from "@/server/telephony-directory";

export const runtime = "nodejs";

export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(TELEPHONY_DIRECTORY_ROLES);
    const favorites = await listTelephonyFavorites(actor);

    return Response.json(
      { favorites },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return telephonyDirectoryErrorResponse(error, "Obľúbené kontakty sa nepodarilo načítať.");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_DIRECTORY_ROLES);
    const body = (await request.json().catch(() => ({}))) as { name?: unknown; phone?: unknown };
    const result = await createTelephonyFavorite(actor, { name: body.name, phone: body.phone });

    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return telephonyDirectoryErrorResponse(error, "Obľúbený kontakt sa nepodarilo vytvoriť.");
  }
}
