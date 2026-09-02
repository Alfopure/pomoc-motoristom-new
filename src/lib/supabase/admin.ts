import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { requireSupabaseServiceEnv } from "./env";

export function createSupabaseAdminClient() {
  const { url, serviceKey } = requireSupabaseServiceEnv();

  return createClient<Database>(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
