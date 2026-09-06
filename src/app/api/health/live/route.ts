import { getAppVersion } from "@/server/app-version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      status: "live",
      version: getAppVersion(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
