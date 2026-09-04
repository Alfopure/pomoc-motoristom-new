import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export type CurrentSessionSignOutClient = {
  auth: {
    signOut(options: { scope: "local" }): Promise<{ error: unknown | null }>;
  };
};

export async function signOutCurrentSession(
  client: CurrentSessionSignOutClient = createSupabaseBrowserClient(),
  navigate: (href: string) => void = (href) => window.location.replace(href),
): Promise<void> {
  const { error } = await client.auth.signOut({ scope: "local" });
  if (error) throw error;
  navigate("/");
}
