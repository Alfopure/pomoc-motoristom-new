import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { PushError, type PushActor } from "@/server/web-push";

export async function handlePushRoute(request: Request, operation: (
  supabase: ReturnType<typeof createSupabaseAdminClient>, actor: PushActor, body: Record<string, unknown>,
) => Promise<unknown>) {
  try {
    if (request.method !== "GET") assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    let body: Record<string, unknown> = {};
    if (request.method !== "GET") {
      if (Number(request.headers.get("content-length")) > 8_192) throw new PushError("Požiadavka je príliš veľká.", 413);
      const text = await request.text();
      if (text.length > 8_192) throw new PushError("Požiadavka je príliš veľká.", 413);
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid body");
        body = parsed as Record<string, unknown>;
      } catch { throw new PushError("Neplatná požiadavka.", 400); }
    }
    const result = await operation(createSupabaseAdminClient(), actor, body);
    return Response.json(result ?? { ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const expected = error instanceof PushError || error instanceof MutationError;
    return Response.json({ error: expected ? error.message : "Push notifikácie sú dočasne nedostupné." }, {
      status: expected ? error.status : 500,
      headers: { "Cache-Control": "private, no-store", ...(expected && error.status === 429 ? { "Retry-After": "30" } : {}) },
    });
  }
}
