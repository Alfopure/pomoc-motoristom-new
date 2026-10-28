import { createBrowserClient } from "@supabase/ssr";

import { requireSupabasePublicEnv } from "./env";

/**
 * Minimal shape of the parts of the Supabase client this module drives, so the
 * wiring can be tested without a browser or a network.
 */
export type RealtimeAuthClient = {
  realtime: { setAuth(token?: string | null): unknown };
  auth: {
    onAuthStateChange(
      callback: (event: string, session: { access_token?: string | null } | null) => void,
    ): unknown;
  };
};

/** A join never waits longer than this for the restored session. */
export const REALTIME_AUTH_READY_MAX_MS = 5_000;

const realtimeAuth = new WeakMap<object, { ready: boolean; promise: Promise<void> }>();

function refreshRealtimeToken(client: RealtimeAuthClient): Promise<unknown> {
  // No argument: the socket asks supabase-js's `accessToken` callback, i.e.
  // `auth.getSession()`, which restores the session and refreshes it when it
  // is about to expire. A concrete token would be "manual": the socket would
  // then stop re-reading it on every heartbeat and after every join.
  return Promise.resolve(client.realtime.setAuth()).catch(() => undefined);
}

/**
 * Private Realtime channels are authorised by the user's JWT.
 *
 * supabase-js pushes a concrete token on `SIGNED_IN`/`TOKEN_REFRESHED`, which
 * pins the socket to it. A hidden tab never emits `TOKEN_REFRESHED` (auth-js
 * stops its refresh ticker there), so that pinned token expired after an hour
 * and every rejoin was refused as "Unauthorized" until the tab was shown
 * again. Handing the socket back to the callback after each auth event keeps
 * the heartbeat re-reading the current session instead.
 *
 * The first read also marks when the restored session is on the socket: a
 * private join sent before it carries only the publishable key and is refused
 * (see `afterRealtimeAuth`).
 */
export function attachSupabaseRealtimeAuth(client: RealtimeAuthClient): void {
  if (realtimeAuth.has(client)) return;
  const state = { ready: false, promise: Promise.resolve() };
  realtimeAuth.set(client, state);
  state.promise = Promise.race([
    refreshRealtimeToken(client),
    new Promise<void>((resolve) => setTimeout(resolve, REALTIME_AUTH_READY_MAX_MS)),
  ]).then(() => { state.ready = true; });

  client.auth.onAuthStateChange(() => {
    void refreshRealtimeToken(client);
  });
}

/**
 * Runs `join` (the channel's `subscribe`) once the socket holds the restored
 * session's token; at once when it already does or the client is not managed
 * here. The returned cancel stops a join for a component that unmounted first.
 */
export function afterRealtimeAuth(client: object, join: () => void): () => void {
  const state = realtimeAuth.get(client);
  if (!state || state.ready) {
    join();
    return () => {};
  }
  let cancelled = false;
  void state.promise.then(() => { if (!cancelled) join(); });
  return () => { cancelled = true; };
}

export function createSupabaseBrowserClient() {
  const { url, publicKey } = requireSupabasePublicEnv();

  const client = createBrowserClient(url, publicKey);
  attachSupabaseRealtimeAuth(client as unknown as RealtimeAuthClient);
  return client;
}
