import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { requireSupabaseServiceEnv } from "./env";

export function createSupabaseAdminClient(signal?: AbortSignal) {
  const { url, serviceKey } = requireSupabaseServiceEnv();

  return createClient<Database>(url, serviceKey, {
    ...(signal ? {
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
        }),
      },
    } : {}),
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
