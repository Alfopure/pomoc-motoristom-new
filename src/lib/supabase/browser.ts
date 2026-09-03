import { createBrowserClient } from "@supabase/ssr";

import { requireSupabasePublicEnv } from "./env";

/**
 * Minimal shape of the parts of the Supabase client this module drives, so the
 * wiring can be tested without a browser or a network.
 */
export type RealtimeAuthClient = {
  realtime: { setAuth(token?: string | null): unknown };
  auth: {
    getSession(): Promise<{ data: { session: { access_token?: string | null } | null } }>;
    onAuthStateChange(
      callback: (event: string, session: { access_token?: string | null } | null) => void,
    ): unknown;
  };
};

const authAttached = new WeakSet<object>();

/**
 * Private Realtime channels are authorised by the user's JWT, which the socket
 * only learns about through `realtime.setAuth`. The cookie-based SSR client
 * does not push it there on its own, so the token is set once when the session
 * is read and again on every auth event (`TOKEN_REFRESHED`, sign-in,
 * sign-out) -- a channel that keeps an expired token is closed by the server
 * mid-shift, which is precisely when the call console must not go quiet.
 */
export function attachSupabaseRealtimeAuth(client: RealtimeAuthClient): void {
  if (authAttached.has(client)) return;
  authAttached.add(client);

  void client.auth
    .getSession()
    .then(({ data }) => {
      client.realtime.setAuth(data.session?.access_token ?? null);
    })
    .catch(() => {
      // No session yet: the auth listener below sets the token when one exists.
    });

  client.auth.onAuthStateChange((_event, session) => {
    client.realtime.setAuth(session?.access_token ?? null);
  });
}

export function createSupabaseBrowserClient() {
  const { url, publicKey } = requireSupabasePublicEnv();

  const client = createBrowserClient(url, publicKey);
  attachSupabaseRealtimeAuth(client as unknown as RealtimeAuthClient);
  return client;
}
