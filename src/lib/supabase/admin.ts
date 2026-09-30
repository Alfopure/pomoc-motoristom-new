import "server-only";
import { assertAppEnvironment } from "@/lib/app-environment";

import { telephonyDatabaseFetch } from "@/server/telephony/ownership";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { requireSupabaseServiceEnv } from "./env";

export function createSupabaseAdminClient(signal?: AbortSignal) {
  assertAppEnvironment();
  const { url, serviceKey } = requireSupabaseServiceEnv();

  return createClient<Database>(url, serviceKey, {
    global: { fetch: signal ? (input, init) => telephonyDatabaseFetch(input, { ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }) : telephonyDatabaseFetch },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
