import { readAppStatus } from "@/server/mobile/app-status";

export const dynamic = "force-dynamic";
/** Public: the app asks before sign-in whether its version is still supported. */
export async function GET() {
  return Response.json(readAppStatus(), { headers: { "Cache-Control": "no-store" } });
}
