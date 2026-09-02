import { requireDefaultMotoristActor } from "@/server/api-auth";
import {
  listTelephonyDirectory,
  searchTelephonyDirectory,
  TELEPHONY_DIRECTORY_ROLES,
  telephonyDirectoryErrorResponse,
} from "@/server/telephony-directory";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireDefaultMotoristActor(TELEPHONY_DIRECTORY_ROLES);
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const contacts = query.trim()
      ? await searchTelephonyDirectory(actor, query)
      : await listTelephonyDirectory(actor);

    return Response.json(
      { contacts },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return telephonyDirectoryErrorResponse(error, "Telefónny zoznam sa nepodarilo načítať.");
  }
}
