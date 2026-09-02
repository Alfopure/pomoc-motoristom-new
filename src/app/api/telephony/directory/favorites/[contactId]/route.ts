import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import {
  addTelephonyFavorite,
  removeTelephonyFavorite,
  TELEPHONY_DIRECTORY_ROLES,
  telephonyDirectoryErrorResponse,
} from "@/server/telephony-directory";

export const runtime = "nodejs";

type FavoriteRouteContext = {
  params: Promise<{ contactId: string }>;
};

export async function PUT(request: Request, { params }: FavoriteRouteContext) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_DIRECTORY_ROLES);
    const { contactId } = await params;
    const contact = await addTelephonyFavorite(actor, contactId);

    return Response.json({ contact, contactId, isFavorite: true });
  } catch (error) {
    return telephonyDirectoryErrorResponse(error, "Obľúbený kontakt sa nepodarilo uložiť.");
  }
}

export async function DELETE(request: Request, { params }: FavoriteRouteContext) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_DIRECTORY_ROLES);
    const { contactId: rawContactId } = await params;
    const contactId = await removeTelephonyFavorite(actor, rawContactId);

    return Response.json({ contactId, isFavorite: false });
  } catch (error) {
    return telephonyDirectoryErrorResponse(error, "Obľúbený kontakt sa nepodarilo odstrániť.");
  }
}
