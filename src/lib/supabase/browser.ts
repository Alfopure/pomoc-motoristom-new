import { createBrowserClient } from "@supabase/ssr";
import { requireSupabasePublicEnv } from "./env";

export function createSupabaseBrowserClient() {
  const { url, publicKey } = requireSupabasePublicEnv();

  return createBrowserClient(url, publicKey);
}
