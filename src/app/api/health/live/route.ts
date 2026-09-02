export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      status: "live",
      version: process.env.DEPLOYMENT_VERSION?.trim() || "development",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
