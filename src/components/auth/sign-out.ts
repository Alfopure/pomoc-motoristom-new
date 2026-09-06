import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { disableCurrentDevicePush } from "@/components/pwa/push-client";

export type CurrentSessionSignOutClient = {
  auth: {
    signOut(options: { scope: "local" }): Promise<{ error: unknown | null }>;
  };
};

export async function signOutCurrentSession(
  client: CurrentSessionSignOutClient = createSupabaseBrowserClient(),
  navigate: (href: string) => void = (href) => window.location.replace(href),
  disablePush: () => Promise<void> = disableCurrentDevicePush,
): Promise<void> {
  // Revoke while the session can still authenticate the endpoint deletion.
  // This prevents another operator on a shared device receiving our alerts.
  await disablePush();
  const { error } = await client.auth.signOut({ scope: "local" });
  if (error) throw error;
  navigate("/");
}
