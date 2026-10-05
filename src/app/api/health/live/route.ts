import { getAppVersion } from "@/server/app-version";
import { getAppRelease } from "@/server/app-release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      status: "live",
      version: getAppVersion(),
      release: getAppRelease(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
