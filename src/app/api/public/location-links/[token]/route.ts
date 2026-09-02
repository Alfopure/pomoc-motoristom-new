import { getPublicLocationLinkState, LocationShareError, submitPublicLocation } from "@/server/location-share-links";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const state = await getPublicLocationLinkState(token);

    return Response.json(state);
  } catch (error) {
    if (error instanceof LocationShareError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Location link state failed:", error);
    return Response.json({ error: "Link na polohu sa nepodarilo overit." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const payload = await request.json().catch(() => null);
    const result = await submitPublicLocation(token, payload, {
      ipAddress: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });

    return Response.json({
      status: result.status,
      submittedAt: result.submittedAt,
    });
  } catch (error) {
    if (error instanceof LocationShareError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Polohu sa nepodarilo ulozit.";
    return Response.json({ error: message }, { status: 500 });
  }
}

function clientIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}
