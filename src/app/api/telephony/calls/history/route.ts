import { MutationError } from "@/server/motorist-mutations";
import { requireDefaultMotoristActor } from "@/server/api-auth";
import { parseCallHistoryQuery, HistoryQueryError } from "@/lib/telephony/call-history-query";
import { loadTelephonyCallHistory, searchTelephonyCallHistory } from "@/server/telephony/call-history";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const checkedAt = new Date().toISOString();

  try {
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    const params = new URL(request.url).searchParams;
    // Old clients retain their small initial snapshot. New UI explicitly sends limit.
    const result = [...params.keys()].length
      ? await searchTelephonyCallHistory(actor, parseCallHistoryQuery(params))
      : { calls: await loadTelephonyCallHistory(actor.organizationId), nextCursor: null };

    return Response.json(
      { ok: true, checkedAt, source: "supabase", ...result },
      { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } },
    );
  } catch (error) {
    const status = error instanceof HistoryQueryError ? 400 : error instanceof MutationError ? error.status : 500;
    const message =
      error instanceof MutationError || error instanceof HistoryQueryError ? error.message : "Históriu hovorov sa nepodarilo načítať.";
    return Response.json(
      {
        ok: false,
        checkedAt,
        error: message,
      },
      { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } },
    );
  }
}
