import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { requireSupabasePublicEnv } from "@/lib/supabase/env";
import { requireMobileActor } from "./auth";

/** RPCs using auth.uid() receive the verified user token, never a service client. */
export async function requireMobileUser(request: Request) {
  const actor = await requireMobileActor(request);
  const { url, publicKey } = requireSupabasePublicEnv();
  const authorization = "Bearer " + request.headers.get("authorization")!.slice(7);
  const client = createClient<Database>(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: authorization },
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: AbortSignal.any([request.signal, ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(8_000)]),
      }),
    },
  });
  return { actor, client };
}
