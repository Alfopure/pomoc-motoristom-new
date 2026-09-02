import { markPasswordCompleted } from "@/server/access-management";
import { assertSameOriginRequest } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

export async function POST(request: Request) {
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
