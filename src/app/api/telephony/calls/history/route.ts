import { MutationError } from "@/server/motorist-mutations";
import { requireDefaultMotoristActor } from "@/server/api-auth";
import { loadTelephonyCallHistory } from "@/server/telephony/call-history";

export const runtime = "nodejs";

export async function GET() {
  const checkedAt = new Date().toISOString();

  try {
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    const calls = await loadTelephonyCallHistory(actor.organizationId);

    return Response.json(
      { ok: true, checkedAt, source: "supabase", calls },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const status = error instanceof MutationError ? error.status : 500;
    const message =
      error instanceof MutationError ? error.message : "Históriu hovorov sa nepodarilo načítať.";
    return Response.json(
      {
        ok: false,
        checkedAt,
        error: message,
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
