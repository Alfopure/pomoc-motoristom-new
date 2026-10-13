import { markPasswordCompleted } from "@/server/access-management";
import { assertSameOriginRequest } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { markTowingPasswordCompleted } from "@/server/towing/auth";
import { assertTowingOrigin, towingErrorResponse } from "@/server/towing/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (new URL(request.url).searchParams.get("module") === "towing") {
    try {
      assertTowingOrigin(request);
      await markTowingPasswordCompleted();
      return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return towingErrorResponse(error); }
  }
  try {
    assertSameOriginRequest(request);
    await markPasswordCompleted();

    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Password completion failed:", error);
    return Response.json({ error: "Heslo sa nepodarilo potvrdiť." }, { status: 500 });
  }
}
